#!/usr/bin/env node
/**
 * Real tarball self-host check.
 *
 * Packs the repository, installs the tarball into an isolated temp project,
 * and exercises the installed CLI/MCP surface. The workspace MCP config is
 * launched exactly as a ZCode workspace would launch it, but ANO_ROOT and cwd
 * are redirected to the temp project so this script never writes into the
 * repository's `.ano` directory.
 *
 * note/recall are exercised through MCP and CLI. An explicit "not implemented"
 * response records `unimplemented` and downgrades the verdict; an actually
 * connected call must satisfy its response contract before it counts as passed.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolveAnoRegistrations, validateAnoStdioServer } from './zcode-mcp-config.ts';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const expectedTools = ['brief', 'explore', 'recall', 'track', 'note', 'verify', 'audit'] as const;

export type CheckStatus = 'passed' | 'failed' | 'unimplemented' | 'not-configured' | 'missing' | 'skipped';

export interface SelfHostCheck {
  readonly status: CheckStatus;
  readonly durationMs: number;
  readonly [key: string]: unknown;
}

export interface SelfHostReport {
  schema: 'ano.selfhost.v1';
  generatedAt: string;
  verdict: 'passed' | 'passed-with-limitations' | 'failed';
  source: {
    root: string;
    packageName: string;
    packageVersion: string;
    nodeRuntime: string;
    targetNode: string;
    targetNodeVersion: string | null;
    npmVersion: string | null;
  };
  checks: {
    build: SelfHostCheck;
    pack: SelfHostCheck;
    install: SelfHostCheck;
    cliVersion: SelfHostCheck;
    graphRebuild: SelfHostCheck;
    workspaceConfig: SelfHostCheck;
    tarballWorkspaceConfig: SelfHostCheck;
    track: SelfHostCheck;
    brief: SelfHostCheck;
    explore: SelfHostCheck;
    note: SelfHostCheck;
    recall: SelfHostCheck;
    cliNote: SelfHostCheck;
    cliRecall: SelfHostCheck;
  };
  tarball: { name: string; bytes: number; sha256: string } | null;
  workspaceRoot: string;
  tempRemoved: boolean;
  limitations: string[];
  error?: string;
}

export interface SelfHostOptions {
  /** Node binary used to execute the installed package. Defaults to process.execPath. */
  readonly nodePath?: string;
  /** Keep the temp workspace for inspection. */
  readonly keep?: boolean;
  readonly log?: (message: string) => void;
}

interface StdioServerConfig {
  type: 'stdio';
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  enabled?: boolean;
  timeoutMs?: number;
}

function statusOf(value: CheckStatus, durationMs: number, detail: Record<string, unknown> = {}): SelfHostCheck {
  return { ...detail, status: value, durationMs };
}

function errorText(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

function runNode(nodePath: string, argv: string[], cwd: string, timeout = 120_000, env?: NodeJS.ProcessEnv) {
  return spawnSync(nodePath, argv, {
    cwd,
    encoding: 'utf8',
    timeout,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(env ? { env } : {}),
  });
}

function toolText(response: unknown): string {
  const value = response as { content?: unknown };
  const content = Array.isArray(value.content) ? value.content as { type?: string; text?: string }[] : [];
  return content.filter((item) => item.type === 'text').map((item) => item.text ?? '').join('\n');
}

function responseOf(value: unknown): { isError: boolean; text: string } {
  const record = value as { isError?: unknown };
  return { isError: record.isError === true, text: toolText(value) };
}

function classifyUnwired(label: string, isError: boolean, text: string, durationMs: number, extra: Record<string, unknown> = {}): SelfHostCheck {
  if (!isError) return statusOf('passed', durationMs, { evidence: text.slice(0, 2_000), ...extra });
  if (/not implemented|未接通/iu.test(text)) return statusOf('unimplemented', durationMs, { evidence: text.slice(0, 2_000), ...extra });
  return statusOf('failed', durationMs, { evidence: text.slice(0, 2_000), ...extra, label });
}

function classifyRecall(isError: boolean, text: string, durationMs: number, extra: Record<string, unknown> = {}): SelfHostCheck {
  if (isError) return classifyUnwired('recall', true, text, durationMs, extra);
  try {
    const value = JSON.parse(text) as { status?: string; degraded?: unknown[]; summary?: { total?: number; mode?: string; returned?: number } };
    if (value.status === 'not_configured') return statusOf('not-configured', durationMs, { evidence: text.slice(0, 2_000), ...extra });
    const total = value.summary?.total;
    if ((value.status === 'ok' || value.status === 'degraded') && typeof total === 'number' && total > 0) {
      return statusOf('passed', durationMs, { evidence: text.slice(0, 2_000), recallStatus: value.status, total, mode: value.summary?.mode, degraded: value.degraded, ...extra });
    }
    return statusOf('failed', durationMs, { evidence: text.slice(0, 2_000), reason: 'recall returned no hits', ...extra });
  } catch {
    return statusOf('failed', durationMs, { evidence: text.slice(0, 2_000), reason: 'recall output was not JSON', ...extra });
  }
}

async function gitInit(root: string): Promise<void> {
  for (const args of [
    ['init', '-q', '-b', 'main'],
    ['config', 'user.email', 'selfhost@localhost'],
    ['config', 'user.name', 'ANO Selfhost'],
    ['config', 'core.autocrlf', 'false'],
    ['add', '.'],
    ['commit', '-qm', 'baseline'],
  ]) {
    const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', shell: false, windowsHide: true });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
}

async function connect(config: StdioServerConfig, root: string) {
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args ?? [],
    cwd: root,
    env: { ...process.env, ...(config.env ?? {}), ANO_ROOT: root },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  const client = new Client({ name: 'ano-selfhost', version: '1.0.0' });
  await client.connect(transport, { timeout: config.timeoutMs ?? 60_000 });
  return { client, transport, stderr: () => stderr };
}

async function checkConfigLaunch(config: StdioServerConfig, root: string, expectedPhase: string): Promise<SelfHostCheck> {
  const started = performance.now();
  const { client, transport, stderr } = await connect(config, root);
  try {
    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    if (JSON.stringify(tools) !== JSON.stringify(expectedTools)) {
      return statusOf('failed', performance.now() - started, { tools, expectedTools, stderr: stderr() });
    }
    const brief = responseOf(await client.callTool({ name: 'brief', arguments: {} }));
    if (brief.isError) return statusOf('failed', performance.now() - started, { tools, brief: brief.text, stderr: stderr() });
    const parsed = JSON.parse(brief.text) as { phase?: string; root?: string };
    if (parsed.phase !== expectedPhase) return statusOf('failed', performance.now() - started, { tools, phase: parsed.phase });
    return statusOf('passed', performance.now() - started, { tools, phase: parsed.phase, pid: transport.pid, command: config.command, args: config.args ?? [] });
  } finally {
    await client.close();
  }
}

export async function runSelfHost(options: SelfHostOptions = {}): Promise<SelfHostReport> {
  const targetNode = resolve(options.nodePath ?? process.execPath);
  const keep = options.keep ?? process.env.ANO_SELFHOST_KEEP === '1';
  const log = options.log ?? (() => {});
  const base = await mkdtemp(join(tmpdir(), 'ano-selfhost-'));
  const projectRoot = join(base, 'project');
  const report: SelfHostReport = {
    schema: 'ano.selfhost.v1',
    generatedAt: new Date().toISOString(),
    verdict: 'failed',
    source: {
      root: resolve(repoRoot),
      packageName: '',
      packageVersion: '',
      nodeRuntime: process.version,
      targetNode,
      targetNodeVersion: null,
      npmVersion: null,
    },
    checks: {
      build: statusOf('skipped', 0),
      pack: statusOf('skipped', 0),
      install: statusOf('skipped', 0),
      cliVersion: statusOf('skipped', 0),
      graphRebuild: statusOf('skipped', 0),
      workspaceConfig: statusOf('skipped', 0),
      tarballWorkspaceConfig: statusOf('skipped', 0),
      track: statusOf('skipped', 0),
      brief: statusOf('skipped', 0),
      explore: statusOf('skipped', 0),
      note: statusOf('skipped', 0),
      recall: statusOf('skipped', 0),
      cliNote: statusOf('skipped', 0),
      cliRecall: statusOf('skipped', 0),
    },
    tarball: null,
    workspaceRoot: projectRoot,
    tempRemoved: false,
    limitations: [
      'recall is exercised only against an explicitly imported synthetic fixture; no real session data is read',
      'the self-host project is synthetic and lives in os.tmpdir(); it does not represent a real client project',
      'no npm publish or remote push is performed',
    ],
  };

  try {
    const manifest = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')) as { name: string; version: string };
    report.source.packageName = manifest.name;
    report.source.packageVersion = manifest.version;
    const targetVersion = spawnSync(targetNode, ['--version'], { encoding: 'utf8', shell: false, windowsHide: true });
    if (targetVersion.status === 0) report.source.targetNodeVersion = targetVersion.stdout.trim();
    const npmVersion = spawnSync(process.execPath, [npmCli, '--version'], { encoding: 'utf8', shell: false, windowsHide: true });
    if (npmVersion.status === 0) report.source.npmVersion = npmVersion.stdout.trim();

    log('building dist');
    const buildStarted = performance.now();
    const build = spawnSync(process.execPath, [npmCli, 'run', 'build'], {
      cwd: repoRoot, encoding: 'utf8', timeout: 180_000, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    report.checks.build = build.status === 0
      ? statusOf('passed', performance.now() - buildStarted, { command: 'npm run build' })
      : statusOf('failed', performance.now() - buildStarted, { stderr: build.stderr });
    if (build.status !== 0) throw new Error(`npm run build failed: ${build.stderr}`);

    log('packing tarball');
    const packDir = join(base, 'pack');
    await mkdir(packDir, { recursive: true });
    const packStarted = performance.now();
    const pack = spawnSync(process.execPath, [npmCli, 'pack', '--pack-destination', packDir], {
      cwd: repoRoot, encoding: 'utf8', timeout: 180_000, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    report.checks.pack = pack.status === 0
      ? statusOf('passed', performance.now() - packStarted, { stdout: pack.stdout.trim().split(/\r?\n/).at(-1) })
      : statusOf('failed', performance.now() - packStarted, { stderr: pack.stderr });
    if (pack.status !== 0) throw new Error(`npm pack failed: ${pack.stderr}`);
    const tarballName = pack.stdout.trim().split(/\r?\n/).at(-1)!;
    const tarball = join(packDir, tarballName);
    const tarballBytes = await readFile(tarball);
    report.tarball = {
      name: basename(tarball),
      bytes: tarballBytes.length,
      sha256: createHash('sha256').update(tarballBytes).digest('hex'),
    };

    log('installing tarball');
    const installDir = join(base, 'install');
    await mkdir(installDir, { recursive: true });
    await writeFile(join(installDir, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    const installStarted = performance.now();
    const installed = spawnSync(process.execPath, [npmCli, 'install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], {
      cwd: installDir, encoding: 'utf8', timeout: 180_000, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    report.checks.install = installed.status === 0
      ? statusOf('passed', performance.now() - installStarted, { installDir: basename(installDir) })
      : statusOf('failed', performance.now() - installStarted, { stderr: installed.stderr });
    if (installed.status !== 0) throw new Error(`npm install failed: ${installed.stderr}`);
    const packageDir = join(installDir, 'node_modules', manifest.name);
    const cli = join(packageDir, 'dist', 'surface', 'cli.js');
    const mcp = join(packageDir, 'dist', 'surface', 'mcp.js');

    log('creating self-host project');
    await mkdir(join(projectRoot, 'src'), { recursive: true });
    await mkdir(join(projectRoot, 'test'), { recursive: true });
    await mkdir(join(projectRoot, '.zcode'), { recursive: true });
    await writeFile(join(projectRoot, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    await writeFile(join(projectRoot, 'src', 'a.ts'), 'export function greet(name: string): string {\n  return `hello ${name}`;\n}\n');
    await writeFile(join(projectRoot, 'test', 'a.test.ts'), "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { greet } from '../src/a.ts';\ntest('greet', () => assert.equal(greet('ano'), 'hello ano'));\n");
    // Explicitly import one hand-authored synthetic fixture (no real session data).
    await cp(
      join(repoRoot, 'test', 'fixtures', 'memory', 'synthetic-alpha', 'unit-visible'),
      join(projectRoot, '.ano', 'memory', 'synthetic', 'synthetic-alpha', 'unit-visible'),
      { recursive: true },
    );
    await gitInit(projectRoot);
    const tarballServer: StdioServerConfig = {
      type: 'stdio',
      command: targetNode,
      args: [mcp],
      cwd: projectRoot,
      env: { ANO_ROOT: projectRoot },
      enabled: true,
      timeoutMs: 60_000,
    };
    await writeFile(join(projectRoot, '.zcode', 'config.json'), JSON.stringify({ mcp: { servers: { ano: tarballServer } } }, null, 2) + '\n');

    log('checking installed CLI');
    const versionStarted = performance.now();
    const version = runNode(targetNode, [cli, '--version'], projectRoot);
    report.checks.cliVersion = version.status === 0 && version.stdout.trim() === manifest.version
      ? statusOf('passed', performance.now() - versionStarted, { version: version.stdout.trim() })
      : statusOf('failed', performance.now() - versionStarted, { status: version.status, stdout: version.stdout, stderr: version.stderr });

    log('rebuilding graph');
    const graphStarted = performance.now();
    const rebuild = runNode(targetNode, [cli, 'rebuild', 'graph', '--root', projectRoot], projectRoot);
    let graph: Record<string, unknown> | null = null;
    try { graph = rebuild.status === 0 ? JSON.parse(rebuild.stdout) as Record<string, unknown> : null; } catch { graph = null; }
    report.checks.graphRebuild = rebuild.status === 0 && graph
      ? statusOf('passed', performance.now() - graphStarted, { symbols: graph.symbols, files: graph.files, freshness: graph.freshness })
      : statusOf('failed', performance.now() - graphStarted, { status: rebuild.status, stdout: rebuild.stdout, stderr: rebuild.stderr });

    log('checking repository workspace MCP registration against temp root');
    let workspaceCheck: SelfHostCheck;
    try {
      const workspacePath = join(repoRoot, '.zcode', 'config.json');
      // A workspace declaration is a valid single-project choice; launch it as
      // written. Otherwise the repository relies on the single user-scope ano
      // registration, so recreate that entry in an isolated user-scope config
      // file (portable and offline) and verify the inherited launch.
      const declared = await resolveAnoRegistrations(workspacePath, join(base, 'no-user-config.json'));
      if (declared.workspaceAnoDeclared) {
        const server = declared.workspace!.server;
        const problems = validateAnoStdioServer(server, 'workspace ano server');
        workspaceCheck = problems.length > 0
          ? statusOf('failed', 0, { problems })
          : { ...(await checkConfigLaunch(server, projectRoot, 'P7')), config: '.zcode/config.json', registrationScope: 'workspace', workspaceAnoDeclared: true, rootRedirectedTo: 'temp-project' };
      } else {
        const userConfigPath = join(base, 'isolated-user-config', '.zcode', 'cli', 'config.json');
        await mkdir(dirname(userConfigPath), { recursive: true });
        const repoMcp = join(repoRoot, 'dist', 'surface', 'mcp.js');
        const userServer: StdioServerConfig = { type: 'stdio', command: targetNode, args: [repoMcp], enabled: true, timeoutMs: 60_000 };
        await writeFile(userConfigPath, `${JSON.stringify({ mcp: { servers: { ano: userServer } } }, null, 2)}\n`);
        const inherited = await resolveAnoRegistrations(workspacePath, userConfigPath);
        if (inherited.duplicate || inherited.effective?.scope !== 'user') {
          workspaceCheck = statusOf('failed', 0, {
            reason: 'workspace config must inherit exactly one user-scope ano registration',
            workspaceAnoDeclared: inherited.workspaceAnoDeclared,
            registrationScope: inherited.effective?.scope ?? null,
            registrationCount: inherited.registrations.length,
          });
        } else {
          const problems = validateAnoStdioServer(inherited.effective.server, 'isolated user-scope ano server');
          workspaceCheck = problems.length > 0
            ? statusOf('failed', 0, { problems })
            : { ...(await checkConfigLaunch(inherited.effective.server, projectRoot, 'P7')), config: '.zcode/config.json', registrationScope: 'user', workspaceAnoDeclared: false, isolatedUserConfig: true, rootRedirectedTo: 'temp-project' };
        }
      }
    } catch (error) {
      workspaceCheck = statusOf('failed', 0, { error: errorText(error) });
    }
    report.checks.workspaceConfig = workspaceCheck;

    log('launching installed tarball through workspace config');
    const { client, stderr } = await connect(tarballServer, projectRoot);
    try {
      const tarballConfigStarted = performance.now();
      const tools = (await client.listTools()).tools.map((tool) => tool.name);
      report.checks.tarballWorkspaceConfig = JSON.stringify(tools) === JSON.stringify(expectedTools)
        ? statusOf('passed', performance.now() - tarballConfigStarted, { tools, config: '.zcode/config.json' })
        : statusOf('failed', performance.now() - tarballConfigStarted, { tools, expectedTools });

      const trackStarted = performance.now();
      const tracked = responseOf(await client.callTool({
        name: 'track',
        arguments: {
          idem_key: 'selfhost:track:T1',
          kind: 'task',
          operation: 'create',
          payload: { id: 'SELFHOST-T1', title: 'self-host smoke', files: ['src/a.ts', 'test/a.test.ts'], status: 'in_progress' },
        },
      }));
      let trackTask: { id?: string; status?: string } | null = null;
      try {
        const parsed = JSON.parse(tracked.text) as { task?: { id?: string; status?: string } };
        trackTask = parsed.task ?? null;
      } catch { trackTask = null; }
      report.checks.track = tracked.isError || !trackTask
        ? statusOf('failed', performance.now() - trackStarted, { evidence: tracked.text })
        : statusOf('passed', performance.now() - trackStarted, { taskId: trackTask.id, taskStatus: trackTask.status, idemKey: 'selfhost:track:T1' });

      const briefStarted = performance.now();
      const brief = responseOf(await client.callTool({ name: 'brief', arguments: {} }));
      let briefValue: { phase?: string; tasks?: unknown[]; limitations?: unknown[] } | null = null;
      try {
        const parsed = JSON.parse(brief.text) as { phase?: string; tasks?: unknown[]; limitations?: unknown[] };
        briefValue = parsed;
      } catch { briefValue = null; }
      const briefTasks = Array.isArray(briefValue?.tasks) ? briefValue!.tasks : [];
      report.checks.brief = brief.isError || !briefValue
        ? statusOf('failed', performance.now() - briefStarted, { evidence: brief.text })
        : statusOf('passed', performance.now() - briefStarted, {
          phase: briefValue.phase,
          taskCount: briefTasks.length,
          hasSelfHostTask: JSON.stringify(briefTasks).includes('SELFHOST-T1'),
          limitations: briefValue.limitations,
        });

      const exploreStarted = performance.now();
      const explored = responseOf(await client.callTool({ name: 'explore', arguments: { query: 'greet' } }));
      let exploreValue: { total?: number; symbols?: unknown[]; freshness?: unknown } | null = null;
      try {
        const parsed = JSON.parse(explored.text) as { total?: number; symbols?: unknown[]; freshness?: unknown };
        exploreValue = parsed;
      } catch { exploreValue = null; }
      report.checks.explore = explored.isError || !exploreValue
        ? statusOf('failed', performance.now() - exploreStarted, { evidence: explored.text })
        : statusOf('passed', performance.now() - exploreStarted, { total: exploreValue.total, returned: Array.isArray(exploreValue.symbols) ? exploreValue.symbols.length : null, freshness: exploreValue.freshness });

      const noteStarted = performance.now();
      let note: { isError: boolean; text: string };
      try {
        note = responseOf(await client.callTool({ name: 'note', arguments: { idem_key: 'selfhost:note:T1', kind: 'session_summary', text: 'self-host smoke note' } }));
      } catch (error) {
        note = { isError: true, text: errorText(error) };
      }
      report.checks.note = classifyUnwired('note', note.isError, note.text, performance.now() - noteStarted);

      const recallStarted = performance.now();
      let recall: { isError: boolean; text: string };
      try {
        recall = responseOf(await client.callTool({ name: 'recall', arguments: { keyword: 'refreshToken' } }));
      } catch (error) {
        recall = { isError: true, text: errorText(error) };
      }
      report.checks.recall = classifyRecall(recall.isError, recall.text, performance.now() - recallStarted);
    } finally {
      await client.close();
    }

    const cliNoteStarted = performance.now();
    const cliNote = runNode(targetNode, [cli, 'note', 'session_summary', '--text', 'self-host smoke note', '--root', projectRoot], projectRoot);
    report.checks.cliNote = cliNote.status === 0
      ? statusOf('passed', performance.now() - cliNoteStarted, { evidence: cliNote.stdout.slice(0, 2_000) })
      : /not implemented|未接通/iu.test(`${cliNote.stdout}${cliNote.stderr}`)
        ? statusOf('unimplemented', performance.now() - cliNoteStarted, { evidence: `${cliNote.stdout}${cliNote.stderr}`.slice(0, 2_000), exitCode: cliNote.status })
        : statusOf('failed', performance.now() - cliNoteStarted, { evidence: `${cliNote.stdout}${cliNote.stderr}`.slice(0, 2_000), exitCode: cliNote.status });

    const cliRecallStarted = performance.now();
    const cliRecall = runNode(targetNode, [cli, 'recall', '--keyword', 'refreshToken', '--root', projectRoot], projectRoot);
    report.checks.cliRecall = cliRecall.status === 0
      ? classifyRecall(false, cliRecall.stdout, performance.now() - cliRecallStarted, { exitCode: 0 })
      : /not implemented|未接通/iu.test(`${cliRecall.stdout}${cliRecall.stderr}`)
        ? statusOf('unimplemented', performance.now() - cliRecallStarted, { evidence: `${cliRecall.stdout}${cliRecall.stderr}`.slice(0, 2_000), exitCode: cliRecall.status })
        : statusOf('failed', performance.now() - cliRecallStarted, { evidence: `${cliRecall.stdout}${cliRecall.stderr}`.slice(0, 2_000), exitCode: cliRecall.status });

    if (report.source.targetNodeVersion === null) {
      report.checks.cliVersion = statusOf('missing', report.checks.cliVersion.durationMs, { reason: `target Node binary did not run: ${targetNode}` });
    }

    const core: SelfHostCheck[] = [
      report.checks.build, report.checks.pack, report.checks.install, report.checks.cliVersion, report.checks.graphRebuild,
      report.checks.workspaceConfig, report.checks.tarballWorkspaceConfig,
      report.checks.track, report.checks.brief, report.checks.explore,
    ];
    const wiring: SelfHostCheck[] = [report.checks.note, report.checks.recall, report.checks.cliNote, report.checks.cliRecall];
    if (core.some((check) => check.status !== 'passed')) report.verdict = 'failed';
    else if (wiring.some((check) => check.status === 'failed')) report.verdict = 'failed';
    else if (wiring.some((check) => check.status === 'unimplemented' || check.status === 'not-configured' || check.status === 'missing')) {
      report.verdict = 'passed-with-limitations';
      report.limitations.unshift('note/recall MCP+CLI wiring is not complete; unimplemented or not-configured is recorded as such, never as passed');
    } else report.verdict = 'passed';
  } catch (error) {
    report.verdict = 'failed';
    report.error = errorText(error);
  } finally {
    if (!keep) {
      try {
        await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        report.tempRemoved = true;
      } catch (error) {
        report.limitations.push(`temp workspace could not be removed: ${errorText(error)}`);
      }
    } else {
      report.tempRemoved = false;
    }
  }
  return report;
}

function value(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const report = await runSelfHost({
    ...(value(argv, '--node') ? { nodePath: value(argv, '--node')! } : {}),
    ...(argv.includes('--keep') ? { keep: true } : {}),
    log: (message) => console.error(`[selfhost] ${message}`),
  });
  const json = JSON.stringify(report, null, 2);
  const out = value(argv, '--out');
  if (out) {
    await mkdir(dirname(resolve(out)), { recursive: true });
    await writeFile(resolve(out), json + '\n');
  }
  console.log(json);
  process.exitCode = report.verdict === 'failed' ? 1 : 0;
}

const invokedPath = process.argv[1];
if (invokedPath && pathToFileURL(resolve(invokedPath)).href === import.meta.url) await main();
