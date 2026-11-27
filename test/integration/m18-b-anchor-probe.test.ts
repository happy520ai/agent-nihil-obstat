/**
 * T-153 shard B: reachable branches of `src/surface/anchor-probe.ts`.
 *
 * The existing integration suite covers the real ledger/graph/Connect happy
 * path. This file drives the wrapper's honest-degradation branches with
 * injected samplers/cores plus one real HistoryStore-backed candidate source:
 * core failures, duplicate aliases, used-file drift, re-sample bounds and
 * unreadable project files. No Node internals are mocked.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  anchorProbeSurface,
  createAnchorProbeCandidateSource,
  newProbeRequestId,
  snapshotOnlyProbeCore,
  type AnchorProbeCore,
  type AnchorProbeCoreResult,
  type AnchorProbeReadSources,
  type AnchorProbeSnapshotSampler,
  type AnchorProbeSnapshotSample,
} from '../../src/surface/anchor-probe.ts';
import { HistoryStore } from '../../src/memory/store.ts';
import { makeCursor } from '../../src/memory/cursor.ts';
import { resolveRoot } from '../../src/connect/paths.ts';
import { ANCHOR_PROBE_REQUEST_SCHEMA_VERSION, type AnchorProbeEvidence, type AnchorProbeRequest } from '../../src/memory/probe-contract.ts';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const AT = '2026-11-21T00:00:00.000Z';

function request(overrides: Record<string, unknown> = {}): AnchorProbeRequest {
  return {
    schema_version: ANCHOR_PROBE_REQUEST_SCHEMA_VERSION,
    request_id: 'req-m18b-1',
    root: '/fixtures/root',
    project_scope: 'fixture',
    temporal_mode: 'CURRENT',
    ...overrides,
  } as AnchorProbeRequest;
}

function snapshot(overrides: Record<string, unknown> = {}): AnchorProbeSnapshotSample['snapshot'] {
  return {
    project_scope: 'fixture',
    ledger_digest: HASH_A,
    graph_revision: null,
    source_fingerprint: null,
    connected_digest: null,
    ...overrides,
  } as AnchorProbeSnapshotSample['snapshot'];
}

function sample(overrides: Partial<AnchorProbeSnapshotSample> = {}): AnchorProbeSnapshotSample {
  return {
    snapshot: snapshot(),
    fileHashes: {},
    connect: { connected: false, sourceDigest: null, unverified: true, notice: 'connect unavailable' },
    graphFreshness: null,
    ...overrides,
  };
}

function coreResult(overrides: Partial<AnchorProbeCoreResult> = {}): AnchorProbeCoreResult {
  return {
    budget_status: { stop_reason: 'FRONTIER_EXHAUSTED', retrieval_completeness: 'UNKNOWN', nodes_visited: 1, frontier_remaining: 0 },
    coverage_gate: {
      status: 'UNKNOWN',
      required_facts: [],
      missing_facts: [],
      unresolved_conflicts: [],
      requirements_origin: 'unknown',
    },
    l1_invariants: [],
    active_evidence: [],
    deprecated_tombstones: [],
    gaps: [],
    conflicts: [],
    used_files: [],
    ...overrides,
  };
}

function samplerSequence(samples: readonly AnchorProbeSnapshotSample[]): AnchorProbeSnapshotSampler & { calls: number } {
  let calls = 0;
  return {
    calls: 0,
    async sample(_root: string, _projectScope: string): Promise<AnchorProbeSnapshotSample> {
      calls += 1;
      this.calls = calls;
      return samples[Math.min(calls - 1, samples.length - 1)]!;
    },
  };
}

async function rootFor(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'm18b-anchor-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  return root;
}

test('m18b anchor-probe surfaces a core failure as FAILED with the error text', async (t) => {
  const root = await rootFor(t);
  const fromString = await anchorProbeSurface(
    root,
    request({ root }),
    { sampler: samplerSequence([sample()]), core: (() => { throw 'plain string failure'; }) as unknown as AnchorProbeCore },
  );
  assert.equal(fromString.response.execution_status, 'FAILED');
  assert.ok(fromString.response.l1_invariants.some((item) => item.invariant_id === 'probe.core'
    && (item.detail ?? '').includes('plain string failure')));

  const fromError = await anchorProbeSurface(
    root,
    request({ root, request_id: 'req-m18b-2' }),
    { sampler: samplerSequence([sample()]), core: (() => { throw new Error('core exploded'); }) as unknown as AnchorProbeCore },
  );
  assert.equal(fromError.response.execution_status, 'FAILED');
  assert.ok(fromError.response.l1_invariants.some((item) => (item.detail ?? '').includes('core exploded')));
});

test('m18b anchor-probe rejects forged duplicate aliases and used-file claims', async (t) => {
  const root = await rootFor(t);
  const evidence: AnchorProbeEvidence = {
    ref: 'E1',
    record_ref: 'rec-1',
    content_hash: HASH_A,
    status: 'active',
    source_health: 'verified_at_snapshot',
    recorded_at: AT,
    effective_from: null,
    source: { kind: 'native_note', path: 'docs/example.md' },
    content: 'Example text.',
  };

  await assert.rejects(
    anchorProbeSurface(root, request({ root }), {
      sampler: samplerSequence([sample()]),
      core: (async () => coreResult({
        active_evidence: [evidence],
        deprecated_tombstones: [{
          ref: 'E1',
          record_ref: 'rec-1',
          content_hash: HASH_A,
          status: 'superseded',
          superseded_by: null,
          recorded_at: AT,
        }],
      })) as unknown as AnchorProbeCore,
    }),
    /Duplicate AnchorProbe evidence alias E1/u,
  );

  await assert.rejects(
    anchorProbeSurface(root, request({ root, request_id: 'req-m18b-3' }), {
      sampler: samplerSequence([sample()]),
      core: (async () => coreResult({
        used_files: [
          { path: 'docs/a.md', sha256: HASH_A },
          { path: 'docs/a.md', sha256: HASH_A },
        ],
      })) as unknown as AnchorProbeCore,
    }),
    /Duplicate AnchorProbe used file docs\/a\.md/u,
  );

  await assert.rejects(
    anchorProbeSurface(root, request({ root, request_id: 'req-m18b-4' }), {
      sampler: samplerSequence([sample()]),
      core: (async () => coreResult({ used_files: [{ path: '../outside.md', sha256: HASH_A }] })) as unknown as AnchorProbeCore,
    }),
    /Path traversal is not allowed/u,
  );

  await assert.rejects(
    anchorProbeSurface(root, request({ root, request_id: 'req-m18b-5' }), {
      sampler: samplerSequence([sample()]),
      core: (async () => coreResult({ used_files: [{ path: 'docs/a.md', sha256: 'not-a-hash' }] })) as unknown as AnchorProbeCore,
    }),
    /non-sha256 digest/u,
  );
});

test('m18b anchor-probe reports SNAPSHOT_UNSTABLE when used files drift', async (t) => {
  const root = await rootFor(t);
  await mkdir(join(root, 'docs'), { recursive: true });
  await writeFile(join(root, 'docs', 'a.md'), 'first revision\n');

  const sampler = samplerSequence([sample()]);
  const result = await anchorProbeSurface(root, request({ root }), {
    sampler,
    core: (async ({ sources }: { sources: AnchorProbeReadSources }) => {
      // Claim the file with a stale digest: the wrapper re-hashes the real file.
      void sources.fileSha256('docs/a.md');
      return coreResult({ used_files: [{ path: 'docs/a.md', sha256: HASH_A }] });
    }) as unknown as AnchorProbeCore,
    maxResampleAttempts: 1,
  });
  assert.equal(result.response.execution_status, 'SNAPSHOT_UNSTABLE');
  assert.equal(result.resamples, 2);
  assert.ok(result.response.l1_invariants.some((item) => item.invariant_id === 'snapshot.stable' && item.status === 'violated'));
});

test('m18b anchor-probe waits through the default sleep while a changing snapshot settles', async (t) => {
  const root = await rootFor(t);
  const sampler = samplerSequence([
    sample({ snapshot: snapshot({ ledger_digest: HASH_A }) }),
    sample({ snapshot: snapshot({ ledger_digest: HASH_B }) }),
    sample({ snapshot: snapshot({ ledger_digest: HASH_B }) }),
  ]);
  const result = await anchorProbeSurface(root, request({ root }), {
    sampler,
    core: snapshotOnlyProbeCore,
    maxResampleAttempts: 1,
    resampleDelayMs: 1,
  });
  assert.equal(result.response.execution_status, 'OK');
  assert.equal(result.resamples, 1);
  assert.equal(sampler.calls, 3);
  assert.equal(result.response.snapshot.ledger_digest, HASH_B);
});

test('m18b anchor-probe tolerates unreadable project-relative sources', async (t) => {
  const root = await rootFor(t);
  await mkdir(join(root, 'docs'), { recursive: true });
  let readFileResult: string | undefined;
  let directoryHash: string | undefined;
  await anchorProbeSurface(root, request({ root }), {
    sampler: samplerSequence([sample()]),
    core: (async ({ sources }: { sources: AnchorProbeReadSources }) => {
      readFileResult = sources.readFile('docs/missing.md');
      directoryHash = sources.fileSha256('docs');
      return coreResult();
    }) as unknown as AnchorProbeCore,
  });
  assert.equal(readFileResult, undefined);
  assert.equal(directoryHash, undefined);
});

test('m18b anchor-probe accepts a non-duplicate tombstone alias', async (t) => {
  const root = await rootFor(t);
  const result = await anchorProbeSurface(root, request({ root }), {
    sampler: samplerSequence([sample()]),
    core: (async () => coreResult({
      deprecated_tombstones: [{
        ref: 'E1',
        record_ref: 'rec-1',
        content_hash: HASH_A,
        status: 'superseded',
        superseded_by: null,
        recorded_at: AT,
      }],
    })) as unknown as AnchorProbeCore,
  });
  assert.equal(result.response.execution_status, 'OK');
  assert.equal(result.response.deprecated_tombstones.length, 1);
});

test('m18b anchor-probe binds an explicit context id to its root, scope and snapshot', async (t) => {
  const root = await rootFor(t);
  const projectRoot = resolveRoot(root);
  const storedBase = {
    context_id: 'ctx-m18b',
    root: projectRoot,
    project_scope: 'fixture',
    snapshot: snapshot(),
  };

  await assert.rejects(
    anchorProbeSurface(root, request({ root, context_id: 'ctx-m18b' }), {
      sampler: samplerSequence([sample()]),
      contexts: () => ({ ...storedBase, root: '/somewhere/else' }),
    }),
    /different root/u,
  );

  await assert.rejects(
    anchorProbeSurface(root, request({ root, context_id: 'ctx-m18b' }), {
      sampler: samplerSequence([sample()]),
      contexts: () => ({ ...storedBase, project_scope: 'other' }),
    }),
    /different project_scope/u,
  );

  const unstable = await anchorProbeSurface(root, request({ root, context_id: 'ctx-m18b' }), {
    sampler: samplerSequence([sample()]),
    contexts: () => ({ ...storedBase, snapshot: snapshot({ ledger_digest: HASH_B }) }),
  });
  assert.equal(unstable.response.execution_status, 'SNAPSHOT_UNSTABLE');
  assert.equal(unstable.resamples, 0);

  const stable = await anchorProbeSurface(root, request({ root, context_id: 'ctx-m18b' }), {
    sampler: samplerSequence([sample()]),
    contexts: () => storedBase,
    core: snapshotOnlyProbeCore,
  });
  assert.equal(stable.response.execution_status, 'OK');

  await assert.rejects(
    anchorProbeSurface(root, request({ root, context_id: 'missing' }), {
      sampler: samplerSequence([sample()]),
      contexts: () => undefined,
    }),
    /Unknown AnchorProbe context_id/u,
  );
});

test('m18b anchor-probe generates an opaque request id and routes symbol queries', async (t) => {
  const id = newProbeRequestId();
  assert.match(id, /^req-[0-9a-f]{24}$/u);

  const root = await rootFor(t);
  const source = await createAnchorProbeCandidateSource(root, snapshot());
  assert.deepEqual(source.entries({ symbol: 'anything' }), []);
  assert.deepEqual(source.edges(), []);
});

test('m18b anchor-probe includes HistoryStore candidates in the real read-only source', async (t) => {
  const root = await rootFor(t);
  const store = HistoryStore.open(root);
  try {
    const value = {
      provider: 'synthetic',
      unitId: 'unit-1',
      sourcePath: 'sessions/unit-1.jsonl',
      sessionId: 'session-1',
      title: 'Synthetic session',
      startedAt: AT,
      formatVersion: 'v1',
      visibility: 'visible' as const,
      contentHash: HASH_A,
      mtimeMs: 1,
      size: 10,
    };
    store.indexUnit(value, {
      records: [{
        id: 'msg-1',
        provider: value.provider,
        unitId: value.unitId,
        sessionId: value.sessionId,
        sourcePath: value.sourcePath,
        line: 1,
        role: 'user',
        text: 'remembered history text',
        timestamp: AT,
        visibility: 'visible',
        files: [],
        symbols: [],
      }],
      cursor: makeCursor({ unitId: value.unitId, contentHash: value.contentHash }, 1),
      fullReplay: true,
      skipped: [],
    });

    const source = await createAnchorProbeCandidateSource(root, snapshot(), { now: AT, includeHistory: true });
    const entries = source.entries();
    assert.ok(entries.some((candidate) => candidate.source.kind === 'history'
      && candidate.content === 'remembered history text'));
    // Routing by symbol exercises the last dimension branch of matchesQuery.
    assert.deepEqual(source.entries({ symbol: 'does-not-exist' }), []);
    const matched = source.entries({ file: 'sessions/unit-1.jsonl' });
    assert.equal(matched.length, 1);
    assert.equal(matched[0]?.source.kind, 'history');
  } finally {
    store.close();
  }
});
