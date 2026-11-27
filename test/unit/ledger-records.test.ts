import assert from 'node:assert/strict';
import test from 'node:test';
import { ulid } from '../../src/core/ulid.ts';
import { eventChain, genesisHash, type LedgerEvent } from '../../src/ledger/event.ts';
import { encodeBatch, encodeEvents, parseEvents, parseSegment } from '../../src/ledger/segment.ts';

const event = (id: string, kind: LedgerEvent['kind'], previous = genesisHash): LedgerEvent => ({ id, hlc: { physical: 1, logical: 0, actor: 'A' }, actor: 'A', kind, payload: {}, prev_hash: previous });

test('batch parsing accepts only complete checksum-protected batches', () => {
  const batch = encodeBatch('b1', [event(ulid(1), 'task.created')]);
  for (let index = 0; index < batch.length; index += 1) {
    const result = parseSegment(batch.subarray(0, index));
    assert.equal(result.events.length, 0, `offset ${index}`);
  }
  assert.equal(parseSegment(batch).events.length, 1);
});

test('partial event stream can be recovered by its owner only', () => {
  const events = encodeEvents([event(ulid(1), 'segment.started'), event(ulid(2), 'task.created')]);
  const partial = events.subarray(0, events.length - 1);
  const parsed = parseEvents(partial);
  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.ignoredTail, true);
});

test('hash chain detects changed events', () => {
  const first = event(ulid(1), 'task.created');
  const second = { ...event(ulid(2), 'task.updated'), prev_hash: 'not-a-hash' };
  assert.equal(eventChain([first]), true);
  assert.equal(eventChain([first, second]), false);
});
