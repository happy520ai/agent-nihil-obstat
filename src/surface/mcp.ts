#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { toolCatalogForProfile } from './tool-catalog.ts';
import { readConfig } from '../core/config.ts';
import { auditSurface, assertLegacyConnectWriteAllowed, brief, defaultRoot, explore, migrateApplySurface, migratePlanSurface, migrateReconcileSurface, note, noteRelate, noteRevise, recall, recallProbe, releaseVerification, takeoverApply, takeoverDisable, takeoverGrant, takeoverRecover, takeoverRevoke, takeoverStatusSurface, trackTask, trackTaskUpdate, verifyContext, verifySurface } from './service.ts';
import { connectProject, connectionStatus, exportConnection, handoffReadiness, planConnection } from '../connect/index.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function result(value: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}
function error(error: unknown): { isError: true; content: { type: 'text'; text: string }[] } {
  return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] };
}

/**
 * ADR-009 §9: MCP and CLI call the same service functions, so the unified graph
 * status is already shared. This guard keeps the MCP projection honest even if
 * a future service regression returns `files=0` with `status='ok'`.
 */
function withGraphStatus(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const graph = isRecord(value.graph) ? value.graph : undefined;
  if (graph !== undefined && graph.status === 'ok' && graph.files === 0) {
    return { ...value, graph: { ...graph, status: 'degraded', stale: true, reason: 'scan-empty:0-files' } };
  }
  if (value.status === 'ok' && value.files === 0) {
    return { ...value, status: 'degraded', stale: true, reason: 'scan-empty:0-files' };
  }
  return value;
}

export function createMcpServer(root = defaultRoot()): McpServer {
  const server = new McpServer({ name: 'ano', version: '0.1.0-alpha.0' });
  for (const tool of toolCatalogForProfile(readConfig(root).profile)) server.registerTool(tool.name, { description: tool.summary, inputSchema: tool.input }, async (args: unknown) => {
    try {
      const input = args as Record<string, unknown>;
      const projectRoot = typeof input.root === 'string' ? resolve(input.root) : root;
      // User-scope ANO serves any explicitly selected project. Each call opens
      // that project's own ledger; existingProjectRoot rejects non-Git/invalid
      // roots before state is created. Without root, use the client's cwd.
      if (tool.name === 'brief') {
        const briefInput: { include_memory_context?: true; context_budget?: number } = {};
        if (input.include_memory_context === true) briefInput.include_memory_context = true;
        if (typeof input.context_budget === 'number') briefInput.context_budget = input.context_budget;
        return result(withGraphStatus(await brief(projectRoot, briefInput)));
      }
      if (tool.name === 'explore') return result(withGraphStatus(await explore(projectRoot, String(input.query), typeof input.budget === 'number' ? input.budget : 100)));
      if (tool.name === 'track' && input.kind === 'task' && input.operation === 'create') return result(await trackTask(projectRoot, input.payload as Record<string, unknown>, String(input.idem_key)));
      if (tool.name === 'track' && input.kind === 'task') {
        const payload = isRecord(input.payload) ? input.payload : {};
        return result(await trackTaskUpdate(projectRoot, { ...payload, operation: input.operation }, String(input.idem_key)));
      }
      if (tool.name === 'track' && input.kind === 'takeover') {
        const operation = typeof input.operation === 'string' ? input.operation : '';
        const payload = isRecord(input.payload) ? input.payload : {};
        const confirm = payload.confirm === true;
        switch (operation) {
          case 'grant': {
            const scope = Array.isArray(payload.scope) ? payload.scope : [];
            return result(await takeoverGrant(projectRoot, {
              scope: scope.map((entry) => String(entry)),
              grantedBy: String(payload.granted_by ?? ''),
              role: String(payload.role ?? ''),
              statement: String(payload.statement ?? ''),
            }));
          }
          case 'apply': {
            if (!confirm) return error('takeover apply requires payload.confirm=true');
            return result(await takeoverApply(projectRoot, { authorizationId: String(payload.authorization_id ?? '') }));
          }
          case 'status':
            return result(takeoverStatusSurface(projectRoot));
          case 'recover': {
            if (!confirm) return error('takeover recover requires payload.confirm=true');
            return result(await takeoverRecover(projectRoot));
          }
          case 'disable': {
            if (!confirm) return error('takeover disable requires payload.confirm=true');
            return result(await takeoverDisable(projectRoot));
          }
          case 'revoke': {
            if (!confirm) return error('takeover revoke requires payload.confirm=true');
            return result(await takeoverRevoke(projectRoot));
          }
          default:
            return error(`track takeover operation ${operation} is not implemented; no mutation was performed.`);
        }
      }
      if (tool.name === 'track' && input.kind === 'connection') {
        const operation = typeof input.operation === 'string' ? input.operation : '';
        const payload = isRecord(input.payload) ? input.payload : {};
        const expectedDigest = payload.expected_digest;
        if (expectedDigest !== undefined && (typeof expectedDigest !== 'string' || expectedDigest.length === 0)) {
          return error('track connection payload.expected_digest must be a non-empty string');
        }
        const options = typeof expectedDigest === 'string' ? { expectedDigest } : {};
        switch (operation) {
          case 'plan':
            return result(await planConnection(projectRoot));
          case 'connect': {
            const outcome = await connectProject(projectRoot, options);
            if (!outcome.report.connected) {
              return error(`track connection connect did not complete (${outcome.report.reason ?? 'source-changed'}); nothing was written.`);
            }
            return result(outcome);
          }
          case 'status':
            return result(await connectionStatus(projectRoot));
          case 'export':
            return result(await exportConnection(projectRoot));
          case 'handoff':
            return result(await handoffReadiness(projectRoot));
          case 'migrate_plan':
            return result(await migratePlanSurface(projectRoot));
          case 'migrate_apply':
            // T-072: explicit legacy-write assertion for the MCP branch; the
            // service applies the same gate, so enforced refuses the legacy
            // PM→ANO migration while recovery/disabled keep their semantics.
            assertLegacyConnectWriteAllowed(projectRoot);
            return result(await migrateApplySurface(projectRoot, payload, String(input.idem_key)));
          case 'reconcile':
            return result(await migrateReconcileSurface(projectRoot));
          default:
            return error(`track connection operation ${operation} is not implemented; no mutation was performed.`);
        }
      }
      if (tool.name === 'note' && input.operation === 'revise') {
        const { root: _root, operation: _operation, ...body } = input;
        return result(await noteRevise(projectRoot, body as never));
      }
      if (tool.name === 'note' && input.operation === 'relate') {
        const { root: _root, operation: _operation, ...body } = input;
        return result(await noteRelate(projectRoot, body as never));
      }
      if (tool.name === 'note') return result(await note(projectRoot, input as never));
      if (tool.name === 'recall' && input.mode === 'probe') return result(await recallProbe(projectRoot, input as never));
      if (tool.name === 'recall') return result(await recall(projectRoot, input as never));
      if (tool.name === 'verify' && input.scope === 'task') return result(await verifySurface(projectRoot, input));
      if (tool.name === 'verify' && input.scope === 'release') return result(await releaseVerification(projectRoot, input));
      if (tool.name === 'verify' && input.scope === 'context') return result(await verifyContext(projectRoot, input as never));
      if (tool.name === 'audit' && typeof input.scope === 'string') return result(await auditSurface(projectRoot, input));
      const scope = typeof input.scope === 'string' ? ` scope=${input.scope}` : typeof input.kind === 'string' ? ` kind=${input.kind}` : '';
      return error(`${tool.name}:${scope} this scope is not implemented; no mutation was performed.`);
    } catch (cause) { return error(cause); }
  });
  return server;
}

export async function startMcpServer(): Promise<void> {
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
}
const invokedPath = process.argv[1];
if (invokedPath && pathToFileURL(resolve(invokedPath)).href === import.meta.url) await startMcpServer();
