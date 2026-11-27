/**
 * T-134 / M17 CV-03 pure-function frame-codec tests for `src/memory/tcp-transport.ts`.
 *
 * These exercise the deterministic seam only: payload schema parsers, frame
 * encoder/decoder bounds and the frozen HA payload validators. No socket is
 * opened, so every branch here is reproducible without timing or networking.
 *
 * Scope note: local loopback TCP/TLS remains covered by the integration and
 * red-team suites; this file targets the codec/config branches that a socket
 * cannot reach deterministically.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { MWHA_ADJUDICATION_SCHEMA_VERSION, MWHA_CLUSTER_LOG_ENTRY_SCHEMA_VERSION, MWHA_PROTOCOL_SCHEMA_VERSION } from '../../src/memory/ha-protocol.ts';
import {
  assertMwhaAdjudication,
  assertMwhaClockObservation,
  assertMwhaClusterLogEntry,
  assertMwhaFaultInjection,
  assertMwhaLeaderLease,
  assertMwhaTopology,
  assertMwhaWriterEvent,
  encodeTcpReplicaFrame,
  parseTcpApplyPayload,
  parseTcpAuthPayload,
  parseTcpHelloPayload,
  parseTcpQueryPayload,
  TcpReplicaFrameDecoder,
  TcpReplicaServer,
  TcpTransportError,
  type TcpReplicaServerOptions,
} from '../../src/memory/tcp-transport.ts';

const HASH = 'a'.repeat(64);

function codeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

async function expectCode(run: () => unknown, code: string): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    assert.equal(codeOf(error), code, `expected ${code}, got ${String(error)}`);
    return error;
  }
  assert.fail(`expected ${code} to be thrown`);
}

function frame(kind: 'query' | 'apply' | 'status', id: string, payload: unknown): Parameters<typeof encodeTcpReplicaFrame>[0] {
  return { schema_version: MWHA_PROTOCOL_SCHEMA_VERSION, kind, id, payload } as Parameters<typeof encodeTcpReplicaFrame>[0];
}

// ---------------------------------------------------------------------------
// Numeric configuration guards (positiveInt / nonNegativeInt / decoder ctor)
// ---------------------------------------------------------------------------

function serverOptions(overrides: Record<string, unknown> = {}): TcpReplicaServerOptions {
  return { host: '127.0.0.1', port: 0, sharedSecret: 'secret', ...overrides };
}

test('server numeric options reject zero, negative and non-integer values', async () => {
  for (const field of ['maxFrameBytes', 'connectTimeoutMs', 'handshakeTimeoutMs', 'requestTimeoutMs'] as const) {
    for (const value of [0, -1, 1.5, Number.NaN]) {
      const error = await expectCode(
        () => new TcpReplicaServer(serverOptions({ [field]: value })),
        'TCP_CONFIG_INVALID',
      );
      assert.ok(error instanceof TcpTransportError);
    }
  }
});

test('idleTimeoutMs accepts zero but rejects negative/non-integer values', async () => {
  // Zero disables the idle timeout legitimately.
  const disabled = new TcpReplicaServer(serverOptions({ idleTimeoutMs: 0 }));
  assert.equal(disabled.isClosed, false);
  for (const value of [-1, 0.5, Number.NaN]) {
    const error = await expectCode(
      () => new TcpReplicaServer(serverOptions({ idleTimeoutMs: value })),
      'TCP_CONFIG_INVALID',
    );
    assert.ok(error instanceof TcpTransportError);
  }
});

test('frame decoder constructor rejects invalid byte ceilings', async () => {
  for (const value of [0, -1, 1.5, Number.NaN]) {
    await expectCode(() => new TcpReplicaFrameDecoder(value), 'TCP_CONFIG_INVALID');
  }
  const decoder = new TcpReplicaFrameDecoder(64);
  assert.equal(decoder.bufferedBytes, 0);
});

// ---------------------------------------------------------------------------
// Payload schema parsers (parsePayload / invalid)
// ---------------------------------------------------------------------------

test('hello/auth/query/apply payload parsers reject malformed values whole', async () => {
  await expectCode(() => parseTcpHelloPayload(undefined), 'TCP_MESSAGE_INVALID');
  await expectCode(() => parseTcpHelloPayload({ nodeId: 'n', nonce: 'XYZ' }), 'TCP_MESSAGE_INVALID');
  await expectCode(() => parseTcpHelloPayload({ nodeId: 'n', nonce: 'a'.repeat(64), extra: 1 }), 'TCP_MESSAGE_INVALID');
  await expectCode(() => parseTcpAuthPayload({}), 'TCP_MESSAGE_INVALID');
  await expectCode(() => parseTcpAuthPayload({ nodeId: 'n', nonce: 'a'.repeat(64), serverNonce: 'b'.repeat(64), signature: 'short' }), 'TCP_MESSAGE_INVALID');
  await expectCode(() => parseTcpQueryPayload({}), 'TCP_MESSAGE_INVALID');
  await expectCode(() => parseTcpQueryPayload({ schema_version: 'anchorprobe.request.v1', request_id: 'r', root: '', project_scope: 'p' }), 'TCP_MESSAGE_INVALID');
  await expectCode(() => parseTcpApplyPayload({ events: 'nope' }), 'TCP_MESSAGE_INVALID');
  await expectCode(() => parseTcpApplyPayload({ events: [{ seq: 0, eventId: 'e', hash: HASH, kind: 'k', payload: {} }] }), 'TCP_MESSAGE_INVALID');
  await expectCode(() => parseTcpApplyPayload({ events: [], unexpected: true }), 'TCP_MESSAGE_INVALID');
});

test('payload parsers accept well-formed values unchanged', () => {
  const hello = parseTcpHelloPayload({ nodeId: 'node-a', nonce: 'a'.repeat(64) });
  assert.equal(hello.nodeId, 'node-a');
  const auth = parseTcpAuthPayload({ nodeId: 'node-a', nonce: 'a'.repeat(64), serverNonce: 'b'.repeat(64), signature: 'c'.repeat(64) });
  assert.equal(auth.serverNonce, 'b'.repeat(64));
  const query = parseTcpQueryPayload({ schema_version: 'anchorprobe.request.v1', request_id: 'req-1', root: 'F:/p', project_scope: 'proj' });
  assert.equal(query.request_id, 'req-1');
  const apply = parseTcpApplyPayload({ events: [{ seq: 1, eventId: 'e1', hash: HASH, kind: 'memory.revised', payload: {} }] });
  assert.equal(apply.events.length, 1);
});

// ---------------------------------------------------------------------------
// Frame encoder bounds
// ---------------------------------------------------------------------------

test('encodeTcpReplicaFrame refuses bodies above the ceiling without truncating', async () => {
  const ok = encodeTcpReplicaFrame(frame('status', 'id-1', { small: true }), 1_024);
  assert.equal(ok.readUInt32BE(0), ok.length - 4);
  const error = await expectCode(() => encodeTcpReplicaFrame(frame('status', 'id-1', { big: 'x'.repeat(4_096) }), 64), 'TCP_FRAME_TOO_LARGE');
  assert.ok(error instanceof TcpTransportError);
});

// ---------------------------------------------------------------------------
// Incremental decoder diagnostics and fatal framing errors
// ---------------------------------------------------------------------------

test('decoder exposes bufferedBytes while a frame is incomplete', () => {
  const decoder = new TcpReplicaFrameDecoder(1_024);
  const encoded = encodeTcpReplicaFrame(frame('status', 'id-1', {}), 1_024);
  const head = encoded.subarray(0, 3);
  const first = decoder.push(head);
  assert.equal(first.frames.length, 0);
  assert.equal(first.error, null);
  assert.equal(decoder.bufferedBytes, 3);
  const second = decoder.push(encoded.subarray(3));
  assert.equal(second.frames.length, 1);
  assert.equal(decoder.bufferedBytes, 0);
});

test('decoder refuses zero/negative lengths, over-limit lengths, non-JSON and bad envelopes', () => {
  const smallMax = 16;

  const zero = new TcpReplicaFrameDecoder(smallMax);
  const zeroOutcome = zero.push(Buffer.from([0x00, 0x00, 0x00, 0x00]));
  assert.equal(zeroOutcome.error?.code, 'TCP_FRAME_INVALID');

  const tooLarge = new TcpReplicaFrameDecoder(smallMax);
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(smallMax + 1, 0);
  const largeOutcome = tooLarge.push(header);
  assert.equal(largeOutcome.error?.code, 'TCP_FRAME_TOO_LARGE');

  const nonJson = new TcpReplicaFrameDecoder(64);
  const body = Buffer.from('not-json', 'utf8');
  const nonJsonHeader = Buffer.allocUnsafe(4);
  nonJsonHeader.writeUInt32BE(body.length, 0);
  const nonJsonOutcome = nonJson.push(Buffer.concat([nonJsonHeader, body]));
  assert.equal(nonJsonOutcome.error?.code, 'TCP_FRAME_INVALID');

  const badEnvelope = new TcpReplicaFrameDecoder(1_024);
  const envelopeOutcome = badEnvelope.push(encodeTcpReplicaFrame({ ...frame('status', 'id-1', {}), unexpected: true } as never, 1_024));
  assert.equal(envelopeOutcome.error?.code, 'TCP_FRAME_INVALID');
});

test('decoder emits multiple complete frames from one chunk and ignores trailing partial bytes', () => {
  const decoder = new TcpReplicaFrameDecoder(1_024);
  const a = encodeTcpReplicaFrame(frame('status', 'id-1', {}), 1_024);
  const b = encodeTcpReplicaFrame(frame('status', 'id-2', {}), 1_024);
  const outcome = decoder.push(Buffer.concat([a, b, a.subarray(0, 2)]));
  assert.equal(outcome.frames.length, 2);
  assert.equal(outcome.error, null);
  assert.equal(decoder.bufferedBytes, 2);
});

// ---------------------------------------------------------------------------
// Frozen HA payload validators (all six failure branches)
// ---------------------------------------------------------------------------

test('every frozen HA validator rejects a malformed payload with HA_INPUT_INVALID', async () => {
  const cases: ReadonlyArray<[string, (value: unknown) => unknown]> = [
    ['writer-event', assertMwhaWriterEvent],
    ['cluster-log-entry', assertMwhaClusterLogEntry],
    ['leader-lease', assertMwhaLeaderLease],
    ['topology', assertMwhaTopology],
    ['adjudication', assertMwhaAdjudication],
    ['clock-observation', assertMwhaClockObservation],
    ['fault-injection', assertMwhaFaultInjection],
  ];
  for (const [label, validate] of cases) {
    const error = await expectCode(() => validate({}), 'HA_INPUT_INVALID');
    assert.ok(error instanceof Error, label);
    assert.ok(!String(error).includes('secret'), label);
  }
});

test('frozen HA validators still accept their valid payloads', () => {
  const identity = { writer_id: 'w1', epoch: 0, term: 1, local_seq: 1, ledger_event_hash: HASH };
  const writerEvent = {
    schema_version: 'mwha.event.v1',
    identity,
    leader: null,
  };
  assert.deepEqual(assertMwhaWriterEvent(writerEvent), writerEvent);

  assert.deepEqual(
    assertMwhaLeaderLease({ term: 1, leader_id: 'node-a', epoch: 0 }),
    { term: 1, leader_id: 'node-a', epoch: 0 },
  );

  assert.deepEqual(
    assertMwhaTopology({
      schema_version: MWHA_PROTOCOL_SCHEMA_VERSION,
      cluster_id: 'cluster-1',
      members: [{ member_id: 'm1', role: 'voting-member' }],
      quorum_size: 1,
    }),
    {
      schema_version: MWHA_PROTOCOL_SCHEMA_VERSION,
      cluster_id: 'cluster-1',
      members: [{ member_id: 'm1', role: 'voting-member' }],
      quorum_size: 1,
    },
  );

  assert.deepEqual(
    assertMwhaClusterLogEntry({
      schema_version: MWHA_CLUSTER_LOG_ENTRY_SCHEMA_VERSION,
      identity,
      status: 'proposed',
      leader: null,
      commit_index: 0,
      conflict_key: null,
    }),
    {
      schema_version: MWHA_CLUSTER_LOG_ENTRY_SCHEMA_VERSION,
      identity,
      status: 'proposed',
      leader: null,
      commit_index: 0,
      conflict_key: null,
    },
  );

  const conflictKey = { writer_id: 'w1', epoch: 0, local_seq: 1 };
  const branches = [
    { branch_id: 'b1', identity, ledger_event_hash: HASH },
    { branch_id: 'b2', identity, ledger_event_hash: 'b'.repeat(64) },
  ];
  assert.deepEqual(
    assertMwhaAdjudication({
      schema_version: MWHA_ADJUDICATION_SCHEMA_VERSION,
      conflict_key: conflictKey,
      branches,
      branch_hashes: [HASH, 'b'.repeat(64)],
      status: 'unresolved',
      selected_branch_id: null,
      resolution_reason: null,
    }),
    {
      schema_version: MWHA_ADJUDICATION_SCHEMA_VERSION,
      conflict_key: conflictKey,
      branches,
      branch_hashes: [HASH, 'b'.repeat(64)],
      status: 'unresolved',
      selected_branch_id: null,
      resolution_reason: null,
    },
  );

  assert.deepEqual(
    assertMwhaClockObservation({ member_id: 'm1', epoch: 0, observed_ms: 1, previous_observed_ms: null, reference_ms: null }),
    { member_id: 'm1', epoch: 0, observed_ms: 1, previous_observed_ms: null, reference_ms: null },
  );

  assert.deepEqual(
    assertMwhaFaultInjection({
      schema_version: MWHA_PROTOCOL_SCHEMA_VERSION,
      kind: 'delay',
      target_member_id: 'm1',
      probability: 0.5,
      duration_ms: 10,
    }),
    {
      schema_version: MWHA_PROTOCOL_SCHEMA_VERSION,
      kind: 'delay',
      target_member_id: 'm1',
      probability: 0.5,
      duration_ms: 10,
    },
  );
});
