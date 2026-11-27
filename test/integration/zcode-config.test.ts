import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { defaultUserConfigPath, resolveAnoRegistrations, validateAnoStdioServer } from '../../scripts/zcode-mcp-config.ts';

interface StdioServerConfig {
  type: 'stdio';
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  enabled?: boolean;
  timeoutMs?: number;
}

interface WorkspaceConfig {
  mcp?: { servers?: Record<string, StdioServerConfig> };
}

interface IntegrationEvidence {
  schema?: string;
  configSha256?: string;
  workspaceAnoDeclared?: boolean;
  registrationScope?: 'workspace' | 'user';
  anoRegistrationCount?: number;
  effectiveConfigPath?: string;
  effectiveServerSha256?: string;
  initialized?: boolean;
  tools?: string[];
  briefPhase?: string;
  clientRestartRequired?: boolean;
}

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const expectedTools = ['brief', 'explore', 'recall', 'track', 'note', 'verify', 'audit'];
const distEntry = join(projectRoot, 'dist', 'surface', 'mcp.js');
const sourceEntry = join(projectRoot, 'src', 'surface', 'mcp.ts');
// Prefer the real build artifact; fall back to the source entry (Node strips
// types on the same supported versions the rest of the suite uses).
const mcpEntry = existsSync(distEntry) ? distEntry : sourceEntry;

async function writeGitProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ano zcode workspace '));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  await writeFile(join(root, 'src', 'alpha.ts'), 'export const alpha = 1;\n');
  for (const args of [['init', '-q'], ['config', 'user.email', 'ano@localhost'], ['config', 'user.name', 'ano'], ['add', '.'], ['commit', '-qm', 'base']]) {
    const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  return root;
}

function textPayload(result: unknown): string {
  const content = (result as { content?: unknown }).content as { type: string; text?: string }[] | undefined;
  const text = content?.find((item) => item.type === 'text')?.text;
  assert.ok(text, 'tool result must contain a text payload');
  return text;
}

test('workspace .zcode/config.json leaves ano to the single user-scope registration', async () => {
  const configPath = join(projectRoot, '.zcode', 'config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8')) as WorkspaceConfig;
  const servers = config.mcp?.servers;
  assert.ok(servers && typeof servers === 'object' && !Array.isArray(servers), '.zcode/config.json must contain an mcp.servers object');
  assert.equal(Object.hasOwn(servers, 'ano'), false, 'the workspace must not duplicate the user-scope ano registration (D-0019)');

  const state = await resolveAnoRegistrations(configPath, defaultUserConfigPath());
  assert.equal(state.duplicate, false, 'ano must never be declared in both user and workspace scope');
  assert.equal(state.workspaceAnoDeclared, false);
  if (state.effective !== null) {
    assert.equal(state.effective.scope, 'user', 'the effective registration must come from user scope');
    assert.equal(state.registrations.length, 1, 'exactly one ano registration may be effective');
  }
});

test('registration resolver reports one effective server and rejects duplicate scopes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ano zcode resolver '));
  const workspacePath = join(root, 'workspace-config.json');
  const userPath = join(root, 'user-config.json');
  const server = { type: 'stdio', command: process.execPath, args: [mcpEntry], enabled: true, timeoutMs: 60_000 } as const;
  try {
    await writeFile(workspacePath, `${JSON.stringify({ mcp: { servers: {} } })}\n`);
    await writeFile(userPath, `${JSON.stringify({ mcp: { servers: { ano: server } } })}\n`);

    const inherited = await resolveAnoRegistrations(workspacePath, userPath);
    assert.equal(inherited.duplicate, false);
    assert.equal(inherited.workspaceAnoDeclared, false);
    assert.equal(inherited.registrations.length, 1);
    assert.equal(inherited.effective?.scope, 'user');
    assert.match(inherited.effective?.serverSha256 ?? '', /^[a-f0-9]{64}$/u);

    await writeFile(workspacePath, `${JSON.stringify({ mcp: { servers: { ano: { ...server, timeoutMs: 30_000 } } } })}\n`);
    const duplicate = await resolveAnoRegistrations(workspacePath, userPath);
    assert.equal(duplicate.duplicate, true, 'both scopes declaring ano must be reported as a duplicate');
    assert.equal(duplicate.registrations.length, 2);
    assert.equal(duplicate.effective?.scope, 'workspace', 'a workspace declaration stays visible so verification can fail closed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ano launch validation rejects relative paths and missing entry arguments', () => {
  const problems = validateAnoStdioServer(
    { type: 'stdio', command: 'node', args: ['dist/surface/mcp.js'], timeoutMs: 10 },
    'fixture ano server',
  );
  assert.ok(problems.some((problem) => problem.includes('command must be an absolute path')), problems.join('\n'));
  assert.ok(problems.some((problem) => problem.includes('args[0] must be an absolute path')), problems.join('\n'));
  assert.ok(problems.some((problem) => problem.includes('timeoutMs must be an integer >= 1000')), problems.join('\n'));
  assert.deepEqual(
    validateAnoStdioServer({ type: 'stdio', command: process.execPath, args: [mcpEntry], timeoutMs: 60_000 }, 'fixture ano server'),
    [],
  );
});

test('a workspace config in a temp directory starts the real MCP server with exactly seven tools', async () => {
  const workspace = await writeGitProject();
  const configDir = join(workspace, '.zcode');
  const configPath = join(configDir, 'config.json');
  const transportOptions: StdioServerConfig = {
    type: 'stdio',
    command: process.execPath,
    args: [mcpEntry],
    cwd: workspace,
    env: { ANO_ROOT: workspace },
    enabled: true,
    timeoutMs: 60_000,
  };
  const client = new Client({ name: 'ano-zcode-config-test', version: '1.0.0' });
  try {
    await mkdir(configDir, { recursive: true });
    await writeFile(configPath, `${JSON.stringify({ mcp: { servers: { ano: transportOptions } } }, null, 2)}\n`);

    // Read the config back from disk: the client process must run from file
    // contents, never from the in-memory literal above.
    const written = JSON.parse(await readFile(configPath, 'utf8')) as WorkspaceConfig;
    const server = written.mcp?.servers?.ano;
    assert.ok(server, 'temp workspace config must contain mcp.servers.ano');
    assert.equal(server.type, 'stdio');
    const configuredEntry = server.args?.[0];
    assert.ok(configuredEntry && existsSync(configuredEntry), `configured MCP entry must exist on disk: ${String(configuredEntry)}`);

    const transport = new StdioClientTransport({
      command: server.command,
      args: server.args ?? [],
      ...(server.cwd ? { cwd: server.cwd } : {}),
      ...(server.env ? { env: server.env } : {}),
      stderr: 'pipe',
    });
    let stderr = '';
    transport.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    try {
      await client.connect(transport, { timeout: server.timeoutMs ?? 30_000 });
      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name);
      assert.equal(listed.tools.length, 7, `expected exactly 7 tools, got ${listed.tools.length}: ${names.join(', ')}`);
      assert.deepEqual(names, expectedTools, 'the tool surface must be exactly the seven intent tools');
      assert.equal(new Set(names).size, 7, 'tool names must be unique');
      for (const tool of listed.tools) {
        assert.equal((tool.inputSchema as { type?: string }).type, 'object', `${tool.name} must publish an object input schema`);
      }

      // No root argument: the server must use the ANO_ROOT/cwd from the config
      // file and report the temp project, not this repository.
      const brief = await client.callTool({ name: 'brief', arguments: {} });
      assert.notEqual(brief.isError, true, `brief over the configured server failed: ${stderr}`);
      const payload = JSON.parse(textPayload(brief)) as { phase?: string; tools?: string[]; tasks?: unknown[] };
      assert.equal(payload.phase, 'P7');
      assert.deepEqual(payload.tools, expectedTools);
      assert.deepEqual(payload.tasks, [], 'brief must read the temp workspace, not the ANO repository ledger');
    } catch (error) {
      throw new Error(`stdio MCP from temp workspace config failed: ${error instanceof Error ? error.message : String(error)}${stderr ? `\nserver stderr:\n${stderr.trim()}` : ''}`);
    }
  } finally {
    await client.close().catch(() => {});
    await rm(workspace, { recursive: true, force: true });
  }
});

test('committed ZCode evidence matches the current effective registration (no stale or fabricated proof)', async () => {
  const configPath = join(projectRoot, '.zcode', 'config.json');
  const configBytes = await readFile(configPath);
  const currentSha = createHash('sha256').update(configBytes).digest('hex');
  const evidence = JSON.parse(await readFile(join(projectRoot, 'docs', 'evidence', 'zcode-mcp.json'), 'utf8')) as IntegrationEvidence;

  assert.equal(evidence.schema, 'ano.zcode-integration.v1');
  assert.equal(evidence.initialized, true);
  assert.equal(evidence.briefPhase, 'P7');
  assert.equal(evidence.clientRestartRequired, true);
  assert.deepEqual(evidence.tools, expectedTools, 'real-connection evidence must record exactly the seven tools');
  assert.equal(evidence.configSha256, currentSha, 'docs/evidence/zcode-mcp.json is stale; re-run node scripts/verify-zcode-mcp.ts');
  assert.equal(evidence.workspaceAnoDeclared, false, 'evidence must record that the workspace does not duplicate user-scope ano');
  assert.equal(evidence.anoRegistrationCount, 1, 'real-connection evidence must record exactly one ano registration');

  // When this host still has the registration, the evidence must match it.
  // A machine without a user-scope registration (for example CI) can only
  // check the recorded shape, never invent a different source.
  const live = await resolveAnoRegistrations(configPath, defaultUserConfigPath());
  assert.equal(live.duplicate, false, 'the repository must not declare ano in both scopes');
  if (live.effective !== null) {
    assert.equal(evidence.registrationScope, live.effective.scope, 'evidence scope does not match the live effective registration');
    assert.equal(evidence.effectiveServerSha256, live.effective.serverSha256, 'docs/evidence/zcode-mcp.json is stale; re-run node scripts/verify-zcode-mcp.ts');
    // The public snapshot redacts the absolute home path; do not compare it
    // against a host-specific live registration path.
  } else if (evidence.effectiveConfigPath && existsSync(evidence.effectiveConfigPath)) {
    assert.fail('docs/evidence/zcode-mcp.json is stale; the recorded effective config exists but no ano registration is resolvable');
  } else {
    assert.ok(evidence.effectiveConfigPath, 'evidence must name the config that supplied the effective registration');
    assert.match(evidence.effectiveServerSha256 ?? '', /^[a-f0-9]{64}$/u, 'evidence must record a server fingerprint');
  }
});
