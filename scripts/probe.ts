import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const server = process.argv[2];
if (!server) throw new Error('Usage: node scripts/probe.ts <server-path>');
const transport = new StdioClientTransport({ command: process.execPath, args: [server], stderr: 'inherit' });
const client = new Client({ name: 'ano-probe', version: '1.0.0' });
try {
  await client.connect(transport);
  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name);
  if (names.length !== 7) throw new Error(`Expected seven tools, got ${names.length}`);
  console.log(JSON.stringify({ server: 'ano', toolCount: names.length, tools: names }, null, 2));
} finally {
  await client.close();
}
