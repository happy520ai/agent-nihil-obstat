import assert from 'node:assert/strict';
import test from 'node:test';
import { compareHlc, Hlc } from '../../src/core/hlc.ts';
import { ulid } from '../../src/core/ulid.ts';
import { assertProjectPath, projectPath } from '../../src/core/paths.ts';

test('HLC stays monotonic during a five-second rollback', () => {
  const clock = new Hlc('A');
  const before = clock.tick(10_000);
  const after = clock.tick(5_000);
  assert.ok(compareHlc(before, after) < 0);
});

test('HLC receive preserves causality', () => {
  const a = new Hlc('A');
  const b = new Hlc('B');
  const sent = a.tick(10_000);
  const received = b.receive(sent, 2_000);
  assert.ok(compareHlc(sent, received) < 0);
  assert.equal(b.tick(3_000).physical, sent.physical);
});

test('ULID is sortable by time and validates entropy length', () => {
  const early = ulid(1, new Uint8Array(10));
  const late = ulid(2, new Uint8Array(10));
  assert.ok(early < late);
  assert.match(early, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.throws(() => ulid(1, new Uint8Array(9)));
});

test('project paths are POSIX normalized and cannot escape root', () => {
  assert.equal(projectPath('F:\\project', 'F:\\project\\src\\a.ts'), 'src/a.ts');
  assert.throws(() => projectPath('F:\\project', 'F:\\other\\a.ts'));
  assert.throws(() => assertProjectPath('../secret'));
});
