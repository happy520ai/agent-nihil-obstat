import assert from 'node:assert/strict';
import test from 'node:test';
import { toolCatalog, toolCatalogForProfile } from '../../src/surface/tool-catalog.ts';
import { currentPins, PINNED } from '../../scripts/check-schema.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../src/surface/mcp.ts';
import { writeDefaultConfig } from '../../src/core/config.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('personal tool descriptions stay under 200 code points and explain when to call', () => {
  const personal = toolCatalogForProfile('personal');
  assert.equal(personal.length, 7);
  for (const tool of personal) {
    assert.ok(Array.from(tool.summary).length <= 200, `${tool.name}: ${String(Array.from(tool.summary).length)}`);
    assert.match(tool.summary, /时调用|前调用|先调用/u, tool.name);
  }
});

test('personal descriptions do not alter tool names, schemas or the seven-tool pin', () => {
  const full = toolCatalogForProfile('full');
  const personal = toolCatalogForProfile('personal');
  assert.deepEqual(personal.map((tool) => tool.name), full.map((tool) => tool.name));
  assert.deepEqual(personal.map((tool) => tool.input), full.map((tool) => tool.input));
  assert.deepEqual(currentPins().tools, PINNED.tools);
  assert.deepEqual(currentPins().ledgerKinds, PINNED.ledgerKinds);
});

test('personal MCP handshake still exposes exactly seven concise tools', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ano-personal-mcp-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeDefaultConfig(root);
  const server = createMcpServer(root);
  const client = new Client({ name: 'personal-description-check', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name), ['brief', 'explore', 'recall', 'track', 'note', 'verify', 'audit']);
    for (const tool of listed.tools) assert.ok(Array.from(tool.description ?? '').length <= 200);
  } finally { await client.close(); await server.close(); }
});
