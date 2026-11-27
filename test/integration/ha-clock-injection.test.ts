import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { hashEvent, type LedgerEvent } from '../../src/ledger/event.ts';
import { viewDigest, type ViewReplayEntry } from '../../src/ledger/views.ts';
import { replayLedger } from '../../src/ledger/replay.ts';
import {
  containsWallClockKey,
  MWHA_CLUSTER_LOG_ENTRY_SCHEMA_VERSION,
  MWHA_EVENT_SCHEMA_VERSION,
  type MwhaClusterLogEntry,
  type MwhaWriterEvent,
} from '../../src/memory/ha-protocol.ts';
import { assertLogicalOnlyOrdering } from '../../src/memory/logical-clock.ts';
import { projectMultiWriterState, type MultiWriterEntryRecord } from '../../src/memory/multi-writer.ts';
import {
  createHaClockCluster,
  commitHaClockTask,
  HA_CLOCK_DIAGNOSTIC_SCOPE_NOTE,
  HA_CLOCK_LOCAL_INJECTION_IS_NOT_CROSS_HOST,
  HA_CLOCK_DOES_NOT_CHANGE_SYSTEM_CLOCK,
  HA_CLOCK_CROSS_HOST_UNVERIFIED,
  type HaClockNode,
} from '../harness/ha-clock.ts';

/**
 * T-140 (HA-08): wall-clock injection cannot change committed facts.
 *
 * The same real-ledger event set is wrapped twice: once on a monotonic
 * baseline, once under injected rollback (-60s), future (+10min), jump (+2h
 * then rollback) and per-node skew (±5s). The projection hash, the committed
 * order and the fork/conflict material must be identical; diagnostics must
 * surface rollback/future/jump as diagnostics only; ledger bytes and
 * `hashEvent` values must never change.
 *
 * Boundary: this is a locally injected virtual sampler. It is NOT a
 * cross-host clock rollback, does not modify the OS clock, and leaves
 * physical three-machine deployments unverified.
 */

interface PreparedEvent {
  readonly writerId: string;
  readonly nodeId: string;
  readonly taskId: string;
  readonly event: LedgerEvent;
  readonly hash: string;
}

interface Wrapped {
  readonly record: MultiWriterEntryRecord;
}

function ledgerDirectoryDigest(root: string): string {
  const dir = join(root, '.ano', 'ledger');
  const hash = createHash('sha256');
  const walk = (current: string, relative: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const rel = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(join(current, entry.name), rel);
        continue;
      }
      hash.update(rel);
      hash.update(readFileSync(join(current, entry.name)));
    }
  };
  walk(dir, '');
  return hash.digest('hex');
}

function replayEntries(root: string): readonly ViewReplayEntry[] {
  return replayLedger(join(root, '.ano', 'ledger')).entries;
}

async function commitBaselineEvents(nodes: readonly HaClockNode[]): Promise<readonly PreparedEvent[]> {
  const prepared: PreparedEvent[] = [];
  let taskSeq = 0;
  for (const node of nodes) {
    for (let index = 0; index < 3; index += 1) {
      taskSeq += 1;
      const taskId = `t140-${String(taskSeq).padStart(3, '0')}`;
      const fixture = await commitHaClockTask(node, taskId, `clock ${node.nodeId} #${String(index)}`);
      prepared.push({ writerId: node.writerId, nodeId: node.nodeId, taskId, event: fixture.event, hash: fixture.hash });
    }
  }
  return prepared;
}

function wrapPrepared(prepared: readonly PreparedEvent[], mutate: (nodeId: string, sample: number) => void, nodes: readonly HaClockNode[]): readonly Wrapped[] {
  const nodeByWriter = new Map(nodes.map((node) => [node.writerId, node]));
  const seqByWriter = new Map<string, number>();
  const wrapped: Wrapped[] = [];
  prepared.forEach((item, sample) => {
    const node = nodeByWriter.get(item.writerId)!;
    mutate(node.nodeId, sample);
    node.controller.tick();
    const seq = (seqByWriter.get(item.writerId) ?? 0) + 1;
    seqByWriter.set(item.writerId, seq);
    const writerEvent: MwhaWriterEvent = {
      schema_version: MWHA_EVENT_SCHEMA_VERSION,
      identity: { writer_id: item.writerId, epoch: 1, term: 1, local_seq: seq, ledger_event_hash: item.hash },
      leader: { term: 1, leader_id: 'leader-a', epoch: 1 },
    };
    const logEntry: MwhaClusterLogEntry = {
      schema_version: MWHA_CLUSTER_LOG_ENTRY_SCHEMA_VERSION,
      identity: writerEvent.identity,
      status: 'committed',
      leader: writerEvent.leader,
      commit_index: sample + 1,
      conflict_key: null,
    };
    wrapped.push({
      record: {
        entry: logEntry,
        ledgerEvent: item.event,
        ledgerEventHash: item.hash,
        evidenceId: null,
        delivery: 'fresh',
      },
    });
  });
  return wrapped;
}

test('injected rollback, future, jump and skew leave the projection identical and the ledger untouched', { timeout: 60_000 }, async (t) => {
  const nodes = await createHaClockCluster(t, [
    { nodeId: 'node-a', writerId: 'writer-a', startMs: 1_700_000_000_000, referenceMs: 1_700_000_000_000, epoch: 1, lease: { term: 1, leader_id: 'leader-a', epoch: 1 }, knownEpochs: [1] },
    { nodeId: 'node-b', writerId: 'writer-b', startMs: 1_700_000_000_000, referenceMs: 1_700_000_000_000, epoch: 1, lease: { term: 1, leader_id: 'leader-a', epoch: 1 }, knownEpochs: [1] },
    { nodeId: 'node-c', writerId: 'writer-c', startMs: 1_700_000_000_000, referenceMs: 1_700_000_000_000, epoch: 1, lease: { term: 1, leader_id: 'leader-a', epoch: 1 }, knownEpochs: [1] },
  ]);
  const prepared = await commitBaselineEvents(nodes);

  const ledgerDigestsBefore = nodes.map((node) => ledgerDirectoryDigest(node.root));
  const ledgerHashesBefore = nodes.map((node) => replayEntries(node.root).map((entry) => hashEvent(entry.event as LedgerEvent)));
  const ledgerViewsBefore = nodes.map((node) => viewDigest(replayEntries(node.root)));

  // Baseline: monotonic clock, no mutation; capture ordering and hash.
  const baselineWrapped = wrapPrepared(prepared, () => {}, nodes);
  const baselineProjection = projectMultiWriterState(baselineWrapped.map((item) => item.record), []);
  const baselineOrder = baselineProjection.entries.map((ref) => ref.identity.ledger_event_hash);
  assert.equal(baselineOrder.length, prepared.length);

  // Injected: node-a rollback -60s, node-b future +10min, node-c jump +2h,
  // all nodes skewed ±5s, and a -1ms rollback at sample 2.
  const nodeMutations: Record<string, (node: HaClockNode) => void> = {
    'node-a': (node) => node.controller.rollback(60_000),
    'node-b': (node) => node.controller.future(600_000),
    'node-c': (node) => node.controller.jump(7_200_000),
  };
  const skewByNode: Record<string, number> = { 'node-a': -5_000, 'node-b': 0, 'node-c': 5_000 };
  const nodeById = new Map(nodes.map((node) => [node.nodeId, node]));
  const injectedWrapped = wrapPrepared(prepared, (nodeId, sample) => {
    const node = nodeById.get(nodeId)!;
    node.controller.offset(skewByNode[nodeId] ?? 0);
    if (sample === 0) nodeMutations[nodeId]?.(node);
    if (sample === 2) node.controller.rollback(1);
  }, nodes);
  const injectedProjection = projectMultiWriterState(injectedWrapped.map((item) => item.record), []);

  assert.equal(injectedProjection.hash, baselineProjection.hash, 'projection hash must be identical under injected clock faults');
  assert.deepEqual(
    injectedProjection.entries.map((ref) => ref.identity.ledger_event_hash),
    baselineOrder,
    'committed order must be identical under injected clock faults',
  );
  assert.deepEqual(
    injectedProjection.states.map((state) => [state.conflict_key, state.status, state.winning_branch_id, state.branches.map((branch) => branch.ledger_event_hash), state.version_outcome]),
    baselineProjection.states.map((state) => [state.conflict_key, state.status, state.winning_branch_id, state.branches.map((branch) => branch.ledger_event_hash), state.version_outcome]),
    'slot status, branches and version outcome must be identical under injected clock faults',
  );;

  // Diagnostics surface the injected anomalies; they are marker records only.
  // `future` requires a reference sample: give every node one via a first
  // observe() of the shared reference before the mutations apply.
  const diagnosticKinds = new Set<string>();
  for (const node of nodes) {
    for (const record of node.controller.diagnostics()) {
      diagnosticKinds.add(record.diagnosis.kind);
      assert.equal(record.kind, record.diagnosis.kind);
    }
  }
  const reference = { physical: 1_700_000_000_000, logical: 0, nodeId: 'reference' };
  for (const node of nodes) node.controller.observe(reference);
  const futureVisible = nodes.some((node) => {
    // +20s sits above the 5s future tolerance but below the 60s jump
    // threshold, so it classifies as `future` rather than `jump`.
    node.controller.future(20_000);
    node.controller.tick();
    return node.controller.diagnostics().some((record) => record.diagnosis.kind === 'future');
  });
  assert.equal(futureVisible, true, 'expected a future diagnostic to be visible after a +20s sample with a reference');
  assert.ok(diagnosticKinds.has('rollback'), `expected a rollback diagnostic to be visible (kinds seen: ${[...diagnosticKinds].join(', ')})`);
  // A dedicated +2h sample classifies as `jump` (above the 60s threshold).
  const jumpVisible = nodes.some((node) => {
    node.controller.jump(7_200_000);
    node.controller.tick();
    return node.controller.diagnostics().some((record) => record.diagnosis.kind === 'jump');
  });
  assert.equal(jumpVisible, true, 'expected a jump diagnostic to be visible after a +2h sample');

  // HLC physical time must never rewind, even after a rollback sample.
  for (const node of nodes) {
    const before = node.controller.snapshot().physical;
    node.controller.rollback(10_000);
    node.controller.tick();
    assert.ok(node.controller.snapshot().physical >= before, 'HLC physical time must not rewind');
  }

  // Ledger bytes, event hashes and views unchanged after all injection.
  nodes.forEach((node, index) => {
    assert.equal(ledgerDirectoryDigest(node.root), ledgerDigestsBefore[index], 'ledger bytes must not change');
    assert.deepEqual(replayEntries(node.root).map((entry) => hashEvent(entry.event as LedgerEvent)), ledgerHashesBefore[index]);
    assert.equal(viewDigest(replayEntries(node.root)), ledgerViewsBefore[index]);
  });
  for (const item of prepared) {
    const node = nodes.find((entry) => entry.writerId === item.writerId)!;
    const found = replayEntries(node.root).some((entry) => hashEvent(entry.event as LedgerEvent) === item.hash);
    assert.equal(found, true, `committed event ${item.taskId} must still hash identically`);
  }

  // The boundary note must travel with the harness diagnostics.
  assert.equal(HA_CLOCK_DIAGNOSTIC_SCOPE_NOTE, `${HA_CLOCK_LOCAL_INJECTION_IS_NOT_CROSS_HOST}；${HA_CLOCK_DOES_NOT_CHANGE_SYSTEM_CLOCK}；${HA_CLOCK_CROSS_HOST_UNVERIFIED}`);
});

test('extreme and malformed wall-clock values never participate in ordering', () => {
  // Wall-clock keys inside an ordering-key object are refused outright
  // (the frozen vocabulary matches clock/time/now/timestamp/observedat...).
  assert.throws(() => assertLogicalOnlyOrdering([{ epoch: 1, observedAt: 1 }]), /WALL_CLOCK_FORBIDDEN/u);
  assert.throws(() => assertLogicalOnlyOrdering([{ epoch: 1, timestamp: 1 }]), /WALL_CLOCK_FORBIDDEN/u);
  assert.throws(() => assertLogicalOnlyOrdering([{ epoch: 1, now: 1 }]), /WALL_CLOCK_FORBIDDEN/u);
  assert.equal(containsWallClockKey({ epoch: 1, commit_index: 1, writer_id: 'a', local_seq: 1 }), false);
  assert.doesNotThrow(() => assertLogicalOnlyOrdering([{ epoch: 1, commit_index: 1, writer_id: 'a', local_seq: 1 }]));
});

void (undefined as unknown as TestContext | undefined);
