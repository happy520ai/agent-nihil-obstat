import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import * as net from 'node:net';
import * as tls from 'node:tls';
import { z } from 'zod';
import {
  HaProtocolError,
  MWHA_ADJUDICATION_SCHEMA_VERSION,
  MWHA_CLUSTER_LOG_ENTRY_SCHEMA_VERSION,
  MWHA_EVENT_SCHEMA_VERSION,
  MWHA_FAULT_INJECTION_LAYER,
  MWHA_FAULT_INJECTION_SCOPE_NOTE,
  MWHA_PROTOCOL_SCHEMA_VERSION,
  MWHA_VERIFICATION_SCOPE,
  MWHA_VERIFICATION_SCOPE_NOTE,
  mwhaAdjudicationSchema,
  mwhaClockObservationSchema,
  mwhaClusterLogEntrySchema,
  mwhaFaultInjectionSchema,
  mwhaLeaderLeaseSchema,
  mwhaTopologySchema,
  mwhaWriterEventSchema,
  type MwhaAdjudication,
  type MwhaClockObservation,
  type MwhaClusterLogEntry,
  type MwhaFaultInjection,
  type MwhaLeaderLease,
  type MwhaTopology,
  type MwhaWriterEvent,
} from './ha-protocol.ts';
import { RemoteReplicaStore } from './replica-transport.ts';
import {
  type AnchorProbeRequest,
  type AnchorProbeSnapshot,
} from './probe-contract.ts';
import {
  authorizeReplica,
  assertClusterPolicy,
  type ClusterOperation,
  type ClusterPolicy,
} from './cluster-policy.ts';
import {
  type DistributedNodeQuery,
  type DistributedNodeResponse,
  type DistributedReplicaNode,
  type DistributedReplicaState,
} from './distributed-probe.ts';
import type { CommittedEventEnvelope, ReplicationReport } from './replication.ts';
import {
  TCP_REPLICA_MAX_FRAME_BYTES,
  TcpReplicaFrameDecoder,
  TcpTransportError,
  encodeTcpReplicaFrame,
  invalid,
  NODE_ID_PATTERN,
  parsePayload,
  parseTcpApplyPayload,
  parseTcpAuthPayload,
  parseTcpCancelPayload,
  parseTcpHelloPayload,
  parseTcpQueryPayload,
  tcpReplicaFailureSchema,
  tcpReplicaSuccessSchema,
  tcpStatusPayloadSchema,
  tcpStatusResultSchema,
} from './tcp-frame-codec.ts';
import { TcpClientPendingTable } from './tcp-connection.ts';
import type {
  TcpApplyPayload,
  TcpReplicaKind,
  TcpReplicaRequest,
  TcpReplicaStatusView,
  TcpReplicaWireMessage,
} from './tcp-frame-codec.ts';

export {
  TCP_REPLICA_MAX_APPLY_EVENTS,
  TCP_REPLICA_MAX_FRAME_BYTES,
  TcpReplicaFrameDecoder,
  TcpTransportError,
  encodeTcpReplicaFrame,
  parseTcpApplyPayload,
  parseTcpAuthPayload,
  parseTcpCancelPayload,
  parseTcpHelloPayload,
  parseTcpQueryPayload,
  tcpApplyEventGuardSchema,
  tcpApplyPayloadSchema,
  tcpAuthPayloadSchema,
  tcpHelloPayloadSchema,
  tcpQueryPayloadSchema,
  tcpReplicaErrorCodes,
  tcpReplicaFailureSchema,
  tcpReplicaInboundSchema,
  tcpReplicaKinds,
  tcpReplicaRequestSchema,
  tcpReplicaSuccessSchema,
  tcpStatusPayloadSchema,
  tcpStatusResultSchema,
} from './tcp-frame-codec.ts';
export type {
  TcpApplyPayload,
  TcpAuthPayload,
  TcpFrameDecodeOutcome,
  TcpHelloPayload,
  TcpReplicaErrorCode,
  TcpReplicaFailure,
  TcpReplicaKind,
  TcpReplicaRequest,
  TcpReplicaStatusView,
  TcpReplicaSuccess,
  TcpReplicaWireMessage,
} from './tcp-frame-codec.ts';

/**
 * T-134 / ADR-012 §10–§12: real local TCP/TLS replica transport with node
 * authentication.
 *
 * This module is an *additional* transport seam: it opens real
 * `node:net`/`node:tls` sockets so two independent local nodes can exchange
 * `query`/`apply`/`status` frames. It deliberately does NOT replace or delete
 * M15's `ChildProcessReplicaTransport` (`replica-transport.ts` is untouched
 * and remains the default local carrier).
 *
 * Verified scope (and nothing more):
 * - real TCP framing, request/response correlation, bounds, timeouts,
 *   cancellation and idempotent close on 127.0.0.1/::1;
 * - HMAC-SHA256 hello/challenge-response node authentication with bounded
 *   replay-nonce tracking;
 * - loopback plaintext + HMAC, and TLS on loopback or non-loopback;
 * - non-loopback plaintext refused before any bind.
 *
 * Explicitly NOT verified / NOT implemented here: physical cross-machine
 * deployment, production HA failover, availability SLAs, OS-level partitions
 * and cross-host clock rollback (see {@link TCP_TRANSPORT_UNVERIFIED_BOUNDARIES});
 * election, fencing, multi-writer commit, adjudication, clocks and fault
 * agents are T-136+.
 *
 * The shared secret only ever lives in process memory or test injection. It is
 * never printed, logged, written to a report or persisted by this module.
 */

// ---------------------------------------------------------------------------
// Constants, error vocabulary and verification boundary
// ---------------------------------------------------------------------------


export const TCP_REPLICA_DEFAULT_HOST = '127.0.0.1';
export const TCP_REPLICA_DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
export const TCP_REPLICA_DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;
export const TCP_REPLICA_DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
export const TCP_REPLICA_DEFAULT_IDLE_TIMEOUT_MS = 60_000;
/** T-158: how long a client waits for a cancel ack before releasing the link. */
export const TCP_REPLICA_DEFAULT_CANCEL_GRACE_MS = 250;
export const TCP_REPLICA_NONCE_BYTES = 32;
export const TCP_REPLICA_MAX_PENDING_REQUESTS = 256;
export const TCP_REPLICA_MAX_PENDING_CHALLENGES = 256;
export const TCP_REPLICA_MAX_USED_NONCES = 4_096;


/** Cross-machine / production capabilities this task does not verify. */
export const TCP_TRANSPORT_UNVERIFIED_BOUNDARIES = [
  'physical-cross-machine-deployment',
  'production-ha-failover',
  'availability-sla',
  'os-level-network-partition',
  'cross-host-clock-rollback',
] as const;

/** Scope marker re-exported from the frozen contract; local TCP only. */
export const TCP_TRANSPORT_VERIFICATION_SCOPE = MWHA_VERIFICATION_SCOPE;
export const TCP_TRANSPORT_VERIFICATION_NOTE =
  `${MWHA_VERIFICATION_SCOPE_NOTE} T-134 仅证明本地真实 TCP/TLS 与节点认证；`
  + '物理跨机部署、生产 HA 故障切换、OS 真分区与可用性 SLA 均未验证。';
/** Fault-injection scope note is carried unchanged; TCP transport is not an OS partition. */
export const TCP_TRANSPORT_FAULT_INJECTION_SCOPE_NOTE = MWHA_FAULT_INJECTION_SCOPE_NOTE;
export const TCP_TRANSPORT_FAULT_INJECTION_LAYER = MWHA_FAULT_INJECTION_LAYER;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function positiveInt(value: number | undefined, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TcpTransportError('TCP_CONFIG_INVALID', `${field} must be a positive integer, got ${String(value)}`);
  }
  return value;
}

function nonNegativeInt(value: number | undefined, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TcpTransportError('TCP_CONFIG_INVALID', `${field} must be a nonnegative integer, got ${String(value)}`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Loopback policy
// ---------------------------------------------------------------------------

const LOOPBACK_HOST_NAMES = new Set(['localhost', '127.0.0.1', '::1']);
const LOOPBACK_IPV4_RANGE = /^127(?:\.\d{1,3}){3}$/u;

/**
 * True only for hosts that cannot reach off-box interfaces: `localhost`,
 * `::1` and the whole 127.0.0.0/8 range. Wildcards such as `0.0.0.0`/`::` and
 * documentation addresses such as `192.0.2.1` are non-loopback.
 */
export function isLoopbackHost(host: string): boolean {
  if (typeof host !== 'string') return false;
  const normalized = host.trim().toLowerCase();
  if (LOOPBACK_HOST_NAMES.has(normalized)) return true;
  const unwrapped = normalized.startsWith('[') && normalized.endsWith(']') ? normalized.slice(1, -1) : normalized;
  return LOOPBACK_HOST_NAMES.has(unwrapped) || LOOPBACK_IPV4_RANGE.test(unwrapped);
}

function assertBindAllowed(host: string, tlsConfig: unknown): void {
  if (!isLoopbackHost(host) && tlsConfig === undefined) {
    throw new TcpTransportError(
      'TCP_TLS_REQUIRED',
      `host ${JSON.stringify(host)} is not loopback; TLS is mandatory for non-loopback listeners/clients (fail-closed, no bind attempted)`,
    );
  }
}



// ---------------------------------------------------------------------------
// Frozen HA payload validators (T-137+ seam; schemas are never redefined)
// ---------------------------------------------------------------------------

function haPayloadError(kind: string, result: { success: false; error: z.ZodError }): HaProtocolError {
  const issue = result.error.issues[0];
  const detail = issue === undefined ? 'schema violation' : `${issue.path.join('.') || kind}: ${issue.message}`;
  return new HaProtocolError('HA_INPUT_INVALID', `${kind} payload violates the frozen ha-protocol schema (${detail})`);
}

export function assertMwhaWriterEvent(value: unknown): MwhaWriterEvent {
  const result = mwhaWriterEventSchema.safeParse(value);
  if (!result.success) throw haPayloadError(MWHA_EVENT_SCHEMA_VERSION, result as { success: false; error: z.ZodError });
  return result.data;
}

export function assertMwhaClusterLogEntry(value: unknown): MwhaClusterLogEntry {
  const result = mwhaClusterLogEntrySchema.safeParse(value);
  if (!result.success) throw haPayloadError(MWHA_CLUSTER_LOG_ENTRY_SCHEMA_VERSION, result as { success: false; error: z.ZodError });
  return result.data;
}

export function assertMwhaLeaderLease(value: unknown): MwhaLeaderLease {
  const result = mwhaLeaderLeaseSchema.safeParse(value);
  if (!result.success) throw haPayloadError('mwha.leader-lease', result as { success: false; error: z.ZodError });
  return result.data;
}

export function assertMwhaTopology(value: unknown): MwhaTopology {
  const result = mwhaTopologySchema.safeParse(value);
  if (!result.success) throw haPayloadError('mwha.topology', result as { success: false; error: z.ZodError });
  return result.data;
}

export function assertMwhaAdjudication(value: unknown): MwhaAdjudication {
  const result = mwhaAdjudicationSchema.safeParse(value);
  if (!result.success) throw haPayloadError(MWHA_ADJUDICATION_SCHEMA_VERSION, result as { success: false; error: z.ZodError });
  return result.data;
}

export function assertMwhaClockObservation(value: unknown): MwhaClockObservation {
  const result = mwhaClockObservationSchema.safeParse(value);
  if (!result.success) throw haPayloadError('mwha.clock-observation', result as { success: false; error: z.ZodError });
  return result.data;
}

export function assertMwhaFaultInjection(value: unknown): MwhaFaultInjection {
  const result = mwhaFaultInjectionSchema.safeParse(value);
  if (!result.success) throw haPayloadError(MWHA_PROTOCOL_SCHEMA_VERSION, result as { success: false; error: z.ZodError });
  return result.data;
}


// ---------------------------------------------------------------------------
// Authentication primitives
// ---------------------------------------------------------------------------

export function generateNonce(): string {
  return randomBytes(TCP_REPLICA_NONCE_BYTES).toString('hex');
}

/**
 * HMAC-SHA256 challenge binding `nodeId`, the client nonce and the server
 * nonce. The secret is used only in memory and is never returned/logged.
 */
export function challengeSignature(
  sharedSecret: string | Buffer,
  nodeId: string,
  nonce: string,
  serverNonce: string,
): string {
  return createHmac('sha256', sharedSecret)
    .update(`${nodeId}\u0000${nonce}\u0000${serverNonce}`, 'utf8')
    .digest('hex');
}

function signaturesMatch(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Server-side service contract
// ---------------------------------------------------------------------------

export interface TcpReplicaServiceContext {
  /** Authenticated peer node id (never taken from the remote payload). */
  readonly nodeId: string;
  readonly projectScope?: string;
  /** T-158: aborted when the peer cancels this request (cooperative stop). */
  readonly signal?: AbortSignal;
}

export interface TcpReplicaService {
  readonly query?: (
    request: AnchorProbeRequest,
    context: TcpReplicaServiceContext,
  ) => DistributedNodeResponse | Promise<DistributedNodeResponse>;
  readonly apply?: (
    events: readonly CommittedEventEnvelope[],
    context: TcpReplicaServiceContext,
  ) => ReplicationReport | Promise<ReplicationReport>;
  readonly status?: (context: TcpReplicaServiceContext) => TcpReplicaStatusView | Promise<TcpReplicaStatusView>;
}

export interface TcpServerTlsOptions {
  readonly key: string | Buffer;
  readonly cert: string | Buffer;
  readonly ca?: string | Buffer | (string | Buffer)[];
  /** Mutual TLS: require a client certificate signed by `ca`. */
  readonly requestCert?: boolean;
  readonly rejectUnauthorized?: boolean;
}

export type TcpAuthorizer = (
  nodeId: string,
  operation: ClusterOperation,
  projectScope?: string,
) => boolean | { readonly allowed: boolean; readonly code?: string; readonly reason?: string };

export interface TcpReplicaServerOptions {
  /** Defaults to `127.0.0.1`; a non-loopback host requires `tls`. */
  readonly host?: string;
  /** Defaults to 0 (ephemeral port). */
  readonly port?: number;
  /** Required for non-loopback hosts; optional but supported on loopback. */
  readonly tls?: TcpServerTlsOptions;
  /**
   * Shared HMAC secret. Memory/test injection only; never logged, printed,
   * written to disk or included in a report.
   */
  readonly sharedSecret: string | Buffer;
  /** Local node identity (diagnostics only; peer identity comes from auth). */
  readonly nodeId?: string;
  readonly service?: TcpReplicaService;
  /** Local cluster policy; used for identity and per-operation authorization. */
  readonly policy?: ClusterPolicy;
  /** Explicit allow-list used when no policy is supplied (test/operator seam). */
  readonly authorizedNodes?: readonly string[];
  /** Custom authorization seam; consulted only when no policy is supplied. */
  readonly authorize?: TcpAuthorizer;
  readonly maxFrameBytes?: number;
  readonly connectTimeoutMs?: number;
  readonly handshakeTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
  readonly maxPendingChallenges?: number;
  readonly maxUsedNonces?: number;
}

interface ResolvedServerOptions {
  readonly host: string;
  readonly port: number;
  readonly tls?: TcpServerTlsOptions;
  readonly sharedSecret: string | Buffer;
  readonly nodeId?: string;
  readonly service: TcpReplicaService;
  readonly policy?: ClusterPolicy;
  readonly authorizedNodes?: readonly string[];
  readonly authorize?: TcpAuthorizer;
  readonly maxFrameBytes: number;
  readonly connectTimeoutMs: number;
  readonly handshakeTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly maxPendingChallenges: number;
  readonly maxUsedNonces: number;
}

export interface TcpReplicaAddress {
  readonly host: string;
  readonly port: number;
}

interface ServerConnection {
  readonly socket: net.Socket;
  readonly decoder: TcpReplicaFrameDecoder;
  authenticated: boolean;
  nodeId: string | null;
  handshakeTimer: NodeJS.Timeout | null;
  idleTimer: NodeJS.Timeout | null;
  closed: boolean;
  /** T-158: in-flight request id -> cooperative cancellation controller. */
  readonly inFlight: Map<string, AbortController>;
}

interface PendingChallenge {
  readonly nodeId: string;
  readonly nonce: string;
  readonly serverNonce: string;
}

function resolveServerOptions(options: TcpReplicaServerOptions): ResolvedServerOptions {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TcpTransportError('TCP_CONFIG_INVALID', 'server options must be an object');
  }
  if (typeof options.sharedSecret !== 'string' && !Buffer.isBuffer(options.sharedSecret)) {
    throw new TcpTransportError('TCP_CONFIG_INVALID', 'sharedSecret must be a string or Buffer (memory only)');
  }
  if (options.sharedSecret.length === 0) {
    throw new TcpTransportError('TCP_CONFIG_INVALID', 'sharedSecret must not be empty');
  }
  const host = options.host ?? TCP_REPLICA_DEFAULT_HOST;
  if (typeof host !== 'string' || host.trim().length === 0) {
    throw new TcpTransportError('TCP_CONFIG_INVALID', 'host must be a non-empty string');
  }
  const port = options.port ?? 0;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new TcpTransportError('TCP_CONFIG_INVALID', `port must be an integer in [0, 65535], got ${String(port)}`);
  }
  if (options.tls !== undefined) {
    if (typeof options.tls.key !== 'string' && !Buffer.isBuffer(options.tls.key)) {
      throw new TcpTransportError('TCP_CONFIG_INVALID', 'tls.key must be a string or Buffer');
    }
    if (typeof options.tls.cert !== 'string' && !Buffer.isBuffer(options.tls.cert)) {
      throw new TcpTransportError('TCP_CONFIG_INVALID', 'tls.cert must be a string or Buffer');
    }
  }
  if (options.policy !== undefined) {
    try {
      assertClusterPolicy(options.policy);
    } catch (error) {
      throw new TcpTransportError('TCP_CONFIG_INVALID', `invalid cluster policy: ${message(error)}`, { cause: error });
    }
  }
  if (options.service !== undefined && (options.service === null || typeof options.service !== 'object')) {
    throw new TcpTransportError('TCP_CONFIG_INVALID', 'service must be an object when provided');
  }
  if (options.authorizedNodes !== undefined) {
    if (!Array.isArray(options.authorizedNodes) || options.authorizedNodes.some((entry) => typeof entry !== 'string' || !NODE_ID_PATTERN.test(entry))) {
      throw new TcpTransportError('TCP_CONFIG_INVALID', 'authorizedNodes must be an array of bounded node identifiers');
    }
  }
  const resolved: ResolvedServerOptions = {
    host: host.trim(),
    port,
    ...(options.tls === undefined ? {} : { tls: options.tls }),
    sharedSecret: options.sharedSecret,
    ...(options.nodeId === undefined ? {} : { nodeId: options.nodeId }),
    service: options.service ?? {},
    ...(options.policy === undefined ? {} : { policy: options.policy }),
    ...(options.authorizedNodes === undefined ? {} : { authorizedNodes: options.authorizedNodes }),
    ...(options.authorize === undefined ? {} : { authorize: options.authorize }),
    maxFrameBytes: positiveInt(options.maxFrameBytes, TCP_REPLICA_MAX_FRAME_BYTES, 'maxFrameBytes'),
    connectTimeoutMs: positiveInt(options.connectTimeoutMs, TCP_REPLICA_DEFAULT_CONNECT_TIMEOUT_MS, 'connectTimeoutMs'),
    handshakeTimeoutMs: positiveInt(options.handshakeTimeoutMs, TCP_REPLICA_DEFAULT_HANDSHAKE_TIMEOUT_MS, 'handshakeTimeoutMs'),
    requestTimeoutMs: positiveInt(options.requestTimeoutMs, TCP_REPLICA_DEFAULT_REQUEST_TIMEOUT_MS, 'requestTimeoutMs'),
    idleTimeoutMs: nonNegativeInt(options.idleTimeoutMs, TCP_REPLICA_DEFAULT_IDLE_TIMEOUT_MS, 'idleTimeoutMs'),
    maxPendingChallenges: Math.min(
      TCP_REPLICA_MAX_PENDING_CHALLENGES,
      positiveInt(options.maxPendingChallenges, TCP_REPLICA_MAX_PENDING_CHALLENGES, 'maxPendingChallenges'),
    ),
    maxUsedNonces: Math.min(
      TCP_REPLICA_MAX_USED_NONCES,
      positiveInt(options.maxUsedNonces, TCP_REPLICA_MAX_USED_NONCES, 'maxUsedNonces'),
    ),
  };
  // Fail closed before any bind: non-loopback plaintext is never allowed.
  assertBindAllowed(resolved.host, resolved.tls);
  return resolved;
}

function rememberBounded<V>(map: Map<string, V>, key: string, value: V, limit: number): void {
  if (map.has(key)) {
    map.delete(key);
    map.set(key, value);
    return;
  }
  map.set(key, value);
  while (map.size > limit) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/**
 * One listening replica node. The listener binds only the requested host
 * (loopback by default) and serves `query`/`apply`/`status` only after a
 * successful HMAC handshake. It never dials out and holds no authoritative
 * ledger state of its own — the injected {@link TcpReplicaService} owns that.
 */
export class TcpReplicaServer {
  readonly #options: ResolvedServerOptions;
  #server: net.Server | tls.Server | null = null;
  #address: TcpReplicaAddress | null = null;
  readonly #connections = new Set<ServerConnection>();
  readonly #challengesByNonce = new Map<string, PendingChallenge>();
  readonly #challengesByServerNonce = new Map<string, string>();
  readonly #usedNonces = new Map<string, true>();
  #closed = false;
  #lastError: TcpTransportError | null = null;

  constructor(options: TcpReplicaServerOptions) {
    this.#options = resolveServerOptions(options);
  }

  /** Live accepted sockets (authenticated or mid-handshake). Test seam. */
  get activeConnectionCount(): number {
    return this.#connections.size;
  }

  /**
   * Server-side watermarks (T-159): accepted sockets plus handshake/idle
   * timers. In-flight request controllers are not timers and are reported as
   * pending requests so a cancelled/timed-out request is still visible.
   */
  resourceWatermarks(): { pendingRequests: number; openSockets: number; activeTimers: number } {
    let pendingRequests = 0;
    let activeTimers = 0;
    for (const connection of this.#connections) {
      pendingRequests += connection.inFlight.size;
      if (connection.handshakeTimer !== null) activeTimers += 1;
      if (connection.idleTimer !== null) activeTimers += 1;
    }
    return { pendingRequests, openSockets: this.#connections.size, activeTimers };
  }

  get isClosed(): boolean {
    return this.#closed;
  }

  get address(): TcpReplicaAddress | null {
    return this.#address;
  }

  /** Diagnostic only: last listen/socket error (never a secret). */
  get lastError(): TcpTransportError | null {
    return this.#lastError;
  }

  async listen(): Promise<TcpReplicaAddress> {
    if (this.#closed) {
      throw new TcpTransportError('TCP_CONNECTION_CLOSED', 'server is closed and cannot listen again');
    }
    if (this.#server !== null) {
      if (this.#address === null) throw new TcpTransportError('TCP_LISTEN_FAILED', 'server listen state is inconsistent');
      return this.#address;
    }
    // Re-check at startup: a non-loopback plaintext listener fails before bind.
    assertBindAllowed(this.#options.host, this.#options.tls);

    const tlsOptions = this.#options.tls;
    const onConnection = (socket: net.Socket): void => this.#onConnection(socket);
    const server = tlsOptions === undefined
      ? net.createServer(onConnection)
      : tls.createServer({
        key: tlsOptions.key,
        cert: tlsOptions.cert,
        ...(tlsOptions.ca === undefined ? {} : { ca: tlsOptions.ca }),
        ...(tlsOptions.requestCert === undefined ? {} : { requestCert: tlsOptions.requestCert }),
        ...(tlsOptions.rejectUnauthorized === undefined ? {} : { rejectUnauthorized: tlsOptions.rejectUnauthorized }),
      }, onConnection);

    server.on('error', (error: Error) => {
      this.#lastError = new TcpTransportError(
        'TCP_LISTEN_FAILED',
        `listener on ${this.#options.host}:${String(this.#options.port)} failed: ${message(error)}`,
        { cause: error },
      );
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.removeListener('listening', onListening);
        reject(new TcpTransportError(
          'TCP_LISTEN_FAILED',
          `failed to listen on ${this.#options.host}:${String(this.#options.port)}: ${message(error)}`,
          { cause: error },
        ));
      };
      const onListening = (): void => {
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      try {
        server.listen({ host: this.#options.host, port: this.#options.port });
      } catch (error) {
        server.removeListener('error', onError);
        server.removeListener('listening', onListening);
        reject(new TcpTransportError(
          'TCP_LISTEN_FAILED',
          `failed to start listener on ${this.#options.host}:${String(this.#options.port)}: ${message(error)}`,
          { cause: error },
        ));
      }
    });

    const address = server.address();
    if (address === null || typeof address !== 'object') {
      throw new TcpTransportError('TCP_LISTEN_FAILED', 'listener did not report an address');
    }
    this.#server = server;
    this.#address = { host: this.#options.host, port: address.port };
    return this.#address;
  }

  /**
   * Stop accepting, destroy every accepted socket and release the listener.
   * Idempotent: a second call returns immediately. Bounded, with no lingering
   * handles — tests assert `activeConnectionCount === 0` afterwards.
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const connection of [...this.#connections]) this.#dropConnection(connection, null);
    const server = this.#server;
    this.#server = null;
    this.#challengesByNonce.clear();
    this.#challengesByServerNonce.clear();
    this.#usedNonces.clear();
    if (server === null) {
      this.#address = null;
      return;
    }
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      server.close(() => finish());
      // `close` waits for live connections; they were destroyed above, but do
      // not wait forever if a socket lingers.
      const guard = setTimeout(finish, 2_000);
      guard.unref?.();
    });
    this.#address = null;
  }

  // -- connection lifecycle ------------------------------------------------

  #onConnection(socket: net.Socket): void {
    const connection: ServerConnection = {
      socket,
      decoder: new TcpReplicaFrameDecoder(this.#options.maxFrameBytes),
      authenticated: false,
      nodeId: null,
      handshakeTimer: null,
      idleTimer: null,
      closed: false,
      inFlight: new Map(),
    };
    this.#connections.add(connection);
    socket.setNoDelay(true);
    socket.on('data', (chunk: Buffer) => this.#onSocketData(connection, chunk));
    socket.on('error', (error: Error) => {
      this.#dropConnection(connection, new TcpTransportError(
        'TCP_CONNECTION_CLOSED',
        `peer socket error: ${message(error)}`,
        { cause: error },
      ));
    });
    socket.on('close', () => this.#dropConnection(connection, null));
    socket.on('timeout', () => {
      this.#dropConnection(connection, new TcpTransportError('TCP_CONNECTION_CLOSED', 'peer socket idle timeout'));
    });
    if (this.#options.idleTimeoutMs > 0) socket.setTimeout(this.#options.idleTimeoutMs);
    if (this.#options.handshakeTimeoutMs > 0) {
      connection.handshakeTimer = setTimeout(() => {
        this.#dropConnection(connection, new TcpTransportError('TCP_AUTH_REQUIRED', 'handshake timed out'));
      }, this.#options.handshakeTimeoutMs);
      connection.handshakeTimer.unref?.();
    }
  }

  #dropConnection(connection: ServerConnection, error: TcpTransportError | null): void {
    if (connection.closed) return;
    connection.closed = true;
    if (connection.handshakeTimer !== null) clearTimeout(connection.handshakeTimer);
    if (connection.idleTimer !== null) clearTimeout(connection.idleTimer);
    // Stop cooperating work; service handlers observe these signals.
    for (const controller of connection.inFlight.values()) {
      controller.abort(new TcpTransportError('TCP_CONNECTION_CLOSED', 'connection closed while the request was in flight'));
    }
    connection.inFlight.clear();
    this.#connections.delete(connection);
    if (error !== null) this.#lastError = error;
    connection.socket.destroy();
  }

  #onSocketData(connection: ServerConnection, chunk: Buffer): void {
    if (connection.closed) return;
    this.#touchIdle(connection);
    const outcome = connection.decoder.push(chunk);
    if (outcome.error !== null) {
      this.#dropConnection(connection, outcome.error);
      return;
    }
    for (const frame of outcome.frames) {
      void this.#handleFrame(connection, frame);
    }
  }

  #touchIdle(connection: ServerConnection): void {
    if (connection.idleTimer !== null) clearTimeout(connection.idleTimer);
    if (this.#options.idleTimeoutMs > 0) {
      connection.idleTimer = setTimeout(() => {
        this.#dropConnection(connection, new TcpTransportError('TCP_CONNECTION_CLOSED', 'peer socket idle timeout'));
      }, this.#options.idleTimeoutMs);
      connection.idleTimer.unref?.();
    }
  }

  // -- frame dispatch ------------------------------------------------------

  async #handleFrame(connection: ServerConnection, frame: TcpReplicaWireMessage): Promise<void> {
    const request = frame as TcpReplicaRequest;
    try {
      if (!connection.authenticated) {
        if (request.kind === 'hello') {
          this.#handleHello(connection, request);
          return;
        }
        if (request.kind === 'auth') {
          this.#handleAuth(connection, request);
          return;
        }
        this.#sendFailure(connection, request.id, request.kind, 'TCP_AUTH_REQUIRED', 'handshake must complete before query/apply/status');
        return;
      }
      if (request.kind === 'hello' || request.kind === 'auth') {
        this.#sendFailure(connection, request.id, request.kind, 'TCP_MESSAGE_INVALID', `${request.kind} is not allowed after authentication`);
        return;
      }
      await this.#dispatch(connection, request);
    } catch (error) {
      const code = error instanceof TcpTransportError ? error.code : 'TCP_NODE_UNAVAILABLE';
      this.#sendFailure(connection, request.id, request.kind, code, message(error));
    }
  }

  #handleHello(connection: ServerConnection, request: TcpReplicaRequest): void {
    const payload = parseTcpHelloPayload(request.payload);
    if (!this.#isKnownNode(payload.nodeId)) {
      this.#sendFailureThenDestroy(connection, request.id, request.kind, 'TCP_AUTH_UNKNOWN_NODE', `node ${JSON.stringify(payload.nodeId)} is not authorized to connect`);
      return;
    }
    if (this.#usedNonces.has(payload.nonce) || this.#challengesByNonce.has(payload.nonce)) {
      this.#sendFailureThenDestroy(connection, request.id, request.kind, 'TCP_AUTH_NONCE_REPLAYED', 'nonce was already used or is pending; replay refused');
      return;
    }
    const serverNonce = generateNonce();
    const challenge: PendingChallenge = { nodeId: payload.nodeId, nonce: payload.nonce, serverNonce };
    rememberBounded(this.#challengesByNonce, payload.nonce, challenge, this.#options.maxPendingChallenges);
    rememberBounded(this.#challengesByServerNonce, serverNonce, payload.nonce, this.#options.maxPendingChallenges);
    this.#sendSuccess(connection, request.id, request.kind, { serverNonce });
  }

  #handleAuth(connection: ServerConnection, request: TcpReplicaRequest): void {
    const payload = parseTcpAuthPayload(request.payload);
    const challenge = this.#challengesByNonce.get(payload.nonce);
    if (
      challenge === undefined
      || challenge.serverNonce !== payload.serverNonce
      || challenge.nodeId !== payload.nodeId
      || this.#challengesByServerNonce.get(payload.serverNonce) !== payload.nonce
    ) {
      this.#sendFailureThenDestroy(connection, request.id, request.kind, 'TCP_AUTH_CHALLENGE_INVALID', 'unknown or mismatched authentication challenge');
      return;
    }
    const expected = challengeSignature(this.#options.sharedSecret, payload.nodeId, payload.nonce, payload.serverNonce);
    if (!signaturesMatch(expected, payload.signature)) {
      this.#sendFailureThenDestroy(connection, request.id, request.kind, 'TCP_AUTH_BAD_SIGNATURE', 'authentication signature mismatch');
      return;
    }
    this.#challengesByNonce.delete(payload.nonce);
    this.#challengesByServerNonce.delete(payload.serverNonce);
    rememberBounded(this.#usedNonces, payload.nonce, true, this.#options.maxUsedNonces);
    connection.authenticated = true;
    connection.nodeId = payload.nodeId;
    if (connection.handshakeTimer !== null) {
      clearTimeout(connection.handshakeTimer);
      connection.handshakeTimer = null;
    }
    this.#sendSuccess(connection, request.id, request.kind, { nodeId: payload.nodeId, authenticated: true });
  }

  async #dispatch(connection: ServerConnection, request: TcpReplicaRequest): Promise<void> {
    const nodeId = connection.nodeId;
    if (nodeId === null) {
      this.#sendFailure(connection, request.id, request.kind, 'TCP_AUTH_REQUIRED', 'connection is not authenticated');
      return;
    }
    let operation: ClusterOperation;
    let scope: string | undefined;
    let parsedPayload: unknown = request.payload;

    if (request.kind === 'cancel') {
      operation = 'read';
      const payload = parseTcpCancelPayload(request.payload);
      const cancelDecision = this.#authorize(nodeId, operation, undefined);
      if (!cancelDecision.allowed) {
        this.#sendFailure(
          connection,
          request.id,
          request.kind,
          cancelDecision.code ?? 'OPERATION_FORBIDDEN',
          cancelDecision.reason ?? 'operation refused by local policy',
        );
        return;
      }
      const controller = connection.inFlight.get(payload.targetId);
      if (controller === undefined) {
        // Idempotent ack: unknown or already completed is not an error.
        this.#sendSuccess(connection, request.id, request.kind, {
          cancelled: false,
          targetId: payload.targetId,
          reason: 'unknown',
        });
        return;
      }
      controller.abort(new TcpTransportError('TCP_REQUEST_CANCELLED', `request ${payload.targetId} was cancelled by ${nodeId}`));
      this.#sendSuccess(connection, request.id, request.kind, { cancelled: true, targetId: payload.targetId });
      return;
    }

    if (request.kind === 'status') {
      operation = 'read';
      parsePayload('status payload', tcpStatusPayloadSchema, request.payload ?? {});
    } else if (request.kind === 'query') {
      operation = 'read';
      parsedPayload = parseTcpQueryPayload(request.payload);
      scope = (parsedPayload as AnchorProbeRequest).project_scope;
    } else if (request.kind === 'apply') {
      operation = 'apply';
      parsedPayload = parseTcpApplyPayload(request.payload);
      const applyScope = (parsedPayload as TcpApplyPayload).projectScope;
      if (applyScope !== undefined) scope = applyScope;
    } else {
      this.#sendFailure(connection, request.id, request.kind, 'TCP_MESSAGE_UNKNOWN_TYPE', `unsupported message kind ${JSON.stringify(request.kind)}`);
      return;
    }

    const decision = this.#authorize(nodeId, operation, scope);
    if (!decision.allowed) {
      this.#sendFailure(
        connection,
        request.id,
        request.kind,
        decision.code ?? 'OPERATION_FORBIDDEN',
        decision.reason ?? 'operation refused by local policy',
      );
      return;
    }

    const controller = new AbortController();
    connection.inFlight.set(request.id, controller);
    const context: TcpReplicaServiceContext = {
      nodeId,
      ...(scope === undefined ? {} : { projectScope: scope }),
      signal: controller.signal,
    };
    const service = this.#options.service;
    try {
      if (request.kind === 'status') {
        if (service.status === undefined) throw new TcpTransportError('TCP_NODE_UNAVAILABLE', 'status service is not configured');
        const result = await this.#withRequestTimeout(service.status(context));
        if (controller.signal.aborted) throw new TcpTransportError('TCP_REQUEST_CANCELLED', 'status was cancelled before it answered');
        parsePayload('status result', tcpStatusResultSchema, result);
        this.#sendSuccess(connection, request.id, request.kind, result);
        return;
      }
      if (request.kind === 'query') {
        if (service.query === undefined) throw new TcpTransportError('TCP_NODE_UNAVAILABLE', 'query service is not configured');
        const result = await this.#withRequestTimeout(service.query(parsedPayload as AnchorProbeRequest, context));
        if (controller.signal.aborted) throw new TcpTransportError('TCP_REQUEST_CANCELLED', 'query was cancelled before it answered');
        if (result === null || typeof result !== 'object' || !Array.isArray((result as { candidates?: unknown }).candidates)) {
          throw invalid('query result must carry a candidates array');
        }
        this.#sendSuccess(connection, request.id, request.kind, result);
        return;
      }
      if (service.apply === undefined) throw new TcpTransportError('TCP_NODE_UNAVAILABLE', 'apply service is not configured');
      const events = (parsedPayload as TcpApplyPayload).events as unknown as readonly CommittedEventEnvelope[];
      const result = await this.#withRequestTimeout(service.apply(events, context));
      if (controller.signal.aborted) throw new TcpTransportError('TCP_REQUEST_CANCELLED', 'apply was cancelled before it answered');
      this.#sendSuccess(connection, request.id, request.kind, result);
    } catch (error) {
      const code = error instanceof TcpTransportError
        ? error.code
        : typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
          ? String((error as { code?: unknown }).code)
          : 'TCP_NODE_UNAVAILABLE';
      this.#sendFailure(connection, request.id, request.kind, code, message(error));
    } finally {
      connection.inFlight.delete(request.id);
    }
  }

  async #withRequestTimeout<T>(work: T | Promise<T>): Promise<T> {
    const timeout = this.#options.requestTimeoutMs;
    if (timeout <= 0) return await work;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        Promise.resolve(work),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new TcpTransportError('TCP_REQUEST_TIMEOUT', `service exceeded its ${String(timeout)}ms request budget`));
          }, timeout);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  #authorize(nodeId: string, operation: ClusterOperation, scope: string | undefined): { allowed: boolean; code?: string; reason?: string } {
    const { policy, authorize, authorizedNodes } = this.#options;
    if (policy !== undefined) {
      const decision = authorizeReplica(policy, nodeId, operation, scope);
      return decision.allowed
        ? { allowed: true }
        : { allowed: false, code: decision.code, reason: decision.reason };
    }
    if (authorize !== undefined) {
      const decision = authorize(nodeId, operation, scope);
      if (decision === true) return { allowed: true };
      if (decision === false) return { allowed: false, code: 'OPERATION_FORBIDDEN', reason: 'authorize callback refused the operation' };
      if (decision.allowed) return { allowed: true };
      return { allowed: false, code: decision.code ?? 'OPERATION_FORBIDDEN', reason: decision.reason ?? 'authorize callback refused the operation' };
    }
    if (authorizedNodes !== undefined) return { allowed: true };
    return { allowed: false, code: 'REPLICA_NOT_AUTHORIZED', reason: 'no cluster policy or allow-list is configured (fail-closed)' };
  }

  #isKnownNode(nodeId: string): boolean {
    const { policy, authorizedNodes, authorize } = this.#options;
    if (policy !== undefined && policy.replicas.some((replica) => replica.replicaId === nodeId)) return true;
    if (authorizedNodes !== undefined && authorizedNodes.includes(nodeId)) return true;
    if (authorize !== undefined) return true;
    return false;
  }

  // -- writes --------------------------------------------------------------

  #write(connection: ServerConnection, frame: TcpReplicaWireMessage): void {
    if (connection.closed || !connection.socket.writable) return;
    try {
      connection.socket.write(encodeTcpReplicaFrame(frame, this.#options.maxFrameBytes));
    } catch (error) {
      this.#dropConnection(connection, new TcpTransportError(
        'TCP_CONNECTION_CLOSED',
        `failed to write response: ${message(error)}`,
        { cause: error },
      ));
    }
  }

  #sendSuccess(connection: ServerConnection, id: string, kind: TcpReplicaKind, payload: unknown): void {
    this.#write(connection, { schema_version: MWHA_PROTOCOL_SCHEMA_VERSION, kind, id, ok: true, payload });
  }

  #sendFailure(connection: ServerConnection, id: string, kind: TcpReplicaKind, code: string, text: string): void {
    this.#write(connection, {
      schema_version: MWHA_PROTOCOL_SCHEMA_VERSION,
      kind,
      id,
      ok: false,
      error: { code, message: text },
    });
  }

  #sendFailureThenDestroy(connection: ServerConnection, id: string, kind: TcpReplicaKind, code: string, text: string): void {
    if (connection.closed || !connection.socket.writable) {
      this.#dropConnection(connection, null);
      return;
    }
    try {
      connection.socket.write(encodeTcpReplicaFrame({
        schema_version: MWHA_PROTOCOL_SCHEMA_VERSION,
        kind,
        id,
        ok: false,
        error: { code, message: text },
      }, this.#options.maxFrameBytes), () => {
        this.#dropConnection(connection, null);
      });
    } catch {
      this.#dropConnection(connection, null);
    }
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface TcpClientTlsOptions {
  /** Trust anchor(s) for the server certificate. Mandatory with TLS. */
  readonly ca: string | Buffer | (string | Buffer)[];
  readonly cert?: string | Buffer;
  readonly key?: string | Buffer;
  /** SNI/identity check name; defaults to the host. */
  readonly serverName?: string;
  /** Certificate verification is mandatory; disabling it is refused. */
  readonly rejectUnauthorized?: boolean;
}

export interface TcpReplicaClientOptions {
  readonly host?: string;
  readonly port: number;
  /** This client's node identity; sent in hello and bound into the signature. */
  readonly nodeId: string;
  /** Memory/test-only HMAC secret; never logged or persisted. */
  readonly sharedSecret: string | Buffer;
  readonly tls?: TcpClientTlsOptions;
  readonly connectTimeoutMs?: number;
  readonly handshakeTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  /** Grace period for a cancel acknowledgement (default 250ms). */
  readonly cancelGraceMs?: number;
  readonly maxFrameBytes?: number;
}

interface ResolvedClientOptions {
  readonly host: string;
  readonly port: number;
  readonly nodeId: string;
  readonly sharedSecret: string | Buffer;
  readonly tls?: TcpClientTlsOptions;
  readonly connectTimeoutMs: number;
  readonly handshakeTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly cancelGraceMs: number;
  readonly maxFrameBytes: number;
}

function resolveClientOptions(options: TcpReplicaClientOptions): ResolvedClientOptions {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TcpTransportError('TCP_CONFIG_INVALID', 'client options must be an object');
  }
  if (typeof options.nodeId !== 'string' || !NODE_ID_PATTERN.test(options.nodeId)) {
    throw new TcpTransportError('TCP_CONFIG_INVALID', 'nodeId must be a bounded identifier');
  }
  if (typeof options.sharedSecret !== 'string' && !Buffer.isBuffer(options.sharedSecret)) {
    throw new TcpTransportError('TCP_CONFIG_INVALID', 'sharedSecret must be a string or Buffer (memory only)');
  }
  if (options.sharedSecret.length === 0) {
    throw new TcpTransportError('TCP_CONFIG_INVALID', 'sharedSecret must not be empty');
  }
  const host = options.host ?? TCP_REPLICA_DEFAULT_HOST;
  if (typeof host !== 'string' || host.trim().length === 0) {
    throw new TcpTransportError('TCP_CONFIG_INVALID', 'host must be a non-empty string');
  }
  const port = options.port;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new TcpTransportError('TCP_CONFIG_INVALID', `port must be an integer in [0, 65535], got ${String(port)}`);
  }
  if (options.tls !== undefined) {
    if (options.tls.ca === undefined) throw new TcpTransportError('TCP_CONFIG_INVALID', 'tls.ca is required when TLS is configured');
    if (options.tls.rejectUnauthorized === false) {
      throw new TcpTransportError('TCP_CONFIG_INVALID', 'tls.rejectUnauthorized=false is refused (certificate verification is mandatory)');
    }
  }
  const resolved: ResolvedClientOptions = {
    host: host.trim(),
    port,
    nodeId: options.nodeId,
    sharedSecret: options.sharedSecret,
    ...(options.tls === undefined ? {} : { tls: options.tls }),
    connectTimeoutMs: positiveInt(options.connectTimeoutMs, TCP_REPLICA_DEFAULT_CONNECT_TIMEOUT_MS, 'connectTimeoutMs'),
    handshakeTimeoutMs: positiveInt(options.handshakeTimeoutMs, TCP_REPLICA_DEFAULT_HANDSHAKE_TIMEOUT_MS, 'handshakeTimeoutMs'),
    requestTimeoutMs: positiveInt(options.requestTimeoutMs, TCP_REPLICA_DEFAULT_REQUEST_TIMEOUT_MS, 'requestTimeoutMs'),
    cancelGraceMs: positiveInt(options.cancelGraceMs, TCP_REPLICA_DEFAULT_CANCEL_GRACE_MS, 'cancelGraceMs'),
    maxFrameBytes: positiveInt(options.maxFrameBytes, TCP_REPLICA_MAX_FRAME_BYTES, 'maxFrameBytes'),
  };
  assertBindAllowed(resolved.host, resolved.tls);
  return resolved;
}

/**
 * One outbound replica connection. `connect()` performs the real TCP/TLS
 * connection and the HMAC hello/auth handshake; `request()` correlates
 * responses by frame id, honours per-request timeouts and AbortSignal
 * cancellation, and `close()` is idempotent and leaves no socket behind.
 */
export class TcpReplicaClient {
  readonly #options: ResolvedClientOptions;
  #socket: net.Socket | tls.TLSSocket | null = null;
  #decoder: TcpReplicaFrameDecoder | null = null;
  readonly #pending = new TcpClientPendingTable();
  /** T-158: cancel-frame id -> grace timer awaiting the peer's ack. */
  readonly #cancels = new Map<string, NodeJS.Timeout>();
  #connectPromise: Promise<void> | null = null;
  #sequence = 0;
  #connected = false;
  #closed = false;

  constructor(options: TcpReplicaClientOptions) {
    this.#options = resolveClientOptions(options);
  }

  /** 1 while a live, authenticated socket exists; 0 otherwise. Test seam. */
  get activeConnectionCount(): number {
    if (this.#socket === null || this.#socket.destroyed || !this.#connected || this.#closed) return 0;
    return 1;
  }

  get isConnected(): boolean {
    return this.activeConnectionCount === 1;
  }

  get isClosed(): boolean {
    return this.#closed;
  }

  /**
   * Observable client watermarks (T-158/T-159). Pending requests, a live
   * socket and every request/cancel timer must all return to zero after close.
   */
  resourceWatermarks(): { pendingRequests: number; openSockets: number; activeTimers: number } {
    return {
      pendingRequests: this.#pending.size,
      openSockets: this.activeConnectionCount,
      activeTimers: this.#pending.timerCount + this.#cancels.size,
    };
  }

  async connect(signal?: AbortSignal): Promise<void> {
    if (this.#closed) throw new TcpTransportError('TCP_CONNECTION_CLOSED', 'client is closed');
    if (this.#connected) return;
    if (this.#connectPromise !== null) {
      if (signal?.aborted === true) throw new TcpTransportError('TCP_REQUEST_CANCELLED', 'connect cancelled before dispatch');
      return await this.#connectPromise;
    }
    this.#connectPromise = this.#doConnect(signal)
      .catch((error) => {
        const wrapped = error instanceof TcpTransportError
          ? error
          : new TcpTransportError('TCP_CONNECTION_FAILED', `connect failed: ${message(error)}`, { cause: error });
        this.#failPending(wrapped);
        void this.#teardownSocket();
        throw wrapped;
      })
      .finally(() => {
        this.#connectPromise = null;
      });
    return await this.#connectPromise;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#failPending(new TcpTransportError('TCP_CONNECTION_CLOSED', 'client closed'));
    await this.#teardownSocket();
  }

  /** Send one framed request and await the correlated response. */
  request(
    kind: TcpReplicaKind,
    payload: unknown,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<unknown> {
    if (this.#closed || !this.#connected || this.#socket === null) {
      return Promise.reject(new TcpTransportError('TCP_CONNECTION_CLOSED', 'client is not connected; call connect() first'));
    }
    if (kind === 'hello' || kind === 'auth') {
      return Promise.reject(new TcpTransportError('TCP_MESSAGE_INVALID', `${kind} is part of the managed handshake and cannot be sent as a regular request`));
    }
    if (options.signal?.aborted === true) {
      return Promise.reject(new TcpTransportError('TCP_REQUEST_CANCELLED', `${kind} was cancelled before dispatch`));
    }
    if (this.#pending.size >= TCP_REPLICA_MAX_PENDING_REQUESTS) {
      return Promise.reject(new TcpTransportError('TCP_NODE_UNAVAILABLE', `too many pending requests (${String(this.#pending.size)})`));
    }
    const timeout = positiveInt(options.timeoutMs, this.#options.requestTimeoutMs, 'timeoutMs');
    const id = this.#nextId('req');
    let encoded: Buffer;
    try {
      encoded = encodeTcpReplicaFrame({ schema_version: MWHA_PROTOCOL_SCHEMA_VERSION, kind, id, payload }, this.#options.maxFrameBytes);
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise<unknown>((resolve, reject) => {
      this.#pending.register({
        id,
        kind,
        resolve,
        reject,
        signal: options.signal,
        timeoutMs: timeout,
        timeoutError: new TcpTransportError('TCP_REQUEST_TIMEOUT', `${kind} exceeded its ${String(timeout)}ms budget`),
        onCancel: (cancelledId: string) => this.#sendCancel(cancelledId),
      });
      try {
        this.#socket?.write(encoded);
      } catch (error) {
        this.#pending.settle(id);
        reject(new TcpTransportError('TCP_CONNECTION_CLOSED', `failed to write request: ${message(error)}`, { cause: error }));
      }
    });
  }

  async query(
    request: AnchorProbeRequest,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<DistributedNodeResponse> {
    const payload = parseTcpQueryPayload(request);
    const result = await this.request('query', payload, options);
    if (result === null || typeof result !== 'object' || !Array.isArray((result as { candidates?: unknown }).candidates)) {
      throw invalid('query response must carry a candidates array');
    }
    return result as DistributedNodeResponse;
  }

  async apply(
    events: readonly CommittedEventEnvelope[],
    options: { projectScope?: string; signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<ReplicationReport> {
    const payload: TcpApplyPayload = {
      events: events as unknown as TcpApplyPayload['events'],
      ...(options.projectScope === undefined ? {} : { projectScope: options.projectScope }),
    };
    parseTcpApplyPayload(payload);
    const result = await this.request('apply', payload, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    if (result === null || typeof result !== 'object' || typeof (result as { applied?: unknown }).applied !== 'number') {
      throw invalid('apply response must carry a replication report');
    }
    return result as ReplicationReport;
  }

  async status(options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<TcpReplicaStatusView> {
    const result = await this.request('status', {}, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    return parsePayload('status result', tcpStatusResultSchema, result) as TcpReplicaStatusView;
  }

  /** Adapt this client to a `DistributedNodeQuery` consumable by `distributedProbe`. */
  createNodeQuery(): DistributedNodeQuery {
    return (request, context) =>
      this.query(request, { signal: context.signal, timeoutMs: context.nodeTimeoutMs });
  }

  // -- internals -----------------------------------------------------------

  #nextId(prefix: string): string {
    this.#sequence += 1;
    return `${prefix}-${Date.now().toString(36)}-${this.#sequence.toString(36)}-${randomBytes(4).toString('hex')}`;
  }

  /**
   * Tell the authenticated peer to stop `targetId`. Best effort: the original
   * promise already settled, so only a failure to write is ignored. If the peer
   * never acks within the grace window and nothing else depends on this
   * connection, the connection is closed — never the whole server and never a
   * connection that still carries other requests.
   */
  #sendCancel(targetId: string): void {
    if (this.#closed || !this.#connected || this.#socket === null) return;
    const id = this.#nextId('cancel');
    let encoded: Buffer;
    try {
      encoded = encodeTcpReplicaFrame(
        { schema_version: MWHA_PROTOCOL_SCHEMA_VERSION, kind: 'cancel', id, payload: { targetId } },
        this.#options.maxFrameBytes,
      );
    } catch {
      return;
    }
    const timer = setTimeout(() => {
      this.#cancels.delete(id);
      if (this.#pending.size === 0) {
        void this.#teardownSocket();
      }
    }, this.#options.cancelGraceMs);
    timer.unref?.();
    this.#cancels.set(id, timer);
    try {
      this.#socket.write(encoded);
    } catch {
      clearTimeout(timer);
      this.#cancels.delete(id);
    }
  }

  async #doConnect(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) throw new TcpTransportError('TCP_REQUEST_CANCELLED', 'connect cancelled before dispatch');
    assertBindAllowed(this.#options.host, this.#options.tls);

    const socket = this.#options.tls === undefined
      ? net.connect({ host: this.#options.host, port: this.#options.port })
      : tls.connect({
        host: this.#options.host,
        port: this.#options.port,
        ca: this.#options.tls.ca,
        ...(this.#options.tls.cert === undefined ? {} : { cert: this.#options.tls.cert }),
        ...(this.#options.tls.key === undefined ? {} : { key: this.#options.tls.key }),
        servername: this.#options.tls.serverName ?? this.#options.host,
        rejectUnauthorized: this.#options.tls.rejectUnauthorized ?? true,
      });

    const decoder = new TcpReplicaFrameDecoder(this.#options.maxFrameBytes);
    this.#socket = socket;
    this.#decoder = decoder;
    socket.setNoDelay(true);
    socket.on('data', (chunk: Buffer) => this.#onSocketData(chunk));
    socket.on('error', (error: Error) => this.#onSocketError(error));
    socket.on('close', () => this.#onSocketClose());

    await this.#awaitConnected(socket, signal);
    await this.#handshake();
    this.#connected = true;
  }

  async #awaitConnected(socket: net.Socket | tls.TLSSocket, signal?: AbortSignal): Promise<void> {
    const isTls = this.#options.tls !== undefined;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const cleanup = (): void => {
        socket.removeListener('connect', onConnect);
        socket.removeListener('secureConnect', onSecureConnect);
        socket.removeListener('error', onError);
        socket.removeListener('close', onClose);
        if (timer !== undefined) clearTimeout(timer);
        if (signal !== undefined) signal.removeEventListener('abort', onAbort);
      };
      const onConnect = (): void => {
        if (settled || isTls) return; // TLS still needs secureConnect
        settled = true;
        cleanup();
        resolve();
      };
      const onSecureConnect = (): void => {
        if (settled || !isTls) return;
        settled = true;
        cleanup();
        resolve();
      };
      const onError = (error: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new TcpTransportError('TCP_CONNECTION_FAILED', `socket error while connecting: ${message(error)}`, { cause: error }));
      };
      const onClose = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new TcpTransportError('TCP_CONNECTION_CLOSED', 'socket closed before the connection was established'));
      };
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new TcpTransportError('TCP_REQUEST_CANCELLED', 'connect cancelled'));
      };
      socket.once('connect', onConnect);
      socket.once('secureConnect', onSecureConnect);
      socket.once('error', onError);
      socket.once('close', onClose);
      if (signal !== undefined) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      if (this.#options.connectTimeoutMs > 0) {
        timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(new TcpTransportError('TCP_CONNECTION_FAILED', `connect exceeded its ${String(this.#options.connectTimeoutMs)}ms budget`));
        }, this.#options.connectTimeoutMs);
        timer.unref?.();
      }
    });
  }

  async #handshake(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new TcpTransportError('TCP_AUTH_REQUIRED', `handshake exceeded its ${String(this.#options.handshakeTimeoutMs)}ms budget`));
      }, this.#options.handshakeTimeoutMs);
      timer.unref?.();
    });
    try {
      const nonce = generateNonce();
      const helloResponse = (await Promise.race([
        this.#requestInternal('hello', { nodeId: this.#options.nodeId, nonce }),
        timeout,
      ])) as { serverNonce?: unknown };
      if (typeof helloResponse?.serverNonce !== 'string') {
        throw new TcpTransportError('TCP_AUTH_CHALLENGE_INVALID', 'hello response did not carry a server nonce');
      }
      const serverNonce = helloResponse.serverNonce;
      const signature = challengeSignature(this.#options.sharedSecret, this.#options.nodeId, nonce, serverNonce);
      await Promise.race([
        this.#requestInternal('auth', { nodeId: this.#options.nodeId, nonce, serverNonce, signature }),
        timeout,
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  #requestInternal(kind: 'hello' | 'auth', payload: unknown): Promise<unknown> {
    if (this.#socket === null || this.#socket.destroyed) {
      return Promise.reject(new TcpTransportError('TCP_CONNECTION_CLOSED', 'socket is not usable during handshake'));
    }
    const id = this.#nextId('hs');
    let encoded: Buffer;
    try {
      encoded = encodeTcpReplicaFrame({ schema_version: MWHA_PROTOCOL_SCHEMA_VERSION, kind, id, payload }, this.#options.maxFrameBytes);
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise<unknown>((resolve, reject) => {
      this.#pending.register({
        id,
        kind,
        resolve,
        reject,
        signal: undefined,
        timeoutMs: this.#options.requestTimeoutMs,
        timeoutError: new TcpTransportError('TCP_REQUEST_TIMEOUT', `${kind} exceeded its ${String(this.#options.requestTimeoutMs)}ms budget`),
      });
      try {
        this.#socket?.write(encoded);
      } catch (error) {
        this.#pending.settle(id);
        reject(new TcpTransportError('TCP_CONNECTION_CLOSED', `failed to write ${kind}: ${message(error)}`, { cause: error }));
      }
    });
  }

  #onSocketData(chunk: Buffer): void {
    const decoder = this.#decoder;
    if (decoder === null) return;
    const outcome = decoder.push(chunk);
    if (outcome.error !== null) {
      this.#failPending(outcome.error);
      void this.#teardownSocket();
      return;
    }
    for (const frame of outcome.frames) this.#routeFrame(frame);
  }

  #routeFrame(frame: TcpReplicaWireMessage): void {
    // A cancel acknowledgement has no pending request of its own: clear the
    // grace timer and drop it.
    const cancelTimer = this.#cancels.get(frame.id);
    if (cancelTimer !== undefined) {
      clearTimeout(cancelTimer);
      this.#cancels.delete(frame.id);
      return;
    }
    const success = tcpReplicaSuccessSchema.safeParse(frame);
    if (success.success) {
      const pending = this.#pending.get(success.data.id);
      if (pending === undefined) return;
      this.#pending.settle(success.data.id);
      if (success.data.kind !== pending.kind) {
        pending.reject(invalid(`response kind ${String(success.data.kind)} does not match request kind ${String(pending.kind)}`));
        return;
      }
      pending.resolve(success.data.payload);
      return;
    }
    const failure = tcpReplicaFailureSchema.safeParse(frame);
    if (failure.success) {
      const pending = this.#pending.get(failure.data.id);
      if (pending === undefined) return;
      this.#pending.settle(failure.data.id);
      pending.reject(new TcpTransportError(failure.data.error.code, failure.data.error.message));
      return;
    }
    this.#failPending(new TcpTransportError('TCP_FRAME_INVALID', 'peer sent a frame that is neither a valid success nor failure response'));
    void this.#teardownSocket();
  }

  #onSocketError(error: Error): void {
    const wrapped = new TcpTransportError('TCP_CONNECTION_CLOSED', `socket error: ${message(error)}`, { cause: error });
    this.#failPending(wrapped);
    void this.#teardownSocket();
  }

  #onSocketClose(): void {
    this.#failPending(new TcpTransportError('TCP_CONNECTION_CLOSED', 'peer closed the connection'));
    void this.#teardownSocket();
  }

  #failPending(error: TcpTransportError): void {
    this.#pending.failAll(error);
  }

  async #teardownSocket(): Promise<void> {
    const socket = this.#socket;
    this.#socket = null;
    this.#decoder = null;
    this.#connected = false;
    for (const timer of this.#cancels.values()) clearTimeout(timer);
    this.#cancels.clear();
    if (socket === null) return;
    socket.removeAllListeners();
    if (!socket.destroyed) socket.destroy();
  }
}

// ---------------------------------------------------------------------------
// distributedProbe compatibility layer (distributed-probe.ts is unchanged)
// ---------------------------------------------------------------------------

/**
 * Build a `DistributedNodeQuery` directly over a connected TCP client. The
 * coordinator scatters its request and forwards the per-node timeout/signal.
 */
export function createTcpNodeQuery(client: TcpReplicaClient): DistributedNodeQuery {
  return (request, context) =>
    client.query(request, { signal: context.signal, timeoutMs: context.nodeTimeoutMs });
}

/**
 * Wrap a connected TCP client as a `DistributedReplicaNode`. `snapshot` reads
 * from the last completed `status` round trip (the same cache-not-connection
 * discipline as M15's `RemoteReplicaStore`), so a stale cache is never
 * presented as a live remote view.
 */
export async function createTcpDistributedReplicaNode(
  client: TcpReplicaClient,
  overrides: { commitIndex?: number; state?: DistributedReplicaState } = {},
): Promise<DistributedReplicaNode> {
  const status = await client.status();
  const cache: {
    snapshot: AnchorProbeSnapshot;
    candidates: readonly never[];
    edges: readonly never[];
  } = { snapshot: status.snapshot, candidates: [], edges: [] };
  const store = new RemoteReplicaStore(() => cache);
  return {
    replicaId: status.replicaId,
    store,
    ...(status.projectScope === undefined ? {} : { projectScope: status.projectScope }),
    ...(status.clusterEpoch === undefined ? {} : { clusterEpoch: status.clusterEpoch }),
    ...(overrides.commitIndex === undefined ? {} : { commitIndex: overrides.commitIndex }),
    ...(overrides.state === undefined ? {} : { state: overrides.state }),
    query: createTcpNodeQuery(client),
  };
}
