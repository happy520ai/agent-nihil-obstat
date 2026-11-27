import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const npmCommand = process.execPath;
const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');

const output = fileURLToPath(new URL('../docs/evidence/package-smoke.json', import.meta.url));
const result: Record<string, unknown> = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  npm: spawnSync(npmCommand, [npmCli, '--version'], { encoding: 'utf8' }).stdout?.trim(),
};
try {
  const packDir = await mkdtemp(join(tmpdir(), 'ano-pack-'));
  const pack = spawnSync(npmCommand, [npmCli, 'pack', '--pack-destination', packDir], { shell: false, encoding: 'utf8' });
  assert.equal(pack.status, 0, pack.stderr);
  const tarball = join(packDir, pack.stdout.trim().split(/\r?\n/).at(-1)!);
  const tarballBytes = await readFile(tarball);
  result.tarball = {
    name: basename(tarball),
    bytes: tarballBytes.length,
    sha256: createHash('sha256').update(tarballBytes).digest('hex'),
  };
  const install = await mkdtemp(join(tmpdir(), 'ano-install-'));
  await writeFile(join(install, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  const installed = spawnSync(npmCommand, [npmCli, 'install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], { cwd: install, shell: false, encoding: 'utf8' });
  assert.equal(installed.status, 0, installed.stderr);
  const packageDir = join(install, 'node_modules', 'agent-nihil-obstat');
  const cli = join(packageDir, 'dist', 'surface', 'cli.js');
  const mcp = join(packageDir, 'dist', 'surface', 'mcp.js');
  const version = spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8' });
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), '0.1.0-alpha.0');
  result.cliVersion = version.stdout.trim();
  const installedManifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8')) as { version: string };
  result.packedVersion = installedManifest.version;
  result.installedDist = {
    cliSha256: createHash('sha256').update(await readFile(cli)).digest('hex'),
    mcpSha256: createHash('sha256').update(await readFile(mcp)).digest('hex'),
  };
  const binVersion = spawnSync(process.execPath, [join(install, 'node_modules', 'agent-nihil-obstat', 'dist', 'surface', 'cli.js'), '--help'], { encoding: 'utf8' });
  assert.equal(binVersion.status, 0, binVersion.stderr);
  result.binRuns = binVersion.stdout.includes('P1 vertical slice');

  const root = await mkdtemp(join(tmpdir(), 'ano package fixture '));
  await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'test'), { recursive: true });
  await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  await writeFile(join(root, 'test', 'a.test.ts'), "import assert from 'node:assert/strict';import test from 'node:test';import { a } from '../src/a.ts';test('a',()=>assert.equal(a,1));\n");
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'smoke@localhost'], ['config', 'user.name', 'ANO Smoke'], ['config', 'core.autocrlf', 'false'], ['add', '.'], ['commit', '-qm', 'baseline']]) {
    const git = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    assert.equal(git.status, 0, git.stderr);
  }
  await writeFile(join(root, 'src', 'a.ts'), 'export const a = 2;\n');
  await writeFile(join(root, 'test', 'a.test.ts'), "import assert from 'node:assert/strict';import test from 'node:test';import { a } from '../src/a.ts';test('a',()=>assert.equal(a,2));\n");
  const created = spawnSync(process.execPath, [cli, 'track', 'create', '--id', 'PACKAGE-T1', '--file', 'src/a.ts', '--file', 'test/a.test.ts', '--root', root], { encoding: 'utf8' });
  assert.equal(created.status, 0, created.stderr);
  const verified = spawnSync(process.execPath, [cli, 'verify', 'PACKAGE-T1', '--test', 'test/a.test.ts', '--root', root, '--', process.execPath, '--test', 'test/a.test.ts'], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(verified.status, 0, verified.stderr);
  const verdict = JSON.parse(verified.stdout).verdict;
  assert.equal(verdict.status, 'done', JSON.stringify(verdict));
  result.cliTaskVerdict = verdict;

  // Connect must also work from the installed tarball for a non-Node, non-Git project.
  const connectRoot = await mkdtemp(join(tmpdir(), 'ano connected package fixture '));
  await mkdir(join(connectRoot, '.pm'));
  await writeFile(join(connectRoot, '.pm', 'project.json'), JSON.stringify({ name: 'Package Connect Fixture' }));
  const sourceTasks = JSON.stringify({ tasks: [{ id: 'PM-1', title: '历史已完成', status: 'done', custom: { keep: true } }] });
  await writeFile(join(connectRoot, '.pm', 'tasks.json'), sourceTasks);
  await writeFile(join(connectRoot, '.pm', 'sessions.json'), JSON.stringify({ sessions: [{ id: 'S-1', summary: '连接历史下一步' }] }));
  await readFile(join(packageDir, 'docs', 'connect.md'), 'utf8');
  const connectCli = (args: string[]) => spawnSync(process.execPath, [cli, 'connect', ...args, '--root', connectRoot], { encoding: 'utf8' });
  const planned = connectCli(['plan']);
  assert.equal(planned.status, 0, planned.stderr);
  assert.equal(existsSync(join(connectRoot, '.ano')), false, 'packaged plan must be zero-write');
  const connected = connectCli([]);
  assert.equal(connected.status, 0, connected.stderr);
  const connectResult = JSON.parse(connected.stdout);
  assert.equal(connectResult.report.connected, true);
  const resumed = connectCli(['resume']);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).duplicate, true);
  const connection = connectCli(['status']);
  assert.equal(connection.status, 0, connection.stderr);
  const connectedStatus = JSON.parse(connection.stdout);
  assert.equal(connectedStatus.tasks[0].status, 'done');
  assert.equal(connectedStatus.tasks[0].category, 'completed');
  assert.equal(connectedStatus.tasks[0].verification, 'unverified');
  const exported = connectCli(['export']);
  assert.equal(exported.status, 0, exported.stderr);
  const bundle = JSON.parse(exported.stdout);
  const archivedTasks = bundle.versions[0].files.find((file: { path: string }) => file.path === 'tasks.json');
  assert.equal(Buffer.from(archivedTasks.base64, 'base64').toString('utf8'), sourceTasks);
  assert.equal(await readFile(join(connectRoot, '.pm', 'tasks.json'), 'utf8'), sourceTasks);
  const handoff = connectCli(['handoff']);
  assert.notEqual(handoff.status, 0);
  const handoffJson = handoff.stderr.slice(handoff.stderr.indexOf('{'), handoff.stderr.lastIndexOf('}') + 1);
  assert.equal(JSON.parse(handoffJson).ready, false);
  result.connect = { connected: true, duplicate: true, sourceUnchanged: true, verification: connectedStatus.tasks[0].verification, versions: bundle.versions.length, handoffReady: false, noNodeOrGitRequired: true };

  const transport = new StdioClientTransport({ command: process.execPath, args: [mcp], env: { ...process.env, ANO_ROOT: root }, stderr: 'pipe' });
  const client = new Client({ name: 'package-smoke', version: '1.0.0' });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.equal(listed.tools.length, 7);
    const brief = await client.callTool({ name: 'brief', arguments: {} });
    assert.equal(brief.isError, undefined, JSON.stringify(brief));
    const exploration = await client.callTool({ name: 'explore', arguments: { query: 'a' } });
    assert.equal(exploration.isError, undefined, JSON.stringify(exploration));
    const connectedBrief = await client.callTool({ name: 'brief', arguments: { root: connectRoot } });
    assert.equal(connectedBrief.isError, undefined, JSON.stringify(connectedBrief));
    const connectionCheck = await client.callTool({ name: 'track', arguments: { root: connectRoot, kind: 'connection', operation: 'status', payload: {}, idem_key: 'package:connect:status' } });
    assert.equal(connectionCheck.isError, undefined, JSON.stringify(connectionCheck));
    const connectedRecall = await client.callTool({ name: 'recall', arguments: { root: connectRoot, source: 'connected', query: '下一步' } });
    assert.equal(connectedRecall.isError, undefined, JSON.stringify(connectedRecall));
    result.mcp = { tools: listed.tools.map((tool) => tool.name), brief: brief.content, explore: exploration.content, connectStatus: connectionCheck.content, connectedRecall: connectedRecall.content };
  } finally { await client.close(); }
  result.verdict = 'passed';
} catch (error) {
  result.verdict = 'failed';
  result.error = error instanceof Error ? error.stack : String(error);
  process.exitCode = 1;
}
await writeFile(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
