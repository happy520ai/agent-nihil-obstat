import fs from 'node:fs';
import { join, resolve } from 'node:path';
import { sha256Hex } from './canonical.ts';
import { ConnectLimitError, ConnectSourceError, ConnectStoreError } from './errors.ts';
import { assertRealDirectory } from './paths.ts';

/**
 * Managed AGENTS.md section for the enforced takeover workflow (ADR-006 §4.2
 * `installed`, §5, §7). The section is wrapped in its own marker pair so it is
 * independent from any other automatically maintained block (for example the
 * pm-mcp maintained section) and never overwrites user content.
 */

export const MANAGED_INSTRUCTIONS_BEGIN = '<!-- ano:takeover:managed:v1:begin -->';
export const MANAGED_INSTRUCTIONS_END = '<!-- ano:takeover:managed:v1:end -->';
export const MANAGED_INSTRUCTIONS_SCHEMA = 'ano.takeover-managed-instructions/1';

/** Prefix of the policy-state declaration hook inside the managed section. */
export const MANAGED_STATE_DECLARATION_PREFIX = '策略状态：';

/** Hard ceiling for the section body; a larger body is rejected, never truncated. */
export const MAX_MANAGED_INSTRUCTIONS_BYTES = 64 * 1024;

/** The default workflow section declares all four ANO-owned scopes. */
export const MANAGED_INSTRUCTIONS_REQUIRED_SCOPES = ['tasks', 'memory', 'acceptance', 'dag'] as const;
export type TakeoverScope = (typeof MANAGED_INSTRUCTIONS_REQUIRED_SCOPES)[number];

const ALLOWED_SCOPES: readonly string[] = MANAGED_INSTRUCTIONS_REQUIRED_SCOPES;
const FORGED_MARKER = /<!--\s*ano:takeover:managed:v1\s*:\s*(?:begin|end)\s*-->/u;

/**
 * Conservative active-content policy for caller-supplied section bodies
 * (F-01 / ADR-006 §4.2 `installed`): AGENTS.md is read as instructions by a
 * model, so executable HTML must never enter the ANO-managed span. The default
 * rendered body contains none of these patterns.
 */
const ACTIVE_CONTENT_PATTERNS: readonly { pattern: RegExp; label: string }[] = [
  { pattern: /<\s*script\b/iu, label: '<script>' },
  { pattern: /<\s*iframe\b/iu, label: '<iframe>' },
  { pattern: /<\s*object\b/iu, label: '<object>' },
  { pattern: /<\s*embed\b/iu, label: '<embed>' },
  { pattern: /<\s*(?:meta|link)\b[^>]*\bhttp-equiv\b/iu, label: 'meta refresh' },
  {
    pattern: /\bon(?:error|load|click|dblclick|mousedown|mouseup|mouseover|mouseout|mousemove|focus|blur|change|input|invalid|submit|reset|select|keydown|keyup|keypress|drag|dragstart|dragend|drop|wheel|scroll|toggle|copy|cut|paste)\s*=/iu,
    label: 'inline event handler',
  },
  { pattern: /javascript\s*:/iu, label: 'javascript:' },
  { pattern: /data\s*:\s*text\/html/iu, label: 'data:text/html' },
];

/** Reject executable/active HTML before any byte of AGENTS.md is written. */
export function assertNoActiveContent(content: string): void {
  for (const { pattern, label } of ACTIVE_CONTENT_PATTERNS) {
    if (pattern.test(content)) {
      throw new ConnectSourceError(`Managed instructions content must not contain active HTML or JavaScript (${label})`);
    }
  }
}

/**
 * Authorization credential accepted by the managed-section writers. It is the
 * project-local `.ano/takeover/authorization.json` record (ADR-006 §3.2). The
 * writer only proves that the caller holds a structurally valid, non-revoked
 * authorization bound to the same canonical root and covering every scope the
 * default section declares; it never treats this as a host permission.
 */
export interface ManagedInstructionsAuthorization {
  readonly authorizationId: string;
  readonly root: string;
  /** Validated at runtime against MANAGED_INSTRUCTIONS_REQUIRED_SCOPES. */
  readonly scope: readonly string[];
  readonly grantedBy: string;
  readonly statement: string;
  readonly grantedAt: string;
  readonly revokedAt?: string | null | undefined;
}

export interface ManagedInstructionsOptions {
  /**
   * Explicit authorization credential. Missing, malformed, revoked,
   * cross-root, or scope-insufficient values fail closed before any byte is
   * written.
   */
  readonly confirm?: ManagedInstructionsAuthorization;
  /**
   * Exit-maintenance opt-in for `removeManagedInstructions` only: permits the
   * removal of the managed section while the authorization is revoked, during
   * an explicit `takeover recover` that restores the old primary writer. It is
   * ignored by install/update, so a revoked grant can never inject content.
   */
  readonly allowRevokedRemoval?: boolean;
}

export type ManagedInstructionsAction = 'installed' | 'updated' | 'removed' | 'unchanged' | 'absent';

export interface ManagedInstructionsResult {
  readonly root: string;
  readonly file: string;
  readonly action: ManagedInstructionsAction;
  readonly changed: boolean;
  readonly bytes: number;
  readonly previousBytes: number;
  readonly contentHash: string;
}

/** The policy-state declaration line; T-067 can substitute the enforced state. */
export function managedStateDeclaration(policyState: string): string {
  return `- ${MANAGED_STATE_DECLARATION_PREFIX}${policyState}`;
}

/** Default ANO workflow body. Declares ANO ownership and old-PM read-only role. */
export function renderDefaultManagedInstructions(policyState = 'enforced'): string {
  return [
    '<!-- ANO 接管工作流（受管段，自动维护） -->',
    '',
    `schema: ${MANAGED_INSTRUCTIONS_SCHEMA}`,
    '',
    '- 本段由 ANO 强制接管流程维护；策略状态以 `.ano/takeover/policy.json` 为准。',
    managedStateDeclaration(policyState),
    '- 默认工作流使用 ANO：brief / 任务 / 记忆 / 验收 / DAG。',
    '- 旧 PM（PM-mcp 与 .pm/）在接管生效期间为只读来源，不主写。',
    '- 移除本段不等于撤销授权；退出接管须执行 takeover disable/recover。',
  ].join('\n');
}

export const DEFAULT_MANAGED_INSTRUCTIONS = renderDefaultManagedInstructions();

interface SegmentMatch {
  readonly beginIndex: number;
  /** Index of the first character of the end marker. */
  readonly endIndex: number;
  /** Body between the markers, CRLF-normalized, without the surrounding newlines. */
  readonly content: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;
}

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let index = 0;
  for (;;) {
    const found = text.indexOf(needle, index);
    if (found === -1) return count;
    count += 1;
    index = found + needle.length;
  }
}

function newlineLengthAt(text: string, index: number): number {
  if (index < 0 || index >= text.length) return 0;
  if (text.startsWith('\r\n', index)) return 2;
  const char = text[index];
  return char === '\n' || char === '\r' ? 1 : 0;
}

function precedingNewlineLength(text: string, index: number): number {
  if (index <= 0 || index > text.length) return 0;
  if (text[index - 1] === '\n') return index >= 2 && text[index - 2] === '\r' ? 2 : 1;
  if (text[index - 1] === '\r') return 1;
  return 0;
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/** Reject a body that tries to forge or nest managed markers. */
export function assertNoForgedManagedMarkers(content: string): void {
  if (FORGED_MARKER.test(content)) {
    throw new ConnectSourceError('Managed instructions content must not contain managed markers');
  }
}

function parseManagedSegment(text: string): SegmentMatch | null {
  const beginCount = countOccurrences(text, MANAGED_INSTRUCTIONS_BEGIN);
  const endCount = countOccurrences(text, MANAGED_INSTRUCTIONS_END);
  if (beginCount === 0 && endCount === 0) return null;
  if (beginCount !== 1 || endCount !== 1) {
    throw new ConnectStoreError(
      `AGENTS.md must contain at most one managed section (found ${beginCount} begin / ${endCount} end markers)`,
    );
  }
  const beginIndex = text.indexOf(MANAGED_INSTRUCTIONS_BEGIN);
  const endIndex = text.indexOf(MANAGED_INSTRUCTIONS_END);
  if (endIndex < beginIndex) {
    throw new ConnectStoreError('Managed instructions end marker appears before the begin marker');
  }
  const afterBegin = newlineLengthAt(text, beginIndex + MANAGED_INSTRUCTIONS_BEGIN.length);
  if (afterBegin === 0) {
    throw new ConnectStoreError('Managed instructions begin marker must be alone on its line');
  }
  const contentStart = beginIndex + MANAGED_INSTRUCTIONS_BEGIN.length + afterBegin;
  const beforeEnd = precedingNewlineLength(text, endIndex);
  if (beforeEnd === 0) {
    throw new ConnectStoreError('Managed instructions end marker must be alone on its line');
  }
  const contentEnd = endIndex - beforeEnd;
  if (contentEnd < contentStart) {
    throw new ConnectStoreError('Managed instructions section is empty or malformed');
  }
  const afterEnd = endIndex + MANAGED_INSTRUCTIONS_END.length;
  if (afterEnd < text.length && newlineLengthAt(text, afterEnd) === 0) {
    throw new ConnectStoreError('Managed instructions end marker must be alone on its line');
  }
  const rawContent = text.slice(contentStart, contentEnd);
  assertNoForgedManagedMarkers(rawContent);
  return { beginIndex, endIndex, content: normalizeNewlines(rawContent) };
}

/** Validate caller-supplied body and return the canonical LF form. */
function assertValidManagedContent(content: string): string {
  if (typeof content !== 'string') throw new ConnectSourceError('Managed instructions content must be a string');
  if (content.length === 0 || content.trim().length === 0) {
    throw new ConnectSourceError('Managed instructions content must not be empty');
  }
  if (content.includes('\0')) throw new ConnectSourceError('Managed instructions content must not contain NUL');
  assertNoForgedManagedMarkers(content);
  assertNoActiveContent(content);
  const normalized = normalizeNewlines(content);
  const bytes = Buffer.byteLength(normalized, 'utf8');
  if (bytes > MAX_MANAGED_INSTRUCTIONS_BYTES) {
    throw new ConnectLimitError(
      `Managed instructions content is ${bytes} bytes; the limit is ${MAX_MANAGED_INSTRUCTIONS_BYTES} bytes`,
    );
  }
  return normalized;
}

function sameCanonicalRoot(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  if (a === b) return true;
  return process.platform === 'win32' && a.toLowerCase() === b.toLowerCase();
}

function assertAuthorization(confirm: unknown, canonicalRoot: string, allowRevokedRemoval = false): ManagedInstructionsAuthorization {
  if (confirm === null || typeof confirm !== 'object' || Array.isArray(confirm)) {
    throw new ConnectSourceError('Missing explicit authorization credential (confirm)');
  }
  const record = confirm as Record<string, unknown>;
  const authorizationId = record.authorizationId;
  if (typeof authorizationId !== 'string' || authorizationId.trim().length === 0) {
    throw new ConnectSourceError('Authorization authorizationId must be a non-empty string');
  }
  if (typeof record.root !== 'string' || !sameCanonicalRoot(record.root, canonicalRoot)) {
    throw new ConnectSourceError('Authorization is not bound to the target project root');
  }
  if (!Array.isArray(record.scope) || record.scope.length === 0) {
    throw new ConnectSourceError('Authorization scope must be a non-empty array');
  }
  const scopes: TakeoverScope[] = [];
  for (const entry of record.scope) {
    if (typeof entry !== 'string' || !ALLOWED_SCOPES.includes(entry)) {
      throw new ConnectSourceError(`Authorization scope contains an unknown value: ${String(entry)}`);
    }
    if (!scopes.includes(entry as TakeoverScope)) scopes.push(entry as TakeoverScope);
  }
  for (const required of MANAGED_INSTRUCTIONS_REQUIRED_SCOPES) {
    if (!scopes.includes(required)) {
      throw new ConnectSourceError(`Authorization scope does not include the required scope: ${required}`);
    }
  }
  if (typeof record.grantedBy !== 'string' || record.grantedBy.trim().length === 0) {
    throw new ConnectSourceError('Authorization grantedBy must be a non-empty string');
  }
  if (typeof record.statement !== 'string' || record.statement.trim().length === 0) {
    throw new ConnectSourceError('Authorization statement must be a non-empty string');
  }
  if (typeof record.grantedAt !== 'string' || !Number.isFinite(Date.parse(record.grantedAt))) {
    throw new ConnectSourceError('Authorization grantedAt must be an ISO 8601 timestamp');
  }
  if (record.revokedAt !== undefined && record.revokedAt !== null && !allowRevokedRemoval) {
    throw new ConnectSourceError('Authorization has been revoked and cannot be used for managed writes');
  }
  return {
    authorizationId,
    root: String(record.root),
    scope: scopes,
    grantedBy: String(record.grantedBy),
    statement: String(record.statement),
    grantedAt: String(record.grantedAt),
  };
}

function requireAuthorization(confirm: unknown, canonicalRoot: string, allowRevokedRemoval = false): ManagedInstructionsAuthorization {
  if (confirm === undefined) {
    throw new ConnectSourceError('Missing explicit authorization credential (confirm)');
  }
  return assertAuthorization(confirm, canonicalRoot, allowRevokedRemoval);
}

function resolveTargetFile(targetRoot: string): { root: string; file: string } {
  if (typeof targetRoot !== 'string' || targetRoot.trim().length === 0) {
    throw new ConnectSourceError('Target project root must be a non-empty path');
  }
  const root = resolve(targetRoot);
  // Rejects a missing root, a non-directory, and a symlink/junction root.
  assertRealDirectory(root, 'Target root');
  const file = join(root, 'AGENTS.md');
  let stats: fs.Stats | undefined;
  try {
    stats = fs.lstatSync(file);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      throw new ConnectStoreError(`Unable to inspect ${file}: ${errorMessage(error)}`);
    }
  }
  if (stats !== undefined) {
    if (stats.isSymbolicLink()) {
      throw new ConnectSourceError(`Refusing to write through a symbolic link: ${file}`);
    }
    if (!stats.isFile()) {
      throw new ConnectSourceError(`AGENTS.md is not a regular file: ${file}`);
    }
  }
  return { root, file };
}

function readOriginalBytes(file: string): Buffer | null {
  try {
    return fs.readFileSync(file);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw new ConnectStoreError(`Unable to read ${file}: ${errorMessage(error)}`);
  }
}

/**
 * Write `next`, restoring the exact original bytes if the write fails. A
 * failed append (no original) removes a partially created file. The original
 * buffer is always captured before the first byte is written.
 */
function writeWithRollback(file: string, original: Buffer | null, next: Buffer): void {
  if (original !== null && original.equals(next)) return;
  try {
    fs.writeFileSync(file, next);
  } catch (error) {
    try {
      if (original === null) {
        try {
          fs.unlinkSync(file);
        } catch {
          /* the file may not have been created */
        }
      } else {
        fs.writeFileSync(file, original);
      }
    } catch (restoreError) {
      throw new ConnectStoreError(
        `Writing ${file} failed and the original bytes could not be restored: ${errorMessage(error)}; restore: ${errorMessage(restoreError)}`,
      );
    }
    throw new ConnectStoreError(`Writing ${file} failed; original bytes were restored: ${errorMessage(error)}`);
  }
}

function renderSegment(content: string): string {
  return `${MANAGED_INSTRUCTIONS_BEGIN}\n${content}\n${MANAGED_INSTRUCTIONS_END}`;
}

function appendSegment(text: string, content: string): string {
  let prefix = text;
  if (prefix.length > 0) {
    if (prefix.endsWith('\r\n')) prefix += '\r\n';
    else if (prefix.endsWith('\n')) prefix += '\n';
    else prefix += '\n\n';
  }
  return `${prefix}${renderSegment(content)}\n`;
}

function replaceSegment(text: string, match: SegmentMatch, content: string): string {
  return `${text.slice(0, match.beginIndex)}${renderSegment(content)}${text.slice(match.endIndex + MANAGED_INSTRUCTIONS_END.length)}`;
}

/** Remove trailing blank lines but keep a single trailing newline when one existed. */
function stripTrailingBlankLines(text: string): string {
  const endedWithNewline = /(?:\r\n|\n|\r)$/u.test(text);
  const lines = text.split('\n');
  while (lines.length > 0 && /^[ \t\r]*$/u.test(lines[lines.length - 1] ?? '')) lines.pop();
  let result = lines.join('\n');
  if (endedWithNewline && !/(?:\r\n|\n|\r)$/u.test(result)) result += '\n';
  return result;
}

function removeSegment(text: string, match: SegmentMatch): string {
  let prefix = text.slice(0, match.beginIndex);
  let suffix = text.slice(match.endIndex + MANAGED_INSTRUCTIONS_END.length);
  // Remove the separator newline that install appended after the end marker.
  if (suffix.startsWith('\r\n')) suffix = suffix.slice(2);
  else if (suffix.startsWith('\n')) suffix = suffix.slice(1);
  // Remove the blank separator line that install inserted before the section.
  if (prefix.endsWith('\r\n')) prefix = prefix.slice(0, -2);
  else if (prefix.endsWith('\n')) prefix = prefix.slice(0, -1);
  return stripTrailingBlankLines(prefix + suffix);
}

function result(
  file: string,
  root: string,
  action: ManagedInstructionsAction,
  previous: Buffer | null,
  next: Buffer,
  content: string,
): ManagedInstructionsResult {
  return {
    root,
    file,
    action,
    changed: previous === null ? next.length > 0 : !previous.equals(next),
    bytes: next.length,
    previousBytes: previous === null ? 0 : previous.length,
    contentHash: sha256Hex(content),
  };
}

function upsertManagedInstructions(
  targetRoot: string,
  content: string,
  options: ManagedInstructionsOptions,
): ManagedInstructionsResult {
  const { root, file } = resolveTargetFile(targetRoot);
  requireAuthorization(options.confirm, root);
  const body = assertValidManagedContent(content);
  const original = readOriginalBytes(file);
  const text = original === null ? '' : original.toString('utf8');
  const match = parseManagedSegment(text);
  if (match === null) {
    const next = appendSegment(text, body);
    writeWithRollback(file, original, Buffer.from(next, 'utf8'));
    return result(file, root, 'installed', original, Buffer.from(next, 'utf8'), body);
  }
  if (match.content === body) {
    return result(file, root, 'unchanged', original, original ?? Buffer.alloc(0), body);
  }
  const next = replaceSegment(text, match, body);
  const nextBuffer = Buffer.from(next, 'utf8');
  writeWithRollback(file, original, nextBuffer);
  return result(file, root, 'updated', original, nextBuffer, body);
}

/**
 * Idempotently install the managed section. No section: append. Same body:
 * zero-byte change. Different body: replace only the managed span, leaving
 * every other byte of AGENTS.md untouched. Requires an explicit authorization
 * credential; without one nothing is written.
 */
export function installManagedInstructions(
  targetRoot: string,
  content: string = DEFAULT_MANAGED_INSTRUCTIONS,
  options: ManagedInstructionsOptions = {},
): ManagedInstructionsResult {
  return upsertManagedInstructions(targetRoot, content, options);
}

/**
 * Idempotently update the managed section. Same semantics as install: absent
 * section installs, identical body is a no-op, different body replaces only
 * the managed span.
 */
export function updateManagedInstructions(
  targetRoot: string,
  content: string = DEFAULT_MANAGED_INSTRUCTIONS,
  options: ManagedInstructionsOptions = {},
): ManagedInstructionsResult {
  return upsertManagedInstructions(targetRoot, content, options);
}

/**
 * Remove the managed section and its separator residue. User content outside
 * the section is preserved. Removing an absent section is a zero-byte no-op.
 * Requires an explicit authorization credential.
 */
export function removeManagedInstructions(
  targetRoot: string,
  options: ManagedInstructionsOptions = {},
): ManagedInstructionsResult {
  const { root, file } = resolveTargetFile(targetRoot);
  requireAuthorization(options.confirm, root, options.allowRevokedRemoval === true);
  const original = readOriginalBytes(file);
  const text = original === null ? '' : original.toString('utf8');
  const match = parseManagedSegment(text);
  if (match === null) {
    return result(file, root, 'absent', original, original ?? Buffer.alloc(0), '');
  }
  const next = removeSegment(text, match);
  const nextBuffer = Buffer.from(next, 'utf8');
  writeWithRollback(file, original, nextBuffer);
  return result(file, root, 'removed', original, nextBuffer, '');
}
