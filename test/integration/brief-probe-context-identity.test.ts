import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Ledger } from '../../src/ledger/ledger.ts';
import { genesisHash, hashEvent, type LedgerEvent } from '../../src/ledger/event.ts';
import { segmentFileName } from '../../src/ledger/append.ts';
import { encodeEvents } from '../../src/ledger/segment.ts';
import { replayLedger } from '../../src/ledger/replay.ts';
import { viewDigest } from '../../src/ledger/views.ts';
import { ANCHOR_PROBE_REQUEST_SCHEMA_VERSION, anchorProbeDefaultBudget, type AnchorProbeRequest } from '../../src/memory/probe-contract.ts';
import { deriveProbeContextId } from '../../src/memory/probe.ts';
import { ProbeManifestConflictError, ProbeManifestStore, type FrozenProbeManifest } from '../../src/memory/probe-manifest.ts';
import { brief } from '../../src/surface/service.ts';
import { memoryProbeSurface, noteReviseSurface } from '../../src/surface/memory.ts';

test('brief freezes different context budgets without colliding and reuses identical material', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ano-brief-probe-identity-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  await writeFile(join(root, '.gitignore'), '.ano/\n');
  await writeFile(join(root, 'src', 'fixture.ts'), 'export const fixture = 1;\n');
  for (const args of [['init', '-q'], ['config', 'user.email', 'ano@localhost'], ['config', 'user.name', 'ano'], ['add', '.'], ['commit', '-qm', 'fixture']]) {
    const result = spawnSync('git', ['-C', root, '-c', 'core.hooksPath=', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  const ledger = await Ledger.open(root, { sessionId: 'brief-probe-identity', clock: () => 1000 });
  try {
    for (const factKey of ['local.storage.engine', 'local.storage.retention']) {
      await noteReviseSurface(ledger, {
        idem_key: `fixture-${factKey}`,
        fact_key: factKey,
        kind: 'memory',
        text: `Fixture material for ${factKey}.`,
        supersedes: [],
        reason: 'context identity regression fixture',
        effective_from: null,
        effective_to: null,
      });
    }
  } finally {
    ledger.close();
  }
  const before = viewDigest(replayLedger(join(root, '.ano', 'ledger')).entries);
  const first = await brief(root, { include_memory_context: true, context_budget: 1 });
  const second = await brief(root, { include_memory_context: true, context_budget: 20 });
  const repeated = await brief(root, { include_memory_context: true, context_budget: 20 });
  type MemoryContext = { context_id: string; project_scope: string; duplicate: boolean; evidence_count: number };
  const low = first.memory_context as MemoryContext;
  const high = second.memory_context as MemoryContext;
  const same = repeated.memory_context as MemoryContext;
  assert.equal(low.evidence_count, 2);
  assert.equal(high.evidence_count, 2);
  assert.notEqual(low.context_id, high.context_id);
  assert.equal(same.context_id, high.context_id);
  assert.equal(same.duplicate, true);
  const store = new ProbeManifestStore({ root });
  for (const context of [low, high]) assert.equal(store.read(context.context_id, context.project_scope).status, 'ok');
  const file = join(root, '.ano', 'memory', 'probes', `${high.context_id}.json`);
  const frozenBytes = await readFile(file, 'utf8');
  const frozen = JSON.parse(frozenBytes) as FrozenProbeManifest;
  assert.deepEqual(frozen.rules.budget, { ...anchorProbeDefaultBudget, max_nodes: 20 });
  assert.equal(frozen.response.context_id, high.context_id);
  assert.throws(() => store.freeze({
    request: {
      schema_version: ANCHOR_PROBE_REQUEST_SCHEMA_VERSION,
      request_id: frozen.response.request_id,
      root,
      project_scope: high.project_scope,
      required_facts: frozen.rules.required_facts,
      temporal_mode: frozen.rules.temporal_mode,
      budget: frozen.rules.budget,
    },
    response: {
      ...frozen.response,
      l1_invariants: [...frozen.response.l1_invariants, { invariant_id: 'fixture.changed', status: 'unknown' }],
    },
  }), ProbeManifestConflictError);
  assert.equal(viewDigest(replayLedger(join(root, '.ano', 'ledger')).entries), before);
  assert.equal(await readFile(file, 'utf8'), frozenBytes, 'rejected material must leave the frozen manifest intact');

  const writer = await Ledger.open(root, { sessionId: 'brief-probe-changed', clock: () => 2000 });
  try {
    await noteReviseSurface(writer, {
      idem_key: 'fixture-ledger-change',
      fact_key: 'local.storage.backup',
      kind: 'memory',
      text: 'A third governed fact changes the ledger snapshot.',
      supersedes: [],
      reason: 'context identity regression fixture',
      effective_from: null,
      effective_to: null,
    });
  } finally {
    writer.close();
  }
  const after = viewDigest(replayLedger(join(root, '.ano', 'ledger')).entries);
  assert.notEqual(after, before);
  const changed = (await brief(root, { include_memory_context: true, context_budget: 20 })).memory_context as MemoryContext;
  const changedRepeated = (await brief(root, { include_memory_context: true, context_budget: 20 })).memory_context as MemoryContext;
  assert.notEqual(changed.context_id, high.context_id);
  assert.equal(changed.duplicate, false);
  assert.equal(changed.evidence_count, 3);
  assert.equal(changedRepeated.context_id, changed.context_id);
  assert.equal(changedRepeated.duplicate, true);
  const changedFrozen = JSON.parse(await readFile(join(root, '.ano', 'memory', 'probes', `${changed.context_id}.json`), 'utf8')) as FrozenProbeManifest;
  assert.equal(frozen.response.snapshot.ledger_digest, before);
  assert.equal(changedFrozen.response.snapshot.ledger_digest, after);
  for (const context of [low, high, changed]) assert.equal(store.read(context.context_id, context.project_scope).status, 'ok');
  assert.equal(await readFile(file, 'utf8'), frozenBytes, 'a new ledger snapshot must not overwrite the prior context');
  assert.equal(viewDigest(replayLedger(join(root, '.ano', 'ledger')).entries), after);
});

test('memory context identity includes projection conflicts added after the probe core', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ano-probe-final-material-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const factKey = 'local.storage.engine';
  const event = (sequence: number, supersedes: string[], previous: string): LedgerEvent => ({
    id: `${'0'.repeat(25)}${sequence}`,
    actor: 't177-fixture',
    hlc: { physical: 1000 + sequence, logical: 0, actor: 't177-fixture' },
    kind: 'memory.revised',
    idem_key: `fixture-${sequence}`,
    prev_hash: previous,
    payload: {
      intent: 'revise',
      fact_key: factKey,
      record: { kind: 'memory', text: `Fixture branch ${sequence}.` },
      supersedes,
      reason: 'merged-fork context identity fixture',
      effective_from: null,
      effective_to: null,
    },
  });
  const genesis = event(1, [], genesisHash);
  const branchA = event(2, [genesis.id], hashEvent(genesis));
  const branchB = event(3, [genesis.id], genesisHash);
  const ledgerDirectory = join(root, '.ano', 'ledger');
  await mkdir(ledgerDirectory, { recursive: true });
  await writeFile(join(ledgerDirectory, segmentFileName(1000, 'T177-A')), encodeEvents([genesis, branchA]));
  await writeFile(join(ledgerDirectory, segmentFileName(2000, 'T177-B')), encodeEvents([branchB]));
  const ledger = await Ledger.open(root, { sessionId: 'T177-READ', clock: () => 3000 });
  try {
    const request: AnchorProbeRequest = {
      schema_version: ANCHOR_PROBE_REQUEST_SCHEMA_VERSION,
      request_id: 'req-final-material',
      root,
      project_scope: 'fixture',
      required_facts: [factKey],
      temporal_mode: 'CURRENT',
      budget: { ...anchorProbeDefaultBudget },
    };
    const before = viewDigest(replayLedger(ledgerDirectory).entries);
    const response = memoryProbeSurface(ledger, request, { now: '2026-11-22T00:00:00.000Z' });
    assert.equal(response.conflicts.length, 1);
    assert.equal(response.conflicts[0]?.fact_key, factKey);
    assert.equal(response.context_id, deriveProbeContextId(request, response));
    assert.notEqual(response.context_id, deriveProbeContextId(request, { ...response, conflicts: [] }));
    const store = new ProbeManifestStore({ root });
    assert.equal(store.freeze({ request, response }).duplicate, false);
    assert.equal(store.freeze({ request, response: memoryProbeSurface(ledger, request, { now: '2026-11-22T00:00:01.000Z' }) }).duplicate, true);
    assert.equal(store.read(response.context_id, request.project_scope).status, 'ok');
    assert.equal(viewDigest(replayLedger(ledgerDirectory).entries), before);
  } finally {
    ledger.close();
  }
});
