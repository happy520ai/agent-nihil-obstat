import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { canonicalJson, sha256Hex } from '../connect/canonical.ts';

/**
 * Client configuration read/write adapter (ADR-007 §5.4 `config`, M11/T-081).
 *
 * This module owns the client configuration write path exclusively: adapters
 * (T-082~T-084) declare `configTargets` (path/format/key) and must never write
 * files themselves. It is deliberately self-contained and synchronous, in the
 * style of `src/connect/managed-instructions.ts` and `src/connect/takeover-store.ts`.
 *
 * Contract highlights (ADR-007 §2 hard boundaries):
 * - read-only by default; dry-run is the default and writes nothing;
 * - apply requires an explicit `confirm` flag plus a project-local authorization
 *   record bound to the same canonical root and clientId;
 * - every authorized write is preceded by a content-hash backup and a `beforeHash`
 *   drift check (concurrent modification is refused, zero write);
 * - merges only add/update the `ano` entry, preserving other MCP services and
 *   unknown fields;
 * - path escape and symlink traversal are refused;
 * - a partial write is rolled back to the exact original bytes.
 *
 * Type note: `src/clients/types.ts` (T-080) is owned by a parallel task and does
 * not exist yet. The minimal shapes below mirror ADR-007 §5.4
 * (`ConfigTarget` / `ClientAuthorizationRef` / `ConfigResult`) and are local
 * stand-ins; T-080/T-085 should consolidate them.
 */

export const CLIENT_CONFIG_BACKUP_SCHEMA = 'ano.client-config-backup/1' as const;
export const CLIENT_CONFIG_INSTALL_SCHEMA = 'ano.client-install/1' as const;

/** Scopes a client authorization may carry (ADR-007 §5.6). */
export const CLIENT_CONFIG_SCOPES = ['detect', 'inspect', 'config', 'install', 'restore'] as const;
export type ClientConfigScopeName = (typeof CLIENT_CONFIG_SCOPES)[number];

export type ClientConfigFormat = 'json' | 'toml';
export type ClientConfigScope = 'user' | 'project' | 'workspace';

/**
 * A declared client configuration target. Paths are injected by the caller
 * (adapter or test); this module never hardcodes a user home directory.
 */
export interface ClientConfigTarget {
  readonly clientId: string;
  readonly scope: ClientConfigScope;
  /** Absolute candidate path of the client configuration file. */
  readonly path: string;
  readonly format: ClientConfigFormat;
  /** Path of the MCP servers container inside the document, e.g. ['mcpServers'] or ['mcp','servers']. */
  readonly serverPath: readonly string[];
  /** MCP server entry name; ANO uses `ano`. */
  readonly serverName: string;
  /** Declared scope boundary: the resolved config path must stay inside it. */
  readonly allowedRoot: string;
}

/**
 * Project-local authorization credential (ADR-007 §5.6). This is not a token
 * and grants no host permission; it only proves a named human granted the write.
 */
export interface ClientConfigAuthorization {
  readonly authorizationId: string;
  readonly root: string;
  readonly clientId: string;
  readonly scope: readonly string[];
  readonly grantedBy: string;
  readonly statement: string;
  readonly grantedAt: string;
  readonly revokedAt?: string | null | undefined;
}

export interface ClientConfigServiceEntry {
  readonly name: string;
  readonly value: unknown;
}

export interface ClientConfigSnapshot {
  readonly target: ClientConfigTarget;
  readonly exists: boolean;
  readonly bytes: number;
  readonly beforeHash: string | null;
  readonly format: ClientConfigFormat;
  /** TOML (and any non-JSON format) is read-only in v1; flagged degraded. */
  readonly degraded: boolean;
  readonly document: unknown;
  readonly containerFound: boolean;
  readonly services: readonly ClientConfigServiceEntry[];
  readonly anoEntry: unknown;
  readonly warnings: readonly string[];
}

export interface ClientConfigChange {
  readonly kind: 'add-server' | 'update-server' | 'remove-server' | 'unchanged';
  readonly serverName: string;
  readonly serverPath: readonly string[];
  readonly before: unknown;
  readonly after: unknown;
}

export interface ClientConfigPlan {
  readonly target: ClientConfigTarget;
  readonly snapshot: ClientConfigSnapshot;
  readonly changes: readonly ClientConfigChange[];
  readonly changed: boolean;
  readonly before: unknown;
  readonly after: unknown;
  /** Serialized prospective bytes; null when the format is not writable in v1. */
  readonly mergedBytes: Buffer | null;
  readonly afterHash: string | null;
  readonly warnings: readonly string[];
}

export interface ClientConfigResult {
  readonly mode: 'dry-run' | 'apply';
  readonly applied: boolean;
  /** True when an apply was requested but refused (missing confirm/authorization/format). */
  readonly refused: boolean;
  readonly target: ClientConfigTarget;
  readonly changes: readonly ClientConfigChange[];
  readonly warnings: readonly string[];
  readonly beforeHash: string | null;
  readonly afterHash: string | null;
  readonly changed: boolean;
  readonly backupId: string | null;
  readonly backupHash: string | null;
  readonly backupPath: string | null;
  readonly restoredOnFailure: boolean;
  readonly error: string | null;
}

export interface ClientConfigBackup {
  readonly id: string;
  readonly dir: string;
  readonly file: string;
  readonly manifestPath: string;
  readonly clientId: string;
  readonly targetPath: string;
  readonly bytes: number;
  readonly beforeHash: string;
  readonly backupHash: string;
}

export interface ClientConfigBackupVerification {
  readonly ok: boolean;
  readonly id: string;
  readonly errors: readonly string[];
  readonly beforeHash: string | null;
  readonly backupHash: string | null;
  readonly bytes: number;
  readonly path: string | null;
}

export interface ClientConfigDiscovery {
  readonly target: ClientConfigTarget | null;
  readonly found: string | null;
  readonly rejected: readonly { path: string; reason: string }[];
  readonly missing: readonly string[];
}

/** Injectable filesystem seam so tests can prove rollback after a failed write. */
export interface ClientConfigIo {
  readonly atomicWrite: (file: string, bytes: Buffer) => void;
}

export interface ClientConfigHooks {
  /** Test seam: invoked after the backup is verified and before the drift check. */
  readonly afterBackup?: (context: { target: ClientConfigTarget; file: string; beforeHash: string }) => void;
}

export interface ClientConfigApplyOptions {
  readonly mode?: 'dry-run' | 'apply';
  readonly confirm?: boolean;
  readonly authorization?: ClientConfigAuthorization;
  /** Defaults to true; install forces it on. */
  readonly backup?: boolean;
  /** Canonical project root that owns `.ano/clients/`. Required for apply. */
  readonly root?: string;
  readonly backupId?: string;
  readonly now?: string;
  readonly io?: ClientConfigIo;
  readonly hooks?: ClientConfigHooks;
}

export type ClientConfigErrorCode =
  | 'CLIENT_CONFIG_AUTH'
  | 'CLIENT_CONFIG_PATH'
  | 'CLIENT_CONFIG_FORMAT'
  | 'CLIENT_CONFIG_DRIFT'
  | 'CLIENT_CONFIG_BACKUP'
  | 'CLIENT_CONFIG_WRITE'
  | 'CLIENT_CONFIG_ROOT';

export class ClientConfigError extends Error {
  readonly code: ClientConfigErrorCode;
  constructor(code: ClientConfigErrorCode, message: string) {
    super(message);
    this.name = 'ClientConfigError';
    this.code = code;
  }
}

// ---- small utilities ----------------------------------------------------

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function sameCanonicalPath(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  if (a === b) return true;
  return process.platform === 'win32' && a.toLowerCase() === b.toLowerCase();
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Order-preserving JSON serialization; unknown keys and their order survive. */
function stringifyJson(document: unknown): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

function assertSafeClientId(clientId: string): void {
  if (typeof clientId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(clientId) || clientId === '..' || clientId === '.') {
    throw new ClientConfigError('CLIENT_CONFIG_PATH', `Unsafe clientId: ${String(clientId)}`);
  }
}

/**
 * Conservative sensitive-path policy for client configuration targets
 * (T-101 / D2 fix). Mirrors `src/surface/service.ts` (T-088/O-01) and
 * `src/connect/backup.ts` (ADR-006 §2.5): an explicit target may never point
 * at an environment file, credential store, token store or key material, at
 * the library level as well as the CLI surface. Declared default targets are
 * fixed constants and are not affected.
 */
const SENSITIVE_CONFIG_DIRECTORY = /^(?:secrets?|credentials?|passwords?|tokens?|private(?:-?keys?)?)$/iu;
const SENSITIVE_CONFIG_FILE = /(?:^|[._-])(?:secret|secrets|credential|credentials|password|passwords|token|tokens|api[-_]?key|private[-_]?key)$/iu;
const SENSITIVE_KEY_MATERIAL = /\.(?:pem|key|p12|pfx|kdbx|ppk)$/iu;

/** Returns the reason a path is sensitive, or null when it is allowed. */
export function sensitiveConfigPathReason(path: string): string | null {
  const segments = path.split(/[\\/]/u);
  const base = segments.at(-1) ?? '';
  if (/^\.env(?:[.].*)?$/u.test(base)) return 'environment file';
  if (segments.some((segment) => SENSITIVE_CONFIG_DIRECTORY.test(segment))) return 'sensitive directory';
  if (/^credentials\.json$/iu.test(base)) return 'credential store';
  if (SENSITIVE_CONFIG_FILE.test(base)) return 'sensitive file name';
  if (SENSITIVE_KEY_MATERIAL.test(base)) return 'key material';
  if (base === 'id_rsa' || base === 'id_ed25519') return 'ssh private key';
  return null;
}

/** Refuses a sensitive configuration path at every library entry point. */
export function assertSafeConfigPath(path: string): void {
  const reason = sensitiveConfigPathReason(path);
  if (reason !== null) {
    throw new ClientConfigError('CLIENT_CONFIG_PATH', `Config path points at a sensitive location (${reason}); refusing to read/write: ${path}`);
  }
}

function requireProjectRoot(root: string | undefined): string {
  if (typeof root !== 'string' || root.trim().length === 0) {
    throw new ClientConfigError('CLIENT_CONFIG_ROOT', 'A canonical project root is required for authorized client-config writes');
  }
  const absolute = resolve(root);
  let stats;
  try {
    stats = lstatSync(absolute);
  } catch {
    throw new ClientConfigError('CLIENT_CONFIG_ROOT', `Project root does not exist: ${absolute}`);
  }
  if (stats.isSymbolicLink()) {
    try {
      return realpathSync(absolute);
    } catch {
      throw new ClientConfigError('CLIENT_CONFIG_ROOT', `Project root is a broken link: ${absolute}`);
    }
  }
  if (!stats.isDirectory()) {
    throw new ClientConfigError('CLIENT_CONFIG_ROOT', `Project root is not a directory: ${absolute}`);
  }
  return absolute;
}

/** Exported for install orchestration, which needs the same canonical root. */
export function resolveClientConfigRoot(root: string | undefined): string {
  return requireProjectRoot(root);
}

/** Walk existing directory components, refusing symlinks/junctions. */
function assertSafeDirectoryChain(dir: string): void {
  const resolved = resolve(dir);
  const parts = resolved.split(sep).filter((part) => part.length > 0);
  let current = resolved.startsWith(sep) ? sep : '';
  if (parts.length > 0 && /^[A-Za-z]:$/.test(parts[0] ?? '')) {
    current = `${parts[0] ?? ''}${sep}`;
    parts.shift();
  }
  for (const part of parts) {
    current = join(current, part);
    let stats;
    try {
      stats = lstatSync(current);
    } catch {
      return; // Missing tail: nothing below it can exist.
    }
    if (stats.isSymbolicLink()) {
      throw new ClientConfigError('CLIENT_CONFIG_PATH', `Refusing to traverse a symbolic link/junction: ${current}`);
    }
    if (!stats.isDirectory()) {
      throw new ClientConfigError('CLIENT_CONFIG_PATH', `Not a directory: ${current}`);
    }
  }
}

export function clientConfigBackupDir(root: string, clientId: string): string {
  assertSafeClientId(clientId);
  return join(requireProjectRoot(root), '.ano', 'clients', 'backups', clientId);
}

/**
 * Reserved object keys must never be used as a server container path: a bare
 * `current['__proto__']` read/write navigates the prototype chain and pollutes
 * `Object.prototype` (T-088/F-01, reproduced by an independent-process probe).
 * Reject them at every entry point instead of trusting the caller.
 */
const RESERVED_SERVER_PATH_KEYS: ReadonlySet<string> = new Set(['__proto__', 'prototype', 'constructor']);

export function assertSafeServerPath(serverPath: readonly string[]): void {
  if (!Array.isArray(serverPath) || serverPath.length === 0) {
    throw new ClientConfigError('CLIENT_CONFIG_PATH', 'serverPath must be a non-empty array');
  }
  for (const segment of serverPath) {
    if (typeof segment !== 'string' || segment.length === 0 || segment.includes('\0')) {
      throw new ClientConfigError('CLIENT_CONFIG_PATH', `Invalid serverPath segment: ${String(segment)}`);
    }
    if (RESERVED_SERVER_PATH_KEYS.has(segment)) {
      throw new ClientConfigError('CLIENT_CONFIG_PATH', `Refusing reserved serverPath segment: ${segment}`);
    }
  }
}

/**
 * Resolve and validate a target path. Refuses escape from the declared scope,
 * symlinked files/directories, non-regular files, and reserved serverPath keys.
 */
export function assertSafeTargetPath(target: ClientConfigTarget): string {
  if (typeof target.path !== 'string' || target.path.trim().length === 0) {
    throw new ClientConfigError('CLIENT_CONFIG_PATH', 'Config path must be a non-empty string');
  }
  if (typeof target.allowedRoot !== 'string' || target.allowedRoot.trim().length === 0) {
    throw new ClientConfigError('CLIENT_CONFIG_PATH', 'allowedRoot must be a non-empty string');
  }
  assertSafeServerPath(target.serverPath);
  if (typeof target.serverName !== 'string' || target.serverName.length === 0) {
    throw new ClientConfigError('CLIENT_CONFIG_PATH', 'serverName must be a non-empty string');
  }
  assertSafeClientId(target.clientId);

  const allowedRoot = resolve(target.allowedRoot);
  const file = resolve(target.path);
  assertSafeConfigPath(file);
  if (!isWithin(allowedRoot, file)) {
    throw new ClientConfigError('CLIENT_CONFIG_PATH', `Config path escapes the declared scope: ${file}`);
  }
  assertSafeDirectoryChain(dirname(file));

  let stats;
  try {
    stats = lstatSync(file);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      throw new ClientConfigError('CLIENT_CONFIG_PATH', `Unable to inspect ${file}: ${errorMessage(error)}`);
    }
  }
  if (stats !== undefined) {
    if (stats.isSymbolicLink()) {
      throw new ClientConfigError('CLIENT_CONFIG_PATH', `Refusing to read/write through a symbolic link: ${file}`);
    }
    if (!stats.isFile()) {
      throw new ClientConfigError('CLIENT_CONFIG_PATH', `Config path is not a regular file: ${file}`);
    }
    let realFile: string;
    let realAllowed: string;
    try {
      realFile = realpathSync(file);
      realAllowed = realpathSync(allowedRoot);
    } catch (error) {
      throw new ClientConfigError('CLIENT_CONFIG_PATH', `Unable to resolve real path for ${file}: ${errorMessage(error)}`);
    }
    if (!isWithin(realAllowed, realFile)) {
      throw new ClientConfigError('CLIENT_CONFIG_PATH', `Config real path escapes the declared scope: ${realFile}`);
    }
  } else {
    assertSafeDirectoryChain(dirname(file));
    let parent;
    try {
      parent = lstatSync(dirname(file));
    } catch (error) {
      throw new ClientConfigError('CLIENT_CONFIG_PATH', `Config parent directory does not exist: ${dirname(file)} (${errorMessage(error)})`);
    }
    if (!parent.isDirectory()) {
      throw new ClientConfigError('CLIENT_CONFIG_PATH', `Config parent is not a directory: ${dirname(file)}`);
    }
  }
  return file;
}

// ---- authorization ------------------------------------------------------

export function checkClientConfigAuthorization(
  authorization: ClientConfigAuthorization | undefined,
  root: string | null,
  clientId: string,
  requiredScopes: readonly string[],
): { ok: true; authorization: ClientConfigAuthorization } | { ok: false; reason: string } {
  if (authorization === undefined || authorization === null) {
    return { ok: false, reason: 'missing authorization credential' };
  }
  if (typeof authorization !== 'object' || Array.isArray(authorization)) {
    return { ok: false, reason: 'authorization credential must be an object' };
  }
  if (typeof authorization.authorizationId !== 'string' || authorization.authorizationId.trim().length === 0) {
    return { ok: false, reason: 'authorizationId must be a non-empty string' };
  }
  if (root === null) {
    return { ok: false, reason: 'project root is required for an authorized write' };
  }
  if (typeof authorization.root !== 'string' || !sameCanonicalPath(authorization.root, root)) {
    return { ok: false, reason: 'authorization is not bound to the target project root' };
  }
  if (authorization.clientId !== clientId) {
    return { ok: false, reason: `authorization is bound to ${String(authorization.clientId)}, not ${clientId}` };
  }
  if (!Array.isArray(authorization.scope) || authorization.scope.length === 0) {
    return { ok: false, reason: 'authorization scope must be a non-empty array' };
  }
  for (const scope of authorization.scope) {
    if (typeof scope !== 'string' || !(CLIENT_CONFIG_SCOPES as readonly string[]).includes(scope)) {
      return { ok: false, reason: `authorization scope contains an unknown value: ${String(scope)}` };
    }
  }
  for (const required of requiredScopes) {
    if (!authorization.scope.includes(required)) {
      return { ok: false, reason: `authorization scope does not include ${required}` };
    }
  }
  if (typeof authorization.grantedBy !== 'string' || authorization.grantedBy.trim().length === 0) {
    return { ok: false, reason: 'grantedBy must be a non-empty string' };
  }
  if (typeof authorization.statement !== 'string' || authorization.statement.trim().length === 0) {
    return { ok: false, reason: 'statement must be a non-empty string' };
  }
  if (typeof authorization.grantedAt !== 'string' || !Number.isFinite(Date.parse(authorization.grantedAt))) {
    return { ok: false, reason: 'grantedAt must be an ISO 8601 timestamp' };
  }
  if (authorization.revokedAt !== undefined && authorization.revokedAt !== null) {
    return { ok: false, reason: 'authorization has been revoked' };
  }
  return { ok: true, authorization };
}

// ---- minimal TOML subset (read-only, v1) --------------------------------
//
// Deliberately small: tables, dotted keys, quoted strings, integers, booleans
// and flat arrays. It is only used to *read* client configs (Codex). Writes for
// TOML are refused in v1 rather than risk corrupting comments/unknown keys; no
// third-party dependency is introduced.

type TomlValue = string | number | boolean | TomlValue[];
type TomlTable = { [key: string]: TomlValue | TomlTable };

function tomlError(line: number, message: string): ClientConfigError {
  return new ClientConfigError('CLIENT_CONFIG_FORMAT', `TOML line ${line}: ${message}`);
}

function stripTomlComment(line: string, lineNumber: number): string {
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!;
    if (quote === '"') {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === '\\') {
        escaped = true;
        continue;
      }
      if (character === '"') quote = null;
      continue;
    }
    if (quote === "'") {
      if (character === "'") quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '#') return line.slice(0, index);
  }
  if (quote !== null) throw tomlError(lineNumber, 'unterminated string');
  return line;
}

function splitTomlOutsideQuotes(text: string, separator: string, lineNumber: number): string[] {
  const parts: string[] = [];
  let start = 0;
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (quote === '"') {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === '\\') {
        escaped = true;
        continue;
      }
      if (character === '"') quote = null;
      continue;
    }
    if (quote === "'") {
      if (character === "'") quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === separator) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  if (quote !== null) throw tomlError(lineNumber, 'unterminated string');
  parts.push(text.slice(start));
  return parts;
}

function parseTomlString(text: string, lineNumber: number): string {
  const quote = text[0];
  if (text.length < 2 || text.at(-1) !== quote) throw tomlError(lineNumber, 'unterminated string');
  const body = text.slice(1, -1);
  if (quote === "'") {
    if (body.includes("'")) throw tomlError(lineNumber, 'unescaped quote in literal string');
    return body;
  }
  let result = '';
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index]!;
    if (character !== '\\') {
      if (character.charCodeAt(0) < 0x20) throw tomlError(lineNumber, 'control character in string');
      result += character;
      continue;
    }
    const next = body[index + 1];
    index += 1;
    switch (next) {
      case '"': result += '"'; break;
      case '\\': result += '\\'; break;
      case 'n': result += '\n'; break;
      case 'r': result += '\r'; break;
      case 't': result += '\t'; break;
      default: throw tomlError(lineNumber, `unsupported escape sequence \\${next ?? ''}`);
    }
  }
  return result;
}

function parseTomlValue(text: string, lineNumber: number): TomlValue {
  const trimmed = text.trim();
  if (trimmed.length === 0) throw tomlError(lineNumber, 'missing value');
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) return parseTomlString(trimmed, lineNumber);
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^-?(?:0|[1-9][0-9]*)$/u.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith('[')) {
    if (!trimmed.endsWith(']')) throw tomlError(lineNumber, 'unterminated array');
    const body = trimmed.slice(1, -1).trim();
    if (body.length === 0) return [];
    const values = splitTomlOutsideQuotes(body, ',', lineNumber).map((part, index) => {
      if (part.trim().length === 0) throw tomlError(lineNumber, `empty array element ${index + 1}`);
      return parseTomlValue(part, lineNumber);
    });
    const kind = typeof values[0];
    if (values.some((value) => Array.isArray(value) || typeof value !== kind)) {
      throw tomlError(lineNumber, 'arrays must be flat and homogeneous');
    }
    return values as TomlValue[];
  }
  throw tomlError(lineNumber, `unsupported value ${JSON.stringify(trimmed)}; strings must be quoted`);
}

const TOML_RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const TOML_BARE_KEY = /^[A-Za-z0-9_-]+$/u;

function tomlKeySegments(text: string, lineNumber: number): string[] {
  const parts = splitTomlOutsideQuotes(text, '.', lineNumber);
  const segments = parts.map((part) => {
    const trimmed = part.trim();
    if (trimmed.length === 0) throw tomlError(lineNumber, 'empty key segment');
    if (trimmed.startsWith('"') || trimmed.startsWith("'")) return parseTomlString(trimmed, lineNumber);
    if (!TOML_BARE_KEY.test(trimmed)) throw tomlError(lineNumber, `invalid key ${JSON.stringify(trimmed)}`);
    return trimmed;
  });
  for (const segment of segments) {
    if (TOML_RESERVED_KEYS.has(segment)) throw tomlError(lineNumber, `reserved key ${segment}`);
  }
  return segments;
}

function tomlTableFor(root: TomlTable, segments: string[], path: string, lineNumber: number, declared: Set<string>): TomlTable {
  const declaration = JSON.stringify(segments);
  if (declared.has(declaration)) throw tomlError(lineNumber, `duplicate table [${path}]`);
  declared.add(declaration);
  let current = root;
  for (const segment of segments) {
    const existing = current[segment];
    if (existing === undefined) {
      const created: TomlTable = Object.create(null) as TomlTable;
      current[segment] = created;
      current = created;
      continue;
    }
    if (Array.isArray(existing) || typeof existing !== 'object') {
      throw tomlError(lineNumber, `table [${path}] conflicts with a scalar value`);
    }
    current = existing as TomlTable;
  }
  return current;
}

/** Parse a deliberately small TOML subset; read-only, marked degraded by callers. */
export function parseTomlDocument(text: string): Record<string, unknown> {
  const root = Object.create(null) as TomlTable;
  const declared = new Set<string>();
  let current = root;
  const lines = text.replace(/\r\n?/gu, '\n').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = stripTomlComment(lines[index]!, lineNumber).trim();
    if (line.length === 0) continue;
    if (line.startsWith('[[')) throw tomlError(lineNumber, 'array tables are not supported');
    if (line.startsWith('[')) {
      if (!line.endsWith(']')) throw tomlError(lineNumber, 'unterminated table header');
      const path = line.slice(1, -1).trim();
      current = tomlTableFor(root, tomlKeySegments(path, lineNumber), path, lineNumber, declared);
      continue;
    }
    const equalsParts = splitTomlOutsideQuotes(line, '=', lineNumber);
    if (equalsParts.length === 1) throw tomlError(lineNumber, 'expected key = value');
    if (equalsParts.length > 2) throw tomlError(lineNumber, 'only one "=" is allowed per assignment');
    const segments = tomlKeySegments(line.slice(0, equalsParts[0]!.length).trim(), lineNumber);
    let target = current;
    for (const segment of segments.slice(0, -1)) {
      const existing = target[segment];
      if (existing === undefined) {
        const created: TomlTable = Object.create(null) as TomlTable;
        target[segment] = created;
        target = created;
        continue;
      }
      if (Array.isArray(existing) || typeof existing !== 'object') {
        throw tomlError(lineNumber, `key ${segments.join('.')} conflicts with a scalar value`);
      }
      target = existing as TomlTable;
    }
    const key = segments.at(-1)!;
    if (Object.hasOwn(target, key)) throw tomlError(lineNumber, `duplicate key ${segments.join('.')}`);
    target[key] = parseTomlValue(line.slice(equalsParts[0]!.length + 1), lineNumber) as TomlValue | TomlTable;
  }
  return root as Record<string, unknown>;
}

// ---- discovery / read ---------------------------------------------------

function navigateContainer(document: unknown, serverPath: readonly string[]): { container: Record<string, unknown> | null; found: boolean } {
  let current: unknown = document;
  for (const segment of serverPath) {
    if (!isPlainObject(current) || !Object.hasOwn(current, segment)) return { container: null, found: false };
    current = current[segment];
  }
  if (!isPlainObject(current)) return { container: null, found: false };
  return { container: current, found: true };
}

function servicesOf(container: Record<string, unknown> | null): ClientConfigServiceEntry[] {
  if (container === null) return [];
  return Object.entries(container).map(([name, value]) => ({ name, value }));
}

function emptySnapshot(target: ClientConfigTarget): ClientConfigSnapshot {
  return {
    target,
    exists: false,
    bytes: 0,
    beforeHash: null,
    format: target.format,
    degraded: target.format !== 'json',
    document: null,
    containerFound: false,
    services: [],
    anoEntry: null,
    warnings: target.format === 'toml' ? ['TOML configs are read-only in v1; apply is refused'] : [],
  };
}

export function readClientConfig(target: ClientConfigTarget): ClientConfigSnapshot {
  const file = assertSafeTargetPath(target);
  if (!existsSync(file)) return emptySnapshot(target);
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch (error) {
    throw new ClientConfigError('CLIENT_CONFIG_FORMAT', `Unable to read ${file}: ${errorMessage(error)}`);
  }
  const beforeHash = sha256Hex(bytes);
  const warnings: string[] = [];
  let document: unknown;
  if (target.format === 'json') {
    try {
      document = JSON.parse(bytes.toString('utf8')) as unknown;
    } catch (error) {
      throw new ClientConfigError('CLIENT_CONFIG_FORMAT', `${file} is not valid JSON: ${errorMessage(error)}`);
    }
    if (!isPlainObject(document)) {
      throw new ClientConfigError('CLIENT_CONFIG_FORMAT', `${file} must contain a JSON object at the top level`);
    }
  } else if (target.format === 'toml') {
    try {
      document = parseTomlDocument(bytes.toString('utf8'));
    } catch (error) {
      if (error instanceof ClientConfigError) throw error;
      throw new ClientConfigError('CLIENT_CONFIG_FORMAT', `${file} is not valid TOML: ${errorMessage(error)}`);
    }
    warnings.push('TOML configs are read-only in v1; apply is refused');
  } else {
    throw new ClientConfigError('CLIENT_CONFIG_FORMAT', `Unsupported config format: ${String(target.format)}`);
  }
  const { container, found } = navigateContainer(document, target.serverPath);
  return {
    target,
    exists: true,
    bytes: bytes.length,
    beforeHash,
    format: target.format,
    degraded: target.format !== 'json',
    document,
    containerFound: found,
    services: servicesOf(container),
    anoEntry: container !== null && Object.hasOwn(container, target.serverName) ? container[target.serverName] : null,
    warnings,
  };
}

/**
 * Read-only discovery over injected candidates. The first candidate that exists
 * and is safe wins; escapes and symlinks are reported, never followed.
 */
export function discoverClientConfig(candidates: readonly ClientConfigTarget[]): ClientConfigDiscovery {
  const rejected: { path: string; reason: string }[] = [];
  const missing: string[] = [];
  for (const candidate of candidates) {
    let file: string;
    try {
      file = assertSafeTargetPath(candidate);
    } catch (error) {
      rejected.push({ path: String(candidate.path), reason: errorMessage(error) });
      continue;
    }
    if (existsSync(file)) return { target: candidate, found: file, rejected, missing };
    missing.push(file);
  }
  return { target: null, found: null, rejected, missing };
}

// ---- merge / plan -------------------------------------------------------

interface MergeOutcome {
  readonly document: Record<string, unknown>;
  readonly container: Record<string, unknown>;
  readonly before: unknown;
  readonly after: unknown;
  readonly changed: boolean;
  readonly kind: ClientConfigChange['kind'];
}

function mergeServerEntry(
  document: Record<string, unknown>,
  target: ClientConfigTarget,
  entry: Record<string, unknown> | null,
): MergeOutcome {
  // Defense in depth: the target validator already rejects reserved keys, but
  // the merge must stay safe even when called directly with an untrusted path.
  assertSafeServerPath(target.serverPath);
  const clone = structuredClone(document);
  let current: Record<string, unknown> = clone;
  for (const segment of target.serverPath) {
    const existing = Object.hasOwn(current, segment) ? current[segment] : undefined;
    if (existing === undefined) {
      const created: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      current[segment] = created;
      current = created;
      continue;
    }
    if (!isPlainObject(existing)) {
      throw new ClientConfigError('CLIENT_CONFIG_FORMAT', `Cannot merge: ${segment} is not an object`);
    }
    current = existing;
  }
  const has = Object.hasOwn(current, target.serverName);
  const before = has ? current[target.serverName] : null;
  if (entry === null) {
    if (!has) return { document: clone, container: current, before, after: null, changed: false, kind: 'unchanged' };
    delete current[target.serverName];
    return { document: clone, container: current, before, after: null, changed: true, kind: 'remove-server' };
  }
  if (has && deepEqual(current[target.serverName], entry)) {
    return { document: clone, container: current, before, after: entry, changed: false, kind: 'unchanged' };
  }
  current[target.serverName] = entry;
  return {
    document: clone,
    container: current,
    before,
    after: entry,
    changed: true,
    kind: has ? 'update-server' : 'add-server',
  };
}

function planFromSnapshot(target: ClientConfigTarget, snapshot: ClientConfigSnapshot, entry: Record<string, unknown> | null): ClientConfigPlan {
  const baseWarnings = [...snapshot.warnings];
  if (!snapshot.exists) {
    if (entry === null) {
      return {
        target,
        snapshot,
        changes: [],
        changed: false,
        before: null,
        after: null,
        mergedBytes: null,
        afterHash: null,
        warnings: baseWarnings,
      };
    }
    const outcome = mergeServerEntry({}, target, entry);
    const mergedBytes = target.format === 'json' ? Buffer.from(stringifyJson(outcome.document), 'utf8') : null;
    return {
      target,
      snapshot,
      changes: [{
        kind: outcome.kind,
        serverName: target.serverName,
        serverPath: target.serverPath,
        before: null,
        after: entry,
      }],
      changed: true,
      before: null,
      after: entry,
      mergedBytes,
      afterHash: mergedBytes === null ? null : sha256Hex(mergedBytes),
      warnings: baseWarnings,
    };
  }
  if (!isPlainObject(snapshot.document)) {
    throw new ClientConfigError('CLIENT_CONFIG_FORMAT', `Cannot merge into a non-object document: ${target.path}`);
  }
  const outcome = mergeServerEntry(snapshot.document, target, entry);
  if (!outcome.changed) {
    return {
      target,
      snapshot,
      changes: [],
      changed: false,
      before: outcome.before,
      after: outcome.after,
      mergedBytes: null,
      afterHash: snapshot.beforeHash,
      warnings: baseWarnings,
    };
  }
  const mergedBytes = target.format === 'json' ? Buffer.from(stringifyJson(outcome.document), 'utf8') : null;
  const change: ClientConfigChange = {
    kind: outcome.kind,
    serverName: target.serverName,
    serverPath: target.serverPath,
    before: outcome.before,
    after: outcome.after,
  };
  return {
    target,
    snapshot,
    changes: [change],
    changed: true,
    before: outcome.before,
    after: outcome.after,
    mergedBytes,
    afterHash: mergedBytes === null ? null : sha256Hex(mergedBytes),
    warnings: baseWarnings,
  };
}

export function planClientConfig(target: ClientConfigTarget, entry: Record<string, unknown> | null): ClientConfigPlan {
  return planFromSnapshot(target, readClientConfig(target), entry);
}

// ---- backup / restore ---------------------------------------------------

function backupIdFor(now: string | undefined): string {
  const stamp = now === undefined ? Date.now() : Date.parse(now);
  const safeStamp = Number.isFinite(stamp) ? stamp : Date.now();
  return `cfg-${safeStamp.toString(36)}-${randomUUID().slice(0, 8)}`;
}

export function backupClientConfig(
  root: string,
  target: ClientConfigTarget,
  original: Buffer,
  authorizationId: string,
  options: { backupId?: string; now?: string } = {},
): ClientConfigBackup {
  const projectRoot = requireProjectRoot(root);
  assertSafeClientId(target.clientId);
  const id = options.backupId ?? backupIdFor(options.now);
  if (!/^[A-Za-z0-9._-]+$/u.test(id) || id === '.' || id === '..') {
    throw new ClientConfigError('CLIENT_CONFIG_BACKUP', `Unsafe backup id: ${id}`);
  }
  const dir = join(clientConfigBackupDir(projectRoot, target.clientId), id);
  if (existsSync(dir)) {
    throw new ClientConfigError('CLIENT_CONFIG_BACKUP', `Backup already exists: ${id}`);
  }
  const extension = target.format === 'toml' ? 'toml' : 'json';
  const file = join(dir, `config.${extension}`);
  const manifestPath = join(dir, 'manifest.json');
  const beforeHash = sha256Hex(original);
  const manifest = {
    schema: CLIENT_CONFIG_BACKUP_SCHEMA,
    id,
    clientId: target.clientId,
    root: projectRoot,
    targetPath: resolve(target.path),
    scope: target.scope,
    format: target.format,
    serverPath: [...target.serverPath],
    serverName: target.serverName,
    authorizationId,
    createdAt: options.now ?? new Date().toISOString(),
    beforeHash,
    bytes: original.length,
  };
  const backupHash = sha256Hex(canonicalJson({
    schema: manifest.schema,
    id: manifest.id,
    clientId: manifest.clientId,
    root: manifest.root,
    targetPath: manifest.targetPath,
    beforeHash: manifest.beforeHash,
    bytes: manifest.bytes,
    authorizationId: manifest.authorizationId,
  }));
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, original);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const readBack = readFileSync(file);
    if (sha256Hex(readBack) !== beforeHash) {
      throw new ClientConfigError('CLIENT_CONFIG_BACKUP', 'Backup artifact hash does not match the original bytes');
    }
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return {
    id,
    dir,
    file,
    manifestPath,
    clientId: target.clientId,
    targetPath: manifest.targetPath,
    bytes: original.length,
    beforeHash,
    backupHash,
  };
}

export function verifyClientConfigBackup(root: string, clientId: string, id: string): ClientConfigBackupVerification {
  const projectRoot = requireProjectRoot(root);
  assertSafeClientId(clientId);
  const dir = join(clientConfigBackupDir(projectRoot, clientId), id);
  const errors: string[] = [];
  let beforeHash: string | null = null;
  let backupHash: string | null = null;
  let bytes = 0;
  let path: string | null = null;
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Record<string, unknown>;
  } catch (error) {
    return { ok: false, id, errors: [`manifest unreadable: ${errorMessage(error)}`], beforeHash, backupHash, bytes, path };
  }
  if (manifest.schema !== CLIENT_CONFIG_BACKUP_SCHEMA) errors.push('manifest schema mismatch');
  if (manifest.id !== id) errors.push('manifest id mismatch');
  if (manifest.clientId !== clientId) errors.push('manifest clientId mismatch');
  if (manifest.root !== projectRoot) errors.push('manifest root mismatch');
  beforeHash = typeof manifest.beforeHash === 'string' ? manifest.beforeHash : null;
  bytes = typeof manifest.bytes === 'number' ? manifest.bytes : 0;
  const artifact = join(dir, `config.${manifest.format === 'toml' ? 'toml' : 'json'}`);
  path = artifact;
  let content: Buffer;
  try {
    content = readFileSync(artifact);
  } catch (error) {
    errors.push(`backup artifact missing: ${errorMessage(error)}`);
    return { ok: errors.length === 0, id, errors, beforeHash, backupHash, bytes, path };
  }
  const actual = sha256Hex(content);
  if (beforeHash === null || actual !== beforeHash) errors.push('backup artifact hash mismatch');
  if (typeof manifest.authorizationId !== 'string' || manifest.authorizationId.length === 0) {
    errors.push('manifest authorizationId missing');
  }
  backupHash = sha256Hex(canonicalJson({
    schema: manifest.schema,
    id: manifest.id,
    clientId: manifest.clientId,
    root: manifest.root,
    targetPath: manifest.targetPath,
    beforeHash: manifest.beforeHash,
    bytes: manifest.bytes,
    authorizationId: manifest.authorizationId,
  }));
  return { ok: errors.length === 0, id, errors, beforeHash, backupHash, bytes, path };
}

export function readClientConfigBackup(root: string, clientId: string, id: string): { manifest: Record<string, unknown>; bytes: Buffer } {
  const verification = verifyClientConfigBackup(root, clientId, id);
  if (!verification.ok || verification.path === null) {
    throw new ClientConfigError('CLIENT_CONFIG_BACKUP', `Refusing to read backup ${id}: ${verification.errors.join(', ')}`);
  }
  const projectRoot = requireProjectRoot(root);
  const manifest = JSON.parse(readFileSync(join(clientConfigBackupDir(projectRoot, clientId), id, 'manifest.json'), 'utf8')) as Record<string, unknown>;
  return { manifest, bytes: readFileSync(verification.path) };
}

export function listClientConfigBackups(root: string, clientId: string): ClientConfigBackupVerification[] {
  const dir = clientConfigBackupDir(root, clientId);
  if (!existsSync(dir)) return [];
  const results: ClientConfigBackupVerification[] = [];
  for (const entry of readdirSyncSafe(dir)) {
    results.push(verifyClientConfigBackup(root, clientId, entry));
  }
  return results;
}

function readdirSyncSafe(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

// ---- atomic write -------------------------------------------------------

export function atomicWriteFile(file: string, bytes: Buffer, io?: ClientConfigIo): void {
  if (io !== undefined) {
    io.atomicWrite(file, bytes);
    return;
  }
  const temp = join(dirname(file), `.${basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temp, 'wx');
    writeSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temp, file);
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        /* best effort */
      }
    }
    try {
      unlinkSync(temp);
    } catch {
      /* best effort: a fresh random temp name is used next time */
    }
    throw error;
  }
}

function restoreBytes(file: string, original: Buffer, io?: ClientConfigIo): void {
  atomicWriteFile(file, original, io);
  const check = readFileSync(file);
  if (!check.equals(original)) {
    throw new ClientConfigError('CLIENT_CONFIG_WRITE', `Restore verification failed for ${file}`);
  }
}

function assertPreserved(before: unknown, after: unknown, target: ClientConfigTarget): void {
  // Every value present before the write must still be present and equal after
  // it, except the ANO entry itself. This subset check allows creating a
  // missing servers container while any dropped or mutated unknown field, other
  // MCP service, or nested value fails verification.
  const containerTrail = target.serverPath.join('.');
  const walk = (expected: unknown, actual: unknown, trail: string): void => {
    if (isPlainObject(expected)) {
      if (!isPlainObject(actual)) {
        throw new ClientConfigError('CLIENT_CONFIG_WRITE', `Written config dropped or changed the object at ${trail || '/'}`);
      }
      for (const [key, value] of Object.entries(expected)) {
        if (trail === containerTrail && key === target.serverName) continue;
        if (!Object.hasOwn(actual, key)) {
          throw new ClientConfigError('CLIENT_CONFIG_WRITE', `Written config dropped the existing key ${trail === '' ? key : `${trail}.${key}`}`);
        }
        walk(value, actual[key], trail === '' ? key : `${trail}.${key}`);
      }
      return;
    }
    if (Array.isArray(expected)) {
      if (!Array.isArray(actual) || actual.length !== expected.length) {
        throw new ClientConfigError('CLIENT_CONFIG_WRITE', `Written config changed the array at ${trail || '/'}`);
      }
      for (let index = 0; index < expected.length; index += 1) {
        walk(expected[index], actual[index], `${trail}[${index}]`);
      }
      return;
    }
    if (!deepEqual(expected, actual)) {
      throw new ClientConfigError('CLIENT_CONFIG_WRITE', `Written config changed the value at ${trail || '/'}`);
    }
  };
  walk(before, after, '');
}

function verifyWrittenConfig(target: ClientConfigTarget, entry: Record<string, unknown> | null, before: unknown, expectedHash: string): ClientConfigSnapshot {
  const snapshot = readClientConfig(target);
  if (snapshot.beforeHash !== expectedHash) {
    throw new ClientConfigError('CLIENT_CONFIG_WRITE', 'Written config hash does not match the planned bytes');
  }
  if (entry === null) {
    if (snapshot.anoEntry !== null) {
      throw new ClientConfigError('CLIENT_CONFIG_WRITE', 'Written config still contains the ANO entry');
    }
  } else if (!deepEqual(snapshot.anoEntry, entry)) {
    throw new ClientConfigError('CLIENT_CONFIG_WRITE', 'Written config does not contain the intended ANO entry');
  }
  assertPreserved(before, snapshot.document, target);
  return snapshot;
}

// ---- apply --------------------------------------------------------------

function resultFor(
  target: ClientConfigTarget,
  plan: ClientConfigPlan,
  overrides: Partial<ClientConfigResult>,
): ClientConfigResult {
  return {
    mode: 'dry-run',
    applied: false,
    refused: false,
    target,
    changes: plan.changes,
    warnings: plan.warnings,
    beforeHash: plan.snapshot.beforeHash,
    afterHash: plan.afterHash,
    changed: plan.changed,
    backupId: null,
    backupHash: null,
    backupPath: null,
    restoredOnFailure: false,
    error: null,
    ...overrides,
  };
}

/**
 * Apply (or dry-run) a client configuration change. Default is dry-run and
 * writes nothing. `mode:'apply'` additionally requires `confirm:true` and a
 * valid authorization; without them a dry-run report with `refused:true` is
 * returned and no byte is written.
 */
export function applyClientConfig(
  target: ClientConfigTarget,
  entry: Record<string, unknown> | null,
  options: ClientConfigApplyOptions = {},
): ClientConfigResult {
  const plan = planClientConfig(target, entry);
  if (!plan.changed) {
    return resultFor(target, plan, { warnings: plan.warnings });
  }

  const mode = options.mode ?? 'dry-run';
  const root = options.root === undefined ? null : requireProjectRoot(options.root);
  const auth = checkClientConfigAuthorization(options.authorization, root, target.clientId, ['config']);
  const authReason = auth.ok ? '' : auth.reason;
  if (mode !== 'apply' || options.confirm !== true || root === null || !auth.ok) {
    const reason = root === null ? 'project root is required for an authorized write' : authReason;
    return resultFor(target, plan, {
      refused: mode === 'apply',
      warnings: [...plan.warnings, `apply refused (${reason}); dry-run only`],
    });
  }
  if (target.format !== 'json') {
    return resultFor(target, plan, {
      refused: true,
      warnings: [...plan.warnings, 'apply refused: TOML configs are read-only in v1; dry-run only'],
    });
  }

  const file = assertSafeTargetPath(target);
  let original: Buffer;
  try {
    original = readFileSync(file);
  } catch (error) {
    throw new ClientConfigError('CLIENT_CONFIG_WRITE', `Unable to read ${file} before writing: ${errorMessage(error)}`);
  }
  const beforeHash = sha256Hex(original);
  const io = options.io;
  let backup: ClientConfigBackup | null = null;
  if (options.backup !== false) {
    backup = backupClientConfig(root, target, original, auth.authorization.authorizationId, {
      ...(options.backupId === undefined ? {} : { backupId: options.backupId }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  }
  options.hooks?.afterBackup?.({ target, file, beforeHash });

  let currentHash: string;
  try {
    currentHash = sha256Hex(readFileSync(file));
  } catch (error) {
    throw new ClientConfigError('CLIENT_CONFIG_DRIFT', `Config changed concurrently and can no longer be read: ${errorMessage(error)}`);
  }
  if (currentHash !== beforeHash) {
    throw new ClientConfigError('CLIENT_CONFIG_DRIFT', `Config changed concurrently: expected ${beforeHash}, found ${currentHash}`);
  }

  const mergedBytes = plan.mergedBytes;
  if (mergedBytes === null) {
      throw new ClientConfigError('CLIENT_CONFIG_FORMAT', 'Refusing to write a config format that is read-only in v1');
  }
  try {
    atomicWriteFile(file, mergedBytes, io);
    verifyWrittenConfig(target, entry, plan.snapshot.document, sha256Hex(mergedBytes));
  } catch (error) {
    try {
      restoreBytes(file, original, io);
    } catch (restoreError) {
      throw new ClientConfigError(
        'CLIENT_CONFIG_WRITE',
        `Write failed and the original bytes could not be restored: ${errorMessage(error)}; restore: ${errorMessage(restoreError)}`,
      );
    }
    return resultFor(target, plan, {
      mode: 'apply',
      applied: false,
      beforeHash,
      afterHash: sha256Hex(original),
      backupId: backup?.id ?? null,
      backupHash: backup?.backupHash ?? null,
      backupPath: backup?.file ?? null,
      restoredOnFailure: true,
      error: errorMessage(error),
    });
  }

  return resultFor(target, plan, {
    mode: 'apply',
    applied: true,
    beforeHash,
    afterHash: sha256Hex(mergedBytes),
    backupId: backup?.id ?? null,
    backupHash: backup?.backupHash ?? null,
    backupPath: backup?.file ?? null,
  });
}

// ---- restore ------------------------------------------------------------

export interface ClientConfigRestoreOptions {
  readonly mode?: 'dry-run' | 'apply';
  readonly confirm?: boolean;
  readonly authorization?: ClientConfigAuthorization;
  readonly root?: string;
  readonly backupId?: string;
  readonly now?: string;
  readonly io?: ClientConfigIo;
}

/** Restore a verified backup over the target config. Requires the `restore` scope. */
export function restoreClientConfig(target: ClientConfigTarget, options: ClientConfigRestoreOptions = {}): ClientConfigResult {
  const root = options.root === undefined ? null : requireProjectRoot(options.root);
  const auth = checkClientConfigAuthorization(options.authorization, root, target.clientId, ['restore']);
  const authReason = auth.ok ? '' : auth.reason;
  const current = readClientConfig(target);
  const backups = root === null ? [] : listClientConfigBackups(root, target.clientId);
  const usable = backups.filter((entry) => entry.ok);
  const selected = options.backupId === undefined ? usable.at(-1) ?? null : usable.find((entry) => entry.id === options.backupId) ?? null;
  const plan: ClientConfigPlan = {
    target,
    snapshot: current,
    changes: [],
    changed: selected !== null && selected.beforeHash !== current.beforeHash,
    before: current.anoEntry,
    after: null,
    mergedBytes: null,
    afterHash: selected?.beforeHash ?? null,
    warnings: selected === null ? ['no verified backup available'] : [],
  };
  const base = resultFor(target, plan, {
    beforeHash: current.beforeHash,
    afterHash: selected?.beforeHash ?? null,
  });
  const mode = options.mode ?? 'dry-run';
  if (root === null) {
    return { ...base, warnings: [...base.warnings, 'restore refused: project root is required; dry-run only'] };
  }
  if (selected === null) return { ...base, warnings: [...base.warnings, 'restore refused: no verified backup'] };
  if (mode !== 'apply' || options.confirm !== true || !auth.ok) {
    return {
      ...base,
      refused: mode === 'apply',
      warnings: [...base.warnings, `restore refused (${authReason}); dry-run only`],
    };
  }
  const { bytes } = readClientConfigBackup(root, target.clientId, selected.id);
  const file = assertSafeTargetPath(target);
  try {
    atomicWriteFile(file, bytes, options.io);
    const check = readFileSync(file);
    if (sha256Hex(check) !== selected.beforeHash) {
      throw new ClientConfigError('CLIENT_CONFIG_WRITE', 'Restored config hash does not match the verified backup');
    }
  } catch (error) {
    return {
      ...base,
      mode: 'apply',
      applied: false,
      refused: true,
      restoredOnFailure: false,
      error: errorMessage(error),
      warnings: base.warnings,
    };
  }
  return {
    ...base,
    mode: 'apply',
    applied: true,
    changed: true,
    beforeHash: current.beforeHash,
    afterHash: selected.beforeHash,
    backupId: selected.id,
    backupHash: selected.backupHash,
    backupPath: selected.path,
  };
}

// ---- hooks section write (T-166) ------------------------------------------
//
// ADR-013 §2.4: hook configuration may only be written through the authorized
// `clients install --with-hooks` path, reusing the exact same backup / drift /
// atomic-merge / restore primitives as the MCP write. This section writes ONLY
// the S8-confirmed `hooks` keys and preserves every other document field.

/** A single S8-confirmed process hook entry. No field outside this set is written. */
export interface ClientHookEntry {
  readonly type: 'process';
  readonly command: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
}

/** The managed `hooks` section. `events` maps host event name -> matcher groups. */
export interface ClientHooksDocument {
  readonly enabled: true;
  readonly events: Readonly<Record<string, readonly { readonly hooks: readonly ClientHookEntry[] }[]>>;
}

/** Target for a hooks-section write. No MCP server container is involved. */
export interface ClientHooksTarget {
  readonly clientId: string;
  readonly scope: ClientConfigScope;
  readonly path: string;
  readonly allowedRoot: string;
}

export interface ClientHooksPlan {
  readonly target: ClientHooksTarget;
  readonly exists: boolean;
  readonly beforeHash: string | null;
  readonly afterHash: string | null;
  readonly mergedBytes: Buffer | null;
  readonly changed: boolean;
  readonly warnings: readonly string[];
}

/** Adapt a hooks target to the shared path-safety validator. */
function hooksConfigTarget(target: ClientHooksTarget): ClientConfigTarget {
  return {
    clientId: target.clientId,
    scope: target.scope,
    path: target.path,
    format: 'json',
    // Sentinel container used only for path validation; the hooks merge below
    // operates on the top-level `hooks` key, not on this container.
    serverPath: ['hooks'],
    serverName: 'events',
    allowedRoot: target.allowedRoot,
  };
}

/**
 * Merge only the S8-confirmed `hooks` keys into a document:
 * `hooks.enabled:true` and, for every managed event, `hooks.events[event]` is
 * replaced with our fixed process entry. All other top-level fields, other
 * `hooks` keys and other events are preserved byte-for-byte in value.
 */
function mergeHooks(document: unknown, hooks: ClientHooksDocument): { document: Record<string, unknown>; changed: boolean; before: unknown; after: unknown } {
  const before = isPlainObject(document) && Object.hasOwn(document, 'hooks') ? document['hooks'] : null;
  const clone: Record<string, unknown> = isPlainObject(document) ? structuredClone(document) : {};
  const section: Record<string, unknown> = isPlainObject(clone['hooks']) ? (clone['hooks'] as Record<string, unknown>) : {};
  section['enabled'] = true;
  const events: Record<string, unknown> = isPlainObject(section['events']) ? (section['events'] as Record<string, unknown>) : {};
  for (const [eventName, groups] of Object.entries(hooks.events)) {
    events[eventName] = structuredClone(groups);
  }
  section['events'] = events;
  clone['hooks'] = section;
  return { document: clone, changed: !deepEqual(before, section), before, after: section };
}

/**
 * Path validation for planning: rejects sensitive paths, escapes, reserved
 * container keys and symlinks/junctions in existing parents, but does NOT
 * require the parent directory to exist (dry-run is a plan, not a write).
 * The full `assertSafeTargetPath` runs again at apply time.
 */
function assertSafeHooksPlanPath(target: ClientHooksTarget): string {
  const adapted = hooksConfigTarget(target);
  assertSafeClientId(adapted.clientId);
  assertSafeServerPath(adapted.serverPath);
  if (typeof target.path !== 'string' || target.path.trim().length === 0) {
    throw new ClientConfigError('CLIENT_CONFIG_PATH', 'Hooks config path must be a non-empty string');
  }
  if (typeof target.allowedRoot !== 'string' || target.allowedRoot.trim().length === 0) {
    throw new ClientConfigError('CLIENT_CONFIG_PATH', 'Hooks allowedRoot must be a non-empty string');
  }
  const file = resolve(target.path);
  const allowedRoot = resolve(target.allowedRoot);
  assertSafeConfigPath(file);
  if (!isWithin(allowedRoot, file)) {
    throw new ClientConfigError('CLIENT_CONFIG_PATH', `Hooks config path escapes the declared scope: ${file}`);
  }
  if (existsSync(file)) {
    return assertSafeTargetPath(adapted); // existing file: full validation including realpath
  }
  assertSafeDirectoryChain(dirname(file));
  return file;
}

export function planClientHooks(target: ClientHooksTarget, hooks: ClientHooksDocument): ClientHooksPlan {
  const file = assertSafeHooksPlanPath(target);
  const exists = existsSync(file);
  let document: unknown = null;
  let beforeHash: string | null = null;
  if (exists) {
    const bytes = readFileSync(file);
    beforeHash = sha256Hex(bytes);
    try {
      document = JSON.parse(bytes.toString('utf8')) as unknown;
    } catch (error) {
      throw new ClientConfigError('CLIENT_CONFIG_FORMAT', `${file} is not valid JSON: ${errorMessage(error)}`);
    }
    if (!isPlainObject(document)) {
      throw new ClientConfigError('CLIENT_CONFIG_FORMAT', `${file} must contain a JSON object at the top level`);
    }
  }
  const outcome = mergeHooks(document, hooks);
  const mergedBytes = Buffer.from(stringifyJson(outcome.document), 'utf8');
  return {
    target,
    exists,
    beforeHash,
    afterHash: sha256Hex(mergedBytes),
    mergedBytes,
    changed: outcome.changed,
    warnings: [],
  };
}

/**
 * Apply a hooks-section change under the same authorization / backup / drift /
 * atomic / verification / rollback guarantees as `applyClientConfig`.
 * Default is dry-run and writes nothing.
 */
export function applyClientHooks(
  target: ClientHooksTarget,
  hooks: ClientHooksDocument,
  options: ClientConfigApplyOptions = {},
): ClientConfigResult {
  const plan = planClientHooks(target, hooks);
  const adapted = hooksConfigTarget(target);
  const base: ClientConfigResult = {
    mode: 'dry-run',
    applied: false,
    refused: false,
    target: adapted,
    changes: [],
    warnings: plan.warnings,
    beforeHash: plan.beforeHash,
    afterHash: plan.afterHash,
    changed: plan.changed,
    backupId: null,
    backupHash: null,
    backupPath: null,
    restoredOnFailure: false,
    error: null,
  };
  if (!plan.changed || plan.mergedBytes === null) return base;

  const mode = options.mode ?? 'dry-run';
  const root = options.root === undefined ? null : requireProjectRoot(options.root);
  const auth = checkClientConfigAuthorization(options.authorization, root, target.clientId, ['config', 'install']);
  const authReason = auth.ok ? '' : auth.reason;
  if (mode !== 'apply' || options.confirm !== true || root === null || !auth.ok) {
    const reason = mode !== 'apply'
      ? 'dry-run preview; no write requested'
      : root === null ? 'project root is required for an authorized write'
        : options.confirm !== true ? 'explicit --confirm is required'
          : authReason;
    return { ...base, refused: mode === 'apply', warnings: [...plan.warnings, `hooks apply refused (${reason}); dry-run only`] };
  }

  const file = assertSafeTargetPath(adapted);
  let original: Buffer;
  if (existsSync(file)) {
    try {
      original = readFileSync(file);
    } catch (error) {
      throw new ClientConfigError('CLIENT_CONFIG_WRITE', `Unable to read ${file} before writing: ${errorMessage(error)}`);
    }
  } else {
    original = Buffer.alloc(0);
  }
  const beforeHash = sha256Hex(original);
  const io = options.io;
  let backup: ClientConfigBackup | null = null;
  if (options.backup !== false && original.length > 0) {
    backup = backupClientConfig(root, adapted, original, auth.authorization.authorizationId, {
      ...(options.backupId === undefined ? {} : { backupId: options.backupId }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  }
  options.hooks?.afterBackup?.({ target: adapted, file, beforeHash });

  let currentHash: string;
  try {
    currentHash = existsSync(file) ? sha256Hex(readFileSync(file)) : sha256Hex(Buffer.alloc(0));
  } catch (error) {
    throw new ClientConfigError('CLIENT_CONFIG_DRIFT', `Config changed concurrently and can no longer be read: ${errorMessage(error)}`);
  }
  if (currentHash !== beforeHash) {
    throw new ClientConfigError('CLIENT_CONFIG_DRIFT', `Config changed concurrently: expected ${beforeHash}, found ${currentHash}`);
  }

  const mergedBytes = plan.mergedBytes;
  try {
    atomicWriteFile(file, mergedBytes, io);
    const written = readFileSync(file);
    if (sha256Hex(written) !== sha256Hex(mergedBytes)) {
      throw new ClientConfigError('CLIENT_CONFIG_WRITE', 'Written hooks config hash does not match the planned bytes');
    }
    const parsed = JSON.parse(written.toString('utf8')) as unknown;
    // 其他顶层字段必须原样保留（hooks 段之外的所有键与值）。
    if (original.length > 0) {
      const beforeDoc = JSON.parse(original.toString('utf8')) as unknown;
      if (!isPlainObject(beforeDoc) || !isPlainObject(parsed)) {
        throw new ClientConfigError('CLIENT_CONFIG_WRITE', 'Written hooks config must be a JSON object');
      }
      for (const [key, value] of Object.entries(beforeDoc)) {
        if (key === 'hooks') continue;
        if (!Object.hasOwn(parsed, key)) {
          throw new ClientConfigError('CLIENT_CONFIG_WRITE', `Written hooks config dropped the existing key ${key}`);
        }
        if (!deepEqual(value, parsed[key])) {
          throw new ClientConfigError('CLIENT_CONFIG_WRITE', `Written hooks config changed the value at ${key}`);
        }
      }
    }
  } catch (error) {
    try {
      restoreBytes(file, original, io);
    } catch (restoreError) {
      throw new ClientConfigError(
        'CLIENT_CONFIG_WRITE',
        `Hooks write failed and original bytes could not be restored: ${errorMessage(error)}; restore: ${errorMessage(restoreError)}`,
      );
    }
    return {
      ...base,
      mode: 'apply',
      beforeHash,
      afterHash: sha256Hex(original),
      backupId: backup?.id ?? null,
      backupHash: backup?.backupHash ?? null,
      backupPath: backup?.file ?? null,
      restoredOnFailure: true,
      error: errorMessage(error),
    };
  }

  return {
    ...base,
    mode: 'apply',
    applied: true,
    beforeHash,
    afterHash: sha256Hex(mergedBytes),
    backupId: backup?.id ?? null,
    backupHash: backup?.backupHash ?? null,
    backupPath: backup?.file ?? null,
  };
}

/** Restore from a verified backup without re-checking authorization (caller responsibility). */
export function restoreFromBackup(root: string, target: ClientConfigTarget, backupId: string, io?: ClientConfigIo): void {
  const projectRoot = requireProjectRoot(root);
  const { bytes, manifest } = readClientConfigBackup(projectRoot, target.clientId, backupId);
  const expected = typeof manifest.beforeHash === 'string' ? manifest.beforeHash : null;
  if (expected === null) {
    throw new ClientConfigError('CLIENT_CONFIG_BACKUP', `Backup ${backupId} has no beforeHash`);
  }
  const file = assertSafeTargetPath(target);
  atomicWriteFile(file, bytes, io);
  const check = readFileSync(file);
  if (sha256Hex(check) !== expected) {
    throw new ClientConfigError('CLIENT_CONFIG_WRITE', 'Restored config hash does not match the verified backup');
  }
}
