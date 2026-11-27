import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test, { type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { runCli } from '../../src/surface/cli.ts';
import { toolCatalog } from '../../src/surface/tool-catalog.ts';

const mcpPath = fileURLToPath(new URL('../../src/surface/mcp.ts', import.meta.url));
const CONNECT_DIR = join('.ano', 'connect');

async function rootFor(t: TestContext, prefix = 'ano-connect-surface-'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  return root;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** Non-Node, non-Git pm-mcp fixture: no package.json, no .git, no node_modules. */
async function makePmFixture(root: string): Promise<void> {
  const pm = join(root, '.pm');
  await mkdir(join(pm, 'decisions'), { recursive: true });
  await writeJson(join(pm, 'project.json'), { name: 'Surface Fixture', exposure: 'local' });
  await writeJson(join(pm, 'tasks.json'), {
    seq: 1,
    tasks: [
      { id: 'T-1', title: 'First task', status: 'done', type: 'feature', milestone: 'M1', priority: 'P0', detail: 'unique-needle-first' },
      { id: 'T-2', title: 'Second task', status: 'in_progress', type: 'fix', milestone: 'M2', priority: 'P1', detail: 'banana' },
    ],
  });
  await writeJson(join(pm, 'roadmap.json'), { seq: 1, milestones: [{ id: 'M1', title: 'Milestone one', status: 'done', order: 1 }] });
  await writeJson(join(pm, 'features.json'), { seq: 1, features: [{ id: 'F-1', name: 'Feature one', status: 'implemented', entry_files: ['src/a.ts'] }] });
  await writeJson(join(pm, 'sessions.json'), { seq: 1, sessions: [{ id: 'S-1', date: '2026-01-01T00:00:00.000Z', author: 'test', summary: 'session summary' }] });
  await writeFile(join(pm, 'decisions', 'ADR-1.md'), '# ADR one\n\nDecision body with needle-decision.\n', 'utf8');
}

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string, rel: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const full = join(current, entry.name);
      const next = rel.length > 0 ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(full, next);
      else if (entry.isFile()) out.push(next);
    }
  }
  await walk(dir, '');
  return out.sort();
}

async function sourceSignature(root: string): Promise<{ hash: string; files: string[] }> {
  const files = await listFiles(root);
  const hash = createHash('sha256');
  for (const file of files) {
    const full = join(root, file);
    hash.update(file);
    hash.update('\0');
    hash.update(String((await stat(full)).mtimeMs));
    hash.update('\0');
  }
  return { hash: hash.digest('hex'), files };
}

async function gitProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ano connect surface git '));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  await writeFile(join(root, 'src', 'alpha.ts'), 'export const alpha = 1;\n');
  for (const args of [['init', '-q'], ['config', 'user.email', 'ano@localhost'], ['config', 'user.name', 'ano'], ['add', '.'], ['commit', '-qm', 'base']]) {
    const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  return root;
}

async function connectMcp(root?: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpPath],
    ...(root ? { env: { ...process.env, ANO_ROOT: root } } : {}),
    stderr: 'pipe',
  });
  const client = new Client({ name: 'ano-connect-surface-test', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

function parse(result: unknown): Record<string, any> {
  const content = (result as { content: { text: string }[] }).content;
  return JSON.parse(content[0]!.text) as Record<string, any>;
}
function text(result: unknown): string { return JSON.stringify(result); }

test('CLI connect plan is zero-write on a non-Node, non-Git root', async (t) => {
  const root = await rootFor(t);
  await makePmFixture(root);
  assert.equal(existsSync(join(root, 'package.json')), false);
  assert.equal(existsSync(join(root, '.git')), false);
  const before = await sourceSignature(root);

  const plan = await runCli(['connect', 'plan', '--root', root]);

  assert.equal(plan.code, 0, plan.output);
  const json = JSON.parse(plan.output) as Record<string, any>;
  assert.equal(json.schema, 'ano.connect/1');
  assert.equal(json.canConnect, true);
  assert.equal(json.counts.tasks, 2);
  assert.equal(existsSync(join(root, '.ano')), false, 'plan must not create .ano');
  assert.deepEqual(await sourceSignature(root), before, 'plan must not touch the source tree');
});

test('CLI connect with no subcommand returns a top-level ConnectionResult plus plan', async (t) => {
  const root = await rootFor(t);
  await makePmFixture(root);

  const result = await runCli(['connect', '--root', root]);

  assert.equal(result.code, 0, result.output);
  const json = JSON.parse(result.output) as Record<string, any>;
  assert.equal(json.schema, 'ano.connect/1');
  assert.equal(json.report.connected, true);
  assert.equal(json.report.version, 1);
  assert.equal(json.duplicate, false);
  assert.equal(json.sourceUnchanged, true);
  assert.ok(json.plan);
  assert.equal(json.plan.connectionId, json.connectionId);
  assert.equal(existsSync(join(root, CONNECT_DIR, 'current.json')), true);
});

test('CLI connect resume is idempotent and status/export/handoff answer honestly', async (t) => {
  const root = await rootFor(t);
  await makePmFixture(root);
  assert.equal((await runCli(['connect', '--root', root])).code, 0);
  const storeBefore = await listFiles(join(root, CONNECT_DIR));

  const resumed = await runCli(['connect', 'resume', '--root', root]);
  assert.equal(resumed.code, 0, resumed.output);
  const resumeJson = JSON.parse(resumed.output) as Record<string, any>;
  assert.equal(resumeJson.duplicate, true);
  assert.equal(resumeJson.report.version, 1);
  assert.deepEqual(await listFiles(join(root, CONNECT_DIR)), storeBefore, 'resume must not add store files');

  const status = await runCli(['connect', 'status', '--root', root]);
  assert.equal(status.code, 0, status.output);
  const statusJson = JSON.parse(status.output) as Record<string, any>;
  assert.equal(statusJson.connected, true);
  assert.equal(statusJson.tasks.length, 2);
  const done = statusJson.tasks.find((task: any) => task.sourceId === 'T-1');
  assert.equal(done.status, 'done');
  assert.equal(done.category, 'completed');
  assert.equal(done.verification, 'unverified');

  const exported = await runCli(['connect', 'export', '--root', root]);
  assert.equal(exported.code, 0, exported.output);
  const exportJson = JSON.parse(exported.output) as Record<string, any>;
  assert.equal(exportJson.schema, 'ano.connect-export/1');
  assert.ok(exportJson.versions[0].files.some((file: any) => file.path === 'tasks.json'));

  const before = await sourceSignature(root);
  const handoff = await runCli(['connect', 'handoff', '--root', root]);
  assert.equal(handoff.code, 1, 'ready=false must be non-zero');
  const handoffJson = JSON.parse(handoff.output) as Record<string, any>;
  assert.equal(handoffJson.ready, false);
  assert.ok(handoffJson.blockers.length > 0);
  assert.deepEqual(await sourceSignature(root), before, 'handoff must not mutate project state');
});

test('CLI expected-digest mismatch is non-zero and writes nothing', async (t) => {
  const root = await rootFor(t);
  await makePmFixture(root);
  const plan = JSON.parse((await runCli(['connect', 'plan', '--root', root])).output) as Record<string, any>;

  const refused = await runCli(['connect', '--root', root, '--expected-digest', '0'.repeat(64)]);
  assert.equal(refused.code, 1);
  const refusedJson = JSON.parse(refused.output) as Record<string, any>;
  assert.equal(refusedJson.report.connected, false);
  assert.equal(refusedJson.sourceUnchanged, false);
  assert.equal(existsSync(join(root, CONNECT_DIR, 'current.json')), false);

  const accepted = await runCli(['connect', '--root', root, '--expected-digest', plan.sourceDigest]);
  assert.equal(accepted.code, 0, accepted.output);
  assert.equal((JSON.parse(accepted.output) as Record<string, any>).report.connected, true);
});

test('CLI recall --source connected --query returns sourced hits and honours limit', async (t) => {
  const root = await rootFor(t);
  await makePmFixture(root);
  assert.equal((await runCli(['connect', '--root', root])).code, 0);

  const recalled = await runCli(['recall', '--root', root, '--source', 'connected', '--query', 'unique-needle-first', '--limit', '1']);
  assert.equal(recalled.code, 0, recalled.output);
  const json = JSON.parse(recalled.output) as Record<string, any>;
  assert.equal(json.untrusted, true);
  assert.ok(json.results.length >= 1);
  for (const hit of json.results as Array<Record<string, any>>) {
    assert.equal(typeof hit.sourcePath, 'string');
    assert.ok(hit.sourcePath.length > 0);
    assert.equal(typeof hit.snapshotDigest, 'string');
    assert.equal(typeof hit.version, 'number');
  }

  const limited = await runCli(['recall', '--root', root, '--source', 'connected', '--query', 'task', '--limit', '1']);
  const limitedJson = JSON.parse(limited.output) as Record<string, any>;
  assert.equal(limitedJson.limit, 1);
  assert.equal(limitedJson.results.length, 1);

  const legacyLimit = await runCli(['recall', '--root', root, '--keyword', 'x', '--limit', '1']);
  assert.equal(legacyLimit.code, 2);
  assert.match(legacyLimit.output, /--source connected/);
});

test('MCP keeps exactly seven tools and rejects unknown connection operations', async () => {
  const client = await connectMcp();
  try {
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name), ['brief', 'explore', 'recall', 'track', 'note', 'verify', 'audit']);
    const track = listed.tools.find((tool) => tool.name === 'track');
    const schema = track?.inputSchema as { properties?: Record<string, unknown> };
    assert.ok(schema.properties, 'track must keep a top-level object schema');
    assert.ok('payload' in schema.properties!);

    const trackSchema = toolCatalog.find((tool) => tool.name === 'track')!.input;
    assert.equal(trackSchema.safeParse({ idem_key: 'k', kind: 'connection', operation: 'plan', payload: {} }).success, true);
    assert.equal(trackSchema.safeParse({ idem_key: 'k', kind: 'connection', operation: 'connect', payload: { expected_digest: 'a'.repeat(64) } }).success, true);
    assert.equal(trackSchema.safeParse({ idem_key: 'k', kind: 'connection', operation: 'create', payload: {} }).success, false);
    assert.equal(trackSchema.safeParse({ idem_key: 'k', kind: 'connection', operation: 'plan', payload: { unexpected: 1 } }).success, false);
    assert.equal(trackSchema.safeParse({ idem_key: 'k', kind: 'connection', operation: 'plan', payload: { expected_digest: 7 } }).success, false);
    assert.equal(trackSchema.safeParse({ idem_key: 'k', kind: 'task', operation: 'create', payload: { expected_digest: 'a' } }).success, false);
    assert.equal(trackSchema.safeParse({ idem_key: 'k', kind: 'task', operation: 'create', payload: {} }).success, true, 'old task/create input stays valid');

    const recallSchema = toolCatalog.find((tool) => tool.name === 'recall')!.input;
    assert.equal(recallSchema.safeParse({ keyword: '账本' }).success, true, 'old recall filters stay valid');
    assert.equal(recallSchema.safeParse({ keyword: '账本', script: 'process.exit(0)' }).success, false);
    assert.equal(recallSchema.safeParse({ source: 'connected', query: 'x', limit: 5 }).success, true);
    assert.equal(recallSchema.safeParse({ source: 'connected', query: 'x', limit: 101 }).success, false);
  } finally {
    await client.close();
  }
});

test('MCP track connection plan/connect/status/export/handoff work without Node or Git', async (t) => {
  const root = await rootFor(t);
  await makePmFixture(root);
  const client = await connectMcp();
  try {
    const plan = await client.callTool({ name: 'track', arguments: { root, idem_key: 'c-plan', kind: 'connection', operation: 'plan', payload: {} } });
    assert.equal(plan.isError, undefined, text(plan));
    assert.equal(parse(plan).canConnect, true);
    assert.equal(existsSync(join(root, '.ano')), false, 'plan must be zero-write');

    const connected = await client.callTool({ name: 'track', arguments: { root, idem_key: 'c-connect', kind: 'connection', operation: 'connect', payload: {} } });
    assert.equal(connected.isError, undefined, text(connected));
    assert.equal(parse(connected).report.connected, true);

    const status = await client.callTool({ name: 'track', arguments: { root, idem_key: 'c-status', kind: 'connection', operation: 'status', payload: {} } });
    assert.equal(status.isError, undefined, text(status));
    assert.equal(parse(status).connected, true);

    const exported = await client.callTool({ name: 'track', arguments: { root, idem_key: 'c-export', kind: 'connection', operation: 'export', payload: {} } });
    assert.equal(exported.isError, undefined, text(exported));
    assert.equal(parse(exported).schema, 'ano.connect-export/1');

    const handoff = await client.callTool({ name: 'track', arguments: { root, idem_key: 'c-handoff', kind: 'connection', operation: 'handoff', payload: {} } });
    assert.equal(handoff.isError, undefined, text(handoff));
    assert.equal(parse(handoff).ready, false);

    const refused = await client.callTool({ name: 'track', arguments: { root, idem_key: 'c-bad', kind: 'connection', operation: 'connect', payload: { expected_digest: '0'.repeat(64) } } });
    assert.equal(refused.isError, true, 'expectedDigest mismatch must not report success');
    assert.match(text(refused), /did not complete|source-changed/i);
  } finally {
    await client.close();
  }
});

test('MCP brief separates native and imported state and recall carries provenance', async (t) => {
  const git = await gitProject();
  const client = await connectMcp();
  try {
    const tracked = await runCli(['track', 'create', '--id', 'T-NATIVE', '--title', 'native', '--file', 'src/alpha.ts', '--root', git]);
    assert.equal(tracked.code, 0, tracked.output);
    const nativeBrief = await client.callTool({ name: 'brief', arguments: { root: git } });
    assert.equal(nativeBrief.isError, undefined, text(nativeBrief));
    const nativeJson = parse(nativeBrief);
    assert.equal(nativeJson.phase, 'P7');
    assert.ok(nativeJson.graph);
    assert.equal(nativeJson.connected.connected, false);
    assert.equal(nativeJson.connected.tasks.native, 1);
    assert.equal(nativeJson.connected.tasks.imported, 0);

    const oldRecall = await client.callTool({ name: 'recall', arguments: { root: git, keyword: 'anything' } });
    assert.equal(oldRecall.isError, undefined, text(oldRecall));
    assert.equal(parse(oldRecall).status, 'not_configured');
  } finally {
    await client.close();
    await rm(git, { recursive: true, force: true });
  }

  const imported = await rootFor(t);
  await makePmFixture(imported);
  const connected = await connectMcp();
  try {
    const connectResult = await connected.callTool({ name: 'track', arguments: { root: imported, idem_key: 'b-connect', kind: 'connection', operation: 'connect', payload: {} } });
    assert.equal(connectResult.isError, undefined, text(connectResult));

    const brief = await connected.callTool({ name: 'brief', arguments: { root: imported } });
    assert.equal(brief.isError, undefined, text(brief));
    const briefJson = parse(brief);
    assert.equal(briefJson.connected.connected, true);
    assert.equal(briefJson.connected.tasks.native, 0);
    assert.equal(briefJson.connected.tasks.imported, 2);
    assert.equal(briefJson.connected.importedTasks.length, 2);
    assert.equal(existsSync(join(imported, '.ano', 'ledger')), false, 'brief must not create a native ledger');
    assert.equal(existsSync(join(imported, '.ano', 'cache', 'graph.db')), false, 'brief must not create a structure graph');

    const recalled = await connected.callTool({ name: 'recall', arguments: { root: imported, source: 'connected', query: 'unique-needle-first' } });
    assert.equal(recalled.isError, undefined, text(recalled));
    const recallJson = parse(recalled);
    assert.ok(recallJson.results.length >= 1);
    for (const hit of recallJson.results as Array<Record<string, any>>) {
      assert.equal(typeof hit.sourcePath, 'string');
      assert.equal(typeof hit.snapshotDigest, 'string');
    }
    assert.equal(recallJson.untrusted, true);
  } finally {
    await connected.close();
  }

  const empty = await rootFor(t);
  const lateClient = await connectMcp();
  try {
    const brief = await lateClient.callTool({ name: 'brief', arguments: { root: empty } });
    assert.equal(brief.isError, true, 'no connection must preserve the native root error');
    assert.match(text(brief), /No \.git found at or above|A Git work tree is required/i);
    assert.equal(existsSync(join(empty, '.ano')), false);
  } finally {
    await lateClient.close();
  }
});
