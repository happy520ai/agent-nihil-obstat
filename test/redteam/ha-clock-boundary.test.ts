import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  containsWallClockKey,
  MWHA_CLOCK_DEFAULT_POLICY,
  MWHA_UNVERIFIED_CAPABILITIES,
  classifyClockObservation,
  assertNoWallClockKey,
  HaProtocolError,
  type MwhaClockObservation,
} from '../../src/memory/ha-protocol.ts';
import { LogicalClockService, assertLogicalOnlyOrdering } from '../../src/memory/logical-clock.ts';
import {
  HA_CLOCK_CROSS_HOST_UNVERIFIED,
  HA_CLOCK_DIAGNOSTIC_SCOPE_NOTE,
  HA_CLOCK_DOES_NOT_CHANGE_SYSTEM_CLOCK,
  HA_CLOCK_LOCAL_INJECTION_IS_NOT_CROSS_HOST,
  HaClockController,
} from '../harness/ha-clock.ts';

/**
 * T-140 red-team boundary: clock anomalies are diagnostics, never authority.
 *
 * Every attempt to let wall-clock time decide facts must fail closed:
 * - wall-clock keys are refused in ordering-key objects;
 * - future/rollback samples never promote or demote a version;
 * - the boundary vocabulary stays explicit (local injection, OS clock
 *   untouched, cross-host unverified);
 * - malformed numeric samples fail closed instead of quietly ordering.
 */

const REFERENCE_MS = 1_700_000_000_000;

function observation(overrides: Record<string, unknown> = {}): MwhaClockObservation {
  return {
    member_id: 'node-x',
    epoch: 1,
    observed_ms: REFERENCE_MS,
    previous_observed_ms: null,
    reference_ms: REFERENCE_MS,
    ...overrides,
  } as MwhaClockObservation;
}

test('wall-clock fields are refused as ordering keys under every spelling', () => {
  for (const key of ['observedAt', 'timestamp', 'now', 'time', 'date', 'recordedAt', 'createdAt', 'updatedAt']) {
    assert.throws(
      () => assertLogicalOnlyOrdering([{ epoch: 1, [key]: 1 }]),
      /WALL_CLOCK_FORBIDDEN/u,
      `${key} must never be accepted as an ordering key`,
    );
    assert.throws(
      () => assertNoWallClockKey({ epoch: 1, [key]: 1 }),
      /WALL_CLOCK_FORBIDDEN/u,
      `${key} must be refused by the direct guard too`,
    );
  }
  for (const key of ['observedAt', 'timestamp', 'now', 'time']) {
    assert.ok(containsWallClockKey({ [key]: 1 }), `${key} must be recognized as a wall-clock key`);
  }
  // The service itself must not expose any ordering helper that accepts keys.
  const service = new LogicalClockService({ nodeId: 'x' });
  const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(service));
  for (const name of methods) {
    assert.doesNotMatch(name, /order|sort|merge/u, `LogicalClockService must not expose an ordering helper ${name}`);
  }
});

test('future and rollback observations classify as diagnostics with no authority', () => {
  const future = classifyClockObservation(observation({ observed_ms: REFERENCE_MS + 20_000 }), MWHA_CLOCK_DEFAULT_POLICY);
  assert.equal(future.kind, 'future');
  assert.equal(future.diagnostic_only, true);
  assert.equal(future.affects_commit_order, false);
  assert.equal(future.affects_fact_version, false);

  const rollback = classifyClockObservation(observation({ observed_ms: REFERENCE_MS - 60_000, previous_observed_ms: REFERENCE_MS }), MWHA_CLOCK_DEFAULT_POLICY);
  assert.equal(rollback.kind, 'rollback');
  assert.equal(rollback.diagnostic_only, true);
  assert.equal(rollback.affects_commit_order, false);
  assert.equal(rollback.affects_fact_version, false);

  // Neither marker mutates the HLC ordering: the same logical sequence ticks
  // identically regardless of the diagnostic history.
  const clean = new HaClockController({ nodeId: 'clean', startMs: REFERENCE_MS, referenceMs: REFERENCE_MS });
  const dirty = new HaClockController({ nodeId: 'dirty', startMs: REFERENCE_MS, referenceMs: REFERENCE_MS });
  clean.tick();
  clean.tick();
  dirty.future(20_000);
  dirty.tick();
  dirty.rollback(60_000);
  dirty.tick();
  dirty.tick();
  // HLC semantics (frozen contract): a physical advance resets logical to 0;
  // equal-physical ticks increment it. Both nodes therefore produce well-
  // formed snapshots; what must NOT happen is the dirty node's physical time
  // rewinding or its logical diverging from a clean node that shares the same
  // physical sample.
  assert.ok(Number.isSafeInteger(clean.snapshot().logical));
  assert.ok(Number.isSafeInteger(dirty.snapshot().logical));
  const cleanSamePhysical = new HaClockController({ nodeId: 'clean-same', startMs: REFERENCE_MS + 20_000, referenceMs: REFERENCE_MS });
  cleanSamePhysical.tick();
  cleanSamePhysical.rollback(60_000);
  cleanSamePhysical.tick();
  cleanSamePhysical.tick();
  assert.equal(
    dirty.snapshot().logical,
    cleanSamePhysical.snapshot().logical,
    'the rollback/future history must not change the logical counter for the same physical samples',
  );
  assert.ok(dirty.snapshot().physical >= REFERENCE_MS + 20_000, 'physical must absorb the forward sample');
  assert.ok(dirty.snapshot().physical <= REFERENCE_MS + 20_000, 'physical must not rewind on a rollback sample');
});

test('malformed clock observations fail closed instead of ordering', () => {
  for (const observed of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(
      () => classifyClockObservation(observation({ observed_ms: observed })),
      /CLOCK_OBSERVATION_INVALID/u,
      `observed_ms ${String(observed)} must be rejected`,
    );
  }
  assert.throws(() => classifyClockObservation(observation({ member_id: '' })), /CLOCK_OBSERVATION_INVALID/u);
  assert.throws(
    () => new LogicalClockService({ nodeId: 'x', now: () => Number.NaN }).tick(),
    /HA_INPUT_INVALID/u,
    'a NaN sampler must fail closed at tick time',
  );
  // The protocol error type is the failure vehicle, never a silent fallback.
  try {
    classifyClockObservation(observation({ observed_ms: Number.NaN }));
    assert.fail('must have thrown');
  } catch (error) {
    assert.ok(error instanceof HaProtocolError);
  }
});

test('the boundary vocabulary stays explicit and unchanged', () => {
  assert.equal(HA_CLOCK_LOCAL_INJECTION_IS_NOT_CROSS_HOST, '本地注入 ≠ 跨机真实回拨');
  assert.equal(HA_CLOCK_DOES_NOT_CHANGE_SYSTEM_CLOCK, '不改系统时钟');
  assert.equal(HA_CLOCK_CROSS_HOST_UNVERIFIED, '跨机未验证');
  assert.match(HA_CLOCK_DIAGNOSTIC_SCOPE_NOTE, /本地注入/u);
  assert.match(HA_CLOCK_DIAGNOSTIC_SCOPE_NOTE, /不改系统时钟/u);
  assert.match(HA_CLOCK_DIAGNOSTIC_SCOPE_NOTE, /跨机未验证/u);
  // The frozen protocol-level list must still name the cross-host rollback.
  assert.ok(
    MWHA_UNVERIFIED_CAPABILITIES.some((item) => item.includes('cross-host') || item.includes('回拨') || item.includes('clock')),
    `unverified capabilities must name the clock boundary: ${MWHA_UNVERIFIED_CAPABILITIES.join('; ')}`,
  );
  // No OS clock API is referenced by the logical clock module source.
  const source = readFileSync(new URL('../../src/memory/logical-clock.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /utimes|setSystemTime|systemclock/iu, 'the module must never touch the OS clock');
});
