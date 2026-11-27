#!/usr/bin/env node
/**
 * P2 concurrency benchmark: N real OS processes write to one ledger root.
 *
 * Every worker is a separate `node` process running this file with `--worker`.
 * Workers race on shared idempotency keys, create unique tasks and evidence,
 * and contend for one shared run lease. The parent then scans every segment,
 * validates chains/checksums, and checks that no event was lost and no
 * idempotent key was committed twice.
 *
 * The canonical evidence file `docs/evidence/p2-concurrency.json` is written
 * only by this script's main entry point. Tests may import `runConcurrencyBench`
 * with an explicit temporary output path.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scanSegment } from '../src/ledger/append.ts';
import { eventChain, type LedgerEvent } from '../src/ledger/event.ts';
import { Ledger } from '../src/ledger/ledger.ts';
import { LeaseHeldError } from '../src/ledger/lease.ts';

export interface ConcurrencyOptions {
  workers?: number;
  uniquePerWorker?: number;
  sharedTasks?: number;
  output?: string;
  workerTimeoutMs?: number;
  keepTmp?: boolean;
}

export interface WorkerResult {
  worker: number;
  shared: { attempts: number; created: number; duplicate: number; conflicts: number };
  unique: { attempts: number; created: number; duplicate: number };
  evidence: { attempts: number; created: number; duplicate: number };
  leases: { uniqueAcquired: boolean; sharedOwned: boolean; heartbeats: number; contended: number };
  errors: string[];
}

export interface ConcurrencyCheck { name: string; ok: boolean; detail: string }
export interface ConcurrencyResult {
  generatedAt: string;
  node: string;
  platform: string;
  command: string;
  workers: number;
  uniquePerWorker: number;
  sharedTasks: number;
  elapsedMs: number;
  root: string;
  segments: number;
  bytes: number;
  events: number;
  segmentSha256: Record<string, string>;
  kinds: Record<string, number>;
  idempotency: { keys: number; duplicated: string[] };
  duplicates: { sharedCreate: number; uniqueCreate: number; evidence: number; expectedSharedCreate: number; expectedUniqueCreate: number; expectedEvidence: number };
  ledger: { tasks: number; evidence: number; runLeases: number; sharedLeaseStatus: string | null; sharedLeaseOwner: string | null };
  workersReported: WorkerResult[];
  checks: ConcurrencyCheck[];
  failures: string[];
  verdict: 'pass' | 'fail';
}

function nowIso(): string { return new Date().toISOString(); }
function sha256(value: Buffer | string): string { return createHash('sha256').update(value).digest('hex'); }

function expectedCounts(workers: number, uniquePerWorker: number, sharedTasks: number): Record<string, number> {
  return {
    'segment.started': workers,
    'task.created': sharedTasks + workers * uniquePerWorker,
    'task.updated': 0,
    'evidence.recorded': workers * uniquePerWorker,
    'verify.started': 0,
    'verify.finished': 0,
    'run.lease.acquired': workers + 1,
    'run.lease.heartbeat': workers + 1,
    'run.lease.reclaimed': 0,
    'run.lease.released': 0,
    'migration.recorded': 0,
  };
}

async function runWorker(root: string, worker: number, uniquePerWorker: number, sharedTasks: number): Promise<WorkerResult> {
  const result: WorkerResult = {
    worker,
    shared: { attempts: 0, created: 0, duplicate: 0, conflicts: 0 },
    unique: { attempts: 0, created: 0, duplicate: 0 },
    evidence: { attempts: 0, created: 0, duplicate: 0 },
    leases: { uniqueAcquired: false, sharedOwned: false, heartbeats: 0, contended: 0 },
    errors: [],
  };
  const ledger = await Ledger.open(root, {
    sessionId: `BENCH-W${worker}`,
    actor: `bench-worker-${worker}`,
    lockTimeoutMs: 120_000,
    lockStaleAfterMs: 120_000,
  });
  try {
    // Two rounds of the same shared keys: one real creation, the rest duplicates.
    for (let round = 0; round < 2; round += 1) {
      for (let shared = 0; shared < sharedTasks; shared += 1) {
        result.shared.attempts += 1;
        try {
          const created = await ledger.createTask(`SHARED-${shared}`, ['shared/src.ts'], `Shared ${shared}`, `bench:v1:shared:${shared}`);
          if (created.duplicate) result.shared.duplicate += 1; else result.shared.created += 1;
        } catch (error) {
          result.shared.conflicts += 1;
          result.errors.push(`shared ${shared}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    const uniqueIds: string[] = [];
    for (let index = 0; index < uniquePerWorker; index += 1) {
      const id = `W${worker}-T${index}`;
      uniqueIds.push(id);
      for (let round = 0; round < 2; round += 1) {
        result.unique.attempts += 1;
        const created = await ledger.createTask(id, [`src/w${worker}-${index}.ts`], `Unique ${worker}-${index}`, `bench:v1:unique:${worker}:${index}`);
        if (created.duplicate) result.unique.duplicate += 1; else result.unique.created += 1;
      }
    }

    for (const [index, taskId] of uniqueIds.entries()) {
      for (let round = 0; round < 2; round += 1) {
        result.evidence.attempts += 1;
        const recorded = await ledger.append({
          kind: 'evidence.recorded',
          payload: {
            task_id: taskId,
            evidence: { id: `bench-evidence-${worker}-${index}`, ok: true, worker, seq: index },
            test_files: [`test/w${worker}-${index}.test.ts`],
          },
        }, `bench:v1:evidence:${worker}:${index}`);
        if (recorded.duplicate) result.evidence.duplicate += 1; else result.evidence.created += 1;
      }
    }

    const uniqueRun = `bench:run:${worker}`;
    const uniqueLease = `lease-${worker}`;
    const acquired = await ledger.acquireRunLease(uniqueRun, { owner: `bench-worker-${worker}`, leaseId: uniqueLease, ttlMs: 60_000, idemKey: `bench:v1:lease:acquire:${worker}` });
    result.leases.uniqueAcquired = acquired.lease.leaseId === uniqueLease;
    const beat = await ledger.heartbeatRunLease(uniqueRun, uniqueLease, { ttlMs: 60_000, idemKey: `bench:v1:lease:heartbeat:${worker}` });
    if (!beat.duplicate) result.leases.heartbeats += 1;

    try {
      const shared = await ledger.acquireRunLease('bench:shared-run', { owner: `bench-worker-${worker}`, leaseId: `shared-lease-${worker}`, ttlMs: 600_000, idemKey: `bench:v1:lease:shared:${worker}` });
      result.leases.sharedOwned = true;
      const sharedBeat = await ledger.heartbeatRunLease('bench:shared-run', shared.lease.leaseId, { ttlMs: 600_000, idemKey: `bench:v1:lease:shared:heartbeat:${worker}` });
      if (!sharedBeat.duplicate) result.leases.heartbeats += 1;
    } catch (error) {
      if (error instanceof LeaseHeldError) result.leases.contended += 1;
      else throw error;
    }
  } finally {
    ledger.close();
  }
  return result;
}

async function spawnWorker(root: string, worker: number, uniquePerWorker: number, sharedTasks: number, timeoutMs: number): Promise<{ result?: WorkerResult; error?: string }> {
  const script = fileURLToPath(import.meta.url);
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [script, '--worker', root, String(worker), String(uniquePerWorker), String(sharedTasks)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolvePromise({ error: `worker ${worker} timed out after ${timeoutMs}ms\n${stderr.slice(-2000)}` });
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ error: `worker ${worker} failed to spawn: ${error.message}` });
    });
    child.once('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const line = stdout.split(/\r?\n/).find((candidate) => candidate.startsWith('WORKER_RESULT '));
      if (code !== 0 || !line) {
        resolvePromise({ error: `worker ${worker} exited ${code ?? 'null'}: ${stderr.slice(-2000)}` });
        return;
      }
      try {
        resolvePromise({ result: JSON.parse(line.slice('WORKER_RESULT '.length)) as WorkerResult });
      } catch (error) {
        resolvePromise({ error: `worker ${worker} printed invalid JSON: ${String(error)}` });
      }
    });
  });
}

export async function runConcurrencyBench(options: ConcurrencyOptions = {}): Promise<ConcurrencyResult> {
  const workers = options.workers ?? 20;
  const uniquePerWorker = options.uniquePerWorker ?? 3;
  const sharedTasks = options.sharedTasks ?? 2;
  const workerTimeoutMs = options.workerTimeoutMs ?? 300_000;
  if (!Number.isSafeInteger(workers) || workers < 1) throw new Error('workers must be a positive integer');
  if (!Number.isSafeInteger(uniquePerWorker) || uniquePerWorker < 1) throw new Error('uniquePerWorker must be a positive integer');
  if (!Number.isSafeInteger(sharedTasks) || sharedTasks < 1) throw new Error('sharedTasks must be a positive integer');
  const output = options.output ?? fileURLToPath(new URL('../docs/evidence/p2-concurrency.json', import.meta.url));
  const root = await mkdtemp(join(tmpdir(), 'ano-p2-concurrency-'));
  const started = Date.now();
  try {
    const settled = await Promise.all(Array.from({ length: workers }, (_, worker) => spawnWorker(root, worker, uniquePerWorker, sharedTasks, workerTimeoutMs)));
    const failures: string[] = [];
    const workersReported: WorkerResult[] = [];
    for (const [index, outcome] of settled.entries()) {
      if (outcome.result) workersReported.push(outcome.result);
      else failures.push(outcome.error ?? `worker ${index} produced no result`);
    }

    const ledgerDir = join(root, '.ano', 'ledger');
    const names = (await readdir(ledgerDir).catch(() => [] as string[])).filter((name) => name.endsWith('.jsonl')).sort();
    const events: LedgerEvent[] = [];
    const segmentSha256: Record<string, string> = {};
    let bytes = 0;
    const seenEventIds = new Map<string, string>();
    for (const name of names) {
      const raw = await readFile(join(ledgerDir, name));
      bytes += raw.length;
      segmentSha256[name] = sha256(raw);
      let scanned;
      try {
        scanned = scanSegment(raw);
      } catch (error) {
        failures.push(`segment ${name} is corrupt: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      if (scanned.ignoredTail) failures.push(`segment ${name} has an uncommitted tail`);
      if (!eventChain(scanned.events)) failures.push(`segment ${name} has an invalid hash chain`);
      for (const event of scanned.events) {
        const prior = seenEventIds.get(event.id);
        if (prior) failures.push(`duplicate event id ${event.id} in ${prior} and ${name}`);
        seenEventIds.set(event.id, name);
        events.push(event);
      }
    }

    const kinds: Record<string, number> = {};
    const idemKeys = new Map<string, number>();
    for (const event of events) {
      kinds[event.kind] = (kinds[event.kind] ?? 0) + 1;
      if (event.idem_key) idemKeys.set(event.idem_key, (idemKeys.get(event.idem_key) ?? 0) + 1);
    }
    const duplicatedKeys = [...idemKeys.entries()].filter(([, count]) => count > 1).map(([key]) => key);
    if (duplicatedKeys.length) failures.push(`idempotency keys committed more than once: ${duplicatedKeys.slice(0, 5).join(', ')}`);

    const expectedKinds = expectedCounts(workers, uniquePerWorker, sharedTasks);
    const allKinds = new Set([...Object.keys(expectedKinds), ...Object.keys(kinds)]);
    for (const kind of allKinds) {
      const expected = expectedKinds[kind] ?? 0;
      const actual = kinds[kind] ?? 0;
      if (actual !== expected) failures.push(`kind ${kind}: expected ${expected}, got ${actual}`);
    }
    const expectedEvents = Object.values(expectedKinds).reduce((sum, count) => sum + count, 0);
    const kindCountsMatch = events.length === expectedEvents && [...allKinds].every((kind) => (kinds[kind] ?? 0) === (expectedKinds[kind] ?? 0));
    if (events.length !== expectedEvents) failures.push(`total events: expected ${expectedEvents}, got ${events.length}`);

    const sharedAttempts = workersReported.reduce((sum, worker) => sum + worker.shared.attempts, 0);
    const sharedCreated = workersReported.reduce((sum, worker) => sum + worker.shared.created, 0);
    const sharedDuplicate = workersReported.reduce((sum, worker) => sum + worker.shared.duplicate, 0);
    const sharedConflicts = workersReported.reduce((sum, worker) => sum + worker.shared.conflicts, 0);
    const uniqueAttempts = workersReported.reduce((sum, worker) => sum + worker.unique.attempts, 0);
    const uniqueCreated = workersReported.reduce((sum, worker) => sum + worker.unique.created, 0);
    const uniqueDuplicate = workersReported.reduce((sum, worker) => sum + worker.unique.duplicate, 0);
    const evidenceAttempts = workersReported.reduce((sum, worker) => sum + worker.evidence.attempts, 0);
    const evidenceCreated = workersReported.reduce((sum, worker) => sum + worker.evidence.created, 0);
    const evidenceDuplicate = workersReported.reduce((sum, worker) => sum + worker.evidence.duplicate, 0);
    if (sharedConflicts !== 0) failures.push(`shared create conflicts: ${sharedConflicts}`);
    if (sharedCreated !== sharedTasks) failures.push(`shared creations: expected ${sharedTasks}, got ${sharedCreated}`);
    if (sharedAttempts - sharedCreated !== sharedDuplicate) failures.push('shared duplicate accounting mismatch');
    if (uniqueCreated !== workers * uniquePerWorker) failures.push(`unique creations: expected ${workers * uniquePerWorker}, got ${uniqueCreated}`);
    if (uniqueAttempts - uniqueCreated !== uniqueDuplicate) failures.push('unique duplicate accounting mismatch');
    if (evidenceCreated !== workers * uniquePerWorker) failures.push(`evidence creations: expected ${workers * uniquePerWorker}, got ${evidenceCreated}`);
    if (evidenceAttempts - evidenceCreated !== evidenceDuplicate) failures.push('evidence duplicate accounting mismatch');
    const sharedOwners = workersReported.filter((worker) => worker.leases.sharedOwned).length;
    if (sharedOwners !== 1) failures.push(`shared lease owners: expected 1, got ${sharedOwners}`);
    const contended = workersReported.reduce((sum, worker) => sum + worker.leases.contended, 0);
    if (contended !== workers - 1) failures.push(`shared lease contention: expected ${workers - 1}, got ${contended}`);
    const uniqueLeaseOwners = workersReported.filter((worker) => worker.leases.uniqueAcquired).length;
    if (uniqueLeaseOwners !== workers) failures.push(`unique lease owners: expected ${workers}, got ${uniqueLeaseOwners}`);
    const heartbeatCount = workersReported.reduce((sum, worker) => sum + worker.leases.heartbeats, 0);
    if (heartbeatCount !== workers + 1) failures.push(`worker heartbeats: expected ${workers + 1}, got ${heartbeatCount}`);

    const verify = await Ledger.open(root, { sessionId: 'BENCH-VERIFY', actor: 'bench-verify', lockTimeoutMs: 120_000, lockStaleAfterMs: 120_000 });
    let taskCount = 0;
    let evidenceCount = 0;
    let runLeases = 0;
    let sharedLeaseStatus: string | null = null;
    let sharedLeaseOwner: string | null = null;
    try {
      taskCount = verify.getTasks().length;
      evidenceCount = verify.listEvidence().length;
      const leases = verify.listRunLeases();
      runLeases = leases.length;
      const sharedLease = verify.getRunLease('bench:shared-run');
      sharedLeaseStatus = sharedLease?.status ?? null;
      sharedLeaseOwner = sharedLease?.owner ?? null;
    } finally {
      verify.close();
    }
    const expectedTasks = sharedTasks + workers * uniquePerWorker;
    if (taskCount !== expectedTasks) failures.push(`ledger tasks: expected ${expectedTasks}, got ${taskCount}`);
    if (evidenceCount !== workers * uniquePerWorker) failures.push(`ledger evidence: expected ${workers * uniquePerWorker}, got ${evidenceCount}`);
    if (runLeases !== workers + 1) failures.push(`run leases: expected ${workers + 1}, got ${runLeases}`);
    if (sharedLeaseStatus !== 'active') failures.push(`shared lease status: expected active, got ${sharedLeaseStatus}`);
    if (!sharedLeaseOwner) failures.push('shared lease has no owner');

    const checks: ConcurrencyCheck[] = [
      { name: 'workers_exited_cleanly', ok: workersReported.length === workers, detail: `${workersReported.length}/${workers}` },
      { name: 'segments_committed', ok: names.length === workers, detail: `${names.length}/${workers}` },
      { name: 'hash_chains_and_checksums', ok: !failures.some((failure) => failure.includes('hash chain') || failure.includes('corrupt') || failure.includes('uncommitted tail')), detail: `${events.length} events` },
      { name: 'no_duplicate_event_ids', ok: !failures.some((failure) => failure.startsWith('duplicate event id')), detail: `${seenEventIds.size} unique ids` },
      { name: 'idempotency_keys_unique', ok: duplicatedKeys.length === 0, detail: `${idemKeys.size} keys` },
      { name: 'event_counts_match', ok: kindCountsMatch, detail: JSON.stringify(kinds) },
      { name: 'shared_creations_once', ok: sharedCreated === sharedTasks && sharedConflicts === 0, detail: `${sharedCreated}/${sharedTasks}` },
      { name: 'unique_creations_persisted', ok: uniqueCreated === workers * uniquePerWorker, detail: `${uniqueCreated}/${workers * uniquePerWorker}` },
      { name: 'evidence_persisted', ok: evidenceCount === workers * uniquePerWorker, detail: `${evidenceCount}/${workers * uniquePerWorker}` },
      { name: 'shared_lease_single_owner', ok: sharedOwners === 1 && contended === workers - 1, detail: `owners=${sharedOwners} contended=${contended}` },
      { name: 'ledger_views_match_events', ok: taskCount === expectedTasks && runLeases === workers + 1, detail: `tasks=${taskCount} leases=${runLeases}` },
    ];
    for (const check of checks) if (!check.ok && !failures.some((failure) => failure.includes(check.name))) failures.push(`check failed: ${check.name} (${check.detail})`);

    const result: ConcurrencyResult = {
      generatedAt: nowIso(),
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      command: `node scripts/bench-concurrency.ts --workers ${workers} --unique ${uniquePerWorker} --shared ${sharedTasks}`,
      workers,
      uniquePerWorker,
      sharedTasks,
      elapsedMs: Date.now() - started,
      root,
      segments: names.length,
      bytes,
      events: events.length,
      segmentSha256,
      kinds,
      idempotency: { keys: idemKeys.size, duplicated: duplicatedKeys },
      duplicates: {
        sharedCreate: sharedDuplicate,
        uniqueCreate: uniqueDuplicate,
        evidence: evidenceDuplicate,
        expectedSharedCreate: workers * sharedTasks * 2 - sharedTasks,
        expectedUniqueCreate: workers * uniquePerWorker,
        expectedEvidence: workers * uniquePerWorker,
      },
      ledger: { tasks: taskCount, evidence: evidenceCount, runLeases, sharedLeaseStatus, sharedLeaseOwner },
      workersReported,
      checks,
      failures,
      verdict: failures.length === 0 ? 'pass' : 'fail',
    };
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    return result;
  } finally {
    if (!options.keepTmp) await rm(root, { recursive: true, force: true });
  }
}

async function workerMain(argv: string[]): Promise<void> {
  const [root, worker, unique, shared] = argv;
  if (!root || !worker) throw new Error('worker requires root and worker index');
  const result = await runWorker(root, Number(worker), Number(unique ?? 3), Number(shared ?? 2));
  process.stdout.write(`WORKER_RESULT ${JSON.stringify(result)}\n`);
}

function parseArgs(argv: string[]): { workers: number; uniquePerWorker: number; sharedTasks: number; output?: string; keepTmp: boolean } {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    workers: Number(value('--workers') ?? 20),
    uniquePerWorker: Number(value('--unique') ?? 3),
    sharedTasks: Number(value('--shared') ?? 2),
    ...(value('--output') === undefined ? {} : { output: resolve(value('--output')!) }),
    keepTmp: argv.includes('--keep-tmp'),
  };
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href === import.meta.url : false;
if (invoked) {
  const workerIndex = process.argv.indexOf('--worker');
  if (workerIndex >= 0) {
    try {
      await workerMain(process.argv.slice(workerIndex + 1));
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  } else {
    try {
      const result = await runConcurrencyBench(parseArgs(process.argv.slice(2)));
      console.log(JSON.stringify({
        verdict: result.verdict,
        workers: result.workers,
        events: result.events,
        segments: result.segments,
        elapsedMs: result.elapsedMs,
        kinds: result.kinds,
        duplicates: result.duplicates,
        failures: result.failures,
      }, null, 2));
      if (result.verdict !== 'pass') process.exitCode = 1;
    } catch (error) {
      console.error(error instanceof Error ? error.stack ?? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
