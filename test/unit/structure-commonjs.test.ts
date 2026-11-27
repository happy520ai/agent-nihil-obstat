import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fingerprintTree } from '../../src/core/fingerprint.ts';
import { resolveProjectScan } from '../../src/core/project-scan.ts';
import { GraphStore } from '../../src/structure/store.ts';
import { buildSnapshot, EXTRACTOR_VERSION, symbolId } from '../../src/structure/extractor.ts';
import { createTsExtractor, type CommonjsExportItem } from '../../src/structure/extractors/ts.ts';
import type { SymbolNode } from '../../src/structure/types.ts';

async function writeFixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ano structure cjs '));
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, ...path.split('/'));
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
  return root;
}

async function scanFixture(files: Record<string, string>): Promise<{ root: string; fingerprint: Awaited<ReturnType<typeof fingerprintTree>> }> {
  const root = await writeFixture(files);
  return { root, fingerprint: await fingerprintTree(root, { onError: () => 'degrade' }) };
}

function byQualified(symbols: SymbolNode[], qualifiedName: string): SymbolNode | undefined {
  return symbols.find((symbol) => symbol.qualifiedName === qualifiedName);
}

test('module.exports=[对象] 生成容器/元素/成员符号，带来源、角色与置信度', async () => {
  const extractor = await createTsExtractor();
  try {
    const result = extractor.parse('src/wecomTools.js', [
      'module.exports = [',
      '  { name: "send", id: "t1", description: "发送消息", function: function sendTool(x) { return x; } },',
      '  { name: "read", id: "t2" },',
      '];',
    ].join('\n'));
    const items = result.commonjsExports ?? [];
    const container = items.find((item) => item.qualifiedName === 'src/wecomTools.js#default');
    assert.equal(container?.role, 'export');
    assert.equal(container?.source, 'module.exports[]');
    assert.equal(container?.confidence, 'exact');
    assert.equal(container?.executable, false);
    assert.equal(container?.fieldKind, 'unknown');

    const first = items.find((item) => item.qualifiedName === 'src/wecomTools.js#default[0]');
    assert.equal(first?.name, 'send');
    assert.equal(first?.role, 'export');
    assert.equal(first?.source, 'module.exports[]');
    assert.equal(first?.confidence, 'exact');
    assert.equal(first?.metadata?.name, 'send');
    assert.equal(first?.metadata?.id, 't1');
    assert.equal(first?.metadata?.description, '发送消息');
    assert.deepEqual(first?.metadataFields, ['name', 'id', 'description']);

    const second = items.find((item) => item.qualifiedName === 'src/wecomTools.js#default[1]');
    assert.equal(second?.name, 'read');
    assert.equal(second?.confidence, 'exact');
    assert.equal(second?.metadata?.name, 'read');

    const member = (name: string, line: number): CommonjsExportItem | undefined =>
      items.find((item) => item.qualifiedName === `src/wecomTools.js#default[0].${name}` && item.startLine === line);
    assert.equal(member('name', 2)?.fieldKind, 'metadata');
    assert.equal(member('name', 2)?.executable, false);
    assert.equal(member('id', 2)?.fieldKind, 'metadata');
    assert.equal(member('description', 2)?.fieldKind, 'metadata');
    assert.equal(member('function', 2)?.fieldKind, 'executable');
    assert.equal(member('function', 2)?.executable, true);
    assert.equal(member('function', 2)?.metadata, undefined);
    // 元素 export 符号按出现顺序稳定命名，成员按对象键顺序稳定命名。
    assert.deepEqual(items.map((item) => item.qualifiedName), [
      'src/wecomTools.js#default',
      'src/wecomTools.js#default[0]',
      'src/wecomTools.js#default[0].name',
      'src/wecomTools.js#default[0].id',
      'src/wecomTools.js#default[0].description',
      'src/wecomTools.js#default[0].function',
      'src/wecomTools.js#default[1]',
      'src/wecomTools.js#default[1].name',
      'src/wecomTools.js#default[1].id',
    ]);
  } finally {
    extractor.close();
  }
});

test('module.exports={对象} 提取成员、嵌套对象，并把未知字段标 unknown', async () => {
  const extractor = await createTsExtractor();
  try {
    const result = extractor.parse('src/tools.js', [
      'module.exports = {',
      '  run: function () {},',
      '  handler: () => 1,',
      '  label: "text",',
      '  nested: { deep: function () {}, note: "n" },',
      '  ref: localFn,',
      '  missing: unknownName,',
      '  count: 3,',
      '  handler2: makeHandler(),',
      '};',
      'function localFn() {}',
    ].join('\n'));
    const items = result.commonjsExports ?? [];
    const qn = (name: string): CommonjsExportItem | undefined => items.find((item) => item.qualifiedName === `src/tools.js#default.${name}`);
    assert.equal(qn('run')?.source, 'module.exports{}');
    assert.equal(qn('run')?.role, 'member');
    assert.equal(qn('run')?.fieldKind, 'executable');
    assert.equal(qn('run')?.executable, true);
    assert.equal(qn('handler')?.fieldKind, 'executable');
    assert.equal(qn('label')?.fieldKind, 'unknown');
    assert.equal(qn('label')?.executable, false);
    assert.equal(qn('label')?.confidence, 'exact');
    assert.equal(qn('nested')?.fieldKind, 'unknown');
    assert.equal(qn('nested.deep')?.fieldKind, 'executable');
    assert.equal(qn('nested.note')?.fieldKind, 'unknown');
    assert.equal(qn('ref')?.fieldKind, 'executable');
    assert.equal(qn('ref')?.confidence, 'exact');
    assert.equal(qn('missing')?.fieldKind, 'unknown');
    assert.equal(qn('missing')?.confidence, 'inferred');
    assert.equal(qn('missing')?.executable, false);
    assert.equal(qn('count')?.fieldKind, 'unknown');
    assert.equal(qn('handler2')?.fieldKind, 'unknown');
    assert.equal(qn('handler2')?.confidence, 'inferred');
  } finally {
    extractor.close();
  }
});

test('exports.x 与 module.exports.x 生成成员符号并区分来源', async () => {
  const extractor = await createTsExtractor();
  try {
    const result = extractor.parse('src/api.js', [
      'exports.send = function send() {};',
      'exports.count = 2;',
      'exports.ref = localFn;',
      'module.exports.read = () => 1;',
    ].join('\n'));
    const items = result.commonjsExports ?? [];
    const send = items.find((item) => item.name === 'send');
    assert.equal(send?.source, 'exports.x');
    assert.equal(send?.qualifiedName, 'src/api.js#exports.send');
    assert.equal(send?.role, 'member');
    assert.equal(send?.fieldKind, 'executable');
    assert.equal(send?.confidence, 'exact');
    const count = items.find((item) => item.name === 'count');
    assert.equal(count?.source, 'exports.x');
    assert.equal(count?.fieldKind, 'unknown');
    const read = items.find((item) => item.name === 'read');
    assert.equal(read?.source, 'module.exports.x');
    assert.equal(read?.qualifiedName, 'src/api.js#exports.read');
    assert.equal(read?.fieldKind, 'executable');
  } finally {
    extractor.close();
  }
});

test('module.exports=fn 与标识符导出：可执行 exact，未知引用 inferred', async () => {
  const extractor = await createTsExtractor();
  try {
    const named = extractor.parse('src/named.js', [
      'module.exports = function main() { helper(); };',
      'function helper() {}',
    ].join('\n'));
    const namedItem = named.commonjsExports?.find((item) => item.qualifiedName === 'src/named.js#default');
    assert.equal(namedItem?.name, 'main');
    assert.equal(namedItem?.source, 'module.exports');
    assert.equal(namedItem?.role, 'export');
    assert.equal(namedItem?.fieldKind, 'executable');
    assert.equal(namedItem?.executable, true);
    assert.equal(namedItem?.confidence, 'exact');
    // 命名函数表达式不冒充模块级声明：definitions 只收真实声明，导出符号单独登记。
    assert.equal(named.definitions.some((definition) => definition.name === 'main'), false);

    const referenced = extractor.parse('src/ref.js', [
      'module.exports = localFn;',
      'function localFn() {}',
    ].join('\n'));
    const refItem = referenced.commonjsExports?.find((item) => item.qualifiedName === 'src/ref.js#default');
    assert.equal(refItem?.name, 'localFn');
    assert.equal(refItem?.fieldKind, 'executable');
    assert.equal(refItem?.confidence, 'exact');

    const unknownRef = extractor.parse('src/unknown-ref.js', 'module.exports = notDeclared;\n');
    const unknownItem = unknownRef.commonjsExports?.[0];
    assert.equal(unknownItem?.name, 'notDeclared');
    assert.equal(unknownItem?.fieldKind, 'unknown');
    assert.equal(unknownItem?.executable, false);
    assert.equal(unknownItem?.confidence, 'inferred');
  } finally {
    extractor.close();
  }
});

test('wecomTools 形态进入图后可查询 module.exports、导出项与合法成员', async () => {
  const tools = Array.from({ length: 14 }, (_, index) =>
    `  { name: "tool${index}", id: "t${index}", description: "tool ${index}", function: function tool${index}() { return ${index}; } },`
  ).join('\n');
  const source = `module.exports = [\n${tools}\n];\n`;
  const { root, fingerprint } = await scanFixture({ 'src/wecomTools.js': source });
  const { snapshot } = await buildSnapshot({ root, fingerprint });
  const fileSymbols = snapshot.symbols.filter((symbol) => symbol.file === 'src/wecomTools.js');
  assert.equal(snapshot.caveats.commonjsExports, fileSymbols.length);
  assert.ok(byQualified(fileSymbols, 'src/wecomTools.js#default'));
  for (let index = 0; index < 14; index += 1) {
    const item = byQualified(fileSymbols, `src/wecomTools.js#default[${index}]`);
    assert.equal(item?.name, `tool${index}`);
    assert.equal(item?.role, 'export');
    assert.equal(item?.source, 'module.exports[]');
    assert.equal(item?.metadata?.description, `tool ${index}`);
    assert.equal(byQualified(fileSymbols, `src/wecomTools.js#default[${index}].function`)?.executable, true);
    assert.equal(byQualified(fileSymbols, `src/wecomTools.js#default[${index}].name`)?.fieldKind, 'metadata');
  }
  // symbolId 与既有定义一致，消费方可直接按 id 查询。
  const first = byQualified(fileSymbols, 'src/wecomTools.js#default[0]');
  assert.equal(first?.id, symbolId('src/wecomTools.js', 'value', 'tool0', 'src/wecomTools.js#default[0]'));
});

test('元数据不参与调用边，真实 import/调用边保留', async () => {
  const { root, fingerprint } = await scanFixture({
    'src/helper.ts': 'export function helper(x: number): number { return x; }\n',
    'src/cjs.js': [
      "import { helper } from './helper.js';",
      "const fs = require('fs');",
      'module.exports = [ { name: "a", description: "d", function: function (x) { return helper(x); } } ];',
      'exports.meta = { name: "m" };',
    ].join('\n'),
  });
  const { snapshot } = await buildSnapshot({ root, fingerprint });
  const file = 'src/cjs.js';
  // import 边：ESM 具名导入 value-confirmed，CommonJS require 仍为动态 import 边。
  const importEdge = snapshot.edges.find((edge) => edge.from === file && edge.to === 'src/helper.ts');
  assert.equal(importEdge?.kind, 'value-confirmed');
  const requireEdge = snapshot.edges.find((edge) => edge.from === file && edge.to === 'fs');
  assert.equal(requireEdge?.label, 'dynamic_import');
  // 调用边：导出函数成员内的 helper() 解析到真实定义。
  const call = snapshot.calls?.find((edge) => edge.from === file && edge.callee === 'helper');
  assert.equal(call?.to, 'src/helper.ts');
  assert.equal(call?.provenance, 'resolved');
  assert.equal(call?.calleeQualifiedName, 'helper');
  assert.ok(call?.calleeSymbolId);
  // 元数据符号不是调用目标：不存在以 name/description 为 callee 的边。
  assert.equal(snapshot.calls?.some((edge) => edge.from === file && (edge.callee === 'name' || edge.callee === 'description')), false);
});

test('旧解析缓存因提取器版本升级失效重算，命中缓存仍带新字段', async () => {
  const { root, fingerprint } = await scanFixture({
    'src/tools.js': 'module.exports = { name: "a", run: function () {} };\n',
  });
  const first = await buildSnapshot({ root, fingerprint });
  const file = 'src/tools.js';
  assert.ok(byQualified(first.snapshot.symbols, `${file}#default.run`)?.source === 'module.exports{}');
  assert.equal(first.parsedFiles[file]?.version, EXTRACTOR_VERSION);

  // 版本不匹配：内容哈希相同也不得复用旧解析。
  const stale = await buildSnapshot({
    root,
    fingerprint,
    previous: first.snapshot,
    parsedCache: { [file]: { hash: first.parsedFiles[file]!.hash, version: 'p3-l2-v1', parsed: first.parsedFiles[file]!.parsed } },
  });
  assert.equal(stale.report.reused, 0);
  assert.equal(stale.report.parsed, 1);
  assert.equal(byQualified(stale.snapshot.symbols, `${file}#default.run`)?.source, 'module.exports{}');

  // 版本匹配：走缓存且不丢新字段。
  const reused = await buildSnapshot({ root, fingerprint, previous: first.snapshot, parsedCache: first.parsedFiles });
  assert.equal(reused.report.reused, 1);
  assert.equal(reused.report.parsed, 0);
  const cached = byQualified(reused.snapshot.symbols, `${file}#default.run`);
  assert.equal(cached?.source, 'module.exports{}');
  assert.equal(cached?.executable, true);
  assert.equal(reused.snapshot.revision, first.snapshot.revision);
});

test('旧图快照重放后符号/边/新字段一致', async () => {
  const { root, fingerprint } = await scanFixture({
    'src/helper.ts': 'export function helper(): number { return 1; }\n',
    'src/cjs.js': "const { helper } = require('./helper.js');\nmodule.exports = function main() { return helper(); };\n",
  });
  const first = await buildSnapshot({ root, fingerprint });
  const replayed = await buildSnapshot({ root, fingerprint, previous: first.snapshot, parsedCache: first.parsedFiles });
  assert.equal(replayed.snapshot.revision, first.snapshot.revision);
  assert.deepEqual(replayed.snapshot.symbols, first.snapshot.symbols);
  assert.deepEqual(replayed.snapshot.edges, first.snapshot.edges);
  assert.deepEqual(replayed.snapshot.calls, first.snapshot.calls);
  const main = byQualified(replayed.snapshot.symbols, 'src/cjs.js#default');
  assert.equal(main?.fieldKind, 'executable');
  assert.equal(main?.source, 'module.exports');
  assert.ok(replayed.snapshot.symbols.some((symbol) => symbol.name === 'main' && symbol.file === 'src/cjs.js'));
});

test('GraphStore 重开重放保持 revision 与 CJS 符号（元数据字段持久化归 T-119）', async () => {
  const root = await writeFixture({
    '.git/HEAD': 'ref: refs/heads/main\n',
    '.pm/project.json': JSON.stringify({ name: 'cjs-scan', private: true }),
    'package.json': JSON.stringify({ name: 'cjs-scan', private: true }),
    'src/tools.js': 'module.exports = { name: "a", run: function () {} };\n',
  });
  const scan = await resolveProjectScan({ startRoot: root });
  const first = await GraphStore.open(root, { scan });
  await first.build();
  const revision = first.revision;
  assert.ok(first.snapshot().symbols.some((symbol) => symbol.file === 'src/tools.js' && symbol.qualifiedName === 'src/tools.js#default.run'));
  first.close();

  const reopened = await GraphStore.open(root, { scan });
  const outcome = await reopened.ensureFresh();
  assert.equal(outcome.cache, 'hit');
  assert.equal(reopened.revision, revision);
  const symbol = reopened.snapshot().symbols.find((candidate) => candidate.file === 'src/tools.js' && candidate.qualifiedName === 'src/tools.js#default.run');
  assert.ok(symbol, 'CJS 成员符号在图重放后仍可查询');
  assert.equal(symbol?.symbolKind, 'value');
  reopened.close();
});

test('普通 TS/ESM 提取不回归：无 CJS 赋值时不产生导出角色符号', async () => {
  const extractor = await createTsExtractor();
  try {
    const result = extractor.parse('src/plain.ts', [
      "import { value } from './defs.js';",
      'export interface Shape { x: number }',
      'export const wrapped = value;',
      'export function run(): number { return wrapped; }',
    ].join('\n'));
    assert.deepEqual(result.commonjsExports, []);
    assert.deepEqual(result.namedExports.map((entry) => entry.exportName).sort(), ['Shape', 'run', 'wrapped']);
    assert.ok(result.definitions.some((definition) => definition.name === 'wrapped' && definition.kind === 'value'));
    assert.equal(result.namedExports.every((entry) => entry.kind !== 'value' || !entry.exportName.startsWith('default')), true);
  } finally {
    extractor.close();
  }

  const { root, fingerprint } = await scanFixture({
    'src/defs.ts': 'export const value = 1;\nexport interface Shape { x: number }\n',
    'src/plain.ts': "import { value } from './defs.js';\nexport const wrapped = value;\nexport function run(): number { return helper(); }\nfunction helper(): number { return wrapped; }\n",
  });
  const { snapshot } = await buildSnapshot({ root, fingerprint });
  assert.equal(snapshot.caveats.commonjsExports, 0);
  assert.equal(snapshot.symbols.some((symbol) => symbol.source !== undefined || symbol.role !== undefined), false);
  const importEdge = snapshot.edges.find((edge) => edge.from === 'src/plain.ts' && edge.to === 'src/defs.ts');
  assert.equal(importEdge?.kind, 'value-confirmed');
  const call = snapshot.calls?.find((edge) => edge.from === 'src/plain.ts' && edge.callee === 'helper');
  assert.equal(call?.provenance, 'resolved');
  assert.equal(call?.to, 'src/plain.ts');
});

test('G1: 解析成功的字面量 require 进入主口径，动态/计算 require 保持 advisory', async () => {
  const { root, fingerprint } = await scanFixture({
    'src/dep.js': 'export const d = 1;\n',
    'src/main.js': [
      "const a = require('./dep.js');",
      'const target = \'./dep.js\';',
      'const b = require(target);',
      "export const c = () => import('./dep.js');",
      'export const all = [a, b, c];',
      '',
    ].join('\n'),
  });
  const { snapshot } = await buildSnapshot({ root, fingerprint });
  // 解析成功（resolved）的字面量 CommonJS require：整模块加载=确定的依赖事实。
  const literalRequire = snapshot.edges.find((edge) => edge.from === 'src/main.js' && edge.to === 'src/dep.js' && edge.label === 'require');
  assert.ok(literalRequire, 'literal require must be an explicit edge');
  assert.equal(literalRequire.kind, 'value-confirmed');
  assert.equal(literalRequire.provenance, 'resolved');
  // 字面量动态 import() 与计算 require 不得借 G1 升级为主口径。
  const dynamicImport = snapshot.edges.find((edge) => edge.from === 'src/main.js' && edge.to === 'src/dep.js' && edge.label === 'dynamic_import');
  assert.ok(dynamicImport);
  assert.equal(dynamicImport.kind, 'unknown');
  assert.equal(dynamicImport.provenance, 'heuristic');
  assert.ok(snapshot.edges.some((edge) => edge.from === 'src/main.js' && edge.to === '<dynamic>' && edge.label === 'unresolved'));
});
