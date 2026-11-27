import * as net from 'node:net';
import {
  MWHA_FAULT_INJECTION_LAYER,
  MWHA_FAULT_INJECTION_SCOPE_NOTE,
  MWHA_UNVERIFIED_CAPABILITIES,
  MWHA_VERIFICATION_SCOPE,
  mwhaFaultKinds,
  type MwhaFaultKind,
} from './ha-protocol.ts';
import { TCP_REPLICA_MAX_FRAME_BYTES, isLoopbackHost } from './tcp-transport.ts';

/**
 * T-138 / HA-06: real local TCP fault-injection proxy for the T-134 transport.
 *
 * This is a *protocol-aware* `node:net` proxy. It terminates the client side,
 * opens one upstream connection per client connection, decodes the frozen
 * 4-byte big-endian length-prefixed frames of `tcp-transport.ts` and applies
 * deterministic whole-frame faults (delay/drop/duplicate/reorder), directional
 * cuts (disconnect/one-way-partition) and token-bucket bandwidth limits.
 *
 * HARD SCOPE BOUNDARY — read before using or citing this module:
 * - This is **TCP protocol-layer fault injection**, NOT an OS firewall rule,
 *   kernel protocol-stack failure or physical link outage. It can only affect
 *   traffic that deliberately traverses this loopback proxy.
 * - It does NOT prove physical three-machine partitions, cross-host network
 *   behaviour, production HA failover or availability SLAs. See
 *   {@link TCP_FAULT_PROXY_FAULT_INJECTION_SCOPE_NOTE} and
 *   {@link TCP_FAULT_PROXY_UNVERIFIED_BOUNDARIES}.
 * - It only understands plaintext `mwha.protocol.v1` length-prefixed frames.
 *   TLS-wrapped traffic is opaque to the frame splitter and is therefore not
 *   protocol-aware (the proxy still forwards the TLS byte stream, but frame
 *   faults cannot be applied inside it).
 * - Loopback only, mirroring T-134: a non-loopback listen or upstream host is
 *   refused before any bind/dial.
 */

// ---------------------------------------------------------------------------
// Constants and verification boundary
// ---------------------------------------------------------------------------

/** Default bind host; the proxy never binds a non-loopback interface. */
export const TCP_FAULT_PROXY_DEFAULT_HOST = '127.0.0.1';
/** Frozen frame ceiling reused from T-134 (`REPLICA_WORKER_MAX_MESSAGE_BYTES`). */
export const TCP_FAULT_PROXY_MAX_FRAME_BYTES = TCP_REPLICA_MAX_FRAME_BYTES;
/** Bounded per-direction emission queue; overflow drops and is counted. */
export const TCP_FAULT_PROXY_MAX_QUEUED_FRAMES = 256;
/** Partial reorder windows are flushed after this hold time. */
export const TCP_FAULT_PROXY_REORDER_FLUSH_MS = 100;
/** Upstream connect budget; a stalled dial tears the pair down. */
export const TCP_FAULT_PROXY_CONNECT_TIMEOUT_MS = 5_000;
/** Target write high-water mark; the source socket is paused above it. */
export const TCP_FAULT_PROXY_HIGH_WATER_BYTES = 1_048_576;

/** Fault vocabulary is the frozen T-133 list; it is never redefined here. */
export const TCP_FAULT_KINDS = mwhaFaultKinds;
export type TcpFaultKind = MwhaFaultKind;

/** Direction of one framed hop through the proxy. */
export const TCP_FAULT_DIRECTIONS = ['client-to-server', 'server-to-client'] as const;
export type TcpFaultDirection = (typeof TCP_FAULT_DIRECTIONS)[number];

export const TCP_FAULT_INJECTION_LAYER = MWHA_FAULT_INJECTION_LAYER;
export const TCP_FAULT_PROXY_VERIFICATION_SCOPE = MWHA_VERIFICATION_SCOPE;

/**
 * Scope note carried into every consumer. The injected faults describe
 * controllable TCP protocol-layer behaviour only; they are not OS-level
 * partitions, kernel failures or physical link outages.
 */
export const TCP_FAULT_PROXY_FAULT_INJECTION_SCOPE_NOTE =
  `${MWHA_FAULT_INJECTION_SCOPE_NOTE} T-138 真实 TCP 代理只对主动经过它的明文 `
  + 'mwha.protocol.v1 长度前缀帧注入整帧故障；TCP 协议层故障注入 ≠ OS 真分区，'
  + '物理三机部署、内核协议栈故障与物理链路中断均未验证。';

/** Capabilities explicitly outside this proxy's verified boundary. */
export const TCP_FAULT_PROXY_UNVERIFIED_BOUNDARIES = [
  ...MWHA_UNVERIFIED_CAPABILITIES,
  'os-firewall-partition',
  'kernel-protocol-stack-failure',
  'physical-link-outage',
  'cross-host-deployment',
] as const;

/**
 * Stable, assertion-friendly configuration/startup error codes. Runtime socket
 * failures are surfaced through the peer sockets themselves, not hidden here.
 */
export const tcpFaultProxyErrorCodes = [
  'TCP_FAULT_PROXY_CONFIG_INVALID',
  'TCP_FAULT_PROXY_NON_LOOPBACK',
  'TCP_FAULT_PROXY_RULE_INVALID',
  'TCP_FAULT_PROXY_LISTEN_FAILED',
  'TCP_FAULT_PROXY_FRAME_INVALID',
  'TCP_FAULT_PROXY_FRAME_TOO_LARGE',
] as const;
export type TcpFaultProxyErrorCode = (typeof tcpFaultProxyErrorCodes)[number];

export class TcpFaultProxyError extends Error {
  readonly code: string;

  constructor(code: string, text: string, options?: { cause?: unknown }) {
    super(`[${code}] ${text}`, options);
    this.name = 'TcpFaultProxyError';
    this.code = code;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

interface TcpFaultRuleBase {
  /** Defaults to `both`; `one-way-partition`/per-direction rules set one. */
  readonly direction?: TcpFaultDirection | 'both';
  /** 0..1; a deterministic test may set 1. Default 1. */
  readonly probability?: number;
  /** Frames to pass in this direction before the rule activates. Default 0. */
  readonly afterFrames?: number;
  /** Frames the rule applies to once active. Default unbounded. */
  readonly durationFrames?: number;
}

/**
 * One injectable rule. Rules compose: every active rule contributes its effect
 * to the same whole frame, and independent rules use independent seeded RNG
 * streams so a fixed seed reproduces the exact injection sequence.
 */
export type TcpFaultRule =
  | (TcpFaultRuleBase & { readonly kind: 'delay'; readonly delayMs: number })
  | (TcpFaultRuleBase & { readonly kind: 'drop' })
  | (TcpFaultRuleBase & { readonly kind: 'duplicate'; readonly duplicateCount: number })
  | (TcpFaultRuleBase & { readonly kind: 'reorder'; readonly reorderWindow: number })
  | (TcpFaultRuleBase & { readonly kind: 'disconnect' })
  | (TcpFaultRuleBase & { readonly kind: 'one-way-partition' })
  | (TcpFaultRuleBase & {
    readonly kind: 'bandwidth';
    readonly bandwidthBytesPerSecond: number;
    readonly burstBytes?: number;
  });

interface ResolvedFaultRule {
  readonly index: number;
  readonly kind: TcpFaultKind;
  readonly direction: TcpFaultDirection | 'both';
  readonly probability: number;
  readonly afterFrames: number;
  readonly durationFrames: number;
  readonly delayMs: number;
  readonly duplicateCount: number;
  readonly reorderWindow: number;
  readonly bandwidthBytesPerSecond: number;
  readonly burstBytes: number;
}

export interface TcpFaultProxyListenOptions {
  readonly host?: string;
  readonly port?: number;
}

export interface TcpFaultProxyUpstreamOptions {
  readonly host: string;
  readonly port: number;
}

export interface TcpFaultProxyOptions {
  /** Where the replica client connects. Defaults to loopback ephemeral. */
  readonly listen: TcpFaultProxyListenOptions;
  /** Real T-134 server behind the proxy. */
  readonly upstream: TcpFaultProxyUpstreamOptions;
  /** Deterministic seed; the same seed + same frame sequence reproduces injections. */
  readonly seed?: string | number;
  readonly rules?: readonly TcpFaultRule[];
  readonly maxFrameBytes?: number;
  readonly maxQueuedFrames?: number;
  readonly reorderFlushMs?: number;
  readonly connectTimeoutMs?: number;
}

interface ResolvedTcpFaultProxyOptions {
  readonly listenHost: string;
  readonly listenPort: number;
  readonly upstreamHost: string;
  readonly upstreamPort: number;
  readonly seedKey: string;
  readonly rules: readonly ResolvedFaultRule[];
  readonly maxFrameBytes: number;
  readonly maxQueuedFrames: number;
  readonly reorderFlushMs: number;
  readonly connectTimeoutMs: number;
}

export interface TcpFaultProxyAddress {
  readonly host: string;
  readonly port: number;
}

export interface TcpFaultProxyStats {
  /** Whole frames actually written to the target, including duplicate copies. */
  readonly forwardedFrames: number;
  /** Frames discarded by drop/one-way-partition/backpressure. */
  readonly droppedFrames: number;
  /** Extra copies emitted by duplicate rules. */
  readonly duplicatedFrames: number;
  /** Wire bytes (4-byte prefix + body) written per direction. */
  readonly bytesByDirection: {
    readonly 'client-to-server': number;
    readonly 'server-to-client': number;
  };
  readonly activeConnections: number;
  /** Client TCP connections accepted since start. */
  readonly acceptedConnections: number;
  /** Client connections torn down (pair teardown, not just accepted). */
  readonly closedConnections: number;
  /** Frames refused because the declared length exceeded the ceiling. */
  readonly oversizedFrames: number;
  /** Frames refused because the length prefix was non-positive. */
  readonly framingErrors: number;
  /** Frames dropped because a bounded emission queue was full. */
  readonly backpressureDrops: number;
  /** Frames still waiting in the bounded emission queues. */
  readonly queuedFrames: number;
}

// ---------------------------------------------------------------------------
// Options / rule validation
// ---------------------------------------------------------------------------

function positiveInt(value: number | undefined, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TcpFaultProxyError(
      'TCP_FAULT_PROXY_CONFIG_INVALID',
      `${field} must be a positive integer, got ${String(value)}`,
    );
  }
  return value;
}

function nonNegativeInt(value: number | undefined, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TcpFaultProxyError(
      'TCP_FAULT_PROXY_CONFIG_INVALID',
      `${field} must be a nonnegative integer, got ${String(value)}`,
    );
  }
  return value;
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TcpFaultProxyError('TCP_FAULT_PROXY_CONFIG_INVALID', `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function hostOf(value: Record<string, unknown>, field: string, fallback?: string): string {
  const raw = value['host'];
  if (raw === undefined) {
    if (fallback !== undefined) return fallback;
    throw new TcpFaultProxyError('TCP_FAULT_PROXY_CONFIG_INVALID', `${field}.host is required`);
  }
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new TcpFaultProxyError('TCP_FAULT_PROXY_CONFIG_INVALID', `${field}.host must be a non-empty string`);
  }
  const host = raw.trim();
  if (!isLoopbackHost(host)) {
    throw new TcpFaultProxyError(
      'TCP_FAULT_PROXY_NON_LOOPBACK',
      `${field}.host ${JSON.stringify(host)} is not loopback; the TCP fault proxy refuses external binds/dials (fail-closed)`,
    );
  }
  return host;
}

function portOf(value: Record<string, unknown>, field: string, fallback: number, min: number): number {
  const raw = value['port'];
  const port = raw === undefined ? fallback : raw;
  if (!Number.isSafeInteger(port) || (port as number) < min || (port as number) > 65_535) {
    throw new TcpFaultProxyError(
      'TCP_FAULT_PROXY_CONFIG_INVALID',
      `${field}.port must be an integer in [${String(min)}, 65535], got ${String(port)}`,
    );
  }
  return port as number;
}

function resolveRule(raw: unknown, index: number): ResolvedFaultRule {
  const rule = requireObject(raw, `rules[${String(index)}]`);
  const kind = rule['kind'];
  if (typeof kind !== 'string' || !(mwhaFaultKinds as readonly string[]).includes(kind)) {
    throw new TcpFaultProxyError(
      'TCP_FAULT_PROXY_RULE_INVALID',
      `rules[${String(index)}].kind must be one of ${mwhaFaultKinds.join('|')}, got ${String(kind)}`,
    );
  }
  const directionRaw = rule['direction'];
  const direction = directionRaw === undefined ? 'both' : directionRaw;
  if (direction !== 'both' && !(TCP_FAULT_DIRECTIONS as readonly string[]).includes(direction as string)) {
    throw new TcpFaultProxyError(
      'TCP_FAULT_PROXY_RULE_INVALID',
      `rules[${String(index)}].direction must be client-to-server|server-to-client|both, got ${String(directionRaw)}`,
    );
  }
  const probabilityRaw = rule['probability'];
  const probability = probabilityRaw === undefined ? 1 : probabilityRaw;
  if (typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new TcpFaultProxyError(
      'TCP_FAULT_PROXY_RULE_INVALID',
      `rules[${String(index)}].probability must be a finite number in [0,1]`,
    );
  }
  const afterFrames = nonNegativeInt(rule['afterFrames'] as number | undefined, 0, `rules[${String(index)}].afterFrames`);
  const durationRaw = rule['durationFrames'];
  const durationFrames = durationRaw === undefined
    ? Number.POSITIVE_INFINITY
    : positiveInt(durationRaw as number | undefined, Number.POSITIVE_INFINITY, `rules[${String(index)}].durationFrames`);
  if (durationRaw !== undefined && (!Number.isSafeInteger(durationRaw) || (durationRaw as number) < 1)) {
    throw new TcpFaultProxyError(
      'TCP_FAULT_PROXY_RULE_INVALID',
      `rules[${String(index)}].durationFrames must be a positive integer when provided`,
    );
  }

  let delayMs = 0;
  let duplicateCount = 0;
  let reorderWindow = 0;
  let bandwidthBytesPerSecond = 0;
  let burstBytes = 0;

  switch (kind) {
    case 'delay': {
      delayMs = nonNegativeInt(rule['delayMs'] as number | undefined, 0, `rules[${String(index)}].delayMs`);
      break;
    }
    case 'duplicate': {
      const count = rule['duplicateCount'];
      if (!Number.isSafeInteger(count) || (count as number) < 1 || (count as number) > 64) {
        throw new TcpFaultProxyError(
          'TCP_FAULT_PROXY_RULE_INVALID',
          `rules[${String(index)}].duplicateCount must be an integer in [1,64]`,
        );
      }
      duplicateCount = count as number;
      break;
    }
    case 'reorder': {
      const window = rule['reorderWindow'];
      if (!Number.isSafeInteger(window) || (window as number) < 2 || (window as number) > 256) {
        throw new TcpFaultProxyError(
          'TCP_FAULT_PROXY_RULE_INVALID',
          `rules[${String(index)}].reorderWindow must be an integer in [2,256]`,
        );
      }
      reorderWindow = window as number;
      break;
    }
    case 'bandwidth': {
      const rate = rule['bandwidthBytesPerSecond'];
      if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
        throw new TcpFaultProxyError(
          'TCP_FAULT_PROXY_RULE_INVALID',
          `rules[${String(index)}].bandwidthBytesPerSecond must be a positive finite number`,
        );
      }
      bandwidthBytesPerSecond = rate;
      const burstRaw = rule['burstBytes'];
      burstBytes = burstRaw === undefined
        ? Math.min(Math.max(1_024, Math.ceil(rate / 2)), 65_536)
        : positiveInt(burstRaw as number | undefined, 1, `rules[${String(index)}].burstBytes`);
      break;
    }
    case 'drop':
    case 'disconnect':
    case 'one-way-partition': {
      break;
    }
    default: {
      throw new TcpFaultProxyError(
        'TCP_FAULT_PROXY_RULE_INVALID',
        `rules[${String(index)}].kind ${String(kind)} is not supported by this proxy`,
      );
    }
  }

  return {
    index,
    kind: kind as TcpFaultKind,
    direction: direction as TcpFaultDirection | 'both',
    probability,
    afterFrames,
    durationFrames,
    delayMs,
    duplicateCount,
    reorderWindow,
    bandwidthBytesPerSecond,
    burstBytes,
  };
}

function resolveOptions(options: TcpFaultProxyOptions): ResolvedTcpFaultProxyOptions {
  const root = requireObject(options, 'proxy options');
  const listen = requireObject(root['listen'], 'listen');
  const upstream = requireObject(root['upstream'], 'upstream');
  const listenHost = hostOf(listen, 'listen', TCP_FAULT_PROXY_DEFAULT_HOST);
  const listenPort = portOf(listen, 'listen', 0, 0);
  const upstreamHost = hostOf(upstream, 'upstream');
  const upstreamPort = portOf(upstream, 'upstream', 0, 1);

  const seedRaw = root['seed'];
  if (seedRaw !== undefined && typeof seedRaw !== 'string' && typeof seedRaw !== 'number') {
    throw new TcpFaultProxyError('TCP_FAULT_PROXY_CONFIG_INVALID', 'seed must be a string or number');
  }
  if (typeof seedRaw === 'number' && !Number.isFinite(seedRaw)) {
    throw new TcpFaultProxyError('TCP_FAULT_PROXY_CONFIG_INVALID', 'seed must be finite when numeric');
  }
  const seedKey = seedRaw === undefined
    ? 'mwha-tcp-fault-proxy-default'
    : typeof seedRaw === 'number'
      ? `n:${String(seedRaw)}`
      : `s:${seedRaw}`;

  const rawRules = root['rules'] === undefined ? [] : root['rules'];
  if (!Array.isArray(rawRules)) {
    throw new TcpFaultProxyError('TCP_FAULT_PROXY_CONFIG_INVALID', 'rules must be an array');
  }
  const rules = rawRules.map((rule, index) => resolveRule(rule, index));

  return {
    listenHost,
    listenPort,
    upstreamHost,
    upstreamPort,
    seedKey,
    rules,
    maxFrameBytes: positiveInt(root['maxFrameBytes'] as number | undefined, TCP_FAULT_PROXY_MAX_FRAME_BYTES, 'maxFrameBytes'),
    maxQueuedFrames: Math.min(
      4_096,
      positiveInt(root['maxQueuedFrames'] as number | undefined, TCP_FAULT_PROXY_MAX_QUEUED_FRAMES, 'maxQueuedFrames'),
    ),
    reorderFlushMs: positiveInt(root['reorderFlushMs'] as number | undefined, TCP_FAULT_PROXY_REORDER_FLUSH_MS, 'reorderFlushMs'),
    connectTimeoutMs: positiveInt(root['connectTimeoutMs'] as number | undefined, TCP_FAULT_PROXY_CONNECT_TIMEOUT_MS, 'connectTimeoutMs'),
  };
}

// ---------------------------------------------------------------------------
// Deterministic RNG and token bucket
// ---------------------------------------------------------------------------

function hashSeed(text: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

/** mulberry32: small, deterministic, adequate for test fault sequences. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return (): number => {
    state = (state + 0x6d_2b_79_f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * Bytes-per-second token bucket used by the bandwidth rule. Tokens start at
 * `burstBytes` (the initial allowance) and refill up to `capacityBytes`, which
 * the caller sets to at least one maximum frame so an oversized frame can
 * eventually accumulate enough tokens instead of deadlocking the direction.
 */
class TokenBucket {
  private readonly rateBytesPerSec: number;
  private readonly capacityBytes: number;
  private tokens: number;
  private lastRefillMs: number;

  constructor(rateBytesPerSec: number, burstBytes: number, capacityBytes: number) {
    this.rateBytesPerSec = rateBytesPerSec;
    this.capacityBytes = Math.max(capacityBytes, burstBytes);
    this.tokens = burstBytes;
    this.lastRefillMs = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsedMs = Math.max(0, now - this.lastRefillMs);
    this.lastRefillMs = now;
    this.tokens = Math.min(this.capacityBytes, this.tokens + (elapsedMs / 1_000) * this.rateBytesPerSec);
  }

  tryTake(bytes: number): boolean {
    this.refill();
    if (this.tokens >= bytes) {
      this.tokens -= bytes;
      return true;
    }
    return false;
  }

  msUntil(bytes: number): number {
    this.refill();
    if (this.tokens >= bytes) return 0;
    return Math.ceil(((bytes - this.tokens) / this.rateBytesPerSec) * 1_000);
  }
}

// ---------------------------------------------------------------------------
// Length-prefixed frame splitter (whole frames only; never byte-level replay)
// ---------------------------------------------------------------------------

interface FrameSplitOutcome {
  readonly frames: readonly Buffer[];
  readonly error: { readonly code: TcpFaultProxyErrorCode; readonly text: string } | null;
}

/**
 * Splits a byte stream on the frozen 4-byte big-endian length prefix. Every
 * fault decision downstream operates on one complete body buffer, so a frame
 * boundary can never be broken and arbitrary-byte reordering is impossible.
 */
class LengthPrefixedFrameSplitter {
  private readonly maxFrameBytes: number;
  private buffer: Buffer = Buffer.alloc(0);

  constructor(maxFrameBytes: number) {
    this.maxFrameBytes = maxFrameBytes;
  }

  push(chunk: Buffer): FrameSplitOutcome {
    this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk]);
    const frames: Buffer[] = [];
    for (;;) {
      if (this.buffer.length < 4) return { frames, error: null };
      const length = this.buffer.readUInt32BE(0);
      if (length <= 0) {
        this.buffer = Buffer.alloc(0);
        return {
          frames,
          error: { code: 'TCP_FAULT_PROXY_FRAME_INVALID', text: `frame length ${String(length)} is not positive` },
        };
      }
      if (length > this.maxFrameBytes) {
        this.buffer = Buffer.alloc(0);
        return {
          frames,
          error: {
            code: 'TCP_FAULT_PROXY_FRAME_TOO_LARGE',
            text: `frame length ${String(length)} exceeds the ${String(this.maxFrameBytes)} byte limit`,
          },
        };
      }
      if (this.buffer.length < 4 + length) return { frames, error: null };
      // Copy the body: a subarray would pin the whole accumulated chunk.
      frames.push(Buffer.from(this.buffer.subarray(4, 4 + length)));
      this.buffer = this.buffer.subarray(4 + length);
      if (this.buffer.length === 0) this.buffer = Buffer.alloc(0);
    }
  }
}

// ---------------------------------------------------------------------------
// Connection runtime
// ---------------------------------------------------------------------------

interface QueuedFrame {
  readonly body: Buffer;
  readonly notBeforeMs: number;
  readonly bucket: TokenBucket | null;
}

interface DirectionRuntime {
  framesSeen: number;
  queue: QueuedFrame[];
  reorderBuffer: Buffer[];
  reorderTimer: NodeJS.Timeout | null;
  pumpTimer: NodeJS.Timeout | null;
  splitters: LengthPrefixedFrameSplitter;
}

interface ProxyConnection {
  readonly id: number;
  readonly client: net.Socket;
  upstream: net.Socket | null;
  closed: boolean;
  readonly directions: {
    readonly 'client-to-server': DirectionRuntime;
    readonly 'server-to-client': DirectionRuntime;
  };
  readonly rngs: Map<string, () => number>;
  readonly buckets: Map<string, TokenBucket>;
}

function newDirectionRuntime(maxFrameBytes: number): DirectionRuntime {
  return {
    framesSeen: 0,
    queue: [],
    reorderBuffer: [],
    reorderTimer: null,
    pumpTimer: null,
    splitters: new LengthPrefixedFrameSplitter(maxFrameBytes),
  };
}

// ---------------------------------------------------------------------------
// Proxy
// ---------------------------------------------------------------------------

/**
 * One listening TCP fault proxy. Each accepted client socket owns exactly one
 * upstream socket; both directions are framed, metered and independently
 * faulted. All timers and sockets are bounded and released by {@link close}.
 */
export class TcpFaultProxy {
  readonly #options: ResolvedTcpFaultProxyOptions;
  #server: net.Server | null = null;
  #address: TcpFaultProxyAddress | null = null;
  readonly #connections = new Set<ProxyConnection>();
  #nextConnectionId = 1;
  #closed = false;

  #forwardedFrames = 0;
  #droppedFrames = 0;
  #duplicatedFrames = 0;
  #bytesClientToServer = 0;
  #bytesServerToClient = 0;
  #acceptedConnections = 0;
  #closedConnections = 0;
  #oversizedFrames = 0;
  #framingErrors = 0;
  #backpressureDrops = 0;

  constructor(options: TcpFaultProxyOptions) {
    this.#options = resolveOptions(options);
  }

  /** Start listening and return the live proxy. Refuses non-loopback before bind. */
  static async start(options: TcpFaultProxyOptions): Promise<TcpFaultProxy> {
    const proxy = new TcpFaultProxy(options);
    await proxy.#listen();
    return proxy;
  }

  get address(): TcpFaultProxyAddress | null {
    return this.#address;
  }

  get isClosed(): boolean {
    return this.#closed;
  }

  /** Point-in-time counters. Decision counts are reproducible under a fixed seed. */
  stats(): TcpFaultProxyStats {
    let queued = 0;
    for (const connection of this.#connections) {
      queued += connection.directions['client-to-server'].queue.length;
      queued += connection.directions['server-to-client'].queue.length;
    }
    return {
      forwardedFrames: this.#forwardedFrames,
      droppedFrames: this.#droppedFrames,
      duplicatedFrames: this.#duplicatedFrames,
      bytesByDirection: {
        'client-to-server': this.#bytesClientToServer,
        'server-to-client': this.#bytesServerToClient,
      },
      activeConnections: this.#connections.size,
      acceptedConnections: this.#acceptedConnections,
      closedConnections: this.#closedConnections,
      oversizedFrames: this.#oversizedFrames,
      framingErrors: this.#framingErrors,
      backpressureDrops: this.#backpressureDrops,
      queuedFrames: queued,
    };
  }

  /**
   * Idempotent shutdown: tear down every client/upstream socket, release the
   * listener and clear every timer. A second call returns immediately.
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const connection of [...this.#connections]) this.#teardown(connection);
    const server = this.#server;
    this.#server = null;
    this.#address = null;
    if (server === null) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      server.close(() => finish());
      // Sockets were destroyed above; do not wait forever if one lingers.
      const guard = setTimeout(finish, 2_000);
      guard.unref?.();
    });
  }

  // -- lifecycle -----------------------------------------------------------

  async #listen(): Promise<void> {
    if (this.#closed) {
      throw new TcpFaultProxyError('TCP_FAULT_PROXY_LISTEN_FAILED', 'proxy is closed and cannot listen again');
    }
    // Fail closed before creating the listener.
    if (!isLoopbackHost(this.#options.listenHost)) {
      throw new TcpFaultProxyError('TCP_FAULT_PROXY_NON_LOOPBACK', `listen host ${JSON.stringify(this.#options.listenHost)} is not loopback`);
    }
    const server = net.createServer((socket: net.Socket) => this.#onClient(socket));
    server.on('error', (error: Error) => {
      // Listen-time failures surface through the pending start promise below.
      void error;
    });
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const onError = (error: Error): void => {
        if (settled) return;
        settled = true;
        server.removeListener('listening', onListening);
        reject(new TcpFaultProxyError(
          'TCP_FAULT_PROXY_LISTEN_FAILED',
          `failed to listen on ${this.#options.listenHost}:${String(this.#options.listenPort)}: ${message(error)}`,
          { cause: error },
        ));
      };
      const onListening = (): void => {
        if (settled) return;
        settled = true;
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      try {
        server.listen({ host: this.#options.listenHost, port: this.#options.listenPort });
      } catch (error) {
        onError(error as Error);
      }
    });
    const address = server.address();
    if (address === null || typeof address !== 'object') {
      await this.close();
      throw new TcpFaultProxyError('TCP_FAULT_PROXY_LISTEN_FAILED', 'listener did not report an address');
    }
    this.#server = server;
    this.#address = { host: this.#options.listenHost, port: address.port };
  }

  #onClient(client: net.Socket): void {
    if (this.#closed) {
      client.destroy();
      return;
    }
    const connection: ProxyConnection = {
      id: this.#nextConnectionId,
      client,
      upstream: null,
      closed: false,
      directions: {
        'client-to-server': newDirectionRuntime(this.#options.maxFrameBytes),
        'server-to-client': newDirectionRuntime(this.#options.maxFrameBytes),
      },
      rngs: new Map<string, () => number>(),
      buckets: new Map<string, TokenBucket>(),
    };
    this.#nextConnectionId += 1;
    this.#connections.add(connection);
    this.#acceptedConnections += 1;

    client.setNoDelay(true);
    client.on('error', () => this.#teardown(connection));
    client.on('close', () => this.#teardown(connection));
    client.on('data', (chunk: Buffer) => this.#ingest(connection, 'client-to-server', chunk));

    const upstream = net.connect({ host: this.#options.upstreamHost, port: this.#options.upstreamPort });
    connection.upstream = upstream;
    upstream.setNoDelay(true);
    upstream.on('error', () => this.#teardown(connection));
    upstream.on('close', () => this.#teardown(connection));
    upstream.on('data', (chunk: Buffer) => this.#ingest(connection, 'server-to-client', chunk));

    // Bounded backpressure: pause the source when the target's kernel buffer is
    // deep, resume on drain. Both sockets stay live.
    client.on('drain', () => {
      if (!connection.closed) upstream.resume();
    });
    upstream.on('drain', () => {
      if (!connection.closed) client.resume();
    });

    if (this.#options.connectTimeoutMs > 0) {
      const guard = setTimeout(() => {
        if (connection.closed) return;
        upstream.destroy();
        this.#teardown(connection);
      }, this.#options.connectTimeoutMs);
      guard.unref?.();
      upstream.once('connect', () => clearTimeout(guard));
    }
  }

  #ingest(connection: ProxyConnection, direction: TcpFaultDirection, chunk: Buffer): void {
    if (connection.closed) return;
    const outcome = connection.directions[direction].splitters.push(chunk);
    if (outcome.error !== null) {
      if (outcome.error.code === 'TCP_FAULT_PROXY_FRAME_TOO_LARGE') this.#oversizedFrames += 1;
      else this.#framingErrors += 1;
      this.#teardown(connection);
      return;
    }
    for (const body of outcome.frames) this.#processFrame(connection, direction, body);
  }

  #rngFor(connection: ProxyConnection, rule: ResolvedFaultRule, direction: TcpFaultDirection): () => number {
    const key = `${String(rule.index)}\u0000${direction}`;
    const cached = connection.rngs.get(key);
    if (cached !== undefined) return cached;
    const created = mulberry32(hashSeed(`${this.#options.seedKey}\u0000${key}`));
    connection.rngs.set(key, created);
    return created;
  }

  #bucketFor(connection: ProxyConnection, rule: ResolvedFaultRule, direction: TcpFaultDirection): TokenBucket {
    const key = `${String(rule.index)}\u0000${direction}`;
    const cached = connection.buckets.get(key);
    if (cached !== undefined) return cached;
    const created = new TokenBucket(
      rule.bandwidthBytesPerSecond,
      rule.burstBytes,
      Math.max(rule.burstBytes, this.#options.maxFrameBytes),
    );
    connection.buckets.set(key, created);
    return created;
  }

  /**
   * Apply every active rule to one whole frame, then enqueue the resulting
   * copies. Drop and one-way-partition are terminal; disconnect tears the pair
   * down; duplicate multiplies; reorder permutes only complete frames.
   */
  #processFrame(connection: ProxyConnection, direction: TcpFaultDirection, body: Buffer): void {
    const runtime = connection.directions[direction];
    runtime.framesSeen += 1;
    const seen = runtime.framesSeen;
    const active: ResolvedFaultRule[] = [];
    for (const rule of this.#options.rules) {
      if (rule.direction !== 'both' && rule.direction !== direction) continue;
      if (seen <= rule.afterFrames) continue;
      if (seen > rule.afterFrames + rule.durationFrames) continue;
      if (rule.probability < 1 && this.#rngFor(connection, rule, direction)() >= rule.probability) continue;
      active.push(rule);
    }

    if (active.some((rule) => rule.kind === 'disconnect')) {
      this.#teardown(connection);
      return;
    }
    if (active.some((rule) => rule.kind === 'one-way-partition')) {
      this.#droppedFrames += 1;
      return;
    }
    if (active.some((rule) => rule.kind === 'drop')) {
      this.#droppedFrames += 1;
      return;
    }

    let copies = 1;
    for (const rule of active) {
      if (rule.kind === 'duplicate') copies += rule.duplicateCount;
    }
    if (copies > 1) this.#duplicatedFrames += copies - 1;

    let delayMs = 0;
    let bucket: TokenBucket | null = null;
    let reorder: ResolvedFaultRule | null = null;
    for (const rule of active) {
      if (rule.kind === 'delay') delayMs = Math.max(delayMs, rule.delayMs);
      else if (rule.kind === 'bandwidth') bucket = this.#bucketFor(connection, rule, direction);
      else if (rule.kind === 'reorder') reorder = rule;
    }

    const notBeforeMs = Date.now() + delayMs;
    if (reorder !== null) {
      for (let copy = 0; copy < copies; copy += 1) {
        runtime.reorderBuffer.push(Buffer.from(body));
      }
      if (runtime.reorderBuffer.length >= reorder.reorderWindow) {
        this.#flushReorder(connection, direction, reorder, bucket);
      } else {
        this.#ensureReorderTimer(connection, direction, reorder, bucket);
      }
      return;
    }
    for (let copy = 0; copy < copies; copy += 1) {
      this.#enqueue(connection, direction, { body: Buffer.from(body), notBeforeMs, bucket });
    }
  }

  #ensureReorderTimer(
    connection: ProxyConnection,
    direction: TcpFaultDirection,
    rule: ResolvedFaultRule,
    bucket: TokenBucket | null,
  ): void {
    const runtime = connection.directions[direction];
    if (runtime.reorderTimer !== null || runtime.reorderBuffer.length === 0) return;
    runtime.reorderTimer = setTimeout(() => {
      runtime.reorderTimer = null;
      if (connection.closed) return;
      this.#flushReorder(connection, direction, rule, bucket);
    }, this.#options.reorderFlushMs);
    runtime.reorderTimer.unref?.();
  }

  /** Permute one bounded group of complete frames with the rule's seeded RNG. */
  #flushReorder(
    connection: ProxyConnection,
    direction: TcpFaultDirection,
    rule: ResolvedFaultRule,
    bucket: TokenBucket | null,
  ): void {
    const runtime = connection.directions[direction];
    if (runtime.reorderTimer !== null) {
      clearTimeout(runtime.reorderTimer);
      runtime.reorderTimer = null;
    }
    const groupSize = Math.min(rule.reorderWindow, runtime.reorderBuffer.length);
    if (groupSize <= 0) return;
    const group = runtime.reorderBuffer.splice(0, groupSize);
    const rng = this.#rngFor(connection, rule, direction);
    for (let index = group.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(rng() * (index + 1));
      const left = group[index]!;
      const right = group[swap]!;
      group[index] = right;
      group[swap] = left;
    }
    const notBeforeMs = Date.now();
    for (const body of group) {
      this.#enqueue(connection, direction, { body, notBeforeMs, bucket });
    }
  }

  #enqueue(connection: ProxyConnection, direction: TcpFaultDirection, item: QueuedFrame): void {
    const runtime = connection.directions[direction];
    if (runtime.queue.length >= this.#options.maxQueuedFrames) {
      this.#backpressureDrops += 1;
      return;
    }
    runtime.queue.push(item);
    this.#pump(connection, direction);
  }

  /** Sequential emission per direction: one in-flight scheduler, bounded queue. */
  #pump(connection: ProxyConnection, direction: TcpFaultDirection): void {
    const runtime = connection.directions[direction];
    if (connection.closed || runtime.pumpTimer !== null) return;

    const step = (): void => {
      runtime.pumpTimer = null;
      if (connection.closed) return;
      const item = runtime.queue[0];
      if (item === undefined) return;
      const now = Date.now();
      if (item.notBeforeMs > now) {
        this.#schedulePump(connection, direction, item.notBeforeMs - now);
        return;
      }
      if (item.bucket !== null && !item.bucket.tryTake(item.body.length + 4)) {
        this.#schedulePump(connection, direction, Math.max(1, item.bucket.msUntil(item.body.length + 4)));
        return;
      }
      runtime.queue.shift();
      const target = direction === 'client-to-server' ? connection.upstream : connection.client;
      if (target === null || target.destroyed || !target.writable) {
        this.#schedulePump(connection, direction, 10);
        return;
      }
      const wire = Buffer.allocUnsafe(4 + item.body.length);
      wire.writeUInt32BE(item.body.length, 0);
      item.body.copy(wire, 4);
      try {
        target.write(wire);
      } catch (error) {
        this.#teardown(connection);
        void error;
        return;
      }
      this.#forwardedFrames += 1;
      if (direction === 'client-to-server') this.#bytesClientToServer += wire.length;
      else this.#bytesServerToClient += wire.length;
      if (target.writableLength > TCP_FAULT_PROXY_HIGH_WATER_BYTES) {
        const source = direction === 'client-to-server' ? connection.client : connection.upstream;
        source?.pause();
      }
      this.#pump(connection, direction);
    };

    step();
  }

  #schedulePump(connection: ProxyConnection, direction: TcpFaultDirection, delayMs: number): void {
    const runtime = connection.directions[direction];
    if (connection.closed || runtime.pumpTimer !== null) return;
    const timer = setTimeout(() => {
      runtime.pumpTimer = null;
      this.#pump(connection, direction);
    }, Math.max(1, delayMs));
    timer.unref?.();
    runtime.pumpTimer = timer;
  }

  #teardown(connection: ProxyConnection): void {
    if (connection.closed) return;
    connection.closed = true;
    this.#connections.delete(connection);
    this.#closedConnections += 1;
    for (const direction of TCP_FAULT_DIRECTIONS) {
      const runtime = connection.directions[direction];
      if (runtime.pumpTimer !== null) clearTimeout(runtime.pumpTimer);
      if (runtime.reorderTimer !== null) clearTimeout(runtime.reorderTimer);
      runtime.pumpTimer = null;
      runtime.reorderTimer = null;
      runtime.queue.length = 0;
      runtime.reorderBuffer.length = 0;
    }
    connection.client.removeAllListeners();
    connection.client.destroy();
    const upstream = connection.upstream;
    connection.upstream = null;
    if (upstream !== null) {
      upstream.removeAllListeners();
      upstream.destroy();
    }
  }
}
