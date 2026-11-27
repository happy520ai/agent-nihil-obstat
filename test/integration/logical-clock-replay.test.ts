import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { hashEvent, type LedgerEvent } from '../../src/ledger/event.ts';
import { Ledger } from '../../src/ledger/ledger.ts';
import {
  HaProtocolError,
  MWHA_EVENT_SCHEMA_VERSION,
  detectForks,
  type MwhaEventIdentity,
  type MwhaLeaderLease,
  type MwhaWriterEvent,
} from '../../src/memory/ha-protocol.ts';
import { MultiWriterLog, type MultiWriterSlotState } from '../../src/memory/multi-writer.ts';
import {
  LogicalClockService,
  assertLogicalOnlyOrdering,
  compareLogicalEntries,
  replayOrder,
  versionOf,
} from '../../src/memory/logical-clock.ts';

/**
 * T-137 integration tests: real Ledger events committed through MultiWriterLog
 * are replayed under an injected virtual clock that rolls back, jumps forward
 * and runs into the future between ticks.
 *
 * Assertions: commit order, projection hash and conflict adjudication are
 * byte-for-byte identical to a monotonic-clock baseline; diagnostics expose
 * the injected anomalies without touching ordering; the historical ledger
 * bytes/hashes never change.
 *
 * Boundary: the injected clock is a virtual sampler in one process. It does
 * NOT modify the OS clock and does NOT model a cross-host rollback.
 */

const HASHES = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((char) => char.repeat(64));

interface TestClock {
  t: number;
  now: () => number;
  set(value: number): void;
  advance(ms: number): void;
}

function makeClock(start: number): TestClock {
  const clock: TestClock = {
    t: start,
    now: () => clock.t,
    set: (value) => { clock.t = value; },
    advance: (ms) => { clock.t += ms; },
  };
  return clock;
}

interface PlannedEntry {
  readonly writerId: string;
  readonly epoch: number;
  readonly localSeq: number;
  readonly taskId: string;
  readonly label: string;
}

/** Seven committed writes across four writers, including one fork slot. */
const PLAN: readonly PlannedEntry[] = [
  { writerId: 'w1', epoch: 1, localSeq: 1, taskId: 'task-001', label: 'first' },
  { writerId: 'w2', epoch: 1, localSeq: 1, taskId: 'task-002', label: 'second' },
  { writerId: 'w1', epoch: 1, localSeq: 2, taskId: 'task-003', label: 'third' },
  { writerId: 'w3', epoch: 1, localSeq: 1, taskId: 'task-004', label: 'fourth' },
  { writerId: 'w1', epoch: 1, localSeq: 1, taskId: 'task-005', label: 'fork-branch' },
  { writerId: 'w3', epoch: 1, localSeq: 2, taskId: 'task-007', label: 'seventh' },
  { writerId: 'w2', epoch: 2, localSeq: 1, taskId: 'task-006', label: 'epoch-two' },
];

const LEADER: MwhaLeaderLease = { term: 1, leader_id: 'leader-a', epoch: 1 };

/**
 * Caller-supplied logical positions. The fork branch deliberately shares the
 * logical version `(w1, epoch 1, local_seq 1, commit_index 1)` with its rival,
 * so the conflict is a same-version hash disagreement rather than a matter of
 * which timestamp arrived last.
 */
const COMMIT_INDICES: readonly number[] = [1, 2, 3, 4, 1, 5, 6];

interface BuiltScenario {
  readonly events: readonly LedgerEvent[];
  readonly hashes: readonly string[];
  readonly root: string;
  close(): void;
}

async function buildScenario(): Promise<BuiltScenario> {
  const clock = makeClock(1_700_000_000_000);
  const root = await mkdtemp(join(tmpdir(), 'ano logical-clock-replay '));
  const ledger = await Ledger.open(root, { sessionId: 'LC-REPLAY', actor: 'ledger-writer', clock: clock.now });
  const events: LedgerEvent[] = [];
  const hashes: string[] = [];
  try {
    for (const [index, planned] of PLAN.entries()) {
      const result = await ledger.createTask(planned.taskId, [`src/${planned.taskId}.ts`], planned.label, `ano:t137:${planned.taskId}`);
      assert.equal(result.duplicate, false, `fixture task ${planned.taskId} must be freshly committed`);
      const event = result.event!;
      events.push(event);
      hashes.push(hashEvent(event));
      assert.notEqual(hashes[index], hashes[index - 1] ?? '', 'fixture hashes must differ');
      clock.advance(1_000);
    }
  } catch (error) {
    ledger.close();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  return {
    events,
    hashes,
    root,
    close: () => ledger.close(),
  };
}

function writerEvent(planned: PlannedEntry, hash: string): MwhaWriterEvent {
  const identity: MwhaEventIdentity = {
    writer_id: planned.writerId,
    epoch: planned.epoch,
    term: LEADER.term,
    local_seq: planned.localSeq,
    ledger_event_hash: hash,
  };
  const leader: MwhaLeaderLease = { ...LEADER, epoch: planned.epoch };
  return { schema_version: MWHA_EVENT_SCHEMA_VERSION, identity, leader };
}

function entryKey(entry: { readonly identity: MwhaEventIdentity; readonly commit_index: number }): string {
  return `${entry.identity.writer_id}|${entry.identity.epoch}|${entry.identity.local_seq}|${entry.commit_index}|${entry.identity.ledger_event_hash}`;
}

function slotKeyOf(state: { readonly conflict_key: { readonly writer_id: string; readonly epoch: number; readonly local_seq: number } }): string {
  return `${state.conflict_key.writer_id}|${state.conflict_key.epoch}|${state.conflict_key.local_seq}`;
}

function findSlot(projection: { readonly states: readonly MultiWriterSlotState[] }, key: string): MultiWriterSlotState | undefined {
  return projection.states.find((state) => slotKeyOf(state) === key);
}

async function readLedgerBytes(root: string): Promise<{ names: string[]; bytes: Buffer }> {
  const dir = join(root, '.ano', 'ledger');
  const names = (await readdir(dir)).filter((name) => !name.startsWith('.')).sort();
  const parts: Buffer[] = [];
  for (const name of names) parts.push(await readFile(join(dir, name)));
  return { names, bytes: Buffer.concat(parts) };
}

function replayInto(log: MultiWriterLog, scenario: BuiltScenario, service: LogicalClockService, clock: TestClock, schedule?: (step: number) => void): void {
  for (const [index, planned] of PLAN.entries()) {
    schedule?.(index);
    const hash = scenario.hashes[index]!;
    log.append({
      event: writerEvent(planned, hash),
      ledgerEvent: scenario.events[index]!,
      ledgerEventHash: hash,
      commitIndex: COMMIT_INDICES[index]!,
    });
    // Physical time advances only as a diagnostic sample; commit_index comes
    // from the caller's logical protocol position above.
    service.tick();
    clock.advance(1_000);
  }
}

test('committed replay stays byte-identical under injected rollback, future and jump clocks', { timeout: 60_000 }, async () => {
  const scenario = await buildScenario();
  try {
    const baselineClock = makeClock(1_700_000_000_000);
    const baselineService = new LogicalClockService({ nodeId: 'node-baseline', now: baselineClock.now });

    const injectedClock = makeClock(1_700_000_000_000);
    const injectedService = new LogicalClockService({
      nodeId: 'node-injected',
      now: injectedClock.now,
      referenceMs: 1_700_000_000_000,
    });
    const injectSchedule = (step: number): void => {
      if (step === 1) injectedClock.set(injectedClock.t - 50_000); // rollback
      if (step === 2) injectedClock.advance(8_000); // still behind the reference -> skew
      if (step === 3) injectedClock.advance(50_000); // ahead of reference+tolerance, within jump bounds -> future
      if (step === 4) injectedClock.advance(900_000); // jump
      if (step === 5) injectedClock.set(injectedClock.t - 1); // rollback
    };

    const baselineLog = new MultiWriterLog();
    const injectedLog = new MultiWriterLog();

    const before = await readLedgerBytes(scenario.root);
    const beforeHashes = scenario.events.map((event) => hashEvent(event));

    replayInto(baselineLog, scenario, baselineService, baselineClock);
    replayInto(injectedLog, scenario, injectedService, injectedClock, injectSchedule);

    const baseline = baselineLog.replay();
    const injected = injectedLog.replay();

    // 1. Commit order and projection hash are exactly the baseline's.
    assert.deepEqual(injected.entries.map(entryKey), baseline.entries.map(entryKey));
    assert.equal(
      injected.hash,
      baseline.hash,
      `projection hash changed under injected clock: baseline=${baseline.hash} injected=${injected.hash}`,
    );
    assert.deepEqual(
      injected.states.map((state) => ({ key: slotKeyOf(state), status: state.status, winner: state.winning_branch_id })),
      baseline.states.map((state) => ({ key: slotKeyOf(state), status: state.status, winner: state.winning_branch_id })),
    );

    // 2. Conflict adjudication does not depend on any time sample.
    const forkReport = detectForks(injected.entries.map((ref) => ({ identity: ref.identity })));
    assert.equal(forkReport.conflicts.length, 1);
    const conflictKey = forkReport.conflicts[0]!.conflict_key;
    const conflictKeyText = slotKeyOf({ conflict_key: conflictKey });
    for (const projection of [baseline, injected]) {
      const slot = findSlot(projection, conflictKeyText);
      assert.ok(slot !== undefined);
      assert.equal(slot.status, 'conflicted');
      assert.equal(slot.branches.length, 2);
      assert.equal(slot.version_outcome.status, 'conflicted');
      assert.equal(slot.winning_branch_id, null);
      assert.equal(slot.evidence_id, null);
    }
    const baselineConflict = findSlot(baseline, conflictKeyText)!;
    const injectedConflict = findSlot(injected, conflictKeyText)!;
    assert.deepEqual(injectedConflict.version_outcome, baselineConflict.version_outcome);
    assert.deepEqual(injectedConflict.branches, baselineConflict.branches);

    // 3. Diagnostics are visible for the injected anomalies and read-only for
    //    the baseline; neither run let diagnostics influence the results.
    const injectedKinds = injectedService.diagnostics().map((record) => record.kind);
    assert.ok(injectedKinds.includes('rollback'), `expected rollback marker, got ${injectedKinds.join(',')}`);
    assert.ok(injectedKinds.includes('future'), `expected future marker, got ${injectedKinds.join(',')}`);
    assert.ok(injectedKinds.includes('jump'), `expected jump marker, got ${injectedKinds.join(',')}`);
    const baselineKinds = baselineService.diagnostics().map((record) => record.kind);
    assert.equal(baselineKinds.includes('rollback'), false);
    assert.equal(baselineKinds.includes('future'), false);
    assert.equal(baselineKinds.includes('jump'), false);
    for (const record of injectedService.diagnostics()) {
      assert.equal(record.diagnosis.diagnostic_only, true);
      assert.equal(record.diagnosis.affects_commit_order, false);
      assert.equal(record.diagnosis.affects_fact_version, false);
    }

    // 4. Explicit wall-clock refusal still applies to ordering material.
    assert.doesNotThrow(() => assertLogicalOnlyOrdering(baseline.entries.map((ref) => versionOf(ref))));
    assert.throws(
      () => assertLogicalOnlyOrdering({ ...versionOf(baseline.entries[0]!), timestamp: Number.MAX_SAFE_INTEGER }),
      (error: unknown) => error instanceof HaProtocolError && error.code === 'WALL_CLOCK_FORBIDDEN',
    );
    const left = baseline.entries[0]!;
    const leftWithTime = { ...left, timestamp: 1 } as typeof left;
    const rightWithTime = { ...left, timestamp: Number.MAX_SAFE_INTEGER } as typeof left;
    assert.equal(compareLogicalEntries(leftWithTime, rightWithTime), 0);

    // 5. Replay order API agrees with the log projection.
    const replayable = PLAN.map((planned, index) => ({
      identity: { ...writerEvent(planned, scenario.hashes[index]!).identity },
      commit_index: COMMIT_INDICES[index]!,
    }));
    assert.deepEqual(replayOrder(replayable).map(entryKey), baseline.entries.map(entryKey));

    // 6. Historical ledger bytes and hashes are untouched by the replay.
    const after = await readLedgerBytes(scenario.root);
    assert.deepEqual(after.names, before.names);
    assert.equal(after.bytes.equals(before.bytes), true, 'ledger segment bytes changed during replay');
    assert.deepEqual(scenario.events.map((event) => hashEvent(event)), beforeHashes);

    // 7. Adjudication converges identically in both runs (same selected branch).
    const branchA = forkReport.conflicts[0]!.branches[0]!;
    const branchB = forkReport.conflicts[0]!.branches[1]!;
    for (const log of [baselineLog, injectedLog]) {
      log.adjudicate({
        schema_version: 'mwha.adjudication.v1',
        conflict_key: conflictKey,
        branches: [branchA, branchB],
        branch_hashes: [branchA.ledger_event_hash, branchB.ledger_event_hash],
        status: 'resolved',
        selected_branch_id: branchA.branch_id,
        resolution_reason: 'T-137 deterministic selection',
      }, { evidenceId: `ev-${branchA.ledger_event_hash.slice(0, 32)}` });
    }
    const baselineResolved = baselineLog.replay();
    const injectedResolved = injectedLog.replay();
    assert.equal(injectedResolved.hash, baselineResolved.hash);
    assert.deepEqual(injectedResolved.entries.map(entryKey), baselineResolved.entries.map(entryKey));
    const resolvedSlot = findSlot(injectedResolved, conflictKeyText)!;
    assert.equal(resolvedSlot.status, 'committed');
    assert.equal(resolvedSlot.winning_branch_id, branchA.branch_id);
    assert.equal(resolvedSlot.evidence_id, `ev-${branchA.ledger_event_hash.slice(0, 32)}`);

    // 8. Ledger bytes still unchanged after adjudication/replay.
    const final = await readLedgerBytes(scenario.root);
    assert.equal(final.bytes.equals(before.bytes), true);
  } finally {
    scenario.close();
    await rm(scenario.root, { recursive: true, force: true });
  }
});
