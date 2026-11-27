/**
 * T-151 / QF-02 complete input x state x error matrix for
 * `src/memory/logical-clock.ts`.
 *
 * Scope notes:
 * - every assertion is about an observable result (snapshot value, thrown
 *   error code/message, diagnostic record, ordering output) or an observable
 *   side effect (buffer length, diagnostic append count); no empty calls are
 *   used to accumulate coverage;
 * - the `MAX_SAFE_INTEGER` cases encode the frozen invariant that a logical
 *   counter must stay a safe integer: an observation that would cross the
 *   boundary is refused without mutating the clock, and the last legal value
 *   (`MAX_SAFE_INTEGER`) is only reachable one step below it;
 * - all three `observe` merge arms are exercised; the source's third arm is
 *   the remote-ahead case (both physical values are safe integers, so
 *   `Math.max` always equals one of them).
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HaProtocolError,
  MWHA_CLOCK_DEFAULT_POLICY,
  type MwhaEventIdentity,
} from '../../src/memory/ha-protocol.ts';
import {
  LOGICAL_CLOCK_MAX_DIAGNOSTICS,
  LOGICAL_CLOCK_SCHEMA_VERSION,
  LogicalClockService,
  assertLogicalOnlyOrdering,
  compareLogicalEntries,
  replayOrder,
  replayProjection,
  versionOf,
  type LogicalClockSnapshot,
  type ReplayableEntry,
} from '../../src/memory/logical-clock.ts';
import type { MultiWriterEntryRecord } from '../../src/memory/multi-writer.ts';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);

interface TestClock {
  t: number;
  now: () => number;
  set(value: number): void;
}

/** Mutable injected clock so tests never wait on wall time. */
function clock(start = 0): TestClock {
  const state = { t: start };
  return {
    t: state.t,
    now: () => state.t,
    set: (value: number) => { state.t = value; },
  };
}

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

function identity(writerId: string, epoch: number, localSeq: number, hash = HASH_A): MwhaEventIdentity {
  return { writer_id: writerId, epoch, term: 1, local_seq: localSeq, ledger_event_hash: hash };
}

function entry(writerId: string, epoch: number, commitIndex: number, localSeq: number, hash = HASH_A): ReplayableEntry {
  return { identity: identity(writerId, epoch, localSeq, hash), commit_index: commitIndex };
}

function isHaError(error: unknown, code: string): boolean {
  return error instanceof HaProtocolError && error.code === code;
}

function assertHaCode(run: () => unknown, code: string): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof HaProtocolError, `expected HaProtocolError, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Module constants
// ---------------------------------------------------------------------------

test('logical-clock module exposes the frozen schema version and diagnostic bound', () => {
  assert.equal(LOGICAL_CLOCK_SCHEMA_VERSION, 'mwha.logical-clock.v1');
  assert.equal(LOGICAL_CLOCK_MAX_DIAGNOSTICS, 256);
});

// ---------------------------------------------------------------------------
// Constructor validation matrix
// ---------------------------------------------------------------------------

test('constructor fails closed on non-object options and malformed members', () => {
  for (const options of [null, [], 42, 'options', true]) {
    assertHaCode(
      () => new LogicalClockService(options as never),
      'HA_INPUT_INVALID',
    );
  }

  // nodeId validation lives behind parseNodeId.
  for (const nodeId of ['', 'bad id', ' leading', 'node/a', '.node', 7, null, {}]) {
    assertHaCode(
      () => new LogicalClockService({ nodeId: nodeId as never }),
      'HA_INPUT_INVALID',
    );
  }
  // A bounded, well-formed identifier is accepted.
  const accepted = new LogicalClockService({ nodeId: 'node-a.1_x:y-z' });
  assert.equal(accepted.nodeId, 'node-a.1_x:y-z');

  // now must be callable when supplied.
  for (const now of ['not-a-function', {}, 1]) {
    assertHaCode(
      () => new LogicalClockService({ nodeId: 'node-a', now: now as unknown as () => number }),
      'HA_INPUT_INVALID',
    );
  }

  // epoch must be a safe nonnegative integer.
  for (const epoch of [1.5, Number.NaN, Number.POSITIVE_INFINITY, '1']) {
    assertHaCode(
      () => new LogicalClockService({ nodeId: 'node-a', epoch: epoch as unknown as number }),
      'HA_INPUT_INVALID',
    );
  }
  assertHaCode(() => new LogicalClockService({ nodeId: 'node-a', epoch: -1 }), 'HA_INPUT_INVALID');
  assert.equal(new LogicalClockService({ nodeId: 'node-a', epoch: 0 }).epoch, 0);

  // referenceMs: omitted/null mean "unknown"; supplied values must be safe integers.
  for (const referenceMs of [1.5, Number.NaN, Number.POSITIVE_INFINITY, '1']) {
    assertHaCode(
      () => new LogicalClockService({ nodeId: 'node-a', referenceMs: referenceMs as unknown as number }),
      'HA_INPUT_INVALID',
    );
  }
  assert.doesNotThrow(() => new LogicalClockService({ nodeId: 'node-a', referenceMs: null }));
  assert.doesNotThrow(() => new LogicalClockService({ nodeId: 'node-a', referenceMs: 1_000 }));
});

test('constructor defaults are Date.now, epoch 0, the frozen policy and null reference', () => {
  const realNow = Date.now;
  let sampled = 5_000;
  (Date as unknown as { now: () => number }).now = () => sampled;
  try {
    const service = new LogicalClockService({ nodeId: 'node-a' });
    assert.deepEqual(service.tick(), { physical: 5_000, logical: 0, nodeId: 'node-a' });
    sampled = 6_000;
    assert.deepEqual(service.tick(), { physical: 6_000, logical: 0, nodeId: 'node-a' });
    assert.equal(service.epoch, 0);
    assert.deepEqual(service.policy, MWHA_CLOCK_DEFAULT_POLICY);
    const records = service.diagnostics();
    assert.equal(records.at(-1)?.reference_ms ?? null, null);
  } finally {
    (Date as unknown as { now: () => number }).now = realNow;
  }

  const customPolicy = { skewToleranceMs: 1, futureToleranceMs: 1, jumpThresholdMs: 1 };
  const custom = new LogicalClockService({ nodeId: 'node-a', epoch: 7, policy: customPolicy });
  assert.equal(custom.epoch, 7);
  assert.equal(custom.policy, customPolicy);
});

test('nodeId/epoch/policy getters return exactly the constructed values', () => {
  const policy = { skewToleranceMs: 5, futureToleranceMs: 6, jumpThresholdMs: 7 };
  const service = new LogicalClockService({ nodeId: 'node-z', epoch: 3, policy, referenceMs: 99 });
  assert.equal(service.nodeId, 'node-z');
  assert.equal(service.epoch, 3);
  assert.equal(service.policy, policy);
  // Reference is observable through diagnostics, not through a dedicated getter.
  service.tick();
  assert.equal(service.diagnostics().at(-1)?.reference_ms, 99);
});

// ---------------------------------------------------------------------------
// observe() input matrix (parseRemoteSnapshot)
// ---------------------------------------------------------------------------

test('observe rejects null/array/non-object snapshots with HA_INPUT_INVALID', () => {
  const service = new LogicalClockService({ nodeId: 'node-a', now: () => 0 });
  for (const remote of [null, [], 42, 'snapshot', undefined]) {
    assertHaCode(
      () => service.observe(remote as never),
      'HA_INPUT_INVALID',
    );
  }
});

test('observe rejects unsafe physical/logical and missing/empty/non-string nodeId', () => {
  const service = new LogicalClockService({ nodeId: 'node-a', now: () => 0 });
  const before = service.snapshot();

  for (const physical of [Number.POSITIVE_INFINITY, Number.NaN, 1.5, '1', null]) {
    assertHaCode(
      () => service.observe({ physical: physical as never, logical: 0, nodeId: 'remote' }),
      'HA_INPUT_INVALID',
    );
  }
  for (const logical of [Number.POSITIVE_INFINITY, Number.NaN, 1.5, '1', null]) {
    assertHaCode(
      () => service.observe({ physical: 1, logical: logical as never, nodeId: 'remote' }),
      'HA_INPUT_INVALID',
    );
  }
  for (const nodeId of [undefined, null, '', 42, {}]) {
    assertHaCode(
      () => service.observe({ physical: 1, logical: 0, nodeId: nodeId as never }),
      'HA_INPUT_INVALID',
    );
  }
  assert.deepEqual(service.snapshot(), before);
  assert.equal(service.diagnostics().length, 0, 'rejected observations must not append diagnostics');
});

// ---------------------------------------------------------------------------
// MAX_SAFE_INTEGER invariant (T-151 red target)
// ---------------------------------------------------------------------------

test('a remote logical at MAX_SAFE_INTEGER is refused without mutating the clock', () => {
  const service = new LogicalClockService({ nodeId: 'node-a', now: () => 1_000 });
  const baseline = service.tick();
  assert.deepEqual(baseline, { physical: 1_000, logical: 0, nodeId: 'node-a' });
  const diagnosticCount = service.diagnostics().length;

  // Physical tie and remote-ahead are the two merge paths that would raise the
  // local logical part; both must refuse rather than emit an unsafe integer.
  const remotes: readonly LogicalClockSnapshot[] = [
    { physical: 1_000, logical: Number.MAX_SAFE_INTEGER, nodeId: 'remote' },
    { physical: 2_000, logical: Number.MAX_SAFE_INTEGER, nodeId: 'remote' },
  ];
  for (const remote of remotes) {
    assert.throws(
      () => service.observe(remote),
      (error: unknown) => isHaError(error, 'HA_INPUT_INVALID') && /MAX_SAFE_INTEGER/u.test(String(error)),
    );
    assert.deepEqual(service.snapshot(), baseline, 'a refused observation must not move the clock');
    assert.equal(service.diagnostics().length, diagnosticCount, 'a refused observation must not append diagnostics');
  }
});

test('a remote logical of MAX_SAFE_INTEGER - 1 reaches MAX and the next increment refuses', () => {
  for (const remotePhysical of [1_000, 2_000]) {
    const service = new LogicalClockService({ nodeId: 'node-a', now: () => 1_000 });
    service.tick();

    const merged = service.observe({
      physical: remotePhysical,
      logical: Number.MAX_SAFE_INTEGER - 1,
      nodeId: 'remote',
    });
    assert.equal(merged.logical, Number.MAX_SAFE_INTEGER);
    assert.ok(Number.isSafeInteger(merged.logical), 'merged logical must remain a safe integer');

    const before = service.snapshot();
    const diagnosticCount = service.diagnostics().length;
    // The next increment has no safe value left; it must fail closed and leave
    // the clock untouched instead of wrapping past Number.MAX_SAFE_INTEGER.
    assertHaCode(() => service.tick(), 'HA_INPUT_INVALID');
    assert.deepEqual(service.snapshot(), before);
    assert.equal(service.diagnostics().length, diagnosticCount);
  }
});

// ---------------------------------------------------------------------------
// tick()/observe() arithmetic and diagnostics
// ---------------------------------------------------------------------------

test('tick samples the injected clock and increments logical on an equal or backwards sample', () => {
  const injected = clock(1_000);
  const service = new LogicalClockService({ nodeId: 'node-a', now: injected.now });
  assert.deepEqual(service.tick(), { physical: 1_000, logical: 0, nodeId: 'node-a' });
  // Equal sample: logical advances, physical never repeats a lower value.
  assert.deepEqual(service.tick(), { physical: 1_000, logical: 1, nodeId: 'node-a' });
  // Forward sample resets the logical part.
  injected.set(4_000);
  assert.deepEqual(service.tick(), { physical: 4_000, logical: 0, nodeId: 'node-a' });
  // Backwards sample is diagnosed but cannot rewind physical time.
  injected.set(1_000);
  assert.deepEqual(service.tick(), { physical: 4_000, logical: 1, nodeId: 'node-a' });
});

test('tick rejects unsafe now() samples without mutating the clock', () => {
  for (const sample of [Number.NaN, 1.5, Number.POSITIVE_INFINITY, '1', null]) {
    const service = new LogicalClockService({ nodeId: 'node-a', now: () => sample as never });
    assertHaCode(() => service.tick(), 'HA_INPUT_INVALID');
    assert.deepEqual(service.snapshot(), { physical: 0, logical: 0, nodeId: 'node-a' });
    assert.equal(service.diagnostics().length, 0);
  }
});

test('observe exercises the reachable HLC arms: tie, local-ahead and remote-ahead', () => {
  // Tie: both physical parts equal -> max(logical, remote) + 1.
  const tie = new LogicalClockService({ nodeId: 'node-a', now: () => 1_000 });
  tie.tick();
  assert.deepEqual(tie.observe({ physical: 1_000, logical: 5, nodeId: 'remote' }), {
    physical: 1_000,
    logical: 6,
    nodeId: 'node-a',
  });

  // Local ahead: local physical wins -> increment local logical.
  const localAhead = new LogicalClockService({ nodeId: 'node-a', now: () => 1_000 });
  localAhead.tick();
  localAhead.tick();
  localAhead.tick();
  assert.deepEqual(localAhead.observe({ physical: 900, logical: 99, nodeId: 'remote' }), {
    physical: 1_000,
    logical: 3,
    nodeId: 'node-a',
  });

  // Remote ahead: remote physical wins -> remote logical + 1.
  const remoteAhead = new LogicalClockService({ nodeId: 'node-a', now: () => 1_000 });
  remoteAhead.tick();
  remoteAhead.tick();
  assert.deepEqual(remoteAhead.observe({ physical: 2_000, logical: 7, nodeId: 'remote' }), {
    physical: 2_000,
    logical: 8,
    nodeId: 'node-a',
  });
});

test('diagnostics record source, samples, sequence and reference, and are defensive copies', () => {
  const injected = clock(1_000);
  const service = new LogicalClockService({
    nodeId: 'node-a',
    now: injected.now,
    epoch: 4,
    referenceMs: 500,
  });
  service.tick();
  injected.set(2_000);
  service.tick();
  service.observe({ physical: 2_000, logical: 3, nodeId: 'remote' });

  const records = service.diagnostics();
  assert.equal(records.length, 3);
  assert.deepEqual(
    records.map((record) => [record.sequence, record.source, record.observed_ms, record.previous_observed_ms]),
    [
      [1, 'tick', 1_000, null],
      [2, 'tick', 2_000, 1_000],
      [3, 'observe', 2_000, 2_000],
    ],
  );
  for (const record of records) {
    assert.equal(record.reference_ms, 500);
    assert.equal(record.diagnosis.diagnostic_only, true);
    assert.equal(record.diagnosis.affects_commit_order, false);
    assert.equal(record.diagnosis.affects_fact_version, false);
  }

  // Mutating the returned view (including its nested diagnosis) must not touch
  // the service, and pushing into the returned array must not grow the buffer.
  const view = service.diagnostics();
  const lengthBefore = view.length;
  (view as unknown as unknown[]).push({});
  assert.equal(service.diagnostics().length, lengthBefore);
  const nested = service.diagnostics()[0]!;
  (nested.diagnosis as { kind: string }).kind = 'rollback';
  assert.notEqual(service.diagnostics()[0]!.diagnosis.kind, 'rollback');
});

test('the diagnostic ring evicts the oldest records beyond the bound', () => {
  const injected = clock(0);
  const service = new LogicalClockService({ nodeId: 'node-a', now: injected.now });
  service.tick();
  const total = LOGICAL_CLOCK_MAX_DIAGNOSTICS + 5;
  for (let index = 1; index <= total; index += 1) {
    injected.set(index);
    service.tick();
  }
  const records = service.diagnostics();
  assert.equal(records.length, LOGICAL_CLOCK_MAX_DIAGNOSTICS);
  // Records 1..(total+1) were appended; the ring keeps the last 256.
  const firstSequence = total + 1 - LOGICAL_CLOCK_MAX_DIAGNOSTICS + 1;
  assert.equal(records[0]!.sequence, firstSequence);
  assert.equal(records.at(-1)!.sequence, total + 1);
  assert.equal(records[0]!.observed_ms, firstSequence - 1);
});

test('default and custom policies both drive diagnosis and recorded kinds', () => {
  const defaultService = new LogicalClockService({ nodeId: 'node-a', now: () => 0 });
  assert.equal(
    defaultService.diagnose({ member_id: 'node-a', epoch: 0, observed_ms: 900, previous_observed_ms: null, reference_ms: 1_000 }).kind,
    'normal',
  );

  const strict = new LogicalClockService({
    nodeId: 'node-a',
    now: () => 0,
    policy: { skewToleranceMs: 100, futureToleranceMs: 10_000, jumpThresholdMs: 10_000 },
  });
  assert.equal(
    strict.diagnose({ member_id: 'node-a', epoch: 0, observed_ms: 899, previous_observed_ms: null, reference_ms: 1_000 }).kind,
    'skew',
  );

  // Diagnostics are classified with the configured policy at record time.
  const clocked = clock(1_000);
  const service = new LogicalClockService({
    nodeId: 'node-a',
    now: clocked.now,
    policy: { skewToleranceMs: 100, futureToleranceMs: 10_000, jumpThresholdMs: 10_000 },
  });
  service.tick();
  clocked.set(500);
  service.tick();
  assert.equal(service.diagnostics().at(-1)?.kind, 'rollback');
});

// ---------------------------------------------------------------------------
// Wall-clock-free ordering helpers
// ---------------------------------------------------------------------------

test('assertLogicalOnlyOrdering accepts clean single keys and lists, rejects non-objects', () => {
  const clean = { epoch: 1, commit_index: 2, writer_id: 'w1', local_seq: 3 };
  assert.doesNotThrow(() => assertLogicalOnlyOrdering(clean));
  assert.doesNotThrow(() => assertLogicalOnlyOrdering([clean, { ...clean, epoch: 2 }]));
  assert.doesNotThrow(() => assertLogicalOnlyOrdering([]));

  assert.throws(
    () => assertLogicalOnlyOrdering(null as unknown as Record<string, unknown>),
    (error: unknown) => isHaError(error, 'HA_INPUT_INVALID'),
  );
  for (const bad of [null, 42, 'key', []] as unknown[]) {
    assert.throws(
      () => assertLogicalOnlyOrdering([clean, bad as unknown as Record<string, unknown>]),
      (error: unknown) => {
        assert.ok(error instanceof HaProtocolError);
        assert.equal(error.code, 'HA_INPUT_INVALID');
        assert.match(error.message, /index 1/u);
        return true;
      },
    );
  }
  assert.throws(
    () => assertLogicalOnlyOrdering({ ...clean, timestamp: 1_000 }),
    (error: unknown) => isHaError(error, 'WALL_CLOCK_FORBIDDEN'),
  );
});

test('versionOf and compareLogicalEntries use exactly (epoch, commit_index, writer_id, local_seq)', () => {
  const base = entry('w1', 1, 10, 1);
  assert.deepEqual(versionOf(base), { epoch: 1, commit_index: 10, writer_id: 'w1', local_seq: 1 });
  assert.equal(compareLogicalEntries(base, entry('w1', 1, 10, 1)), 0);
  assert.equal(compareLogicalEntries(entry('w1', 2, 1, 1), base), 1);
  assert.equal(compareLogicalEntries(entry('w1', 0, 99, 1), base), -1);
  assert.equal(compareLogicalEntries(entry('w1', 1, 11, 1), base), 1);
  assert.equal(compareLogicalEntries(entry('w0', 1, 10, 1), base), -1);
  assert.equal(compareLogicalEntries(entry('w2', 1, 10, 1), base), 1);
  assert.equal(compareLogicalEntries(entry('w1', 1, 10, 2), base), 1);
});

test('replayOrder is deterministic and replayProjection is pure with a default adjudication list', () => {
  const items = [
    entry('w2', 1, 1, 1, HASH_B),
    entry('w1', 2, 5, 2, HASH_A),
    entry('w1', 1, 5, 1, HASH_A),
    entry('w1', 1, 5, 1, HASH_C),
    entry('w1', 1, 4, 9, HASH_A),
  ];
  // Order: (epoch, commit_index, writer_id, local_seq), hash tie-break last.
  const expected = [HASH_B, HASH_A, HASH_A, HASH_C, HASH_A];
  assert.deepEqual(replayOrder(items).map((item) => item.identity.ledger_event_hash), expected);
  assert.deepEqual(replayOrder([...items].reverse()).map((item) => item.identity.ledger_event_hash), expected);

  const records = items.map(makeRecord);
  const first = replayProjection(records);
  const second = replayProjection([...records].reverse(), []);
  assert.equal(first.hash, second.hash);
  assert.match(first.hash, /^[a-f0-9]{64}$/u);
});
