import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { escapeHtml, isLoopbackHostHeader, renderPanel, startUiServer, UI_CSP } from '../../src/surface/ui.ts';
import type { ExportSnapshot } from '../../src/surface/export.ts';

function snapshot(overrides: Partial<ExportSnapshot> = {}): ExportSnapshot {
  return {
    schema: 'ano.export.v1',
    generatedAt: '2026-01-01T00:00:00.000Z',
    root: 'C:/fixture',
    project: { phase: 'P7' },
    tasks: [],
    evidence: [],
    touched: [],
    graph: {
      revision: '',
      sourceFingerprint: 'a'.repeat(64),
      freshness: { status: 'missing', stale: 0, changed: 0, added: 0, removed: 0, detail: 'not-built' } as unknown as ExportSnapshot['graph']['freshness'],
      files: 0,
      symbols: 0,
      edges: 0,
      caveats: {} as unknown as ExportSnapshot['graph']['caveats'],
    },
    findings: [],
    baselines: [],
    limitations: [],
    ...overrides,
  };
}

function rawRequest(port: number, line: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(`${line}\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`));
    let data = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => { data += chunk; });
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
  });
}

test('renderPanel renders empty collections and escapes populated values', () => {
  const empty = renderPanel(snapshot());
  assert.ok(empty.includes('无任务'));
  assert.ok(empty.includes('无 Finding'));
  assert.ok(empty.includes('无基线'));
  assert.ok(empty.includes('未构建'));

  const populated = renderPanel(snapshot({
    project: { name: '<name>', version: '1.0.0', phase: 'P7' },
    tasks: [{ id: 'T-1', status: 'done', declaredFiles: ['src/a.ts'] }, { id: 'T-2', status: 'todo', title: 'titled', declaredFiles: [] }],
    findings: [
      {
        id: 'f1', scope: 'security', rule: 'secret/x', severity: 'high', message: 'm', fingerprint: 'b'.repeat(64),
        status: 'open', path: 'src/a.ts', line: 3,
      },
      {
        id: 'f2', scope: 'license', rule: 'license/x', severity: 'low', message: 'm', fingerprint: 'c'.repeat(64),
        status: 'resolved',
      },
    ] as unknown as ExportSnapshot['findings'],
    baselines: [{ version: 1, status: 'approved' }, { version: 2, status: 'draft' }] as unknown as ExportSnapshot['baselines'],
    graph: { ...snapshot().graph, revision: 'rev-1' },
  }));
  assert.ok(populated.includes('阶段 P7'));
  assert.ok(populated.includes('titled'));
  assert.ok(populated.includes('src/a.ts:3'));
  assert.ok(populated.includes('rev-1'));
  assert.ok(populated.includes('v1'));
  assert.ok(populated.includes('v2'));
});

test('escapeHtml encodes every dangerous character and isLoopbackHostHeader rejects foreign hosts', () => {
  assert.equal(escapeHtml(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
  assert.equal(isLoopbackHostHeader(undefined), false);
  assert.equal(isLoopbackHostHeader('127.0.0.1:1234'), true);
  assert.equal(isLoopbackHostHeader('localhost:80'), true);
  assert.equal(isLoopbackHostHeader('evil.example'), false);
  assert.equal(isLoopbackHostHeader('['), false);
});

test('UI answers 414 for oversized URLs, 500 when export fails and keeps security headers', async () => {
  const missingRoot = join(await mkdtemp(join(tmpdir(), 'ano ui missing ')), 'gone');
  const handle = await startUiServer({ root: missingRoot });
  try {
    const longUrl = `http://127.0.0.1:${handle.port}/${'a'.repeat(3000)}`;
    const tooLong = await fetch(longUrl);
    assert.equal(tooLong.status, 414);

    const failed = await fetch(handle.url);
    assert.equal(failed.status, 500);
    assert.equal(await failed.text(), 'Export failed\n');
    assert.equal(failed.headers.get('content-security-policy'), UI_CSP);
    assert.equal(failed.headers.get('x-frame-options'), 'DENY');
    assert.equal(failed.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(failed.headers.get('cache-control'), 'no-store');
    assert.equal(failed.headers.get('x-content-type-options'), 'nosniff');
  } finally {
    await handle.close();
    await rm(missingRoot, { recursive: true, force: true });
  }
});

test('UI rejects an unparsable request target with 400 over a raw socket', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ano ui raw '));
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'raw-fixture' }));
  const handle = await startUiServer({ root });
  try {
    const response = await rawRequest(handle.port, 'GET http://[::1 HTTP/1.1');
    assert.match(response, /^HTTP\/1\.1 400/);
    assert.match(response, /Bad request/);
  } finally {
    await handle.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('UI refuses to start on a port in use instead of leaking an unhandled error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ano ui busy '));
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'busy-fixture' }));
  const first = await startUiServer({ root });
  try {
    await assert.rejects(startUiServer({ root, port: first.port }), /EADDRINUSE|address already in use/i);
  } finally {
    await first.close();
    await rm(root, { recursive: true, force: true });
  }
});
