import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HaProtocolError,
  MWHA_CLOCK_DEFAULT_POLICY,
  compareLogicalVersion,
  containsWallClockKey,
  type MwhaEventIdentity,
  type MwhaLogicalVersion,
} from '../../src/memory/ha-protocol.ts';
import {
  LOGICAL_CLOCK_MAX_DIAGNOSTICS,
  LogicalClockService,
  assertLogicalOnlyOrdering,
  compareLogicalEntries,
  replayOrder,
  replayProjection,
  versionOf,
  type LogicalClockSnapshot,
  type ReplayableEntry,
} from '../../src/memory/logical-clock.ts';
import {
  projectMultiWriterState,
  type MultiWriterAdjudicationRecord,
  type MultiWriterEntryRecord,
} from '../../src/memory/multi-writer.ts';

/**
 * T-137 unit tests: HLC-style logical clock monotonicity, remote merge,
 * rollback/future/jump/skew diagnosis at threshold boundaries, the explicit
 * wall-clock-key refusal and the fact that diagnostics never influence
 * version order or replay.
 *
 * Boundary: these tests inject a virtual clock into one process. That models
 * an arbitrary *sample sequence*; it is NOT a cross-host clock rollback and
 * does not modify the OS clock.
 */

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);

interface TestClock {
  t: number;
  now: () => number;
  set(value: number): void;
  advance(ms: number): void;
}

function makeClock(start = 0): TestClock {
  const clock: TestClock = {
    t: start,
    now: () => clock.t,
    set: (value) => { clock.t = value; },
    advance: (ms) => { clock.t += ms; },
  };
  return clock;
}

function identity(writerId: string, epoch: number, localSeq: number, hash = HASH_A): MwhaEventIdentity {
  return { writer_id: writerId, epoch, term: 1, local_seq: localSeq, ledger_event_hash: hash };
}

function entry(writerId: string, epoch: number, commitIndex: number, localSeq: number, hash = HASH_A): ReplayableEntry {
  return { identity: identity(writerId, epoch, localSeq, hash), commit_index: commitIndex };
}

function isHaError(error: unknown, code: string): boolean {
  return error instanceof HaProtocolError && error.code === code;
}

// ---------------------------------------------------------------------------
// HLC tick / observe
// ---------------------------------------------------------------------------

test('HLC tick keeps physical time monotone and increments logical at equal physical', { timeout: 60_000 }, () => {
  const clock = makeClock(1_000);
  const service = new LogicalClockService({ nodeId: 'node-a', now: clock.now });

  const first = service.tick();
  assert.deepEqual(first, { physical: 1_000, logical: 0, nodeId: 'node-a' });
  // Same physical sample: logical increments, physical never moves.
  assert.deepEqual(service.tick(), { physical: 1_000, logical: 1, nodeId: 'node-a' });
  assert.deepEqual(service.tick(), { physical: 1_000, logical: 2, nodeId: 'node-a' });

  clock.advance(500);
  assert.deepEqual(service.tick(), { physical: 1_500, logical: 0, nodeId: 'node-a' });
});

test('a backwards local sample is diagnosed but cannot rewind physical time', { timeout: 60_000 }, () => {
  const clock = makeClock(5_000);
  const service = new LogicalClockService({ nodeId: 'node-a', now: clock.now });
  service.tick();

  clock.set(4_000); // simulated rollback
  const rolledBack = service.tick();
  assert.equal(rolledBack.physical, 5_000, 'physical must stay at the highest observed sample');
  assert.equal(rolledBack.logical, 1, 'a rolled-back sample consumes logical space');

  const kinds = service.diagnostics().map((record) => record.kind);
  assert.equal(kinds[0], 'unknown');
  assert.equal(kinds[1], 'rollback');
});

test('observe merges a leading remote clock and increments logical on a physical tie', { timeout: 60_000 }, () => {
  const clock = makeClock(1_000);
  const service = new LogicalClockService({ nodeId: 'node-a', now: clock.now });
  service.tick(); // (1000, 0)

  const leading: LogicalClockSnapshot = { physical: 2_000, logical: 5, nodeId: 'node-b' };
  assert.deepEqual(service.observe(leading), { physical: 2_000, logical: 6, nodeId: 'node-a' });

  const tieLower: LogicalClockSnapshot = { physical: 2_000, logical: 9, nodeId: 'node-b' };
  assert.deepEqual(service.observe(tieLower), { physical: 2_000, logical: 10, nodeId: 'node-a' });

  const behind: LogicalClockSnapshot = { physical: 1_500, logical: 99, nodeId: 'node-b' };
  assert.deepEqual(service.observe(behind), { physical: 2_000, logical: 11, nodeId: 'node-a' });
});

test('observe never rewinds physical time after a remote backwards sample', { timeout: 60_000 }, () => {
  const service = new LogicalClockService({ nodeId: 'node-a', now: () => 5_000 });
  service.tick();
  const snapshot = service.observe({ physical: 1_000, logical: 0, nodeId: 'node-b' });
  assert.equal(snapshot.physical, 5_000);
  assert.equal(snapshot.logical, 1);
});

// ---------------------------------------------------------------------------
// Diagnosis classification and threshold boundaries
// ---------------------------------------------------------------------------

test('diagnosis classifies rollback, jump, future, skew, normal and unknown', { timeout: 60_000 }, () => {
  const skewService = new LogicalClockService({
    nodeId: 'node-a',
    now: () => 0,
    policy: { skewToleranceMs: 100, futureToleranceMs: 10_000, jumpThresholdMs: 10_000 },
  });
  const futureService = new LogicalClockService({
    nodeId: 'node-a',
    now: () => 0,
    policy: { skewToleranceMs: 10_000, futureToleranceMs: 200, jumpThresholdMs: 10_000 },
  });

  const classify = (observation: Parameters<LogicalClockService['diagnose']>[0]) => skewService.diagnose(observation).kind;
  const classifyFuture = (observedMs: number) =>
    futureService.diagnose({ member_id: 'node-a', epoch: 0, observed_ms: observedMs, previous_observed_ms: null, reference_ms: 1_000 }).kind;

  assert.equal(classify({ member_id: 'node-a', epoch: 0, observed_ms: 999, previous_observed_ms: 1_000, reference_ms: null }), 'rollback');
  assert.equal(classify({ member_id: 'node-a', epoch: 0, observed_ms: 1_000, previous_observed_ms: 1_000, reference_ms: 1_000 }), 'normal');
  // skew exactly at tolerance stays normal; tolerance + 1 is skew.
  assert.equal(classify({ member_id: 'node-a', epoch: 0, observed_ms: 900, previous_observed_ms: null, reference_ms: 1_000 }), 'normal');
  assert.equal(classify({ member_id: 'node-a', epoch: 0, observed_ms: 899, previous_observed_ms: null, reference_ms: 1_000 }), 'skew');
  // future exactly at tolerance stays normal; tolerance + 1 is future.
  assert.equal(classifyFuture(1_200), 'normal');
  assert.equal(classifyFuture(1_201), 'future');
  // rollback wins over jump when both conditions hold (fixed precedence).
  assert.equal(classify({ member_id: 'node-a', epoch: 0, observed_ms: 0, previous_observed_ms: 1_000, reference_ms: 50_000 }), 'rollback');
  assert.equal(classify({ member_id: 'node-a', epoch: 0, observed_ms: 1_000, previous_observed_ms: null, reference_ms: null }), 'unknown');
});

test('jump classification uses the strict threshold boundary', { timeout: 60_000 }, () => {
  const service = new LogicalClockService({
    nodeId: 'node-a',
    now: () => 0,
    policy: { skewToleranceMs: 10_000, futureToleranceMs: 10_000, jumpThresholdMs: 500 },
  });
  const classify = (observedMs: number, previous: number | null, reference: number | null) =>
    service.diagnose({ member_id: 'node-a', epoch: 0, observed_ms: observedMs, previous_observed_ms: previous, reference_ms: reference }).kind;

  assert.equal(classify(1_499, 1_000, 1_000), 'normal');
  assert.equal(classify(1_500, 1_000, 1_000), 'normal', 'delta == jump threshold is not a jump');
  assert.equal(classify(1_501, 1_000, 1_000), 'jump', 'delta > jump threshold is a jump');
  assert.equal(classify(2_000, 1_000, null), 'jump', 'previous sample can also reveal a jump');
});

test('every diagnosis carries the diagnostic-only flags', { timeout: 60_000 }, () => {
  const clock = makeClock(1_000);
  const service = new LogicalClockService({ nodeId: 'node-a', now: clock.now });
  service.tick();
  clock.set(10); // rollback marker
  service.tick();

  const records = service.diagnostics();
  assert.ok(records.length >= 2);
  for (const record of records) {
    assert.equal(record.diagnosis.diagnostic_only, true);
    assert.equal(record.diagnosis.affects_commit_order, false);
    assert.equal(record.diagnosis.affects_fact_version, false);
    assert.ok(record.sequence >= 1);
  }
});

test('diagnose is read-only and the diagnostic buffer is bounded', { timeout: 60_000 }, () => {
  const clock = makeClock(0);
  const service = new LogicalClockService({ nodeId: 'node-a', now: clock.now });
  const before = service.diagnostics().length;
  service.diagnose({ member_id: 'node-a', epoch: 0, observed_ms: 1, previous_observed_ms: 0, reference_ms: 0 });
  assert.equal(service.diagnostics().length, before, 'diagnose() must not append to the diagnostic log');

  for (let index = 0; index < LOGICAL_CLOCK_MAX_DIAGNOSTICS + 10; index += 1) {
    clock.advance(1);
    service.tick();
  }
  assert.equal(service.diagnostics().length, LOGICAL_CLOCK_MAX_DIAGNOSTICS);
  const sequences = service.diagnostics().map((record) => record.sequence);
  const monotonic = sequences.every((sequence, index) => index === 0 || sequence === sequences[index - 1]! + 1);
  assert.equal(monotonic, true);
});

// ---------------------------------------------------------------------------
// Wall-clock refusal and version ordering
// ---------------------------------------------------------------------------

test('assertLogicalOnlyOrdering refuses wall-clock keys and accepts logical keys', { timeout: 60_000 }, () => {
  const clean = { epoch: 1, commit_index: 2, writer_id: 'w1', local_seq: 3 };
  assert.doesNotThrow(() => assertLogicalOnlyOrdering(clean));
  assert.doesNotThrow(() => assertLogicalOnlyOrdering([clean, { ...clean, epoch: 2 }]));

  const offenders = [
    { ...clean, timestamp: 1_000 },
    { ...clean, wall_clock: 1_000 },
    { ...clean, createdAt: '2026-01-01T00:00:00Z' },
    { ...clean, 'recorded-at': 1_000 },
  ];
  for (const offender of offenders) {
    assert.ok(containsWallClockKey(offender));
    assert.throws(() => assertLogicalOnlyOrdering(offender), (error: unknown) => isHaError(error, 'WALL_CLOCK_FORBIDDEN'));
    assert.throws(() => assertLogicalOnlyOrdering([clean, offender]), (error: unknown) => isHaError(error, 'WALL_CLOCK_FORBIDDEN'));
  }

  assert.throws(() => assertLogicalOnlyOrdering([null as unknown as Record<string, unknown>]), (error: unknown) => isHaError(error, 'HA_INPUT_INVALID'));
});

test('versionOf and compareLogicalEntries read only the four logical fields', { timeout: 60_000 }, () => {
  const base = entry('w1', 1, 10, 1, HASH_A);
  const same = entry('w1', 1, 10, 1, HASH_A);
  assert.deepEqual(versionOf(base), { epoch: 1, commit_index: 10, writer_id: 'w1', local_seq: 1 });
  assert.equal(compareLogicalEntries(base, same), 0);
  assert.equal(compareLogicalEntries(entry('w1', 1, 11, 1), base), 1);
  assert.equal(compareLogicalEntries(entry('w1', 0, 99, 1), base), -1);
  assert.equal(compareLogicalEntries(entry('w1', 0, 99, 1), base), -1);
  assert.equal(compareLogicalEntries(entry('w0', 1, 10, 1), base), -1);
});

test('extreme wall-clock values never change the logical comparison', { timeout: 60_000 }, () => {
  const left: MwhaLogicalVersion & Record<string, unknown> = {
    epoch: 7, commit_index: 12, writer_id: 'w1', local_seq: 4, timestamp: Number.MAX_SAFE_INTEGER,
  };
  const right: MwhaLogicalVersion & Record<string, unknown> = {
    epoch: 7, commit_index: 12, writer_id: 'w1', local_seq: 4, timestamp: -Number.MAX_SAFE_INTEGER,
  };
  assert.equal(compareLogicalVersion(left, right), 0);
  const withWallClock = { ...right, wall_clock: 0 } as MwhaLogicalVersion;
  const withCreatedAt = { ...left, created_at: Number.MIN_SAFE_INTEGER } as MwhaLogicalVersion;
  assert.equal(compareLogicalVersion(left, withWallClock), 0);
  assert.equal(compareLogicalVersion(withCreatedAt, right), 0);

  const older: MwhaLogicalVersion = { epoch: 7, commit_index: 11, writer_id: 'w1', local_seq: 4 };
  assert.equal(compareLogicalVersion(left, older), 1);
});

test('replayOrder is deterministic, hash-tie break included, and ignores extra time fields', { timeout: 60_000 }, () => {
  const entries = [
    entry('w2', 1, 1, 1, HASH_B),
    entry('w1', 2, 5, 2, HASH_A),
    entry('w1', 1, 5, 1, HASH_A),
    entry('w1', 1, 5, 1, HASH_C), // same version as previous, different hash
    entry('w1', 1, 4, 9, HASH_A),
  ] as unknown as ReadonlyArray<ReplayableEntry & Record<string, unknown>>;

  const expected = [...entries]
    .sort((left, right) => {
      const order = compareLogicalVersion(versionOf(left), versionOf(right));
      if (order !== 0) return order;
      return left.identity.ledger_event_hash < right.identity.ledger_event_hash ? -1 : 1;
    })
    .map((item) => item.identity.ledger_event_hash);

  const withTime = entries.map((item, index) => ({ ...item, timestamp: index * 1_000_000 }));
  assert.deepEqual(replayOrder(withTime).map((item) => item.identity.ledger_event_hash), expected);

  const shuffled = [...entries].reverse();
  assert.deepEqual(replayOrder(shuffled).map((item) => item.identity.ledger_event_hash), expected);
});

// ---------------------------------------------------------------------------
// Time-series independence
// ---------------------------------------------------------------------------

function makeRecord(item: ReplayableEntry): MultiWriterEntryRecord {
  return {
    entry: {
      schema_version: 'mwha.cluster-log-entry.v1',
      identity: item.identity,
      status: 'committed',
      leader: { term: 1, leader_id: 'leader-a', epoch: item.identity.epoch },
      commit_index: item.commit_index,
      conflict_key: null,
    },
    ledgerEvent: {
      id: '00000000000000000000000001',
      hlc: { physical: item.commit_index, logical: 0, actor: 'writer' },
      actor: 'writer',
      kind: 'note.recorded',
      payload: { note_id: HASH_A, kind: 'memory', text: 'x', created_at: '2026-01-01T00:00:00.000Z' },
      prev_hash: '0'.repeat(64),
    },
    ledgerEventHash: item.identity.ledger_event_hash,
    evidenceId: null,
    delivery: 'fresh',
  };
}

test('the same entry set replays identically under arbitrary physical time series', { timeout: 60_000 }, () => {
  const items = [
    entry('w1', 1, 1, 1, HASH_A),
    entry('w1', 1, 2, 2, HASH_B),
    entry('w2', 1, 3, 1, HASH_C),
    entry('w2', 2, 4, 1, HASH_A),
    entry('w3', 1, 5, 1, HASH_B),
  ];

  const monotonic = new LogicalClockService({ nodeId: 'node-base', now: makeClock(1_000).now });
  const adversarial = new LogicalClockService({ nodeId: 'node-inject', now: makeClock(9_000_000).now });

  const baselineOrder = replayOrder(items).map((item) => `${item.identity.writer_id}:${item.identity.local_seq}`);
  const baselineHash = replayProjection(items.map(makeRecord)).hash;

  // Drive both clocks through a permutation of forward, backward, equal and
  // far-future samples between the same replay calls.
  const series = [1_000, -500, -500, 10_000_000, 9_999, 9_999, 7_000_000, 0, 8_000_000];
  for (const sample of series) {
    monotonic.tick();
    adversarial.observe({ physical: sample, logical: 0, nodeId: 'remote' });
  }
  assert.ok(adversarial.diagnostics().some((record) => record.kind === 'rollback'));

  assert.deepEqual(replayOrder(items).map((item) => `${item.identity.writer_id}:${item.identity.local_seq}`), baselineOrder);
  assert.equal(replayProjection(items.map(makeRecord)).hash, baselineHash);
  assert.equal(projectMultiWriterState(items.map(makeRecord)).hash, baselineHash);
});

test('projection hash is invariant across shuffled arrival order', { timeout: 60_000 }, () => {
  const records = [
    makeRecord(entry('w1', 1, 1, 1, HASH_A)),
    makeRecord(entry('w1', 1, 2, 2, HASH_B)),
    makeRecord(entry('w2', 1, 3, 1, HASH_C)),
  ];
  const forward = replayProjection(records).hash;
  const reverse = replayProjection([...records].reverse()).hash;
  const shuffled = replayProjection([records[1]!, records[2]!, records[0]!]).hash;
  assert.equal(forward, reverse);
  assert.equal(forward, shuffled);
});

test('service options fail closed on malformed input', { timeout: 60_000 }, () => {
  assert.throws(() => new LogicalClockService({ nodeId: '', now: () => 0 }), (error: unknown) => isHaError(error, 'HA_INPUT_INVALID'));
  assert.throws(() => new LogicalClockService({ nodeId: 'node-a', now: 'not-a-function' as unknown as () => number }), (error: unknown) => isHaError(error, 'HA_INPUT_INVALID'));
  assert.throws(() => new LogicalClockService({ nodeId: 'node-a', now: () => Number.NaN }).tick(), (error: unknown) => isHaError(error, 'HA_INPUT_INVALID'));
  assert.throws(
    () => new LogicalClockService({ nodeId: 'node-a', now: () => 0 }).observe({ physical: Number.POSITIVE_INFINITY, logical: 0, nodeId: 'node-b' }),
    (error: unknown) => isHaError(error, 'HA_INPUT_INVALID'),
  );
});

test('default clock policy constants stay wired to the frozen contract', { timeout: 60_000 }, () => {
  const service = new LogicalClockService({ nodeId: 'node-a', now: () => 0 });
  assert.equal(service.policy.skewToleranceMs, MWHA_CLOCK_DEFAULT_POLICY.skewToleranceMs);
  assert.equal(service.policy.futureToleranceMs, MWHA_CLOCK_DEFAULT_POLICY.futureToleranceMs);
  assert.equal(service.policy.jumpThresholdMs, MWHA_CLOCK_DEFAULT_POLICY.jumpThresholdMs);
  assert.deepEqual(service.snapshot(), { physical: 0, logical: 0, nodeId: 'node-a' });
});

test('adjudicated replay material still projects deterministically', { timeout: 60_000 }, () => {
  const records = [
    makeRecord(entry('w1', 1, 1, 1, HASH_A)),
    makeRecord(entry('w1', 1, 2, 1, HASH_B)), // fork branch at (w1, epoch 1, seq 1)
  ];
  const adjudication: MultiWriterAdjudicationRecord = {
    adjudication: {
      schema_version: 'mwha.adjudication.v1',
      conflict_key: { writer_id: 'w1', epoch: 1, local_seq: 1 },
      branches: [
        { branch_id: `branch-${HASH_A.slice(0, 16)}`, identity: identity('w1', 1, 1, HASH_A), ledger_event_hash: HASH_A },
        { branch_id: `branch-${HASH_B.slice(0, 16)}`, identity: identity('w1', 1, 1, HASH_B), ledger_event_hash: HASH_B },
      ],
      branch_hashes: [HASH_A, HASH_B],
      status: 'resolved',
      selected_branch_id: `branch-${HASH_A.slice(0, 16)}`,
      resolution_reason: 'deterministic replay test selection',
    },
    conflict_key: { writer_id: 'w1', epoch: 1, local_seq: 1 },
    branches: [
      { branch_id: `branch-${HASH_A.slice(0, 16)}`, identity: identity('w1', 1, 1, HASH_A), ledger_event_hash: HASH_A },
      { branch_id: `branch-${HASH_B.slice(0, 16)}`, identity: identity('w1', 1, 1, HASH_B), ledger_event_hash: HASH_B },
    ],
    evidenceId: null,
  };
  assert.equal(replayProjection(records, [adjudication]).hash, replayProjection([...records].reverse(), [adjudication]).hash);
});
