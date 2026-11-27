import assert from 'node:assert/strict';
import test from 'node:test';
import type { z } from 'zod';
import { toolCatalog } from '../../src/surface/tool-catalog.ts';

function schema(name: string): z.ZodTypeAny {
  const tool = toolCatalog.find((candidate) => candidate.name === name);
  assert.ok(tool, `tool ${name} exists`);
  return tool.input;
}

const track = schema('track');
const sha = 'a'.repeat(64);

test('M18-D track takeover lifecycle keeps authorization_id on apply only', () => {
  const base = {
    root: '/tmp/project',
    idem_key: 'TK-1',
    kind: 'takeover',
    operation: 'status',
    payload: {},
  };
  // A status query must not carry an apply-only credential.
  assert.equal(track.safeParse({ ...base, payload: { authorization_id: sha } }).success, false);
  assert.equal(track.safeParse({ ...base, payload: {} }).success, true);

  const grant = {
    root: '/tmp/project',
    idem_key: 'TK-2',
    kind: 'takeover',
    operation: 'grant',
    payload: { scope: ['tasks'], granted_by: 'Owner', role: 'owner', statement: 'accept' },
  };
  assert.equal(track.safeParse(grant).success, true);
  assert.equal(track.safeParse({ ...grant, payload: { ...grant.payload, authorization_id: sha } }).success, false);
  assert.equal(track.safeParse({ ...grant, payload: { ...grant.payload, scope: [] } }).success, false);
  assert.equal(track.safeParse({ ...grant, payload: { ...grant.payload, scope: ['tasks', 'tasks'] } }).success, false);
  assert.equal(track.safeParse({ ...grant, payload: { ...grant.payload, scope: ['nope'] } }).success, false);
  assert.equal(track.safeParse({ ...grant, payload: { ...grant.payload, granted_by: '' } }).success, false);
  assert.equal(track.safeParse({ ...grant, payload: { ...grant.payload, role: '' } }).success, false);
});

test('M18-D takeover apply/recover/disable/revoke require literal confirm=true and apply carries the sha256 authorization_id', () => {
  for (const operation of ['recover', 'disable', 'revoke']) {
    assert.equal(track.safeParse({ idem_key: `TK-${operation}`, kind: 'takeover', operation, payload: {} }).success, false, `${operation} requires confirm`);
    assert.equal(
      track.safeParse({ idem_key: `TK-${operation}`, kind: 'takeover', operation, payload: { confirm: true } }).success,
      true,
      `${operation} accepts confirm=true`,
    );
    // authorization_id is apply-only; these operations must reject it.
    assert.equal(
      track.safeParse({ idem_key: `TK-${operation}-auth`, kind: 'takeover', operation, payload: { confirm: true, authorization_id: sha } }).success,
      false,
      `${operation} must not carry an apply credential`,
    );
  }

  const apply = { idem_key: 'TK-apply', kind: 'takeover', operation: 'apply', payload: { confirm: true } };
  assert.equal(track.safeParse(apply).success, false, 'apply needs the authorization id');
  assert.equal(track.safeParse({ ...apply, payload: { confirm: true, authorization_id: 'not-a-sha' } }).success, false);
  assert.equal(track.safeParse({ ...apply, payload: { confirm: true, authorization_id: sha } }).success, true);
});

test('M18-D task update requires a non-done status and complete requires Gate evidence', () => {
  const base = { root: '/tmp/project', idem_key: 'TK-task', kind: 'task' };
  assert.equal(track.safeParse({ ...base, operation: 'update', payload: { id: 'T-1' } }).success, false, 'update without status is rejected');
  assert.equal(track.safeParse({ ...base, operation: 'update', payload: { id: 'T-1', status: 'bogus' } }).success, false);
  assert.equal(track.safeParse({ ...base, operation: 'update', payload: { id: 'T-1', status: 'todo' } }).success, true);
  assert.equal(track.safeParse({ ...base, operation: 'complete', payload: { id: 'T-1' } }).success, false);
  assert.equal(track.safeParse({ ...base, operation: 'cancel', payload: { id: '' } }).success, false);
  assert.equal(track.safeParse({ ...base, operation: 'reopen', payload: { id: 'T-1' } }).success, true);
});

test('M18-D track connection payload rejects non-skip conflicts and bad digests', () => {
  const base = { root: '/tmp/project', idem_key: 'TK-conn', kind: 'connection', operation: 'plan' };
  assert.equal(track.safeParse({ ...base, payload: { on_conflict: 'overwrite' } }).success, false);
  assert.equal(track.safeParse({ ...base, payload: { expected_digest: '' } }).success, false);
  assert.equal(track.safeParse({ ...base, payload: { expected_source_digest: 'z'.repeat(64) } }).success, false);
  assert.equal(track.safeParse({ ...base, payload: { unknown: 1 } }).success, false);
  const migrateApply = { idem_key: 'TK-mig', kind: 'connection', operation: 'migrate_apply', payload: {} };
  assert.equal(track.safeParse(migrateApply).success, false, 'migrate_apply needs the planned source digest');
});
