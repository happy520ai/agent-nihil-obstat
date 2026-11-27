import { deriveConnectionId } from '../../connect/index.ts';
import type {
  ConnectionExcludedEntry,
  ConnectionPlan,
  ConnectionResult,
  ConnectionStatus,
  ConnectionSummary,
  ConnectedTask,
  ConnectIdentity,
  HandoffReadiness,
} from '../../connect/types.ts';
import { escapeHtml, MAX_TASK_ROWS } from './policy.ts';

export interface ConnectShellMeta {
  root: string;
  port: number;
  sessionToken: string;
  csrf: string;
  exportToken: string;
}

export interface ConnectPageData extends ConnectShellMeta {
  plan: ConnectionPlan | null;
  planError: string | null;
  status: ConnectionStatus | null;
  statusError: string | null;
  readiness: HandoffReadiness | null;
}

export interface ConnectResultPageData extends ConnectShellMeta {
  result: ConnectionResult | null;
  error: string | null;
}

export function sessionPath(meta: ConnectShellMeta, route = '', extra = ''): string {
  let path = `/session/${meta.sessionToken}/`;
  if (route.length > 0) path += route;
  if (extra.length > 0) path += `/${extra}`;
  return path;
}

/**
 * Prefer the core's original display name when it is available; fall back to the
 * stable slug. `displayName` is additive in the core identity, so this keeps
 * working before and after the core exposes it.
 */
function displayNameOf(identity: ConnectIdentity): string {
  const display = (identity as ConnectIdentity & { displayName?: string }).displayName;
  if (typeof display === 'string' && display.trim().length > 0) return display.trim();
  return identity.project;
}

/**
 * The active connection is the one designated by the core's current pointer.
 * `ConnectionStatus` exposes only the active snapshot's identity, so derive its
 * connectionId and match it instead of assuming `connections[0]`. If the
 * identity is unavailable and several connections exist, return null rather
 * than guessing.
 */
export function activeConnectionSummary(status: ConnectionStatus): ConnectionSummary | null {
  if (!status.connected || status.connections.length === 0) return null;
  if (status.connections.length === 1) return status.connections[0] ?? null;
  if (!status.identity) return null;
  const activeId = deriveConnectionId(status.identity);
  return status.connections.find((entry) => entry.connectionId === activeId) ?? null;
}

function row(label: string, value: unknown): string {
  return `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`;
}

function bulletList(items: readonly string[]): string {
  if (items.length === 0) return '<ul><li>无</li></ul>';
  return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
}

function businessStatus(task: ConnectedTask): string {
  switch (task.category) {
    case 'completed':
      return '已完成';
    case 'in_progress':
      return '进行中';
    case 'todo':
      return '待办';
    case 'cancelled':
      return '已取消';
    default:
      return '未知';
  }
}

function excludedRows(entries: readonly ConnectionExcludedEntry[]): string {
  if (entries.length === 0) return '<p class="muted">无排除项</p>';
  const rows = entries
    .map(
      (entry) =>
        `<tr><td>${escapeHtml(entry.path)}</td><td>${escapeHtml(entry.reason === 'derived-cache' ? '可重建派生缓存' : entry.reason)}</td><td>${escapeHtml(entry.bytes)}</td></tr>`,
    )
    .join('');
  return `<table><tr><th>路径</th><th>原因</th><th>字节</th></tr>${rows}</table>`;
}

function taskTable(tasks: readonly ConnectedTask[]): { html: string; total: number } {
  const total = tasks.length;
  const rows = tasks
    .slice(0, MAX_TASK_ROWS)
    .map(
      (task) =>
        `<tr><td>${escapeHtml(task.sourceId)}</td><td>${escapeHtml(task.title)}</td><td><span class="tag">${escapeHtml(businessStatus(task))}</span></td><td><small class="muted">${escapeHtml(task.status)}</small></td><td>未验证</td><td>${escapeHtml(task.sourcePath)}</td></tr>`,
    )
    .join('');
  const body = rows.length > 0 ? rows : '<tr><td colspan="6">无任务</td></tr>';
  return {
    html: `<table><tr><th>源 ID</th><th>标题</th><th>业务状态</th><th>原始状态</th><th>验证</th><th>来源文件</th></tr>${body}</table>`,
    total,
  };
}

function renderShell(title: string, body: string, meta: ConnectShellMeta): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
body{font-family:system-ui,sans-serif;margin:1.5rem;color:#1f2328;background:#fff;max-width:70rem}
h1{font-size:1.4rem} h2{font-size:1.1rem;margin-top:1.6rem} h3{font-size:1rem}
table{border-collapse:collapse;width:100%;margin:.5rem 0}th,td{border:1px solid #d0d7de;padding:.35rem .5rem;text-align:left;font-size:.85rem;vertical-align:top;word-break:break-all}
th{background:#f6f8fa;white-space:nowrap}
.card{border:1px solid #d0d7de;border-radius:8px;padding:1rem;margin:1rem 0}
.notice{border:1px solid #d0d7de;background:#fff8e6;padding:.6rem .8rem;border-radius:8px}
.muted{color:#57606a}.error{color:#b42318;font-weight:600}
.tag{display:inline-block;border:1px solid #d0d7de;border-radius:999px;padding:.05rem .5rem}
small{color:#57606a}
form{margin:1rem 0}button{font-size:1rem;padding:.45rem 1.2rem}
a{margin-right:1rem}
details{margin-top:1rem}summary{cursor:pointer;font-weight:600}
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<p class="muted">root：${escapeHtml(meta.root)} · 127.0.0.1:${escapeHtml(meta.port)} · 无脚本（script-src 'none'）</p>
${body}
<p><a href="${escapeHtml(sessionPath(meta))}">返回 Connect 向导</a></p>
</body>
</html>`;
}

export function renderConnectPage(data: ConnectPageData): string {
  const plan = data.plan;
  const status = data.status;
  const readiness = data.readiness;
  const connection = status !== null ? activeConnectionSummary(status) : null;
  const connected = status?.connected ?? false;
  const excluded = plan?.excluded ?? [];
  const excludedBytes = plan?.counts.excludedBytes ?? 0;
  const tasks = status?.tasks ?? [];
  const tasksView = taskTable(tasks);
  const versionLabel = connection
    ? `${connection.currentVersion}（共 ${connection.versionCount} 版）`
    : '0';

  const sourceCard = plan
    ? `<section class="card">
<h2>来源与项目</h2>
<table>
${row('来源', 'pm-mcp（PM 项目）')}
${row('项目', displayNameOf(plan.identity))}
${row('待导入任务', `${plan.counts.tasks} 条`)}
${row('历史已接入任务', `${tasks.length} 条`)}
${row('历史版本', versionLabel)}
${row('接入状态', connected ? `已接入 v${connection?.currentVersion ?? 0}` : '未接入')}
${row('排除项', excluded.length > 0 ? `${excluded.length} 个 / ${excludedBytes} 字节（可重建派生缓存，不计入摘要）` : '无')}
</table>
${
  plan.canConnect
    ? `<form method="post" action="${escapeHtml(sessionPath(data, 'connect'))}">
<input type="hidden" name="_csrf" value="${escapeHtml(data.csrf)}">
<input type="hidden" name="expectedDigest" value="${escapeHtml(plan.sourceDigest)}">
<button type="submit">${connected ? '刷新接入' : '开始使用'}</button>
</form>
<a href="${escapeHtml(sessionPath(data))}">刷新预检</a>`
    : `<p class="muted">没有可用的预检结果，<a href="${escapeHtml(sessionPath(data))}">刷新预检</a>。</p>`
}
</section>`
    : `<section class="card"><h2>来源与项目</h2><p class="error">未检测到可用的 PM 源：${escapeHtml(data.planError ?? '未知错误')}</p><p><a href="${escapeHtml(sessionPath(data))}">刷新预检</a></p></section>`;

  const taskSection = `<h2>任务</h2>
<p class="muted">${plan ? `待导入 ${plan.counts.tasks} 条` : '待导入未检测'} · 历史已接入 ${tasks.length} 条${connected ? '' : '（未接入）'}</p>
${tasksView.html}
${tasksView.total > MAX_TASK_ROWS ? `<p class="muted">共 ${tasksView.total} 条任务，仅显示前 ${MAX_TASK_ROWS} 条。</p>` : ''}
<p class="muted">业务状态由源状态映射；验证固定为“未验证”，历史完成不等于 ANO 验收。</p>`;

  const technical = `<details>
<summary>技术详情</summary>
<h3>预检</h3>
${
  plan
    ? `<table>
${row('源', plan.source)}
${row('源摘要 sourceDigest', plan.sourceDigest)}
${row('连接 ID', plan.connectionId)}
${row('文件 / 文本 / 二进制', `${plan.counts.files} / ${plan.counts.textFiles} / ${plan.counts.binaryFiles}`)}
${row('记录 / 任务', `${plan.counts.records} / ${plan.counts.tasks}`)}
${row('总字节', plan.counts.totalBytes)}
${row('可接入', plan.canConnect)}
${row('能力', plan.capabilities.join(', '))}
</table>`
    : '<p class="muted">无预检结果。</p>'
}
<h3>身份</h3>
${
  plan
    ? `<table>
${row('项目', displayNameOf(plan.identity))}
${row('项目 slug', plan.identity.project)}
${row('项目 ID', plan.identity.projectId)}
${row('项目键', plan.identity.projectKey)}
${row('实例', plan.identity.instance)}
</table>`
    : '<p class="muted">无。</p>'
}
<h3>排除清单（${excluded.length}）</h3>
${excludedRows(excluded)}
<h3>边界与限制</h3>
<ul>
<li>原 pm-mcp 工具不受本向导改动：仅创建只读快照，不回写、不删除、不重排。</li>
<li>完整接管未开放：handoff ready=false，无编辑/重排/删除，无反向写回。</li>
<li>导入任务 verification 固定为 unverified，不能据此声称 Gate 完成。</li>
<li>仅监听 127.0.0.1，仅作用于当前 root；导出含敏感原始历史且需随机 token。</li>
${(readiness?.blockers ?? []).map((blocker) => `<li>${escapeHtml(blocker)}</li>`).join('')}
</ul>
<h3>警告</h3>
${bulletList([...(plan?.warnings ?? []), ...(status?.warnings ?? [])])}
</details>`;

  const exportSection = `<h2>导出</h2>
<p><a href="${escapeHtml(sessionPath(data, 'export', data.exportToken))}" rel="noopener">下载接入导出（JSON）</a></p>
<p class="muted">该链接含本进程随机 token；导出包含原始历史内容，可能敏感，请仅在本地保存，勿分享。</p>`;

  return renderShell(
    'ANO Connect 本地向导',
    `<p class="notice">原 pm-mcp 工具继续使用；本向导只读取并生成只读快照。历史“已完成”≠ ANO 验收。</p>
${sourceCard}
${status ? `<p class="muted">安全提示：${escapeHtml(status.notice)}</p>` : ''}
${taskSection}
${technical}
${exportSection}`,
    data,
  );
}

export function renderConnectResultPage(data: ConnectResultPageData): string {
  const result = data.result;
  let content: string;
  if (result) {
    const report = result.report;
    const state = report.connected
      ? result.duplicate
        ? '接入已是最新（幂等重复）'
        : '接入成功'
      : '接入未完成';
    content = `<div id="connect-result" data-connected="${escapeHtml(report.connected)}" data-duplicate="${escapeHtml(result.duplicate)}" data-source-unchanged="${escapeHtml(result.sourceUnchanged)}" data-version="${escapeHtml(report.version)}">
<h2>${escapeHtml(state)}</h2>
</div>
<table>
${row('连接 ID', result.connectionId)}
${row('源摘要', result.sourceDigest)}
${row('版本', report.version)}
${row('文件 / 记录 / 任务', `${report.files} / ${report.records} / ${report.tasks}`)}
${row('变更 added/updated/removed', `${report.changes.added} / ${report.changes.updated} / ${report.changes.removed}`)}
${report.reason ? row('原因', report.reason) : ''}
</table>
${bulletList(report.warnings)}
<p class="muted">导入内容不可信：任务 verification=unverified；不回写 pm-mcp。</p>
<p><a href="${escapeHtml(sessionPath(data))}">返回向导刷新预检</a><a href="${escapeHtml(sessionPath(data, 'export', data.exportToken))}" rel="noopener">下载导出</a></p>`;
  } else {
    content = `<div id="connect-result" data-connected="false" data-duplicate="false" data-source-unchanged="false" data-version="0">
<h2>接入失败</h2>
</div>
<p class="error">${escapeHtml(data.error ?? '未知错误')}</p>
<p><a href="${escapeHtml(sessionPath(data))}">返回向导重新预检</a></p>`;
  }
  return renderShell('ANO Connect 接入结果', content, data);
}
