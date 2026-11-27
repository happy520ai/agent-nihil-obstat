import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { toolCatalog } from '../src/surface/tool-catalog.ts';

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string; engines: { node: string } };
const expected = [
  '# 生成的工具目录',
  '',
  '<!-- 由 npm run gen-docs 生成；不要手工修改。 -->',
  '',
  `包版本：${manifest.version}；Node：${manifest.engines.node}。`,
  '',
  `MCP 工具数量：**${toolCatalog.length}**。`,
  '',
  '| 工具 | 访问 | 用途 |',
  '|---|---|---|',
  ...toolCatalog.map((tool) => `| \`${tool.name}\` | ${tool.access} | ${tool.summary} |`),
  '',
  '> 当前为本地 alpha：七工具数量不变。`track` 支持原生任务 create/update/complete/cancel/reopen（complete 必须携带已记录的 Gate evidence_id）与 connection 的预检、接入、状态、导出、接管检查，以及 PM→ANO 迁移 plan/apply/reconcile；`recall` 默认查询合成历史，source=connected 查询显式接入的 PM 历史。迁移只读 `.pm/` 并在 `.ano/ledger` 落账，不写回来源； Connect 不代表完整主写接管或双向同步；release 裁决不代替人工批准。签字、放行和同步不暴露为 MCP 工具。',
  '',
].join('\n');
const actual = await readFile(new URL('../docs/generated/tools.md', import.meta.url), 'utf8');
assert.equal(actual.replaceAll('\r\n', '\n'), expected.replaceAll('\r\n', '\n'), '生成文档过期，请运行 npm run gen-docs 并检查 diff');
console.log('Generated tool catalog is current.');
