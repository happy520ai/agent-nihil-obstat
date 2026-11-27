#!/usr/bin/env node
/**
 * Real ZCode MCP verification for this workspace.
 *
 * The repository intentionally registers `ano` once, at user scope, and keeps
 * the workspace `mcp.servers` container empty (D-0019). This script resolves
 * the effective registration from the real configs, fails closed when both
 * scopes declare `ano`, launches the configured command over stdio, asserts the
 * seven-tool surface and `brief.phase=P7`, then writes evidence bound to the
 * current workspace config hash and effective server fingerprint.
 */
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { defaultUserConfigPath, resolveAnoRegistrations, validateAnoStdioServer } from './zcode-mcp-config.ts';

const projectRoot = resolve(fileURLToPath(new URL('../', import.meta.url)));
const workspaceConfigPath = resolve(projectRoot, '.zcode/config.json');
const state = await resolveAnoRegistrations(workspaceConfigPath, defaultUserConfigPath());
if (state.duplicate) {
  throw new Error(
    `ano is registered in both ${state.workspace?.configPath} and ${state.user?.configPath}; ` +
      'remove the workspace duplicate and keep the single user-scope registration',
  );
}
const effective = state.effective;
if (effective === null) {
  throw new Error(
    `No ano MCP registration found in ${workspaceConfigPath} or ${state.userConfigPath}; ` +
      'register it once at user scope (see docs/zcode-integration.md)',
  );
}
const problems = validateAnoStdioServer(effective.server, `${effective.scope} ano server`);
if (problems.length > 0) throw new Error(`Invalid ano MCP registration:\n- ${problems.join('\n- ')}`);

// ZCode launches MCP servers from the workspace with its own environment plus
// the configured env. Keep that shape, but drop an ambient ANO_ROOT so the
// verified root really is this workspace (a configured ANO_ROOT still wins).
const environment: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) if (value !== undefined) environment[key] = value;
delete environment.ANO_ROOT;
Object.assign(environment, effective.server.env ?? {});

const client = new Client({ name: 'ano-zcode-integration-check', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: effective.server.command,
  args: effective.server.args ?? [],
  cwd: effective.server.cwd ?? projectRoot,
  env: environment,
  stderr: 'pipe',
});
let stderr = '';
transport.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
try {
  await client.connect(transport, { timeout: effective.server.timeoutMs ?? 30_000 });
  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name);
  const expected = ['brief', 'explore', 'recall', 'track', 'note', 'verify', 'audit'];
  if (JSON.stringify(names) !== JSON.stringify(expected)) throw new Error(`Unexpected ANO tool list: ${names.join(', ')}`);
  const response = await client.callTool({ name: 'brief', arguments: {} });
  if (response.isError) throw new Error(`ANO brief failed: ${JSON.stringify(response.content)}`);
  const content = response.content as { type: string; text?: string }[];
  const text = content.find((item) => item.type === 'text')?.text;
  if (!text) throw new Error('ANO brief returned no text payload');
  const brief = JSON.parse(text) as { phase?: string };
  if (brief.phase !== 'P7') throw new Error(`Unexpected ANO phase: ${String(brief.phase)}`);
  const report = {
    schema: 'ano.zcode-integration.v1',
    generatedAt: new Date().toISOString(),
    // Repo-controlled freshness anchor: editing the workspace config still
    // requires regenerating this evidence.
    configPath: workspaceConfigPath,
    configSha256: state.workspaceConfigSha256,
    workspaceAnoDeclared: state.workspaceAnoDeclared,
    // The single effective registration (user scope for this repository).
    registrationScope: effective.scope,
    anoRegistrationCount: state.registrations.length,
    effectiveConfigPath: effective.configPath,
    effectiveServerSha256: effective.serverSha256,
    serverPid: transport.pid,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    initialized: true,
    tools: names,
    briefPhase: brief.phase,
    root: projectRoot,
    scope: effective.scope,
    verified: 'configured-stdio-command',
    clientRestartRequired: true,
  };
  const output = resolve(projectRoot, 'docs/evidence/zcode-mcp.json');
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (stderr) console.error(stderr.trim());
  throw error;
} finally {
  await client.close();
}
