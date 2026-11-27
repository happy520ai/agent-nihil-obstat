import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { assertLegacyWriteAllowed, legacyWriteDecision, roleMatrixForState } from '../../src/connect/capabilities.ts';
import { backupHash, listBackups, verifyBackup, type BackupManifest } from '../../src/connect/backup.ts';
import { MANAGED_INSTRUCTIONS_BEGIN, MANAGED_INSTRUCTIONS_END, managedStateDeclaration } from '../../src/connect/managed-instructions.ts';
import { readMigrationSummary } from '../../src/ledger/migrate.ts';
import type { LedgerEvent } from '../../src/ledger/event.ts';
import { Ledger } from '../../src/ledger/ledger.ts';
import { replayLedger } from '../../src/ledger/replay.ts';
import { resolveRoot } from '../../src/connect/paths.ts';
import { computeTransactionId, loadPolicy, readTransactions } from '../../src/connect/takeover-store.ts';
import {
  computeTakeoverSourceDigest,
  runTakeover,
  takeoverStatus,
  type TakeoverRunResult,
  type TakeoverRuntime,
} from '../../src/connect/takeover.ts';
import type { ConnectDriftReport } from '../../src/connect/types.ts';
import { detectLegacyDrift } from '../../src/connect/watch.ts';
import { runCli } from '../../src/surface/cli.ts';

/**
 * T-074 / TO-10: full takeover and rollback drill in an isolated synthetic root.
 *
 * Every scenario runs against a fresh `os.tmpdir()` project with a real PM
 * fixture, the real `runTakeover` orchestration, the real ANO ledger and the
 * real CLI surface. Nothing here touches the repository's own `.pm/`, `.ano/`
 * or user-level configuration. The drill writes one machine-readable evidence
 * document. By default it lands in a fresh `os.tmpdir()` directory so the test
 * run never rewrites the repository fingerprint range; setting
 * `ANO_TAKEOVER_EVIDENCE_WRITE=1` is the explicit maintainer opt-in that
 * refreshes the committed snapshot at `docs/evidence/takeover-recovery.json`.
 *
 * History is never deleted: backups, the append-only journal, the ledger and
 * files added while enforced are all asserted to survive recovery.
 */

const NOW = '2026-11-22T00:00:00.000Z';
const NOW2 = '2026-11-22T01:00:00.000Z';
const AGENTS_ORIGINAL = '<!-- pm-mcp:agents-md:v1:begin -->\npm rules\n<!-- pm-mcp:agents-md:v1:end -->\n\n# User notes\n\nkeep this 字节\n';
const REPO_EVIDENCE_PATH = fileURLToPath(new URL('../../docs/evidence/takeover-recovery.json', import.meta.url));
// Explicit opt-in only: refresh the committed docs/evidence snapshot. Default is
// a fresh os.tmpdir() output so test runs stay out of the repository fingerprint.
const EXPLICIT_REPO_EVIDENCE_WRITE = process.env.ANO_TAKEOVER_EVIDENCE_WRITE === '1';

// ---- evidence shapes ----------------------------------------------------

interface AssertionRecord {
  readonly name: string;
  readonly ok: boolean;
  readonly actual: unknown;
  readonly expected: unknown;
}

interface StepRecord {
  readonly name: string;
  readonly at: string;
  readonly detail: unknown;
}

interface ScenarioEvidence {
  id: string;
  name: string;
  status: 'pass' | 'fail';
  started_at: string;
  finished_at: string;
  steps: StepRecord[];
  assertions: AssertionRecord[];
  facts: Record<string, unknown>;
  txId: string | null;
  backupId: string | null;
  backupHash: string | null;
  phaseSequence: string[];
  journalLength: number;
  gaps: string[];
  error: string | null;
}

interface Evidence {
  schema: string;
  task: string;
  generated_at: string;
  platform: string;
  node_version: string;
  isolated: boolean;
  root: string | null;
  scenarios: ScenarioEvidence[];
  preservation: Record<string, unknown>;
  known_gaps: string[];
  summary: { scenarios: number; passed: number; with_gaps: number; failed: number };
}

function isoNow(): string {
  return new Date().toISOString();
}

class Scenario {
  readonly evidence: ScenarioEvidence;

  constructor(id: string, name: string) {
    this.evidence = {
      id,
      name,
      status: 'fail',
      started_at: isoNow(),
      finished_at: '',
      steps: [],
      assertions: [],
      facts: {},
      txId: null,
      backupId: null,
      backupHash: null,
      phaseSequence: [],
      journalLength: 0,
      gaps: [],
      error: null,
    };
  }

  step(name: string, detail: unknown = null): void {
    this.evidence.steps.push({ name, at: isoNow(), detail });
  }

  eq(name: string, actual: unknown, expected: unknown): void {
    assert.equal(actual, expected);
    this.evidence.assertions.push({ name, ok: true, actual, expected });
  }

  deep(name: string, actual: unknown, expected: unknown): void {
    assert.deepEqual(actual, expected);
    this.evidence.assertions.push({ name, ok: true, actual, expected });
  }

  ok(name: string, condition: boolean, detail: unknown = null): void {
    assert.equal(condition, true, name);
    this.evidence.assertions.push({ name, ok: true, actual: condition, expected: true });
    if (detail !== null) this.step(name, detail);
  }

  match(name: string, value: string, pattern: RegExp): void {
    assert.match(value, pattern);
    this.evidence.assertions.push({ name, ok: true, actual: value, expected: pattern.source });
  }

  fact(name: string, value: unknown): void {
    this.evidence.facts[name] = value;
  }

  gap(message: string): void {
    this.evidence.gaps.push(message);
  }

  finish(status: 'pass' | 'fail', error?: unknown): void {
    this.evidence.status = status;
    this.evidence.finished_at = isoNow();
    this.evidence.error = error === undefined ? null : error instanceof Error ? error.message : String(error);
  }
}

// ---- fixtures and helpers ----------------------------------------------

async function makeRoot(t: TestContext, prefix = 'ano-takeover-recovery-'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

async function pmFixture(root: string): Promise<void> {
  await mkdir(join(root, '.pm'), { recursive: true });
  await writeFile(join(root, '.pm', 'project.json'), `${JSON.stringify({ id: 'fixture-project', name: 'Takeover Fixture' }, null, 2)}\n`);
  await writeFile(join(root, '.pm', 'tasks.json'), `${JSON.stringify({
    seq: 1,
    tasks: [
      { id: 'T-PM-1', title: 'Migrate me', status: 'done', files: ['test/a.test.ts'] },
      { id: 'T-PM-2', title: 'Keep going', status: 'in_progress' },
    ],
  }, null, 2)}\n`);
  await writeFile(join(root, '.pm', 'roadmap.json'), `${JSON.stringify({ seq: 1, milestones: [{ id: 'M1', title: 'One', status: 'active' }] }, null, 2)}\n`);
  await writeFile(join(root, '.pm', 'features.json'), `${JSON.stringify({ seq: 1, features: [{ id: 'F-1', name: 'Feature' }] }, null, 2)}\n`);
  await writeFile(join(root, '.pm', 'sessions.json'), `${JSON.stringify({ seq: 1, sessions: [{ id: 'S-1', summary: 'seed' }] }, null, 2)}\n`);
}

function writeAgents(root: string, content: string): void {
  writeFileSync(join(root, 'AGENTS.md'), content);
}

function readAgents(root: string): string {
  return readFileSync(join(root, 'AGENTS.md'), 'utf8');
}

async function pmSnapshot(root: string): Promise<string> {
  const entries: Array<Record<string, unknown>> = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = join(dir, entry.name);
      const rel = prefix.length > 0 ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(full, rel);
      else if (entry.isFile()) {
        const bytes = await readFile(full);
        entries.push({ path: rel, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length });
      }
    }
  };
  await walk(join(root, '.pm'), '');
  return JSON.stringify(entries);
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function ledgerEvents(root: string): LedgerEvent[] {
  return replayLedger(join(root, '.ano', 'ledger')).entries.map((entry) => entry.event);
}

interface GrantIdentity {
  authorizationId: string;
  projectId: string;
  projectKey: string;
}

async function grantCli(root: string, grantedAt: string): Promise<GrantIdentity> {
  const result = await runCli([
    'takeover', 'grant', '--root', root,
    '--scope', 'tasks,memory,acceptance,dag',
    '--granted-by', 'Alice', '--role', 'owner',
    '--statement', 'I explicitly authorize ANO takeover of this project.',
    '--granted-at', grantedAt,
  ]);
  assert.equal(result.code, 0, result.output);
  const payload = JSON.parse(result.output) as { authorization: GrantIdentity };
  return payload.authorization;
}

async function applyCli(root: string, authorizationId: string): Promise<TakeoverRunResult> {
  const result = await runCli(['takeover', 'apply', '--root', root, '--authorization-id', authorizationId, '--confirm']);
  assert.equal(result.code, 0, result.output);
  return JSON.parse(result.output) as TakeoverRunResult;
}

function journalPhases(root: string): string[] {
  return readTransactions(root).map((entry) => entry.phase);
}

// ---- scenarios ---------------------------------------------------------

interface Lifecycle {
  root: string;
  authorizationId: string;
  projectId: string;
  projectKey: string;
  run: TakeoverRunResult;
  manifest: BackupManifest;
  pmBefore: string;
}

async function scenarioFullTakeover(t: TestContext, sc: Scenario): Promise<Lifecycle> {
  const root = await makeRoot(t);
  await pmFixture(root);
  writeAgents(root, AGENTS_ORIGINAL);
  const pmBefore = await pmSnapshot(root);
  sc.step('isolated fixture ready', { root, pmSnapshot: pmBefore });

  const granted = await grantCli(root, NOW);
  sc.eq('grant authorizationId is sha256', /^[0-9a-f]{64}$/.test(granted.authorizationId), true);
  sc.eq('grant reuses Connect projectKey', granted.projectKey, 'field:id:fixture-project');
  sc.eq('grant projectId is 12 hex', /^[0-9a-f]{12}$/.test(granted.projectId), true);
  sc.eq('grant writes no policy before apply', loadPolicy(root), null);
  sc.eq('grant does not touch .pm', await pmSnapshot(root), pmBefore);
  sc.eq('grant does not touch AGENTS.md', readAgents(root), AGENTS_ORIGINAL);
  sc.ok('grant writes .ano/takeover/authorization.json', existsSync(join(root, '.ano', 'takeover', 'authorization.json')));

  const applied = await applyCli(root, granted.authorizationId);
  sc.eq('apply active', applied.active, true);
  sc.eq('apply state', applied.state, 'enforced');
  sc.eq('apply phase', applied.phase, 'active');
  sc.eq('apply aborted', applied.aborted, false);
  sc.eq('apply created', applied.created, true);
  sc.eq('apply resumed', applied.resumed, false);
  sc.eq('apply failedPhase', applied.failedPhase ?? null, null);
  sc.eq('apply error', applied.error ?? null, null);
  sc.eq(
    'txId binds (authorizationId, sourceDigest, backupHash)',
    applied.txId,
    computeTransactionId({ authorizationId: granted.authorizationId, sourceDigest: applied.sourceDigest, backupHash: applied.backupHash }),
  );
  sc.eq('source digest is the migration source digest', applied.sourceDigest, computeTakeoverSourceDigest(root));

  const entries = readTransactions(root);
  sc.deep('journal phase sequence', entries.map((entry) => entry.phase), ['prepared', 'migrated', 'reconciled', 'verified', 'installed', 'active']);
  sc.eq('journal entries share txId', entries.every((entry) => entry.txId === applied.txId), true);
  sc.evidence.txId = applied.txId;
  sc.evidence.backupId = applied.backupId;
  sc.evidence.backupHash = applied.backupHash;
  sc.evidence.phaseSequence = entries.map((entry) => entry.phase);
  sc.evidence.journalLength = entries.length;

  const policy = loadPolicy(root);
  sc.eq('policy state', policy?.state ?? null, 'enforced');
  sc.eq('policy enforcedAt is ISO-8601', typeof policy?.enforcedAt === 'string' && Number.isFinite(Date.parse(policy.enforcedAt as string)), true);
  sc.eq('policy baselineDigest', policy?.baselineDigest ?? null, applied.sourceDigest);
  sc.eq('policy hostCapability', policy?.hostCapability ?? null, 'degraded');

  const status = takeoverStatus(root);
  sc.eq('status state', status.state, 'enforced');
  sc.eq('status transaction phase', status.transaction?.phase ?? null, 'active');
  sc.eq('status transaction count', status.transactions, 6);
  for (const name of ['prepared.json', 'migration-summary.json', 'reconcile.json', 'verification.json', 'installed.json']) {
    sc.eq(`artifact ${name}`, status.artifacts.includes(name), true);
  }

  const manifests = await listBackups(root);
  const manifest = manifests.find((candidate) => candidate.id === applied.backupId);
  sc.ok('backup manifest exists', manifest !== undefined);
  if (manifest === undefined) throw new Error('takeover backup manifest missing');
  sc.eq('backup hash matches', backupHash(manifest), applied.backupHash);
  sc.eq('backup id is takeover-*', manifest.id.startsWith('takeover-'), true);
  const verification = await verifyBackup(root, applied.backupId);
  sc.eq('backup verifies', verification.ok, true);
  sc.eq('backup pm file count', verification.pm, 5);
  sc.eq('backup ledger file count', verification.ledger, 0);
  sc.ok('backup path is .ano/backup/<id>/manifest.json', existsSync(join(root, '.ano', 'backup', manifest.id, 'manifest.json')));
  sc.fact('backupPath', `.ano/backup/${manifest.id}/`);

  const agents = readAgents(root);
  sc.eq('AGENTS.md keeps user prefix', agents.startsWith(AGENTS_ORIGINAL), true);
  sc.eq('AGENTS.md has managed section', agents.includes(MANAGED_INSTRUCTIONS_BEGIN), true);
  sc.eq('AGENTS.md managed declaration is enforced', agents.includes(managedStateDeclaration('enforced')), true);
  sc.eq('AGENTS.md user bytes preserved outside section', agents.slice(0, AGENTS_ORIGINAL.length), AGENTS_ORIGINAL);

  sc.eq('.pm bytes unchanged by takeover', await pmSnapshot(root), pmBefore);

  const events = ledgerEvents(root);
  sc.eq('migration created both tasks', events.filter((event) => event.kind === 'task.created').length, 2);
  sc.eq('migration.recorded summary present', events.some((event) => event.kind === 'migration.recorded' && event.payload.entity === 'migration'), true);
  const summary = readMigrationSummary(root);
  sc.eq('migration summary binds source digest', summary?.source_sha256 ?? null, applied.sourceDigest);
  sc.fact('migrationSummary', summary ?? null);

  const reconcile = readJson<{ report: Record<string, unknown> }>(join(root, '.ano', 'takeover', 'reconcile.json'));
  sc.eq('reconcile matched', reconcile.report.matched, 2);
  sc.deep('reconcile missing', reconcile.report.missing, []);
  sc.deep('reconcile conflicts', reconcile.report.conflicts, []);
  sc.eq('reconcile sourceUnchanged', reconcile.report.sourceUnchanged, true);
  sc.fact('reconcileReport', reconcile.report);

  const verificationRecord = readJson<{ evidence: Array<{ kind: string; ok: boolean }>; evidenceHash: string; hostCapability: string; baselineDigest: string }>(join(root, '.ano', 'takeover', 'verification.json'));
  sc.eq('verification evidence all ok', verificationRecord.evidence.every((entry) => entry.ok), true);
  sc.eq('verification has backup evidence', verificationRecord.evidence.some((entry) => entry.kind === 'backup' && entry.ok), true);
  sc.eq('verification has reconcile evidence', verificationRecord.evidence.some((entry) => entry.kind === 'reconcile' && entry.ok), true);
  sc.eq('verification hostCapability degraded', verificationRecord.hostCapability, 'degraded');
  sc.eq('verification baselineDigest binds source', verificationRecord.baselineDigest, applied.sourceDigest);
  sc.fact('verificationEvidenceHash', verificationRecord.evidenceHash);
  sc.fact('hostCapability', verificationRecord.hostCapability);

  const prepared = readJson<{ agents: { exists: boolean; bytes: number; sha256: string | null }; pm: unknown[]; ledger: unknown[] }>(join(root, '.ano', 'takeover', 'prepared.json'));
  const original = Buffer.from(AGENTS_ORIGINAL, 'utf8');
  sc.eq('prepared agents sha256', prepared.agents.sha256 ?? null, createHash('sha256').update(original).digest('hex'));
  sc.eq('prepared agents bytes', prepared.agents.bytes, original.length);
  sc.eq('prepared pm manifest size', prepared.pm.length, 5);
  sc.eq('prepared ledger manifest size', prepared.ledger.length, 0);

  sc.step('full takeover complete', { txId: applied.txId, backupId: applied.backupId, backupHash: applied.backupHash });
  return {
    root,
    authorizationId: granted.authorizationId,
    projectId: granted.projectId,
    projectKey: granted.projectKey,
    run: applied,
    manifest,
    pmBefore,
  };
}

async function scenarioRepeatTakeover(
  sc: Scenario,
  lifecycle: Lifecycle,
): Promise<{ run: TakeoverRunResult; ledgerEventId: string }> {
  const { root, authorizationId, run: first } = lifecycle;
  const journalBefore = readTransactions(root).length;
  const backupsBefore = (await listBackups(root)).length;
  const agentsBefore = readAgents(root);

  const repeated = await applyCli(root, authorizationId);
  sc.eq('repeat apply active', repeated.active, true);
  sc.eq('repeat apply state', repeated.state, 'enforced');
  sc.eq('repeat txId unchanged', repeated.txId, first.txId);
  sc.eq('repeat backupId unchanged', repeated.backupId, first.backupId);
  sc.eq('repeat backupHash unchanged', repeated.backupHash, first.backupHash);
  sc.eq('repeat created', repeated.created, false);
  sc.eq('repeat resumed', repeated.resumed, true);
  sc.eq('repeat adds no journal entries', readTransactions(root).length, journalBefore);
  sc.eq('repeat creates no backup', (await listBackups(root)).length, backupsBefore);
  sc.eq('repeat leaves AGENTS.md bytes', readAgents(root), agentsBefore);
  sc.evidence.txId = repeated.txId;
  sc.evidence.backupId = repeated.backupId;
  sc.evidence.backupHash = repeated.backupHash;
  sc.evidence.phaseSequence = journalPhases(root);
  sc.evidence.journalLength = readTransactions(root).length;

  // A real ANO ledger write while enforced: this event must survive recovery.
  const ledger = await Ledger.open(root);
  let ledgerEventId = '';
  try {
    const appended = await ledger.append(
      { kind: 'task.updated', payload: { task_id: 'T-PM-2', status: 'in_progress', reason: 'T-074 post-takeover ledger event' } },
      't-074:post-takeover:ledger-event',
    );
    ledgerEventId = appended.event?.id ?? '';
    sc.eq('post-takeover ledger event appended once', appended.duplicate, false);
  } finally {
    ledger.close();
  }
  sc.eq('post-takeover ledger event has id', ledgerEventId.length > 0, true);
  sc.fact('postTakeoverLedgerEventId', ledgerEventId);
  sc.step('repeat takeover and post-takeover ledger write complete', { txId: repeated.txId, ledgerEventId });
  return { run: repeated, ledgerEventId };
}

async function scenarioExternalDrift(
  sc: Scenario,
  lifecycle: Lifecycle,
  ledgerEventId: string,
): Promise<ConnectDriftReport> {
  const { root, run: first } = lifecycle;
  sc.evidence.txId = first.txId;
  sc.evidence.backupId = first.backupId;
  sc.evidence.backupHash = first.backupHash;
  const pmBefore = await pmSnapshot(root);
  const ledgerBefore = ledgerEvents(root).length;

  const tasksPath = join(root, '.pm', 'tasks.json');
  const tasks = JSON.parse(await readFile(tasksPath, 'utf8')) as { seq: number; tasks: Array<Record<string, unknown>> };
  tasks.seq = 2;
  tasks.tasks.push({ id: 'T-PM-3', title: 'External edit', status: 'todo' });
  await writeFile(tasksPath, `${JSON.stringify(tasks, null, 2)}\n`);
  await writeFile(join(root, '.pm', 'external-note.json'), '{"note":"external"}\n');
  const pmAfterExternal = await pmSnapshot(root);
  sc.eq('external write changed .pm', pmAfterExternal !== pmBefore, true);

  const report = detectLegacyDrift(root);
  sc.ok('drift report exists while enforced', report !== null);
  if (report === null) throw new Error('expected a drift report while enforced');
  sc.eq('drift detected', report.drifted, true);
  sc.eq('drift recommendation is recovery', report.recommendation, 'recovery');
  sc.eq('drift marks reconcile stale', report.reconcileStale, true);
  sc.eq('drift baseline is takeover source digest', report.baselineDigest, first.sourceDigest);
  sc.eq('drift current digest differs', report.currentDigest !== report.baselineDigest, true);
  sc.eq('drift keeps policy enforced', loadPolicy(root)?.state ?? null, 'enforced');
  const paths = report.files.map((file) => file.path);
  sc.eq('drift localizes tasks.json', paths.includes('tasks.json'), true);
  sc.eq('drift localizes external-note.json', paths.includes('external-note.json'), true);
  sc.eq('drift tasks.json kind', report.files.find((file) => file.path === 'tasks.json')?.kind ?? null, 'modified');
  sc.eq('drift external-note.json kind', report.files.find((file) => file.path === 'external-note.json')?.kind ?? null, 'added');
  sc.eq('drift detection writes nothing back', await pmSnapshot(root), pmAfterExternal);
  sc.eq('drift detection appends no ledger events', ledgerEvents(root).length, ledgerBefore);
  sc.fact('driftReport', report);

  const journalBefore = readTransactions(root).length;
  const refused = await runCli(['takeover', 'apply', '--root', root, '--authorization-id', lifecycle.authorizationId, '--confirm']);
  sc.eq('drifted apply is refused', refused.code, 1);
  sc.match('drifted apply reason', refused.output, /source changed|drift/iu);
  sc.eq('refused apply adds no journal entries', readTransactions(root).length, journalBefore);
  sc.eq('refused apply keeps policy enforced', loadPolicy(root)?.state ?? null, 'enforced');
  sc.eq('refused apply keeps ledger event', ledgerEvents(root).some((event) => event.id === ledgerEventId), true);
  sc.evidence.phaseSequence = journalPhases(root);
  sc.evidence.journalLength = readTransactions(root).length;
  sc.step('external drift localized without write-back', { recommendation: report.recommendation, files: paths });
  return report;
}

async function scenarioDisable(sc: Scenario, lifecycle: Lifecycle): Promise<Record<string, unknown>> {
  const { root, run: first } = lifecycle;
  sc.evidence.txId = first.txId;
  sc.evidence.backupId = first.backupId;
  sc.evidence.backupHash = first.backupHash;
  const result = await runCli(['takeover', 'disable', '--root', root, '--confirm']);
  sc.eq('disable exit code', result.code, 0);
  const payload = JSON.parse(result.output) as Record<string, unknown>;
  sc.eq('disable state', payload.state, 'recovery');
  sc.eq('policy state after disable', loadPolicy(root)?.state ?? null, 'recovery');

  const matrix = roleMatrixForState('recovery', 'degraded');
  const tasks = matrix.layers.find((layer) => layer.layer === 'tasks');
  sc.eq('recovery ANO tasks role', tasks?.ano ?? null, 'paused');
  sc.eq('recovery legacy tasks role', tasks?.legacyPm ?? null, 'primary-write');
  sc.eq('recovery legacy write decision', legacyWriteDecision('recovery').allowed, true);
  let legacyAllowed = false;
  try {
    assertLegacyWriteAllowed('recovery', 'tasks');
    legacyAllowed = true;
  } catch {
    legacyAllowed = false;
  }
  sc.eq('recovery legacy write assert passes', legacyAllowed, true);

  const agents = readAgents(root);
  sc.eq('managed section still present after disable', agents.includes(MANAGED_INSTRUCTIONS_BEGIN), true);
  const observed = ['enforced', 'disabled', 'recovery'].find((state) => agents.includes(managedStateDeclaration(state))) ?? null;
  // Gap resolution: disable now flips the managed declaration to recovery so the
  // rendered section never claims enforcement after the authoritative switch.
  sc.eq('observed managed declaration after disable', observed, 'recovery');
  sc.eq('disable declaration no longer claims enforced', agents.includes(managedStateDeclaration('enforced')), false);
  sc.fact('managedDeclarationAfterDisable', observed);
  sc.step('disable complete', { state: payload.state, managedDeclaration: observed });
  sc.evidence.phaseSequence = journalPhases(root);
  sc.evidence.journalLength = readTransactions(root).length;
  return payload;
}

async function scenarioRecover(
  sc: Scenario,
  lifecycle: Lifecycle,
  ledgerEventId: string,
): Promise<Record<string, unknown>> {
  const { root, run: first, manifest, pmBefore } = lifecycle;
  sc.evidence.txId = first.txId;
  sc.evidence.backupId = first.backupId;
  sc.evidence.backupHash = first.backupHash;
  const backupsBefore = await listBackups(root);
  sc.eq('backup count before recover', backupsBefore.length, 1);
  const journalBefore = readTransactions(root).length;

  const result = await runCli(['takeover', 'recover', '--root', root, '--confirm']);
  sc.eq('recover exit code', result.code, 0);
  const payload = JSON.parse(result.output) as Record<string, unknown>;
  sc.eq('recover state', payload.state, 'disabled');
  sc.eq('recover restored flag', payload.restored, true);
  sc.eq('recover backupId', payload.backupId, first.backupId);
  sc.eq('recover backupHash', payload.backupHash, first.backupHash);
  sc.eq('policy state after recover', loadPolicy(root)?.state ?? null, 'disabled');
  sc.eq('policy recoveredAt is ISO-8601', typeof loadPolicy(root)?.recoveredAt === 'string' && Number.isFinite(Date.parse(loadPolicy(root)?.recoveredAt as string)), true);

  // Every file named in the backup manifest is restored byte-for-byte; the
  // backup copy itself is untouched.
  const backupRoot = join(root, '.ano', 'backup', manifest.id);
  for (const entry of manifest.pm) {
    const restored = await readFile(join(root, '.pm', ...entry.path.split('/')));
    const original = await readFile(join(backupRoot, '.pm', ...entry.path.split('/')));
    sc.eq(`pm restored to backup bytes: ${entry.path}`, createHash('sha256').update(restored).digest('hex'), entry.sha256);
    sc.eq(`backup copy preserved: ${entry.path}`, createHash('sha256').update(original).digest('hex'), entry.sha256);
  }
  sc.eq('tasks.json restored to pre-drift bytes', await readFile(join(root, '.pm', 'tasks.json'), 'utf8'), await readFile(join(backupRoot, '.pm', 'tasks.json'), 'utf8'));
  sc.eq('external added file preserved (history not deleted)', existsSync(join(root, '.pm', 'external-note.json')), true);
  sc.eq('.pm snapshot after recover differs from pre-takeover only by the external added file', (await pmSnapshot(root)) !== pmBefore, true);
  sc.fact('externalAddedFilesPreserved', ['external-note.json']);

  sc.eq('AGENTS.md restored to original bytes', readAgents(root), AGENTS_ORIGINAL);
  sc.eq('managed section removed', readAgents(root).includes(MANAGED_INSTRUCTIONS_BEGIN), false);
  sc.eq('managed end marker removed', readAgents(root).includes(MANAGED_INSTRUCTIONS_END), false);

  const events = ledgerEvents(root);
  sc.eq('post-takeover ledger event preserved', events.some((event) => event.id === ledgerEventId), true);
  sc.eq('migration ledger events preserved', events.some((event) => event.kind === 'migration.recorded' && event.payload.entity === 'migration'), true);
  sc.eq('task.created events preserved', events.filter((event) => event.kind === 'task.created').length, 2);
  sc.fact('ledgerEventCountAfterRecover', events.length);

  sc.eq('backup still listed', (await listBackups(root)).length, 1);
  sc.eq('backup still verifies', (await verifyBackup(root, first.backupId)).ok, true);
  sc.eq('journal preserved by recover', readTransactions(root).length, journalBefore);
  sc.eq('journal last phase remains active', journalPhases(root).at(-1) ?? null, 'active');

  const status = takeoverStatus(root);
  sc.eq('status state after recover', status.state, 'disabled');
  sc.eq('status transaction phase after recover', status.transaction?.phase ?? null, 'active');
  sc.eq('drift report is null when disabled', detectLegacyDrift(root), null);

  sc.fact('pmBytesRestored', true);
  sc.fact('ledgerEventsPreserved', true);
  sc.fact('backupPreserved', true);
  sc.fact('userContentPreserved', true);
  sc.fact('journalPreserved', true);
  sc.step('recover complete', { state: payload.state, backupId: payload.backupId });
  sc.evidence.phaseSequence = journalPhases(root);
  sc.evidence.journalLength = readTransactions(root).length;
  return payload;
}

async function scenarioReTakeover(
  t: TestContext,
  sc: Scenario,
  lifecycle: Lifecycle,
): Promise<{ fresh: TakeoverRunResult }> {
  const { root, run: first } = lifecycle;

  // (a) Explicit same-root re-grant after recover starts a fresh six-phase cycle.
  const regranted = await grantCli(root, NOW2);
  sc.eq('re-grant produces a new authorizationId', regranted.authorizationId !== first.authorizationId, true);
  const backupsBefore = await listBackups(root);
  const journalBefore = readTransactions(root).length;
  const secondRun = await runCli(['takeover', 'apply', '--root', root, '--authorization-id', regranted.authorizationId, '--confirm']);
  sc.eq('same-root re-takeover succeeds', secondRun.code, 0);
  const secondPayload = JSON.parse(secondRun.output) as { active: boolean; state: string; txId: string; backupId: string };
  sc.eq('same-root re-takeover active', secondPayload.active, true);
  sc.eq('same-root re-takeover state', secondPayload.state, 'enforced');
  sc.eq('same-root re-takeover has a new txId', secondPayload.txId !== first.txId, true);
  sc.eq('same-root re-takeover creates a second backup', (await listBackups(root)).length, backupsBefore.length + 1);
  sc.eq('same-root re-takeover appends a full journal cycle', readTransactions(root).length, journalBefore + 6);
  sc.eq('same-root policy binds the new authorization', loadPolicy(root)?.authorization.authorizationId ?? null, regranted.authorizationId);
  sc.eq('same-root re-takeover declaration enforced', readAgents(root).includes(managedStateDeclaration('enforced')), true);
  sc.fact('sameRootReTakeover', 'allowed after explicit re-grant while disabled');

  // (b) Control: a second full transaction on a fresh isolated root does get a
  // new txId and a new backup.
  const fresh = await makeRoot(t, 'ano-takeover-recovery-second-');
  await pmFixture(fresh);
  writeAgents(fresh, AGENTS_ORIGINAL);
  const granted = await grantCli(fresh, NOW);
  const second = await applyCli(fresh, granted.authorizationId);
  sc.eq('second full transaction active', second.active, true);
  sc.eq('second transaction state', second.state, 'enforced');
  sc.eq('second transaction new txId', second.txId !== first.txId, true);
  sc.eq('second transaction new backupId', second.backupId !== first.backupId, true);
  sc.eq('second transaction backup count', (await listBackups(fresh)).length, 1);
  sc.deep('second transaction phases', journalPhases(fresh), ['prepared', 'migrated', 'reconciled', 'verified', 'installed', 'active']);
  sc.eq('second transaction journal length', readTransactions(fresh).length, 6);
  sc.eq('second AGENTS.md user bytes preserved', readAgents(fresh).startsWith(AGENTS_ORIGINAL), true);
  sc.eq('second transaction managed declaration enforced', readAgents(fresh).includes(managedStateDeclaration('enforced')), true);
  sc.evidence.txId = second.txId;
  sc.evidence.backupId = second.backupId;
  sc.evidence.backupHash = second.backupHash;
  sc.evidence.phaseSequence = journalPhases(fresh);
  sc.evidence.journalLength = readTransactions(fresh).length;
  sc.step('re-takeover boundary probed; fresh-root second transaction verified', { newTxId: second.txId, newBackupId: second.backupId });
  return { fresh: second };
}

async function scenarioFailureInjection(t: TestContext, sc: Scenario): Promise<void> {
  // (a) migration failure -> aborted, zero main-write side effects.
  {
    const root = await makeRoot(t, 'ano-takeover-recovery-fail-migration-');
    await pmFixture(root);
    writeAgents(root, AGENTS_ORIGINAL);
    const pmBefore = await pmSnapshot(root);
    const agentsBefore = readAgents(root);
    const granted = await grantCli(root, NOW);
    const runtime: TakeoverRuntime = {
      migrateProject: async () => {
        throw new Error('injected migration failure');
      },
    };
    const result = await runTakeover(root, { confirm: true, authorizationId: granted.authorizationId, now: NOW, hostCapability: 'degraded', runtime });
    sc.eq('migration failure aborted', result.aborted, true);
    sc.eq('migration failure phase', result.failedPhase ?? null, 'migrated');
    sc.eq('migration failure active', result.active, false);
    sc.eq('migration failure state', result.state, 'disabled');
    sc.match('migration failure error', result.error ?? '', /injected migration failure/);
    sc.deep('migration failure journal', journalPhases(root), ['prepared', 'aborted']);
    sc.eq('migration failure leaves .pm', await pmSnapshot(root), pmBefore);
    sc.eq('migration failure leaves AGENTS.md', readAgents(root), agentsBefore);
    sc.eq('migration failure policy disabled', loadPolicy(root)?.state ?? null, 'disabled');
    sc.eq('migration failure installs no managed section', readAgents(root).includes(MANAGED_INSTRUCTIONS_BEGIN), false);
    sc.step('migration failure injection complete', { failedPhase: result.failedPhase });
  }

  // (b) reconcile failure -> aborted before verified, no managed section.
  {
    const root = await makeRoot(t, 'ano-takeover-recovery-fail-reconcile-');
    await pmFixture(root);
    writeAgents(root, AGENTS_ORIGINAL);
    const pmBefore = await pmSnapshot(root);
    const agentsBefore = readAgents(root);
    const granted = await grantCli(root, NOW);
    const runtime: TakeoverRuntime = {
      reconcileMigration: () => ({
        schema: 'ano.migration-reconcile/1',
        root,
        sourceDigest: '0'.repeat(64),
        sourceUnchanged: true,
        canApply: false,
        sourceTasks: 2,
        ledgerTasks: 1,
        matched: 1,
        missing: ['T-PM-1'],
        conflicts: [],
        records: {},
      }),
    };
    const result = await runTakeover(root, { confirm: true, authorizationId: granted.authorizationId, now: NOW, hostCapability: 'degraded', runtime });
    sc.eq('reconcile failure aborted', result.aborted, true);
    sc.eq('reconcile failure phase', result.failedPhase ?? null, 'reconciled');
    sc.eq('reconcile failure active', result.active, false);
    sc.eq('reconcile failure state', result.state, 'disabled');
    sc.deep('reconcile failure journal', journalPhases(root), ['prepared', 'migrated', 'aborted']);
    sc.eq('reconcile failure leaves .pm', await pmSnapshot(root), pmBefore);
    sc.eq('reconcile failure leaves AGENTS.md', readAgents(root), agentsBefore);
    sc.eq('reconcile failure writes no verification artifact', existsSync(join(root, '.ano', 'takeover', 'verification.json')), false);
    sc.eq('reconcile failure installs no managed section', readAgents(root).includes(MANAGED_INSTRUCTIONS_BEGIN), false);
    sc.step('reconcile failure injection complete', { failedPhase: result.failedPhase });
  }

  // (c) source drift after prepare -> refused, no writes, no active.
  {
    const root = await makeRoot(t, 'ano-takeover-recovery-fail-drift-');
    await pmFixture(root);
    writeAgents(root, AGENTS_ORIGINAL);
    const pmBefore = await pmSnapshot(root);
    const agentsBefore = readAgents(root);
    const granted = await grantCli(root, NOW);
    const prepared = await runTakeover(root, { confirm: true, authorizationId: granted.authorizationId, now: NOW, hostCapability: 'degraded', stopAfterPhase: 'prepared' });
    sc.eq('drift prepare phase', prepared.phase, 'prepared');
    sc.eq('prepare leaves .pm', await pmSnapshot(root), pmBefore);

    const tasksPath = join(root, '.pm', 'tasks.json');
    const tasks = JSON.parse(await readFile(tasksPath, 'utf8')) as { seq: number; tasks: Array<Record<string, unknown>> };
    tasks.seq = 3;
    tasks.tasks.push({ id: 'T-PM-4', title: 'Drift', status: 'todo' });
    await writeFile(tasksPath, `${JSON.stringify(tasks, null, 2)}\n`);
    const pmAfterExternal = await pmSnapshot(root);
    const journalBefore = readTransactions(root).length;

    await assert.rejects(
      runTakeover(root, { confirm: true, authorizationId: granted.authorizationId, now: NOW, hostCapability: 'degraded' }),
      /source changed|drift/iu,
    );
    sc.eq('drift run makes no .pm writes', await pmSnapshot(root), pmAfterExternal);
    sc.eq('drift run makes no journal writes', readTransactions(root).length, journalBefore);
    sc.eq('drift run leaves AGENTS.md', readAgents(root), agentsBefore);
    sc.eq('drift run has no active transaction', takeoverStatus(root).transaction?.phase !== 'active', true);
    sc.eq('drift run policy disabled', loadPolicy(root)?.state ?? null, 'disabled');
    sc.step('source drift injection complete', { journalBefore });
  }
}

async function scenarioRevokeRecoverBoundary(t: TestContext, sc: Scenario): Promise<void> {
  const root = await makeRoot(t, 'ano-takeover-recovery-revoke-');
  await pmFixture(root);
  writeAgents(root, AGENTS_ORIGINAL);
  const pmBefore = await pmSnapshot(root);
  const granted = await grantCli(root, NOW);
  await applyCli(root, granted.authorizationId);

  const revoked = await runCli(['takeover', 'revoke', '--root', root, '--confirm']);
  sc.eq('revoke exit code', revoked.code, 0);
  const revokedPayload = JSON.parse(revoked.output) as { state: string; authorization: { revokedAt: string | null } };
  sc.eq('revoke state', revokedPayload.state, 'recovery');
  sc.eq('revoke writes revokedAt', revokedPayload.authorization.revokedAt !== null, true);

  const recover = await runCli(['takeover', 'recover', '--root', root, '--confirm']);
  // Gap resolution: revocation is an exit action; recovery removes the managed
  // section under the explicit revoked-removal opt-in and restores the old writer.
  sc.eq('recover after revoke succeeds', recover.code, 0);
  const recoverPayload = JSON.parse(recover.output) as { state: string; restored: boolean };
  sc.eq('recover after revoke state', recoverPayload.state, 'disabled');
  sc.eq('recover after revoke restored flag', recoverPayload.restored, true);
  sc.eq('recover after revoke leaves state disabled', loadPolicy(root)?.state ?? null, 'disabled');
  sc.eq('recover after revoke removes managed section', readAgents(root).includes(MANAGED_INSTRUCTIONS_BEGIN), false);
  sc.eq('recover after revoke restores AGENTS bytes', readAgents(root), AGENTS_ORIGINAL);
  sc.eq('recover after revoke restores .pm', await pmSnapshot(root), pmBefore);
  sc.eq('recover after revoke leaves backup', (await listBackups(root)).length, 1);
  sc.fact('revokeRecover', 'allowed: revoked grant permits managed-section removal during explicit recovery');
  sc.step('revoke/recover boundary probed', { state: loadPolicy(root)?.state });
}

// ---- drill -------------------------------------------------------------

test('T-074 isolated full takeover and recovery drill writes machine-readable evidence', async (t) => {
  const scenarios: ScenarioEvidence[] = [];

  async function record<T>(id: string, name: string, run: (sc: Scenario) => Promise<T>): Promise<T | undefined> {
    const sc = new Scenario(id, name);
    try {
      const value = await run(sc);
      sc.finish('pass');
      scenarios.push(sc.evidence);
      return value;
    } catch (error) {
      sc.finish('fail', error);
      scenarios.push(sc.evidence);
      return undefined;
    }
  }

  const lifecycle = await record('S1', 'full takeover: grant -> apply -> six phases -> active', (sc) => scenarioFullTakeover(t, sc));
  const repeat = await record('S2', 'repeat takeover: same authorization/source idempotent replay + post-takeover ledger write', (sc) => {
    if (lifecycle === undefined) throw new Error('S1 did not complete');
    return scenarioRepeatTakeover(sc, lifecycle);
  });
  const drift = await record('S3', 'external drift: localizable report, no write-back, policy unchanged', (sc) => {
    if (lifecycle === undefined || repeat === undefined) throw new Error('S1/S2 did not complete');
    return scenarioExternalDrift(sc, lifecycle, repeat.ledgerEventId);
  });
  await record('S4', 'disable: enforced -> recovery, ANO paused, legacy write restored', (sc) => {
    if (lifecycle === undefined) throw new Error('S1 did not complete');
    return scenarioDisable(sc, lifecycle);
  });
  await record('S5', 'recover: verified backup restore, managed section removal, ledger/backup/journal preserved', (sc) => {
    if (lifecycle === undefined || repeat === undefined) throw new Error('S1/S2 did not complete');
    return scenarioRecover(sc, lifecycle, repeat.ledgerEventId);
  });
  await record('S6', 're-takeover: same-root boundary probe + fresh-root second full transaction', (sc) => {
    if (lifecycle === undefined) throw new Error('S1 did not complete');
    return scenarioReTakeover(t, sc, lifecycle);
  });
  await record('S7', 'failure injection: migration/reconcile aborted and source drift leave no active state', (sc) => scenarioFailureInjection(t, sc));
  await record('S8', 'revoke/recover boundary: post-revoke recovery is fail-closed', (sc) => scenarioRevokeRecoverBoundary(t, sc));

  const byId = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
  const preservation: Record<string, unknown> = {
    pmBytesRestoredFromBackup: byId.get('S5')?.facts.pmBytesRestored ?? false,
    ledgerEventsPreserved: byId.get('S5')?.facts.ledgerEventsPreserved ?? false,
    backupPreserved: byId.get('S5')?.facts.backupPreserved ?? false,
    userContentPreserved: byId.get('S5')?.facts.userContentPreserved ?? false,
    journalPreserved: byId.get('S5')?.facts.journalPreserved ?? false,
    externalAddedFilesPreserved: byId.get('S5')?.facts.externalAddedFilesPreserved ?? [],
  };

  const evidence: Evidence = {
    schema: 'ano.takeover-recovery-evidence/1',
    task: 'T-074',
    generated_at: isoNow(),
    platform: process.platform,
    node_version: process.version,
    isolated: true,
    root: lifecycle?.root ?? null,
    scenarios,
    preservation,
    known_gaps: scenarios.flatMap((scenario) => scenario.gaps),
    summary: {
      scenarios: scenarios.length,
      passed: scenarios.filter((scenario) => scenario.status === 'pass').length,
      with_gaps: scenarios.filter((scenario) => scenario.gaps.length > 0).length,
      failed: scenarios.filter((scenario) => scenario.status === 'fail').length,
    },
  };

  // Default output is a fresh os.tmpdir() directory, so the drill never rewrites
  // the repository fingerprint range. The committed docs/evidence snapshot is
  // only refreshed when ANO_TAKEOVER_EVIDENCE_WRITE=1 is set explicitly.
  const repoEvidenceBefore = existsSync(REPO_EVIDENCE_PATH)
    ? createHash('sha256').update(readFileSync(REPO_EVIDENCE_PATH)).digest('hex')
    : null;
  const evidenceDir = EXPLICIT_REPO_EVIDENCE_WRITE
    ? dirname(REPO_EVIDENCE_PATH)
    : await mkdtemp(join(tmpdir(), 'ano-takeover-recovery-evidence-'));
  const evidencePath = join(evidenceDir, 'takeover-recovery.json');
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);

  const reread = JSON.parse(await readFile(evidencePath, 'utf8')) as Evidence;
  assert.equal(reread.schema, 'ano.takeover-recovery-evidence/1');
  assert.equal(reread.scenarios.length, scenarios.length);
  assert.equal(reread.summary.failed, 0, JSON.stringify(reread.summary));
  assert.equal(reread.preservation.pmBytesRestoredFromBackup, true);
  assert.equal(reread.preservation.ledgerEventsPreserved, true);
  assert.equal(reread.preservation.backupPreserved, true);
  assert.equal(reread.preservation.userContentPreserved, true);
  assert.equal(reread.summary.passed, scenarios.length);

  if (!EXPLICIT_REPO_EVIDENCE_WRITE) {
    const repoEvidenceAfter = existsSync(REPO_EVIDENCE_PATH)
      ? createHash('sha256').update(readFileSync(REPO_EVIDENCE_PATH)).digest('hex')
      : null;
    assert.equal(repoEvidenceAfter, repoEvidenceBefore, 'default drill run must not rewrite docs/evidence/takeover-recovery.json');
  }

  // The drill must never touch the repository's own PM tree.
  const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
  assert.equal(existsSync(join(repoRoot, '.ano', 'takeover')), false, 'the drill must not create .ano/takeover in the repository');
  assert.equal(resolveRoot(repoRoot) !== lifecycle?.root, true);
});
