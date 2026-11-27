import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fingerprintTree } from '../../src/core/fingerprint.ts';
import type { Ledger } from '../../src/ledger/ledger.ts';

/**
 * Test helper for the ledger's completion gate.
 *
 * Production code reaches `done` only through `verifyTask`, which records a
 * real evidence row plus stored Gate metadata and then completes the task. The
 * unit/integration tests below exercise ledger mechanics rather than the Gate
 * runner, so they bind the same two facts (source fingerprint + stored verdict)
 * directly instead of bypassing the gate with a bare `status: 'done'`.
 */

export interface GateCompletion {
  evidenceId: string;
  verdict: Record<string, unknown>;
}

export interface GateCompletionOptions {
  evidenceId?: string;
  /** Idempotency key for the evidence.recorded event. */
  idemKey?: string;
  /** Idempotency key for the task.updated completion event. */
  updateIdemKey?: string;
}

export async function recordGateEvidence(
  root: string,
  ledger: Ledger,
  taskId: string,
  options: GateCompletionOptions = {},
): Promise<GateCompletion> {
  let fingerprint = await fingerprintTree(root);
  if (fingerprint.status === 'degraded' && fingerprint.files.length === 0 && fingerprint.degraded.length === 0) {
    // Ledger-only fixtures still need a non-empty source scope to pass the Gate.
    await writeFile(join(root, '__gate_fixture__.ts'), 'export const gateFixture = true;\n', { flag: 'wx' });
    fingerprint = await fingerprintTree(root);
  }
  if (fingerprint.status !== 'ok' || fingerprint.degraded.length > 0) {
    throw new Error('Gate evidence fixture requires a complete source fingerprint');
  }
  const evidenceId = options.evidenceId ?? randomUUID();
  const at = new Date().toISOString();
  const verdict: Record<string, unknown> = {
    taskId,
    status: 'done',
    level: 'T1',
    evidenceId,
    sourceFingerprint: fingerprint.hash,
    graphRevision: 'test-graph-1',
    freshness: { status: 'fresh', stale: 0 },
    blastRadius: { impacted: [], covered: [], uncovered: [], advisory: [] },
    policy: { minimum: 'T1', unknown: 'strict' },
    caveats: {},
    reasons: ['test gate evidence'],
  };
  const evidence = {
    id: evidenceId,
    argv: [process.execPath, '--test', 'test/a.test.ts'],
    cwd: root,
    sourceFingerprint: fingerprint.hash,
    graphRevision: 'test-graph-1',
    environment: { node: process.version, platform: process.platform, arch: process.arch },
    startedAt: at,
    finishedAt: at,
    durationMs: 1,
    exitCode: 0,
    signal: null,
    timedOut: false,
    counts: { tests: 1, pass: 1 },
    ok: true,
    outputDigest: 'c'.repeat(64),
    verification: {
      idem_key: `gate-${evidenceId}`,
      params: 'test-params',
      identity: 'test-identity',
      task_id: taskId,
      graph_revision: 'test-graph-1',
      test_files: ['test/a.test.ts'],
      policy: { minimum: 'T1', unknown: 'strict' },
      verdict,
    },
  };
  await ledger.append({
    kind: 'evidence.recorded',
    payload: { task_id: taskId, evidence, test_files: ['test/a.test.ts'] },
  }, options.idemKey ?? `ev-${evidenceId}`);
  return { evidenceId, verdict };
}

export async function completeTaskViaGate(
  root: string,
  ledger: Ledger,
  taskId: string,
  options: GateCompletionOptions = {},
): Promise<GateCompletion> {
  const gate = await recordGateEvidence(root, ledger, taskId, options);
  await ledger.updateTask(taskId, { status: 'done', verdict: gate.verdict }, options.updateIdemKey);
  return gate;
}
