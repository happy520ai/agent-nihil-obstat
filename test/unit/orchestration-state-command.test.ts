import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  adoptTask,
  readCurrentFingerprint,
  releaseGate,
  verifyCompletion,
  type FingerprintProvider,
} from '../../scripts/orchestration/state-command.ts';

const SCRIPT = fileURLToPath(new URL('../../scripts/orchestration/state-command.ts', import.meta.url));

const SOURCE_A = 'a'.repeat(64);
const SOURCE_B = 'b'.repeat(64);
const REPORT_PATH = '.pm/quality-runs/report.json';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function completionHash(task: { result_note: string; verification: string }): string {
  return createHash('sha256').update(JSON.stringify([task.result_note, task.verification])).digest('hex');
}

function reportText(options: { ok?: unknown; stable?: unknown; before?: string; after?: string } = {}): string {
  const before = options.before ?? SOURCE_A;
  const after = options.after ?? before;
  return JSON.stringify({
    ok: options.ok ?? true,
    source: {
      stable: options.stable ?? true,
      before: { algorithm: 'sha256-tree-v1', sha256: before, files: 1, bytes: 1 },
      after: { algorithm: 'sha256-tree-v1', sha256: after, files: 1, bytes: 1 },
    },
  });
}

function provider(sha256Value: string): FingerprintProvider {
  return () => ({ algorithm: 'sha256-tree-v1', sha256: sha256Value, files: 1, bytes: 1 });
}

interface Fixture {
  root: string;
  planPath: string;
  reportPath: string;
  reportSha256: string;
  task: { result_note: string; verification: string };
}

interface FixtureInput {
  taskStatus?: string;
  resultNote?: string;
  verification?: string;
  report?: string;
  completion?: Record<string, unknown> | null;
  lease?: Record<string, unknown> | null;
}

function createFixture(input: FixtureInput = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'ano-state-command-'));
  mkdirSync(join(root, '.pm', 'quality-runs'), { recursive: true });
  const report = input.report ?? reportText();
  writeFileSync(join(root, REPORT_PATH), report);
  const task = {
    id: 'T-INT',
    title: 'integration',
    detail: '',
    status: input.taskStatus ?? 'done',
    files: [],
    steps: [],
    acceptance: '',
    result_note: input.resultNote ?? 'integration verified',
    verification: input.verification ?? REPORT_PATH,
  };
  writeFileSync(join(root, '.pm', 'tasks.json'), JSON.stringify({ tasks: [task] }));
  const planPath = join(root, 'plan.json');
  writeFileSync(planPath, JSON.stringify({
    schema_version: 1,
    milestone: 'M22',
    description: '',
    tasks: {
      'T-INT': { depends_on: [], gate: 'phase-test', mutex_group: 'integration' },
      'T-NEXT': { depends_on: ['T-INT'], gate: 'phase-test' },
    },
  }));
  const completion = input.completion === undefined
    ? {
        acceptance_verified: true,
        verified_at: '2026-01-01T00:00:00.000Z',
        verification: REPORT_PATH,
        source_sha256: SOURCE_A,
        report_sha256: sha256(report),
        task_sha256: completionHash(task),
      }
    : input.completion;
  const state = {
    schema_version: 1,
    revision: 1,
    leases: input.lease === null
      ? {}
      : { 'T-INT': input.lease ?? { task_id: 'T-INT', lease_id: 'lease-1', attempt: 1, acquired_at: 1, heartbeat_at: 1 } },
    completed: completion === null ? {} : { 'T-INT': completion },
    gates: {},
  };
  writeFileSync(join(root, '.pm', 'orchestration-state.json'), JSON.stringify(state));
  return { root, planPath, reportPath: REPORT_PATH, reportSha256: sha256(report), task };
}

function readState(root: string): {
  completed: Record<string, Record<string, unknown>>;
  gates: Record<string, Record<string, unknown>>;
  leases: Record<string, unknown>;
} {
  return JSON.parse(readFileSync(join(root, '.pm', 'orchestration-state.json'), 'utf8'));
}

function updateTask(fixture: Fixture, patch: Record<string, unknown>): void {
  const path = join(fixture.root, '.pm', 'tasks.json');
  const document = JSON.parse(readFileSync(path, 'utf8')) as { tasks: Array<Record<string, unknown>> };
  Object.assign(document.tasks[0]!, patch);
  writeFileSync(path, JSON.stringify(document));
}

function updateCompletion(fixture: Fixture, patch: Record<string, unknown>): void {
  const state = readState(fixture.root);
  Object.assign(state.completed['T-INT']!, patch);
  writeFileSync(join(fixture.root, '.pm', 'orchestration-state.json'), JSON.stringify(state));
}

function updateLease(fixture: Fixture, lease: Record<string, unknown> | null): void {
  const state = readState(fixture.root);
  if (lease === null) delete state.leases['T-INT'];
  else state.leases['T-INT'] = lease;
  writeFileSync(join(fixture.root, '.pm', 'orchestration-state.json'), JSON.stringify(state));
}

async function withFixture<T>(input: FixtureInput, body: (fixture: Fixture) => T | Promise<T>): Promise<T> {
  const fixture = createFixture(input);
  try {
    return await body(fixture);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

function withVerifyFixture<T>(input: FixtureInput, body: (fixture: Fixture) => T | Promise<T>): Promise<T> {
  return withFixture({ ...input, completion: null }, body);
}

function verify(fixture: Fixture, fingerprint: FingerprintProvider, expected?: string) {
  return verifyCompletion(fixture.root, 'T-INT', fixture.reportPath, expected, fingerprint);
}

// --- verifyCompletion: report shape ---------------------------------------

test('verify rejects truthy non-boolean report ok', async () => {
  await withVerifyFixture({ report: reportText({ ok: 'true' }) }, async fixture => {
    await assert.rejects(verify(fixture, provider(SOURCE_A)), /not successful and source-stable/);
    assert.equal(readState(fixture.root).completed['T-INT'], undefined);
  });
});

test('verify rejects truthy non-boolean source stable', async () => {
  await withVerifyFixture({ report: reportText({ stable: 'yes' }) }, async fixture => {
    await assert.rejects(verify(fixture, provider(SOURCE_A)), /not successful and source-stable/);
  });
});

test('verify rejects before/after mismatch even when stable is truthy', async () => {
  await withVerifyFixture({ report: reportText({ stable: 1, before: SOURCE_A, after: SOURCE_B }) }, async fixture => {
    await assert.rejects(verify(fixture, provider(SOURCE_A)), /not successful and source-stable/);
  });
});

// --- verifyCompletion: PM verification path identity ----------------------

test('verify rejects verification text that only embeds the report path as a substring', async () => {
  await withVerifyFixture({ verification: `superseded-${REPORT_PATH}` }, async fixture => {
    await assert.rejects(verify(fixture, provider(SOURCE_A)), /does not reference/);
    assert.equal(readState(fixture.root).completed['T-INT'], undefined);
  });
});

test('verify rejects a report path used as a prefix of another file name', async () => {
  await withVerifyFixture({ verification: `${REPORT_PATH}.bak` }, async fixture => {
    await assert.rejects(verify(fixture, provider(SOURCE_A)), /does not reference/);
  });
});

test('verify accepts a boundary-delimited report path and records digests', async () => {
  await withVerifyFixture({}, async fixture => {
    const result = await verify(fixture, provider(SOURCE_A));
    assert.deepEqual(result, {
      task_id: 'T-INT',
      report_sha256: fixture.reportSha256,
      source_sha256: SOURCE_A,
      task_sha256: completionHash(fixture.task),
    });
    const state = readState(fixture.root);
    assert.deepEqual(state.completed['T-INT'], {
      acceptance_verified: true,
      verified_at: (state.completed['T-INT'] as { verified_at: string }).verified_at,
      verification: REPORT_PATH,
      source_sha256: SOURCE_A,
      report_sha256: fixture.reportSha256,
      task_sha256: completionHash(fixture.task),
    });
    assert.match(String((state.completed['T-INT'] as { verified_at: string }).verified_at), /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(state.leases['T-INT'], undefined);
  });
});

test('verify accepts a digest-only PM verification reference', async () => {
  await withVerifyFixture({}, async fixture => {
    updateTask(fixture, { verification: `质量报告: other-place.json\n报告 SHA-256: ${fixture.reportSha256}\n` });
    const result = await verify(fixture, provider(SOURCE_A));
    assert.equal(result.report_sha256, fixture.reportSha256);
  });
});

test('verify rejects a digest embedded in a longer hexadecimal token', async () => {
  await withVerifyFixture({}, async fixture => {
    updateTask(fixture, { verification: `报告 SHA-256: 0${fixture.reportSha256}0` });
    await assert.rejects(verify(fixture, provider(SOURCE_A)), /does not reference/);
  });
});

// --- verifyCompletion: current source and time-of-check stability ---------

test('verify rejects a historical report whose source differs from the current tree', async () => {
  await withVerifyFixture({}, async fixture => {
    await assert.rejects(verify(fixture, provider(SOURCE_B)), /does not match current source/);
    assert.equal(readState(fixture.root).completed['T-INT'], undefined);
  });
});

test('verify fails closed when the source changes before the state update', async () => {
  await withVerifyFixture({}, async fixture => {
    let calls = 0;
    const changing: FingerprintProvider = () => ({
      algorithm: 'sha256-tree-v1',
      sha256: calls++ === 0 ? SOURCE_A : SOURCE_B,
      files: 1,
      bytes: 1,
    });
    await assert.rejects(verify(fixture, changing), /Source changed before state update/);
    assert.equal(readState(fixture.root).completed['T-INT'], undefined);
  });
});

test('verify fails closed when the report file changes before the state update', async () => {
  await withVerifyFixture({}, async fixture => {
    let calls = 0;
    const mutating: FingerprintProvider = () => {
      if (calls++ === 0) writeFileSync(join(fixture.root, fixture.reportPath), reportText({ ok: false }));
      return { algorithm: 'sha256-tree-v1', sha256: SOURCE_A, files: 1, bytes: 1 };
    };
    await assert.rejects(verify(fixture, mutating), /Quality report changed before state update/);
    assert.equal(readState(fixture.root).completed['T-INT'], undefined);
  });
});

test('verify fails closed when PM completion evidence changes before the state update', async () => {
  await withVerifyFixture({}, async fixture => {
    let calls = 0;
    const mutating: FingerprintProvider = () => {
      if (calls++ === 0) updateTask(fixture, { result_note: 'rewritten during verification' });
      return { algorithm: 'sha256-tree-v1', sha256: SOURCE_A, files: 1, bytes: 1 };
    };
    await assert.rejects(verify(fixture, mutating), /PM completion evidence changed before state update/);
    assert.equal(readState(fixture.root).completed['T-INT'], undefined);
  });
});

// --- adopt: real PM status and fenced lease --------------------------------

test('adopt refuses a PM task that is not in_progress', async () => {
  await withFixture({ taskStatus: 'done', completion: null, lease: null }, async fixture => {
    assert.throws(() => adoptTask(fixture.root, 'T-INT', 'sess_adopt'), /in_progress/);
    assert.equal(readState(fixture.root).leases['T-INT'], undefined);
  });
});

test('adopt refuses a missing PM task', async () => {
  await withFixture({ taskStatus: 'in_progress', completion: null, lease: null }, async fixture => {
    writeFileSync(join(fixture.root, '.pm', 'tasks.json'), JSON.stringify({ tasks: [] }));
    assert.throws(() => adoptTask(fixture.root, 'T-INT', 'sess_adopt'), /not found/);
  });
});

test('adopt claims an in_progress PM task and fences the heartbeat to the new lease', async () => {
  await withFixture({ taskStatus: 'in_progress', completion: null, lease: null }, async fixture => {
    const result = adoptTask(fixture.root, 'T-INT', 'sess_adopt');
    assert.equal(result.acquired, true);
    assert.equal(result.lease.session_id, 'sess_adopt');
    const lease = readState(fixture.root).leases['T-INT'] as { lease_id: string; session_id: string; heartbeat_at: number };
    assert.equal(lease.lease_id, result.lease.lease_id);
    assert.equal(lease.session_id, 'sess_adopt');
    assert.ok(lease.heartbeat_at > 0);
  });
});

test('adopt refuses an expired lease instead of promoting it', async () => {
  await withFixture({
    taskStatus: 'in_progress',
    completion: null,
    lease: { task_id: 'T-INT', lease_id: 'expired-lease', session_id: 'sess_adopt', attempt: 1, acquired_at: 1, heartbeat_at: 0 },
  }, async fixture => {
    assert.throws(() => adoptTask(fixture.root, 'T-INT', 'sess_adopt'), /non-claimable/);
    const lease = readState(fixture.root).leases['T-INT'] as { lease_id: string; heartbeat_at: number };
    assert.equal(lease.lease_id, 'expired-lease');
    assert.equal(lease.heartbeat_at, 0);
  });
});

test('adopt refuses a fresh lease owned by another session', async () => {
  const now = Date.now();
  await withFixture({
    taskStatus: 'in_progress',
    completion: null,
    lease: { task_id: 'T-INT', lease_id: 'other-lease', session_id: 'sess_other', attempt: 1, acquired_at: now, heartbeat_at: now },
  }, async fixture => {
    assert.throws(() => adoptTask(fixture.root, 'T-INT', 'sess_adopt'), /non-claimable/);
  });
});

test('adopt refreshes a fresh same-session lease through the lease fence', async () => {
  const now = Date.now();
  await withFixture({
    taskStatus: 'in_progress',
    completion: null,
    lease: { task_id: 'T-INT', lease_id: 'same-lease', session_id: 'sess_adopt', attempt: 1, acquired_at: now, heartbeat_at: now },
  }, async fixture => {
    const result = adoptTask(fixture.root, 'T-INT', 'sess_adopt');
    assert.equal(result.acquired, true);
    assert.equal(result.lease.lease_id, 'same-lease');
    const lease = readState(fixture.root).leases['T-INT'] as { lease_id: string; heartbeat_at: number };
    assert.equal(lease.lease_id, 'same-lease');
    assert.ok(lease.heartbeat_at >= now);
  });
});

// --- fingerprint adapter ---------------------------------------------------

test('state-command imports without a resolvable pm-mcp fingerprint provider', () => {
  const empty = mkdtempSync(join(tmpdir(), 'ano-empty-pm-dist-'));
  try {
    const child = spawnSync(process.execPath, [
      '--input-type=module',
      '-e',
      `await import(${JSON.stringify(pathToFileURL(SCRIPT).href)});`,
    ], {
      cwd: empty,
      env: { ...process.env, PM_MCP_DIST: empty },
      encoding: 'utf8',
    });
    assert.equal(child.status, 0, child.stderr);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test('default fingerprint adapter loads the configured pm-mcp implementation', () => {
  const dist = mkdtempSync(join(tmpdir(), 'ano-fake-pm-dist-'));
  const root = mkdtempSync(join(tmpdir(), 'ano-state-command-'));
  const saved = process.env.PM_MCP_DIST;
  writeFileSync(join(dist, 'project-fingerprint.js'), `module.exports = {
  fingerprintProject() {
    return { algorithm: 'sha256-tree-v1', sha256: '${SOURCE_B}', files: 1, bytes: 1 };
  },
};
`);
  process.env.PM_MCP_DIST = dist;
  try {
    assert.equal(readCurrentFingerprint(root), SOURCE_B);
  } finally {
    if (saved === undefined) delete process.env.PM_MCP_DIST;
    else process.env.PM_MCP_DIST = saved;
    rmSync(dist, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('default fingerprint adapter fails closed when the configured dist lacks project-fingerprint.js', () => {
  const empty = mkdtempSync(join(tmpdir(), 'ano-empty-pm-dist-'));
  const saved = process.env.PM_MCP_DIST;
  process.env.PM_MCP_DIST = empty;
  try {
    assert.throws(() => readCurrentFingerprint(empty), /fingerprint provider unavailable|does not export fingerprintProject/i);
  } finally {
    process.env.PM_MCP_DIST = saved;
    rmSync(empty, { recursive: true, force: true });
  }
});

// --- gate: fresh report/source/PM revalidation ----------------------------

test('gate rechecks report success instead of trusting historical completion', async () => {
  await withFixture({
    report: reportText({ ok: false }),
    completion: { acceptance_verified: true, verified_at: '2026-01-01T00:00:00.000Z', verification: REPORT_PATH },
  }, async fixture => {
    assert.throws(() => releaseGate({
      root: fixture.root,
      gateId: 'phase-test',
      reportPath: REPORT_PATH,
      planPath: 'plan.json',
      fingerprint: provider(SOURCE_A),
    }), /not successful and source-stable/);
    assert.equal(readState(fixture.root).gates['phase-test'], undefined);
  });
});

test('gate rejects truthy report booleans despite historical completion', async () => {
  await withFixture({
    report: reportText({ ok: 'true', stable: 'true' }),
    completion: { acceptance_verified: true, verified_at: '2026-01-01T00:00:00.000Z', verification: REPORT_PATH },
  }, async fixture => {
    assert.throws(() => releaseGate({
      root: fixture.root,
      gateId: 'phase-test',
      reportPath: REPORT_PATH,
      planPath: 'plan.json',
      fingerprint: provider(SOURCE_A),
    }), /not successful and source-stable/);
  });
});

test('gate rechecks current source instead of trusting historical completion', async () => {
  await withFixture({
    completion: { acceptance_verified: true, verified_at: '2026-01-01T00:00:00.000Z', verification: REPORT_PATH },
  }, async fixture => {
    assert.throws(() => releaseGate({
      root: fixture.root,
      gateId: 'phase-test',
      reportPath: REPORT_PATH,
      planPath: 'plan.json',
      fingerprint: provider(SOURCE_B),
    }), /does not match current source/);
    assert.equal(readState(fixture.root).gates['phase-test'], undefined);
  });
});

test('gate rechecks PM task status instead of trusting historical completion', async () => {
  await withFixture({
    taskStatus: 'in_progress',
    completion: { acceptance_verified: true, verified_at: '2026-01-01T00:00:00.000Z', verification: REPORT_PATH },
  }, async fixture => {
    assert.throws(() => releaseGate({
      root: fixture.root,
      gateId: 'phase-test',
      reportPath: REPORT_PATH,
      planPath: 'plan.json',
      fingerprint: provider(SOURCE_A),
    }), /PM task lacks completion evidence/);
  });
});

test('gate rejects completion whose task fingerprint no longer matches PM', async () => {
  await withFixture({}, async fixture => {
    updateTask(fixture, { result_note: 'rewritten after verification' });
    assert.throws(() => releaseGate({
      root: fixture.root,
      gateId: 'phase-test',
      reportPath: REPORT_PATH,
      planPath: 'plan.json',
      fingerprint: provider(SOURCE_A),
    }), /task attestation is missing or changed/);
    assert.equal(readState(fixture.root).gates['phase-test'], undefined);
  });
});

test('gate rejects a stale report digest attestation', async () => {
  await withFixture({}, async fixture => {
    writeFileSync(join(fixture.root, REPORT_PATH), `${reportText()} `);
    assert.throws(() => releaseGate({
      root: fixture.root,
      gateId: 'phase-test',
      reportPath: REPORT_PATH,
      planPath: 'plan.json',
      fingerprint: provider(SOURCE_A),
    }), /report attestation is missing or stale/);
  });
});

test('gate rejects a stale source digest attestation', async () => {
  await withFixture({}, async fixture => {
    updateCompletion(fixture, { source_sha256: SOURCE_B });
    assert.throws(() => releaseGate({
      root: fixture.root,
      gateId: 'phase-test',
      reportPath: REPORT_PATH,
      planPath: 'plan.json',
      fingerprint: provider(SOURCE_A),
    }), /source attestation is missing or stale/);
  });
});

test('gate opens only after revalidating report, source and PM and records attestation', async () => {
  await withFixture({}, async fixture => {
    const result = releaseGate({
      root: fixture.root,
      gateId: 'phase-test',
      reportPath: REPORT_PATH,
      planPath: 'plan.json',
      fingerprint: provider(SOURCE_A),
    });
    assert.equal(result.gate, 'phase-test');
    assert.equal(result.passed, true);
    assert.equal(result.verification, REPORT_PATH);
    assert.equal(result.report_sha256, fixture.reportSha256);
    assert.equal(result.source_sha256, SOURCE_A);
    assert.equal(result.task_id, 'T-INT');
    assert.equal(result.task_sha256, completionHash(fixture.task));
    const state = readState(fixture.root);
    assert.deepEqual(state.gates['phase-test'], {
      passed: true,
      verified_at: (state.gates['phase-test'] as { verified_at: string }).verified_at,
      verification: REPORT_PATH,
      report_sha256: fixture.reportSha256,
      source_sha256: SOURCE_A,
      task_id: 'T-INT',
    });
    assert.match(String((state.gates['phase-test'] as { verified_at: string }).verified_at), /^\d{4}-\d{2}-\d{2}T/);
  });
});

test('gate rejects legacy completion evidence that lacks all attestation hashes', async () => {
  await withFixture({
    completion: { acceptance_verified: true, verified_at: '2026-01-01T00:00:00.000Z', verification: REPORT_PATH },
  }, async fixture => {
    assert.throws(() => releaseGate({
      root: fixture.root,
      gateId: 'phase-test',
      reportPath: REPORT_PATH,
      planPath: 'plan.json',
      fingerprint: provider(SOURCE_A),
    }), /report attestation is missing or stale/);
    assert.equal(readState(fixture.root).gates['phase-test'], undefined);
  });
});

test('gate rejects a missing completion record', async () => {
  await withFixture({ completion: null }, async fixture => {
    assert.throws(() => releaseGate({
      root: fixture.root,
      gateId: 'phase-test',
      reportPath: REPORT_PATH,
      planPath: 'plan.json',
      fingerprint: provider(SOURCE_A),
    }), /requires current verified integration task/);
  });
});

test('gate rejects a completion that names a different report', async () => {
  await withFixture({}, async fixture => {
    updateCompletion(fixture, { verification: '.pm/quality-runs/other.json' });
    assert.throws(() => releaseGate({
      root: fixture.root,
      gateId: 'phase-test',
      reportPath: REPORT_PATH,
      planPath: 'plan.json',
      fingerprint: provider(SOURCE_A),
    }), /requires current verified integration task/);
  });
});

test('gate fails closed when the source changes before the gate update', async () => {
  await withFixture({}, async fixture => {
    let calls = 0;
    const changing: FingerprintProvider = () => ({
      algorithm: 'sha256-tree-v1',
      sha256: calls++ === 0 ? SOURCE_A : SOURCE_B,
      files: 1,
      bytes: 1,
    });
    assert.throws(() => releaseGate({
      root: fixture.root,
      gateId: 'phase-test',
      reportPath: REPORT_PATH,
      planPath: 'plan.json',
      fingerprint: changing,
    }), /Source changed before state update/);
    assert.equal(readState(fixture.root).gates['phase-test'], undefined);
  });
});

test('gate fails closed when the report changes before the gate update', async () => {
  await withFixture({}, async fixture => {
    let calls = 0;
    const mutating: FingerprintProvider = () => {
      if (calls++ === 0) writeFileSync(join(fixture.root, fixture.reportPath), reportText({ stable: false }));
      return { algorithm: 'sha256-tree-v1', sha256: SOURCE_A, files: 1, bytes: 1 };
    };
    assert.throws(() => releaseGate({
      root: fixture.root,
      gateId: 'phase-test',
      reportPath: REPORT_PATH,
      planPath: 'plan.json',
      fingerprint: mutating,
    }), /Quality report changed before state update/);
    assert.equal(readState(fixture.root).gates['phase-test'], undefined);
  });
});
