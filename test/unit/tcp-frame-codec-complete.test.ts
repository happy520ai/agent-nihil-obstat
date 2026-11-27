/**
 * T-151 / QF-02 boundary matrix for `src/memory/tcp-frame-codec.ts`.
 *
 * Focus: transport-independent branches that the socket-level suite cannot
 * reach deterministically: `invalid()` cause propagation, strict-schema
 * boundaries (frame/apply limits, optional fields, union arms), incremental
 * decoder buffering/resync, and atomic rejection diagnostics.
 *
 * T-153 follow-up (headers only; assertions unchanged): the two former
 * `issue === undefined` fallbacks (`parsePayload`, decoder envelope) were
 * removed by the main-control cleanup because a failed Zod parse always carries
 * at least one issue, so `issues[0]!` is now unconditional. This module is
 * expected at 100/100/100 after that cleanup; no mock was ever used to force
 * either old branch.
 *
 * Coverage map (scoped: tcp-frame-codec.test.ts + this file):
 * - real callers always carry an issue (path/message asserted, never the old
 *   "schema violation" fallback text):
 *   "parsePayload returns data on success and names the failing path on failure",
 *   "envelope rejection messages carry the Zod path instead of the fallback text".
 * - Reachable branches covered by the new cases:
 *   invalid() cause/no-cause and error surface:
 *     "transport error surface exposes stable codes and formats the message"
 *   schema optional/bounds/vocabulary:
 *     "hello/auth/status schemas accept only their frozen shapes",
 *     "query payload schema enforces the frozen anchor-probe request contract",
 *     "apply payload enforces the event array bound and optional project scope",
 *     "status result schema accepts both epoch kinds and rejects out-of-vocabulary state",
 *     "inbound union distinguishes request, success and failure envelopes strictly"
 *   framing/decoder buffering, resync, cause, atomicity:
 *     "encode refuses over-limit bodies and otherwise round-trips every wire arm",
 *     "decoder buffers a header-only and partial-body chunk without error, then completes",
 *     "decoder resynchronises after a fatal framing error and keeps the cause",
 *     "decoder emits multiple frames and reports the last fatal error atomically"
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { MWHA_PROTOCOL_SCHEMA_VERSION } from '../../src/memory/ha-protocol.ts';
import {
  NODE_ID_PATTERN,
  TCP_REPLICA_MAX_APPLY_EVENTS,
  TCP_REPLICA_MAX_FRAME_BYTES,
  TcpReplicaFrameDecoder,
  TcpTransportError,
  encodeTcpReplicaFrame,
  invalid,
  parsePayload,
  parseTcpApplyPayload,
  parseTcpAuthPayload,
  parseTcpHelloPayload,
  parseTcpQueryPayload,
  tcpApplyEventGuardSchema,
  tcpApplyPayloadSchema,
  tcpAuthPayloadSchema,
  tcpHelloPayloadSchema,
  tcpReplicaErrorCodes,
  tcpReplicaFailureSchema,
  tcpReplicaInboundSchema,
  tcpReplicaKinds,
  tcpReplicaRequestSchema,
  tcpStatusResultSchema,
  tcpReplicaSuccessSchema,
  tcpStatusPayloadSchema,
  type TcpReplicaFailure,
  type TcpReplicaRequest,
  type TcpReplicaSuccess,
} from '../../src/memory/tcp-frame-codec.ts';

const HASH = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function requestFrame(id: string, payload: unknown, kind: 'query' | 'apply' | 'status' | 'hello' | 'auth' = 'status'): TcpReplicaRequest {
  return { schema_version: MWHA_PROTOCOL_SCHEMA_VERSION, kind, id, payload };
}

function successFrame(id: string, payload: unknown): TcpReplicaSuccess {
  return { schema_version: MWHA_PROTOCOL_SCHEMA_VERSION, kind: 'status', id, ok: true, payload };
}

function failureFrame(id: string, code: string, message: string): TcpReplicaFailure {
  return {
    schema_version: MWHA_PROTOCOL_SCHEMA_VERSION,
    kind: 'status',
    id,
    ok: false,
    error: { code, message },
  };
}

// ---------------------------------------------------------------------------
// Error surface and constants
// ---------------------------------------------------------------------------

test('transport error surface exposes stable codes and formats the message', () => {
  assert.ok(TCP_REPLICA_MAX_FRAME_BYTES > 0);
  assert.equal(TCP_REPLICA_MAX_FRAME_BYTES, 1_048_576);
  assert.equal(TCP_REPLICA_MAX_APPLY_EVENTS, 1_024);
  assert.equal(NODE_ID_PATTERN.source, '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$');
  // T-158 adds the authenticated cancel kind; the other five are the frozen
  // M16 vocabulary.
  assert.deepEqual([...tcpReplicaKinds], ['query', 'apply', 'status', 'hello', 'auth', 'cancel']);

  const requiredCodes = [
    'TCP_CONFIG_INVALID', 'TCP_TLS_REQUIRED', 'TCP_LISTEN_FAILED', 'TCP_CONNECTION_FAILED',
    'TCP_CONNECTION_CLOSED', 'TCP_AUTH_REQUIRED', 'TCP_AUTH_UNKNOWN_NODE', 'TCP_AUTH_CHALLENGE_INVALID',
    'TCP_AUTH_BAD_SIGNATURE', 'TCP_AUTH_NONCE_REPLAYED', 'TCP_FRAME_INVALID', 'TCP_FRAME_TOO_LARGE',
    'TCP_MESSAGE_INVALID', 'TCP_MESSAGE_UNKNOWN_TYPE', 'TCP_REQUEST_TIMEOUT', 'TCP_REQUEST_CANCELLED',
    'TCP_NODE_UNAVAILABLE',
  ];
  for (const code of requiredCodes) {
    assert.ok(tcpReplicaErrorCodes.includes(code as never), code);
  }

  const bare = new TcpTransportError('TCP_X', 'boom');
  assert.equal(bare.name, 'TcpTransportError');
  assert.equal(bare.code, 'TCP_X');
  assert.equal(bare.message, '[TCP_X] boom');

  // invalid() with no cause passes no options through; with a cause it is kept.
  const noCause = invalid('bad payload');
  assert.equal(noCause.code, 'TCP_MESSAGE_INVALID');
  assert.equal(noCause.message, '[TCP_MESSAGE_INVALID] bad payload');
  assert.equal('cause' in noCause, false);

  const root = new Error('root cause');
  const withCause = invalid('bad payload', root);
  assert.equal(withCause.cause, root);
  const nonErrorCause = invalid('bad payload', 'text cause');
  assert.equal(nonErrorCause.cause, 'text cause');
});

// ---------------------------------------------------------------------------
// parsePayload
// ---------------------------------------------------------------------------

test('parsePayload returns data on success and names the failing path on failure', () => {
  const schema = tcpApplyEventGuardSchema;
  const value = { seq: 1, eventId: 'e1', hash: HASH, kind: 'memory.revised', payload: { a: 1 } };
  assert.deepEqual(parsePayload('apply event', schema, value), value);

  assert.throws(
    () => parsePayload('apply event', schema, { ...value, seq: 0 }),
    (error: unknown) => {
      assert.ok(error instanceof TcpTransportError);
      assert.equal(error.code, 'TCP_MESSAGE_INVALID');
      assert.match(error.message, /apply event does not satisfy its strict schema \(seq:/u);
      return true;
    },
  );

  assert.throws(
    () => parsePayload('apply event', schema, null),
    (error: unknown) => {
      assert.ok(error instanceof TcpTransportError);
      // Real Zod failures always carry an issue; the "schema violation"
      // fallback text must not be what callers observe.
      assert.doesNotMatch(error.message, /\(schema violation\)/u);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Payload schemas: optional fields, bounds and vocabulary
// ---------------------------------------------------------------------------

test('hello/auth/status schemas accept only their frozen shapes', () => {
  const hello = parseTcpHelloPayload({ nodeId: 'node-a', nonce: HASH });
  assert.deepEqual(hello, { nodeId: 'node-a', nonce: HASH });

  const withRole = parseTcpHelloPayload({ nodeId: 'node-a', nonce: HASH, role: 'observer' });
  assert.equal(withRole.role, 'observer');
  for (const role of ['admin', '', 1]) {
    assert.throws(() => parseTcpHelloPayload({ nodeId: 'node-a', nonce: HASH, role }), TcpTransportError);
  }
  assert.throws(() => parseTcpHelloPayload({ nodeId: 'node-a', nonce: HASH.toUpperCase() }), TcpTransportError);
  assert.throws(() => parseTcpHelloPayload({ nodeId: 'bad id', nonce: HASH }), TcpTransportError);

  const auth = parseTcpAuthPayload({ nodeId: 'node-a', nonce: HASH, serverNonce: HASH_B, signature: HASH });
  assert.equal(auth.signature, HASH);
  assert.throws(() => parseTcpAuthPayload({ nodeId: 'node-a', nonce: HASH, serverNonce: HASH_B }), TcpTransportError);

  assert.deepEqual(tcpStatusPayloadSchema.parse({}), {});
  assert.throws(() => tcpStatusPayloadSchema.parse({ extra: true }));
  assert.equal(tcpStatusPayloadSchema.safeParse([]).success, false);
});

test('query payload schema enforces the frozen anchor-probe request contract', () => {
  const base = { schema_version: 'anchorprobe.request.v1', request_id: 'req-1', root: 'F:/project', project_scope: 'proj' };
  const parsed = parseTcpQueryPayload(base);
  assert.equal(parsed.request_id, 'req-1');
  assert.equal(parsed.temporal_mode, 'CURRENT');

  // AS_OF/HISTORICAL require an explicit as_of timestamp.
  for (const temporal_mode of ['AS_OF', 'HISTORICAL']) {
    assert.throws(() => parseTcpQueryPayload({ ...base, temporal_mode }), TcpTransportError);
    const withAsOf = parseTcpQueryPayload({ ...base, temporal_mode, as_of: '2026-11-25T00:00:00.000Z' });
    assert.equal(withAsOf.temporal_mode, temporal_mode);
  }
  assert.throws(() => parseTcpQueryPayload({ ...base, as_of: 'not-a-date' }), TcpTransportError);
  assert.throws(() => parseTcpQueryPayload({ ...base, required_facts: ['NOT_A_FACT'] }), TcpTransportError);
  assert.throws(() => parseTcpQueryPayload({ ...base, budget: { ...{}, max_candidates: 0 } }), TcpTransportError);
  assert.throws(() => parseTcpQueryPayload({ ...base, unexpected: 1 }), TcpTransportError);
});

test('apply payload enforces the event array bound and optional project scope', () => {
  const event = (seq: number) => ({ seq, eventId: `e${String(seq)}`, hash: HASH, kind: 'memory.revised', payload: {} });
  const atLimit = parseTcpApplyPayload({ events: Array.from({ length: TCP_REPLICA_MAX_APPLY_EVENTS }, (_, index) => event(index + 1)) });
  assert.equal(atLimit.events.length, TCP_REPLICA_MAX_APPLY_EVENTS);
  assert.equal(atLimit.projectScope, undefined);

  assert.throws(
    () => parseTcpApplyPayload({
      events: Array.from({ length: TCP_REPLICA_MAX_APPLY_EVENTS + 1 }, (_, index) => event(index + 1)),
    }),
    TcpTransportError,
  );

  const scoped = parseTcpApplyPayload({ events: [event(1)], projectScope: 'proj' });
  assert.equal(scoped.projectScope, 'proj');
  for (const projectScope of ['', 'x'.repeat(129)]) {
    assert.throws(() => parseTcpApplyPayload({ events: [], projectScope }), TcpTransportError);
  }

  // Guard schema boundaries.
  const validEvent = event(1);
  for (const bad of [{ ...validEvent, seq: 1.5 }, { ...validEvent, seq: 0 }, { ...validEvent, eventId: '' }, { ...validEvent, payload: [] }]) {
    assert.equal(tcpApplyEventGuardSchema.safeParse(bad).success, false);
  }
  assert.equal(tcpApplyEventGuardSchema.safeParse(validEvent).success, true);
  assert.equal(tcpApplyPayloadSchema.safeParse({ events: 'nope' }).success, false);
});

test('status result schema accepts both epoch kinds and rejects out-of-vocabulary state', () => {
  const base = {
    replicaId: 'replica-1',
    commitIndex: 0,
    viewDigest: HASH,
    evidenceDigest: HASH,
    state: 'ACTIVE',
    snapshot: {},
  };
  assert.deepEqual(tcpStatusResultSchema.parse(base), base);
  for (const clusterEpoch of ['epoch-1', 7]) {
    assert.equal(tcpStatusResultSchema.parse({ ...base, clusterEpoch }).clusterEpoch, clusterEpoch);
  }
  assert.equal(tcpStatusResultSchema.parse({ ...base, projectScope: 'proj' }).projectScope, 'proj');
  assert.throws(() => tcpStatusResultSchema.parse({ ...base, projectScope: '' }));
  assert.throws(() => tcpStatusResultSchema.parse({ ...base, state: 'GHOST' }));
  assert.throws(() => tcpStatusResultSchema.parse({ ...base, commitIndex: -1 }));
  assert.throws(() => tcpStatusResultSchema.parse({ ...base, extra: true }));
  // z.unknown() accepts undefined by design; an invalid replicaId is rejected.
  assert.throws(() => tcpStatusResultSchema.parse({ ...base, replicaId: '' }));
});

test('inbound union distinguishes request, success and failure envelopes strictly', () => {
  const request = requestFrame('id-1', {});
  const success = successFrame('id-2', {});
  const failure = failureFrame('id-3', 'TCP_NODE_UNAVAILABLE', 'gone');

  assert.deepEqual(tcpReplicaRequestSchema.parse(request), request);
  assert.deepEqual(tcpReplicaSuccessSchema.parse(success), success);
  assert.deepEqual(tcpReplicaFailureSchema.parse(failure), failure);
  assert.deepEqual(tcpReplicaInboundSchema.parse(request), request);
  assert.deepEqual(tcpReplicaInboundSchema.parse(success), success);
  assert.deepEqual(tcpReplicaInboundSchema.parse(failure), failure);

  // Request/success/failure are distinguished by the `ok` literal: adding
  // ok:true turns a request into a success envelope; ok:false without an error
  // object matches no arm.
  assert.equal(tcpReplicaInboundSchema.safeParse({ ...request, ok: true }).success, true);
  assert.equal(tcpReplicaInboundSchema.safeParse({ ...success, ok: false }).success, false);
  assert.equal(tcpReplicaInboundSchema.safeParse({ ...request, kind: 'vote' }).success, false);
  assert.equal(tcpReplicaInboundSchema.safeParse({ ...request, id: 'bad id' }).success, false);
  assert.equal(tcpReplicaInboundSchema.safeParse({ ...request, schema_version: 'other.v1' }).success, false);
  assert.equal(tcpReplicaInboundSchema.safeParse({ ...request, extra: 1 }).success, false);
  assert.equal(tcpReplicaInboundSchema.safeParse(null).success, false);
  assert.equal(tcpReplicaInboundSchema.safeParse({ ...failure, error: { code: '', message: 'x' } }).success, false);
  assert.equal(tcpReplicaInboundSchema.safeParse({ ...failure, error: { code: 'x'.repeat(129), message: 'x' } }).success, false);
  assert.equal(tcpReplicaInboundSchema.safeParse({ ...failure, error: { code: 'X', message: '' } }).success, false);
  assert.equal(tcpReplicaInboundSchema.safeParse({ ...failure, error: { code: 'X', message: 'x'.repeat(2_001) } }).success, false);
  assert.equal(tcpReplicaInboundSchema.safeParse({ ...failure, error: { code: 'X', message: 'x', extra: 1 } }).success, false);
});

// ---------------------------------------------------------------------------
// Framing encoder/decoder
// ---------------------------------------------------------------------------

test('encode refuses over-limit bodies and otherwise round-trips every wire arm', () => {
  assert.throws(
    () => encodeTcpReplicaFrame(successFrame('id-big', { blob: 'x'.repeat(4_096) }), 64),
    (error: unknown) => {
      assert.ok(error instanceof TcpTransportError);
      assert.equal(error.code, 'TCP_FRAME_TOO_LARGE');
      return true;
    },
  );

  // Default ceiling is used when the second argument is omitted.
  const small = encodeTcpReplicaFrame(requestFrame('id-1', { a: 1 }));
  assert.equal(small.readUInt32BE(0), small.length - 4);

  const decoder = new TcpReplicaFrameDecoder();
  const outcome = decoder.push(Buffer.concat([
    encodeTcpReplicaFrame(requestFrame('id-1', {}, 'query')),
    encodeTcpReplicaFrame(successFrame('id-2', {})),
    encodeTcpReplicaFrame(failureFrame('id-3', 'E', 'm')),
  ]));
  assert.equal(outcome.error, null);
  assert.deepEqual(outcome.frames.map((frame) => frame.id), ['id-1', 'id-2', 'id-3']);
  assert.equal(decoder.bufferedBytes, 0);
});

test('decoder buffers a header-only and partial-body chunk without error, then completes', () => {
  const decoder = new TcpReplicaFrameDecoder(1_024);
  const encoded = encodeTcpReplicaFrame(successFrame('id-1', { a: 1 }), 1_024);

  const headerOnly = decoder.push(encoded.subarray(0, 4));
  assert.equal(headerOnly.frames.length, 0);
  assert.equal(headerOnly.error, null);
  assert.equal(decoder.bufferedBytes, 4);

  const partialBody = decoder.push(encoded.subarray(4, 6));
  assert.equal(partialBody.frames.length, 0);
  assert.equal(partialBody.error, null);
  assert.equal(decoder.bufferedBytes, 6, 'partial body stays buffered');

  const rest = decoder.push(encoded.subarray(6));
  assert.equal(rest.error, null);
  assert.equal(rest.frames.length, 1);
  assert.equal(rest.frames[0]!.id, 'id-1');
  assert.equal(decoder.bufferedBytes, 0);
});

test('decoder resynchronises after a fatal framing error and keeps the cause', () => {
  const decoder = new TcpReplicaFrameDecoder(1_024);

  const zeroLength = decoder.push(Buffer.from([0, 0, 0, 0]));
  assert.equal(zeroLength.error?.code, 'TCP_FRAME_INVALID');
  assert.equal(decoder.bufferedBytes, 0, 'fatal errors clear the buffer');

  // A valid frame pushed afterwards must decode normally (no stale prefix).
  const recovered = decoder.push(encodeTcpReplicaFrame(successFrame('id-recovered', {}), 1_024));
  assert.equal(recovered.error, null);
  assert.deepEqual(recovered.frames.map((frame) => frame.id), ['id-recovered']);

  const broken = new TcpReplicaFrameDecoder(64);
  const body = Buffer.from('{not json', 'utf8');
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(body.length, 0);
  const badJson = broken.push(Buffer.concat([header, body]));
  assert.equal(badJson.error?.code, 'TCP_FRAME_INVALID');
  assert.ok(badJson.error?.cause instanceof SyntaxError, 'JSON parse cause is preserved');
});

test('decoder emits multiple frames and reports the last fatal error atomically', () => {
  const decoder = new TcpReplicaFrameDecoder(1_024);
  const a = encodeTcpReplicaFrame(successFrame('id-a', {}), 1_024);
  const b = encodeTcpReplicaFrame(failureFrame('id-b', 'E', 'm'), 1_024);
  const outcome = decoder.push(Buffer.concat([a, b, a.subarray(0, 2)]));
  assert.equal(outcome.frames.length, 2);
  assert.equal(outcome.error, null);
  assert.equal(decoder.bufferedBytes, 2);

  // An over-limit length header is rejected before any body byte is consumed;
  // previously decoded frames stay returned and the buffer is dropped. The
  // ceiling equals the first frame's declared body length, so that frame is
  // still legal and the following larger header is not.
  const first = encodeTcpReplicaFrame(successFrame('id-ok', {}));
  const limited = new TcpReplicaFrameDecoder(first.length - 4);
  const oversizedHeader = Buffer.allocUnsafe(4);
  oversizedHeader.writeUInt32BE(first.length - 4 + 1, 0);
  const mixed = limited.push(Buffer.concat([first, oversizedHeader]));
  assert.equal(mixed.frames.length, 1);
  assert.equal(mixed.error?.code, 'TCP_FRAME_TOO_LARGE');
  assert.equal(limited.bufferedBytes, 0);
});

test('envelope rejection messages carry the Zod path instead of the fallback text', () => {
  const decoder = new TcpReplicaFrameDecoder(1_024);
  const badEnvelope = decoder.push(encodeTcpReplicaFrame({ ...requestFrame('id-1', {}), kind: 'vote' } as never, 1_024));
  assert.equal(badEnvelope.error?.code, 'TCP_FRAME_INVALID');
  assert.doesNotMatch(badEnvelope.error?.message ?? '', /\(schema violation\)/u);
  assert.match(badEnvelope.error?.message ?? '', /envelope/u);
});
