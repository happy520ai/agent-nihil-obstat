import assert from 'node:assert/strict';
import fs, { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  DEFAULT_MANAGED_INSTRUCTIONS,
  MANAGED_INSTRUCTIONS_BEGIN,
  MANAGED_INSTRUCTIONS_END,
  MANAGED_INSTRUCTIONS_REQUIRED_SCOPES,
  MANAGED_STATE_DECLARATION_PREFIX,
  MAX_MANAGED_INSTRUCTIONS_BYTES,
  installManagedInstructions,
  managedStateDeclaration,
  removeManagedInstructions,
  renderDefaultManagedInstructions,
  updateManagedInstructions,
  type ManagedInstructionsAuthorization,
} from '../../src/connect/managed-instructions.ts';

const PM_BLOCK = '<!-- pm-mcp:agents-md:v1:begin -->\npm-mcp rules\n<!-- pm-mcp:agents-md:v1:end -->\n';

function rootFor(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'ano-managed-instructions-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function agentsPath(root: string): string {
  return join(root, 'AGENTS.md');
}

function writeAgents(root: string, content: string): void {
  writeFileSync(agentsPath(root), content);
}

function readAgents(root: string): Buffer {
  return readFileSync(agentsPath(root));
}

function authorization(root: string, overrides: Partial<ManagedInstructionsAuthorization> = {}): ManagedInstructionsAuthorization {
  return {
    authorizationId: 'a'.repeat(64),
    root,
    scope: [...MANAGED_INSTRUCTIONS_REQUIRED_SCOPES],
    grantedBy: 'Alice',
    statement: 'Authorize ANO enforced takeover for this project',
    grantedAt: '2026-11-22T00:00:00.000Z',
    ...overrides,
  };
}

test('install appends the section and preserves the pm-mcp block and user bytes', (t) => {
  const root = rootFor(t);
  const user = `${PM_BLOCK}\n# User notes\n\nkeep this 字节 🚀\n`;
  writeAgents(root, user);

  const result = installManagedInstructions(root, 'BODY', { confirm: authorization(root) });

  assert.equal(result.action, 'installed');
  assert.equal(result.changed, true);
  assert.equal(result.previousBytes, Buffer.byteLength(user, 'utf8'));
  const after = readAgents(root).toString('utf8');
  assert.equal(after.slice(0, user.length), user);
  assert.equal(after.slice(user.length), `\n${MANAGED_INSTRUCTIONS_BEGIN}\nBODY\n${MANAGED_INSTRUCTIONS_END}\n`);
  assert.equal(after.indexOf(MANAGED_INSTRUCTIONS_BEGIN), user.length + 1);
});

test('install creates AGENTS.md when it is absent', (t) => {
  const root = rootFor(t);
  const result = installManagedInstructions(root, 'BODY', { confirm: authorization(root) });
  assert.equal(result.action, 'installed');
  assert.deepEqual(readAgents(root), Buffer.from(`${MANAGED_INSTRUCTIONS_BEGIN}\nBODY\n${MANAGED_INSTRUCTIONS_END}\n`));
});

test('repeat install is a zero-byte no-op', (t) => {
  const root = rootFor(t);
  writeAgents(root, `${PM_BLOCK}\nuser\n`);
  const first = installManagedInstructions(root, 'BODY', { confirm: authorization(root) });
  assert.equal(first.action, 'installed');
  const afterFirst = readAgents(root);

  const second = installManagedInstructions(root, 'BODY', { confirm: authorization(root) });
  assert.equal(second.action, 'unchanged');
  assert.equal(second.changed, false);
  assert.deepEqual(readAgents(root), afterFirst);
  assert.equal(afterFirst.toString('utf8').split(MANAGED_INSTRUCTIONS_BEGIN).length - 1, 1);
  assert.equal(afterFirst.toString('utf8').split(MANAGED_INSTRUCTIONS_END).length - 1, 1);
});

test('update replaces only the managed span and leaves prefix/suffix bytes identical', (t) => {
  const root = rootFor(t);
  const prefix = `${PM_BLOCK}\n# User\n`;
  writeAgents(root, prefix);
  installManagedInstructions(root, 'OLD', { confirm: authorization(root) });
  const withOld = readAgents(root).toString('utf8');
  const beginIndex = withOld.indexOf(MANAGED_INSTRUCTIONS_BEGIN);
  const endIndex = withOld.indexOf(MANAGED_INSTRUCTIONS_END) + MANAGED_INSTRUCTIONS_END.length;
  const expectedPrefix = withOld.slice(0, beginIndex);
  const expectedSuffix = withOld.slice(endIndex);

  const result = updateManagedInstructions(root, 'NEW', { confirm: authorization(root) });

  assert.equal(result.action, 'updated');
  assert.equal(result.changed, true);
  const updated = readAgents(root).toString('utf8');
  assert.equal(updated.slice(0, beginIndex), expectedPrefix);
  assert.equal(updated.slice(updated.indexOf(MANAGED_INSTRUCTIONS_END) + MANAGED_INSTRUCTIONS_END.length), expectedSuffix);
  assert.ok(updated.includes(`${MANAGED_INSTRUCTIONS_BEGIN}\nNEW\n${MANAGED_INSTRUCTIONS_END}`));
  assert.equal(updated.includes('OLD'), false);
});

test('remove deletes the section and round-trips the original bytes', (t) => {
  const root = rootFor(t);
  const original = `${PM_BLOCK}\n# User notes\n`;
  writeAgents(root, original);
  installManagedInstructions(root, 'BODY', { confirm: authorization(root) });

  const result = removeManagedInstructions(root, { confirm: authorization(root) });

  assert.equal(result.action, 'removed');
  assert.equal(result.changed, true);
  const text = readAgents(root).toString('utf8');
  assert.deepEqual(readAgents(root), Buffer.from(original));
  assert.equal(text.includes(MANAGED_INSTRUCTIONS_BEGIN), false);
  assert.equal(text.includes(MANAGED_INSTRUCTIONS_END), false);

  const second = removeManagedInstructions(root, { confirm: authorization(root) });
  assert.equal(second.action, 'absent');
  assert.equal(second.changed, false);
});

test('remove cleans trailing blank lines around the section', (t) => {
  const root = rootFor(t);
  writeAgents(root, `user\n\n\n${MANAGED_INSTRUCTIONS_BEGIN}\nBODY\n${MANAGED_INSTRUCTIONS_END}\n\n\n`);
  const result = removeManagedInstructions(root, { confirm: authorization(root) });
  assert.equal(result.action, 'removed');
  assert.equal(readAgents(root).toString('utf8'), 'user\n');
});

test('missing confirm writes nothing for install, update and remove', (t) => {
  const root = rootFor(t);
  const original = `${PM_BLOCK}\nuser\n`;
  writeAgents(root, original);
  const before = readAgents(root);

  assert.throws(() => installManagedInstructions(root, 'BODY'), /authorization/iu);
  assert.throws(() => updateManagedInstructions(root, 'BODY', {}), /authorization/iu);
  assert.throws(() => removeManagedInstructions(root, {}), /authorization/iu);

  assert.deepEqual(readAgents(root), before);
});

test('cross-root, scope-insufficient and revoked authorizations are refused without writes', (t) => {
  const root = rootFor(t);
  const other = rootFor(t);
  const original = 'user\n';
  writeAgents(root, original);
  const before = readAgents(root);
  const auth = authorization(root);

  assert.throws(() => installManagedInstructions(root, 'BODY', { confirm: authorization(other) }), /root/iu);
  assert.throws(() => installManagedInstructions(root, 'BODY', { confirm: authorization(root, { scope: ['tasks'] }) }), /scope/iu);
  assert.throws(() => installManagedInstructions(root, 'BODY', { confirm: authorization(root, { scope: [] }) }), /scope/iu);
  assert.throws(
    () => installManagedInstructions(root, 'BODY', { confirm: authorization(root, { revokedAt: '2026-11-22T01:00:00.000Z' }) }),
    /revoked/iu,
  );
  assert.throws(() => installManagedInstructions(root, 'BODY', { confirm: authorization(root, { grantedBy: '   ' }) }), /grantedBy/iu);

  assert.deepEqual(readAgents(root), before);
  void auth;
});

test('symlink roots, non-directory roots and AGENTS.md links are refused', (t) => {
  const root = rootFor(t);
  const real = join(root, 'real');
  fs.mkdirSync(real);
  const link = join(root, 'link');
  fs.symlinkSync(real, link, 'dir');
  writeAgents(real, 'user\n');
  const realBefore = readAgents(real);

  assert.throws(() => installManagedInstructions(link, 'BODY', { confirm: authorization(real) }), /symbolic link|directory/iu);

  const filePath = join(root, 'file.txt');
  writeFileSync(filePath, 'x');
  assert.throws(() => installManagedInstructions(filePath, 'BODY', { confirm: authorization(filePath) }), /directory/iu);

  const linkedRoot = rootFor(t);
  const outside = join(linkedRoot, 'outside.md');
  writeFileSync(outside, 'user\n');
  fs.symlinkSync(outside, agentsPath(linkedRoot), 'file');
  assert.throws(() => installManagedInstructions(linkedRoot, 'BODY', { confirm: authorization(linkedRoot) }), /symbolic link/iu);

  assert.deepEqual(readAgents(real), realBefore);
});

test('forged, nested, oversized, NUL and empty content is refused without writes', (t) => {
  const root = rootFor(t);
  const original = 'user\n';
  writeAgents(root, original);
  const before = readAgents(root);
  const auth = authorization(root);

  assert.throws(() => installManagedInstructions(root, `x ${MANAGED_INSTRUCTIONS_BEGIN} y`, { confirm: auth }), /marker/iu);
  assert.throws(() => installManagedInstructions(root, `x ${MANAGED_INSTRUCTIONS_END} y`, { confirm: auth }), /marker/iu);
  assert.throws(() => installManagedInstructions(root, '<!--ano:takeover:managed:v1:begin-->', { confirm: auth }), /marker/iu);
  assert.throws(() => installManagedInstructions(root, 'x'.repeat(MAX_MANAGED_INSTRUCTIONS_BYTES + 1), { confirm: auth }), /limit/iu);
  assert.throws(() => installManagedInstructions(root, 'a\0b', { confirm: auth }), /NUL/iu);
  assert.throws(() => installManagedInstructions(root, '   \n  ', { confirm: auth }), /empty/iu);

  assert.deepEqual(readAgents(root), before);
});

test('multiple or unbalanced existing markers are refused without writes', (t) => {
  const root = rootFor(t);
  const auth = authorization(root);
  const duplicated = `${MANAGED_INSTRUCTIONS_BEGIN}\nA\n${MANAGED_INSTRUCTIONS_END}\n${MANAGED_INSTRUCTIONS_BEGIN}\nB\n${MANAGED_INSTRUCTIONS_END}\n`;
  writeAgents(root, duplicated);
  const before = readAgents(root);

  assert.throws(() => installManagedInstructions(root, 'NEW', { confirm: auth }), /at most one/iu);
  assert.throws(() => updateManagedInstructions(root, 'NEW', { confirm: auth }), /at most one/iu);
  assert.throws(() => removeManagedInstructions(root, { confirm: auth }), /at most one/iu);
  assert.deepEqual(readAgents(root), before);

  const unbalanced = `${MANAGED_INSTRUCTIONS_BEGIN}\nA\n`;
  writeAgents(root, unbalanced);
  const beforeUnbalanced = readAgents(root);
  assert.throws(() => installManagedInstructions(root, 'NEW', { confirm: auth }), /at most one/iu);
  assert.throws(() => removeManagedInstructions(root, { confirm: auth }), /at most one/iu);
  assert.deepEqual(readAgents(root), beforeUnbalanced);
});

test('a failed write restores the exact original bytes', (t) => {
  const root = rootFor(t);
  const original = `${PM_BLOCK}\nuser\n`;
  writeAgents(root, original);
  const before = readAgents(root);
  const auth = authorization(root);
  const realWrite = fs.writeFileSync;
  let failed = false;
  const mock = t.mock.method(fs, 'writeFileSync', (...args: Parameters<typeof fs.writeFileSync>): ReturnType<typeof fs.writeFileSync> => {
    if (args[0] === agentsPath(root) && !failed) {
      failed = true;
      realWrite(agentsPath(root), 'partial garbage');
      throw new Error('injected write failure');
    }
    return realWrite(...args);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => installManagedInstructions(root, 'BODY', { confirm: auth }), /injected write failure/iu);
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }

  assert.equal(failed, true);
  assert.deepEqual(readAgents(root), before);
  assert.equal(readAgents(root).toString('utf8'), original);

  const recovered = installManagedInstructions(root, 'BODY', { confirm: auth });
  assert.equal(recovered.action, 'installed');
});

test('default section declares the enforced policy state and the ANO workflow', (t) => {
  const root = rootFor(t);
  writeAgents(root, 'user\n');
  const content = renderDefaultManagedInstructions('enforced');

  assert.ok(content.includes(managedStateDeclaration('enforced')));
  assert.ok(content.includes(`${MANAGED_STATE_DECLARATION_PREFIX}enforced`));
  assert.ok(content.includes('ANO'));
  assert.ok(content.includes('只读'));
  assert.equal(DEFAULT_MANAGED_INSTRUCTIONS, renderDefaultManagedInstructions());

  const result = installManagedInstructions(root, content, { confirm: authorization(root) });
  assert.equal(result.action, 'installed');
  const text = readAgents(root).toString('utf8');
  assert.ok(text.includes(managedStateDeclaration('enforced')));
  assert.equal(updateManagedInstructions(root, content, { confirm: authorization(root) }).action, 'unchanged');
});

test('active HTML/JavaScript bodies are refused without writes (F-01)', (t) => {
  const root = rootFor(t);
  writeAgents(root, 'user\n');
  const before = readAgents(root);
  const auth = authorization(root);

  const active = [
    '<script>alert(1)</script>',
    '<SCRIPT src="https://evil.example/x.js"></SCRIPT>',
    '<img src=x onerror=alert(1)>',
    '<a href="javascript:alert(1)">click</a>',
    '<iframe src="https://evil.example"></iframe>',
    '<object data="x"></object>',
    '<embed src="x">',
    '<a href="data:text/html,<script>alert(1)</script>">x</a>',
  ];
  for (const body of active) {
    assert.throws(() => installManagedInstructions(root, body, { confirm: auth }), /active HTML or JavaScript/iu, body);
    assert.throws(() => updateManagedInstructions(root, body, { confirm: auth }), /active HTML or JavaScript/iu, body);
  }
  // Case/whitespace variants of the same executable constructs.
  assert.throws(() => installManagedInstructions(root, '<  script >x', { confirm: auth }), /active HTML/iu);

  assert.deepEqual(readAgents(root), before, 'refused active content must leave AGENTS.md byte-identical');
});

test('revoked grants cannot inject content but may remove the section during recovery', (t) => {
  const root = rootFor(t);
  writeAgents(root, 'user\n');
  const revoked = authorization(root, { revokedAt: '2026-11-22T01:00:00.000Z' });

  assert.throws(
    () => installManagedInstructions(root, 'BODY', { confirm: revoked, allowRevokedRemoval: true }),
    /revoked/iu,
    'the revoked-removal opt-in must not open install',
  );
  assert.throws(
    () => updateManagedInstructions(root, 'BODY', { confirm: revoked, allowRevokedRemoval: true }),
    /revoked/iu,
    'the revoked-removal opt-in must not open update',
  );

  installManagedInstructions(root, 'BODY', { confirm: authorization(root) });
  const removed = removeManagedInstructions(root, { confirm: revoked, allowRevokedRemoval: true });
  assert.equal(removed.action, 'removed');
  assert.equal(readAgents(root).toString('utf8'), 'user\n');
});
