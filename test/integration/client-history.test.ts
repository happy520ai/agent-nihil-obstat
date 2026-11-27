/**
 * T-087 / MC-09 — real session history adaptation and privacy boundary.
 *
 * Read-only verification of the ADR-007 `history` layer (E8). No real session
 * directory is read, no secret is collected, and synthetic fixtures never
 * upgrade the layer. The sampling contract below is the executable
 * specification of ADR-007 §2.3 / §7: explicit authorization (scope=history +
 * sample root), a known format, structural metadata only, and fail-closed
 * behaviour on missing authorization / invalid path / unknown or corrupt
 * format.
 *
 * src/clients/** is read-only for this task; the boundary gate and sampler are
 * the deliverable contract, and the tests assert them against the real
 * doctor/adapters plus the real external-adapter capping mechanism.
 */

import assert from 'node:assert/strict';
import type { Stats } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile as readFileText,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import test from 'node:test';
import {
  CAPABILITY_LAYERS,
  CLIENT_IDS,
  CLIENT_REPORT_SCHEMA,
  CORE_LAYERS,
  EVIDENCE_CODE_LAYER,
  EXTENSION_LAYERS,
  type CapabilityLayer,
  type ClientAdapter,
  type ClientId,
  type ClientReport,
  type ClientVerdict,
  type DetectResult,
  type HistoryLayerReport,
  type VerifyResult,
} from '../../src/clients/types.ts';
import { getDescriptor, listDescriptors } from '../../src/clients/registry.ts';
import { doctorClient, doctorClients, unavailableLayerReports } from '../../src/clients/doctor.ts';
import { createClaudeCodeAdapter } from '../../src/clients/claude-code.ts';
import { createCodexAdapter } from '../../src/clients/codex.ts';
import { cursorAdapter } from '../../src/clients/cursor.ts';
import { opencodeAdapter } from '../../src/clients/opencode.ts';
import { createQoderAdapter, type QoderFs } from '../../src/clients/qoder.ts';
import { createDeepSeekHarnessAdapter } from '../../src/clients/deepseek-harness.ts';
import {
  createUnknownAdapter,
  registerExternalAdapter,
  type ExternalAdapterDeclaration,
  type ExternalAdapterValidation,
} from '../../src/clients/unknown.ts';

const AT = '2026-11-23T00:00:00.000Z';

const HISTORY_SAMPLE_ERROR_CODES = [
  'HISTORY_SAMPLE_UNAUTHORIZED',
  'HISTORY_SAMPLE_SCOPE_MISSING',
  'HISTORY_SAMPLE_ROOT_INVALID',
  'HISTORY_SAMPLE_PATH_INVALID',
  'HISTORY_SAMPLE_PATH_ESCAPE',
  'HISTORY_SAMPLE_SYMLINK_REFUSED',
  'HISTORY_SAMPLE_REAL_SESSION_REFUSED',
  'HISTORY_SAMPLE_FORMAT_UNKNOWN',
  'HISTORY_SAMPLE_PARSE_FAILED',
  'HISTORY_SAMPLE_EMPTY',
] as const;
type HistorySampleErrorCode = (typeof HISTORY_SAMPLE_ERROR_CODES)[number];

const SYNTHETIC_MARKERS = [
  'SYNTHETIC_CONTENT_MARKER',
  'SYNTHETIC_MESSAGE_MARKER',
  'SYNTHETIC_SECRET_MARKER',
  'SYNTHETIC_TOKEN_MARKER',
  'SYNTHETIC_PROMPT_MARKER',
  'SYNTHETIC_TEXT_MARKER',
] as const;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

async function temp(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

function emptyVerdicts(): Record<CapabilityLayer, ClientVerdict> {
  return {
    detected: 'unavailable',
    configured: 'unavailable',
    mcp: 'unavailable',
    tools: 'unavailable',
    brief: 'unavailable',
    instructions: 'unavailable',
    orchestration: 'unavailable',
    history: 'unavailable',
    'output-interception': 'unavailable',
  };
}

function detected(clientId: ClientId, at: string = AT): DetectResult {
  return {
    clientId,
    detected: true,
    executablePath: `/fake/${clientId}`,
    version: null,
    sources: [],
    errors: [],
  };
}

function assertHistoryUnavailable(report: ClientReport): void {
  const history = report.layers.history;
  assert.equal(history.layer, 'history');
  assert.equal(history.code, 'E8');
  assert.equal(history.verdict, 'unavailable', `${report.clientId} history must stay unavailable`);
  assert.equal(history.evidence, 'absent');
  assert.equal(history.details.source, null);
  assert.equal(history.details.formatVersion, null);
  assert.equal(history.details.sampleAuthorized, false);
  assert.equal(history.details.parsedRecords, 0);
  assert.equal(history.details.privacy, 'not-read');
  if (history.source.includes('adr-007:no-authorized-sample')) {
    assert.ok(
      history.limitations.some((line) => line.includes('authorized sample')),
      `${report.clientId} history must state the authorized-sample requirement`,
    );
    assert.ok(
      history.limitations.some((line) => line.includes('synthetic fixtures do not upgrade')),
      `${report.clientId} history must state the synthetic-fixture non-upgrade rule`,
    );
  }
}

// ---------------------------------------------------------------------------
// History sampling contract (executable specification)
// ---------------------------------------------------------------------------

interface HistoryAuthorization {
  readonly scope: readonly string[];
  readonly sampleRoot: string;
  readonly grantedBy: string;
}

interface HistorySampleRequest {
  readonly authorization?: HistoryAuthorization;
  readonly samplePath: string;
  readonly synthetic?: boolean;
}

interface HistoryMetadata {
  readonly recordCount: number;
  readonly timeRange: { readonly start: string | null; readonly end: string | null } | null;
  readonly format: string;
  readonly synthetic: boolean;
}

type HistorySampleResult =
  | { readonly ok: true; readonly metadata: HistoryMetadata; readonly reads: readonly string[] }
  | { readonly ok: false; readonly code: HistorySampleErrorCode; readonly message: string; readonly reads: readonly string[] };

interface HistorySamplerOptions {
  readonly readFile?: (path: string) => Promise<string>;
  readonly lstat?: (path: string) => Promise<Stats>;
}

/** Real session storage locations that must never be sampled. */
const FORBIDDEN_SESSION_SEGMENTS: readonly (readonly string[])[] = [
  ['.claude', 'projects'],
  ['.codex', 'sessions'],
  ['.cursor'],
];

function isForbiddenSessionPath(path: string): boolean {
  const segments = resolve(path).split(sep);
  return FORBIDDEN_SESSION_SEGMENTS.some((marker) =>
    segments.some((_, start) => marker.every((part, offset) => segments[start + offset] === part)),
  );
}

function historyFormatOf(path: string): 'json' | 'jsonl' | null {
  const extension = extname(path).toLowerCase();
  if (extension === '.json') return 'json';
  if (extension === '.jsonl' || extension === '.ndjson') return 'jsonl';
  return null;
}

function parseHistoryRecords(text: string, format: 'json' | 'jsonl'): readonly unknown[] | null {
  if (format === 'jsonl') {
    const records: unknown[] = [];
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        records.push(JSON.parse(trimmed) as unknown);
      } catch {
        return null;
      }
    }
    return records;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    if (parsed !== null && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>;
      for (const key of ['records', 'messages', 'sessions', 'history']) {
        const value = record[key];
        if (Array.isArray(value)) return value;
      }
    }
    return null;
  } catch {
    return null;
  }
}

const TIMESTAMP_KEYS = ['timestamp', 'ts', 'time', 'createdAt', 'created_at', 'updatedAt'] as const;

function timeRangeOf(records: readonly unknown[]): { start: string | null; end: string | null } | null {
  const values: string[] = [];
  for (const record of records) {
    if (record === null || typeof record !== 'object') continue;
    const entry = record as Record<string, unknown>;
    for (const key of TIMESTAMP_KEYS) {
      const value = entry[key];
      if (typeof value === 'string' && value.length > 0) {
        values.push(value);
        break;
      }
      if (typeof value === 'number' && Number.isFinite(value)) {
        values.push(new Date(value).toISOString());
        break;
      }
    }
  }
  if (values.length === 0) return null;
  values.sort();
  return { start: values[0] ?? null, end: values[values.length - 1] ?? null };
}

/**
 * Authorized, privacy-minimizing history sampler.
 *
 * Fail-closed contract:
 * - explicit authorization with `scope` containing `history` and a sample root;
 * - sample path must stay inside the authorized root and must not be a symlink;
 * - real session storage paths are refused before any read;
 * - only a known format (`.json` / `.jsonl`) is parsed; unknown formats and
 *   corrupt payloads are refused, never guessed;
 * - output is structural metadata only (count / time range / format id).
 */
class HistorySampler {
  private readonly reader: (path: string) => Promise<string>;
  private readonly lstatFn: (path: string) => Promise<Stats>;
  private readonly reads: string[] = [];

  constructor(options: HistorySamplerOptions = {}) {
    this.reader = options.readFile ?? ((path) => readFileText(path, 'utf8'));
    this.lstatFn = options.lstat ?? ((path) => lstat(path));
  }

  get readPaths(): readonly string[] {
    return this.reads;
  }

  async sample(request: HistorySampleRequest): Promise<HistorySampleResult> {
    const fail = (code: HistorySampleErrorCode, message: string): HistorySampleResult => ({
      ok: false,
      code,
      message,
      reads: [...this.reads],
    });

    const authorization = request.authorization;
    if (authorization === undefined) {
      return fail('HISTORY_SAMPLE_UNAUTHORIZED', 'history sampling requires an explicit authorization; zero read');
    }
    if (!authorization.scope.includes('history')) {
      return fail(
        'HISTORY_SAMPLE_SCOPE_MISSING',
        `authorization scope must include "history"; got [${authorization.scope.join(', ')}]`,
      );
    }

    const root = resolve(authorization.sampleRoot);
    let rootStat: Stats;
    try {
      rootStat = await this.lstatFn(root);
    } catch {
      return fail('HISTORY_SAMPLE_ROOT_INVALID', `sample root does not exist or is unreadable: ${authorization.sampleRoot}`);
    }
    if (!rootStat.isDirectory()) {
      return fail('HISTORY_SAMPLE_ROOT_INVALID', `sample root is not a directory: ${authorization.sampleRoot}`);
    }

    const target = resolve(request.samplePath);
    if (target !== root && !target.startsWith(root + sep)) {
      return fail('HISTORY_SAMPLE_PATH_ESCAPE', `sample path escapes the authorized root: ${request.samplePath}`);
    }
    if (isForbiddenSessionPath(target)) {
      return fail('HISTORY_SAMPLE_REAL_SESSION_REFUSED', 'real session storage is never sampled; zero read');
    }

    let targetStat: Stats;
    try {
      targetStat = await this.lstatFn(target);
    } catch {
      return fail('HISTORY_SAMPLE_PATH_INVALID', `sample path does not exist or is unreadable: ${request.samplePath}`);
    }
    if (targetStat.isSymbolicLink()) {
      return fail('HISTORY_SAMPLE_SYMLINK_REFUSED', 'symlinked sample paths are refused; zero read');
    }
    if (!targetStat.isFile()) {
      return fail('HISTORY_SAMPLE_PATH_INVALID', `sample path is not a regular file: ${request.samplePath}`);
    }

    const format = historyFormatOf(target);
    if (format === null) {
      return fail(
        'HISTORY_SAMPLE_FORMAT_UNKNOWN',
        `unknown history format for ${request.samplePath}; no parser is fabricated`,
      );
    }

    let text: string;
    try {
      this.reads.push(target);
      text = await this.reader(target);
    } catch (error) {
      return fail(
        'HISTORY_SAMPLE_PATH_INVALID',
        `sample read failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const records = parseHistoryRecords(text, format);
    if (records === null) {
      return fail('HISTORY_SAMPLE_PARSE_FAILED', `sample is not valid ${format}; corrupt payload refused`);
    }
    if (records.length === 0) {
      return fail('HISTORY_SAMPLE_EMPTY', 'sample contains zero records');
    }

    return {
      ok: true,
      metadata: {
        recordCount: records.length,
        timeRange: timeRangeOf(records),
        format,
        synthetic: request.synthetic === true,
      },
      reads: [...this.reads],
    };
  }
}

// ---------------------------------------------------------------------------
// History boundary gate (privacy / anti-amplification contract)
// ---------------------------------------------------------------------------

/**
 * The history layer may only stay `validated`/`measured` when the report
 * carries an authorized sample with a known format and that sample is not a
 * synthetic fixture. Anything else is capped to `degraded`/`assumed`.
 */
function historyUpgradeAllowed(report: ClientReport, sample: HistoryMetadata | undefined): boolean {
  const details = report.layers.history.details;
  return (
    details.sampleAuthorized === true &&
    details.formatVersion !== null &&
    details.source !== null &&
    sample !== undefined &&
    sample.synthetic === false
  );
}

function enforceHistoryBoundary(report: ClientReport, sample?: HistoryMetadata): ClientReport {
  if (historyUpgradeAllowed(report, sample)) return report;
  const history = report.layers.history;
  if (history.verdict !== 'validated' && history.evidence !== 'measured') return report;
  const capped: HistoryLayerReport = {
    ...history,
    verdict: history.verdict === 'validated' ? 'degraded' : history.verdict,
    evidence: history.evidence === 'measured' ? 'assumed' : history.evidence,
    limitations: [
      ...history.limitations,
      'history capped: no authorized real sample with a known format; synthetic fixtures never upgrade this layer',
    ],
  };
  return { ...report, layers: { ...report.layers, history: capped } };
}

function lyingHistoryReport(clientId: ClientId): ClientReport {
  const layers = unavailableLayerReports(AT, `lying:${clientId}`);
  const history: HistoryLayerReport = {
    layer: 'history',
    code: 'E8',
    verdict: 'validated',
    evidence: 'measured',
    at: AT,
    version: 'synthetic-format-1',
    source: 'lying-adapter',
    limitations: [],
    errors: [],
    details: {
      source: 'lying-adapter',
      formatVersion: 'synthetic-format-1',
      sampleAuthorized: true,
      parsedRecords: 999,
      privacy: 'content-echoed',
    },
  };
  return {
    schema: CLIENT_REPORT_SCHEMA,
    clientId,
    alias: null,
    status: 'ready',
    coreVerdict: 'validated',
    layers: { ...layers, history },
    generatedAt: AT,
    limitations: [],
    errors: [],
  };
}

function lyingAdapter(clientId: ClientId): ClientAdapter {
  return {
    id: clientId,
    identitySources: [{ kind: 'executable', value: clientId, detail: 'lying declaration' }],
    detect: async () => detected(clientId),
    inspect: async () => lyingHistoryReport(clientId),
    config: async () => ({ mode: 'dry-run', changes: [], backupPlan: null, warnings: [] }),
    verify: async (): Promise<VerifyResult> => ({
      handshake: null,
      tools: null,
      brief: null,
      verdicts: emptyVerdicts(),
      errors: [],
    }),
  };
}

class FakeQoderFs implements QoderFs {
  readonly files = new Map<string, string>();
  isFile(path: string): boolean {
    return this.files.has(path);
  }
  readJson(path: string): { ok: true; value: unknown } | { ok: false; error: string } {
    const content = this.files.get(path);
    if (content === undefined) return { ok: false, error: 'ENOENT' };
    try {
      return { ok: true, value: JSON.parse(content) as unknown };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}

// ---------------------------------------------------------------------------
// 1. Twenty-four-client history matrix (default doctor path, isolated home/root)
// ---------------------------------------------------------------------------

test('every registered client keeps history unavailable without an authorized sample', async () => {
  const home = await temp('ano-history-home-');
  const root = await temp('ano-history-root-');
  try {
    const report = await doctorClients({
      home,
      root,
      probePaths: [],
      env: { PATH: '' },
      now: () => AT,
    });

    assert.deepEqual(report.clients.map((client) => client.clientId), [...CLIENT_IDS]);
    assert.equal(CLIENT_IDS.length, 24);
    assert.equal(report.clients.length, 24);
    for (const client of report.clients) {
      assertHistoryUnavailable(client);
      assert.ok(!CAPABILITY_LAYERS.some((layer) => client.layers[layer].verdict === 'validated'));
    }

    const byId = new Map(report.clients.map((client) => [client.clientId, client]));
    // ADR-008 §8: dsh is the declared deepseek-harness alias; with no local
    // measurement it is unavailable, never a permanent unknown.
    const dsh = byId.get('deepseek-harness');
    assert.ok(dsh, 'deepseek-harness (dsh alias) must be registered');
    assert.equal(dsh.alias, 'dsh');
    assert.equal(dsh.status, 'unavailable');
    assert.notEqual(dsh.status, 'ready');
    assert.equal(byId.get('pi')?.status, 'unknown');
    // Bare relative identity sources (e.g. `AGENTS.md`) resolve against the
    // process cwd, so a repository rule file can mark a client detected. That
    // affects `detected`/`status` only; history stays closed either way.
    for (const id of CLIENT_IDS.filter((clientId) => clientId !== 'pi')) {
      const status = byId.get(id)?.status;
      assert.ok(status === 'unavailable' || status === 'degraded', `${id} status must not be ready/unknown`);
      assert.notEqual(status, 'ready');
    }

    const realHome = resolve(homedir());
    for (const client of report.clients) {
      const serialized = JSON.stringify(client.layers.history);
      assert.ok(!serialized.includes(realHome), `${client.clientId} must not reference the real home`);
      assert.ok(!serialized.includes('~/.claude/projects'), `${client.clientId} must not reference real session storage`);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('history is an extension layer: it never feeds coreVerdict and is always E8', () => {
  assert.equal(EVIDENCE_CODE_LAYER['E8'], 'history');
  assert.ok(!CORE_LAYERS.includes('history' as never));
  assert.ok(EXTENSION_LAYERS.includes('history' as never));
  assert.equal(CORE_LAYERS.length, 5);
  assert.equal(EXTENSION_LAYERS.length, 4);
});

test('Pi stays unknown with history unavailable against a lying adapter; deepseek-harness stays unmeasured', async () => {
  const home = await temp('ano-history-home-');
  const root = await temp('ano-history-root-');
  try {
    // Pi: identity unknown, so even a lying history adapter is forced back to
    // the unknown degradation.
    const piReport = await doctorClient(getDescriptor('pi'), {
      adapters: { pi: lyingAdapter('pi') },
      home,
      root,
      probePaths: [],
      env: { PATH: '' },
      now: () => AT,
    });
    assert.equal(piReport.status, 'unknown');
    assertHistoryUnavailable(piReport);

    // deepseek-harness (dsh alias): declared identity, no local measurement, so
    // history stays closed and the report is not upgraded.
    const dshReport = await doctorClient(getDescriptor('deepseek-harness'), {
      home,
      root,
      probePaths: [],
      env: { PATH: '' },
      now: () => AT,
    });
    assert.equal(dshReport.clientId, 'deepseek-harness');
    assert.equal(dshReport.alias, 'dsh');
    assert.notEqual(dshReport.status, 'unknown');
    assert.notEqual(dshReport.status, 'ready');
    assertHistoryUnavailable(dshReport);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('the six known adapters report history unavailable on an isolated empty home', async () => {
  const home = await temp('ano-history-home-');
  const root = await temp('ano-history-root-');
  try {
    const env = { HOME: home, USERPROFILE: home, PATH: '' };
    const reports: readonly ClientReport[] = [
      await createClaudeCodeAdapter({ home, root, probePaths: [], env: { PATH: '' }, now: () => AT }).inspect({ root }),
      await createCodexAdapter({ home, root, probePaths: [], env: { PATH: '' }, now: () => AT }).inspect({ root }),
      await cursorAdapter.inspect({ root, env }),
      await opencodeAdapter.inspect({ root, env }),
      await createQoderAdapter({ home, root, now: () => AT, fs: new FakeQoderFs() }).inspect({}),
      // ADR-008 §8: dsh is the deepseek-harness adapter now, not an unknown one.
      await createDeepSeekHarnessAdapter({ home, root, env: { PATH: '' }, probePaths: [], now: () => AT }).inspect({ root }),
      await createUnknownAdapter('pi').inspect({}),
    ];
    assert.equal(reports.length, 7);
    for (const report of reports) {
      assertHistoryUnavailable(report);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('the registry declares exactly twenty-four clients and history is not a core layer', () => {
  const descriptors = listDescriptors();
  assert.equal(descriptors.length, 24);
  for (const descriptor of descriptors) {
    assert.equal(descriptor.identityStatus === 'unknown', descriptor.id === 'pi');
  }
  assert.equal(getDescriptor('cloudcode').id, 'claude-code');
  // ADR-008 §8: dsh resolves to the declared deepseek-harness identity.
  assert.equal(getDescriptor('dsh').id, 'deepseek-harness');
  assert.equal(getDescriptor('dsh').identityStatus, 'declared');
  assert.equal(getDescriptor('pi').identityStatus, 'unknown');
});

// ---------------------------------------------------------------------------
// 2. Authorization sampling contract
// ---------------------------------------------------------------------------

test('sampling without history authorization or with the wrong scope reads nothing', async () => {
  const root = await temp('ano-history-sample-');
  try {
    await writeFile(join(root, 'history.json'), JSON.stringify([{ timestamp: AT }]), 'utf8');

    const unauthorized = new HistorySampler();
    const missing = await unauthorized.sample({ samplePath: join(root, 'history.json'), synthetic: true });
    assert.equal(missing.ok, false);
    if (!missing.ok) {
      assert.equal(missing.code, 'HISTORY_SAMPLE_UNAUTHORIZED');
      assert.deepEqual(missing.reads, []);
    }
    assert.deepEqual(unauthorized.readPaths, []);

    const wrongScope = new HistorySampler();
    const scoped = await wrongScope.sample({
      authorization: { scope: ['config'], sampleRoot: root, grantedBy: 'test' },
      samplePath: join(root, 'history.json'),
      synthetic: true,
    });
    assert.equal(scoped.ok, false);
    if (!scoped.ok) {
      assert.equal(scoped.code, 'HISTORY_SAMPLE_SCOPE_MISSING');
      assert.deepEqual(scoped.reads, []);
    }
    assert.deepEqual(wrongScope.readPaths, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('sampling refuses an invalid root or a path that escapes the authorized root', async () => {
  const root = await temp('ano-history-sample-');
  const outside = await temp('ano-history-outside-');
  try {
    await writeFile(join(outside, 'history.json'), JSON.stringify([{ timestamp: AT }]), 'utf8');

    const invalidRoot = new HistorySampler();
    const missing = await invalidRoot.sample({
      authorization: { scope: ['history'], sampleRoot: join(root, 'does-not-exist'), grantedBy: 'test' },
      samplePath: join(root, 'does-not-exist', 'history.json'),
      synthetic: true,
    });
    assert.equal(missing.ok, false);
    if (!missing.ok) {
      assert.equal(missing.code, 'HISTORY_SAMPLE_ROOT_INVALID');
      assert.deepEqual(missing.reads, []);
    }

    const escape = new HistorySampler();
    const escaped = await escape.sample({
      authorization: { scope: ['history'], sampleRoot: root, grantedBy: 'test' },
      samplePath: join(outside, 'history.json'),
      synthetic: true,
    });
    assert.equal(escaped.ok, false);
    if (!escaped.ok) {
      assert.equal(escaped.code, 'HISTORY_SAMPLE_PATH_ESCAPE');
      assert.deepEqual(escaped.reads, []);
    }
    assert.deepEqual(escape.readPaths, []);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('sampling refuses symlink paths and real session storage with zero reads', async () => {
  const root = await temp('ano-history-sample-');
  const fakeHome = join(root, 'fake-home');
  const realSession = join(fakeHome, '.claude', 'projects');
  const outside = await temp('ano-history-outside-');
  try {
    await mkdir(realSession, { recursive: true });
    await writeFile(join(realSession, 'session.json'), JSON.stringify([{ timestamp: AT }]), 'utf8');
    await writeFile(join(outside, 'target.json'), JSON.stringify([{ timestamp: AT }]), 'utf8');
    await symlink(join(outside, 'target.json'), join(root, 'link.json'));

    const sampler = new HistorySampler();

    const symlinkResult = await sampler.sample({
      authorization: { scope: ['history'], sampleRoot: root, grantedBy: 'test' },
      samplePath: join(root, 'link.json'),
      synthetic: true,
    });
    assert.equal(symlinkResult.ok, false);
    if (!symlinkResult.ok) {
      assert.equal(symlinkResult.code, 'HISTORY_SAMPLE_SYMLINK_REFUSED');
      assert.deepEqual(symlinkResult.reads, []);
    }

    const sessionResult = await sampler.sample({
      authorization: { scope: ['history'], sampleRoot: fakeHome, grantedBy: 'test' },
      samplePath: join(realSession, 'session.json'),
      synthetic: true,
    });
    assert.equal(sessionResult.ok, false);
    if (!sessionResult.ok) {
      assert.equal(sessionResult.code, 'HISTORY_SAMPLE_REAL_SESSION_REFUSED');
      assert.deepEqual(sessionResult.reads, []);
    }

    const realHome = homedir();
    const realResult = await sampler.sample({
      authorization: { scope: ['history'], sampleRoot: realHome, grantedBy: 'test' },
      samplePath: join(realHome, '.claude', 'projects', 'must-not-read.json'),
      synthetic: true,
    });
    assert.equal(realResult.ok, false);
    if (!realResult.ok) {
      assert.equal(realResult.code, 'HISTORY_SAMPLE_REAL_SESSION_REFUSED');
      assert.deepEqual(realResult.reads, []);
    }

    assert.deepEqual(sampler.readPaths, []);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('sampling refuses unknown formats and corrupted JSON without fabricating a parser', async () => {
  const root = await temp('ano-history-sample-');
  try {
    await writeFile(join(root, 'history.xml'), '<history><record/></history>', 'utf8');
    await writeFile(join(root, 'broken.json'), '{ this is not json', 'utf8');

    const sampler = new HistorySampler();
    const authorization = { scope: ['history'], sampleRoot: root, grantedBy: 'test' } as const;

    const unknown = await sampler.sample({ authorization, samplePath: join(root, 'history.xml'), synthetic: true });
    assert.equal(unknown.ok, false);
    if (!unknown.ok) {
      assert.equal(unknown.code, 'HISTORY_SAMPLE_FORMAT_UNKNOWN');
      assert.deepEqual(unknown.reads, []);
    }

    const corrupt = await sampler.sample({ authorization, samplePath: join(root, 'broken.json'), synthetic: true });
    assert.equal(corrupt.ok, false);
    if (!corrupt.ok) {
      assert.equal(corrupt.code, 'HISTORY_SAMPLE_PARSE_FAILED');
      assert.deepEqual(corrupt.reads, [join(root, 'broken.json')]);
    }

    assert.equal(sampler.readPaths.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('sampling returns structural metadata only and never echoes content or secrets', async () => {
  const root = await temp('ano-history-sample-');
  try {
    const records = [1, 2, 3].map((index) => ({
      id: `rec-${index}`,
      timestamp: `2026-11-2${index}T10:00:00.000Z`,
      content: 'SYNTHETIC_CONTENT_MARKER',
      message: 'SYNTHETIC_MESSAGE_MARKER',
      api_key: 'SYNTHETIC_SECRET_MARKER',
      token: 'SYNTHETIC_TOKEN_MARKER',
      nested: { prompt: 'SYNTHETIC_PROMPT_MARKER', text: 'SYNTHETIC_TEXT_MARKER' },
    }));
    const samplePath = join(root, 'synthetic-history.json');
    await writeFile(samplePath, JSON.stringify(records), 'utf8');

    const sampler = new HistorySampler();
    const result = await sampler.sample({
      authorization: { scope: ['history'], sampleRoot: root, grantedBy: 'test' },
      samplePath,
      synthetic: true,
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.metadata.recordCount, 3);
    assert.equal(result.metadata.format, 'json');
    assert.equal(result.metadata.synthetic, true);
    assert.deepEqual(result.metadata.timeRange, {
      start: '2026-11-21T10:00:00.000Z',
      end: '2026-11-23T10:00:00.000Z',
    });
    assert.deepEqual(result.reads, [samplePath]);

    const serialized = JSON.stringify(result.metadata);
    for (const marker of SYNTHETIC_MARKERS) {
      assert.ok(!serialized.includes(marker), `metadata must never contain ${marker}`);
    }
    assert.deepEqual(Object.keys(result.metadata).sort(), ['format', 'recordCount', 'synthetic', 'timeRange']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a synthetic sample never upgrades the history layer', () => {
  const report = lyingHistoryReport('claude-code');
  const synthetic: HistoryMetadata = { recordCount: 3, timeRange: null, format: 'json', synthetic: true };
  const enforced = enforceHistoryBoundary(report, synthetic);
  assert.equal(enforced.layers.history.verdict, 'degraded');
  assert.equal(enforced.layers.history.evidence, 'assumed');
  assert.ok(enforced.layers.history.limitations.some((line) => line.includes('synthetic fixtures never upgrade')));

  const real: HistoryMetadata = { recordCount: 3, timeRange: null, format: 'json', synthetic: false };
  const allowed = enforceHistoryBoundary(report, real);
  assert.equal(allowed.layers.history.verdict, 'validated');
});

// ---------------------------------------------------------------------------
// 3. Lying adapter never becomes real compatibility
// ---------------------------------------------------------------------------

test('a lying external history adapter is capped to degraded without trusted measurement', async () => {
  const declaration: ExternalAdapterDeclaration = {
    ...lyingAdapter('claude-code'),
    capabilities: { layers: ['history'], notes: ['lying history declaration'] },
    evidence: { source: 'synthetic-fixture', measured: false },
  };
  const validation: ExternalAdapterValidation = { evidenceSource: 'untrusted-synthetic', measured: false };
  const adapter = registerExternalAdapter(declaration, validation);

  const report = await adapter.inspect({});

  assert.notEqual(report.layers.history.verdict, 'validated');
  assert.equal(report.layers.history.verdict, 'degraded');
  assert.equal(report.layers.history.evidence, 'assumed');
  assert.ok(report.layers.history.limitations.some((line) => line.includes('capped')));
  assert.ok(report.errors.some((error) => error.code === 'E_EXTERNAL_VERDICT_CAPPED'));
  assert.notEqual(report.status, 'ready');
});

test('the history boundary gate downgrades a lying injected adapter', async () => {
  const home = await temp('ano-history-home-');
  const root = await temp('ano-history-root-');
  try {
    const raw = await doctorClient(getDescriptor('claude-code'), {
      adapters: { 'claude-code': lyingAdapter('claude-code') },
      home,
      root,
      probePaths: [],
      env: { PATH: '' },
      now: () => AT,
    });
    // doctor passes adapter-supplied extension layers through unchanged; the
    // boundary gate is the privacy/anti-amplification gate for history.
    assert.equal(raw.layers.history.verdict, 'validated');
    assert.equal(raw.layers.history.evidence, 'measured');

    const enforced = enforceHistoryBoundary(raw);
    assert.equal(enforced.layers.history.verdict, 'degraded');
    assert.equal(enforced.layers.history.evidence, 'assumed');
    assert.ok(enforced.layers.history.limitations.some((line) => line.includes('no authorized real sample')));
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
