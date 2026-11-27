import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MUTATIONS,
  MUTATION_CATEGORIES,
  applyExactReplacement,
  classifyRun,
  countOccurrences,
  deterministicFrameSizes,
  hashSourceTree,
  parseTapSummary,
  seededRng,
  validateMutationSpecs,
} from '../helpers/m18-mutation-harness.ts';
import { MWHA_PROTOCOL_SCHEMA_VERSION, type MwhaLeaderLease } from '../../src/memory/ha-protocol.ts';
import {
  TcpReplicaFrameDecoder,
  encodeTcpReplicaFrame,
  type TcpReplicaWireMessage,
} from '../../src/memory/tcp-frame-codec.ts';
import { compareDeclarations } from '../../src/memory/leader-state.ts';
import { Hlc, compareHlc } from '../../src/core/hlc.ts';

/**
 * T-154 / QF-05 lightweight coverage for the mutation harness.
 *
 * This file intentionally never spawns the mutation runner, never opens a
 * socket and never touches the working tree: the ordinary suite only verifies
 * the harness's pure logic plus two tiny, budgeted, seeded fuzz loops over
 * real production pure functions. The actual isolated-copy mutation run is a
 * separate manual command (`node scripts/mutation-check.ts`).
 */

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string') {
    return (error as { code: string }).code;
  }
  return undefined;
}

/** Normalize -0 away so strict equality can compare signs. */
function sign(value: number): number {
  return value > 0 ? 1 : value < 0 ? -1 : 0;
}

test('mutation catalogue covers all six categories and every anchor matches current source once', () => {
  const validation = validateMutationSpecs(PROJECT_ROOT);
  assert.deepEqual(validation.problems, []);
  assert.equal(validation.ok, true);
  assert.equal(validation.checked, MUTATIONS.length);
  const categories = new Set(MUTATIONS.map((spec) => spec.category));
  assert.deepEqual([...categories].sort(), [...MUTATION_CATEGORIES].sort());
});

test('applyExactReplacement requires exactly one match', () => {
  const source = 'alpha\nbeta\ngamma\n';
  const once = applyExactReplacement(source, 'beta', 'BETA');
  assert.equal(once.occurrences, 1);
  assert.equal(once.output, 'alpha\nBETA\ngamma\n');

  const absent = applyExactReplacement(source, 'delta', 'DELTA');
  assert.equal(absent.occurrences, 0);
  assert.equal(absent.output, source);

  const twice = applyExactReplacement('x\nx\n', 'x', 'y');
  assert.equal(twice.occurrences, 2);
  assert.equal(twice.output, 'x\nx\n');

  assert.equal(countOccurrences('aaaa', 'aa'), 2);
  assert.equal(countOccurrences('abc', ''), 0);
});

test('classifyRun records assertion failures as kills and load failures as harness errors', () => {
  const killed = classifyRun({
    exitCode: 1,
    signal: null,
    timedOut: false,
    output: 'TAP version 13\n# Subtest: detector\nnot ok 1 - term dominates\n  ---\n  failing: true\n',
  });
  assert.equal(killed.kind, 'killed');
  assert.equal(killed.reason, 'assertion-failure');
  assert.deepEqual(killed.failingTests, ['term dominates']);

  const survived = classifyRun({ exitCode: 0, signal: null, timedOut: false, output: '# pass 3\n' });
  assert.equal(survived.kind, 'survived');

  const timeout = classifyRun({ exitCode: null, signal: 'SIGKILL', timedOut: true, output: '' });
  assert.equal(timeout.kind, 'harness_error');
  assert.equal(timeout.reason, 'subprocess-timeout');

  const syntax = classifyRun({
    exitCode: 1,
    signal: null,
    timedOut: false,
    output: 'file.ts:12\nconst x = ;\nSyntaxError: Unexpected token ;\n',
  });
  assert.equal(syntax.kind, 'harness_error');
  assert.equal(syntax.reason, 'syntax-error');

  const missingImport = classifyRun({
    exitCode: 1,
    signal: null,
    timedOut: false,
    output: "Cannot find module '../src/nope.ts'\nERR_MODULE_NOT_FOUND\n",
  });
  assert.equal(missingImport.kind, 'harness_error');
  assert.equal(missingImport.reason, 'import-resolution-error');
});

test('parseTapSummary extracts counters and failing names', () => {
  const summary = parseTapSummary([
    'TAP version 13',
    'ok 1 - first',
    'not ok 2 - second',
    'not ok 3 - third',
    'ok 4 - fourth # SKIP',
    '# tests 4',
    '# pass 2',
    '# fail 2',
    '# skipped 1',
  ].join('\n'));
  assert.equal(summary.tests, 4);
  assert.equal(summary.pass, 2);
  assert.equal(summary.fail, 2);
  assert.equal(summary.skipped, 1);
  assert.deepEqual(summary.notOkNames, ['second', 'third']);
});

test('hashSourceTree is deterministic and sensitive to content changes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ano-m18-hash-'));
  try {
    mkdirSync(join(directory, 'src'), { recursive: true });
    writeFileSync(join(directory, 'src', 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(directory, 'src', 'b.ts'), 'export const b = 2;\n');
    const first = hashSourceTree(directory);
    const second = hashSourceTree(directory);
    assert.equal(first.hash, second.hash);
    assert.equal(first.files, 2);
    writeFileSync(join(directory, 'src', 'b.ts'), 'export const b = 3;\n');
    const third = hashSourceTree(directory);
    assert.notEqual(third.hash, first.hash);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('seeded fuzz primitives are deterministic and bounded', () => {
  const left = deterministicFrameSizes(154, 32);
  const right = deterministicFrameSizes(154, 32);
  assert.deepEqual(left, right);
  for (const size of left) {
    assert.ok(Number.isSafeInteger(size));
    assert.ok(size >= 0);
  }
  const rng = seededRng(7);
  for (let index = 0; index < 64; index += 1) {
    const value = rng();
    assert.ok(value >= 0 && value < 1);
  }
});

test('bounded seeded frame fuzz round-trips through the real codec at size boundaries', () => {
  const maxFrameBytes = 256;
  const sizes = deterministicFrameSizes(154, 96, [0, 1, 64, 200, 240]);
  let decodedCount = 0;
  let rejectedCount = 0;
  for (let index = 0; index < sizes.length; index += 1) {
    const frame: TcpReplicaWireMessage = {
      schema_version: MWHA_PROTOCOL_SCHEMA_VERSION,
      kind: 'query',
      id: `fuzz-${String(index)}`,
      payload: { marker: 'x'.repeat(sizes[index]!) },
    };
    let encoded: Buffer;
    try {
      encoded = encodeTcpReplicaFrame(frame, maxFrameBytes);
    } catch (error) {
      assert.equal(errorCode(error), 'TCP_FRAME_TOO_LARGE');
      rejectedCount += 1;
      continue;
    }
    const outcome = new TcpReplicaFrameDecoder(maxFrameBytes).push(encoded);
    assert.equal(outcome.error, null, `case ${String(index)} size ${String(sizes[index])}`);
    assert.deepEqual(outcome.frames, [frame]);
    decodedCount += 1;
  }
  assert.ok(decodedCount > 0, 'fuzz must exercise at least one accepted frame');
  assert.ok(rejectedCount > 0, 'fuzz must exercise at least one boundary rejection');
});

test('bounded seeded leader/HLC state fuzz holds ordering and monotonicity invariants', () => {
  const rng = seededRng(154);
  const lease = (leaderId: string, epoch: number, term: number): MwhaLeaderLease => ({ leader_id: leaderId, epoch, term });
  for (let index = 0; index < 96; index += 1) {
    const pick = (): MwhaLeaderLease => lease(
      rng() < 0.5 ? 'a' : 'b',
      Math.floor(rng() * 4),
      Math.floor(rng() * 4),
    );
    const left = pick();
    const right = pick();
    const forward = compareDeclarations(left, right);
    const backward = compareDeclarations(right, left);
    assert.equal(sign(forward) + sign(backward), 0, 'declaration order is antisymmetric');
    assert.equal(compareDeclarations(left, left), 0, 'equal declarations compare zero');
  }

  const hlc = new Hlc('actor-a');
  let previous = hlc.timestamp();
  for (let index = 0; index < 64; index += 1) {
    const now = index < 20 ? index * 10 : 200;
    const next = hlc.tick(now);
    assert.ok(next.physical >= previous.physical, 'hlc physical time never goes backwards');
    assert.ok(compareHlc(next, previous) >= 0, 'hlc timestamps stay ordered');
    const merged = hlc.receive({ physical: now, logical: index, actor: 'actor-b' }, now);
    assert.ok(merged.physical >= next.physical, 'hlc receive never lowers physical time');
    assert.deepEqual(Object.keys(merged).sort(), ['actor', 'logical', 'physical']);
    previous = merged;
  }
});
