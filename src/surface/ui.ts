import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportProject, type ExportSnapshot } from './export.ts';

export const UI_HOST = '127.0.0.1';
export const UI_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; script-src 'none'; connect-src 'none'; font-src 'none'; media-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function jsonForHtml(value: unknown): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026');
}

export function renderPanel(data: ExportSnapshot): string {
  const taskRows = data.tasks.length === 0
    ? '<tr><td colspan="4">无任务</td></tr>'
    : data.tasks.map((task) => `<tr><td>${escapeHtml(task.id)}</td><td>${escapeHtml(task.status)}</td><td>${escapeHtml(task.title ?? '')}</td><td>${escapeHtml(task.declaredFiles.join(', '))}</td></tr>`).join('');
  const findingRows = data.findings.length === 0
    ? '<tr><td colspan="6">无 Finding</td></tr>'
    : data.findings.map((finding) => `<tr><td>${escapeHtml(finding.severity)}</td><td>${escapeHtml(finding.scope)}</td><td>${escapeHtml(finding.rule)}</td><td>${escapeHtml(finding.path ?? '')}${finding.line ? `:${escapeHtml(finding.line)}` : ''}</td><td>${escapeHtml(finding.status)}</td><td title="${escapeHtml(finding.fingerprint)}">${escapeHtml(finding.fingerprint.slice(0, 16))}…</td></tr>`).join('');
  const baselineRows = data.baselines.length === 0
    ? '<tr><td colspan="2">无基线</td></tr>'
    : data.baselines.map((baseline) => `<tr><td>v${escapeHtml(baseline.version)}</td><td>${escapeHtml(baseline.status)}</td></tr>`).join('');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ANO 只读面板</title>
<style>
body{font-family:system-ui,sans-serif;margin:1.5rem;color:#1f2328;background:#fff}
h1{font-size:1.4rem} h2{font-size:1.1rem;margin-top:1.6rem}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #d0d7de;padding:.35rem .5rem;text-align:left;font-size:.85rem;vertical-align:top}
th{background:#f6f8fa}.muted{color:#57606a}.badge{display:inline-block;border:1px solid #d0d7de;border-radius:999px;padding:.05rem .5rem;margin-right:.3rem}
</style>
</head>
<body>
<h1>Agent Nihil Obstat — 只读面板</h1>
<p class="muted">仅监听 127.0.0.1，仅 GET，无脚本，全部动态值已转义。生成时间：${escapeHtml(data.generatedAt)}</p>
<p><span class="badge">阶段 ${escapeHtml(data.project.phase)}</span><span class="badge">任务 ${escapeHtml(data.tasks.length)}</span><span class="badge">Finding ${escapeHtml(data.findings.length)}</span><span class="badge">图 ${escapeHtml(data.graph.revision || '未构建')}</span></p>
<h2>图</h2>
<table><tr><th>文件</th><th>符号</th><th>边</th><th>新鲜度</th></tr>
<tr><td>${escapeHtml(data.graph.files)}</td><td>${escapeHtml(data.graph.symbols)}</td><td>${escapeHtml(data.graph.edges)}</td><td>${escapeHtml(data.graph.freshness.status)}</td></tr></table>
<h2>任务</h2>
<table><tr><th>ID</th><th>状态</th><th>标题</th><th>声明文件</th></tr>${taskRows}</table>
<h2>审计 Finding（仅指纹与位置）</h2>
<table><tr><th>级别</th><th>范围</th><th>规则</th><th>位置</th><th>状态</th><th>指纹</th></tr>${findingRows}</table>
<h2>验收基线</h2>
<table><tr><th>版本</th><th>状态</th></tr>${baselineRows}</table>
<p class="muted">限制：本面板不批准发布、不签署 attestation、不显示明文秘密。</p>
</body>
</html>`;
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader('Content-Security-Policy', UI_CSP);
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Cache-Control', 'no-store');
}

export function isLoopbackHostHeader(host: string | undefined): boolean {
  if (!host) return false;
  try {
    const parsed = new URL(`http://${host}`);
    return parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
  } catch { return false; }
}

async function handle(root: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
  setSecurityHeaders(response);
  if (!isLoopbackHostHeader(request.headers.host)) {
    response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Forbidden host\n');
    return;
  }
  if (request.method !== 'GET') {
    response.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET' });
    response.end('Method not allowed\n');
    return;
  }
  if ((request.url ?? '').length > 2048) {
    response.writeHead(414, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('URI too long\n');
    return;
  }
  let path: string;
  try { path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname; }
  catch {
    response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Bad request\n');
    return;
  }
  if (path !== '/' && path !== '/export.json') {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found\n');
    return;
  }
  let data: ExportSnapshot;
  try { data = await exportProject(root); }
  catch {
    response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Export failed\n');
    return;
  }
  if (path === '/export.json') {
    const body = jsonForHtml(data);
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    response.end(body);
    return;
  }
  const body = renderPanel(data);
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  response.end(body);
}

export interface UiServerOptions { root: string; port?: number; host?: string }
export interface UiServerHandle { server: Server; port: number; url: string; close: () => Promise<void> }

/** Loopback-only read-only UI. Any host other than 127.0.0.1 is refused before listen. */
export async function startUiServer(options: UiServerOptions): Promise<UiServerHandle> {
  if (options.host !== undefined && options.host !== UI_HOST) throw new Error(`UI must bind ${UI_HOST}; refusing ${options.host}`);
  const server = createServer((request, response) => {
    void handle(options.root, request, response).catch(() => {
      if (!response.headersSent) setSecurityHeaders(response);
      response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Internal error\n');
    });
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => { server.off('listening', onListening); reject(error); };
    const onListening = (): void => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(options.port ?? 0, UI_HOST);
  });
  const address = server.address() as AddressInfo | null;
  if (!address) throw new Error('UI server did not expose an address');
  return {
    server,
    port: address.port,
    url: `http://${UI_HOST}:${address.port}/`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
