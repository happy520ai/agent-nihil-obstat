import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  connectProject,
  connectionStatus,
  exportConnection,
  handoffReadiness,
  planConnection,
} from '../../connect/index.ts';
import type {
  ConnectionPlan,
  ConnectionResult,
  ConnectionStatus,
  ExportConnection,
  HandoffReadiness,
} from '../../connect/types.ts';
import {
  CONNECT_UI_HOST,
  MAX_BODY_BYTES,
  MAX_URL_LENGTH,
  connectTokenEquals,
  errorMessage,
  isConnectHostAllowed,
  respondHtml,
  respondJson,
  respondText,
  setSecurityHeaders,
} from './policy.ts';
import type { ConnectShellMeta } from './render.ts';
import { activeConnectionSummary, renderConnectPage, renderConnectResultPage } from './render.ts';

const UNAUTHORIZED_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>未授权</title>
<style>body{font-family:system-ui,sans-serif;margin:1.5rem;color:#1f2328;background:#fff}h1{font-size:1.3rem}.muted{color:#57606a}</style>
</head>
<body>
<h1>未授权</h1>
<p class="muted">请通过启动时返回的链接访问。</p>
</body>
</html>`;

interface ConnectContext extends ConnectShellMeta {}

interface SessionRoute {
  token: string;
  route: string;
  exportToken: string;
  extra: boolean;
}

type BodyRead = { ok: true; body: string } | { ok: false; tooLarge: boolean };

function parseSessionPath(pathname: string): SessionRoute | null {
  const prefix = '/session/';
  if (!pathname.startsWith(prefix)) return null;
  const segments = pathname
    .slice(prefix.length)
    .split('/')
    .filter((segment) => segment.length > 0);
  return {
    token: segments[0] ?? '',
    route: segments[1] ?? '',
    exportToken: segments[2] ?? '',
    extra: segments.length > 3,
  };
}

function readBody(request: IncomingMessage, limit: number): Promise<BodyRead> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (result: BodyRead): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    request.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        // Drain so the client can read our 413 instead of seeing a reset.
        request.resume();
        finish({ ok: false, tooLarge: true });
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => finish({ ok: true, body: Buffer.concat(chunks).toString('utf8') }));
    request.on('error', () => finish({ ok: false, tooLarge: false }));
    request.on('aborted', () => finish({ ok: false, tooLarge: false }));
  });
}

async function handleIndex(ctx: ConnectContext, response: ServerResponse): Promise<void> {
  let plan: ConnectionPlan | null = null;
  let planError: string | null = null;
  try {
    plan = await planConnection(ctx.root);
  } catch (error) {
    planError = errorMessage(error);
  }

  let status: ConnectionStatus | null = null;
  let statusError: string | null = null;
  try {
    status = await connectionStatus(ctx.root);
  } catch (error) {
    statusError = errorMessage(error);
  }

  let readiness: HandoffReadiness | null = null;
  try {
    readiness = await handoffReadiness(ctx.root);
  } catch {
    readiness = null;
  }

  respondHtml(
    response,
    200,
    renderConnectPage({
      root: ctx.root,
      port: ctx.port,
      sessionToken: ctx.sessionToken,
      csrf: ctx.csrf,
      exportToken: ctx.exportToken,
      plan,
      planError,
      status,
      statusError,
      readiness,
    }),
  );
}

async function handleStatus(ctx: ConnectContext, response: ServerResponse): Promise<void> {
  let status: ConnectionStatus;
  try {
    status = await connectionStatus(ctx.root);
  } catch (error) {
    respondText(response, 500, `Status failed: ${errorMessage(error)}\n`);
    return;
  }
  let plan: ConnectionPlan | null = null;
  let planError: string | null = null;
  try {
    plan = await planConnection(ctx.root);
  } catch (error) {
    planError = errorMessage(error);
  }
  const connection = activeConnectionSummary(status);
  respondJson(response, 200, {
    schema: 'ano.connect-ui-status/1',
    root: status.root,
    connected: status.connected,
    source: status.source,
    sourceDigest: connection ? connection.sourceDigest : '',
    version: connection ? connection.currentVersion : 0,
    versionCount: connection ? connection.versionCount : 0,
    files: connection ? connection.files : 0,
    tasks: status.tasks.length,
    recordCounts: status.recordCounts,
    excluded: status.excluded,
    warnings: status.warnings,
    capabilities: ['read', 'recall', 'export'],
    ready: false,
    notice: status.notice,
    plan: plan
      ? {
          source: plan.source,
          project: plan.identity.project,
          connectionId: plan.connectionId,
          sourceDigest: plan.sourceDigest,
          counts: plan.counts,
          excluded: plan.excluded,
          canConnect: plan.canConnect,
          warnings: plan.warnings,
        }
      : null,
    planError,
  });
}

async function handleExport(ctx: ConnectContext, token: string, response: ServerResponse): Promise<void> {
  if (token.length === 0 || token.includes('/') || !connectTokenEquals(token, ctx.exportToken)) {
    respondText(response, 401, 'Unauthorized\n');
    return;
  }
  let data: ExportConnection;
  try {
    data = await exportConnection(ctx.root);
  } catch {
    respondText(response, 404, 'No connection to export\n');
    return;
  }
  const body = JSON.stringify(data);
  response.setHeader('Content-Disposition', `attachment; filename="ano-connect-${data.connectionId}.json"`);
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Content-Length', Buffer.byteLength(body));
  response.writeHead(200);
  response.end(body);
}

/**
 * Narrow acceptance for browser navigations that report an opaque `Origin:
 * null` (e.g. Chromium private-window/IAB style contexts). Only a same-origin
 * navigation with `sec-fetch-site: same-origin`, `sec-fetch-mode: navigate`
 * and `sec-fetch-dest: document` is accepted; anything else with a wrong or
 * missing Origin/Referer is still rejected.
 */
function isOpaqueSameOriginNavigation(request: IncomingMessage): boolean {
  if (request.headers.origin !== 'null') return false;
  return (
    request.headers['sec-fetch-site'] === 'same-origin' &&
    request.headers['sec-fetch-mode'] === 'navigate' &&
    request.headers['sec-fetch-dest'] === 'document'
  );
}

async function handleConnect(ctx: ConnectContext, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const contentType = request.headers['content-type'] ?? '';
  const mediaType = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (mediaType !== 'application/x-www-form-urlencoded') {
    respondText(response, 415, 'Unsupported media type\n');
    return;
  }

  const expectedOrigin = `http://${CONNECT_UI_HOST}:${ctx.port}`;
  const origin = request.headers.origin;
  const referer = request.headers.referer;
  let sameOrigin = false;
  if (typeof origin === 'string' && origin.length > 0) {
    sameOrigin = origin === expectedOrigin || isOpaqueSameOriginNavigation(request);
  } else if (typeof referer === 'string' && referer.length > 0) {
    sameOrigin = referer.startsWith(`${expectedOrigin}/`);
  }
  if (!sameOrigin) {
    respondText(response, 403, 'Cross-origin request refused\n');
    return;
  }

  const declaredLength = Number(request.headers['content-length'] ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    respondText(response, 413, 'Payload too large\n');
    request.resume();
    return;
  }

  const bodyRead = await readBody(request, MAX_BODY_BYTES);
  if (!bodyRead.ok) {
    respondText(response, bodyRead.tooLarge ? 413 : 400, bodyRead.tooLarge ? 'Payload too large\n' : 'Bad request\n');
    return;
  }

  const fields = new URLSearchParams(bodyRead.body);
  const csrf = fields.get('_csrf') ?? '';
  if (!connectTokenEquals(csrf, ctx.csrf)) {
    respondText(response, 403, 'Invalid CSRF token\n');
    return;
  }

  const expectedDigest = fields.get('expectedDigest') ?? '';
  if (expectedDigest.length === 0) {
    respondHtml(
      response,
      400,
      renderConnectResultPage({
        root: ctx.root,
        port: ctx.port,
        sessionToken: ctx.sessionToken,
        csrf: ctx.csrf,
        exportToken: ctx.exportToken,
        result: null,
        error: '缺少 expectedDigest，请返回向导重新预检。',
      }),
    );
    return;
  }

  let result: ConnectionResult | null = null;
  let error: string | null = null;
  try {
    result = await connectProject(ctx.root, { expectedDigest });
  } catch (caught) {
    error = errorMessage(caught);
  }

  respondHtml(
    response,
    error === null ? 200 : 500,
    renderConnectResultPage({
      root: ctx.root,
      port: ctx.port,
      sessionToken: ctx.sessionToken,
      csrf: ctx.csrf,
      exportToken: ctx.exportToken,
      result,
      error,
    }),
  );
}

async function handle(ctx: ConnectContext, request: IncomingMessage, response: ServerResponse): Promise<void> {
  setSecurityHeaders(response);

  const method = request.method ?? '';
  if (!isConnectHostAllowed(request.headers.host, ctx.port)) {
    respondText(response, 403, 'Forbidden host\n');
    return;
  }
  if (method !== 'GET' && method !== 'POST') {
    response.setHeader('allow', 'GET, POST');
    respondText(response, 405, 'Method not allowed\n');
    return;
  }

  const rawUrl = request.url ?? '/';
  if (rawUrl.length > MAX_URL_LENGTH) {
    respondText(response, 414, 'URI too long\n');
    return;
  }
  let pathname: string;
  try {
    pathname = new URL(rawUrl, `http://${CONNECT_UI_HOST}:${ctx.port}`).pathname;
  } catch {
    respondText(response, 400, 'Bad request\n');
    return;
  }

  const session = parseSessionPath(pathname);
  if (session === null || !connectTokenEquals(session.token, ctx.sessionToken)) {
    respondHtml(response, 401, UNAUTHORIZED_PAGE);
    return;
  }
  if (session.extra) {
    respondText(response, 404, 'Not found\n');
    return;
  }

  const route = session.route;
  if (method === 'GET') {
    if (route === '') {
      await handleIndex(ctx, response);
      return;
    }
    if (route === 'status') {
      await handleStatus(ctx, response);
      return;
    }
    if (route === 'export') {
      if (session.exportToken.length === 0) {
        respondHtml(response, 401, UNAUTHORIZED_PAGE);
        return;
      }
      await handleExport(ctx, session.exportToken, response);
      return;
    }
    if (route === 'connect') {
      response.setHeader('allow', 'POST');
      respondText(response, 405, 'Method not allowed\n');
      return;
    }
    respondText(response, 404, 'Not found\n');
    return;
  }

  if (route !== 'connect') {
    response.setHeader('allow', 'GET');
    respondText(response, 405, 'Method not allowed\n');
    return;
  }
  await handleConnect(ctx, request, response);
}

export { handle, type ConnectContext };
