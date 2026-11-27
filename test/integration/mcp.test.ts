import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { explore } from '../../src/surface/service.ts';
import { toolCatalog } from '../../src/surface/tool-catalog.ts';
import { GraphStore } from '../../src/structure/store.ts';

const serverPath = fileURLToPath(new URL('../../src/surface/mcp.ts', import.meta.url));

async function connect(root?: string): Promise<Client> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath], ...(root ? { env: { ...process.env, ANO_ROOT: root } } : {}), stderr: 'pipe' });
  const client = new Client({ name: 'ano-test', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

async function gitProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ano mcp project '));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  await writeFile(join(root, 'src', 'alpha.ts'), 'export const alpha = 1;\nexport const beta = 2;\n');
  for (const args of [['init', '-q'], ['config', 'user.email', 'ano@localhost'], ['config', 'user.name', 'ano'], ['add', '.'], ['commit', '-qm', 'base']]) {
    const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  return root;
}

function text(result: unknown): string { return JSON.stringify(result); }
function properties(tool: { inputSchema: unknown }): Record<string, unknown> {
  const schema = tool.inputSchema as { properties?: Record<string, unknown> };
  assert.ok(schema.properties, 'inputSchema must expose properties');
  return schema.properties;
}
function required(tool: { inputSchema: unknown }): string[] {
  const schema = tool.inputSchema as { required?: string[] };
  return schema.required ?? [];
}

test('real stdio MCP server lists exactly seven tools with real schemas', async () => {
  const client = await connect();
  try {
    const result = await client.listTools();
    assert.deepEqual(result.tools.map((tool) => tool.name), ['brief', 'explore', 'recall', 'track', 'note', 'verify', 'audit']);
    for (const tool of result.tools) {
      assert.equal((tool.inputSchema as { type?: string }).type, 'object');
      assert.ok(Object.keys(properties(tool)).length > 0, `${tool.name} must not expose empty properties`);
    }
    const byName = new Map(result.tools.map((tool) => [tool.name, tool]));
    const note = byName.get('note')!;
    const noteProperties = properties(note);
    for (const field of ['root', 'idem_key', 'kind', 'text', 'anchor', 'operation', 'fact_key', 'supersedes', 'reason', 'effective_from', 'effective_to', 'edge', 'from_ref', 'to_ref']) assert.ok(field in noteProperties, `note.${field} missing`);
    const anchor = noteProperties.anchor as { properties?: Record<string, unknown> };
    assert.ok(anchor.properties && 'file' in anchor.properties, 'note.anchor.file must be a real field');
    assert.ok(required(note).includes('idem_key'), `note.required = ${required(note).join(',')}`);

    const recall = byName.get('recall')!;
    const recallProperties = properties(recall);
    for (const field of ['mode', 'project_scope', 'requirements', 'temporal_mode', 'as_of', 'budget']) assert.ok(field in recallProperties, `recall.${field} missing`);

    const verify = byName.get('verify')!;
    const verifyProperties = properties(verify);
    for (const field of ['root', 'idem_key', 'scope', 'task_id', 'argv', 'test_files', 'target', 'profiles', 'artifact_path', 'context_id', 'project_scope', 'draft']) assert.ok(field in verifyProperties, `verify.${field} missing`);
    assert.equal((verifyProperties.argv as { type?: string }).type, 'array');
    assert.equal((verifyProperties.test_files as { type?: string }).type, 'array');
    assert.ok(['scope', 'idem_key'].every((field) => required(verify).includes(field)), `verify.required = ${required(verify).join(',')}`);

    const brief = byName.get('brief')!;
    const briefProperties = properties(brief);
    for (const field of ['include_memory_context', 'context_budget']) assert.ok(field in briefProperties, `brief.${field} missing`);
  } finally {
    await client.close();
  }
});

test('unimplemented tools return errors rather than pretending to mutate', async () => {
  const client = await connect();
  try {
    const result = await client.callTool({ name: 'note', arguments: { kind: 'memory', text: 'unanchored', idem_key: 'test:note' } });
    assert.equal(result.isError, true);
    assert.match(text(result), /not implemented|Invalid input|invalid/i);
    const incompleteVerify = await client.callTool({ name: 'verify', arguments: { scope: 'task', task_id: 'T1', idem_key: 'v1' } });
    assert.equal(incompleteVerify.isError, true, 'task verification without argv/test_files must be rejected');
    assert.match(text(incompleteVerify), /argv|test_files|Invalid input|invalid/i);
  } finally {
    await client.close();
  }
});

test('connected memory and release tools return real results while unimplemented scopes fail closed', async () => {
  const root = await gitProject();
  const client = await connect(root);
  try {
    const recalled = await client.callTool({ name: 'recall', arguments: { root, keyword: 'anything' } });
    assert.equal(recalled.isError, undefined);
    assert.equal(JSON.parse((recalled.content as { text: string }[])[0]!.text).status, 'not_configured');
    const noted = await client.callTool({ name: 'note', arguments: { root, idem_key: 'n1', kind: 'memory', text: 'x', anchor: { file: 'src/alpha.ts' } } });
    assert.equal(noted.isError, undefined, text(noted));
    assert.equal(JSON.parse((noted.content as { text: string }[])[0]!.text).status, 'recorded');
    const missingRelease = await client.callTool({ name: 'verify', arguments: { root, idem_key: 'v1', scope: 'release', target: '0.1.0', profiles: ['library'] } });
    assert.equal(missingRelease.isError, true, 'release without a real artifact must fail');
    const unsupported = await client.callTool({ name: 'track', arguments: { root, idem_key: 't1', kind: 'milestone', operation: 'create', payload: {} } });
    assert.equal(unsupported.isError, true);
    assert.match(text(unsupported), /not implemented/i);
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('read tools validate root existence and Git work-tree status before creating .ano', async () => {
  const noPackage = await mkdtemp(join(tmpdir(), 'ano mcp nopkg '));
  const notGit = await mkdtemp(join(tmpdir(), 'ano mcp notgit '));
  const fakeGit = await mkdtemp(join(tmpdir(), 'ano mcp fakegit '));
  const missing = join(tmpdir(), `ano-mcp-missing-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await writeFile(join(notGit, 'package.json'), JSON.stringify({ private: true }));
  // A `.git` file is a valid Git-root marker (ADR-009 §3.1/§4.1), so this root
  // passes the Git work-tree check and fails later on the missing Node package.
  await writeFile(join(fakeGit, '.git'), 'gitdir: nowhere\n');
  const client = await connect();
  try {
    // Neither .git nor package.json: the Git work-tree check runs first.
    const noPackageResult = await client.callTool({ name: 'brief', arguments: { root: noPackage } });
    assert.equal(noPackageResult.isError, true);
    assert.match(text(noPackageResult), /No \.git found at or above|A Git work tree is required/i, 'an explicitly selected project is validated before use');
    assert.equal(existsSync(join(noPackage, '.ano')), false);

    // package.json without a Git work tree: the Git check still runs first.
    const notGitResult = await client.callTool({ name: 'brief', arguments: { root: notGit } });
    assert.equal(notGitResult.isError, true);
    assert.match(text(notGitResult), /No \.git found at or above|A Git work tree is required/i);
    assert.equal(existsSync(join(notGit, '.ano')), false);

    // The `.git` file satisfies the Git-root check, so the visible failure is the
    // missing package.json (NO_NODE_PACKAGE), not a Git work-tree error.
    const fakeGitResult = await client.callTool({ name: 'explore', arguments: { root: fakeGit, query: 'alpha' } });
    assert.equal(fakeGitResult.isError, true);
    assert.match(text(fakeGitResult), /No package\.json at/i);
    assert.doesNotMatch(text(fakeGitResult), /No \.git found at or above|A Git work tree is required/i);
    assert.equal(existsSync(join(fakeGit, '.ano')), false);

    const missingResult = await client.callTool({ name: 'explore', arguments: { root: missing, query: 'alpha' } });
    assert.equal(missingResult.isError, true);
    assert.match(text(missingResult), /does not exist/i);
    assert.equal(existsSync(missing), false, 'a missing root must not be created');

    const traversed = await client.callTool({ name: 'brief', arguments: { root: 'not-a-real-path', extra: true } });
    assert.equal(traversed.isError, true, 'unknown fields must be rejected before any filesystem work');
  } finally {
    await client.close();
    await Promise.all([noPackage, notGit, fakeGit].map((path) => rm(path, { recursive: true, force: true })));
  }
});

test('explore truncation is derived from the budget, not the total match count', async () => {
  const root = await gitProject();
  const store = await GraphStore.open(root);
  try { await store.build(); } finally { store.close(); }
  try {
    const limited = await explore(root, 'a', 1);
    assert.equal((limited.symbols as unknown[]).length, 1);
    assert.ok((limited.total as number) > 1, `expected several matches, got ${limited.total}`);
    assert.equal(limited.truncated, true);
    const widened = await explore(root, 'a', 1_000);
    assert.equal(widened.truncated, false);
    assert.equal((widened.symbols as unknown[]).length, widened.total);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('real stdio dispatch covers the AP-13 branches without changing the tool count', async () => {
  const root = await gitProject();
  const client = await connect(root);
  try {
    const listed = await client.listTools();
    assert.equal(listed.tools.length, 7);

    const revised = await client.callTool({
      name: 'note',
      arguments: {
        root, idem_key: 'stdio:revise:1', operation: 'revise', kind: 'memory',
        text: 'storage is sqlite', fact_key: 'local.storage.engine', supersedes: [],
        reason: 'genesis', effective_from: null, effective_to: null,
      },
    });
    assert.equal(revised.isError, undefined, text(revised));

    const briefed = await client.callTool({ name: 'brief', arguments: { root, include_memory_context: true, context_budget: 20 } });
    assert.equal(briefed.isError, undefined, text(briefed));
    const memoryContext = JSON.parse((briefed.content as { text: string }[])[0]!.text).memory_context as { context_id: string; project_scope: string };
    assert.equal(memoryContext.project_scope, 'local');

    const manifest = JSON.parse(await readFile(join(root, '.ano', 'memory', 'probes', `${memoryContext.context_id}.json`), 'utf8')) as {
      response: { active_evidence: Array<{ ref: string }> };
    };
    const ref = manifest.response.active_evidence[0]?.ref;
    assert.ok(ref, 'the frozen context must carry an evidence alias');

    const probed = await client.callTool({ name: 'recall', arguments: { root, mode: 'probe', project_scope: 'local', requirements: ['local.storage.engine'] } });
    assert.equal(probed.isError, undefined, text(probed));

    const verified = await client.callTool({
      name: 'verify',
      arguments: {
        root, idem_key: 'stdio:verify:1', scope: 'context',
        context_id: memoryContext.context_id, project_scope: 'local',
        draft: {
          schema_version: 'anchorprobe.draft.v1',
          context_id: memoryContext.context_id,
          project_scope: 'local',
          claims: [{ id: 'C1', kind: 'CURRENT_FACT', fact_key: 'local.storage.engine', text: 'SQLite is the storage engine.', evidence_refs: [ref], params: [] }],
          not_applicable: [],
          unresolved: [],
        },
      },
    });
    assert.equal(verified.isError, undefined, text(verified));
    const report = JSON.parse((verified.content as { text: string }[])[0]!.text) as Record<string, unknown>;
    assert.equal(report.status, 'NEEDS_REVIEW');
    assert.equal('evidence_id' in report, false, 'context verify never produces Gate evidence');

    const legacyRecall = await client.callTool({ name: 'recall', arguments: { root, keyword: 'anything' } });
    assert.equal(legacyRecall.isError, undefined);
    assert.equal(JSON.parse((legacyRecall.content as { text: string }[])[0]!.text).status, 'not_configured');
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('ADR-007 client access stays CLI-only: the MCP surface remains seven tools', async () => {
  const client = await connect();
  try {
    const listed = await client.listTools();
    assert.equal(listed.tools.length, 7);
    assert.deepEqual(listed.tools.map((tool) => tool.name), ['brief', 'explore', 'recall', 'track', 'note', 'verify', 'audit']);
    assert.equal(listed.tools.some((tool) => /client|doctor|install|restore/u.test(tool.name)), false);
  } finally {
    await client.close();
  }
});

test('track takeover branch schema is strict, mutually exclusive and confirmation-explicit', () => {
  const track = toolCatalog.find((tool) => tool.name === 'track');
  assert.ok(track);
  const grant = {
    idem_key: 'schema:grant', kind: 'takeover', operation: 'grant',
    payload: { scope: ['tasks', 'memory'], granted_by: 'Alice', role: 'owner', statement: 'authorize' },
  };
  assert.equal(track.input.safeParse(grant).success, true);
  assert.equal(track.input.safeParse({ ...grant, payload: { ...grant.payload, nope: 1 } }).success, false, 'unknown payload fields are rejected');
  assert.equal(track.input.safeParse({ ...grant, payload: { ...grant.payload, scope: ['tasks', 'nope'] } }).success, false);
  assert.equal(track.input.safeParse({ ...grant, payload: { ...grant.payload, scope: ['tasks', 'tasks'] } }).success, false, 'duplicate scopes are rejected');
  assert.equal(track.input.safeParse({ ...grant, payload: { scope: ['tasks'], granted_by: 'A', role: 'r' } }).success, false, 'statement is required');
  assert.equal(track.input.safeParse({ ...grant, kind: 'connection' }).success, false, 'takeover fields cannot be mixed with connection kind');

  const apply = {
    idem_key: 'schema:apply', kind: 'takeover', operation: 'apply',
    payload: { authorization_id: 'a'.repeat(64), confirm: true },
  };
  assert.equal(track.input.safeParse(apply).success, true);
  const { confirm: _confirm, ...withoutConfirm } = apply.payload;
  assert.equal(track.input.safeParse({ ...apply, payload: withoutConfirm }).success, false, 'apply requires explicit confirm=true');
  assert.equal(track.input.safeParse({ ...apply, payload: { ...apply.payload, confirm: false } }).success, false, 'confirm must be the literal true');
  assert.equal(track.input.safeParse({ ...apply, payload: { authorization_id: 'short', confirm: true } }).success, false);
  assert.equal(track.input.safeParse({ ...apply, payload: { ...apply.payload, scope: ['tasks'] } }).success, false, 'grant fields are only allowed for grant');

  const status = { idem_key: 'schema:status', kind: 'takeover', operation: 'status', payload: {} };
  assert.equal(track.input.safeParse(status).success, true);
  assert.equal(track.input.safeParse({ ...status, operation: 'plan' }).success, false, 'takeover kind requires a takeover operation');
  assert.equal(track.input.safeParse({ ...status, kind: 'task' }).success, false, 'takeover operation cannot be mixed with task kind');
});

test('MCP dispatches the takeover lifecycle through track while tools stay at seven', async () => {
  const root = await gitProject();
  await mkdir(join(root, '.pm'), { recursive: true });
  await writeFile(join(root, '.pm', 'project.json'), JSON.stringify({ id: 'fixture-project', name: 'fixture' }));
  await writeFile(join(root, '.pm', 'tasks.json'), JSON.stringify({ seq: 1, tasks: [{ id: 'T-PM-1', title: 'Migrate me', status: 'done', files: ['src/alpha.ts'] }] }));
  await writeFile(join(root, '.pm', 'roadmap.json'), JSON.stringify({ seq: 1, milestones: [] }));
  await writeFile(join(root, '.pm', 'features.json'), JSON.stringify({ seq: 1, features: [] }));
  await writeFile(join(root, '.pm', 'sessions.json'), JSON.stringify({ seq: 1, sessions: [] }));
  await writeFile(join(root, 'AGENTS.md'), '# Agents\n\nkeep this\n');
  const client = await connect(root);
  try {
    const listed = await client.listTools();
    assert.equal(listed.tools.length, 7);
    assert.deepEqual(listed.tools.map((tool) => tool.name), ['brief', 'explore', 'recall', 'track', 'note', 'verify', 'audit']);

    const granted = await client.callTool({
      name: 'track',
      arguments: {
        root, idem_key: 'mcp:takeover:grant', kind: 'takeover', operation: 'grant',
        payload: { scope: ['tasks', 'memory', 'acceptance', 'dag'], granted_by: 'Alice', role: 'owner', statement: 'I authorize ANO takeover.' },
      },
    });
    assert.equal(granted.isError, undefined, text(granted));
    const grantPayload = JSON.parse((granted.content as { text: string }[])[0]!.text) as { authorization: { authorizationId: string } };
    const authorizationId = grantPayload.authorization.authorizationId;
    assert.match(authorizationId, /^[0-9a-f]{64}$/);

    const noConfirm = await client.callTool({
      name: 'track',
      arguments: { root, idem_key: 'mcp:takeover:apply-no', kind: 'takeover', operation: 'apply', payload: { authorization_id: authorizationId } },
    });
    assert.equal(noConfirm.isError, true, 'apply without confirm=true must be rejected');

    const applied = await client.callTool({
      name: 'track',
      arguments: { root, idem_key: 'mcp:takeover:apply', kind: 'takeover', operation: 'apply', payload: { authorization_id: authorizationId, confirm: true } },
    });
    assert.equal(applied.isError, undefined, text(applied));
    assert.equal(JSON.parse((applied.content as { text: string }[])[0]!.text).state, 'enforced');

    const status = await client.callTool({
      name: 'track',
      arguments: { root, idem_key: 'mcp:takeover:status', kind: 'takeover', operation: 'status', payload: {} },
    });
    assert.equal(status.isError, undefined, text(status));
    assert.equal(JSON.parse((status.content as { text: string }[])[0]!.text).state, 'enforced');

    // enforced refuses the legacy PM→ANO migration write through the MCP branch.
    const plan = await client.callTool({
      name: 'track',
      arguments: { root, idem_key: 'mcp:takeover:plan', kind: 'connection', operation: 'migrate_plan', payload: {} },
    });
    assert.equal(plan.isError, undefined, text(plan));
    const digest = (JSON.parse((plan.content as { text: string }[])[0]!.text) as { sourceDigest: string }).sourceDigest;
    const blocked = await client.callTool({
      name: 'track',
      arguments: { root, idem_key: 'mcp:takeover:migrate', kind: 'connection', operation: 'migrate_apply', payload: { expected_source_digest: digest } },
    });
    assert.equal(blocked.isError, true, 'enforced must refuse the legacy migration write');
    assert.match(text(blocked), /legacy PM-mcp write refused/);

    const disabled = await client.callTool({
      name: 'track',
      arguments: { root, idem_key: 'mcp:takeover:disable', kind: 'takeover', operation: 'disable', payload: { confirm: true } },
    });
    assert.equal(disabled.isError, undefined, text(disabled));
    assert.equal(JSON.parse((disabled.content as { text: string }[])[0]!.text).state, 'recovery');

    const recovered = await client.callTool({
      name: 'track',
      arguments: { root, idem_key: 'mcp:takeover:recover', kind: 'takeover', operation: 'recover', payload: { confirm: true } },
    });
    assert.equal(recovered.isError, undefined, text(recovered));
    assert.equal(JSON.parse((recovered.content as { text: string }[])[0]!.text).state, 'disabled');

    const revoked = await client.callTool({
      name: 'track',
      arguments: { root, idem_key: 'mcp:takeover:revoke', kind: 'takeover', operation: 'revoke', payload: { confirm: true } },
    });
    assert.equal(revoked.isError, undefined, text(revoked));
    const revokePayload = JSON.parse((revoked.content as { text: string }[])[0]!.text) as { state: string; authorization: { revokedAt: string | null } };
    assert.equal(revokePayload.state, 'disabled');
    assert.ok(revokePayload.authorization.revokedAt !== null);

    // Ordinary Connect read commands keep working on an ordinary project.
    const recalled = await client.callTool({ name: 'recall', arguments: { root, keyword: 'anything' } });
    assert.equal(recalled.isError, undefined);
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
});
