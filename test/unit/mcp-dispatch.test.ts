import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../src/surface/mcp.ts';

async function temp(prefix: string): Promise<string> { return mkdtemp(join(tmpdir(), prefix)); }

async function write(root: string, path: string, source: string): Promise<void> {
  const target = join(root, ...path.split('/'));
  await mkdir(join(target, '..'), { recursive: true });
  await writeFile(target, source);
}

function git(root: string, args: string[]): void {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
}

async function gitProject(): Promise<string> {
  const root = await temp('ano mcp dispatch ');
  await write(root, 'package.json', JSON.stringify({ private: true, type: 'module' }));
  await write(root, 'src/a.ts', 'export function alpha() { return 1; }\n');
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'ano@localhost'], ['config', 'user.name', 'ano'], ['add', '.'], ['commit', '-qm', 'base']]) git(root, args);
  return root;
}

function payload(result: unknown): Record<string, unknown> {
  const content = (result as { content?: Array<{ text?: string }> }).content;
  return JSON.parse(content?.[0]?.text ?? '{}') as Record<string, unknown>;
}

test('in-process MCP dispatch covers root overrides, budget, track/verify/audit and errors', async () => {
  const root = await gitProject();
  const server = createMcpServer(root);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'ano-unit', version: '1.0.0' });
  await client.connect(clientTransport);
  try {
    const brief = await client.callTool({ name: 'brief', arguments: {} });
    assert.equal(payload(brief).phase, 'P7', 'no root argument falls back to the server root');

    const explicitRoot = await client.callTool({ name: 'brief', arguments: { root } });
    assert.equal(payload(explicitRoot).phase, 'P7');

    const explored = await client.callTool({ name: 'explore', arguments: { root, query: 'alpha', budget: 1 } });
    const explorePayload = payload(explored);
    assert.equal(typeof explorePayload.total, 'number');
    assert.equal(typeof explorePayload.truncated, 'boolean');
    assert.equal(explorePayload.query, 'alpha');

    const tracked = await client.callTool({
      name: 'track',
      arguments: { root, idem_key: 'mcp:track:1', kind: 'task', operation: 'create', payload: { id: 'T-MCP', files: ['src/a.ts'] } },
    });
    const trackPayload = payload(tracked);
    assert.equal((trackPayload.task as { id: string }).id, 'T-MCP');

    const unimplemented = await client.callTool({
      name: 'track',
      arguments: { root, idem_key: 'mcp:track:2', kind: 'milestone', operation: 'create', payload: {} },
    });
    assert.equal(unimplemented.isError, true);

    const verify = await client.callTool({
      name: 'verify',
      arguments: {
        root, idem_key: 'mcp:verify:1', scope: 'task', task_id: 'T-UNKNOWN',
        argv: [process.execPath, '--test', 'test/a.test.ts'], test_files: ['test/a.test.ts'],
      },
    });
    assert.equal(verify.isError, true, 'verification of an unknown task is an honest error');
    assert.match(JSON.stringify(verify), /Unknown task/);

    const audited = await client.callTool({ name: 'audit', arguments: { root, idem_key: 'mcp:audit:1', scope: 'drift' } });
    const auditPayload = payload(audited);
    assert.equal(auditPayload.scope, 'drift');

    const note = await client.callTool({
      name: 'note',
      arguments: { root, idem_key: 'mcp:note:1', kind: 'memory', text: 'x', anchor: { file: 'src/a.ts' } },
    });
    assert.equal(note.isError, undefined, JSON.stringify(note));
    assert.equal(payload(note).status, 'recorded');

    const recalled = await client.callTool({ name: 'recall', arguments: { root } });
    assert.equal(payload(recalled).status, 'not_configured');

    const foreign = await gitProject();
    try {
      const other = await client.callTool({ name: 'brief', arguments: { root: foreign } });
      assert.equal(other.isError, undefined, 'user-scope MCP serves an explicitly selected project');
      assert.deepEqual(payload(other).tasks, [], 'the other project has its own empty ledger');
    } finally { await rm(foreign, { recursive: true, force: true }); }

    const invalid = await client.callTool({ name: 'explore', arguments: { root } });
    assert.equal(invalid.isError, true);
  } finally {
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('in-process MCP dispatch covers brief context, recall probe, note revise/relate and context verify', async () => {
  const root = await gitProject();
  const server = createMcpServer(root);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'ano-unit', version: '1.0.0' });
  await client.connect(clientTransport);
  try {
    const first = await client.callTool({
      name: 'note',
      arguments: {
        root, idem_key: 'dispatch:revise:1', operation: 'revise', kind: 'memory',
        text: 'storage is sqlite', fact_key: 'local.storage.engine', supersedes: [],
        reason: 'genesis', effective_from: null, effective_to: null,
      },
    });
    assert.equal(first.isError, undefined, JSON.stringify(first));
    assert.equal(payload(first).status, 'recorded');
    const firstEvent = String(payload(first).eventId);

    const second = await client.callTool({
      name: 'note',
      arguments: {
        root, idem_key: 'dispatch:revise:2', operation: 'revise', kind: 'memory',
        text: 'retention is 30 days', fact_key: 'local.storage.retention', supersedes: [],
        reason: 'genesis', effective_from: null, effective_to: null,
      },
    });
    assert.equal(second.isError, undefined, JSON.stringify(second));
    const secondEvent = String(payload(second).eventId);

    const related = await client.callTool({
      name: 'note',
      arguments: {
        root, idem_key: 'dispatch:relate:1', operation: 'relate', edge: 'depends_on',
        from_ref: firstEvent, to_ref: secondEvent,
      },
    });
    assert.equal(related.isError, undefined, JSON.stringify(related));
    assert.equal(payload(related).status, 'recorded');

    const briefed = await client.callTool({ name: 'brief', arguments: { root, include_memory_context: true } });
    assert.equal(briefed.isError, undefined, JSON.stringify(briefed));
    const memoryContext = payload(briefed).memory_context as { context_id: string; project_scope: string };
    assert.equal(typeof memoryContext.context_id, 'string');
    assert.equal(memoryContext.project_scope, 'local');

    const probed = await client.callTool({
      name: 'recall',
      arguments: { root, mode: 'probe', project_scope: 'local', requirements: ['local.storage.engine'] },
    });
    assert.equal(probed.isError, undefined, JSON.stringify(probed));
    assert.equal(typeof (payload(probed).response as { context_id: string }).context_id, 'string');
    assert.equal((payload(probed).response as { untrusted: boolean }).untrusted, true);

    const manifest = JSON.parse(await readFile(join(root, '.ano', 'memory', 'probes', `${memoryContext.context_id}.json`), 'utf8')) as {
      response: { active_evidence: Array<{ ref: string }> };
    };
    const ref = manifest.response.active_evidence[0]?.ref;
    assert.ok(ref, 'the frozen context must carry at least one evidence alias');

    const draft = {
      schema_version: 'anchorprobe.draft.v1',
      context_id: memoryContext.context_id,
      project_scope: 'local',
      claims: [{
        id: 'C1', kind: 'CURRENT_FACT', fact_key: 'local.storage.engine',
        text: 'SQLite is the storage engine.', evidence_refs: [ref], params: [],
      }],
      not_applicable: [],
      unresolved: [],
    };
    const verified = await client.callTool({
      name: 'verify',
      arguments: {
        root, idem_key: 'dispatch:verify:1', scope: 'context',
        context_id: memoryContext.context_id, project_scope: 'local', draft,
      },
    });
    assert.equal(verified.isError, undefined, JSON.stringify(verified));
    const report = payload(verified);
    assert.equal(report.status, 'NEEDS_REVIEW', 'v1 semantic support is unknown');
    assert.equal('evidence_id' in report, false, 'context verify never produces Gate evidence');
    assert.equal('verdict' in report, false);

    const forged = await client.callTool({
      name: 'verify',
      arguments: {
        root, idem_key: 'dispatch:verify:2', scope: 'context',
        context_id: memoryContext.context_id, project_scope: 'local',
        draft: { ...draft, claims: [{ ...draft.claims[0]!, evidence_refs: ['E999'] }] },
      },
    });
    assert.equal(forged.isError, undefined, JSON.stringify(forged));
    assert.equal(payload(forged).status, 'BLOCK');

    const mixedRecall = await client.callTool({
      name: 'recall',
      arguments: { root, mode: 'probe', project_scope: 'local', requirements: ['local.storage.engine'], keyword: 'x' },
    });
    assert.equal(mixedRecall.isError, true, 'legacy filters cannot be mixed with mode=probe');

    const mixedVerify = await client.callTool({
      name: 'verify',
      arguments: { root, idem_key: 'dispatch:verify:3', scope: 'context', context_id: 'ctx-1', project_scope: 'local', draft, task_id: 'T1' },
    });
    assert.equal(mixedVerify.isError, true, 'task fields cannot be mixed with scope=context');
  } finally {
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
