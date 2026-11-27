import assert from 'node:assert/strict';
import test from 'node:test';
import { TcpClientPendingTable } from '../../src/memory/tcp-connection.ts';
import { TcpTransportError } from '../../src/memory/tcp-frame-codec.ts';

function timeoutError(): TcpTransportError {
  return new TcpTransportError('TCP_REQUEST_TIMEOUT', 'test budget exceeded');
}

test('settle clears the timer and listener and is idempotent', () => {
  const table = new TcpClientPendingTable();
  const controller = new AbortController();
  let cancels = 0;
  let rejections = 0;
  table.register({
    id: 'req-1',
    kind: 'query',
    resolve: () => {
      throw new Error('a settled request must not resolve');
    },
    reject: () => {
      rejections += 1;
    },
    signal: controller.signal,
    timeoutMs: 5_000,
    timeoutError: timeoutError(),
    onCancel: () => {
      cancels += 1;
    },
  });
  assert.equal(table.size, 1);
  assert.equal(table.timerCount, 1);
  table.settle('req-1');
  assert.equal(table.size, 0);
  assert.equal(table.timerCount, 0);
  table.settle('req-1');
  assert.equal(rejections, 0);
  assert.equal(cancels, 0);
});

test('an abort notifies the transport exactly once and releases the timer', () => {
  const table = new TcpClientPendingTable();
  const controller = new AbortController();
  let cancels = 0;
  let rejections = 0;
  table.register({
    id: 'req-2',
    kind: 'status',
    resolve: () => undefined,
    reject: () => {
      rejections += 1;
    },
    signal: controller.signal,
    timeoutMs: 5_000,
    timeoutError: timeoutError(),
    onCancel: () => {
      cancels += 1;
    },
  });
  controller.abort();
  controller.abort();
  assert.equal(rejections, 1);
  assert.equal(cancels, 1);
  assert.equal(table.size, 0);
  assert.equal(table.timerCount, 0);
});

test('a timeout notifies the transport with the cancelled id and kind', async () => {
  const table = new TcpClientPendingTable();
  const seen: string[] = [];
  let rejected: unknown;
  table.register({
    id: 'req-3',
    kind: 'apply',
    resolve: () => undefined,
    reject: (error) => {
      rejected = error;
    },
    signal: undefined,
    timeoutMs: 10,
    timeoutError: timeoutError(),
    onCancel: (id, kind) => {
      seen.push(`${id}:${kind}`);
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(seen, ['req-3:apply']);
  assert.equal(rejected instanceof TcpTransportError, true);
  assert.equal((rejected as TcpTransportError).code, 'TCP_REQUEST_TIMEOUT');
  assert.equal(table.size, 0);
  assert.equal(table.timerCount, 0);
});

test('failAll rejects every pending request and clears all timers', () => {
  const table = new TcpClientPendingTable();
  const errors: string[] = [];
  for (const id of ['a', 'b']) {
    table.register({
      id,
      kind: 'status',
      resolve: () => undefined,
      reject: (error) => {
        errors.push(error.code);
      },
      signal: undefined,
      timeoutMs: 5_000,
      timeoutError: timeoutError(),
    });
  }
  assert.equal(table.timerCount, 2);
  table.failAll(new TcpTransportError('TCP_CONNECTION_CLOSED', 'closed'));
  assert.deepEqual(errors, ['TCP_CONNECTION_CLOSED', 'TCP_CONNECTION_CLOSED']);
  assert.equal(table.size, 0);
  assert.equal(table.timerCount, 0);
});
