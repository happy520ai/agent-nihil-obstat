import { z } from 'zod';
import { MWHA_PROTOCOL_SCHEMA_VERSION, mwhaMemberRoles } from './ha-protocol.ts';
import {
  REPLICA_WORKER_MAX_ARRAY_LENGTH,
  REPLICA_WORKER_MAX_MESSAGE_BYTES,
} from './replica-worker.ts';
import {
  anchorProbeRequestSchema,
  type AnchorProbeRequest,
  type AnchorProbeSnapshot,
} from './probe-contract.ts';
import { distributedReplicaStates, type DistributedReplicaState } from './distributed-probe.ts';

/**
 * T-147 / CV-05 extraction: wire frame codec, strict schemas and payload
 * parsers.
 *
 * Pure boundary: no socket, no timer, no shared state. `tcp-transport.ts`
 * keeps the connection lifecycle and re-exports this module's public surface
 * unchanged, so callers and tests are unaffected by the split.
 */

export const TCP_REPLICA_MAX_FRAME_BYTES = REPLICA_WORKER_MAX_MESSAGE_BYTES;
/** M15 pull chunk bound reused for one apply batch. */
export const TCP_REPLICA_MAX_APPLY_EVENTS = REPLICA_WORKER_MAX_ARRAY_LENGTH;
/**
 * Stable, assertion-friendly transport error codes. Naming follows the frozen
 * `ha-protocol.ts` convention: SCREAMING_SNAKE, fail-closed, unknown/missing
 * input is never silently accepted.
 */
export const tcpReplicaErrorCodes = [
  'TCP_CONFIG_INVALID',
  'TCP_TLS_REQUIRED',
  'TCP_LISTEN_FAILED',
  'TCP_CONNECTION_FAILED',
  'TCP_CONNECTION_CLOSED',
  'TCP_AUTH_REQUIRED',
  'TCP_AUTH_UNKNOWN_NODE',
  'TCP_AUTH_CHALLENGE_INVALID',
  'TCP_AUTH_BAD_SIGNATURE',
  'TCP_AUTH_NONCE_REPLAYED',
  'TCP_FRAME_INVALID',
  'TCP_FRAME_TOO_LARGE',
  'TCP_MESSAGE_INVALID',
  'TCP_MESSAGE_UNKNOWN_TYPE',
  'TCP_REQUEST_TIMEOUT',
  'TCP_REQUEST_CANCELLED',
  'TCP_NODE_UNAVAILABLE',
] as const;
export type TcpReplicaErrorCode = (typeof tcpReplicaErrorCodes)[number];

export class TcpTransportError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(`[${code}] ${message}`, options);
    this.name = 'TcpTransportError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Wire schemas (strict; unknown/missing fields fail closed)
// ---------------------------------------------------------------------------

export const NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const NONCE_PATTERN = /^[a-f0-9]{64}$/u;
const FRAME_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

const nodeIdSchema = z.string().regex(NODE_ID_PATTERN, 'expected a bounded node identifier');
const nonceSchema = z.string().regex(NONCE_PATTERN, 'expected 64 lowercase hex chars');

/** Message kinds this transport accepts. Election/commit messages are T-136+. */
export const tcpReplicaKinds = ['query', 'apply', 'status', 'hello', 'auth', 'cancel'] as const;
export type TcpReplicaKind = (typeof tcpReplicaKinds)[number];

const baseEnvelope = {
  schema_version: z.literal(MWHA_PROTOCOL_SCHEMA_VERSION),
  kind: z.enum(tcpReplicaKinds),
  id: z.string().regex(FRAME_ID_PATTERN, 'expected a bounded frame id'),
};

/** Strict request envelope (ADR-012 implementation reference §2.1). */
export const tcpReplicaRequestSchema = z.object({
  ...baseEnvelope,
  payload: z.unknown(),
}).strict();
export type TcpReplicaRequest = z.infer<typeof tcpReplicaRequestSchema>;

export const tcpReplicaSuccessSchema = z.object({
  ...baseEnvelope,
  ok: z.literal(true),
  payload: z.unknown(),
}).strict();
export type TcpReplicaSuccess = z.infer<typeof tcpReplicaSuccessSchema>;

export const tcpReplicaFailureSchema = z.object({
  ...baseEnvelope,
  ok: z.literal(false),
  error: z.object({
    code: z.string().min(1).max(128),
    message: z.string().min(1).max(2_000),
  }).strict(),
}).strict();
export type TcpReplicaFailure = z.infer<typeof tcpReplicaFailureSchema>;

/** Everything that may legally appear on the wire, in either direction. */
export const tcpReplicaInboundSchema = z.union([
  tcpReplicaRequestSchema,
  tcpReplicaSuccessSchema,
  tcpReplicaFailureSchema,
]);
export type TcpReplicaWireMessage = TcpReplicaRequest | TcpReplicaSuccess | TcpReplicaFailure;

export const tcpHelloPayloadSchema = z.object({
  nodeId: nodeIdSchema,
  /** Client-generated fresh nonce; the server rejects reuse/replay. */
  nonce: nonceSchema,
  role: z.enum(mwhaMemberRoles).optional(),
}).strict();
export type TcpHelloPayload = z.infer<typeof tcpHelloPayloadSchema>;

export const tcpAuthPayloadSchema = z.object({
  nodeId: nodeIdSchema,
  nonce: nonceSchema,
  serverNonce: nonceSchema,
  signature: z.string().regex(NONCE_PATTERN, 'expected 64 lowercase hex chars'),
}).strict();
export type TcpAuthPayload = z.infer<typeof tcpAuthPayloadSchema>;

export const tcpStatusPayloadSchema = z.object({}).strict();

/**
 * T-158: an authenticated peer asks the receiving side to abandon the request
 * identified by `targetId`. It can only name a request already issued on the
 * same connection; it carries no authority of its own.
 */
export const tcpCancelPayloadSchema = z.object({
  targetId: z.string().regex(FRAME_ID_PATTERN, 'expected a bounded request id'),
}).strict();
export type TcpCancelPayload = z.infer<typeof tcpCancelPayloadSchema>;

/** Query payload reuses the frozen AnchorProbe request schema. */
export const tcpQueryPayloadSchema = anchorProbeRequestSchema;

/**
 * Transport-level apply guard. Deep envelope validation (ledger hash, chain,
 * redaction) stays with the replica applier, mirroring M15's split between
 * `validateApply` and `committedEnvelopeIssue`.
 */
export const tcpApplyEventGuardSchema = z.object({
  seq: z.number().int().min(1),
  eventId: z.string().min(1).max(128),
  hash: z.string().min(1).max(128),
  kind: z.string().min(1).max(128),
  payload: z.record(z.string(), z.unknown()),
});

export const tcpApplyPayloadSchema = z.object({
  events: z.array(tcpApplyEventGuardSchema).max(TCP_REPLICA_MAX_APPLY_EVENTS),
  projectScope: z.string().min(1).max(128).optional(),
}).strict();
export type TcpApplyPayload = z.infer<typeof tcpApplyPayloadSchema>;

export const tcpStatusResultSchema = z.object({
  replicaId: z.string().min(1).max(128),
  commitIndex: z.number().int().min(0),
  viewDigest: z.string().min(1),
  evidenceDigest: z.string().min(1),
  state: z.enum(distributedReplicaStates),
  snapshot: z.unknown(),
  clusterEpoch: z.union([z.string(), z.number()]).optional(),
  projectScope: z.string().min(1).max(128).optional(),
}).strict();

export interface TcpReplicaStatusView {
  readonly replicaId: string;
  readonly commitIndex: number;
  readonly viewDigest: string;
  readonly evidenceDigest: string;
  readonly state: DistributedReplicaState;
  readonly snapshot: AnchorProbeSnapshot;
  readonly clusterEpoch?: string | number;
  readonly projectScope?: string;
}
export function invalid(messageText: string, cause?: unknown): TcpTransportError {
  return new TcpTransportError('TCP_MESSAGE_INVALID', messageText, cause === undefined ? undefined : { cause });
}

/** Parse one payload with a strict schema; any violation is a whole-frame reject. */
export function parsePayload<T>(label: string, schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    // Zod only returns a failed parse when at least one issue exists.
    const issue = result.error.issues[0]!;
    const detail = `${issue.path.join('.') || label}: ${issue.message}`;
    throw invalid(`${label} does not satisfy its strict schema (${detail})`);
  }
  return result.data;
}

export function parseTcpHelloPayload(value: unknown): TcpHelloPayload {
  return parsePayload('hello payload', tcpHelloPayloadSchema, value);
}

export function parseTcpAuthPayload(value: unknown): TcpAuthPayload {
  return parsePayload('auth payload', tcpAuthPayloadSchema, value);
}

export function parseTcpQueryPayload(value: unknown): AnchorProbeRequest {
  return parsePayload('query payload', tcpQueryPayloadSchema, value);
}

export function parseTcpCancelPayload(value: unknown): TcpCancelPayload {
  return parsePayload('cancel payload', tcpCancelPayloadSchema, value);
}

export function parseTcpApplyPayload(value: unknown): TcpApplyPayload {
  return parsePayload('apply payload', tcpApplyPayloadSchema, value);
}

// ---------------------------------------------------------------------------
// Framing: 4-byte big-endian length prefix + JSON body
// ---------------------------------------------------------------------------

/**
 * Encode one frame. A body above the 1 MiB ceiling is refused locally; it is
 * never truncated or partially written.
 */
export function encodeTcpReplicaFrame(
  frame: TcpReplicaWireMessage,
  maxFrameBytes: number = TCP_REPLICA_MAX_FRAME_BYTES,
): Buffer {
  const body = Buffer.from(JSON.stringify(frame), 'utf8');
  if (body.length > maxFrameBytes) {
    throw new TcpTransportError(
      'TCP_FRAME_TOO_LARGE',
      `frame body is ${String(body.length)} bytes, above the ${String(maxFrameBytes)} byte limit`,
    );
  }
  const out = Buffer.allocUnsafe(4 + body.length);
  out.writeUInt32BE(body.length, 0);
  body.copy(out, 4);
  return out;
}

export interface TcpFrameDecodeOutcome {
  readonly frames: readonly TcpReplicaWireMessage[];
  /** Fatal framing error; the caller must drop the connection. */
  readonly error: TcpTransportError | null;
}

/**
 * Incremental decoder. Every complete frame is strictly parsed; an invalid
 * length (<=0 or > limit), an over-limit body, non-JSON bytes or an envelope
 * violation is fatal for the whole connection — no partial adoption.
 */
export class TcpReplicaFrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);
  private readonly maxFrameBytes: number;

  constructor(maxFrameBytes: number = TCP_REPLICA_MAX_FRAME_BYTES) {
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes <= 0) {
      throw new TcpTransportError('TCP_CONFIG_INVALID', `maxFrameBytes must be a positive integer, got ${String(maxFrameBytes)}`);
    }
    this.maxFrameBytes = maxFrameBytes;
  }

  /** Bytes currently buffered waiting for the rest of a frame. */
  get bufferedBytes(): number {
    return this.buffer.length;
  }

  push(chunk: Buffer): TcpFrameDecodeOutcome {
    this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk]);
    const frames: TcpReplicaWireMessage[] = [];
    for (;;) {
      if (this.buffer.length < 4) return { frames, error: null };
      const length = this.buffer.readUInt32BE(0);
      if (length <= 0) {
        this.buffer = Buffer.alloc(0);
        return { frames, error: new TcpTransportError('TCP_FRAME_INVALID', `frame length ${String(length)} is not positive`) };
      }
      if (length > this.maxFrameBytes) {
        this.buffer = Buffer.alloc(0);
        return {
          frames,
          error: new TcpTransportError(
            'TCP_FRAME_TOO_LARGE',
            `frame length ${String(length)} exceeds the ${String(this.maxFrameBytes)} byte limit`,
          ),
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
        return { frames, error: new TcpTransportError('TCP_FRAME_INVALID', 'frame body is not valid JSON', { cause: error }) };
      }
      const parsed = tcpReplicaInboundSchema.safeParse(raw);
      if (!parsed.success) {
        this.buffer = Buffer.alloc(0);
        // Zod only returns a failed parse when at least one issue exists.
        const issue = parsed.error.issues[0]!;
        return {
          frames,
          error: new TcpTransportError(
            'TCP_FRAME_INVALID',
            `frame violates ${MWHA_PROTOCOL_SCHEMA_VERSION} envelope (${issue.path.join('.') || 'frame'}: ${issue.message})`,
          ),
        };
      }
      frames.push(parsed.data);
    }
  }
}
