import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { MAX_RETAINED_ANOMALIES, parseJUnitXml } from '../../src/gate/adapters/junit-xml.ts';

const root = new URL('../../', import.meta.url);
const MAX_BYTES = 16 * 1024 * 1024;

function rejected(input: string | Uint8Array, needle: string): void {
  const result = parseJUnitXml(input);
  assert.equal(result.ok, false, needle);
  assert.equal(result.tests, 0, needle);
  assert.ok(result.anomalies.some((anomaly) => anomaly.includes(needle)), `${needle}: ${JSON.stringify(result.anomalies)}`);
}

function wrap(body: string, attrs = 'tests="1" failures="0" errors="0" skipped="0"'): string {
  return `<testsuites><testsuite name="pytest" ${attrs}>${body}</testsuite></testsuites>`;
}

// ---------------------------------------------------------------------------
// Attack inputs: attempt first, then assert the parser refuses the count.
// ---------------------------------------------------------------------------

test('PY-04 redteam: XXE, external DTD and entity expansion never reach a count', () => {
  rejected('<?xml version="1.0"?><!DOCTYPE testsuites [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><testsuites><testsuite tests="1"><testcase name="t"><failure>&xxe;</failure></testcase></testsuite></testsuites>', 'doctype');
  rejected('<!DOCTYPE testsuites [<!ENTITY % file SYSTEM "file:///c:/windows/win.ini">%file;]><testsuites />', 'doctype');
  rejected('<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;">]><testsuites />', 'doctype');
  rejected('<!ENTITY standalone "boom"><testsuites />', 'entity_declaration');
});

test('PY-04 redteam: processing instructions after the initial declaration are refused', () => {
  rejected('<?xml-stylesheet type="text/xsl" href="forged.xsl"?><testsuites />', 'processing_instruction');
  rejected('<testsuites><?php echo "forged"; ?></testsuites>', 'processing_instruction');
});

test('PY-04 redteam: unquoted or duplicated attributes cannot smuggle counts', () => {
  rejected('<testsuite name="pytest" tests=1><testcase name="t" /></testsuite>', 'unquoted_attribute');
  rejected('<testsuite name="pytest" tests="1" failures=0 errors=0 skipped=0 />', 'unquoted_attribute');
  rejected('<testsuite name="pytest" tests="1" tests="99"><testcase name="t" /></testsuite>', 'duplicate_attribute');
});

test('PY-04 redteam: unknown entities and malformed numeric references are refused', () => {
  for (const entity of ['&xxe;', '&file;', '&system;', '&#xD800;', '&#0;', '&#x110000;']) {
    rejected(wrap(`<testcase name="t"><failure>${entity}</failure></testcase>`), entity.startsWith('&#') ? 'invalid_entity' : 'unknown_entity');
  }
  rejected('<testsuite name="pytest" tests="&amp;"><testcase name="t" /></testsuite>', 'invalid_count');
});

test('PY-04 redteam: control characters, lone surrogates and invalid UTF-8 are refused', () => {
  rejected(wrap('<testcase name="t"><failure>\u0001</failure></testcase>'), 'control:U+0001');
  rejected(wrap('<testcase name="t"><failure>\u001B[31m</failure></testcase>'), 'control:U+001B');
  rejected('\uDBFF'.repeat(2), 'lone_high_surrogate');
  rejected(new Uint8Array([0x3C, 0x74, 0x3E, 0xC0, 0xAF, 0x3C, 0x2F, 0x74, 0x3E]), 'invalid_utf8');
});

test('PY-04 redteam: a byte beyond the 16 MiB cap is rejected before parsing', () => {
  rejected(new Uint8Array(MAX_BYTES + 1), 'input_too_large');
  const text = 'x'.repeat(MAX_BYTES + 1);
  rejected(text, 'input_too_large');
});

test('PY-04 redteam: a 65-level chain hits the depth cap before it can be walked', () => {
  const deep = (levels: number): string => '<testsuites>' + '<x>'.repeat(levels - 1) + '</x>'.repeat(levels - 1) + '</testsuites>';
  const over = parseJUnitXml(deep(65));
  assert.equal(over.ok, false);
  assert.ok(over.anomalies.some((anomaly) => anomaly.includes('depth_exceeded')), JSON.stringify(over.anomalies));
  const at = parseJUnitXml(deep(64));
  assert.equal(at.ok, false);
  assert.ok(at.anomalies.some((anomaly) => anomaly.includes('unsupported_element')), JSON.stringify(at.anomalies));
});

test('PY-04 redteam: forged suite aggregates cannot turn a failing case green', () => {
  const forged = '<testsuites><testsuite name="pytest" tests="1" failures="0" errors="0" skipped="0">'
    + '<testcase name="fails"><failure message="boom">assert False</failure></testcase>'
    + '</testsuite></testsuites>';
  const result = parseJUnitXml(forged);
  assert.equal(result.ok, false);
  assert.equal(result.tests, 1);
  assert.equal(result.failures, 1);
  assert.equal(result.counts.fail, 1);
  assert.equal(result.counts.pass, 0);
  assert.ok(result.anomalies.some((anomaly) => anomaly.includes('testsuite[0].failures:declared=0:actual=1')));
  assert.equal(result.anomalies.length, 1);
});

test('PY-04 redteam: forged root aggregates and contradictory sums fail closed', () => {
  const forgedRoot = parseJUnitXml('<testsuites tests="99" failures="0" errors="0" skipped="0">'
    + '<testsuite tests="1" failures="0" errors="0" skipped="0"><testcase name="t" /></testsuite>'
    + '</testsuites>');
  assert.equal(forgedRoot.ok, false);
  assert.ok(forgedRoot.anomalies.some((anomaly) => anomaly.includes('testsuites.tests:declared=99:actual=1')));

  const contradictory = parseJUnitXml(wrap('<testcase name="t" />', 'tests="1" failures="1" errors="1" skipped="0"'));
  assert.equal(contradictory.ok, false);
  assert.ok(contradictory.anomalies.some((anomaly) => anomaly.startsWith('contradictory_counts:testsuite[0]')));
});

test('PY-04 redteam: mixed statuses on one testcase fail closed', () => {
  rejected(wrap('<testcase name="t"><failure /><error /></testcase>'), 'testcase_multiple_statuses');
  rejected(wrap('<testcase name="t"><skipped /><failure /></testcase>'), 'testcase_multiple_statuses');
});

test('PY-04 redteam: the authentic interrupt artifact cannot be read as success', async () => {
  const evidence = JSON.parse(await readFile(new URL('docs/evidence/s9-python-pytest.json', root), 'utf8')) as {
    results: Array<{ scenario: string; xmlSample?: string }>;
  };
  const interrupt = evidence.results.find((entry) => entry.scenario === 'interrupt');
  assert.ok(interrupt?.xmlSample);
  const result = parseJUnitXml(interrupt.xmlSample);
  assert.equal(result.ok, false);
  assert.ok(result.anomalies.some((anomaly) => anomaly.includes('count_mismatch:testsuite[0].tests:declared=0:actual=1')));
});

test('PY-04 redteam: a flood of forged counts cannot grow the retained diagnostic list', () => {
  const suites = 50_000;
  // Two forged counts per suite (tests/failures). The recount is 0/0, so every
  // suite is a mismatch; the cap must bound the retained list, not the verdict.
  const xml = `<testsuites>${'<testsuite tests="2" failures="2"/>'.repeat(suites)}</testsuites>`;
  const result = parseJUnitXml(xml);
  assert.equal(result.ok, false);
  assert.equal(result.counts.suites, suites);
  assert.equal(result.tests, 0);
  assert.equal(result.counts.pass, 0);
  assert.equal(result.counts.fail, 0);
  assert.equal(result.counts.skipped, 0);
  // 100k forged claims plus `no_tests`; only the cap is retained.
  assert.equal(result.anomalies.length, MAX_RETAINED_ANOMALIES + 1);
  assert.equal(result.anomalies[0], 'count_mismatch:testsuite[0].tests:declared=2:actual=0');
  assert.equal(result.anomalies[MAX_RETAINED_ANOMALIES], `anomaly_cap_reached:kept=${MAX_RETAINED_ANOMALIES}:dropped=${suites * 2 + 1 - MAX_RETAINED_ANOMALIES}`);
  // Bounded evidence payload: proportional to the cap, not to the suite count.
  assert.ok(JSON.stringify(result).length < 8192, `payload=${JSON.stringify(result).length}`);
});

// ---------------------------------------------------------------------------
// Exit-code evaluator boundary
// ---------------------------------------------------------------------------

test('PY-04 redteam: XML validity is not a verdict; exit-code cross-check stays out of this parser', () => {
  // Failing artifacts parse cleanly at the XML layer. ADR-014 §4.3 requires the
  // pytest adapter to combine this recount with the process exit code; treating
  // parser `ok` as a verdict would make `exit 1` look successful.
  const failing = parseJUnitXml(wrap('<testcase name="t"><failure message="boom" /></testcase>', 'tests="1" failures="1" errors="0" skipped="0"'));
  assert.equal(failing.ok, true);
  assert.equal(failing.failures, 1);
  assert.equal(failing.counts.fail, 1);

  // No exit code can enter the parser: the only parameter is the artifact.
  assert.equal(parseJUnitXml.length, 1);
  assert.deepEqual(Object.keys(failing).sort(), ['anomalies', 'counts', 'errors', 'failures', 'ok', 'tests']);
});

test('PY-04 redteam: a rewritten all-green XML is consistent at this layer (documented trust boundary)', () => {
  // conftest.py can overwrite the JUnit artifact before ANO reads it. The
  // parser must accept internally consistent XML; source trust is not a
  // cryptographic property (ADR-014 §4.5). This test records the boundary
  // instead of claiming the parser can detect a rewrite.
  const rewritten = '<testsuites><testsuite name="rewritten" tests="1" errors="0" failures="0" skipped="0">'
    + '<testcase classname="forged" name="all_green" /></testsuite></testsuites>';
  const result = parseJUnitXml(rewritten);
  assert.equal(result.ok, true);
  assert.deepEqual(result.counts, { pass: 1, fail: 0, skipped: 0, todo: 0, cancelled: 0, suites: 1, tests: 1 });
});
