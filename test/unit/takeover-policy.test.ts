import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TAKEOVER_ACTIVE_PHASES,
  TAKEOVER_PHASES,
  TAKEOVER_STATES,
  assertAuthorizationIntegrity,
  assertPhaseAdvance,
  assertPolicyStateIntegrity,
  assertRootBinding,
  assertStateTransition,
  authorizationIssues,
  canTransitionState,
  computeAuthorizationId,
  computePolicyStateHash,
  createAuthorization,
  createPolicy,
  nextStates,
  parsePolicy,
  policyIssues,
  type CreateAuthorizationInput,
  type CreatePolicyInput,
  type TakeoverAuthorization,
  type TakeoverPolicy,
  type TakeoverState,
} from '../../src/connect/takeover-policy.ts';

const ROOT = '<repo>';
const OTHER_ROOT = 'F:/Some Other Project';
const GRANTED_AT = '2026-11-22T00:00:00.000Z';
const HASH_A = 'a'.repeat(64);

function auth(overrides: Partial<CreateAuthorizationInput> = {}): TakeoverAuthorization {
  return createAuthorization({
    root: ROOT,
    projectId: 'proj-1',
    projectKey: 'key-1',
    scope: ['tasks', 'memory'],
    grantedBy: 'Alice',
    role: 'owner',
    statement: 'I explicitly authorize ANO takeover of this project.',
    grantedAt: GRANTED_AT,
    ...overrides,
  });
}

function policy(overrides: Partial<CreatePolicyInput> = {}): TakeoverPolicy {
  return createPolicy({
    root: ROOT,
    projectId: 'proj-1',
    projectKey: 'key-1',
    authorization: auth(),
    updatedAt: GRANTED_AT,
    ...overrides,
  });
}

test('authorization id is deterministic, scope-order independent and field sensitive', () => {
  const first = auth();
  const reordered = auth({ scope: ['memory', 'tasks'] });
  assert.equal(reordered.authorizationId, first.authorizationId, 'set-equal scopes must share one identity');

  const changed = auth({ statement: 'A different grant statement.' });
  assert.notEqual(changed.authorizationId, first.authorizationId);
  assert.notEqual(auth({ grantedBy: 'Bob' }).authorizationId, first.authorizationId);
  assert.notEqual(auth({ grantedAt: '2026-11-22T00:00:01.000Z' }).authorizationId, first.authorizationId);

  const expected = computeAuthorizationId({
    root: ROOT,
    projectId: 'proj-1',
    projectKey: 'key-1',
    scope: ['tasks', 'memory'],
    grantedBy: 'Alice',
    role: 'owner',
    statement: 'I explicitly authorize ANO takeover of this project.',
    grantedAt: GRANTED_AT,
  });
  assert.equal(first.authorizationId, expected);
  assert.match(first.authorizationId, /^[0-9a-f]{64}$/u);
});

test('authorization integrity fails closed when the stored id no longer matches', () => {
  const tampered = { ...auth(), statement: 'edited after grant' };
  assert.throws(() => assertAuthorizationIntegrity(tampered), /does not match/);
  // The edit is schema-shaped; only the id binding catches it, so persistence
  // must always recompute the id rather than trusting schema validity alone.
  assert.deepEqual(authorizationIssues(tampered), []);
});

test('policy roundtrips through its strict schema', () => {
  const doc = policy();
  assert.deepEqual(parsePolicy(doc), doc);
  assert.deepEqual(policyIssues(doc), []);
  assert.deepEqual(authorizationIssues(doc.authorization), []);
});

test('strict schemas reject unknown fields, wrong types, bad digests and bad timestamps', () => {
  const doc = policy();
  assert.ok(policyIssues({ ...doc, surprise: true }).length > 0, 'unknown top-level field');
  assert.ok(policyIssues({ ...doc, state: 'paused' }).length > 0, 'unknown state');
  assert.ok(policyIssues({ ...doc, updatedAt: 'yesterday' }).length > 0, 'non-ISO timestamp');
  assert.ok(policyIssues({ ...doc, baselineDigest: 'not-a-digest' }).length > 0, 'malformed digest');
  assert.ok(policyIssues({ ...doc, schemaVersion: 2 }).length > 0, 'unknown document version');
  assert.ok(policyIssues({ ...doc, authorization: { ...doc.authorization, surprise: 1 } }).length > 0, 'unknown authorization field');
  assert.throws(() => parsePolicy({ ...doc, state: 7 }), /schema validation/u);
  assert.throws(() => parsePolicy({ ...doc, authorization: { ...doc.authorization, revokedAt: 'soon' } }), /schema validation/u);
});

test('scope must be a non-empty unique enum subset', () => {
  assert.ok(policyIssues({ ...policy(), authorization: { ...auth(), scope: [] } }).length > 0, 'empty scope');
  assert.ok(policyIssues({ ...policy(), authorization: { ...auth(), scope: ['tasks', 'tasks'] } }).length > 0, 'duplicate scope');
  assert.ok(policyIssues({ ...policy(), authorization: { ...auth(), scope: ['secrets'] } }).length > 0, 'unknown scope');
  assert.deepEqual(policyIssues({ ...policy(), authorization: auth({ scope: ['dag', 'acceptance'] }) }), []);
});

test('state machine only allows legal forward or explicit recovery edges', () => {
  const expected: Record<TakeoverState, TakeoverState[]> = {
    disabled: ['enforced'],
    enforced: ['recovery'],
    recovery: ['disabled'],
  };
  for (const from of TAKEOVER_STATES) {
    for (const to of TAKEOVER_STATES) {
      assert.equal(canTransitionState(from, to), expected[from].includes(to), `${from} -> ${to}`);
      if (expected[from].includes(to)) assert.doesNotThrow(() => assertStateTransition(from, to));
      else assert.throws(() => assertStateTransition(from, to), /illegal takeover state transition/u);
    }
    assert.deepEqual(nextStates(from), expected[from]);
  }
  // ADR-006 §4.1 illegal jumps called out by name.
  assert.throws(() => assertStateTransition('enforced', 'disabled'));
  assert.throws(() => assertStateTransition('recovery', 'enforced'));
  assert.throws(() => assertStateTransition('disabled', 'recovery'));
});

test('phase advance follows the fixed sequence into terminal aborted', () => {
  for (let index = 0; index < TAKEOVER_ACTIVE_PHASES.length - 1; index += 1) {
    const from = TAKEOVER_ACTIVE_PHASES[index];
    const to = TAKEOVER_ACTIVE_PHASES[index + 1];
    if (from === undefined || to === undefined) continue;
    assert.doesNotThrow(() => assertPhaseAdvance(from, to), `${from} -> ${to}`);
    assert.throws(() => assertPhaseAdvance(to, from), /illegal takeover phase advance/u);
  }
  assert.throws(() => assertPhaseAdvance('prepared', 'verified'), 'skipped phase');
  assert.doesNotThrow(() => assertPhaseAdvance('installed', 'active'));
  assert.doesNotThrow(() => assertPhaseAdvance('active', 'aborted'));
  assert.doesNotThrow(() => assertPhaseAdvance('prepared', 'aborted'));
  assert.throws(() => assertPhaseAdvance('aborted', 'prepared'), /terminal/u);
  assert.equal(TAKEOVER_PHASES.includes('aborted'), true);
});

test('enforced policy requires enforcedAt, baselineDigest and a live authorization', () => {
  assert.throws(() => createPolicy({ ...policy(), state: 'enforced' }), /enforcedAt/u);
  assert.throws(
    () => createPolicy({ ...policy(), state: 'enforced', enforcedAt: GRANTED_AT }),
    /baselineDigest/u,
  );
  assert.throws(
    () => createPolicy({
      ...policy(),
      state: 'enforced',
      enforcedAt: GRANTED_AT,
      baselineDigest: HASH_A,
      authorization: { ...auth(), revokedAt: GRANTED_AT },
    }),
    /revoked authorization/u,
  );
  const enforced = createPolicy({
    ...policy(),
    state: 'enforced',
    enforcedAt: GRANTED_AT,
    baselineDigest: HASH_A,
  });
  assert.equal(enforced.state, 'enforced');
  assert.deepEqual(policyIssues(enforced), []);
});

test('root binding rejects documents from another root', () => {
  const doc = policy();
  assert.doesNotThrow(() => assertRootBinding(doc, ROOT));
  assert.throws(() => assertRootBinding(doc, OTHER_ROOT), /bound to root/u);
  assert.throws(() => assertRootBinding(doc.authorization, OTHER_ROOT), /bound to root/u);

  const foreignAuthorization = auth({ root: OTHER_ROOT });
  assert.ok(policyIssues({ ...doc, authorization: foreignAuthorization }).length > 0, 'authorization root mismatch');
  const renamedAuthorization = auth({ projectKey: 'key-2' });
  assert.ok(policyIssues({ ...doc, authorization: renamedAuthorization }).length > 0, 'authorization identity mismatch');
});

test('policy stateHash binds the mutable state and detects post-write edits', () => {
  const doc = policy();
  assert.match(doc.stateHash, /^[0-9a-f]{64}$/u);
  assert.equal(computePolicyStateHash(doc), doc.stateHash, 'deterministic over key order');
  assert.doesNotThrow(() => assertPolicyStateIntegrity(doc));

  // A schema-valid edit (for example a forged `enforced`) keeps the old hash.
  const edited = { ...doc, baselineDigest: HASH_A };
  assert.deepEqual(policyIssues(edited), [], 'the edit stays schema-valid');
  assert.throws(() => assertPolicyStateIntegrity(edited), /stateHash/u);

  const enforced = createPolicy({
    ...policy(),
    state: 'enforced',
    enforcedAt: GRANTED_AT,
    baselineDigest: HASH_A,
  });
  assert.notEqual(enforced.stateHash, doc.stateHash);
  assert.equal(computePolicyStateHash(enforced), enforced.stateHash);
});
