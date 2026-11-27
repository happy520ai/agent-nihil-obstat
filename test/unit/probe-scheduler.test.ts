import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acquireProbeSlot,
  ProbeCapacityError,
  ProbeSlotCancelledError,
  ProbeSlotTimeoutError,
  probeSchedulerStats,
  resetProbeScheduler,
  type ProbeSchedulerLimits,
} from '../../src/memory/probe-scheduler.ts';

const LIMITS: ProbeSchedulerLimits = { maxConcurrentNodes: 1, maxInFlightPerNode: 1, maxQueuedNodes: 4 };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('a slot is granted immediately and release is idempotent', async () => {
  resetProbeScheduler();
  const slot = await acquireProbeSlot({ nodeId: 'node-a', limits: LIMITS, waitTimeoutMs: 1_000 });
  assert.equal(probeSchedulerStats().inFlight, 1);
  assert.equal(probeSchedulerStats().perNode.get('node-a'), 1);
  slot.release();
  slot.release();
  const stats = probeSchedulerStats();
  assert.equal(stats.inFlight, 0);
  assert.equal(stats.queued, 0);
  assert.deepEqual(stats.perNode, new Map());
});

test('waiters queue FIFO and are admitted when the head releases', async () => {
  resetProbeScheduler();
  const held = await acquireProbeSlot({ nodeId: 'node-a', limits: LIMITS, waitTimeoutMs: 1_000 });
  let admitted = false;
  const waiting = acquireProbeSlot({ nodeId: 'node-b', limits: LIMITS, waitTimeoutMs: 1_000 }).then((slot) => {
    admitted = true;
    return slot;
  });
  await sleep(5);
  assert.equal(admitted, false);
  assert.equal(probeSchedulerStats().queued, 1);
  held.release();
  const slot = await waiting;
  assert.equal(admitted, true);
  assert.equal(probeSchedulerStats().inFlight, 1);
  slot.release();
  assert.equal(probeSchedulerStats().inFlight, 0);
});

test('a full queue refuses instead of waiting forever', async () => {
  resetProbeScheduler();
  const limits: ProbeSchedulerLimits = { maxConcurrentNodes: 1, maxInFlightPerNode: 1, maxQueuedNodes: 1 };
  const held = await acquireProbeSlot({ nodeId: 'node-a', limits, waitTimeoutMs: 1_000 });
  const queued = acquireProbeSlot({ nodeId: 'node-b', limits, waitTimeoutMs: 1_000 });
  await sleep(5);
  await assert.rejects(
    () => acquireProbeSlot({ nodeId: 'node-c', limits, waitTimeoutMs: 1_000 }),
    (error: unknown) => error instanceof ProbeCapacityError && error.code === 'DISTRIBUTED_PROBE_CAPACITY_EXCEEDED',
  );
  held.release();
  (await queued).release();
  assert.equal(probeSchedulerStats().inFlight, 0);
  assert.equal(probeSchedulerStats().queued, 0);
});

test('cancellation while queued leaves the queue and never takes a slot', async () => {
  resetProbeScheduler();
  const held = await acquireProbeSlot({ nodeId: 'node-a', limits: LIMITS, waitTimeoutMs: 1_000 });
  const controller = new AbortController();
  const waiting = acquireProbeSlot({ nodeId: 'node-b', limits: LIMITS, signal: controller.signal, waitTimeoutMs: 1_000 });
  await sleep(5);
  assert.equal(probeSchedulerStats().queued, 1);
  controller.abort();
  await assert.rejects(waiting, (error: unknown) => error instanceof ProbeSlotCancelledError);
  assert.equal(probeSchedulerStats().queued, 0);
  assert.equal(probeSchedulerStats().inFlight, 1);
  held.release();
  assert.equal(probeSchedulerStats().inFlight, 0);
});

test('an already-aborted signal never queues', async () => {
  resetProbeScheduler();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => acquireProbeSlot({ nodeId: 'node-a', limits: LIMITS, signal: controller.signal, waitTimeoutMs: 1_000 }),
    (error: unknown) => error instanceof ProbeSlotCancelledError,
  );
  assert.equal(probeSchedulerStats().queued, 0);
});

test('a wait budget expires with the typed timeout error', async () => {
  resetProbeScheduler();
  const held = await acquireProbeSlot({ nodeId: 'node-a', limits: LIMITS, waitTimeoutMs: 1_000 });
  await assert.rejects(
    () => acquireProbeSlot({ nodeId: 'node-b', limits: LIMITS, waitTimeoutMs: 10 }),
    (error: unknown) => error instanceof ProbeSlotTimeoutError && error.code === 'DISTRIBUTED_PROBE_SLOT_TIMEOUT',
  );
  assert.equal(probeSchedulerStats().queued, 0);
  held.release();
});

test('work-conserving admission lets another node use free capacity, then drains the queue', async () => {
  resetProbeScheduler();
  const limits: ProbeSchedulerLimits = { maxConcurrentNodes: 4, maxInFlightPerNode: 1, maxQueuedNodes: 4 };
  const first = await acquireProbeSlot({ nodeId: 'node-x', limits, waitTimeoutMs: 1_000 });
  const secondPromise = acquireProbeSlot({ nodeId: 'node-x', limits, waitTimeoutMs: 1_000 });
  const otherPromise = acquireProbeSlot({ nodeId: 'node-y', limits, waitTimeoutMs: 1_000 });
  await sleep(5);
  assert.equal(probeSchedulerStats().queued, 1, 'only the second node-x waiter is queued');
  assert.equal(probeSchedulerStats().inFlight, 2, 'the free global slot goes to node-y');
  const other = await otherPromise;
  first.release();
  const second = await secondPromise;
  assert.equal(probeSchedulerStats().inFlight, 2);
  second.release();
  other.release();
  assert.equal(probeSchedulerStats().inFlight, 0);
  assert.equal(probeSchedulerStats().queued, 0);
});

test('releasing one of several slots for the same node keeps the remaining count', async () => {
  resetProbeScheduler();
  const limits: ProbeSchedulerLimits = { maxConcurrentNodes: 4, maxInFlightPerNode: 2, maxQueuedNodes: 4 };
  const first = await acquireProbeSlot({ nodeId: 'node-a', limits, waitTimeoutMs: 1_000 });
  const second = await acquireProbeSlot({ nodeId: 'node-a', limits, waitTimeoutMs: 1_000 });
  assert.equal(probeSchedulerStats().perNode.get('node-a'), 2);
  first.release();
  assert.equal(probeSchedulerStats().perNode.get('node-a'), 1);
  assert.equal(probeSchedulerStats().inFlight, 1);
  second.release();
  assert.equal(probeSchedulerStats().perNode.get('node-a'), undefined);
  assert.equal(probeSchedulerStats().inFlight, 0);
});

test('reset refuses every queued waiter and clears the counters', async () => {
  resetProbeScheduler();
  const held = await acquireProbeSlot({ nodeId: 'node-a', limits: LIMITS, waitTimeoutMs: 1_000 });
  const waiting = acquireProbeSlot({ nodeId: 'node-b', limits: LIMITS, waitTimeoutMs: 1_000 });
  const outcome = waiting.catch((error: unknown) => error);
  await sleep(5);
  resetProbeScheduler();
  const error = await outcome;
  assert.equal(error instanceof ProbeCapacityError, true);
  const stats = probeSchedulerStats();
  assert.equal(stats.inFlight, 0);
  assert.equal(stats.queued, 0);
  assert.deepEqual(stats.perNode, new Map());
  held.release();
});
