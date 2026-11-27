import { randomBytes } from 'node:crypto';
import * as net from 'node:net';
import { z } from 'zod';
import {
  HaProtocolError,
  MWHA_ADJUDICATION_SCHEMA_VERSION,
  MWHA_EVENT_SCHEMA_VERSION,
  MWHA_PROTOCOL_SCHEMA_VERSION,
  MWHA_UNVERIFIED_CAPABILITIES,
  MWHA_VERIFICATION_SCOPE,
  assertAdjudicationComplete,
  assertGateBoundary,
  assertQuorum,
  compareLogicalVersion,
  contentKey,
  detectMultipleLeaders,
  evaluateFence,
  evaluatePartitions,
  isUnverifiedCapability,
  logicalVersionOfEntry,
  makeBranchId,
  mwhaAdjudicationSchema,
  mwhaEventIdentitySchema,
  mwhaLeaderLeaseSchema,
  mwhaLogicalVersionSchema,
  mwhaMemberSchema,
  mwhaProjectionStateSchema,
  mwhaTopologySchema,
  mwhaWriterEventSchema,
  quorumSizeForMembers,
  votingMemberCount,
  type MwhaAdjudication,
  type MwhaClusterLogEntry,
  type MwhaEventIdentity,
  type MwhaLeaderLease,
  type MwhaLogicalVersion,
  type MwhaMember,
  type MwhaMultipleLeader,
  type MwhaProjectionState,
  type MwhaWriterEvent,
} from './ha-protocol.ts';
import {
  LeaderLeaseManager,
  assertSingleLeader,
  mwhaHeartbeatRequestSchema,
  mwhaHeartbeatResponseSchema,
  mwhaVoteRequestSchema,
  mwhaVoteResponseSchema,
  type HeartbeatRequest,
  type LeaderLeaseCommitRecord,
  type LeaderLeaseElectionResult,
  type LeaderLeaseRejoinReport,
  type VoteRequest,
  type VoterRpc,
} from './leader-lease.ts';
import {
  MultiWriterLog,
  projectMultiWriterState,
  type MultiWriterAdjudicationRecord,
  type MultiWriterEntryRecord,
  type MultiWriterIngestItem,
  type MultiWriterProjection,
} from './multi-writer.ts';
import {
  encodeTcpReplicaFrame,
  isLoopbackHost,
  TcpReplicaServer,
  TCP_REPLICA_MAX_FRAME_BYTES,
  type TcpReplicaKind,
  type TcpReplicaService,
  type TcpReplicaWireMessage,
} from './tcp-transport.ts';
import {
  TcpFaultProxy,
  type TcpFaultRule,
} from './tcp-fault-proxy.ts';
import { ledgerEventSchema, type LedgerEvent } from '../ledger/event.ts';
import type { AnchorProbeSnapshot } from './probe-contract.ts';

/**
 * T-139 / HA-07: a real local-TCP multi-writer cluster used to validate
 * split-brain safety (majority commits with a fresh epoch/term, minority writes
 * refused, 2-2 no-commit, old-leader isolation/demotion/catch-up, same-term
 * dual-master refusal, fork retention and the Gate boundary).
 *
 * HARD SCOPE BOUNDARY — read before citing this module:
 * - every node binds `127.0.0.1:0` only; no external interface is ever used;
 * - election/commit frames travel over real loopback TCP through
 *   {@link TcpFaultProxy} links, so a partition is a *real socket-level* cut of
 *   the injected links. It is still only TCP protocol-layer fault injection:
 *   **本地 TCP + 代理 ≠ OS 真分区**. Physical three-machine clusters, OS
 *   firewall/kernel partitions, cross-host clock rollback, production HA
 *   failover and availability SLAs remain unverified (see
 *   {@link HA_CLUSTER_VERIFICATION_NOTE} and {@link HA_CLUSTER_UNVERIFIED_CAPABILITIES});
 * - wall clock never orders facts. `(epoch, commit_index, writer_id,
 *   local_seq)` is the only version key; the injected `now()` is used solely by
 *   the frozen lease-expiry mechanism and diagnostics;
 * - only a leader holding a live lease that also collects a verified majority
 *   of *real TCP* proposal acks may append a committed entry. Acks are bound to
 *   a per-attempt nonce; forged, duplicated or unexpected voter ids are refused.
 *
 * Transport note: `tcp-transport.ts` is a frozen contract and its
 * `tcpReplicaKinds` vocabulary has no vote/heartbeat/proposal kind. Its own
 * `TcpVoterRpcAdapter` comment assigns that extension to T-139. This module
 * therefore owns a thin HA wire endpoint that reuses the *frozen* 4-byte
 * big-endian length-prefixed frame codec (`encodeTcpReplicaFrame`) so genuine
 * bytes traverse the same {@link TcpFaultProxy}, while each node additionally
 * hosts a real frozen {@link TcpReplicaServer} for its replica/status surface.
 */

// ---------------------------------------------------------------------------
// Verification boundary
// ---------------------------------------------------------------------------

/** Verification scope marker re-exported from the frozen contract. */
export const HA_CLUSTER_VERIFICATION_SCOPE = MWHA_VERIFICATION_SCOPE;

/** Capabilities explicitly outside the verified boundary. */
export const HA_CLUSTER_UNVERIFIED_CAPABILITIES = MWHA_UNVERIFIED_CAPABILITIES;

/**
 * Scope note carried into status()/projection() output. The wording is
 * load-bearing: local TCP plus a proxy is NOT an OS-level partition.
 */
export const HA_CLUSTER_VERIFICATION_NOTE =
  'T-139 本地 TCP 集群：真实 loopback TCP 帧 + TcpFaultProxy 协议层故障注入。'
  + '本地 TCP + 代理 ≠ OS 真分区；物理三机部署、OS 级网络分区、跨机时钟回拨、'
  + '生产 HA 故障切换与可用性 SLA 均为未验证能力，不得宣称。';

/** Fault-injection layer note (frozen contract re-export). */
export const HA_CLUSTER_FAULT_INJECTION_SCOPE_NOTE =
  'TCP 协议层故障注入 ≠ OS 真分区；OS 级网络分区、内核协议栈故障与物理链路中断均未验证。';

// ---------------------------------------------------------------------------
// HA wire vocabulary and strict schemas
// ---------------------------------------------------------------------------

/**
 * Frame kinds owned by T-139. They are carried inside the frozen
 * `mwha.protocol.v1` envelope and encoded with the frozen length-prefixed codec;
 * the frozen `tcp-transport.ts` dispatch is not extended or monkey-patched.
 */
export const HA_WIRE_KINDS = [
  'vote-request',
  'vote-response',
  'heartbeat-request',
  'heartbeat-response',
  'proposal',
  'proposal-response',
  'sync-request',
  'sync-push',
] as const;
export type HaWireKind = (typeof HA_WIRE_KINDS)[number];

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const identifierSchema = z.string().regex(ID_PATTERN, 'expected a bounded identifier');
const uintSchema = z.number().int().min(0);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u, 'expected a lowercase sha256 hex digest');

const haWireRequestSchema = z.object({
  schema_version: z.literal(MWHA_PROTOCOL_SCHEMA_VERSION),
  kind: z.enum(HA_WIRE_KINDS),
  id: identifierSchema,
  payload: z.unknown(),
}).strict();

const haWireSuccessSchema = z.object({
  schema_version: z.literal(MWHA_PROTOCOL_SCHEMA_VERSION),
  kind: z.enum(HA_WIRE_KINDS),
  id: identifierSchema,
  ok: z.literal(true),
  payload: z.unknown(),
}).strict();

const haWireFailureSchema = z.object({
  schema_version: z.literal(MWHA_PROTOCOL_SCHEMA_VERSION),
  kind: z.enum(HA_WIRE_KINDS),
  id: identifierSchema,
  ok: z.literal(false),
  error: z.object({
    code: z.string().min(1).max(128),
    message: z.string().min(1).max(2_000),
  }).strict(),
}).strict();

/** Everything accepted on the HA wire, in either direction. */
export const haWireEnvelopeSchema = z.union([
  haWireRequestSchema,
  haWireSuccessSchema,
  haWireFailureSchema,
]);
export type HaWireEnvelope = z.infer<typeof haWireEnvelopeSchema>;

/** Proposal ack request: a writer event plus a per-attempt anti-forgery nonce. */
export const haProposalPayloadSchema = z.object({
  schema_version: z.literal(MWHA_EVENT_SCHEMA_VERSION),
  event: mwhaWriterEventSchema,
  /** 32-byte hex nonce generated by the proposer; voters must echo it. */
  ack_nonce: z.string().regex(/^[a-f0-9]{64}$/u, 'expected a 64-char hex ack nonce'),
}).strict();
export type HaProposalPayload = z.infer<typeof haProposalPayloadSchema>;

/** Voter decision on one proposal. */
export const haProposalResponseSchema = z.object({
  granted: z.boolean(),
  term: uintSchema,
  epoch: uintSchema,
  voter_id: identifierSchema,
  leader_id: identifierSchema.nullable(),
  ack_nonce: z.string().regex(/^[a-f0-9]{64}$/u),
  detail: z.string().min(1).max(500),
}).strict();
export type HaProposalResponse = z.infer<typeof haProposalResponseSchema>;

/** Catch-up unit replicated between nodes. Mirrors `MultiWriterIngestItem`. */
export const haSyncItemSchema = z.object({
  entry: z.object({
    schema_version: z.literal('mwha.cluster-log-entry.v1' as const),
    identity: mwhaEventIdentitySchema,
    status: z.enum(['proposed', 'committed', 'conflicted', 'adjudicated'] as const),
    leader: mwhaLeaderLeaseSchema.nullable(),
    commit_index: uintSchema,
    conflict_key: z.object({
      writer_id: identifierSchema,
      epoch: uintSchema,
      local_seq: uintSchema,
    }).strict().nullable(),
  }).strict().superRefine((value, context) => {
    // Reuse the frozen entry consistency rules without importing the private
    // validator: committed/adjudicated require a positive index and a lease.
    if (value.status === 'committed' || value.status === 'adjudicated') {
      if (value.commit_index < 1) {
        context.addIssue({ code: 'custom', message: `${value.status} entry must carry a positive commit_index`, path: ['commit_index'] });
      }
      if (value.leader === null) {
        context.addIssue({ code: 'custom', message: `${value.status} entry must carry a leader lease`, path: ['leader'] });
      }
    } else if (value.commit_index !== 0) {
      context.addIssue({ code: 'custom', message: `${value.status} entry must keep commit_index = 0`, path: ['commit_index'] });
    }
  }),
  ledger_event: ledgerEventSchema,
  ledger_event_hash: sha256Schema,
  evidence_id: identifierSchema.nullable().optional(),
}).strict();
export type HaSyncItem = z.infer<typeof haSyncItemSchema>;

export const haSyncRequestSchema = z.object({
  member_id: identifierSchema,
}).strict();

export const haSyncResponseSchema = z.object({
  items: z.array(haSyncItemSchema).max(4_096),
}).strict();

export const haSyncPushSchema = z.object({
  items: z.array(haSyncItemSchema).max(4_096),
}).strict();

export const haSyncPushResponseSchema = z.object({
  applied: uintSchema,
  duplicates: uintSchema,
  conflicts: uintSchema,
}).strict();

function invalid(message: string, cause?: unknown): HaProtocolError {
  return new HaProtocolError('HA_INPUT_INVALID', message, cause === undefined ? undefined : { cause });
}

function issueText(error: z.ZodError): string {
  return error.issues.map((issue) => issue.message).join('; ');
}

// ---------------------------------------------------------------------------
// Frozen framing helpers (the proxy splits on this exact format)
// ---------------------------------------------------------------------------

function encodeHaFrame(message: HaWireEnvelope): Buffer {
  // `encodeTcpReplicaFrame` performs no semantic validation; it only bounds and
  // length-prefixes the JSON body. The cast keeps the frozen tcp-transport
  // module untouched while reusing its codec.
  return encodeTcpReplicaFrame(
    message as unknown as TcpReplicaWireMessage,
    TCP_REPLICA_MAX_FRAME_BYTES,
  );
}

interface DecodedHaFrames {
  readonly frames: readonly HaWireEnvelope[];
  readonly error: HaProtocolError | null;
}

/** Incremental decoder for the frozen 4-byte big-endian length prefix. */
class HaFrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): DecodedHaFrames {
    this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk]);
    const frames: HaWireEnvelope[] = [];
    for (;;) {
      if (this.buffer.length < 4) return { frames, error: null };
      const length = this.buffer.readUInt32BE(0);
      if (length <= 0) {
        this.buffer = Buffer.alloc(0);
        return { frames, error: invalid(`frame length ${String(length)} is not positive`) };
      }
      if (length > TCP_REPLICA_MAX_FRAME_BYTES) {
        this.buffer = Buffer.alloc(0);
        return {
          frames,
          error: invalid(`frame length ${String(length)} exceeds the ${String(TCP_REPLICA_MAX_FRAME_BYTES)} byte limit`),
        };
      }
      if (this.buffer.length < 4 + length) return { frames, error: null };
      const body = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);
      let raw: unknown;
      try {
        raw = JSON.parse(body.toString('utf8'));
      } catch (error) {
        this.buffer = Buffer.alloc(0);
        return { frames, error: invalid('frame body is not valid JSON', error) };
      }
      const parsed = haWireEnvelopeSchema.safeParse(raw);
      if (!parsed.success) {
        this.buffer = Buffer.alloc(0);
        return { frames, error: invalid(`frame violates the HA envelope (${issueText(parsed.error)})`) };
      }
      frames.push(parsed.data);
    }
  }
}

// ---------------------------------------------------------------------------
// HA TCP endpoint (server + client)
// ---------------------------------------------------------------------------

export interface HaEndpoint {
  readonly host: string;
  readonly port: number;
}

type HaReply =
  | { readonly ok: true; readonly payload: unknown }
  | { readonly ok: false; readonly code: string; readonly message: string };

type HaHandler = (kind: HaWireKind, payload: unknown) => HaReply | Promise<HaReply>;

interface HaServerConnection {
  readonly socket: net.Socket;
  readonly decoder: HaFrameDecoder;
}

/**
 * One node's HA listener. Real `node:net` sockets, frozen length-prefixed
 * frames, correlated responses by frame id. No timer is left behind on close.
 */
export class HaTcpServer {
  #server: net.Server | null = null;
  #address: HaEndpoint | null = null;
  readonly #connections = new Set<HaServerConnection>();
  readonly #handler: HaHandler;
  #closed = false;

  constructor(handler: HaHandler) {
    if (typeof handler !== 'function') throw invalid('HA TCP server handler must be a function');
    this.#handler = handler;
  }

  get address(): HaEndpoint | null {
    return this.#address === null ? null : { ...this.#address };
  }

  get activeConnectionCount(): number {
    return this.#connections.size;
  }

  get isClosed(): boolean {
    return this.#closed;
  }

  async listen(host: string, port = 0): Promise<HaEndpoint> {
    if (this.#closed) throw invalid('HA TCP server is closed and cannot listen again');
    if (this.#server !== null) {
      if (this.#address === null) throw invalid('HA TCP server listen state is inconsistent');
      return { ...this.#address };
    }
    if (!isLoopbackHost(host)) {
      throw invalid(`HA TCP server refuses non-loopback bind ${JSON.stringify(host)}`);
    }
    const server = net.createServer((socket) => this.#onConnection(socket));
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const onError = (error: Error): void => {
        if (settled) return;
        settled = true;
        server.removeListener('listening', onListening);
        reject(invalid(`HA TCP server failed to listen on ${host}:${String(port)}: ${String(error.message)}`, error));
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
        server.listen({ host, port });
      } catch (error) {
        onError(error as Error);
      }
    });
    const address = server.address();
    if (address === null || typeof address !== 'object') {
      await this.close();
      throw invalid('HA TCP listener did not report an address');
    }
    this.#server = server;
    this.#address = { host, port: address.port };
    return { ...this.#address };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const connection of [...this.#connections]) {
      connection.socket.removeAllListeners();
      connection.socket.destroy();
      this.#connections.delete(connection);
    }
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
      const guard = setTimeout(finish, 2_000);
      guard.unref?.();
    });
  }

  #onConnection(socket: net.Socket): void {
    if (this.#closed) {
      socket.destroy();
      return;
    }
    const connection: HaServerConnection = { socket, decoder: new HaFrameDecoder() };
    this.#connections.add(connection);
    socket.setNoDelay(true);
    socket.on('data', (chunk: Buffer) => this.#onData(connection, chunk));
    socket.on('error', () => this.#drop(connection));
    socket.on('close', () => this.#drop(connection));
  }

  #drop(connection: HaServerConnection): void {
    if (!this.#connections.has(connection)) return;
    this.#connections.delete(connection);
    connection.socket.removeAllListeners();
    connection.socket.destroy();
  }

  #onData(connection: HaServerConnection, chunk: Buffer): void {
    if (!this.#connections.has(connection)) return;
    const outcome = connection.decoder.push(chunk);
    if (outcome.error !== null) {
      this.#drop(connection);
      return;
    }
    for (const frame of outcome.frames) {
      if ('ok' in frame) continue; // response frame; not expected inbound
      void this.#handle(connection, frame.kind, frame.id, frame.payload);
    }
  }

  async #handle(connection: HaServerConnection, kind: HaWireKind, id: string, payload: unknown): Promise<void> {
    let reply: HaReply;
    try {
      reply = await this.#handler(kind, payload);
    } catch (error) {
      reply = {
        ok: false,
        code: error instanceof HaProtocolError ? error.code : 'HA_INPUT_INVALID',
        message: error instanceof Error ? error.message : String(error),
      };
    }
    if (!this.#connections.has(connection) || connection.socket.destroyed || !connection.socket.writable) return;
    const frame: HaWireEnvelope = reply.ok
      ? { schema_version: MWHA_PROTOCOL_SCHEMA_VERSION, kind, id, ok: true, payload: reply.payload }
      : {
          schema_version: MWHA_PROTOCOL_SCHEMA_VERSION,
          kind,
          id,
          ok: false,
          error: { code: reply.code, message: reply.message },
        };
    try {
      connection.socket.write(encodeHaFrame(frame));
    } catch {
      this.#drop(connection);
    }
  }
}

interface HaPendingRequest {
  readonly resolve: (payload: unknown) => void;
  readonly reject: (error: HaProtocolError) => void;
  timer: NodeJS.Timeout | null;
}

/**
 * One outbound HA channel. It dials a target resolved lazily (so the cluster can
 * rebuild proxy links), correlates responses by frame id, times out honestly
 * when a proxy drops frames, and reconnects after a link teardown.
 */
export class HaTcpClient {
  readonly #resolveTarget: () => HaEndpoint | undefined;
  readonly #connectTimeoutMs: number;
  readonly #requestTimeoutMs: number;
  #socket: net.Socket | null = null;
  #decoder: HaFrameDecoder | null = null;
  #lastTarget: HaEndpoint | null = null;
  readonly #pending = new Map<string, HaPendingRequest>();
  #sequence = 0;
  #connecting: Promise<void> | null = null;
  #closed = false;

  constructor(
    resolveTarget: () => HaEndpoint | undefined,
    options: { connectTimeoutMs?: number; requestTimeoutMs?: number } = {},
  ) {
    if (typeof resolveTarget !== 'function') throw invalid('HA TCP client target resolver must be a function');
    this.#resolveTarget = resolveTarget;
    this.#connectTimeoutMs = positiveInt(options.connectTimeoutMs, 1_500, 'connectTimeoutMs');
    this.#requestTimeoutMs = positiveInt(options.requestTimeoutMs, 2_000, 'requestTimeoutMs');
  }

  get activeConnectionCount(): number {
    return this.#socket !== null && !this.#socket.destroyed && !this.#closed ? 1 : 0;
  }

  get isClosed(): boolean {
    return this.#closed;
  }

  request(kind: HaWireKind, payload: unknown, timeoutMs?: number): Promise<unknown> {
    if (this.#closed) {
      return Promise.reject(new HaProtocolError('QUORUM_NOT_REACHED', 'HA TCP client is closed'));
    }
    const target = this.#resolveTarget();
    if (target === undefined) {
      return Promise.reject(new HaProtocolError('QUORUM_NOT_REACHED', 'HA TCP target address is unavailable'));
    }
    const timeout = positiveInt(timeoutMs, this.#requestTimeoutMs, 'timeoutMs');
    return this.#ensureConnected(target).then(() => this.#send(kind, payload, timeout));
  }

  /** Force-drop the current link so the next request dials the latest target. */
  async reset(): Promise<void> {
    this.#failPending(new HaProtocolError('QUORUM_NOT_REACHED', 'HA TCP link was rebuilt'));
    await this.#teardownSocket();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#failPending(new HaProtocolError('QUORUM_NOT_REACHED', 'HA TCP client closed'));
    await this.#teardownSocket();
  }

  #send(kind: HaWireKind, payload: unknown, timeout: number): Promise<unknown> {
    const socket = this.#socket;
    if (socket === null || socket.destroyed) {
      return Promise.reject(new HaProtocolError('QUORUM_NOT_REACHED', 'HA TCP socket is not usable'));
    }
    this.#sequence += 1;
    const id = `ha-${this.#sequence.toString(36)}-${randomBytes(6).toString('hex')}`;
    const frame: HaWireEnvelope = { schema_version: MWHA_PROTOCOL_SCHEMA_VERSION, kind, id, payload };
    let encoded: Buffer;
    try {
      encoded = encodeHaFrame(frame);
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise<unknown>((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null;
      const pending: HaPendingRequest = { resolve, reject, timer: null };
      timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new HaProtocolError(
          'QUORUM_NOT_REACHED',
          `${kind} exceeded its ${String(timeout)}ms budget without a real TCP response`,
        ));
      }, timeout);
      pending.timer = timer;
      timer.unref?.();
      this.#pending.set(id, pending);
      try {
        socket.write(encoded);
      } catch (error) {
        if (timer !== null) clearTimeout(timer);
        this.#pending.delete(id);
        reject(new HaProtocolError('QUORUM_NOT_REACHED', `failed to write ${kind}: ${String(error)}`, { cause: error }));
      }
    });
  }

  #ensureConnected(target: HaEndpoint): Promise<void> {
    if (this.#closed) {
      return Promise.reject(new HaProtocolError('QUORUM_NOT_REACHED', 'HA TCP client is closed'));
    }
    if (this.#socket !== null && !this.#socket.destroyed && this.#lastTarget === target) return Promise.resolve();
    if (this.#socket !== null || this.#connecting !== null) {
      // Target changed (proxy rebuilt) or socket dead: drop before dialling.
      void this.#teardownSocket();
    }
    if (this.#connecting !== null) return this.#connecting;
    this.#connecting = this.#connect(target)
      .catch((error: unknown) => {
        const wrapped = error instanceof HaProtocolError
          ? error
          : new HaProtocolError('QUORUM_NOT_REACHED', `HA TCP connect failed: ${String(error)}`, { cause: error });
        void this.#teardownSocket();
        throw wrapped;
      })
      .finally(() => {
        this.#connecting = null;
      });
    return this.#connecting;
  }

  #connect(target: HaEndpoint): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!isLoopbackHost(target.host)) {
        reject(new HaProtocolError('QUORUM_NOT_REACHED', `HA TCP client refuses non-loopback target ${JSON.stringify(target.host)}`));
        return;
      }
      const socket = net.connect({ host: target.host, port: target.port });
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new HaProtocolError('QUORUM_NOT_REACHED', `HA TCP connect exceeded its ${String(this.#connectTimeoutMs)}ms budget`));
      }, this.#connectTimeoutMs);
      timer.unref?.();
      const cleanup = (): void => {
        clearTimeout(timer);
        socket.removeListener('error', onError);
        socket.removeListener('close', onClose);
      };
      const onError = (error: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new HaProtocolError('QUORUM_NOT_REACHED', `HA TCP connect failed: ${String(error.message)}`, { cause: error }));
      };
      const onClose = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new HaProtocolError('QUORUM_NOT_REACHED', 'HA TCP socket closed before connect completed'));
      };
      socket.once('error', onError);
      socket.once('close', onClose);
      socket.once('connect', () => {
        if (settled) return;
        settled = true;
        cleanup();
        this.#socket = socket;
        this.#lastTarget = target;
        this.#decoder = new HaFrameDecoder();
        socket.on('data', (chunk: Buffer) => this.#onData(chunk));
        socket.on('error', () => {
          this.#failPending(new HaProtocolError('QUORUM_NOT_REACHED', 'HA TCP socket error'));
          void this.#teardownSocket();
        });
        socket.on('close', () => {
          this.#failPending(new HaProtocolError('QUORUM_NOT_REACHED', 'HA TCP peer closed the connection'));
          void this.#teardownSocket();
        });
        resolve();
      });
    });
  }

  #onData(chunk: Buffer): void {
    const decoder = this.#decoder;
    if (decoder === null) return;
    const outcome = decoder.push(chunk);
    if (outcome.error !== null) {
      this.#failPending(outcome.error);
      void this.#teardownSocket();
      return;
    }
    for (const frame of outcome.frames) {
      if (!('ok' in frame)) continue;
      const pending = this.#pending.get(frame.id);
      if (pending === undefined) continue;
      this.#pending.delete(frame.id);
      if (pending.timer !== null) clearTimeout(pending.timer);
      if (frame.ok === true) pending.resolve(frame.payload);
      else pending.reject(new HaProtocolError(frame.error.code, frame.error.message));
    }
  }

  #failPending(error: HaProtocolError): void {
    for (const pending of this.#pending.values()) {
      if (pending.timer !== null) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  async #teardownSocket(): Promise<void> {
    const socket = this.#socket;
    this.#socket = null;
    this.#decoder = null;
    this.#lastTarget = null;
    if (socket === null) return;
    socket.removeAllListeners();
    if (!socket.destroyed) socket.destroy();
  }
}

function positiveInt(value: number | undefined, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw invalid(`${field} must be a positive integer, got ${String(value)}`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// VoterRpc over real TCP
// ---------------------------------------------------------------------------

class TcpHaVoterRpc implements VoterRpc {
  readonly #voterId: string;
  readonly #targetId: string;
  readonly #client: HaTcpClient;

  constructor(voterId: string, targetId: string, client: HaTcpClient) {
    this.#voterId = voterId;
    this.#targetId = targetId;
    this.#client = client;
  }

  get target_id(): string {
    return this.#targetId;
  }

  get voter_id(): string {
    return this.#voterId;
  }

  requestVote(request: VoteRequest): Promise<z.infer<typeof mwhaVoteResponseSchema>> {
    return this.#client.request('vote-request', request).then((payload) => mwhaVoteResponseSchema.parse(payload));
  }

  sendHeartbeat(request: HeartbeatRequest): Promise<z.infer<typeof mwhaHeartbeatResponseSchema>> {
    return this.#client.request('heartbeat-request', request).then((payload) => mwhaHeartbeatResponseSchema.parse(payload));
  }
}

// ---------------------------------------------------------------------------
// Ack verification (forged/duplicate/unexpected acks are refused)
// ---------------------------------------------------------------------------

/**
 * Fail-closed verification of proposal acks. Only distinct, expected voter ids
 * that arrived as real TCP responses may count; the proposer adds itself as the
 * final vote. Below quorum throws `QUORUM_NOT_REACHED`.
 */
export function verifyProposalAcks(
  acks: readonly string[],
  expectedRemoteIds: readonly string[],
  votingCount: number,
): void {
  const seen = new Set<string>();
  for (const ack of acks) {
    if (!expectedRemoteIds.includes(ack)) {
      throw invalid(`ack from ${JSON.stringify(ack)} is not a verified real-TCP response from an expected voter`);
    }
    if (seen.has(ack)) {
      throw invalid(`duplicate ack from ${JSON.stringify(ack)}; a voter cannot grant two votes in one attempt`);
    }
    seen.add(ack);
  }
  assertQuorum(seen.size + 1, votingCount);
}

// ---------------------------------------------------------------------------
// Node
// ---------------------------------------------------------------------------

export interface HaNodeOptions {
  readonly memberId: string;
  readonly members: readonly MwhaMember[];
  readonly now: () => number;
  readonly leaseDurationMs: number;
  readonly heartbeatTimeoutMs: number;
  readonly host: string;
  readonly sharedSecret: string | Buffer;
  readonly authorizedNodes: readonly string[];
  readonly requestTimeoutMs: number;
}

/**
 * One cluster member: a real frozen {@link TcpReplicaServer} for the replica
 * surface, a real HA TCP endpoint used by {@link LeaderLeaseManager}'s
 * {@link VoterRpc}, and a {@link MultiWriterLog}. No socket is opened before
 * {@link HaNode.start}; {@link HaNode.close} releases every socket and timer.
 */
export class HaNode {
  readonly memberId: string;
  readonly manager: LeaderLeaseManager;
  readonly log: MultiWriterLog;
  readonly replica: TcpReplicaServer;
  readonly haServer: HaTcpServer;
  /** Lazily-resolved remote endpoints; the cluster mutates this on repartition. */
  readonly remoteTargets = new Map<string, HaEndpoint>();
  readonly clients = new Map<string, HaTcpClient>();
  readonly clock: () => number;
  readonly host: string;
  #haAddress: HaEndpoint | null = null;
  #replicaAddress: HaEndpoint | null = null;
  #started = false;
  #closed = false;

  constructor(options: HaNodeOptions) {
    this.memberId = options.memberId;
    this.clock = options.now;
    this.host = options.host;
    this.log = new MultiWriterLog();

    const others = options.members.filter((member) => member.member_id !== options.memberId);
    for (const other of others) {
      const client = new HaTcpClient(
        () => this.remoteTargets.get(other.member_id),
        { requestTimeoutMs: options.requestTimeoutMs },
      );
      this.clients.set(other.member_id, client);
    }
    const voters: VoterRpc[] = others.map((other) => new TcpHaVoterRpc(
      options.memberId,
      other.member_id,
      this.clients.get(other.member_id)!,
    ));

    this.manager = new LeaderLeaseManager({
      member_id: options.memberId,
      members: options.members,
      voters,
      now: options.now,
      leaseDurationMs: options.leaseDurationMs,
      heartbeatTimeoutMs: options.heartbeatTimeoutMs,
    });

    this.haServer = new HaTcpServer((kind, payload) => this.#handleHa(kind, payload));

    const service: TcpReplicaService = {
      status: () => ({
        replicaId: this.memberId,
        commitIndex: this.log.maxCommitIndex,
        viewDigest: 'ha-cluster-view',
        evidenceDigest: 'ha-cluster-evidence',
        state: 'ACTIVE',
        snapshot: {
          project_scope: 'ha-cluster',
          ledger_digest: 'ha-cluster-ledger',
          graph_revision: null,
          source_fingerprint: null,
          connected_digest: null,
        } satisfies AnchorProbeSnapshot,
      }),
    };
    this.replica = new TcpReplicaServer({
      host: options.host,
      port: 0,
      sharedSecret: options.sharedSecret,
      nodeId: options.memberId,
      authorizedNodes: options.authorizedNodes,
      service,
      idleTimeoutMs: 0,
    });
  }

  get haAddress(): HaEndpoint | null {
    return this.#haAddress === null ? null : { ...this.#haAddress };
  }

  get replicaAddress(): HaEndpoint | null {
    return this.#replicaAddress === null ? null : { ...this.#replicaAddress };
  }

  get isClosed(): boolean {
    return this.#closed;
  }

  get activeConnectionCount(): number {
    let total = this.haServer.activeConnectionCount + this.replica.activeConnectionCount;
    for (const client of this.clients.values()) total += client.activeConnectionCount;
    return total;
  }

  async start(): Promise<void> {
    if (this.#closed) throw invalid(`node ${this.memberId} is closed`);
    if (this.#started) return;
    this.#haAddress = await this.haServer.listen(this.host, 0);
    this.#replicaAddress = await this.replica.listen();
    this.#started = true;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const client of this.clients.values()) await client.close();
    await this.haServer.close();
    await this.replica.close();
    this.#haAddress = null;
    this.#replicaAddress = null;
  }

  /** Send one HA request to a remote node over its current real-TCP link. */
  requestTo(targetMemberId: string, kind: HaWireKind, payload: unknown, timeoutMs?: number): Promise<unknown> {
    const client = this.clients.get(targetMemberId);
    if (client === undefined) throw invalid(`node ${this.memberId} has no HA link to ${targetMemberId}`);
    return client.request(kind, payload, timeoutMs);
  }

  #handleHa(kind: HaWireKind, payload: unknown): HaReply {
    switch (kind) {
      case 'vote-request': {
        return { ok: true, payload: this.manager.handleVoteRequest(mwhaVoteRequestSchema.parse(payload)) };
      }
      case 'heartbeat-request': {
        return { ok: true, payload: this.manager.handleHeartbeat(mwhaHeartbeatRequestSchema.parse(payload)) };
      }
      case 'proposal': {
        const request = haProposalPayloadSchema.parse(payload);
        const baseline = this.manager.currentLease;
        const candidate = request.event.leader;
        const fence = candidate === null
          ? { allowed: false as const, code: 'FENCE_REJECTED' as const, detail: 'proposal carries no leader lease' }
          : baseline === null
            ? { allowed: true as const, code: 'FENCE_OK' as const, detail: 'no local lease baseline' }
            : evaluateFence(baseline, candidate);
        return {
          ok: true,
          payload: {
            granted: fence.allowed,
            term: this.manager.term,
            epoch: this.manager.epoch,
            voter_id: this.memberId,
            leader_id: this.manager.leaderId,
            ack_nonce: request.ack_nonce,
            detail: fence.detail,
          } satisfies HaProposalResponse,
        };
      }
      case 'sync-request': {
        haSyncRequestSchema.parse(payload);
        return { ok: true, payload: { items: this.log.getEntries().map(toHaSyncItem) } };
      }
      case 'sync-push': {
        const parsed = haSyncPushSchema.parse(payload);
        const report = this.log.ingest(parsed.items.map(fromHaSyncItem));
        return {
          ok: true,
          payload: {
            applied: report.applied,
            duplicates: report.duplicates,
            conflicts: report.conflicts,
          } satisfies z.infer<typeof haSyncPushResponseSchema>,
        };
      }
      default:
        return { ok: false, code: 'HA_INPUT_INVALID', message: `unsupported HA wire kind ${JSON.stringify(kind)}` };
    }
  }
}

function toHaSyncItem(record: MultiWriterEntryRecord): HaSyncItem {
  return {
    entry: record.entry,
    ledger_event: record.ledgerEvent,
    ledger_event_hash: record.ledgerEventHash,
    ...(record.evidenceId === null ? {} : { evidence_id: record.evidenceId }),
  };
}

function fromHaSyncItem(item: HaSyncItem): MultiWriterIngestItem {
  return {
    entry: item.entry,
    ledgerEvent: item.ledger_event,
    ledgerEventHash: item.ledger_event_hash,
    ...(item.evidence_id === undefined ? {} : { evidenceId: item.evidence_id }),
  };
}

// ---------------------------------------------------------------------------
// Cluster
// ---------------------------------------------------------------------------

export interface HaClusterOptions {
  /** Defaults to `['n1','n2','n3']`; N=3/4/5 covered by tests. */
  readonly memberIds?: readonly string[];
  /** Defaults to `127.0.0.1`; a non-loopback host is refused before any bind. */
  readonly host?: string;
  /** Injectable initial physical sample for every node lease clock. */
  readonly now?: () => number;
  readonly leaseDurationMs?: number;
  readonly heartbeatTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly connectTimeoutMs?: number;
  /** Runtime-only HMAC secret for the frozen replica servers; never persisted. */
  readonly sharedSecret?: string | Buffer;
}

export interface HaProposeInput {
  /** Node acting as leader/proposer. */
  readonly memberId: string;
  readonly writerId: string;
  readonly epoch: number;
  readonly term: number;
  readonly localSeq: number;
  /** Already committed ledger event referenced by `ledgerEventHash`. */
  readonly ledgerEvent: LedgerEvent;
  /** Caller-computed `hashEvent(ledgerEvent)`; never recomputed here. */
  readonly ledgerEventHash: string;
  readonly evidenceId?: string | null;
}

export interface HaProposeResult {
  readonly committed: true;
  readonly member_id: string;
  readonly commit_index: number;
  readonly version: MwhaLogicalVersion;
  readonly evidence_id: string | null;
  readonly acks: readonly string[];
  readonly quorum_size: number;
  readonly replicated_to: readonly string[];
  readonly replication_failures: readonly { readonly member_id: string; readonly code: string }[];
}

export interface HaNodeStatus {
  readonly member_id: string;
  readonly role: 'follower' | 'leader';
  readonly epoch: number;
  readonly term: number;
  readonly leader_id: string | null;
  readonly lease_expires_at_ms: number | null;
  readonly lease_expired: boolean;
  readonly committed_count: number;
  readonly max_commit_index: number;
  readonly ha_address: HaEndpoint | null;
  readonly replica_address: HaEndpoint | null;
  readonly active_connection_count: number;
}

export interface HaClusterStatus {
  readonly cluster_id: string;
  readonly member_ids: readonly string[];
  readonly voting_count: number;
  readonly quorum_size: number;
  readonly leader_id: string | null;
  readonly declarations: readonly MwhaLeaderLease[];
  readonly multiple_leaders: readonly MwhaMultipleLeader[];
  readonly nodes: readonly HaNodeStatus[];
  readonly partitions: readonly (readonly string[])[];
  readonly verification_scope: typeof HA_CLUSTER_VERIFICATION_SCOPE;
  readonly verification_note: string;
}

export interface HaClusterProjection extends MultiWriterProjection {
  readonly gate_ok: true;
  readonly verification_scope: typeof HA_CLUSTER_VERIFICATION_SCOPE;
  readonly verification_note: string;
}

export interface HaRejoinResult extends LeaderLeaseRejoinReport {
  readonly ingested: number;
  readonly duplicates: number;
  readonly conflicts: number;
  readonly adjudications: readonly MultiWriterAdjudicationRecord[];
}

export interface HaResourceStats {
  readonly nodes_open: number;
  readonly ha_servers_open: number;
  readonly replica_servers_open: number;
  readonly proxies_open: number;
  readonly clients_open: number;
  readonly active_connections: number;
}

interface PartitionState {
  readonly groups: readonly (readonly string[])[] | null;
}

/**
 * Build and manage N real local-TCP nodes. Every remote link is a
 * {@link TcpFaultProxy}; repartitioning closes and rebuilds those links so the
 * isolation is a genuine socket-level cut, never an in-memory boolean shortcut.
 */
export class HaCluster {
  readonly clusterId = 'ha-cluster';
  readonly members: readonly MwhaMember[];
  readonly votingCount: number;
  readonly quorumSize: number;
  readonly host: string;
  readonly sharedSecret: string | Buffer;
  readonly requestTimeoutMs: number;
  readonly connectTimeoutMs: number;
  readonly leaseDurationMs: number;
  readonly heartbeatTimeoutMs: number;

  readonly #nodes = new Map<string, HaNode>();
  readonly #proxies: TcpFaultProxy[] = [];
  readonly #clockState: { t: number };
  #partitions: PartitionState = { groups: null };
  #closed = false;

  private constructor(options: Required<HaClusterOptions>) {
    this.members = options.memberIds.map((memberId) => ({ member_id: memberId, role: 'writer' }));
    this.votingCount = votingMemberCount(this.members);
    this.quorumSize = quorumSizeForMembers(this.members);
    this.host = options.host;
    this.sharedSecret = options.sharedSecret;
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.connectTimeoutMs = options.connectTimeoutMs;
    this.leaseDurationMs = options.leaseDurationMs;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs;
    this.#clockState = { t: options.now() };
  }

  static async start(options: HaClusterOptions = {}): Promise<HaCluster> {
    const memberIds = options.memberIds ?? ['n1', 'n2', 'n3'];
    if (memberIds.length === 0) throw invalid('memberIds must be a non-empty array');
    if (new Set(memberIds).size !== memberIds.length) throw invalid('memberIds must be unique');
    for (const memberId of memberIds) {
      if (mwhaMemberSchema.safeParse({ member_id: memberId, role: 'writer' }).success === false) {
        throw invalid(`memberId ${JSON.stringify(memberId)} is not a bounded identifier`);
      }
    }
    if (!isLoopbackHost(options.host ?? '127.0.0.1')) {
      throw invalid(`cluster host ${JSON.stringify(options.host)} is not loopback; refusing external binds`);
    }
    const members: MwhaMember[] = memberIds.map((memberId) => ({ member_id: memberId, role: 'writer' }));
    // Derive quorum from the topology exactly like the frozen contract; a
    // hand-written majority can never widen or narrow it.
    mwhaTopologySchema.parse({
      schema_version: MWHA_PROTOCOL_SCHEMA_VERSION,
      cluster_id: 'ha-cluster',
      members,
      quorum_size: quorumSizeForMembers(members),
    });

    const resolved: Required<HaClusterOptions> = {
      memberIds,
      host: options.host ?? '127.0.0.1',
      now: options.now ?? Date.now,
      leaseDurationMs: positiveInt(options.leaseDurationMs, 5_000, 'leaseDurationMs'),
      heartbeatTimeoutMs: positiveInt(options.heartbeatTimeoutMs, 5_000, 'heartbeatTimeoutMs'),
      requestTimeoutMs: positiveInt(options.requestTimeoutMs, 2_000, 'requestTimeoutMs'),
      connectTimeoutMs: positiveInt(options.connectTimeoutMs, 1_500, 'connectTimeoutMs'),
      sharedSecret: options.sharedSecret ?? randomBytes(32).toString('hex'),
    };
    const cluster = new HaCluster(resolved);

    for (const memberId of memberIds) {
      const node = new HaNode({
        memberId,
        members: cluster.members,
        now: () => cluster.#clockState.t,
        leaseDurationMs: cluster.leaseDurationMs,
        heartbeatTimeoutMs: cluster.heartbeatTimeoutMs,
        host: cluster.host,
        sharedSecret: cluster.sharedSecret,
        authorizedNodes: memberIds,
        requestTimeoutMs: cluster.requestTimeoutMs,
      });
      cluster.#nodes.set(memberId, node);
    }
    for (const node of cluster.#nodes.values()) await node.start();
    await cluster.#rebuildLinks(null);
    return cluster;
  }

  get memberIds(): readonly string[] {
    return this.members.map((member) => member.member_id);
  }

  get isClosed(): boolean {
    return this.#closed;
  }

  node(memberId: string): HaNode {
    const node = this.#nodes.get(memberId);
    if (node === undefined) throw invalid(`unknown cluster member ${JSON.stringify(memberId)}`);
    return node;
  }

  /** Advance every node's injected lease clock. Version ordering never reads it. */
  advanceClock(ms: number): void {
    if (!Number.isSafeInteger(ms) || ms < 0) throw invalid(`clock advance must be a nonnegative integer, got ${String(ms)}`);
    this.#clockState.t += ms;
  }

  async elect(memberId: string): Promise<LeaderLeaseElectionResult> {
    this.#assertOpen();
    return await this.node(memberId).manager.requestVote();
  }

  /**
   * Commit one already-committed ledger event. Requires: caller is the current
   * lease holder, the held lease matches `(epoch, term)`, the frozen fencing
   * check passes, and a verified majority of real-TCP proposal acks responds.
   */
  async propose(input: HaProposeInput): Promise<HaProposeResult> {
    this.#assertOpen();
    const node = this.node(input.memberId);
    if (input.writerId.length === 0 || input.writerId.length > 128) {
      throw invalid('writerId must be a bounded identifier');
    }
    const ledgerEvent = ledgerEventSchema.parse(input.ledgerEvent);
    const identity: MwhaEventIdentity = {
      writer_id: input.writerId,
      epoch: input.epoch,
      term: input.term,
      local_seq: input.localSeq,
      ledger_event_hash: input.ledgerEventHash,
    };
    const parsedIdentity = mwhaEventIdentitySchema.parse(identity);
    if (parsedIdentity.ledger_event_hash !== input.ledgerEventHash) {
      throw invalid('identity ledger_event_hash must equal the caller-supplied ledgerEventHash');
    }

    const current = node.manager.currentLease;
    if (current === null) {
      throw new HaProtocolError('FENCE_REJECTED', `${input.memberId} holds no lease; only a lease holder may propose`);
    }
    if (current.leader_id !== input.memberId) {
      throw new HaProtocolError(
        'FENCE_REJECTED',
        `${input.memberId} is not the current lease holder (leader=${current.leader_id})`,
      );
    }
    const fenceCandidate = { term: input.term, leader_id: input.memberId, epoch: input.epoch };
    if (input.epoch > current.epoch || (input.epoch === current.epoch && input.term > current.term)) {
      throw new HaProtocolError(
        'FENCE_REJECTED',
        `write epoch ${String(input.epoch)}/term ${String(input.term)} is ahead of the held lease epoch ${String(current.epoch)}/term ${String(current.term)}`,
      );
    }
    const fence = evaluateFence(current, fenceCandidate);
    if (!fence.allowed) throw new HaProtocolError(fence.code, fence.detail);

    const event: MwhaWriterEvent = {
      schema_version: MWHA_EVENT_SCHEMA_VERSION,
      identity: parsedIdentity,
      leader: current,
    };
    mwhaWriterEventSchema.parse(event);

    const ackNonce = randomBytes(32).toString('hex');
    const remotes = this.memberIds.filter((memberId) => memberId !== input.memberId);
    const outcomes = await Promise.allSettled(remotes.map(async (remoteId) => {
      const raw = await node.requestTo(
        remoteId,
        'proposal',
        { schema_version: MWHA_EVENT_SCHEMA_VERSION, event, ack_nonce: ackNonce },
      );
      const response = haProposalResponseSchema.parse(raw);
      if (response.ack_nonce !== ackNonce) {
        throw invalid(`proposal response from ${remoteId} did not echo the per-attempt ack nonce`);
      }
      if (response.voter_id !== remoteId) {
        throw invalid(`proposal response voter_id ${response.voter_id} does not match target ${remoteId}`);
      }
      return response;
    }));

    const granted: string[] = [];
    const rejected: { member_id: string; detail: string }[] = [];
    const unreachable: string[] = [];
    for (const [index, outcome] of outcomes.entries()) {
      const remoteId = remotes[index]!;
      if (outcome.status === 'rejected') {
        unreachable.push(remoteId);
        continue;
      }
      if (outcome.value.granted) granted.push(remoteId);
      else rejected.push({ member_id: remoteId, detail: outcome.value.detail });
    }
    verifyProposalAcks(granted, remotes, this.votingCount);

    const grant = node.manager.assertCanCommit(parsedIdentity);
    // Mirror the frozen log's deterministic evidence derivation so every
    // committed proposal carries a real Gate evidence reference.
    const evidenceId = input.evidenceId ?? `ev-${parsedIdentity.ledger_event_hash.slice(0, 32)}`;
    const appended = node.log.append({
      event,
      ledgerEvent,
      ledgerEventHash: input.ledgerEventHash,
      commitIndex: grant.commit_index,
      evidenceId,
    });

    const item = toHaSyncItem(appended.entry);
    const replicationOutcomes = await Promise.allSettled(remotes.map(async (remoteId) => {
      const raw = await node.requestTo(remoteId, 'sync-push', { items: [item] });
      return haSyncPushResponseSchema.parse(raw);
    }));
    const replicatedTo: string[] = [];
    const replicationFailures: { member_id: string; code: string }[] = [];
    for (const [index, outcome] of replicationOutcomes.entries()) {
      const remoteId = remotes[index]!;
      if (outcome.status === 'fulfilled') replicatedTo.push(remoteId);
      else replicationFailures.push({ member_id: remoteId, code: errorCodeOf(outcome.reason) });
    }

    return {
      committed: true,
      member_id: input.memberId,
      commit_index: appended.entry.entry.commit_index,
      version: logicalVersionOfEntry(appended.entry.entry),
      evidence_id: appended.evidenceId,
      acks: [input.memberId, ...granted],
      quorum_size: this.quorumSize,
      replicated_to: replicatedTo,
      replication_failures: replicationFailures,
    };
  }

  /**
   * Reconnect one node: adopt the newest visible lease and catch up committed
   * records over real TCP. Conflicting branches are retained and resolved by
   * explicit, complete adjudication preferring the peer's newer branch; the
   * old leader can never overwrite the new leader.
   */
  async rejoin(memberId: string): Promise<HaRejoinResult> {
    this.#assertOpen();
    const node = this.node(memberId);
    let cachedItems: readonly HaSyncItem[] = [];
    let applyReport: { ingested: number; duplicates: number; conflicts: number } = {
      ingested: 0,
      duplicates: 0,
      conflicts: 0,
    };
    let madeAdjudications: MultiWriterAdjudicationRecord[] = [];

    const report = await node.manager.rejoin({
      fetchCommitted: async (peer) => {
        const raw = await node.requestTo(peer.member_id, 'sync-request', { member_id: memberId });
        const parsed = haSyncResponseSchema.parse(raw);
        cachedItems = parsed.items;
        return parsed.items.map((item): LeaderLeaseCommitRecord => ({
          identity: item.entry.identity,
          commit_index: item.entry.commit_index,
          leader: item.entry.leader!,
          version: logicalVersionOfEntry(item.entry),
        }));
      },
      apply: async () => {
        if (cachedItems.length === 0) return;
        const ingested = node.log.ingest(cachedItems.map(fromHaSyncItem));
        applyReport = {
          ingested: ingested.applied,
          duplicates: ingested.duplicates,
          conflicts: ingested.conflicts,
        };
        madeAdjudications = adjudicateNewestBranches(
          node.log,
          new Set(cachedItems.map((item) => item.entry.identity.ledger_event_hash)),
        );
      },
    });

    return {
      ...report,
      ingested: applyReport.ingested,
      duplicates: applyReport.duplicates,
      conflicts: applyReport.conflicts,
      adjudications: madeAdjudications,
    };
  }

  /**
   * Refuse two leaders for one `(epoch, term)`. A rival declaration throws the
   * frozen `SPLIT_BRAIN` code; it is also recorded as a split-brain signal by
   * the receiving node's `observeLease` path.
   */
  assertNoRivalLeader(memberId: string, lease: MwhaLeaderLease): void {
    this.#assertOpen();
    const parsed = mwhaLeaderLeaseSchema.parse(lease);
    if (parsed.leader_id !== memberId) {
      throw invalid('assertNoRivalLeader lease leader_id must match memberId');
    }
    assertSingleLeader([...this.#declarations(), parsed]);
    this.node(memberId).manager.observeLease(parsed);
  }

  /** Current deterministic projection over every retained entry/adjudication. */
  projection(): HaClusterProjection {
    this.#assertOpen();
    const records: MultiWriterEntryRecord[] = [];
    const seenContent = new Set<string>();
    for (const node of this.#nodes.values()) {
      for (const record of node.log.getEntries()) {
        const key = contentKey(record.entry.identity);
        if (seenContent.has(key)) continue;
        seenContent.add(key);
        records.push(record);
      }
    }
    const adjudications = this.#aggregateAdjudications();
    const projection = projectMultiWriterState(records, adjudications);
    for (const state of projection.states) assertGateBoundary(state);
    return {
      ...projection,
      gate_ok: true,
      verification_scope: HA_CLUSTER_VERIFICATION_SCOPE,
      verification_note: HA_CLUSTER_VERIFICATION_NOTE,
    };
  }

  status(): HaClusterStatus {
    this.#assertOpen();
    const declarations = this.#declarations();
    const multiple = detectMultipleLeaders(declarations);
    let leader: MwhaLeaderLease | null = null;
    for (const declaration of declarations) {
      if (leader === null
        || declaration.epoch > leader.epoch
        || (declaration.epoch === leader.epoch && declaration.term > leader.term)
        || (declaration.epoch === leader.epoch && declaration.term === leader.term && declaration.leader_id > leader.leader_id)) {
        leader = declaration;
      }
    }
    return {
      cluster_id: this.clusterId,
      member_ids: this.memberIds,
      voting_count: this.votingCount,
      quorum_size: this.quorumSize,
      leader_id: leader?.leader_id ?? null,
      declarations,
      multiple_leaders: multiple,
      nodes: this.memberIds.map((memberId) => {
        const node = this.node(memberId);
        const snapshot = node.manager.snapshot();
        return {
          member_id: memberId,
          role: snapshot.role,
          epoch: snapshot.epoch,
          term: snapshot.term,
          leader_id: snapshot.leader?.leader_id ?? null,
          lease_expires_at_ms: snapshot.lease_expires_at_ms,
          lease_expired: snapshot.lease_expired,
          committed_count: snapshot.committed_count,
          max_commit_index: snapshot.max_commit_index,
          ha_address: node.haAddress,
          replica_address: node.replicaAddress,
          active_connection_count: node.activeConnectionCount,
        };
      }),
      partitions: this.#partitions.groups === null ? [] : this.#partitions.groups.map((group) => [...group]),
      verification_scope: HA_CLUSTER_VERIFICATION_SCOPE,
      verification_note: HA_CLUSTER_VERIFICATION_NOTE,
    };
  }

  /** True when at least one current partition could independently reach quorum. */
  evaluateCurrentPartitions(): ReturnType<typeof evaluatePartitions> {
    this.#assertOpen();
    const sizes = this.#partitionSizes();
    return evaluatePartitions(sizes, this.votingCount);
  }

  #partitionSizes(): number[] {
    const groups = this.#partitions.groups;
    if (groups === null) return [this.votingCount];
    const listed = new Set(groups.flat());
    const sizes = groups.map((group) => group.length);
    for (const memberId of this.memberIds) {
      if (!listed.has(memberId)) sizes.push(1);
    }
    return sizes;
  }

  /** Cut the listed member groups apart by rebuilding every directed link. */
  async isolate(groups: readonly (readonly string[])[]): Promise<void> {
    this.#assertOpen();
    if (groups.length === 0) throw invalid('isolate requires at least one partition group');
    const seen = new Set<string>();
    for (const group of groups) {
      if (group.length === 0) throw invalid('partition groups must be non-empty');
      for (const memberId of group) {
        if (!this.#nodes.has(memberId)) throw invalid(`partition references unknown member ${JSON.stringify(memberId)}`);
        if (seen.has(memberId)) throw invalid(`member ${memberId} appears in more than one partition group`);
        seen.add(memberId);
      }
    }
    await this.#rebuildLinks(groups);
  }

  /** Restore full connectivity by rebuilding clean proxy links. */
  async restore(): Promise<void> {
    this.#assertOpen();
    await this.#rebuildLinks(null);
  }

  resourceStats(): HaResourceStats {
    let haServersOpen = 0;
    let replicaServersOpen = 0;
    let clientsOpen = 0;
    let activeConnections = 0;
    for (const node of this.#nodes.values()) {
      if (!node.haServer.isClosed) haServersOpen += 1;
      if (!node.replica.isClosed) replicaServersOpen += 1;
      if (!node.isClosed) clientsOpen += 1;
      activeConnections += node.activeConnectionCount;
    }
    let proxiesOpen = 0;
    let proxyConnections = 0;
    for (const proxy of this.#proxies) {
      if (!proxy.isClosed) proxiesOpen += 1;
      proxyConnections += proxy.stats().activeConnections;
    }
    return {
      nodes_open: this.#nodes.size,
      ha_servers_open: haServersOpen,
      replica_servers_open: replicaServersOpen,
      proxies_open: proxiesOpen,
      clients_open: clientsOpen,
      active_connections: activeConnections + proxyConnections,
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const node of this.#nodes.values()) {
      try {
        await node.close();
      } catch {
        // Closing one node must never prevent closing the rest.
      }
    }
    for (const proxy of this.#proxies) {
      try {
        await proxy.close();
      } catch {
        // Same best-effort discipline as node shutdown.
      }
    }
    this.#proxies.length = 0;
    this.#nodes.clear();
  }

  #assertOpen(): void {
    if (this.#closed) throw invalid('HA cluster is closed');
  }

  #declarations(): MwhaLeaderLease[] {
    const all: MwhaLeaderLease[] = [];
    for (const node of this.#nodes.values()) all.push(...node.manager.collectDeclarations());
    return all;
  }

  #aggregateAdjudications(): MultiWriterAdjudicationRecord[] {
    const bySlot = new Map<string, MultiWriterAdjudicationRecord>();
    for (const node of this.#nodes.values()) {
      for (const record of node.log.getAdjudications()) {
        const key = `${record.conflict_key.writer_id}\u0000${String(record.conflict_key.epoch)}\u0000${String(record.conflict_key.local_seq)}`;
        const existing = bySlot.get(key);
        if (existing === undefined || (existing.adjudication.status === 'unresolved' && record.adjudication.status === 'resolved')) {
          bySlot.set(key, record);
        }
      }
    }
    return [...bySlot.values()].sort((left, right) => {
      const leftKey = `${left.conflict_key.writer_id}\u0000${String(left.conflict_key.epoch)}\u0000${String(left.conflict_key.local_seq)}`;
      const rightKey = `${right.conflict_key.writer_id}\u0000${String(right.conflict_key.epoch)}\u0000${String(right.conflict_key.local_seq)}`;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
  }

  async #rebuildLinks(groups: readonly (readonly string[])[] | null): Promise<void> {
    for (const proxy of this.#proxies) await proxy.close();
    this.#proxies.length = 0;

    const blocked = new Set<string>();
    if (groups !== null) {
      const groupOf = new Map<string, number>();
      for (const [index, group] of groups.entries()) {
        for (const memberId of group) groupOf.set(memberId, index);
      }
      for (const source of this.memberIds) {
        for (const target of this.memberIds) {
          if (source === target) continue;
          const sourceGroup = groupOf.get(source);
          const targetGroup = groupOf.get(target);
          if (sourceGroup === undefined || targetGroup === undefined || sourceGroup !== targetGroup) {
            blocked.add(`${source}\u0000${target}`);
          }
        }
      }
    }

    for (const source of this.memberIds) {
      for (const target of this.memberIds) {
        if (source === target) continue;
        const targetNode = this.#nodes.get(target)!;
        const upstream = targetNode.haAddress;
        if (upstream === null) throw invalid(`node ${target} has no HA listener address`);
        const rules: TcpFaultRule[] = blocked.has(`${source}\u0000${target}`)
          ? [{ kind: 'drop', probability: 1, direction: 'both' }]
          : [];
        const proxy = await TcpFaultProxy.start({
          listen: { host: this.host, port: 0 },
          upstream: { host: upstream.host, port: upstream.port },
          seed: `t139-${source}-${target}`,
          rules,
        });
        const address = proxy.address;
        if (address === null) throw invalid(`HA link proxy ${source}->${target} did not report an address`);
        this.#proxies.push(proxy);
        const sourceNode = this.#nodes.get(source)!;
        sourceNode.remoteTargets.set(target, { host: address.host, port: address.port });
        // Force the client to drop any socket aimed at the previous proxy so
        // the next request really traverses the rebuilt link.
        await sourceNode.clients.get(target)?.reset();
      }
    }
    this.#partitions = { groups: groups === null ? null : groups.map((group) => [...group]) };
  }
}

function errorCodeOf(error: unknown): string {
  if (error instanceof HaProtocolError) return error.code;
  if (typeof error === 'object' && error !== null && 'code' in error && typeof (error as { code?: unknown }).code === 'string') {
    return (error as { code: string }).code;
  }
  return 'UNKNOWN';
}

function isCommittedStatus(status: MwhaClusterLogEntry['status']): boolean {
  return status === 'committed' || status === 'adjudicated';
}

/**
 * Explicitly adjudicate every retained fork by the newest logical version
 * (deterministic hash tie-break, preferring the peer's incoming branch). All
 * branches stay retained; a missing branch fails `ADJUDICATION_INCOMPLETE`
 * inside the frozen log API. Used by rejoin catch-up so an old leader converges
 * on the new leader without ever overwriting it.
 */
function adjudicateNewestBranches(
  log: MultiWriterLog,
  preferredHashes: ReadonlySet<string> = new Set(),
): MultiWriterAdjudicationRecord[] {
  const made: MultiWriterAdjudicationRecord[] = [];
  for (const conflict of log.forkReport().conflicts) {
    const records = log.getEntries().filter((record) => (
      isCommittedStatus(record.entry.status)
      && record.entry.identity.writer_id === conflict.conflict_key.writer_id
      && record.entry.identity.epoch === conflict.conflict_key.epoch
      && record.entry.identity.local_seq === conflict.conflict_key.local_seq
    ));
    const byHash = new Map<string, MultiWriterEntryRecord>();
    for (const record of records) {
      if (!byHash.has(record.entry.identity.ledger_event_hash)) {
        byHash.set(record.entry.identity.ledger_event_hash, record);
      }
    }
    if (byHash.size < 2) continue;
    const ordered = [...byHash.entries()].sort(([leftHash, left], [rightHash, right]) => {
      const order = compareLogicalVersion(logicalVersionOfEntry(left.entry), logicalVersionOfEntry(right.entry));
      if (order !== 0) return order;
      const leftPreferred = preferredHashes.has(leftHash) ? 1 : 0;
      const rightPreferred = preferredHashes.has(rightHash) ? 1 : 0;
      if (leftPreferred !== rightPreferred) return leftPreferred - rightPreferred;
      return leftHash < rightHash ? -1 : leftHash > rightHash ? 1 : 0;
    });
    const winner = ordered.at(-1);
    if (winner === undefined) continue;
    const branches = ordered.map(([hash, record]) => ({
      branch_id: makeBranchId(record.entry.identity, hash),
      identity: record.entry.identity,
      ledger_event_hash: hash,
    }));
    const adjudication: MwhaAdjudication = {
      schema_version: MWHA_ADJUDICATION_SCHEMA_VERSION,
      conflict_key: conflict.conflict_key,
      branches,
      branch_hashes: branches.map((branch) => branch.ledger_event_hash),
      status: 'resolved',
      selected_branch_id: makeBranchId(winner[1].entry.identity, winner[0]),
      resolution_reason: 'T-139 rejoin adopts the newest logical version deterministically without dropping any branch',
    };
    mwhaAdjudicationSchema.parse(adjudication);
    assertAdjudicationComplete(adjudication, branches);
    made.push(log.adjudicate(adjudication, { evidenceId: null }));
  }
  return made;
}

// ---------------------------------------------------------------------------
// Contract re-exports used by T-139 consumers
// ---------------------------------------------------------------------------

export {
  HaProtocolError,
  evaluatePartitions,
  isUnverifiedCapability,
  mwhaProjectionStateSchema,
  type MwhaProjectionState,
};
