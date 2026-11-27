/**
 * T-157 / MNT-01: bounded scatter scheduler for the distributed probe.
 *
 * The coordinator scatters one query to N replicas in parallel. Without a
 * bound, P concurrent probes times N replicas open an unbounded number of node
 * queries and starve the process. This module is the only admission control
 * in front of a node query:
 *
 * - `maxConcurrentNodes` caps the node queries running at the same time
 *   across every concurrently running `distributedProbe` call (process-wide);
 * - `maxInFlightPerNode` caps the running queries per replica id;
 * - `maxQueuedNodes` bounds the FIFO wait queue: a node that cannot be
 *   admitted immediately waits for a slot, and a node that arrives while the
 *   queue is full is refused with {@link ProbeCapacityError} instead of
 *   waiting forever.
 *
 * The state is process-wide on purpose: the caps protect the process, not a
 * single call. The limits themselves are supplied per call by the caller, so
 * a caller may tighten them for its own traffic.
 *
 * Hard boundaries honoured here:
 * - a waiter that is cancelled or times out while queued leaves the queue and
 *   never holds a slot (no leak, no phantom capacity);
 * - the scheduler never decides anything about the answer: it only admits,
 *   refuses or delays a node query.
 */

/** Error code carried by a refused (queue-full) admission. */
export const PROBE_CAPACITY_ERROR_CODE = 'DISTRIBUTED_PROBE_CAPACITY_EXCEEDED';

/** A node query could not be admitted because the wait queue is full. */
export class ProbeCapacityError extends Error {
  readonly code = PROBE_CAPACITY_ERROR_CODE;

  constructor(message: string) {
    super(message);
    this.name = 'ProbeCapacityError';
  }
}

/** A queued node query was cancelled by the caller before it got a slot. */
export class ProbeSlotCancelledError extends Error {
  readonly code = 'DISTRIBUTED_PROBE_SLOT_CANCELLED';

  constructor(message: string) {
    super(message);
    this.name = 'ProbeSlotCancelledError';
  }
}

/** A queued node query waited longer than its budget and gave up. */
export class ProbeSlotTimeoutError extends Error {
  readonly code = 'DISTRIBUTED_PROBE_SLOT_TIMEOUT';

  constructor(message: string) {
    super(message);
    this.name = 'ProbeSlotTimeoutError';
  }
}

/** Admission limits for one acquisition request. */
export interface ProbeSchedulerLimits {
  /** Process-wide cap on simultaneously running node queries. */
  readonly maxConcurrentNodes: number;
  /** Cap on simultaneously running node queries for one replica id. */
  readonly maxInFlightPerNode: number;
  /** Maximum number of node queries waiting for a slot. */
  readonly maxQueuedNodes: number;
}

/** One admitted node query; `release` returns the slot exactly once. */
export interface ProbeSlot {
  readonly nodeId: string;
  release(): void;
}

export interface ProbeSlotRequest {
  /** Per-node admission key: the replica id. */
  readonly nodeId: string;
  readonly limits: ProbeSchedulerLimits;
  /** Cancels the wait (and the admission) when aborted. */
  readonly signal?: AbortSignal;
  /** Milliseconds the caller may wait for a slot before giving up. */
  readonly waitTimeoutMs: number;
}

/** Observable scheduler state (test seam and diagnostics). */
export interface ProbeSchedulerStats {
  readonly inFlight: number;
  readonly queued: number;
  readonly perNode: ReadonlyMap<string, number>;
}

interface Waiter {
  readonly nodeId: string;
  readonly limits: ProbeSchedulerLimits;
  readonly resolve: (slot: ProbeSlot) => void;
  readonly reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
  settled: boolean;
}

const perNode = new Map<string, number>();
const queue: Waiter[] = [];
let inFlight = 0;

function nodeCount(nodeId: string): number {
  return perNode.get(nodeId) ?? 0;
}

function canAdmit(nodeId: string, limits: ProbeSchedulerLimits): boolean {
  if (inFlight >= limits.maxConcurrentNodes) return false;
  return nodeCount(nodeId) < limits.maxInFlightPerNode;
}

function grant(nodeId: string): ProbeSlot {
  inFlight += 1;
  perNode.set(nodeId, nodeCount(nodeId) + 1);
  let released = false;
  return {
    nodeId,
    release(): void {
      if (released) return;
      released = true;
      inFlight = Math.max(0, inFlight - 1);
      const remaining = nodeCount(nodeId) - 1;
      if (remaining <= 0) perNode.delete(nodeId);
      else perNode.set(nodeId, remaining);
      drain();
    },
  };
}

/** Drop the timer and the caller-signal listener; every settle path calls it. */
function detach(waiter: Waiter): void {
  if (waiter.timer !== undefined) {
    clearTimeout(waiter.timer);
    waiter.timer = undefined;
  }
  if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
    waiter.signal.removeEventListener('abort', waiter.onAbort);
  }
  waiter.signal = undefined;
  waiter.onAbort = undefined;
}

function admit(waiter: Waiter): void {
  waiter.settled = true;
  detach(waiter);
  waiter.resolve(grant(waiter.nodeId));
}

/**
 * Admit waiters in queue order but work-conservingly: a waiter whose own node
 * is at its per-node cap does not block an admittable waiter behind it. This
 * keeps capacity used while still making the wait order deterministic.
 */
function drain(): void {
  for (let index = 0; index < queue.length;) {
    const waiter = queue[index] as Waiter;
    if (waiter.settled) {
      queue.splice(index, 1);
      continue;
    }
    if (!canAdmit(waiter.nodeId, waiter.limits)) {
      index += 1;
      continue;
    }
    queue.splice(index, 1);
    admit(waiter);
  }
}

function removeFromQueue(waiter: Waiter): void {
  const index = queue.indexOf(waiter);
  if (index >= 0) queue.splice(index, 1);
}

/**
 * Acquire one node-query slot.
 *
 * Resolves with a {@link ProbeSlot} the caller must release, or rejects with
 * {@link ProbeCapacityError} (queue full), {@link ProbeSlotCancelledError}
 * (caller aborted) or {@link ProbeSlotTimeoutError} (the wait budget expired).
 */
export function acquireProbeSlot(request: ProbeSlotRequest): Promise<ProbeSlot> {
  const { nodeId, limits } = request;
  if (request.signal !== undefined && request.signal.aborted) {
    return Promise.reject(new ProbeSlotCancelledError('cancelled before the scheduler wait'));
  }
  if (canAdmit(nodeId, limits)) {
    return Promise.resolve(grant(nodeId));
  }
  if (queue.length >= limits.maxQueuedNodes) {
    return Promise.reject(
      new ProbeCapacityError(
        `scheduler queue is full (${String(queue.length)} queued of ${String(limits.maxQueuedNodes)} allowed)`,
      ),
    );
  }
  return new Promise<ProbeSlot>((resolve, reject) => {
    const waiter: Waiter = {
      nodeId,
      limits,
      resolve,
      reject,
      timer: undefined,
      signal: undefined,
      onAbort: undefined,
      settled: false,
    };
    const giveUp = (error: Error): void => {
      waiter.settled = true;
      detach(waiter);
      removeFromQueue(waiter);
      reject(error);
      // Removing an earlier waiter can unblock the new head (for example when
      // it was only waiting on its own per-node cap).
      drain();
    };
    waiter.timer = setTimeout(() => {
      giveUp(new ProbeSlotTimeoutError(`waited ${String(request.waitTimeoutMs)}ms for a scheduler slot`));
    }, request.waitTimeoutMs);
    if (request.signal !== undefined) {
      const onAbort = (): void => {
        giveUp(new ProbeSlotCancelledError('cancelled while waiting for a scheduler slot'));
      };
      waiter.signal = request.signal;
      waiter.onAbort = onAbort;
      request.signal.addEventListener('abort', onAbort, { once: true });
    }
    queue.push(waiter);
  });
}

/** Observable scheduler state; used by tests and diagnostics. */
export function probeSchedulerStats(): ProbeSchedulerStats {
  return {
    inFlight,
    queued: queue.length,
    perNode: new Map(perNode),
  };
}

/**
 * Test seam: drop every counter and refuse every queued waiter so no promise
 * stays pending. Slots already handed out stay valid; releasing them after a
 * reset is a no-op beyond the counter clamp.
 */
export function resetProbeScheduler(): void {
  const pending = queue.splice(0, queue.length);
  for (const waiter of pending) {
    if (waiter.settled) continue;
    waiter.settled = true;
    detach(waiter);
    waiter.reject(new ProbeCapacityError('scheduler state was reset'));
  }
  inFlight = 0;
  perNode.clear();
}
