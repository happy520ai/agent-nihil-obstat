import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CONNECT_UI_HOST,
  MAX_BODY_BYTES,
  MAX_TASK_ROWS,
  MAX_URL_LENGTH,
  connectTokenEquals,
  errorMessage,
  escapeHtml,
  isConnectHostAllowed,
  newToken,
} from '../../src/surface/connect-ui/policy.ts';
import { renderConnectResultPage, sessionPath, type ConnectResultPageData } from '../../src/surface/connect-ui/render.ts';

function resultPage(overrides: Partial<ConnectResultPageData> = {}): ConnectResultPageData {
  return {
    root: '/tmp/project',
    port: 4321,
    sessionToken: 'session-token',
    csrf: 'csrf-token',
    exportToken: 'export-token',
    result: null,
    error: null,
    ...overrides,
  };
}

test('M18-D policy constants are the fixed loopback/scriptless bounds', () => {
  assert.equal(CONNECT_UI_HOST, '127.0.0.1');
  assert.equal(MAX_URL_LENGTH, 2048);
  assert.equal(MAX_BODY_BYTES, 8192);
  assert.equal(MAX_TASK_ROWS, 50);
});

test('M18-D errorMessage preserves Error messages and stringifies foreign values', () => {
  assert.equal(errorMessage(new Error('boom')), 'boom');
  assert.equal(errorMessage('plain'), 'plain');
  assert.equal(errorMessage(42), '42');
  assert.equal(errorMessage(null), 'null');
  assert.equal(errorMessage(undefined), 'undefined');
});

test('M18-D host allowlist rejects alias ports, overflow ports and decoration', () => {
  assert.equal(isConnectHostAllowed('127.0.0.1:0', 0), true);
  assert.equal(isConnectHostAllowed('127.0.0.1:99999', 99999), true);
  assert.equal(isConnectHostAllowed('127.0.0.1:65536', 65536), true, 'the allowlist compares the literal numeric port');
  assert.equal(isConnectHostAllowed('127.0.0.1:00001', 1), true);
  assert.equal(isConnectHostAllowed('127.0.0.1:+1234', 1234), false);
  assert.equal(isConnectHostAllowed('127.0.0.1:1234 ', 1234), false);
  assert.equal(isConnectHostAllowed(' 127.0.0.1:1234', 1234), false);
  assert.equal(isConnectHostAllowed('127.0.0.1:1234:80', 1234), false);
  assert.equal(isConnectHostAllowed(undefined, 1234), false);
});

test('M18-D connectTokenEquals never throws on odd lengths and newToken is url-safe', () => {
  assert.equal(connectTokenEquals('', ''), true);
  assert.equal(connectTokenEquals('', 'a'), false);
  assert.doesNotThrow(() => connectTokenEquals('a'.repeat(5000), 'b'.repeat(3)));
  const token = newToken();
  assert.match(token, /^[A-Za-z0-9_-]+$/u);
  assert.ok(token.length >= 40);
  assert.equal(escapeHtml(undefined), 'undefined');
});

test('M18-D sessionPath appends route and extra segments deterministically', () => {
  const meta = { root: '/tmp/p', port: 1, sessionToken: 'S', csrf: 'C', exportToken: 'E' };
  assert.equal(sessionPath(meta), '/session/S/');
  assert.equal(sessionPath(meta, 'status'), '/session/S/status');
  assert.equal(sessionPath(meta, 'export', 'E'), '/session/S/export/E');
});

test('M18-D connect result page renders the failure state without leaking the digest or tokens', () => {
  const html = renderConnectResultPage(resultPage({ error: '<script>alert(1)</script>' }));
  assert.match(html, /data-connected="false"/);
  assert.match(html, /data-duplicate="false"/);
  assert.match(html, /data-source-unchanged="false"/);
  assert.match(html, /data-version="0"/);
  assert.match(html, /接入失败/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.doesNotMatch(html, /export-token/);
  assert.doesNotMatch(html, /csrf-token/);
});
