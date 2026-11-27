import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import type { ConnectServerHandle } from '../../src/surface/connect-ui.ts';
import { CONNECT_UI_CSP, startConnectServer } from '../../src/surface/connect-ui.ts';
import { startUiServer, UI_CSP } from '../../src/surface/ui.ts';

interface PmOptions {
  name?: string;
  tasks?: Array<Record<string, unknown>>;
  extra?: Record<string, string>;
}

async function makePmRoot(options: PmOptions = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ano connect ui '));
  await mkdir(join(root, '.pm'), { recursive: true });
  await writeFile(
    join(root, '.pm', 'project.json'),
    JSON.stringify({ name: options.name ?? 'Fixture Project', version: '0.1.0' }),
  );
  await writeFile(
    join(root, '.pm', 'tasks.json'),
    JSON.stringify({
      tasks: options.tasks ?? [
        { id: 'T-001', title: 'First task', status: 'done' },
        { id: 'T-002', title: 'Second task', status: 'in_progress' },
      ],
    }),
  );
  for (const [relative, content] of Object.entries(options.extra ?? {})) {
    const full = join(root, '.pm', relative);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  }
  return root;
}

function hiddenField(html: string, name: string): string {
  const match = new RegExp(`name="${name}" value="([^"]*)"`).exec(html);
  if (!match || match[1] === undefined) throw new Error(`missing form field ${name}`);
  return match[1];
}

function exportPath(html: string): string {
  const match = /href="(\/session\/[^"]+\/export\/[^"]+)"/.exec(html);
  if (!match || match[1] === undefined) throw new Error('missing export href');
  return match[1];
}

function sessionPath(handle: ConnectServerHandle): string {
  return new URL(handle.url).pathname;
}

function sessionToken(handle: ConnectServerHandle): string {
  const segments = sessionPath(handle).split('/').filter(Boolean);
  const token = segments[1];
  if (token === undefined) throw new Error('missing session token');
  return token;
}

function originFor(base: { url: string }): string {
  return new URL(base.url).origin;
}

function urlOf(handle: ConnectServerHandle, path: string): string {
  return `http://127.0.0.1:${handle.port}${path}`;
}

async function postConnect(
  handle: ConnectServerHandle,
  fields: Record<string, string>,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${handle.url}connect`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: originFor(handle),
      ...headers,
    },
    body: new URLSearchParams(fields).toString(),
  });
}

function rawRequest(port: number, requestLine: string, headers: Record<string, string> = {}, body = ''): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      const lines = [
        requestLine,
        ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
        'Connection: close',
        '',
        '',
      ];
      socket.write(lines.join('\r\n') + body);
    });
    let data = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      data += chunk;
    });
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
  });
}

async function indexHtml(handle: ConnectServerHandle): Promise<string> {
  const response = await fetch(handle.url);
  assert.equal(response.status, 200);
  return response.text();
}

test('returned url carries a session credential; startup and GET / + /status stay read-only', async () => {
  const root = await makePmRoot();
  const handle = await startConnectServer({ root });
  try {
    assert.match(handle.url, /^http:\/\/127\.0\.0\.1:\d+\/session\/[^/]+\/$/);
    assert.equal(existsSync(join(root, '.ano')), false);

    const html = await indexHtml(handle);
    assert.match(html, /原 pm-mcp 工具继续使用/);
    assert.match(html, /历史“已完成”≠ ANO 验收/);
    assert.match(html, /来源与项目/);
    assert.match(html, /pm-mcp（PM 项目）/);
    assert.match(html, /<button type="submit">开始使用<\/button>/);
    assert.match(html, /action="\/session\/[^/]+\/connect"/);
    assert.doesNotMatch(html, /<script/i);
    assert.equal(existsSync(join(root, '.ano')), false);

    const status = await fetch(`${handle.url}status`);
    assert.equal(status.status, 200);
    assert.equal(status.headers.get('content-security-policy'), CONNECT_UI_CSP);
    assert.equal(status.headers.get('cache-control'), 'no-store');
    assert.equal(status.headers.get('referrer-policy'), 'same-origin');
    const payload = (await status.json()) as Record<string, unknown>;
    assert.equal(payload.connected, false);
    assert.equal(payload.root, root);
    assert.equal(typeof payload.sourceDigest, 'string');
    assert.equal(existsSync(join(root, '.ano')), false);
  } finally {
    await handle.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('unauthorized requests get a generic 401 with no root, title, session, CSRF or export token', async () => {
  const root = await makePmRoot({ name: 'Secret Project Name' });
  const handle = await startConnectServer({ root });
  try {
    const html = await indexHtml(handle);
    const session = sessionToken(handle);
    const csrf = hiddenField(html, '_csrf');
    const exportToken = exportPath(html).split('/').pop() ?? '';

    const paths = [
      '/',
      '/status',
      '/connect',
      '/export',
      '/export/whatever',
      '/session/',
      '/session/wrong/',
      '/session/wrong/status',
      '/session/wrong/export/whatever',
      '/nope',
    ];
    for (const path of paths) {
      const response = await fetch(urlOf(handle, path));
      assert.equal(response.status, 401, path);
      const text = await response.text();
      assert.equal(text.includes(root), false, `${path} leaked root`);
      assert.equal(text.includes(session), false, `${path} leaked session token`);
      assert.equal(text.includes(csrf), false, `${path} leaked csrf token`);
      assert.equal(text.includes(exportToken), false, `${path} leaked export token`);
      assert.equal(text.includes('Secret Project Name'), false, `${path} leaked project`);
      assert.doesNotMatch(text, /ANO Connect|Connect 向导|PM 已检测/);
    }

    const post = await fetch(urlOf(handle, '/connect'), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: originFor(handle) },
      body: new URLSearchParams({ _csrf: csrf, expectedDigest: 'x' }).toString(),
    });
    assert.equal(post.status, 401);
    assert.equal((await post.text()).includes(csrf), false);

    const unknown = await fetch(urlOf(handle, `${sessionPath(handle)}nope`));
    assert.equal(unknown.status, 404);
  } finally {
    await handle.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('one-key HTTP flow connects, shows Chinese business status + unverified, and is idempotent', async () => {
  const root = await makePmRoot({
    tasks: [
      { id: 'T-100', title: 'Ship it', status: 'done' },
      { id: 'T-101', title: 'Keep going', status: 'in_progress' },
    ],
  });
  const handle = await startConnectServer({ root });
  try {
    const html = await indexHtml(handle);
    const csrf = hiddenField(html, '_csrf');
    const digest = hiddenField(html, 'expectedDigest');

    const first = await postConnect(handle, { _csrf: csrf, expectedDigest: digest });
    assert.equal(first.status, 200);
    const firstHtml = await first.text();
    assert.match(firstHtml, /data-connected="true"/);
    assert.match(firstHtml, /data-duplicate="false"/);
    assert.match(firstHtml, /接入成功/);
    assert.equal(existsSync(join(root, '.ano', 'connect', 'current.json')), true);

    const after = await indexHtml(handle);
    assert.match(after, /Ship it/);
    assert.match(after, /Keep going/);
    assert.match(after, /<span class="tag">已完成<\/span>/);
    assert.match(after, /<small class="muted">done<\/small>/);
    assert.match(after, /<span class="tag">进行中<\/span>/);
    assert.match(after, /<td>未验证<\/td>/);
    assert.match(after, /历史已接入任务/);
    assert.match(after, /历史完成不等于 ANO 验收/);
    assert.match(after, /<button type="submit">刷新接入<\/button>/);

    const second = await postConnect(handle, { _csrf: csrf, expectedDigest: digest });
    assert.equal(second.status, 200);
    const secondHtml = await second.text();
    assert.match(secondHtml, /data-connected="true"/);
    assert.match(secondHtml, /data-duplicate="true"/);
    assert.match(secondHtml, /幂等/);
  } finally {
    await handle.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('stale expectedDigest fails friendly, then re-preflight succeeds at version 2', async () => {
  const root = await makePmRoot();
  const handle = await startConnectServer({ root });
  try {
    const html = await indexHtml(handle);
    const csrf = hiddenField(html, '_csrf');
    const stale = hiddenField(html, 'expectedDigest');

    const first = await postConnect(handle, { _csrf: csrf, expectedDigest: stale });
    assert.equal(first.status, 200);
    assert.match(await first.text(), /data-version="1"/);

    await writeFile(
      join(root, '.pm', 'tasks.json'),
      JSON.stringify({
        tasks: [
          { id: 'T-001', title: 'First task', status: 'done' },
          { id: 'T-002', title: 'Second task', status: 'in_progress' },
          { id: 'T-003', title: 'New task', status: 'todo' },
        ],
      }),
    );

    const stalePost = await postConnect(handle, { _csrf: csrf, expectedDigest: stale });
    assert.equal(stalePost.status, 200);
    const staleHtml = await stalePost.text();
    assert.match(staleHtml, /data-connected="false"/);
    assert.match(staleHtml, /data-source-unchanged="false"/);
    assert.match(staleHtml, /source-changed/);
    assert.match(staleHtml, /返回向导刷新预检/);

    const refreshed = await indexHtml(handle);
    const freshDigest = hiddenField(refreshed, 'expectedDigest');
    assert.notEqual(freshDigest, stale);

    const second = await postConnect(handle, { _csrf: csrf, expectedDigest: freshDigest });
    const secondHtml = await second.text();
    assert.match(secondHtml, /data-connected="true"/);
    assert.match(secondHtml, /data-version="2"/);
  } finally {
    await handle.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('request root/query/path cannot override the fixed server root', async () => {
  const root = await makePmRoot({ name: 'Real Project' });
  const other = await makePmRoot({ name: 'Other Project' });
  const handle = await startConnectServer({ root });
  try {
    const html = await indexHtml(handle);
    const csrf = hiddenField(html, '_csrf');
    const digest = hiddenField(html, 'expectedDigest');

    const response = await fetch(`${handle.url}connect?root=${encodeURIComponent(other)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: originFor(handle) },
      body: new URLSearchParams({
        _csrf: csrf,
        expectedDigest: digest,
        root: other,
        path: other,
      }).toString(),
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /data-connected="true"/);

    assert.equal(existsSync(join(other, '.ano')), false);
    assert.equal(existsSync(join(root, '.ano', 'connect', 'current.json')), true);
  } finally {
    await handle.close();
    await rm(root, { recursive: true, force: true });
    await rm(other, { recursive: true, force: true });
  }
});

test('oversized body is 413 and non-form content type is 415', async () => {
  const root = await makePmRoot();
  const handle = await startConnectServer({ root });
  try {
    const tooLarge = await fetch(`${handle.url}connect`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: originFor(handle) },
      body: 'a'.repeat(20_000),
    });
    assert.equal(tooLarge.status, 413);

    const wrongType = await fetch(`${handle.url}connect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: originFor(handle) },
      body: '{}',
    });
    assert.equal(wrongType.status, 415);
  } finally {
    await handle.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('POST requires a per-process CSRF token and a matching Origin or Referer', async () => {
  const root = await makePmRoot();
  const handle = await startConnectServer({ root });
  try {
    const html = await indexHtml(handle);
    const csrf = hiddenField(html, '_csrf');
    const digest = hiddenField(html, 'expectedDigest');

    const noOrigin = await fetch(`${handle.url}connect`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: csrf, expectedDigest: digest }).toString(),
    });
    assert.equal(noOrigin.status, 403);

    const wrongOrigin = await postConnect(handle, { _csrf: csrf, expectedDigest: digest }, { origin: 'http://evil.example' });
    assert.equal(wrongOrigin.status, 403);

    const wrongCsrf = await postConnect(handle, { _csrf: 'not-the-token', expectedDigest: digest });
    assert.equal(wrongCsrf.status, 403);

    const refererOnly = await fetch(`${handle.url}connect`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', referer: handle.url },
      body: new URLSearchParams({ _csrf: csrf, expectedDigest: digest }).toString(),
    });
    assert.equal(refererOnly.status, 200);
    assert.match(await refererOnly.text(), /data-connected="true"/);
  } finally {
    await handle.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Origin null is accepted only for same-origin document navigations with valid CSRF', async () => {
  const root = await makePmRoot();
  const handle = await startConnectServer({ root });
  try {
    const html = await indexHtml(handle);
    const csrf = hiddenField(html, '_csrf');
    const digest = hiddenField(html, 'expectedDigest');
    const body = new URLSearchParams({ _csrf: csrf, expectedDigest: digest }).toString();
    const requestPath = `${sessionPath(handle)}connect`;
    const navigationHeaders = {
      Host: `127.0.0.1:${handle.port}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': String(Buffer.byteLength(body)),
      Origin: 'null',
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Dest': 'document',
    };

    const accepted = await rawRequest(handle.port, `POST ${requestPath} HTTP/1.1`, navigationHeaders, body);
    assert.match(accepted, /^HTTP\/1\.1 200/);
    assert.match(accepted, /data-connected="true"/);

    const missingMetadata = await rawRequest(
      handle.port,
      `POST ${requestPath} HTTP/1.1`,
      {
        Host: `127.0.0.1:${handle.port}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': String(Buffer.byteLength(body)),
        Origin: 'null',
      },
      body,
    );
    assert.match(missingMetadata, /^HTTP\/1\.1 403/);

    const crossSiteMetadata = await rawRequest(
      handle.port,
      `POST ${requestPath} HTTP/1.1`,
      { ...navigationHeaders, 'Sec-Fetch-Site': 'cross-site' },
      body,
    );
    assert.match(crossSiteMetadata, /^HTTP\/1\.1 403/);

    const invalidCsrfBody = new URLSearchParams({ _csrf: 'not-the-token', expectedDigest: digest }).toString();
    const invalidCsrf = await rawRequest(
      handle.port,
      `POST ${requestPath} HTTP/1.1`,
      { ...navigationHeaders, 'Content-Length': String(Buffer.byteLength(invalidCsrfBody)) },
      invalidCsrfBody,
    );
    assert.match(invalidCsrf, /^HTTP\/1\.1 403/);
  } finally {
    await handle.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Host must match 127.0.0.1 and the actual bound port exactly', async () => {
  const root = await makePmRoot();
  const handle = await startConnectServer({ root });
  try {
    const good = await rawRequest(handle.port, `GET ${sessionPath(handle)} HTTP/1.1`, {
      Host: `127.0.0.1:${handle.port}`,
    });
    assert.match(good, /^HTTP\/1\.1 200/);

    const wrongPort = await rawRequest(handle.port, `GET ${sessionPath(handle)} HTTP/1.1`, {
      Host: `127.0.0.1:${handle.port + 1}`,
    });
    assert.match(wrongPort, /^HTTP\/1\.1 403/);

    const rebinding = await rawRequest(handle.port, `GET ${sessionPath(handle)} HTTP/1.1`, {
      Host: 'evil.example',
    });
    assert.match(rebinding, /^HTTP\/1\.1 403/);

    const localhost = await rawRequest(handle.port, `GET ${sessionPath(handle)} HTTP/1.1`, {
      Host: `localhost:${handle.port}`,
    });
    assert.match(localhost, /^HTTP\/1\.1 403/);

    const traversal = await rawRequest(handle.port, 'GET /../../etc/passwd HTTP/1.1', {
      Host: `127.0.0.1:${handle.port}`,
    });
    assert.match(traversal, /^HTTP\/1\.1 401/);
  } finally {
    await handle.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('export needs both the session path and the independent export token', async () => {
  const root = await makePmRoot();
  const handle = await startConnectServer({ root });
  try {
    const html = await indexHtml(handle);
    const exportLink = exportPath(html);
    const exportToken = exportLink.split('/').pop() ?? '';

    assert.equal((await fetch(urlOf(handle, '/export'))).status, 401);
    assert.equal((await fetch(urlOf(handle, `/export/${exportToken}`))).status, 401);
    assert.equal((await fetch(urlOf(handle, `${sessionPath(handle)}export`))).status, 401);
    assert.equal((await fetch(urlOf(handle, `${sessionPath(handle)}export/wrong`))).status, 401);
    assert.equal((await fetch(urlOf(handle, exportLink))).status, 404);

    const csrf = hiddenField(html, '_csrf');
    const digest = hiddenField(html, 'expectedDigest');
    const connect = await postConnect(handle, { _csrf: csrf, expectedDigest: digest });
    assert.equal(connect.status, 200);

    const download = await fetch(urlOf(handle, exportLink));
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('cache-control'), 'no-store');
    assert.match(download.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
    assert.equal(download.headers.get('access-control-allow-origin'), null);
    assert.match(download.headers.get('content-disposition') ?? '', /attachment/);

    const bundle = (await download.json()) as Record<string, unknown>;
    assert.equal(bundle.schema, 'ano.connect-export/1');
    const tasks = bundle.tasks as Array<Record<string, unknown>>;
    assert.equal(tasks.some((task) => task.verification === 'unverified'), true);

    const statusText = await (await fetch(`${handle.url}status`)).text();
    assert.doesNotMatch(statusText, new RegExp(exportToken));
  } finally {
    await handle.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('imported content is HTML-escaped and never emitted as executable markup', async () => {
  const root = await makePmRoot({
    tasks: [
      { id: 'T-X', title: '<img src=x onerror=alert(1)>', status: 'done' },
      { id: 'T-Y', title: '</script><script>alert(2)</script>', status: 'todo' },
    ],
  });
  const handle = await startConnectServer({ root });
  try {
    const html = await indexHtml(handle);
    const csrf = hiddenField(html, '_csrf');
    const digest = hiddenField(html, 'expectedDigest');
    const connect = await postConnect(handle, { _csrf: csrf, expectedDigest: digest });
    assert.equal(connect.status, 200);

    const after = await indexHtml(handle);
    assert.doesNotMatch(after, /<img src=x onerror=alert\(1\)>/);
    assert.match(after, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.doesNotMatch(after, /<script>alert\(2\)<\/script>/);
    assert.match(after, /&lt;\/script&gt;&lt;script&gt;alert\(2\)&lt;\/script&gt;/);
    assert.doesNotMatch(after, /<script/i);
  } finally {
    await handle.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('non-GET/POST methods and unknown session routes are rejected', async () => {
  const root = await makePmRoot();
  const handle = await startConnectServer({ root });
  try {
    const del = await fetch(handle.url, { method: 'DELETE' });
    assert.equal(del.status, 405);
    assert.equal(del.headers.get('allow'), 'GET, POST');

    const postHome = await fetch(handle.url, { method: 'POST', headers: { origin: originFor(handle) }, body: '' });
    assert.equal(postHome.status, 405);

    const unknown = await fetch(urlOf(handle, `${sessionPath(handle)}nope`));
    assert.equal(unknown.status, 404);

    const getConnect = await fetch(`${handle.url}connect`);
    assert.equal(getConnect.status, 405);

    const postStatus = await fetch(`${handle.url}status`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: originFor(handle) },
      body: '',
    });
    assert.equal(postStatus.status, 405);
  } finally {
    await handle.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('legacy read-only UI is untouched: still GET-only and 404 for connect routes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ano legacy ui '));
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'legacy' }));
  const legacy = await startUiServer({ root });
  try {
    const post = await fetch(`${legacy.url}connect`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: originFor(legacy) },
      body: '_csrf=x&expectedDigest=y',
    });
    assert.equal(post.status, 405);

    const exportResponse = await fetch(`${legacy.url}export`);
    assert.equal(exportResponse.status, 404);

    assert.equal(UI_CSP.includes("form-action 'none'"), true);
    assert.equal(CONNECT_UI_CSP.includes("form-action 'self'"), true);
    assert.notEqual(CONNECT_UI_CSP, UI_CSP);
  } finally {
    await legacy.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('startup refuses a foreign host and an invalid root without creating .ano', async () => {
  const root = await makePmRoot();
  try {
    await assert.rejects(startConnectServer({ root, host: '0.0.0.0' }), /must bind 127\.0\.0\.1/);
    await assert.rejects(startConnectServer({ root: join(root, 'missing') }), /Project root/);
    assert.equal(existsSync(join(root, '.ano')), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
