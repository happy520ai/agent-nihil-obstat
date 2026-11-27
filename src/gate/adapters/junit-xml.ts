import { Buffer } from 'node:buffer';

/**
 * Restricted, dependency-free JUnit XML parser (ADR-014 §4.4, PY-04).
 *
 * The parser exists so pytest evidence can be recounted from an artifact the
 * adapter owns. It deliberately implements only the xunit2 subset pytest
 * emits: `testsuites`, `testsuite`, `testcase`, `failure`, `error`, `skipped`
 * plus the non-count payload (`properties`/`property`, `system-out`,
 * `system-err`) that some producers add. Anything outside that subset is
 * rejected instead of guessed at.
 *
 * Trust boundary: `ok` means "the XML is well formed, internally consistent,
 * and contains at least one testcase". It is not a verdict. The ADR §4.3
 * exit-code cross-check lives in the pytest adapter, which is a separate
 * layer; this function never sees an exit code.
 *
 * Memory bound: the 16 MiB input ceiling still fits hundreds of thousands of
 * `testsuite` elements, so suites are streamed into running totals as they
 * close and never retained one object per suite. The anomaly list is the only
 * per-suite residue and is capped (see MAX_RETAINED_ANOMALIES); past the cap a
 * single summary entry carries the dropped count so `ok` stays truthful.
 */

const MAX_XML_BYTES = 16 * 1024 * 1024;
const MAX_DEPTH = 64;

/**
 * Retained-anomaly ceiling. A pathological document can forge one count per
 * attribute on every suite (millions of strings on a 16 MiB file), which would
 * both pin heap and balloon the serialized evidence payload. Keeping the first
 * `MAX_RETAINED_ANOMALIES` diagnostics plus one summary preserves every
 * decision (`ok`) and the aggregate counts while bounding retention.
 */
export const MAX_RETAINED_ANOMALIES = 64;

const COUNT_ATTRIBUTES: ReadonlySet<string> = new Set(['tests', 'failures', 'errors', 'skipped']);
const NAMED_ENTITIES: ReadonlySet<string> = new Set(['amp', 'lt', 'gt', 'quot', 'apos']);
const STATUS_ELEMENTS: ReadonlySet<string> = new Set(['failure', 'error', 'skipped']);
const NAME_PATTERN = /[A-Za-z_][A-Za-z0-9_.:-]*/y;
const DECIMAL_PATTERN = /^[0-9]+$/;
const HEX_PATTERN = /^[0-9A-Fa-f]+$/;

export interface JUnitXmlCounts {
  /** Evidence counts are an open integer map (src/gate/types.ts evidenceSchema). */
  readonly [key: string]: number;
  readonly pass: number;
  readonly fail: number;
  readonly skipped: number;
  readonly todo: number;
  readonly cancelled: number;
  readonly suites: number;
  readonly tests: number;
}

export interface JUnitXmlParseResult {
  readonly ok: boolean;
  readonly counts: JUnitXmlCounts;
  /** Recounted testcase elements. */
  readonly tests: number;
  /** Recounted `failure` elements. */
  readonly failures: number;
  /** Recounted `error` elements. */
  readonly errors: number;
  /**
   * Diagnostic codes. Bounded: at most `MAX_RETAINED_ANOMALIES` entries, plus a
   * final `anomaly_cap_reached:kept=…:dropped=…` summary when diagnostics were
   * dropped. `ok` and the counts are never derived from this truncated list.
   */
  readonly anomalies: string[];
}

type TestStatus = 'pass' | 'failure' | 'error' | 'skipped';

interface OpenTag {
  readonly name: string;
  readonly attributes: ReadonlyMap<string, string>;
  readonly selfClosing: boolean;
  readonly depth: number;
}

interface SuiteCounts {
  readonly tests: number;
  readonly failures: number;
  readonly errors: number;
  readonly skipped: number;
}

/** Running document totals; each suite is folded in when it closes. */
interface DocumentTotals {
  suites: number;
  tests: number;
  failures: number;
  errors: number;
  skipped: number;
}

/**
 * Bounded anomaly collector. Suites are streamed, so this list is the only
 * structure that could still grow with suite count; it keeps the first
 * `MAX_RETAINED_ANOMALIES` entries and reports the remainder as one summary.
 */
class AnomalySink {
  private readonly listed: string[] = [];
  private total = 0;

  add(anomaly: string): void {
    this.total += 1;
    if (this.listed.length < MAX_RETAINED_ANOMALIES) this.listed.push(anomaly);
  }

  /** True when any anomaly was recorded, including ones dropped by the cap. */
  get failed(): boolean {
    return this.total > 0;
  }

  /** At most `MAX_RETAINED_ANOMALIES` entries, plus the summary when truncated. */
  snapshot(): string[] {
    const dropped = this.total - this.listed.length;
    if (dropped === 0) return [...this.listed];
    return [...this.listed, `anomaly_cap_reached:kept=${this.listed.length}:dropped=${dropped}`];
  }
}

class XmlRejection extends Error {
  readonly reason: string;

  constructor(code: string, detail?: string) {
    const suffix = detail === undefined ? '' : `:${detail.slice(0, 120)}`;
    super(`${code}${suffix}`);
    this.reason = `${code}${suffix}`;
  }
}

class XmlCursor {
  readonly text: string;
  index = 0;

  constructor(text: string) {
    this.text = text;
  }

  eof(): boolean {
    return this.index >= this.text.length;
  }

  char(offset: number): string {
    return this.text.charAt(this.index + offset);
  }

  startsWith(token: string): boolean {
    return this.text.startsWith(token, this.index);
  }

  slice(start: number): string {
    return this.text.slice(start, this.index);
  }
}

function isSpace(character: string): boolean {
  return character === ' ' || character === '\t' || character === '\n' || character === '\r';
}

function isAllowedCodePoint(code: number): boolean {
  return code === 0x9
    || code === 0xA
    || code === 0xD
    || (code >= 0x20 && code <= 0x7E)
    || (code >= 0x80 && code <= 0xD7FF)
    || (code >= 0xE000 && code <= 0xFFFD)
    || (code >= 0x10000 && code <= 0x10FFFF);
}

function assertXmlCharacters(text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const low = text.charCodeAt(index + 1);
      if (!(low >= 0xDC00 && low <= 0xDFFF)) {
        throw new XmlRejection('invalid_utf8', 'lone_high_surrogate');
      }
      index += 1;
      continue;
    }
    if (code >= 0xDC00 && code <= 0xDFFF) {
      throw new XmlRejection('invalid_utf8', 'lone_low_surrogate');
    }
    if (!isAllowedCodePoint(code)) {
      const kind = code < 0x20 || code === 0x7F ? 'control' : 'noncharacter';
      throw new XmlRejection('invalid_character', `${kind}:U+${code.toString(16).toUpperCase().padStart(4, '0')}`);
    }
  }
}

function decodeInput(input: string | Uint8Array): string {
  let text: string;
  if (input instanceof Uint8Array) {
    if (input.byteLength > MAX_XML_BYTES) throw new XmlRejection('input_too_large');
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(input);
    } catch {
      throw new XmlRejection('invalid_utf8');
    }
  } else {
    text = input;
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_XML_BYTES) throw new XmlRejection('input_too_large');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  assertXmlCharacters(text);
  return text;
}

function skipSpaces(cursor: XmlCursor): number {
  const start = cursor.index;
  while (isSpace(cursor.char(0))) cursor.index += 1;
  return cursor.index - start;
}

function readName(cursor: XmlCursor): string {
  NAME_PATTERN.lastIndex = cursor.index;
  const match = NAME_PATTERN.exec(cursor.text);
  if (match === null) throw new XmlRejection('malformed_xml', 'element_name');
  cursor.index = NAME_PATTERN.lastIndex;
  return match[0];
}

function readEntity(cursor: XmlCursor): void {
  const end = cursor.text.indexOf(';', cursor.index + 1);
  if (end < 0) throw new XmlRejection('malformed_xml', 'unterminated_entity');
  const body = cursor.text.slice(cursor.index + 1, end);
  if (body.length === 0) throw new XmlRejection('malformed_xml', 'empty_entity');
  if (body.charAt(0) === '#') {
    let code: number;
    if (body.startsWith('#x')) {
      const digits = body.slice(2);
      if (!HEX_PATTERN.test(digits)) throw new XmlRejection('invalid_entity', body);
      code = Number.parseInt(digits, 16);
    } else {
      const digits = body.slice(1);
      if (!DECIMAL_PATTERN.test(digits)) throw new XmlRejection('invalid_entity', body);
      code = Number(digits);
    }
    if (!Number.isSafeInteger(code) || !isAllowedCodePoint(code)) {
      throw new XmlRejection('invalid_entity', body);
    }
  } else if (!NAMED_ENTITIES.has(body)) {
    throw new XmlRejection('unknown_entity', body);
  }
  cursor.index = end + 1;
}

function readAttributeValue(cursor: XmlCursor, quote: string): string {
  const start = cursor.index;
  for (;;) {
    if (cursor.eof()) throw new XmlRejection('malformed_xml', 'unterminated_attribute');
    const character = cursor.char(0);
    if (character === quote) {
      const value = cursor.slice(start);
      cursor.index += 1;
      return value;
    }
    if (character === '<') throw new XmlRejection('malformed_xml', 'attribute_lt');
    if (character === '&') {
      readEntity(cursor);
      continue;
    }
    cursor.index += 1;
  }
}

function readCountAttribute(name: string, value: string): void {
  if (!DECIMAL_PATTERN.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new XmlRejection('invalid_count', `${name}=${value}`);
  }
}

function readOpenTag(cursor: XmlCursor, depth: number): OpenTag {
  if (depth > MAX_DEPTH) throw new XmlRejection('depth_exceeded');
  if (cursor.char(0) !== '<') throw new XmlRejection('malformed_xml', 'expected_element');
  cursor.index += 1;
  if (cursor.char(0) === '!') {
    if (cursor.startsWith('!DOCTYPE')) throw new XmlRejection('doctype');
    if (cursor.startsWith('!ENTITY')) throw new XmlRejection('entity_declaration');
    throw new XmlRejection('malformed_xml', 'declaration');
  }
  if (cursor.char(0) === '?') throw new XmlRejection('processing_instruction');
  const name = readName(cursor);
  const attributes = new Map<string, string>();
  for (;;) {
    const spaces = skipSpaces(cursor);
    if (cursor.eof()) throw new XmlRejection('malformed_xml', 'unterminated_tag');
    const character = cursor.char(0);
    if (character === '>') {
      cursor.index += 1;
      return { name, attributes, selfClosing: false, depth };
    }
    if (character === '/') {
      if (cursor.char(1) !== '>') throw new XmlRejection('malformed_xml', 'self_close');
      cursor.index += 2;
      return { name, attributes, selfClosing: true, depth };
    }
    if (spaces === 0) throw new XmlRejection('malformed_xml', 'missing_attribute_separator');
    const attributeName = readName(cursor);
    skipSpaces(cursor);
    if (cursor.char(0) !== '=') throw new XmlRejection('malformed_xml', 'attribute_value');
    cursor.index += 1;
    skipSpaces(cursor);
    const quote = cursor.char(0);
    if (quote !== '"' && quote !== "'") throw new XmlRejection('malformed_xml', 'unquoted_attribute');
    cursor.index += 1;
    const value = readAttributeValue(cursor, quote);
    if (attributes.has(attributeName)) throw new XmlRejection('duplicate_attribute', attributeName);
    if (COUNT_ATTRIBUTES.has(attributeName)) readCountAttribute(attributeName, value);
    attributes.set(attributeName, value);
  }
}

/** Callers confirm the `</` prefix; this keeps the grammar from drifting. */
function readCloseTag(cursor: XmlCursor, expectedName: string): void {
  cursor.index += 2;
  const name = readName(cursor);
  if (name !== expectedName) throw new XmlRejection('mismatched_tag', `${expectedName}/${name}`);
  skipSpaces(cursor);
  if (cursor.char(0) !== '>') throw new XmlRejection('malformed_xml', 'close_tag');
  cursor.index += 1;
}

function consumeComment(cursor: XmlCursor): void {
  cursor.index += 4;
  const end = cursor.text.indexOf('-->', cursor.index);
  if (end < 0) throw new XmlRejection('malformed_xml', 'unterminated_comment');
  if (cursor.text.slice(cursor.index, end).includes('--')) {
    throw new XmlRejection('malformed_xml', 'comment_dashes');
  }
  cursor.index = end + 3;
}

function consumeCdata(cursor: XmlCursor): string {
  cursor.index += 9;
  const start = cursor.index;
  const end = cursor.text.indexOf(']]>', start);
  if (end < 0) throw new XmlRejection('malformed_xml', 'unterminated_cdata');
  const content = cursor.text.slice(start, end);
  cursor.index = end + 3;
  return content;
}

function consumeContainerText(cursor: XmlCursor): string {
  const start = cursor.index;
  while (!cursor.eof() && cursor.char(0) !== '<') {
    if (cursor.char(0) === '&') {
      readEntity(cursor);
      continue;
    }
    cursor.index += 1;
  }
  return cursor.slice(start);
}

function skipMisc(cursor: XmlCursor): void {
  for (;;) {
    skipSpaces(cursor);
    if (cursor.startsWith('<!--')) {
      consumeComment(cursor);
      continue;
    }
    if (cursor.startsWith('<?')) throw new XmlRejection('processing_instruction');
    return;
  }
}

function parseXmlDeclaration(cursor: XmlCursor): void {
  if (!cursor.startsWith('<?xml')) return;
  const after = cursor.char(5);
  if (after !== '?' && !isSpace(after)) return;
  const end = cursor.text.indexOf('?>', cursor.index + 5);
  if (end < 0) throw new XmlRejection('malformed_xml', 'xml_declaration');
  if (cursor.text.slice(5, end).includes('<')) throw new XmlRejection('malformed_xml', 'xml_declaration');
  cursor.index = end + 2;
}

type ChildHandler = (child: OpenTag) => void;

/**
 * Shared grammar for the elements that may only contain child elements and
 * whitespace. Comments are valid non-count payload; any non-whitespace text
 * at container level is rejected instead of silently discarded.
 */
function parseContainerBody(cursor: XmlCursor, open: OpenTag, handleChild: ChildHandler): void {
  if (open.selfClosing) return;
  for (;;) {
    skipSpaces(cursor);
    if (cursor.eof()) throw new XmlRejection('malformed_xml', `unclosed_${open.name}`);
    if (cursor.startsWith('<!--')) {
      consumeComment(cursor);
      continue;
    }
    if (cursor.startsWith('</')) {
      readCloseTag(cursor, open.name);
      return;
    }
    if (cursor.startsWith('<![CDATA[')) {
      if (consumeCdata(cursor).trim().length > 0) {
        throw new XmlRejection('malformed_xml', 'unexpected_text');
      }
      continue;
    }
    if (cursor.char(0) === '<') {
      handleChild(readOpenTag(cursor, open.depth + 1));
      continue;
    }
    if (consumeContainerText(cursor).trim().length > 0) {
      throw new XmlRejection('malformed_xml', 'unexpected_text');
    }
  }
}

/** Text/CDATA-only payload shared by status, property and system elements. */
function parseTextBody(cursor: XmlCursor, open: OpenTag): void {
  if (open.selfClosing) return;
  for (;;) {
    if (cursor.eof()) throw new XmlRejection('malformed_xml', `unclosed_${open.name}`);
    if (cursor.startsWith('</')) {
      readCloseTag(cursor, open.name);
      return;
    }
    if (cursor.startsWith('<!--')) {
      consumeComment(cursor);
      continue;
    }
    if (cursor.startsWith('<![CDATA[')) {
      consumeCdata(cursor);
      continue;
    }
    if (cursor.char(0) === '<') {
      rejectUnsupported(cursor, readOpenTag(cursor, open.depth + 1));
    }
    if (cursor.char(0) === '&') {
      readEntity(cursor);
      continue;
    }
    cursor.index += 1;
  }
}

/**
 * Consumes an element the grammar does not allow so the depth/well-formedness
 * guards still see its subtree, then rejects it. This keeps a 65-level unknown
 * chain classified as `depth_exceeded` rather than merely unsupported.
 */
function rejectUnsupported(cursor: XmlCursor, open: OpenTag): never {
  consumeGenericBody(cursor, open);
  throw new XmlRejection('unsupported_element', open.name);
}

function consumeGenericBody(cursor: XmlCursor, open: OpenTag): void {
  if (open.selfClosing) return;
  for (;;) {
    if (cursor.eof()) throw new XmlRejection('malformed_xml', `unclosed_${open.name}`);
    if (cursor.startsWith('</')) {
      readCloseTag(cursor, open.name);
      return;
    }
    if (cursor.startsWith('<!--')) {
      consumeComment(cursor);
      continue;
    }
    if (cursor.startsWith('<![CDATA[')) {
      consumeCdata(cursor);
      continue;
    }
    if (cursor.char(0) === '<') {
      consumeGenericBody(cursor, readOpenTag(cursor, open.depth + 1));
      continue;
    }
    if (cursor.char(0) === '&') {
      readEntity(cursor);
      continue;
    }
    cursor.index += 1;
  }
}

function parseTestcaseBody(cursor: XmlCursor, open: OpenTag): TestStatus {
  const statuses: TestStatus[] = [];
  parseContainerBody(cursor, open, (child) => {
    if (STATUS_ELEMENTS.has(child.name)) {
      statuses.push(child.name as TestStatus);
      parseTextBody(cursor, child);
      return;
    }
    if (child.name === 'system-out' || child.name === 'system-err') {
      parseTextBody(cursor, child);
      return;
    }
    rejectUnsupported(cursor, child);
  });
  if (statuses.length > 1) {
    throw new XmlRejection('testcase_multiple_statuses', statuses.join('+'));
  }
  return statuses[0] ?? 'pass';
}

function parseSuiteBody(cursor: XmlCursor, open: OpenTag): SuiteCounts {
  const counts = { tests: 0, failures: 0, errors: 0, skipped: 0 };
  parseContainerBody(cursor, open, (child) => {
    if (child.name === 'testcase') {
      const status = parseTestcaseBody(cursor, child);
      counts.tests += 1;
      if (status === 'failure') counts.failures += 1;
      else if (status === 'error') counts.errors += 1;
      else if (status === 'skipped') counts.skipped += 1;
      return;
    }
    if (child.name === 'properties') {
      parseContainerBody(cursor, child, (property) => {
        if (property.name !== 'property') rejectUnsupported(cursor, property);
        parseTextBody(cursor, property);
      });
      return;
    }
    if (child.name === 'system-out' || child.name === 'system-err') {
      parseTextBody(cursor, child);
      return;
    }
    rejectUnsupported(cursor, child);
  });
  return counts;
}

/**
 * Folds one closed suite into the running totals and lets it be collected.
 * The declared-count cross-check runs here so the suite's attribute map has no
 * reason to survive the call; only capped anomaly strings outlive it.
 */
function recordSuite(
  totals: DocumentTotals,
  anomalies: AnomalySink,
  attributes: ReadonlyMap<string, string>,
  counts: SuiteCounts,
): void {
  const index = totals.suites;
  totals.suites = index + 1;
  totals.tests += counts.tests;
  totals.failures += counts.failures;
  totals.errors += counts.errors;
  totals.skipped += counts.skipped;
  checkCountAttributes(anomalies, `testsuite[${index}]`, attributes, counts);
}

function parseTestsuitesBody(
  cursor: XmlCursor,
  open: OpenTag,
  totals: DocumentTotals,
  anomalies: AnomalySink,
): void {
  parseContainerBody(cursor, open, (child) => {
    if (child.name !== 'testsuite') rejectUnsupported(cursor, child);
    recordSuite(totals, anomalies, child.attributes, parseSuiteBody(cursor, child));
  });
}

function emptyTotals(): DocumentTotals {
  return { suites: 0, tests: 0, failures: 0, errors: 0, skipped: 0 };
}

function parseDocument(text: string): JUnitXmlParseResult {
  const cursor = new XmlCursor(text);
  parseXmlDeclaration(cursor);
  skipMisc(cursor);
  if (cursor.eof()) throw new XmlRejection('malformed_xml', 'missing_root');
  const open = readOpenTag(cursor, 1);
  const totals = emptyTotals();
  const anomalies = new AnomalySink();
  let rootAttributes: ReadonlyMap<string, string> | undefined;
  if (open.name === 'testsuites') {
    rootAttributes = open.attributes;
    parseTestsuitesBody(cursor, open, totals, anomalies);
  } else if (open.name === 'testsuite') {
    recordSuite(totals, anomalies, open.attributes, parseSuiteBody(cursor, open));
  } else {
    rejectUnsupported(cursor, open);
  }
  skipMisc(cursor);
  if (!cursor.eof()) throw new XmlRejection('malformed_xml', 'trailing_content');
  return evaluateDocument(totals, rootAttributes, anomalies);
}

function checkDeclaredCount(
  anomalies: AnomalySink,
  scope: string,
  attributes: ReadonlyMap<string, string>,
  name: string,
  actual: number,
): void {
  const declared = attributes.get(name);
  if (declared === undefined) return;
  if (Number(declared) !== actual) {
    anomalies.add(`count_mismatch:${scope}.${name}:declared=${declared}:actual=${actual}`);
  }
}

function checkCountAttributes(
  anomalies: AnomalySink,
  scope: string,
  attributes: ReadonlyMap<string, string>,
  actual: SuiteCounts,
): void {
  checkDeclaredCount(anomalies, scope, attributes, 'tests', actual.tests);
  checkDeclaredCount(anomalies, scope, attributes, 'failures', actual.failures);
  checkDeclaredCount(anomalies, scope, attributes, 'errors', actual.errors);
  checkDeclaredCount(anomalies, scope, attributes, 'skipped', actual.skipped);
  const declaredTests = attributes.get('tests');
  if (declaredTests === undefined) return;
  const declaredStatuses = Number(attributes.get('failures') ?? 0)
    + Number(attributes.get('errors') ?? 0)
    + Number(attributes.get('skipped') ?? 0);
  if (declaredStatuses > Number(declaredTests)) {
    anomalies.add(`contradictory_counts:${scope}:tests=${declaredTests}:failures_errors_skipped=${declaredStatuses}`);
  }
}

function evaluateDocument(
  totals: DocumentTotals,
  rootAttributes: ReadonlyMap<string, string> | undefined,
  anomalies: AnomalySink,
): JUnitXmlParseResult {
  if (rootAttributes !== undefined) {
    checkCountAttributes(anomalies, 'testsuites', rootAttributes, totals);
  }
  if (totals.tests === 0) anomalies.add('no_tests');
  return {
    // Derived from the full anomaly total, never from the capped list.
    ok: !anomalies.failed,
    counts: {
      pass: totals.tests - totals.failures - totals.errors - totals.skipped,
      fail: totals.failures + totals.errors,
      skipped: totals.skipped,
      todo: 0,
      cancelled: 0,
      suites: totals.suites,
      tests: totals.tests,
    },
    tests: totals.tests,
    failures: totals.failures,
    errors: totals.errors,
    anomalies: anomalies.snapshot(),
  };
}

function rejectedResult(reason: string): JUnitXmlParseResult {
  return {
    ok: false,
    counts: { pass: 0, fail: 0, skipped: 0, todo: 0, cancelled: 0, suites: 0, tests: 0 },
    tests: 0,
    failures: 0,
    errors: 0,
    anomalies: [`invalid_xml:${reason}`],
  };
}

/**
 * Parses one JUnit XML artifact. Total function: malformed, hostile or
 * oversized input returns `ok: false` plus anomaly codes, never a partial
 * count. `ok` means "internally consistent non-empty XML", not "verdict pass";
 * exit-code agreement is evaluated by the caller (ADR-014 §4.3). Retained state
 * is bounded: suites fold into totals as they close and anomalies stop at
 * `MAX_RETAINED_ANOMALIES` plus a summary entry.
 */
export function parseJUnitXml(input: string | Uint8Array): JUnitXmlParseResult {
  try {
    return parseDocument(decodeInput(input));
  } catch (error) {
    const reason = error instanceof XmlRejection ? error.reason : 'internal';
    return rejectedResult(reason);
  }
}
