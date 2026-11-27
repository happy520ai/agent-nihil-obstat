#!/usr/bin/env node
/**
 * S2 spike: web-tree-sitter stability / memory / throughput on Windows + Node 24.
 *
 * Scope: investigative prototype only. Reads only self-generated fixtures under
 * scripts/fixtures/generated/s2. No network, no host project code.
 *
 * Usage:
 *   node --expose-gc scripts/spikes/s2-tree-sitter.mjs
 *   node --expose-gc scripts/spikes/s2-tree-sitter.mjs --skip-generate
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Parser, Language } from 'web-tree-sitter';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const GEN_DIR = path.join(ROOT, 'scripts', 'fixtures', 'generated', 's2');
const EVIDENCE = path.join(ROOT, 'docs', 'evidence', 's2-tree-sitter.json');
const NM = path.join(ROOT, 'scripts', 'node_modules');

const TARGET = { small: 2000, medium: 2000, large: 1200 };
const SAMPLE_EVERY = 100;
const extCycle = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

const startedAt = new Date().toISOString();
const t0 = process.hrtime.bigint();
const log = (...a) => console.log('[s2]', ...a);

function pkgVersion(name) {
  const p = path.join(NM, name, 'package.json');
  return JSON.parse(fs.readFileSync(p, 'utf8')).version;
}

function pickExt(i) {
  return extCycle[i % extCycle.length];
}

function isTsExt(ext) {
  return ext === '.ts' || ext === '.tsx';
}

function makeSmall(i, ext) {
  const a = `const seed${i} = ${i};\n`;
  if (!isTsExt(ext)) {
    return `// small js sample ${i} 小型样例\nimport { dep${i} } from './dep${i}.js';\n` +
      `export const value${i} = ${i};\n` +
      `export function fn${i}(input) {\n  return (input?.id ?? 0) + value${i};\n}\n` +
      `export const arrow${i} = (x) => x * 2;\n` + a;
  }
  const jsx = ext === '.tsx'
    ? `export function Comp${i}(props: { title: string }) {\n  return <div className="c${i}"><span>{props.title}</span></div>;\n}\n`
    : '';
  return `// small ts sample ${i} 小型样例\nimport { dep${i} } from './dep${i}';\n` +
    `export interface Item${i} { id: number; name: string; tags?: string[]; }\n` +
    `export type Maybe${i}<T> = T | null;\n` +
    `export const value${i}: number = ${i};\n` +
    `export function fn${i}(input: Item${i}): number {\n  return input.id + value${i};\n}\n` +
    `export const arrow${i} = (x: number): number => x * 2;\n` + jsx + a;
}

function makeMedium(i, ext) {
  const ts = isTsExt(ext);
  const typeBits = ts
    ? `export type Handler${i} = (input: Item${i}) => Promise<number>;\n` +
      `export enum Kind${i} { A = 'a', B = 'b' }\n` +
      `export namespace NS${i} { export const stamp = ${i}; }\n`
    : `export const Kind${i} = Object.freeze({ A: 'a', B: 'b' });\n`;
  const jsx = ext === '.tsx'
    ? `export function View${i}(props: { items: Item${i}[] }) {\n  return (<ul>{props.items.map((it) => <li key={it.id}>{it.name}</li>)}</ul>);\n}\n`
    : ext === '.jsx'
      ? `export function View${i}(props) {\n  return (<ul>{props.items.map((it) => <li key={it.id}>{it.name}</li>)}</ul>);\n}\n`
      : '';
  const cls = ts
    ? `export class Service${i} {\n  private items: Item${i}[] = [];\n  constructor(private readonly kind: Kind${i} = Kind${i}.A) {}\n  add(item: Item${i}): this { this.items.push(item); return this; }\n  async run(handler: Handler${i}): Promise<number> {\n    let total = 0;\n    for (const item of this.items) {\n      try { total += await handler(item); } catch (err) { console.error(err); }\n    }\n    switch (this.kind) {\n      case Kind${i}.A: return total;\n      case Kind${i}.B: return total * 2;\n      default: return 0;\n    }\n  }\n}\n`
    : `export class Service${i} {\n  constructor(kind = Kind${i}.A) { this.kind = kind; this.items = []; }\n  add(item) { this.items.push(item); return this; }\n  async run(handler) {\n    let total = 0;\n    for (const item of this.items) { total += await handler(item); }\n    return total;\n  }\n}\n`;
  const reexport = ts
    ? `export { Service${i} as ServiceAlias${i} } from './service${i}';\n`
    : `export { Service${i} as ServiceAlias${i} } from './service${i}.js';\n`;
  return `// medium sample ${i} 中型样例\nimport { dep${i} } from './dep${i}';\n` +
    (ts ? `export interface Item${i} { id: number; name: string; tags?: string[]; }\n` : '') +
    typeBits + cls + reexport + jsx;
}

function makeLarge(i, ext, targetBytes) {
  const ts = isTsExt(ext);
  const jsxBlock = ext === '.tsx'
    ? `export function Shell${i}(props: { rows: { id: number }[] }) {\n  return (<section>{props.rows.map((r) => <article key={r.id}>{r.id}</article>)}</section>);\n}\n`
    : ext === '.jsx'
      ? `export function Shell${i}(props) {\n  return (<section>{props.rows.map((r) => <article key={r.id}>{r.id}</article>)}</section>);\n}\n`
      : '';
  const head = `// large sample ${i} 大型样例\n` +
    (ts ? `export interface Row${i} { id: number; value: number; label: string; }\n` : '') +
    jsxBlock +
    (ts ? `export function compute${i}(rows: Row${i}[]): number {\n` : `export function compute${i}(rows) {\n`) +
    `  let acc = 0;\n  for (const row of rows) {\n`;
  let body = '';
  let k = 0;
  // Generate class methods and statements until the target size is reached.
  let cls = ts
    ? `\nexport class Engine${i} {\n  private cache = new Map<string, number>();\n`
    : `\nexport class Engine${i} {\n  constructor() { this.cache = new Map(); }\n`;
  while (Buffer.byteLength(head + body + cls) < targetBytes) {
    if (k % 7 === 0) {
      body += `    acc += row.value * ${(k % 13) + 1} + cache${k % 20};\n`;
    } else if (k % 7 === 1) {
      body += `    const cache${k % 20} = row.label.length + ${k};\n`;
    } else if (k % 7 === 2) {
      body += `    if (row.id % ${(k % 9) + 2} === 0) { acc -= ${k % 17}; }\n`;
    } else {
      body += `    acc = (((acc + ${k % 31}) * 3) ^ ${k % 7}) | 0;\n`;
    }
    k++;
    if (k % 12 === 0) {
      cls += `  method${k}(x${ts ? ': number' : ''})${ts ? ': number' : ''} {\n` +
        `    let v = x + ${k};\n    for (let j = 0; j < 5; j++) { v = (v * 2 + j) % 100000; }\n` +
        `    this.cache.set('k${k}', v);\n    return v;\n  }\n`;
    }
  }
  cls += ts ? `  size(): number { return this.cache.size; }\n}\n` : `  size() { return this.cache.size; }\n}\n`;
  return head + body + `  }\n  return acc;\n}\n` + cls;
}

function padToTarget(content, targetBytes, i) {
  let out = content;
  let n = 0;
  while (Buffer.byteLength(out) < targetBytes) {
    out += `// padding ${i}-${n} 填充\nconst pad${i}_${n} = ${n};\nexport function padFn${i}_${n}(x) { return x + pad${i}_${n}; }\n`;
    n++;
  }
  return out;
}

function generateFixtures() {
  fs.rmSync(GEN_DIR, { recursive: true, force: true });
  const specs = [];
  let idx = 0;
  for (const [tier, count] of Object.entries(TARGET)) {
    for (let j = 0; j < count; j++, idx++) {
      const ext = pickExt(idx);
      let content;
      if (tier === 'small') content = makeSmall(idx, ext);
      else if (tier === 'medium') content = makeMedium(idx, ext);
      else content = makeLarge(idx, ext, 40000);
      if (tier === 'large') content = padToTarget(content, 40000, idx);
      const dir = path.join(GEN_DIR, tier);
      const file = path.join(dir, `f${String(idx).padStart(5, '0')}${ext}`);
      specs.push({ file, content });
    }
  }
  // 20 extra files under a CJK + space directory to exercise Windows paths.
  for (let j = 0; j < 20; j++, idx++) {
    const ext = pickExt(idx);
    const file = path.join(GEN_DIR, '中文 目录', `样例${j}${ext}`);
    specs.push({ file, content: makeSmall(idx, ext) });
  }
  for (const { file, content } of specs) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
  }
  log(`generated ${specs.length} files under ${GEN_DIR}`);
  return specs.length;
}

function walkFiles(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    for (const ent of fs.readdirSync(cur, { withFileTypes: true })) {
      const p = path.join(cur, ent.name);
      if (ent.isDirectory()) stack.push(p);
      else if (ent.isFile() && extCycle.includes(path.extname(ent.name))) out.push(p);
    }
  }
  out.sort();
  return out;
}

function grammarFor(ext) {
  if (ext === '.ts') return 'typescript';
  if (ext === '.tsx') return 'tsx';
  return 'javascript';
}

function keyFor(ext) {
  switch (ext) {
    case '.ts': return 'ts';
    case '.tsx': return 'tsx';
    default: return 'js';
  }
}

function countNodes(node) {
  const stack = [node];
  let n = 0;
  while (stack.length) {
    const cur = stack.pop();
    n++;
    for (let i = 0; i < cur.childCount; i++) stack.push(cur.child(i));
  }
  return n;
}

function memSnapshot() {
  const m = process.memoryUsage();
  return {
    rssMB: +(m.rss / 1048576).toFixed(2),
    heapUsedMB: +(m.heapUsed / 1048576).toFixed(2),
    heapTotalMB: +(m.heapTotal / 1048576).toFixed(2),
    externalMB: +(m.external / 1048576).toFixed(2),
    arrayBuffersMB: +(m.arrayBuffers / 1048576).toFixed(2),
    at: new Date().toISOString()
  };
}

function gcNow() {
  if (typeof global.gc === 'function') {
    global.gc();
    global.gc();
    return true;
  }
  return false;
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[i];
}

async function main() {
  const skipGenerate = process.argv.includes('--skip-generate');
  if (!skipGenerate) generateFixtures();
  const files = walkFiles(GEN_DIR);
  if (files.length < 5000) throw new Error(`expected >=5000 fixture files, got ${files.length}`);

  const initTiming = { baseline: memSnapshot(), steps: [] };
  let initStart = process.hrtime.bigint();
  await Parser.init({
    locateFile: (file) => path.join(NM, 'web-tree-sitter', file)
  });
  initTiming.steps.push({
    step: 'Parser.init', ms: +(Number(process.hrtime.bigint() - initStart) / 1e6).toFixed(1), mem: memSnapshot()
  });

  const languages = {};
  const parsers = {};
  const wasmInfo = {};
  for (const [key, name] of [['ts', 'typescript'], ['tsx', 'tsx'], ['js', 'javascript']]) {
    const wasmPath = path.join(NM, 'tree-sitter-wasms', 'out', `tree-sitter-${name}.wasm`);
    initStart = process.hrtime.bigint();
    const lang = await Language.load(wasmPath);
    const loadMs = +(Number(process.hrtime.bigint() - initStart) / 1e6).toFixed(1);
    languages[key] = lang;
    const parser = new Parser();
    parser.setLanguage(lang);
    parsers[key] = parser;
    wasmInfo[key] = {
      name,
      wasmPath,
      wasmBytes: fs.statSync(wasmPath).size,
      abiVersion: lang.abiVersion,
      nodeTypeCount: lang.nodeTypeCount,
      loadMs
    };
    initTiming.steps.push({ step: `Language.load(${name})`, ms: loadMs, mem: memSnapshot() });
  }

  const samples = [];
  const exceptions = [];
  const errorFiles = [];
  const perGrammar = {};
  let totalBytes = 0;
  let hasErrorCount = 0;
  const parseTimes = [];
  const parseBytes = [];
  const gcAvailable = typeof global.gc === 'function';
  const runStart = process.hrtime.bigint();

  const takeSample = (label, i) => {
    const before = memSnapshot();
    const gced = gcNow();
    const after = gced ? memSnapshot() : null;
    samples.push({ label, index: i, beforeGc: before, afterGc: after });
  };

  takeSample('start', 0);

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const ext = path.extname(file);
    const key = keyFor(ext);
    const grammar = grammarFor(ext);
    const g = (perGrammar[grammar] ??= {
      files: 0, bytes: 0, errors: 0, nodes: 0, minNodes: Infinity, maxNodes: 0, parseMs: []
    });
    const readStart = process.hrtime.bigint();
    let source;
    try {
      source = fs.readFileSync(file, 'utf8');
    } catch (err) {
      exceptions.push({ file, stage: 'read', name: err.name, message: err.message });
      continue;
    }
    const readMs = Number(process.hrtime.bigint() - readStart) / 1e6;
    totalBytes += Buffer.byteLength(source);

    let nodes = 0;
    let tree = null;
    try {
      const pStart = process.hrtime.bigint();
      tree = parsers[key].parse(source);
      const pMs = Number(process.hrtime.bigint() - pStart) / 1e6;
      if (!tree) throw new Error('parser returned null tree');
      const hasError = tree.rootNode.hasError;
      if (hasError) { hasErrorCount++; if (errorFiles.length < 20) errorFiles.push(file); }
      nodes = countNodes(tree.rootNode);
      parseTimes.push(+(readMs + pMs).toFixed(3));
      parseBytes.push(Buffer.byteLength(source));
      g.files++; g.bytes += Buffer.byteLength(source); g.nodes += nodes;
      g.minNodes = Math.min(g.minNodes, nodes);
      g.maxNodes = Math.max(g.maxNodes, nodes);
      g.parseMs.push(+pMs.toFixed(3));
      if (hasError) g.errors++;
    } catch (err) {
      exceptions.push({ file, stage: 'parse', name: err.name, message: err.message });
      g.errors++;
    } finally {
      if (tree) {
        try { tree.delete(); } catch { /* ignore */ }
      }
    }

    if ((i + 1) % SAMPLE_EVERY === 0) takeSample('progress', i + 1);
    if ((i + 1) % 1000 === 0) log(`parsed ${i + 1}/${files.length}`);
  }

  takeSample('end', files.length);
  const mainPassCompleted = files.length;
  const wallMs = Number(process.hrtime.bigint() - runStart) / 1e6;

  // Phase B: does skipping tree.delete() leak? Parse 500 small files, keep refs,
  // measure, then drop refs (no delete) and force GC to see whether WASM memory
  // is reclaimed by finalizers alone. Then explicitly delete a fresh batch.
  const phaseB = { retained: [], noDelete: {}, explicitDelete: {} };
  const smallFiles = files.filter((f) => f.includes(`${path.sep}small${path.sep}`)).slice(0, 500);
  const parseBatch = (list, keep) => {
    const trees = [];
    for (const file of list) {
      const ext = path.extname(file);
      const tree = parsers[keyFor(ext)].parse(fs.readFileSync(file, 'utf8'));
      if (keep) trees.push(tree);
      else tree?.delete();
    }
    return trees;
  };

  takeSample('phaseB-start', 0);
  phaseB.noDelete.trees = parseBatch(smallFiles, true);
  phaseB.noDelete.retainedTrees = phaseB.noDelete.trees.length;
  phaseB.noDelete.afterParseBeforeGc = memSnapshot();
  gcNow();
  phaseB.noDelete.afterGcWithRefs = memSnapshot();
  phaseB.noDelete.trees = null; // drop refs, deliberately no tree.delete()
  gcNow();
  await new Promise((r) => setTimeout(r, 50));
  gcNow();
  phaseB.noDelete.afterDropRefsGc = memSnapshot();

  takeSample('phaseB-explicit-start', 0);
  const delTrees = parseBatch(smallFiles, true);
  phaseB.explicitDelete.afterParseBeforeGc = memSnapshot();
  for (const t of delTrees) t.delete();
  gcNow();
  phaseB.explicitDelete.afterDeleteGc = memSnapshot();

  const sortedTimes = [...parseTimes].sort((a, b) => a - b);
  const sortedGcHeap = samples.filter((s) => s.afterGc).map((s) => s.afterGc.heapUsedMB);
  const idxOneQuarter = Math.max(0, Math.ceil(sortedGcHeap.length * 0.25) - 1);
  const lastHeap = sortedGcHeap[sortedGcHeap.length - 1];
  const quarterHeap = sortedGcHeap[idxOneQuarter];
  const heapGrowthMB = +(lastHeap - quarterHeap).toFixed(2);
  const rssPeak = Math.max(...samples.map((s) => Math.max(s.beforeGc.rssMB, s.afterGc?.rssMB ?? 0)));
  const heapPeak = Math.max(...samples.map((s) => Math.max(s.beforeGc.heapUsedMB, s.afterGc?.heapUsedMB ?? 0)));
  const externalPeak = Math.max(...samples.map((s) => Math.max(s.beforeGc.externalMB, s.afterGc?.externalMB ?? 0)));
  const arrayBuffersPeak = Math.max(...samples.map((s) => Math.max(s.beforeGc.arrayBuffersMB, s.afterGc?.arrayBuffersMB ?? 0)));
  const externalGrowthMB = +(externalPeak - samples.find((s) => s.afterGc)?.afterGc.externalMB).toFixed(2);

  for (const g of Object.values(perGrammar)) {
    g.parseMs.sort((a, b) => a - b);
    g.p50ParseMs = +percentile(g.parseMs, 50).toFixed(3);
    g.p95ParseMs = +percentile(g.parseMs, 95).toFixed(3);
    g.maxParseMs = +g.parseMs[g.parseMs.length - 1].toFixed(3);
    g.errorRate = +(g.errors / Math.max(1, g.files)).toFixed(6);
    delete g.parseMs;
  }

  const criteria = {
    P1_stable: {
      pass: exceptions.filter((e) => e.stage === 'parse').length === 0 && totalBytes > 0 && mainPassCompleted === files.length,
      filesCompleted: mainPassCompleted,
      filesTotal: files.length,
      parseExceptions: exceptions.filter((e) => e.stage === 'parse').length,
      allExceptions: exceptions.length
    },
    P2_smoke: {
      pass: hasErrorCount / files.length <= 0.01 &&
        Object.values(perGrammar).every((g) => g.maxNodes > 10),
      hasErrorCount,
      hasErrorRate: +(hasErrorCount / files.length).toFixed(6),
      perGrammarMaxNodes: Object.fromEntries(Object.entries(perGrammar).map(([k, v]) => [k, v.maxNodes]))
    },
    P3_boundedMemory: {
      pass: heapGrowthMB <= 32 && lastHeap <= quarterHeap * 2 && rssPeak < 1536,
      heapGrowthMbFromQuarterToEnd: heapGrowthMB,
      lastGcHeapMB: lastHeap,
      quarterGcHeapMB: quarterHeap,
      rssPeakMB: rssPeak,
      heapPeakMB: heapPeak,
      externalPeakMB: externalPeak,
      arrayBuffersPeakMB: arrayBuffersPeak,
      externalGrowthMb: externalGrowthMB,
      note: 'P3 uses JS heap growth + RSS peak; WASM linear memory shows up in external/arrayBuffers and is reported, not asserted'
    },
    P4_throughput: {
      pass: percentile(sortedTimes, 95) < 500,
      p50MsPerFile: +percentile(sortedTimes, 50).toFixed(3),
      p95MsPerFile: +percentile(sortedTimes, 95).toFixed(3),
      p99MsPerFile: +percentile(sortedTimes, 99).toFixed(3),
      maxMsPerFile: +sortedTimes[sortedTimes.length - 1].toFixed(3),
      filesPerSecond: +(files.length / (wallMs / 1000)).toFixed(2),
      mbPerSecond: +(totalBytes / 1048576 / (wallMs / 1000)).toFixed(2),
      wallMs: +wallMs.toFixed(1),
      note: 'p95 < 500ms threshold is human-set for outlier detection only; not a performance promise'
    },
    P5_leakShape: {
      explicitDeleteReduces: phaseB.explicitDelete.afterDeleteGc.heapUsedMB < phaseB.explicitDelete.afterParseBeforeGc.heapUsedMB,
      gcReclaimsWithoutDelete: phaseB.noDelete.afterDropRefsGc.heapUsedMB < phaseB.noDelete.afterGcWithRefs.heapUsedMB,
      note: 'compare heapUsed/external/arrayBuffers across phase B snapshots'
    }
  };

  const result = {
    spike: 'S2',
    status: 'measured',
    startedAt,
    finishedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      nodeExecPath: process.execPath,
      v8: process.versions.v8,
      icu: process.versions.icu,
      unicode: process.versions.unicode,
      platform: process.platform,
      arch: process.arch,
      osRelease: os.release(),
      osVersion: os.version?.() ?? null,
      cpuModel: os.cpus()?.[0]?.model ?? null,
      cpuCount: os.cpus()?.length ?? null,
      totalMemMB: Math.round(os.totalmem() / 1048576),
      exposeGc: gcAvailable,
      cwd: process.cwd(),
      note: 'Only Node 24.14.0 on Windows was measured. Results do NOT represent Node 22, Linux, or macOS.'
    },
    dependencies: {
      'web-tree-sitter': pkgVersion('web-tree-sitter'),
      'tree-sitter-wasms': pkgVersion('tree-sitter-wasms'),
      typescript: pkgVersion('typescript'),
      wasm: wasmInfo
    },
    fixtures: {
      dir: GEN_DIR,
      totalFiles: files.length,
      totalBytes,
      tiers: TARGET,
      extraCjkFiles: 20,
      extensions: Object.fromEntries(extCycle.map((e) => [e, files.filter((f) => path.extname(f) === e).length]))
    },
    measurement: {
      sampleEveryFiles: SAMPLE_EVERY,
      gcBeforeSample: gcAvailable,
      initTiming,
      samples,
      perGrammar,
      errorFiles,
      exceptions: exceptions.slice(0, 50),
      exceptionCount: exceptions.length,
      phaseB
    },
    criteria,
    verdict: {
      passed: Object.entries(criteria).filter(([k]) => k.startsWith('P') && k !== 'P5_leakShape').every(([, v]) => v.pass === true),
      failedCriteria: Object.entries(criteria).filter(([k, v]) => k.startsWith('P') && k !== 'P5_leakShape' && v.pass !== true).map(([k]) => k)
    }
  };

  fs.mkdirSync(path.dirname(EVIDENCE), { recursive: true });
  fs.writeFileSync(EVIDENCE, JSON.stringify(result, null, 2), 'utf8');
  log('criteria:', JSON.stringify(criteria, null, 2));
  log('summary:', JSON.stringify({
    files: files.length,
    hasErrorCount,
    exceptions: exceptions.length,
    filesPerSecond: criteria.P4_throughput.filesPerSecond,
    p95: criteria.P4_throughput.p95MsPerFile,
    rssPeakMB: rssPeak,
    heapGrowthMB,
    wallSec: +(wallMs / 1000).toFixed(1)
  }));
  log('evidence written to', EVIDENCE);

  for (const p of Object.values(parsers)) p.delete();
}

main().catch((err) => {
  console.error('[s2] FATAL', err);
  process.exitCode = 1;
});
