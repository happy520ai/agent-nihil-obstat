import assert from 'node:assert/strict';
import test from 'node:test';
import * as publicApi from '../../src/index.ts';
import * as memoryApi from '../../src/memory/index.ts';
import * as memoryContracts from '../../src/memory/types.ts';
import { Ledger } from '../../src/ledger/ledger.ts';
import { verifyTask } from '../../src/gate/verify.ts';
import { MemoryNoteBook } from '../../src/memory/note.ts';
import { decodeCursor, makeCursor } from '../../src/memory/cursor.ts';
import { testOnlyInteractiveStreams } from '../../src/readiness/test-seams.ts';

 test('M18 public barrels preserve implementation identity without exporting approval test seams', () => {
  assert.equal(publicApi.Ledger, Ledger);
  assert.equal(publicApi.verifyTask, verifyTask);
  assert.equal(memoryApi.MemoryNoteBook, MemoryNoteBook);
  assert.equal(memoryApi.makeCursor, makeCursor);
  assert.equal(memoryApi.decodeCursor, decodeCursor);
  assert.equal('testOnlyInteractiveStreams' in publicApi, false);
  assert.equal('testOnlyInteractiveStreams' in memoryApi, false);
  assert.deepEqual(Object.keys(memoryContracts), []);
});

test('M18 isolated readiness test streams are explicit fresh values, not shared process streams', () => {
  const first = testOnlyInteractiveStreams();
  const second = testOnlyInteractiveStreams();
  assert.deepEqual(first, { stdin: { isTTY: true }, stdout: { isTTY: true } });
  assert.notEqual(first, second);
  assert.notEqual(first.stdin, second.stdin);
  assert.notEqual(first.stdout, second.stdout);
  assert.notEqual(first.stdin, process.stdin);
  assert.notEqual(first.stdout, process.stdout);
});
