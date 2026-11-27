// Direct stdio JSON-RPC bridge to the local pm-mcp server, used when the host
// MCP client connection drops (ConnectionClosed) but orchestration must continue.
// Same server, same tools, same params as the mcp__pm-mcp__* surface.
// Usage: node scripts/orchestration/pm-bridge.mjs <tool-name> [args-json-file]
//        (args JSON read from file or stdin; result content printed to stdout)
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const toolName = process.argv[2];
const argsFile = process.argv[3];
if (!toolName) {
  console.error('Usage: node scripts/orchestration/pm-bridge.mjs <tool-name> [args-json-file]');
  process.exit(2);
}
let toolArgs = {};
if (argsFile) toolArgs = JSON.parse(readFileSync(resolve(argsFile), 'utf8'));
else if (!process.stdin.isTTY) toolArgs = JSON.parse(readFileSync(0, 'utf8'));

const PM_MCP = process.env.PM_MCP_ENTRY ?? 'D:/DevTools/pm-mcp/dist/index.js';
const child = spawn(process.execPath, [PM_MCP], { stdio: ['pipe', 'pipe', 'pipe'] });

let buffer = '';
const pending = new Map();
function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}
function nextId() { return ++rpcId; }
let rpcId = 0;

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.id !== undefined && pending.has(message.id)) {
      const { resolve: res, reject: rej } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) rej(new Error(JSON.stringify(message.error)));
      else res(message.result);
    }
  }
});
child.stderr.on('data', () => {});

function request(method, params) {
  const id = nextId();
  return new Promise((res, rej) => {
    pending.set(id, { resolve: res, reject: rej });
    send({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
  });
}

const timer = setTimeout(() => {
  console.error(`pm-bridge timeout waiting for ${toolName}`);
  child.kill();
  process.exit(3);
}, Number(process.env.PM_BRIDGE_TIMEOUT_MS ?? 120000));

try {
  const init = await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'orchestrator-bridge', version: '1.0.0' },
  });
  if (!init || !init.serverInfo) throw new Error('pm-mcp initialize failed');
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const result = await request('tools/call', { name: toolName, arguments: toolArgs });
  clearTimeout(timer);
  child.kill();
  if (result.isError) {
    const text = Array.isArray(result.content) ? result.content.map((c) => c.text ?? '').join('\n') : JSON.stringify(result);
    console.error(text);
    process.exit(1);
  }
  const text = Array.isArray(result.content) ? result.content.map((c) => c.text ?? '').join('\n') : JSON.stringify(result);
  console.log(text);
} catch (error) {
  clearTimeout(timer);
  child.kill();
  console.error(String(error));
  process.exit(1);
}
