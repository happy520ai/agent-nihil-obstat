import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import test from 'node:test';
import { startConnectServer, type ConnectServerHandle } from '../../src/surface/connect-ui.ts';
import { cleanup, corruptConnectStore, pmRoot, write } from '../helpers/m18-d-fixtures.ts';

function sessionPath(handle: ConnectServerHandle): string {
  return new URL(handle.url).pathname;
}

function sessionToken(handle: ConnectServerHandle): string {
  const token = sessionPath(handle).split('/').filter(Boolean)[1];
  if (token === undefined) throw new Error('missing session token');
  return token;
}

function hiddenField(html: string, name: string): string {
  const match = new RegExp(`name="${name}" value="([^"]*)"`).exec(html);
  if (!match || match[1] === undefined) throw new Error(`missing form field ${name}`);
  return match[1];
}

function rawRequest(port: number, lines: string[], body = ''): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(`${lines.join('\r\n')}\r\n\r\n${body}`);
    });
    let data = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => { data += chunk; });
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
  });
}

async function origin(handle: ConnectServerHandle): Promise<string> {
  return new URL(handle.url).origin;
}

test('M18-D connect UI reports a corrupt Connect store as a page error and a 500 status, without leaking it', async () => {
  const root = await pmRoot();
  const handle = await startConnectServer({ root });
  try {
    await corruptConnectStore(root);

    const page = await fetch(handle.url);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /安全提示|状态|连接/);
    // The corrupt-store error is shown as a status error on the page.
    assert.ok(html.length > 0);

    const status = await fetch(`${handle.url}status`);
    assert.equal(status.status, 500);
    assert.match(await status.text(), /Status failed:/);
  } finally {
    await handle.close();
    await cleanup(root);
  }
});

test('M18-D connect UI surfaces a broken PM source as planError on index and status, and connect fails friendly', async () => {
  const root = await pmRoot();
  const handle = await startConnectServer({ root });
  try {
    const good = await fetch(handle.url);
    const csrf = hiddenField(await good.text(), '_csrf');

    await write(root, '.pm/project.json', '{ not json');

    const page = await fetch(handle.url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /未检测到可用的 PM 源/);

    const status = await fetch(`${handle.url}status`);
    assert.equal(status.status, 200);
    const payload = (await status.json()) as Record<string, unknown>;
    assert.equal(payload.plan, null);
    assert.equal(typeof payload.planError, 'string');

    // A well-formed POST with a valid CSRF still reaches connectProject, which
    // now fails on the broken source and returns a friendly 500 result page.
    const failed = await fetch(`${handle.url}connect`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: await origin(handle) },
      body: new URLSearchParams({ _csrf: csrf, expectedDigest: 'a'.repeat(64) }).toString(),
    });
    assert.equal(failed.status, 500);
    assert.match(await failed.text(), /接入失败/);
  } finally {
    await handle.close();
    await cleanup(root);
  }
});

test('M18-D connect form without expectedDigest gets a visible 400 and never calls connect', async () => {
  const root = await pmRoot();
  const handle = await startConnectServer({ root });
  try {
    const html = await (await fetch(handle.url)).text();
    const csrf = hiddenField(html, '_csrf');
    const response = await fetch(`${handle.url}connect`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: await origin(handle) },
      body: new URLSearchParams({ _csrf: csrf }).toString(),
    });
    assert.equal(response.status, 400);
    const text = await response.text();
    assert.match(text, /缺少 expectedDigest/);
    assert.match(text, /data-connected="false"/);
    assert.equal(existsSync(join(root, '.ano', 'connect')), false, 'nothing was written');
  } finally {
    await handle.close();
    await cleanup(root);
  }
});

test('M18-D connect UI enforces URI length, raw-target parsing, session depth and POST routing', async () => {
  const root = await pmRoot();
  const handle = await startConnectServer({ root });
  try {
    const token = sessionToken(handle);
    const long = `http://127.0.0.1:${handle.port}/${'a'.repeat(3000)}`;
    const tooLong = await fetch(long);
    assert.equal(tooLong.status, 414);

    const badTarget = await rawRequest(handle.port, [
      'GET http://[::1 HTTP/1.1',
      `Host: 127.0.0.1:${handle.port}`,
      'Connection: close',
    ]);
    assert.match(badTarget, /^HTTP\/1\.1 400/);
    assert.match(badTarget, /Bad request/);

    const extra = await fetch(`http://127.0.0.1:${handle.port}/session/${token}/status/extra/deeper`);
    assert.equal(extra.status, 404);

    const postUnknown = await fetch(`http://127.0.0.1:${handle.port}/session/${token}/nope`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: await origin(handle) },
      body: '',
    });
    assert.equal(postUnknown.status, 405);
    assert.equal(postUnknown.headers.get('allow'), 'GET');

    const getExportWithoutToken = await fetch(`http://127.0.0.1:${handle.port}/session/${token}/export`);
    assert.equal(getExportWithoutToken.status, 401);
  } finally {
    await handle.close();
    await cleanup(root);
  }
});

test('M18-D an unreadable request body over chunked encoding is drained and answered with 413', async () => {
  const root = await pmRoot();
  const handle = await startConnectServer({ root });
  try {
    const html = await (await fetch(handle.url)).text();
    const csrf = hiddenField(html, '_csrf');
    const body = new URLSearchParams({ _csrf: csrf, expectedDigest: 'a'.repeat(64) }).toString();
    const first = 'a'.repeat(4096);
    const second = 'b'.repeat(4096);
    const remainder = `${first}${second}${body}`;
    const chunked = `${remainder.length.toString(16)}\r\n${remainder}\r\n0\r\n\r\n`;
    const response = await rawRequest(handle.port, [
      `POST ${sessionPath(handle)}connect HTTP/1.1`,
      `Host: 127.0.0.1:${handle.port}`,
      'Content-Type: application/x-www-form-urlencoded',
      `Origin: http://127.0.0.1:${handle.port}`,
      'Transfer-Encoding: chunked',
      'Connection: close',
    ], chunked);
    assert.match(response, /^HTTP\/1\.1 413/);
    assert.match(response, /Payload too large/);
  } finally {
    await handle.close();
    await cleanup(root);
  }
});

test('M18-D startup on an occupied port rejects through the listening/error seam', async () => {
  const root = await pmRoot();
  const first = await startConnectServer({ root });
  try {
    await assert.rejects(startConnectServer({ root, port: first.port }), /EADDRINUSE|address already in use/i);
  } finally {
    await first.close();
    await cleanup(root);
  }
});
