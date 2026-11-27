import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { hashEvent, type LedgerEvent } from '../../src/ledger/event.ts';
import { Ledger } from '../../src/ledger/ledger.ts';
import {
  MWHA_CLOCK_DEFAULT_POLICY,
  type MwhaClockPolicy,
  type MwhaLeaderLease,
} from '../../src/memory/ha-protocol.ts';
import {
  LogicalClockService,
  type LogicalClockDiagnosticRecord,
  type LogicalClockRemote,
  type LogicalClockSnapshot,
} from '../../src/memory/logical-clock.ts';
import { MultiWriterLog } from '../../src/memory/multi-writer.ts';

/**
 * T-140 clock-injection harness.
 *
 * Provides a controllable per-node wall-clock sampler (offset / rollback /
 * future / jump / skew sequences) injected into a real `LogicalClockService`,
 * plus a constructor that wires each node to its own temporary on-disk
 * `Ledger` and an in-memory `MultiWriterLog`.
 *
 * Hard boundaries honoured here:
 * - the OS clock is never read or written once `now` is injected; this fixture
 *   only moves a private virtual sample;
 * - local injection models an arbitrary sample sequence. It is NOT a
 *   cross-host clock rollback, does not modify the system clock and leaves
 *   physical three-machine deployments unverified;
 * - no timer is created and no network is touched.
 */

export const HA_CLOCK_LOCAL_INJECTION_IS_NOT_CROSS_HOST = '本地注入 ≠ 跨机真实回拨';
export const HA_CLOCK_DOES_NOT_CHANGE_SYSTEM_CLOCK = '不改系统时钟';
export const HA_CLOCK_CROSS_HOST_UNVERIFIED = '跨机未验证';
export const HA_CLOCK_DIAGNOSTIC_SCOPE_NOTE =
  `${HA_CLOCK_LOCAL_INJECTION_IS_NOT_CROSS_HOST}；`
  + `${HA_CLOCK_DOES_NOT_CHANGE_SYSTEM_CLOCK}；`
  + `${HA_CLOCK_CROSS_HOST_UNVERIFIED}`;

const NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DEFAULT_START_MS = 1_700_000_000_000;

/** Harness-local fail-closed error for malformed clock fixtures. */
export class HaClockHarnessError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(`[ha-clock:${field}] ${message}`);
    this.name = 'HaClockHarnessError';
    this.field = field;
  }
}

function assertSafeSample(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new HaClockHarnessError(label, `must be a nonnegative safe integer, got ${String(value)}`);
  }
}

function parseNodeId(nodeId: unknown): string {
  if (typeof nodeId !== 'string' || !NODE_ID_PATTERN.test(nodeId)) {
    throw new HaClockHarnessError('nodeId', 'must match [A-Za-z0-9][A-Za-z0-9._:-]{0,127}');
  }
  return nodeId;
}

// ---------------------------------------------------------------------------
// Controllable virtual clock
// ---------------------------------------------------------------------------

export interface HaClockControllerOptions {
  readonly nodeId: string;
  readonly startMs?: number;
  readonly epoch?: number;
  /** Fixed reference used by skew/future/jump diagnosis. */
  readonly referenceMs?: number | null;
  readonly policy?: MwhaClockPolicy;
}

/**
 * One node's controllable physical sample. Every mutation only changes the
 * value returned by {@link HaClockController.now}; it never touches
 * `Date.now`, starts no timer and performs no I/O.
 */
export class HaClockController {
  readonly nodeId: string;
  readonly epoch: number;
  readonly referenceMs: number | null;
  readonly policy: MwhaClockPolicy;
  readonly service: LogicalClockService;

  #currentMs: number;
  readonly #startMs: number;
  #samples = 0;

  constructor(options: HaClockControllerOptions) {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw new HaClockHarnessError('options', 'must be an object');
    }
    const nodeId = parseNodeId(options.nodeId);
    const startMs = options.startMs ?? DEFAULT_START_MS;
    assertSafeSample(startMs, 'startMs');
    if (options.epoch !== undefined && (!Number.isSafeInteger(options.epoch) || options.epoch < 0)) {
      throw new HaClockHarnessError('epoch', `must be a nonnegative safe integer, got ${String(options.epoch)}`);
    }
    if (options.referenceMs !== undefined && options.referenceMs !== null && !Number.isSafeInteger(options.referenceMs)) {
      throw new HaClockHarnessError('referenceMs', `must be a safe integer or null, got ${String(options.referenceMs)}`);
    }

    this.nodeId = nodeId;
    this.#currentMs = startMs;
    this.#startMs = startMs;
    this.epoch = options.epoch ?? 0;
    this.referenceMs = options.referenceMs ?? null;
    this.policy = options.policy ?? MWHA_CLOCK_DEFAULT_POLICY;
    this.service = new LogicalClockService({
      nodeId,
      now: () => this.#currentMs,
      ...(options.epoch !== undefined ? { epoch: options.epoch } : {}),
      ...(options.referenceMs !== undefined ? { referenceMs: options.referenceMs } : {}),
      ...(options.policy !== undefined ? { policy: options.policy } : {}),
    });
  }

  get currentMs(): number {
    return this.#currentMs;
  }

  get startMs(): number {
    return this.#startMs;
  }

  get sampleCount(): number {
    return this.#samples;
  }

  /** The injected sampler handed to `LogicalClockService`/`Ledger`. */
  now(): number {
    return this.#currentMs;
  }

  /** Absolute jump of the virtual sample. */
  set(ms: number): void {
    assertSafeSample(ms, 'set');
    this.#currentMs = ms;
  }

  /** Relative shift of the virtual sample (positive or negative). */
  advance(deltaMs: number): void {
    if (!Number.isSafeInteger(deltaMs)) throw new HaClockHarnessError('advance', `delta must be a safe integer, got ${String(deltaMs)}`);
    const next = this.#currentMs + deltaMs;
    assertSafeSample(next, 'advance result');
    this.#currentMs = next;
  }

  /** Alias of {@link advance}; named for offset-style schedules. */
  offset(deltaMs: number): void {
    this.advance(deltaMs);
  }

  /** Move the virtual sample backwards by `deltaMs`. */
  rollback(deltaMs: number): void {
    if (!Number.isSafeInteger(deltaMs) || deltaMs <= 0) {
      throw new HaClockHarnessError('rollback', `delta must be a positive safe integer, got ${String(deltaMs)}`);
    }
    this.advance(-deltaMs);
  }

  /** Move the virtual sample forwards by `deltaMs`. */
  jump(deltaMs: number): void {
    if (!Number.isSafeInteger(deltaMs) || deltaMs <= 0) {
      throw new HaClockHarnessError('jump', `delta must be a positive safe integer, got ${String(deltaMs)}`);
    }
    this.advance(deltaMs);
  }

  /** Small relative shift used to model node skew around a reference. */
  skew(deltaMs: number): void {
    this.advance(deltaMs);
  }

  /**
   * Shift ahead by `deltaMs`. The caller chooses the magnitude relative to
   * `referenceMs`; this helper deliberately does not invent a threshold.
   */
  future(deltaMs: number): void {
    this.jump(deltaMs);
  }

  /** Sample the virtual clock through the HLC service. */
  tick(): LogicalClockSnapshot {
    const snapshot = this.service.tick();
    this.#samples += 1;
    return snapshot;
  }

  /** Merge one remote HLC snapshot through the service. */
  observe(remote: LogicalClockRemote): LogicalClockSnapshot {
    const snapshot = this.service.observe(remote);
    this.#samples += 1;
    return snapshot;
  }

  snapshot(): LogicalClockSnapshot {
    return this.service.snapshot();
  }

  diagnostics(): readonly LogicalClockDiagnosticRecord[] {
    return this.service.diagnostics();
  }
}

export type HaClockMutation =
  | { readonly kind: 'set'; readonly ms: number }
  | { readonly kind: 'offset'; readonly deltaMs: number }
  | { readonly kind: 'rollback'; readonly deltaMs: number }
  | { readonly kind: 'jump'; readonly deltaMs: number };

/** Apply a declarative per-node mutation sequence. */
export function applyHaClockMutations(controller: HaClockController, mutations: readonly HaClockMutation[]): void {
  for (const mutation of mutations) {
    switch (mutation.kind) {
      case 'set':
        controller.set(mutation.ms);
        break;
      case 'offset':
        controller.offset(mutation.deltaMs);
        break;
      case 'rollback':
        controller.rollback(mutation.deltaMs);
        break;
      case 'jump':
        controller.jump(mutation.deltaMs);
        break;
      default: {
        const exhaustive: never = mutation;
        throw new HaClockHarnessError('mutation', `unsupported mutation ${JSON.stringify(exhaustive)}`);
      }
    }
  }
}

/** Human-readable diagnostic text, always carrying the scope boundary. */
export function formatHaClockDiagnostic(record: LogicalClockDiagnosticRecord): string {
  const diagnosis = record.diagnosis;
  return `[${diagnosis.kind}] ${diagnosis.detail} (${HA_CLOCK_DIAGNOSTIC_SCOPE_NOTE})`;
}

// ---------------------------------------------------------------------------
// Real Ledger + MultiWriterLog + LogicalClockService node constructor
// ---------------------------------------------------------------------------

export interface HaClockNodeOptions {
  readonly nodeId: string;
  /** Defaults to `nodeId`; used as ledger actor when `actor` is omitted. */
  readonly writerId?: string;
  readonly sessionId?: string;
  readonly actor?: string;
  readonly startMs?: number;
  readonly epoch?: number;
  readonly referenceMs?: number | null;
  readonly policy?: MwhaClockPolicy;
  readonly lease?: MwhaLeaderLease;
  readonly knownEpochs?: Iterable<number>;
}

export interface HaClockNode {
  readonly nodeId: string;
  readonly writerId: string;
  readonly root: string;
  readonly ledger: Ledger;
  readonly log: MultiWriterLog;
  readonly controller: HaClockController;
  readonly service: LogicalClockService;
  close(): Promise<void>;
}

/**
 * Create one isolated node: its own tmpdir `Ledger` (clock wired to the
 * injected sampler), its own `MultiWriterLog` and its own
 * `LogicalClockService`. Cleanup is registered with `t.after`, so callers only
 * need to close early when they want to assert before teardown.
 */
export async function createHaClockNode(t: TestContext, options: HaClockNodeOptions): Promise<HaClockNode> {
  const nodeId = parseNodeId(options.nodeId);
  const controller = new HaClockController({
    nodeId,
    ...(options.startMs !== undefined ? { startMs: options.startMs } : {}),
    ...(options.epoch !== undefined ? { epoch: options.epoch } : {}),
    ...(options.referenceMs !== undefined ? { referenceMs: options.referenceMs } : {}),
    ...(options.policy !== undefined ? { policy: options.policy } : {}),
  });

  const root = await mkdtemp(join(tmpdir(), `ano-ha-clock-${nodeId}-`));
  let ledger: Ledger;
  try {
    ledger = await Ledger.open(root, {
      actor: options.actor ?? nodeId,
      sessionId: options.sessionId ?? nodeId,
      clock: () => controller.now(),
    });
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }

  const log = new MultiWriterLog({
    ...(options.lease !== undefined ? { lease: options.lease } : {}),
    ...(options.knownEpochs !== undefined ? { knownEpochs: options.knownEpochs } : {}),
  });

  let closed = false;
  const node: HaClockNode = {
    nodeId,
    writerId: options.writerId ?? nodeId,
    root,
    ledger,
    log,
    controller,
    service: controller.service,
    close: async () => {
      if (closed) return;
      closed = true;
      ledger.close();
      await rm(root, { recursive: true, force: true });
    },
  };
  t.after(async () => {
    await node.close();
  });
  return node;
}

/** Create several independent nodes in one call. */
export async function createHaClockCluster(t: TestContext, specs: readonly HaClockNodeOptions[]): Promise<readonly HaClockNode[]> {
  const nodes: HaClockNode[] = [];
  for (const spec of specs) nodes.push(await createHaClockNode(t, spec));
  return nodes;
}

export interface HaClockTaskFixture {
  readonly event: LedgerEvent;
  readonly hash: string;
}

/**
 * Commit one real `task.created` event through the node's own ledger. The
 * returned hash is the existing `hashEvent` value; the harness never rewrites
 * ledger bytes.
 */
export async function commitHaClockTask(
  node: HaClockNode,
  taskId: string,
  label: string,
): Promise<HaClockTaskFixture> {
  const result = await node.ledger.createTask(taskId, [`src/${taskId}.ts`], label, `ano:t140:${node.writerId}:${taskId}`);
  if (result.event === undefined) throw new HaClockHarnessError('fixture', `ledger append produced no event for ${taskId}`);
  return { event: result.event, hash: hashEvent(result.event) };
}
