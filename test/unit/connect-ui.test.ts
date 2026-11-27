import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CONNECT_UI_CSP,
  connectTokenEquals,
  escapeHtml,
  isConnectHostAllowed,
  renderConnectPage,
} from '../../src/surface/connect-ui.ts';
import type { ConnectPageData, ConnectShellMeta } from '../../src/surface/connect-ui.ts';
import type {
  ConnectionPlan,
  ConnectionStatus,
  ConnectionSummary,
  ConnectedTask,
  ConnectIdentity,
} from '../../src/connect/types.ts';
import { deriveConnectionId } from '../../src/connect/index.ts';

function meta(overrides: Partial<ConnectShellMeta> = {}): ConnectShellMeta {
  return {
    root: '/tmp/project',
    port: 1234,
    sessionToken: 'session-token',
    csrf: 'csrf-token',
    exportToken: 'export-token',
    ...overrides,
  };
}

function plan(overrides: Partial<ConnectionPlan> = {}): ConnectionPlan {
  return {
    schema: 'ano.connect/1',
    root: '/tmp/project',
    source: 'pm-mcp',
    connectionId: 'CN-1',
    sourceDigest: 'd'.repeat(64),
    files: [],
    excluded: [{ path: 'index.db', reason: 'derived-cache', bytes: 4096 }],
    counts: {
      files: 1,
      totalBytes: 2,
      textFiles: 1,
      binaryFiles: 0,
      excluded: 1,
      excludedBytes: 4096,
      records: 1,
      tasks: 1,
    },
    warnings: ['<warn>'],
    capabilities: ['read', 'recall', 'export'],
    canConnect: true,
    identity: {
      tool: 'pm-mcp',
      instance: '<instance>',
      project: '<project>',
      projectId: 'p<',
      projectKey: '/tmp/project',
    },
    ...overrides,
  } as ConnectionPlan;
}

function summary(overrides: Partial<ConnectionSummary> = {}): ConnectionSummary {
  return {
    connectionId: 'CN-1',
    source: 'pm-mcp',
    sourceDigest: 'e'.repeat(64),
    currentVersion: 2,
    versionCount: 3,
    snapshotPath: '.ano/connect/snapshots/CN-1/e.json',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    files: 1,
    tasks: 1,
    recordCounts: { task: 1 },
    ...overrides,
  } as ConnectionSummary;
}

function task(overrides: Partial<ConnectedTask> = {}): ConnectedTask {
  return {
    id: 'x',
    sourceId: '<source>',
    title: '<script>alert(1)</script>',
    status: 'done',
    category: 'completed',
    verification: 'unverified',
    sourcePath: 'tasks.json',
    raw: {},
    identity: {},
    ...overrides,
  } as ConnectedTask;
}

function status(overrides: Partial<ConnectionStatus> = {}): ConnectionStatus {
  return {
    schema: 'ano.connect/1',
    connected: false,
    root: '/tmp/project',
    source: 'pm-mcp',
    connections: [],
    tasks: [],
    recordCounts: {},
    excluded: [],
    warnings: [],
    untrusted: true,
    notice: '<notice>',
    ...overrides,
  } as ConnectionStatus;
}

function pageData(overrides: Partial<ConnectPageData> = {}): ConnectPageData {
  return {
    ...meta(),
    plan: plan(),
    planError: null,
    status: status(),
    statusError: null,
    readiness: null,
    ...overrides,
  };
}

test('escapeHtml encodes every dangerous character', () => {
  assert.equal(escapeHtml(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
  assert.equal(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(escapeHtml(0), '0');
  assert.equal(escapeHtml(null), 'null');
  assert.equal(escapeHtml(undefined), 'undefined');
});

test('isConnectHostAllowed accepts only the exact loopback host and actual port', () => {
  assert.equal(isConnectHostAllowed('127.0.0.1:1234', 1234), true);
  assert.equal(isConnectHostAllowed('127.0.0.1:1235', 1234), false);
  assert.equal(isConnectHostAllowed('localhost:1234', 1234), false);
  assert.equal(isConnectHostAllowed('127.0.0.1', 1234), false);
  assert.equal(isConnectHostAllowed('127.0.0.1:1234 ', 1234), false);
  assert.equal(isConnectHostAllowed('http://127.0.0.1:1234', 1234), false);
  assert.equal(isConnectHostAllowed(undefined, 1234), false);
  assert.equal(isConnectHostAllowed('', 1234), false);
});

test('connectTokenEquals is exact, length-agnostic and constant-time shaped', () => {
  assert.equal(connectTokenEquals('a', 'a'), true);
  assert.equal(connectTokenEquals('a', 'b'), false);
  assert.equal(connectTokenEquals('', 'a'), false);
  assert.equal(connectTokenEquals('a'.repeat(200), 'a'.repeat(200)), true);
  assert.equal(connectTokenEquals('a'.repeat(200), `${'a'.repeat(199)}b`), false);
});

test('renderConnectPage puts the product summary and CTA first, escapes everything, and hides debug in details', () => {
  const html = renderConnectPage(pageData());

  // First-screen product copy and CTA.
  assert.match(html, /原 pm-mcp 工具继续使用/);
  assert.match(html, /历史“已完成”≠ ANO 验收/);
  assert.match(html, /来源与项目/);
  assert.match(html, /pm-mcp（PM 项目）/);
  assert.match(html, /待导入任务/);
  assert.match(html, /历史已接入任务/);
  assert.match(html, /<td>未接入<\/td>/);
  assert.match(html, /<button type="submit">开始使用<\/button>/);
  assert.match(html, /action="\/session\/session-token\/connect"/);
  assert.match(html, /name="_csrf" value="csrf-token"/);
  assert.match(html, /name="expectedDigest" value="d{64}"/);
  assert.match(html, /href="\/session\/session-token\/"/);
  assert.match(html, /href="\/session\/session-token\/export\/export-token"/);

  // Excluded entries are explicit, including in the summary and the details list.
  assert.match(html, /排除项/);
  assert.match(html, /1 个 \/ 4096 字节（可重建派生缓存，不计入摘要）/);
  assert.match(html, /排除清单（1）/);
  assert.match(html, /<td>index\.db<\/td><td>可重建派生缓存<\/td><td>4096<\/td>/);

  // Technical values are escaped and live inside <details>.
  assert.match(html, /<details>/);
  assert.match(html, /<summary>技术详情<\/summary>/);
  assert.match(html, /&lt;warn&gt;/);
  assert.match(html, /&lt;notice&gt;/);
  assert.match(html, /&lt;project&gt;/);
  assert.match(html, /&lt;instance&gt;/);
  assert.doesNotMatch(html, /<script/i);
});

test('renderConnectPage shows Chinese business status, raw status and the unverified label', () => {
  const html = renderConnectPage(
    pageData({
      status: status({ connected: true, connections: [summary()], tasks: [task()] }),
    }),
  );
  assert.match(html, /<td>已接入 v2<\/td>/);
  assert.match(html, /<td>2（共 3 版）<\/td>/);
  assert.match(html, /<span class="tag">已完成<\/span>/);
  assert.match(html, /<small class="muted">done<\/small>/);
  assert.match(html, /<td>未验证<\/td>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /历史完成不等于 ANO 验收/);
  assert.match(html, /<button type="submit">刷新接入<\/button>/);
});

test('connected summary selects the active connection by identity, not connections[0]', () => {
  const activeIdentity = {
    tool: 'pm-mcp',
    instance: 'inst',
    project: 'p',
    projectId: 'pid',
    projectKey: '/tmp/project',
  } as ConnectIdentity;
  const activeId = deriveConnectionId(activeIdentity);
  const connections = [
    summary({ connectionId: 'CN-other', currentVersion: 1, versionCount: 1 }),
    summary({ connectionId: activeId, currentVersion: 5, versionCount: 7 }),
  ];
  const html = renderConnectPage(
    pageData({ status: status({ connected: true, connections, identity: activeIdentity }) }),
  );
  assert.match(html, /<td>已接入 v5<\/td>/);
  assert.match(html, /<td>5（共 7 版）<\/td>/);
  assert.doesNotMatch(html, /<td>已接入 v1<\/td>/);
});

test('renderConnectPage prefers the original display name over the slug', () => {
  const identity = {
    tool: 'pm-mcp',
    instance: 'i',
    project: 'connect',
    projectId: 'p',
    projectKey: '/tmp/project',
    displayName: 'Connect 演示项目',
  } as ConnectIdentity;
  const html = renderConnectPage(pageData({ plan: plan({ identity }) }));
  assert.match(html, /<td>Connect 演示项目<\/td>/);
  assert.match(html, /<td>connect<\/td>/);
});

test('renderConnectPage maps other business statuses to Chinese', () => {
  const tasks = [
    task({ sourceId: 'a', category: 'todo', status: 'todo' }),
    task({ sourceId: 'b', category: 'in_progress', status: 'in-progress' }),
    task({ sourceId: 'c', category: 'cancelled', status: 'canceled' }),
    task({ sourceId: 'd', category: 'unknown', status: 'weird' }),
  ];
  const html = renderConnectPage(pageData({ status: status({ connected: true, tasks }) }));
  assert.match(html, /<span class="tag">待办<\/span>/);
  assert.match(html, /<span class="tag">进行中<\/span>/);
  assert.match(html, /<span class="tag">已取消<\/span>/);
  assert.match(html, /<span class="tag">未知<\/span>/);
});

test('renderConnectPage shows a visible truncation note above 50 tasks', () => {
  const tasks = Array.from({ length: 51 }, (_, index) => task({ sourceId: `T-${index}`, title: `task ${index}` }));
  const html = renderConnectPage(pageData({ status: status({ connected: true, tasks }) }));
  assert.match(html, /共 51 条任务，仅显示前 50 条。/);
  assert.match(html, /<td>T-49<\/td>/);
  assert.doesNotMatch(html, /<td>T-50<\/td>/);
});

test('renderConnectPage keeps a friendly no-source state without rendering a form', () => {
  const html = renderConnectPage(
    pageData({ plan: null, planError: '<boom>', status: status({ connected: false, tasks: [], connections: [] }) }),
  );
  assert.match(html, /未检测到可用的 PM 源：&lt;boom&gt;/);
  assert.doesNotMatch(html, /<button type="submit">/);
  assert.doesNotMatch(html, /action="\/session\/session-token\/connect"/);
});

test('CONNECT_UI_CSP allows same-origin forms but no scripts', () => {
  assert.match(CONNECT_UI_CSP, /script-src 'none'/);
  assert.match(CONNECT_UI_CSP, /form-action 'self'/);
  assert.match(CONNECT_UI_CSP, /frame-ancestors 'none'/);
});
