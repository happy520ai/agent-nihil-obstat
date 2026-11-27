/**
 * T-121 / SG-11: security red team and compatibility regression for the
 * ADR-010 structure-intelligence boundary.
 *
 * Scope (docs/adr/ADR-010-structure-intelligence.md §2 hard boundaries,
 * §3 revision-bound exploration evidence, §4 nine-way classification,
 * §5 risk/review inputs, §6 Gate boundary, §7 extraction contracts,
 * §8 performance budgets, §10 error codes):
 *   01 malicious AST shapes (deep nesting, long chains, unicode, `__proto__`,
 *      throwing getters, recursive generators) never execute and never crash
 *      the supported build path; unbounded shapes degrade explicitly;
 *   02 oversized object/array literals stay bounded and leave an explicit
 *      truncation/budget record instead of silently disappearing;
 *   03 circular imports / recursive require terminate;
 *   04 scope-depth explosion past MAX_SCOPE_DEPTH yields an explicit
 *      `depth-limit` gap and bounded symbol capture;
 *   05 forged `structure.queried` records cannot widen coverage: stale
 *      revisions, symbol granularity, missing idem_key, absolute paths,
 *      invalid classifications and tampered results are rejected or ignored;
 *   06 cache/query evidence bound to an older graph revision is never reused;
 *   07 blind spots cannot be bypassed through forged review claims or by
 *      disabling structural grading; structural evidence carries no
 *      `evidence_id` and never becomes completion evidence;
 *   08 analyzed sources are never executed and the analysis stack never
 *      spawns subprocesses;
 *   09 budget exhaustion / malformed input produce explicit timeout /
 *      degraded states, never a healthy `ok` with `files=0`;
 *   10 legacy snapshots, legacy Gate evidence and the legacy explore call
 *      shape still work.
 *
 * Every scenario runs in a fresh `os.tmpdir()` project. Nothing writes the
 * repository's own `.pm/`, `.ano/`, `src/` or user-level configuration, and
 * `D:/Temp/ano_probe` is never touched.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { blastRadiusSchema, storedVerificationSchema, structureEvidenceSchema } from '../../src/gate/types.ts';
import { verdictForTask } from '../../src/gate/verdict.ts';
import { verifyTask } from '../../src/gate/verify.ts';
import { analyzeStructure, createStructureAnalysisCache, openStructureAnalyzer, StructureAnalysisSession, type CoverageClassification } from '../../src/structure/analysis.ts';
import { assessRisk } from '../../src/structure/risk.ts';
import { GraphStore } from '../../src/structure/store.ts';
import { emptyCaveats, STRUCTURE_BUDGET_EXCEEDED, type GraphSnapshot } from '../../src/structure/types.ts';
import { createTsExtractor, type ParsedFile } from '../../src/structure/extractors/ts.ts';
import { buildSnapshot } from '../../src/structure/extractor.ts';
import { Ledger } from '../../src/ledger/ledger.ts';
import { currentExploredFiles, exploredState, initViews, readStructureQueries, type ExploredState, type StructureQueryRow } from '../../src/ledger/views.ts';
import { brief, explore, structureAnalysis, structureFileQuery, structureRiskPlan, verifySurface } from '../../src/surface/service.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PASSING_TEST = "import test from 'node:test';import assert from 'node:assert/strict';test('a', () => assert.equal(1, 1));\n";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function temp(t: TestContext, prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  return root;
}

async function write(root: string, path: string, content: string | Buffer): Promise<void> {
  const target = join(root, ...path.split('/'));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
}

function git(root: string, args: readonly string[]): void {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
}

interface RepoOptions {
  /** Commit the initial fixture so `brief`/`explore` can derive touched files. */
  readonly commit?: boolean;
  readonly pm?: boolean;
}

async function makeRepo(t: TestContext, files: Record<string, string>, options: RepoOptions = {}): Promise<string> {
  const root = await temp(t, 'ano-si-rb-');
  for (const [path, content] of Object.entries(files)) await write(root, path, content);
  if (options.pm !== false) {
    await write(root, '.pm/project.json', JSON.stringify({ name: 'si-redteam-fixture', private: true }));
  }
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 'ano@localhost']);
  git(root, ['config', 'user.name', 'ano']);
  if (options.commit !== false) {
    git(root, ['add', '.']);
    git(root, ['commit', '-qm', 'base']);
  }
  return root;
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function fileFingerprint(path: string, content: string) {
  return { hash: sha256(content), files: [{ path, hash: sha256(content), size: Buffer.byteLength(content, 'utf8') }], degraded: [] };
}

/** IIFE-wrapped nested function declarations: each level opens one more scope. */
function nestedFunctionScopes(levels: number): string {
  let source = '(function outer() {\n';
  for (let index = 0; index < levels; index += 1) source += `${' '.repeat(index + 1)}function f${index}() {\n`;
  source += `${' '.repeat(levels + 1)}let leaf = 1;\n`;
  for (let index = levels - 1; index >= 0; index -= 1) source += `${' '.repeat(index + 1)}}\n`;
  source += '})();\n';
  return source;
}

function wideIifeObject(count: number): string {
  const parts: string[] = [];
  for (let index = 0; index < count; index += 1) parts.push(`k${index}: ${index}`);
  return `(function () {\n  const big = { ${parts.join(', ')} };\n})();\n`;
}

function wideIifeArray(count: number): string {
  const items: string[] = [];
  for (let index = 0; index < count; index += 1) items.push(String(index));
  return `(function () {\n  const xs = [${items.join(', ')}];\n})();\n`;
}

async function buildFromSource(root: string, path: string, source: string) {
  return buildSnapshot({
    root,
    fingerprint: fileFingerprint(path, source),
    readFile: async () => source,
  });
}

async function listFiles(root: string): Promise<string[]> {
  const entries: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await (await import('node:fs/promises')).readdir(directory, { withFileTypes: true })) {
      if (entry.name === '.ano' || entry.name === '.git') continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else entries.push(relative(root, absolute).split(sep).join('/'));
    }
  }
  await walk(root);
  return entries.sort();
}

function readViews(root: string): DatabaseSync {
  const db = new DatabaseSync(join(root, '.ano', 'cache', 'views.db'));
  initViews(db);
  return db;
}

// ---------------------------------------------------------------------------
// 01. Malicious AST shapes
// ---------------------------------------------------------------------------

test('T-121/01 adversarial ASTs are parsed without execution and degrade explicitly when unbounded', async (t) => {
  const root = await temp(t, 'ano-si-mal-');
  const marker = join(root, 'side-effect-marker.txt');
  const sentinel = '__ANO_SI_MARKER__';
  const extractor = await createTsExtractor();

  // Every fixture carries side effects. The analysis only parses them, so none
  // of these markers may ever materialize.
  const sideEffects = [
    `globalThis.${sentinel} = true;`,
    `require('fs').writeFileSync(${JSON.stringify(marker)}, 'executed');`,
    `process.exit(9);`,
    `throw new Error('SI_EXECUTED');`,
    '',
  ].join('\n');
  (globalThis as Record<string, unknown>)[sentinel] = false;
  const exitCodeBefore = process.exitCode;

  // Side-effect-bearing but syntactically valid sources. None of these may run.
  const cases: ReadonlyArray<{ readonly name: string; readonly source: string }> = [
    { name: 'parens.js', source: `export const v = ${'('.repeat(1000)}1${')'.repeat(1000)};\n${sideEffects}` },
    {
      name: 'decls.js',
      source: `${Array.from({ length: 4000 }, (_, index) => `function f${index}() { return ${index}; }\nclass C${index} {}\n`).join('')}${sideEffects}`,
    },
    {
      name: 'unicode.js',
      source: `const \\u0061\\u0062 = 1; export const \\u00e9 = { \\u0061: \\u0062 }; function \\u03bb() { return 1; } export { \\u03bb };\n${sideEffects}`,
    },
    {
      name: 'proto.js',
      source: `const o = {}; o.__proto__ = { polluted: true }; const p = { ['__proto__']: { x: 1 } }; const q = { constructor: { prototype: { evil: 1 } } }; export { o, p, q };\n${sideEffects}`,
    },
    {
      name: 'getter.js',
      source: `const o = { get boom() { throw new Error('pwned'); }, set boom(v) { globalThis.pwned = v; } }; export default o;\n${sideEffects}`,
    },
    {
      name: 'genrec.js',
      source: `function* g(n) { if (n <= 0) return; yield n; yield* g(n - 1); } async function* ag() { yield* ag(); } export { g, ag };\n${sideEffects}`,
    },
  ];

  try {
    for (const item of cases) {
      const parsed = extractor.parse(`src/${item.name}`, item.source);
      assert.ok(parsed, `${item.name} must parse`);
      assert.ok(parsed.definitions.length > 0 || item.name === 'parens.js', `${item.name} must capture declarations`);
      assert.equal(JSON.stringify(parsed).includes('side-effect-marker'), false);
    }
    // Prototype pollution would be observable globally.
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
    assert.equal(({} as Record<string, unknown>).x, undefined);
    assert.equal(({} as Record<string, unknown>).evil, undefined);
    assert.equal((globalThis as Record<string, unknown>).pwned, undefined);
    assert.equal(existsSync(marker), false, 'no analyzed source may touch the filesystem');
    assert.equal((globalThis as Record<string, unknown>)[sentinel], false, 'no analyzed source may mutate globals');
    assert.equal(process.exitCode, exitCodeBefore, 'no analyzed source may change the process exit code');

    // The getter throwing proves the body was parsed, never evaluated.
    const getter = extractor.parse('src/getter.js', cases.find((item) => item.name === 'getter.js')!.source);
    assert.ok(getter.scope?.semanticGaps.some((gap) => gap.pattern === 'unresolved-identifier'));
  } finally {
    extractor.close();
  }

  // Unbounded shapes are stopped by the extractor's explicit node/depth budgets
  // before they can overflow the JS stack: the file is parsed and indexed, and
  // the overflow is reported as located `STRUCTURE_BUDGET_EXCEEDED` evidence
  // instead of a generic parse failure that drops the file.
  const chain = `export const v = 1${'+1'.repeat(50_000)};\n${sideEffects}`;
  let deep = 'export const deep = ';
  for (let index = 0; index < 3000; index += 1) deep += '{ a:';
  deep += '1';
  for (let index = 0; index < 3000; index += 1) deep += '}';
  deep += `;\n${sideEffects}`;

  for (const [name, source] of [['chain.js', chain], ['deep.js', deep]] as const) {
    const output = await buildFromSource(root, name, source);
    assert.ok(output, `${name} must still produce a snapshot`);
    assert.equal(output.report.degraded, false, `${name} must be parsed under the explicit budget gate`);
    assert.ok(output.snapshot.files[name], `${name} must stay indexed instead of being dropped`);
    assert.ok(output.snapshot.symbols.some((symbol) => symbol.file === name), `${name} must keep its top-level declaration`);
    const gap = output.snapshot.caveats.semanticGaps?.find((entry) => entry.file === name && entry.pattern === 'depth-limit');
    assert.ok(gap, `${name} must carry an explicit budget/depth gap, got ${JSON.stringify(output.snapshot.caveats.semanticGaps ?? [])}`);
    assert.match(gap.reason, new RegExp(STRUCTURE_BUDGET_EXCEEDED));
    const analysis = analyzeStructure(output.snapshot);
    assert.equal(analysis.counts.parsed, 1);
    assert.deepEqual(analysis.inScopeFiles, [name]);
    assert.ok(Array.isArray(analysis.notes));
  }

  // A budget-gated adversarial file degrades only itself: healthy neighbours in
  // the same snapshot stay indexed, and no generic parse failure is invented.
  const good = 'export const good = 1;\n';
  const mixed = await buildSnapshot({
    root,
    fingerprint: {
      hash: 'mixed-fingerprint',
      files: [
        { path: 'src/good.js', hash: sha256(good), size: Buffer.byteLength(good, 'utf8') },
        { path: 'src/chain.js', hash: sha256(chain), size: Buffer.byteLength(chain, 'utf8') },
      ],
      degraded: [],
    },
    readFile: async (absolute) => (absolute.endsWith('good.js') ? good : chain),
  });
  assert.ok(mixed.snapshot.files['src/good.js'], 'the healthy neighbour must stay indexed');
  assert.ok(mixed.snapshot.files['src/chain.js'], 'the budget-gated file must stay indexed too');
  assert.deepEqual(mixed.snapshot.caveats.degradedReasons, [], 'the budget gate must not fabricate a parse failure');
  const mixedGap = mixed.snapshot.caveats.semanticGaps?.find((entry) => entry.file === 'src/chain.js' && entry.pattern === 'depth-limit');
  assert.ok(mixedGap, 'the gated file must carry its explicit budget evidence');
  assert.match(mixedGap.reason, new RegExp(STRUCTURE_BUDGET_EXCEEDED));
  const mixedAnalysis = analyzeStructure(mixed.snapshot);
  assert.deepEqual(mixedAnalysis.inScopeFiles, ['src/chain.js', 'src/good.js']);

  // None of the adversarial fixtures executed, including the overflowing ones.
  assert.equal((globalThis as Record<string, unknown>)[sentinel], false);
  assert.equal(existsSync(marker), false);
  assert.equal(process.exitCode, exitCodeBefore);
});

// ---------------------------------------------------------------------------
// 02. Oversized objects/arrays are bounded and explicitly truncated
// ---------------------------------------------------------------------------

test('T-121/02 oversized object/array literals stay bounded with an explicit node-budget record', async (t) => {
  const root = await temp(t, 'ano-si-big-');
  const count = 210_000;
  const objectSource = wideIifeObject(count);
  const arraySource = wideIifeArray(count);
  assert.ok(Buffer.byteLength(objectSource, 'utf8') > 1024 * 1024, 'fixture must actually be megabyte-scale');
  await write(root, 'src/wide-object.js', objectSource);
  await write(root, 'src/wide-array.js', arraySource);

  const outputs = new Map<string, Awaited<ReturnType<typeof buildSnapshot>>>();
  for (const [path, source] of [['src/wide-object.js', objectSource], ['src/wide-array.js', arraySource]] as const) {
    const started = Date.now();
    const output = await buildSnapshot({ root, fingerprint: fileFingerprint(path, source), readFile: async () => source });
    const elapsed = Date.now() - started;
    assert.ok(output, `${path} must finish`);
    assert.ok(elapsed < 120_000, `${path} took ${elapsed}ms`);
    assert.ok(output.snapshot.files[path], `${path} must remain in the graph`);
    assert.equal(output.report.degraded, false);
    const gap = output.snapshot.caveats.semanticGaps?.find((entry) => entry.file === path && entry.pattern === 'depth-limit');
    assert.ok(gap, `${path} must record an explicit budget/depth gap, got ${JSON.stringify(output.snapshot.caveats.semanticGaps ?? [])}`);
    assert.match(gap.reason, /node budget exhausted/);
    outputs.set(path, output);
  }

  const objectOutput = outputs.get('src/wide-object.js')!;
  assert.ok(objectOutput.snapshot.symbols.length >= 1);
  assert.ok(objectOutput.snapshot.symbols.length <= count + 2, `captured symbols must stay linear in input size: ${objectOutput.snapshot.symbols.length}`);
  const arrayOutput = outputs.get('src/wide-array.js')!;
  assert.ok(arrayOutput.snapshot.symbols.length <= 2);

  // The batch analyzer surfaces the same located gap and never crashes on it.
  const session = new StructureAnalysisSession(objectOutput.snapshot);
  try {
    assert.equal(session.analysis.metrics.inScope, 1);
    assert.ok(session.analysis.blindSpots?.some((spot) => spot.pattern === 'depth-limit'));
    assert.ok(session.outline('src/wide-object.js'));
  } finally {
    session.close();
  }
});

// ---------------------------------------------------------------------------
// 03. Circular references terminate
// ---------------------------------------------------------------------------

test('T-121/03 circular imports and recursive require terminate with bounded output', async (t) => {
  const root = await temp(t, 'ano-si-cycle-');
  await write(root, 'src/a.js', "import { b } from './b.js';\nexport const a = 1;\n");
  await write(root, 'src/b.js', "import { a } from './a.js';\nexport const b = 2;\n");
  await write(root, 'src/self.js', "import './self.js';\nexport const s = 1;\n");
  await write(root, 'src/dyn.js', "const list = ['./a.js', './b.js'];\nexport const d = require(list[0]);\n");

  const output = await buildSnapshot({
    root,
    fingerprint: {
      hash: 'cycle-fingerprint',
      files: [
        { path: 'src/a.js', hash: sha256(await readFile(join(root, 'src', 'a.js'), 'utf8')), size: (await stat(join(root, 'src', 'a.js'))).size },
        { path: 'src/b.js', hash: sha256(await readFile(join(root, 'src', 'b.js'), 'utf8')), size: (await stat(join(root, 'src', 'b.js'))).size },
        { path: 'src/self.js', hash: sha256(await readFile(join(root, 'src', 'self.js'), 'utf8')), size: (await stat(join(root, 'src', 'self.js'))).size },
        { path: 'src/dyn.js', hash: sha256(await readFile(join(root, 'src', 'dyn.js'), 'utf8')), size: (await stat(join(root, 'src', 'dyn.js'))).size },
      ],
      degraded: [],
    },
    readFile: async (absolute) => readFile(absolute, 'utf8'),
  });
  assert.ok(output);
  assert.deepEqual(Object.keys(output.snapshot.files).sort(), ['src/a.js', 'src/b.js', 'src/dyn.js', 'src/self.js']);
  assert.deepEqual(output.snapshot.caveats.degradedReasons, []);

  const session = new StructureAnalysisSession(output.snapshot, { touched: ['src/a.js', 'src/self.js', 'src/dyn.js'] });
  try {
    assert.equal(session.analysis.metrics.inScope, 4);
    assert.ok(Number.isFinite(session.analysis.metrics.unchanged));
    assert.ok(session.analysis.metrics.blindness <= 1);
    for (const file of ['src/a.js', 'src/b.js', 'src/self.js', 'src/dyn.js']) {
      const impact = session.impact(file);
      assert.ok(impact, `${file} impact must terminate`);
      assert.ok(impact.direct.length < 4 && impact.transitive.length < 4);
    }
  } finally {
    session.close();
  }
});

// ---------------------------------------------------------------------------
// 04. Depth explosion is reported as a depth-limit gap
// ---------------------------------------------------------------------------

test('T-121/04 scope-depth explosion beyond MAX_SCOPE_DEPTH yields an explicit depth-limit gap', async (t) => {
  const root = await temp(t, 'ano-si-depth-');
  const source = nestedFunctionScopes(30);
  const started = Date.now();
  const output = await buildFromSource(root, 'src/deep.js', source);
  const elapsed = Date.now() - started;

  assert.ok(output);
  assert.ok(elapsed < 30_000, `depth fixture must terminate quickly, took ${elapsed}ms`);
  assert.ok(output.snapshot.files['src/deep.js'], 'the file must still be indexed');
  assert.equal(output.report.degraded, false);
  // MAX_SCOPE_DEPTH is 16; a 30-deep chain stops capturing at the bound and
  // records the limit instead of walking forever or crashing.
  assert.ok(output.snapshot.symbols.length <= 17, `symbol capture must be bounded, got ${output.snapshot.symbols.length}`);
  const gap = output.snapshot.caveats.semanticGaps?.find((entry) => entry.file === 'src/deep.js' && entry.pattern === 'depth-limit');
  assert.ok(gap, `expected a depth-limit gap, got ${JSON.stringify(output.snapshot.caveats.semanticGaps ?? [])}`);
  assert.match(gap.reason, /deeper than 16/);

  const session = new StructureAnalysisSession(output.snapshot, { touched: ['src/deep.js'] });
  try {
    assert.ok(session.analysis.blindSpots?.some((spot) => spot.file === 'src/deep.js' && spot.pattern === 'depth-limit'));
    assert.equal(typeof session.analysis.metrics.depthLimited, 'boolean');
  } finally {
    session.close();
  }
});

// ---------------------------------------------------------------------------
// 05. Forged structure.queried records cannot widen coverage
// ---------------------------------------------------------------------------

test('T-121/05 forged structure.queried records are rejected or ignored by the projection', async (t) => {
  const root = await makeRepo(t, {
    '.gitignore': '.ano/\n',
    'package.json': JSON.stringify({ name: 'si-forge', private: true }),
    'src/a.ts': 'export const alpha = 1;\n',
    'src/b.ts': 'export const beta = 2;\n',
    'src/c.ts': 'export const gamma = 3;\n',
  });

  const graph = await GraphStore.open(root);
  await graph.build();
  const revision = graph.revision;
  assert.ok(revision);
  graph.close();

  const ledger = await Ledger.open(root, { sessionId: 'SI-FORGE' });
  try {
    const accepted = await ledger.append({
      kind: 'structure.queried',
      payload: {
        granularity: 'file',
        file: 'src/a.ts',
        graph_revision: 'OLD-REVISION-NOT-CURRENT',
        query: 'outline:src/a.ts',
        result: { total: 1, returned: 1, truncated: false, classification: 'parsed' },
      },
    }, 'forge-stale-file');
    assert.equal(accepted.duplicate, false);

    const symbol = await ledger.append({
      kind: 'structure.queried',
      payload: {
        granularity: 'symbol',
        file: 'src/b.ts',
        ref: 'beta',
        graph_revision: revision,
        query: 'outline:src/b.ts#beta',
        result: { total: 1, returned: 1, truncated: false, classification: 'parsed' },
      },
    }, 'forge-symbol');
    assert.equal(symbol.duplicate, false);

    // Tampered result: the file really is zero-edge, but the forged event claims
    // `parsed`. Projection stores the event; analysis must still trust the graph.
    const tampered = await ledger.append({
      kind: 'structure.queried',
      payload: {
        granularity: 'file',
        file: 'src/c.ts',
        graph_revision: revision,
        query: 'outline:src/c.ts',
        result: { total: 999, returned: 999, truncated: false, classification: 'parsed' },
      },
    }, 'forge-tampered');
    assert.equal(tampered.duplicate, false);

    // Missing idem_key, absolute path and an invalid classification are
    // fail-closed integrity errors, not silently accepted events.
    await assert.rejects(
      ledger.append({
        kind: 'structure.queried',
        payload: {
          granularity: 'file',
          file: 'src/a.ts',
          graph_revision: revision,
          query: 'outline:src/a.ts',
          result: { total: 1, returned: 1, truncated: false, classification: 'parsed' },
        },
      }),
      /requires an idem_key/,
    );
    await assert.rejects(
      ledger.append({
        kind: 'structure.queried',
        payload: {
          granularity: 'file',
          file: '/etc/passwd',
          graph_revision: revision,
          query: 'outline:/etc/passwd',
          result: { total: 1, returned: 1, truncated: false, classification: 'parsed' },
        },
      }, 'forge-absolute'),
      /relative POSIX/,
    );
    await assert.rejects(
      ledger.append({
        kind: 'structure.queried',
        payload: {
          granularity: 'file',
          file: 'src/a.ts',
          graph_revision: revision,
          query: 'outline:src/a.ts',
          result: { total: 1, returned: 1, truncated: false, classification: 'bogus' },
        },
      }, 'forge-classification'),
      /classification/,
    );

    // Reusing the same idem_key with different parameters is refused.
    await assert.rejects(
      ledger.append({
        kind: 'structure.queried',
        payload: {
          granularity: 'file',
          file: 'src/a.ts',
          graph_revision: revision,
          query: 'outline:src/a.ts',
          result: { total: 2, returned: 2, truncated: false, classification: 'parsed' },
        },
      }, 'forge-tampered'),
      /different parameters/,
    );
  } finally {
    ledger.close();
  }

  const db = readViews(root);
  try {
    const rows = readStructureQueries(db);
    assert.deepEqual(rows.map((row) => row.granularity), ['file', 'symbol', 'file']);
    assert.ok(rows.every((row) => !('evidenceId' in row) && !('evidence_id' in row)));
    const explored = currentExploredFiles(db, revision);
    assert.deepEqual(explored, ['src/c.ts'], 'only file-granularity evidence at the current revision counts');
    const state: ExploredState = exploredState(db, revision);
    assert.deepEqual(state.explored, ['src/c.ts']);
    assert.deepEqual(state.stale, ['src/a.ts'], 'stale-revision evidence must be surfaced as stale, not explored');
  } finally {
    db.close();
  }

  // Analysis consumes the graph, never the tampered ledger payload.
  const reopened = await GraphStore.open(root);
  try {
    const analysis = analyzeStructure(reopened.snapshot(), { touched: ['src/c.ts'] });
    const row = analysis.files.find((candidate) => candidate.file === 'src/c.ts');
    assert.ok(row);
    assert.equal(row.classification, 'zero-edge');
    const plan = assessRisk(analysis, { snapshot: reopened.snapshot() });
    const planned = plan.rows.find((candidate) => candidate.file === 'src/c.ts');
    assert.equal(planned?.classification, 'zero-edge');
  } finally {
    reopened.close();
  }

  // Caller-supplied exploredFiles intersect with the projection: they can never
  // add a file the projection does not already contain.
  const claimed = (await brief(root, { exploredFiles: ['src/a.ts', 'src/c.ts', 'src/phantom.ts'] } as never)) as {
    memory: { structure: { exploredFiles: string[] }; unexploredChanges: { modifiedWithoutExplore: string[] } };
  };
  assert.deepEqual(claimed.memory.structure.exploredFiles, ['src/c.ts']);
  assert.equal(claimed.memory.unexploredChanges.modifiedWithoutExplore.includes('src/phantom.ts'), false);
});

// ---------------------------------------------------------------------------
// 06. Cache and query evidence bound to an older revision are never reused
// ---------------------------------------------------------------------------

test('T-121/06 old-revision query evidence and cached analyses are not reused', async (t) => {
  const root = await makeRepo(t, {
    '.gitignore': '.ano/\n',
    'package.json': JSON.stringify({ name: 'si-revision', private: true }),
    'src/a.ts': 'export const alpha = 1;\n',
    'src/b.ts': 'export const beta = 2;\n',
  });

  const firstBuild = await GraphStore.open(root);
  await firstBuild.build();
  const revisionBefore = firstBuild.revision;
  firstBuild.close();

  const before = await structureFileQuery(root, { file: 'src/a.ts', kind: 'outline' });
  assert.equal(before.graphRevision, revisionBefore);
  assert.equal(before.evidence?.duplicate, false);
  assert.equal(before.total, 1);

  // Mutating the file and rebuilding produces a new graph revision. The old
  // query evidence is stale and cannot describe the new snapshot.
  await write(root, 'src/a.ts', 'export const alpha = 1;\nexport const gamma = 3;\n');
  const rebuild = await GraphStore.open(root);
  await rebuild.build();
  const revisionAfter = rebuild.revision;
  assert.notEqual(revisionAfter, revisionBefore);
  rebuild.close();

  const staleBrief = (await brief(root)) as {
    memory: { structure: { exploredFiles: string[]; staleCount: number }; unexploredChanges: { warning: string | null } };
  };
  assert.deepEqual(staleBrief.memory.structure.exploredFiles, []);
  assert.equal(staleBrief.memory.structure.staleCount, 1);
  assert.match(staleBrief.memory.unexploredChanges.warning ?? '', /without a structure query/u);
  const db = readViews(root);
  try {
    assert.deepEqual(currentExploredFiles(db, revisionAfter), []);
    assert.deepEqual(exploredState(db, revisionAfter).stale, ['src/a.ts']);
  } finally {
    db.close();
  }

  // Re-querying the current revision yields fresh evidence and a larger outline:
  // the old answer (total=1) is not replayed.
  const after = await structureFileQuery(root, { file: 'src/a.ts', kind: 'outline' });
  assert.equal(after.graphRevision, revisionAfter);
  assert.equal(after.evidence?.duplicate, false);
  assert.equal(after.total, 2);
  assert.deepEqual(after.outline?.symbols.map((symbol) => symbol.name).sort(), ['alpha', 'gamma']);

  // The batch analysis cache is keyed by graph revision: an old entry is never
  // served for a new revision, and invalidation is explicit.
  const cache = createStructureAnalysisCache();
  const cacheBefore = await openStructureAnalyzer(root, { cache });
  assert.equal(cacheBefore.analysis.revision, revisionAfter);
  assert.equal(cache.size, 1);
  cacheBefore.close();

  await write(root, 'src/b.ts', 'export const beta = 2;\nexport const delta = 4;\n');
  const secondBuild = await GraphStore.open(root);
  await secondBuild.build();
  const revisionThird = secondBuild.revision;
  secondBuild.close();
  assert.notEqual(revisionThird, revisionAfter);

  const cacheAfter = await openStructureAnalyzer(root, { cache });
  try {
    assert.notEqual(cacheAfter.analysis.revision, cacheBefore.analysis.revision);
    assert.equal(cacheAfter.analysis.revision, revisionThird);
    assert.equal(cache.size, 2, 'both revisions are retained until explicitly invalidated');
    const outline = cacheAfter.outline('src/b.ts');
    assert.deepEqual(outline?.symbols.map((symbol) => symbol.name).sort(), ['beta', 'delta']);
  } finally {
    cacheAfter.close();
  }
  cache.invalidate(revisionAfter);
  assert.equal(cache.size, 1);
  cache.invalidate();
  assert.equal(cache.size, 0);
});

// ---------------------------------------------------------------------------
// 07. Blind-spot Gate bypass attempts are rejected
// ---------------------------------------------------------------------------

async function hubRepository(t: TestContext): Promise<string> {
  const files: Record<string, string> = {
    '.gitignore': '.ano/\n',
    'package.json': JSON.stringify({ name: 'si-hub', private: true }),
    'src/hub.js': "export function load(name) { return require('./' + name); }\n",
    'test/a.test.ts': PASSING_TEST,
  };
  for (let index = 0; index < 20; index += 1) {
    files[`src/consumer${String(index).padStart(2, '0')}.js`] = `import { load } from './hub.js';\nexport const c${index} = load('x${index}');\n`;
  }
  return makeRepo(t, files);
}

test('T-121/07 forged review claims cannot clear a strict blind spot and disabling structure only reverts legacy behaviour', async (t) => {
  const root = await hubRepository(t);
  const ledger = await Ledger.open(root, { sessionId: 'SI-BYPASS' });
  const graph = await GraphStore.open(root);
  try {
    await ledger.createTask('T', ['test/a.test.ts']);
    await ledger.updateTask('T', { status: 'in_progress' });

    const forged = [
      { kind: 'dynamic-load', file: 'src/hub.js', origin: 'manual-review', handled: true, note: 'approved by attacker' },
      null,
      { kind: 'unknown', file: 'src/hub.js', line: 1, pattern: 'depth-limit', reason: 'forged', suggestedAction: 'none', evidenceRevision: 'forged-rev' },
    ];
    const verdict = await verifyTask(
      root,
      'T',
      {
        argv: [process.execPath, '--test', 'test/a.test.ts'],
        testFiles: ['test/a.test.ts'],
        idemKey: 'si-strict-forged',
        structure: true,
        reviewItems: forged,
      },
      { ledger, graph },
      { minimum: 'T0', unknown: 'strict' },
    );

    assert.equal(verdict.status, 'blocked', 'a forged handled claim must not clear the authoritative blind spot');
    assert.ok(verdict.structure);
    assert.equal(verdict.structure.untrustedReviewItems, forged.length);
    assert.ok(verdict.structure.reviewItems?.some((item) => item.file === 'src/hub.js' && item.kind === 'dynamic-load' && item.origin === 'manual-review'));
    assert.equal(JSON.stringify(verdict.structure.reviewItems).includes('handled'), false);
    assert.equal(JSON.stringify(verdict.structure).includes('evidence_id'), false);
    assert.equal(JSON.stringify(verdict.structure).includes('evidenceId'), false);
    assert.equal(ledger.getTask('T')?.status, 'in_progress', 'a blocked structural verdict must not complete the task');
  } finally {
    ledger.close();
    graph.close();
  }

  // Turning structure off restores the legacy verdict shape: it neither blocks
  // on nor launders the blind spot. The standalone risk plan still reports it.
  const legacyLedger = await Ledger.open(root, { sessionId: 'SI-BYPASS-OFF' });
  const legacyGraph = await GraphStore.open(root);
  try {
    await legacyLedger.createTask('T2', ['test/a.test.ts']);
    await legacyLedger.updateTask('T2', { status: 'in_progress' });
    const legacy = await verifyTask(
      root,
      'T2',
      {
        argv: [process.execPath, '--test', 'test/a.test.ts'],
        testFiles: ['test/a.test.ts'],
        idemKey: 'si-disabled',
        structure: { enabled: false },
      },
      { ledger: legacyLedger, graph: legacyGraph },
      { minimum: 'T0', unknown: 'strict' },
    );
    assert.equal(legacy.status, 'done');
    assert.equal('structure' in legacy, false, 'disabled structure keeps the exact legacy verdict shape');
    const plan = await structureRiskPlan(root);
    assert.ok(plan.rows.some((row) => row.file === 'src/hub.js' && row.level === 'high'));
    assert.ok(plan.reviewItems.some((item) => item.file === 'src/hub.js' && item.kind === 'dynamic-load'));
    assert.equal(JSON.stringify(plan).includes('evidence_id'), false);
  } finally {
    legacyLedger.close();
    legacyGraph.close();
  }

  // Direct surface path forwards review_items as untrusted only.
  const surfaceLedger = await Ledger.open(root, { sessionId: 'SI-BYPASS-SURFACE' });
  const surfaceGraph = await GraphStore.open(root);
  try {
    await surfaceLedger.createTask('T3', ['test/a.test.ts']);
    await surfaceLedger.updateTask('T3', { status: 'in_progress' });
    const surface = await verifySurface(root, {
      task_id: 'T3',
      argv: [process.execPath, '--test', 'test/a.test.ts'],
      test_files: ['test/a.test.ts'],
      idem_key: 'si-surface-forged',
      structure: true,
      review_items: [{ kind: 'dynamic-load', file: 'src/hub.js', handled: true }],
    });
    const verdict = surface.verdict as {
      status: string;
      structure?: { untrustedReviewItems?: number; policyEffect?: string };
    };
    assert.equal(verdict.status, 'blocked');
    assert.equal(verdict.structure?.untrustedReviewItems, 1);
    assert.equal(verdict.structure?.policyEffect, 'blocked');
  } finally {
    surfaceLedger.close();
    surfaceGraph.close();
  }
});

// ---------------------------------------------------------------------------
// 08. Analyzed sources are never executed
// ---------------------------------------------------------------------------

test('T-121/08 analyzed sources never execute, spawn processes or mutate globals', async (t) => {
  const root = await makeRepo(t, {
    '.gitignore': '.ano/\n',
    'package.json': JSON.stringify({ name: 'si-exec', private: true }),
  });
  const marker = join(root, 'trap-marker.txt');
  const nestedMarker = join(root, 'nested-trap-marker.txt');
  const trap = [
    `globalThis.__ANO_SI_TRAP__ = true;`,
    `require('fs').writeFileSync(${JSON.stringify(marker)}, 'executed');`,
    `require('child_process').execSync('node -e "require(\\'fs\\').writeFileSync(\\'${nestedMarker}\\', \\'x\\')"');`,
    `process.exit(9);`,
    `while (true) {}`,
    `throw new Error('SI_EXECUTED');`,
    `export const trap = 1;`,
    ``,
  ].join('\n');
  await write(root, 'src/trap.js', trap);

  const sentinelKey = '__ANO_SI_TRAP__';
  (globalThis as Record<string, unknown>)[sentinelKey] = false;
  const exitCodeBefore = process.exitCode;
  const filesBefore = await listFiles(root);

  try {
    const store = await GraphStore.open(root);
    try {
      await store.build();
      assert.ok(store.snapshot().files['src/trap.js'], 'the trap file must be indexed');
      // Two literal `require()` calls are recorded statically, never executed.
      assert.equal(store.snapshot().files['src/trap.js']?.dynamicLoads, 2);
    } finally {
      store.close();
    }

    const snapshot = await buildSnapshot({
      root,
      fingerprint: fileFingerprint('src/trap.js', trap),
      readFile: async () => trap,
    });
    assert.ok(snapshot.snapshot.files['src/trap.js']);
    const session = new StructureAnalysisSession(snapshot.snapshot, { touched: ['src/trap.js'] });
    try {
      assert.ok(session.outline('src/trap.js'));
      assert.ok(session.impact('src/trap.js'));
    } finally {
      session.close();
    }

    await structureAnalysis(root, { touched: ['src/trap.js'] });
    await explore(root, 'trap');
    await structureFileQuery(root, { file: 'src/trap.js', kind: 'outline' });
  } finally {
    (globalThis as Record<string, unknown>)[sentinelKey] = false;
  }

  assert.equal(existsSync(marker), false, 'analyzed source must never write files');
  assert.equal(existsSync(nestedMarker), false, 'analyzed source must never spawn a child process');
  assert.equal((globalThis as Record<string, unknown>)[sentinelKey], false, 'analyzed source must never mutate globals');
  assert.equal(process.exitCode, exitCodeBefore, 'analyzed source must never change the process exit code');
  assert.deepEqual(await listFiles(root), filesBefore, 'analysis must not create files outside .ano/.git');

  // Static assurance: the analysis/extraction stack contains no execution
  // primitives. This complements the behavioural markers above.
  const guardedSources = [
    'src/structure/extractors/ts.ts',
    'src/structure/extractor.ts',
    'src/structure/analysis.ts',
    'src/structure/store.ts',
    'src/surface/service.ts',
  ];
  for (const relativePath of guardedSources) {
    const text = await readFile(join(REPO_ROOT, relativePath), 'utf8');
    assert.equal(/child_process/.test(text), false, `${relativePath} references child_process`);
    assert.equal(/\b(spawnSync|execSync|execFileSync|spawn|fork)\s*\(/.test(text), false, `${relativePath} invokes a subprocess primitive`);
  }
});

// ---------------------------------------------------------------------------
// 09. Budget exhaustion and malformed input produce explicit degraded states
// ---------------------------------------------------------------------------

test('T-121/09 budget exhaustion and malformed input are explicit timeout/degraded, never ok with files=0', async (t) => {
  const root = await makeRepo(t, {
    '.gitignore': '.ano/\n',
    'package.json': JSON.stringify({ name: 'si-budget', private: true }),
    'src/a.ts': 'export const a = 1;\n',
    'src/b.ts': 'export const b = 2;\n',
  });

  const baseline = await GraphStore.open(root);
  await baseline.build();
  assert.equal(baseline.buildOutcome?.status, 'ok');
  const previousFiles = baseline.filesList();
  const previousRevision = baseline.revision;
  assert.ok(previousFiles.length > 0);
  baseline.close();

  const timed = await GraphStore.open(root);
  try {
    await timed.build({ scan: { startRoot: root, deadline: Date.now() - 1000 } });
    const outcome = timed.buildOutcome!;
    assert.equal(outcome.status, 'timeout');
    assert.equal(outcome.partial, true);
    assert.equal(outcome.stale, true);
    assert.equal(outcome.reason, 'scan-budget-exceeded');
    assert.equal(outcome.files, previousFiles.length, 'the previous snapshot is retained, not replaced by files=0');
    assert.deepEqual(timed.filesList(), previousFiles);
    assert.equal(timed.revision, previousRevision);
    assert.equal(timed.freshness().status, 'stale');

    const byteCapped = await timed.build({ scan: { startRoot: root, maxTotalBytes: 1 } });
    const cappedOutcome = byteCapped.buildOutcome!;
    assert.equal(cappedOutcome.status, 'timeout');
    assert.equal(cappedOutcome.partial, true);
    assert.equal(cappedOutcome.reason, 'scan-budget-exceeded');
    assert.ok(cappedOutcome.completed, 'the completed-work record must be explicit');
  } finally {
    timed.close();
  }

  // Malformed/binary-ish source is tolerated by the grammar (tree-sitter keeps
  // an error tree) but can never become a crash or a silent healthy result: it
  // is classified as a zero-symbol blind spot and stays in the denominator.
  const garbage = '\u0000\u0001\u0002 this is not javascript {{{';
  const garbageOutput = await buildFromSource(root, 'src/bad.ts', garbage);
  assert.ok(garbageOutput.snapshot.files['src/bad.ts']);
  assert.doesNotThrow(() => analyzeStructure(garbageOutput.snapshot));
  const garbageAnalysis = analyzeStructure(garbageOutput.snapshot);
  const garbageRow = garbageAnalysis.files.find((row) => row.file === 'src/bad.ts');
  assert.equal(garbageRow?.classification, 'zero-symbol');
  assert.ok(garbageAnalysis.counts['zero-symbol'] >= 1);
  assert.ok(garbageAnalysis.blindSpots?.some((spot) => spot.type === 'zero-symbol' && spot.file === 'src/bad.ts'));

  // Unsupported extensions are classified separately, included in the blind
  // denominator, and excluded is not confused with them.
  const supported = await buildFromSource(root, 'src/a.ts', 'export const a = 1;\n');
  const classified = analyzeStructure(supported.snapshot, {
    unsupportedFiles: ['legacy.php'],
    excludedFiles: ['skip.js'],
  });
  const byFile = new Map(classified.files.map((row) => [row.file, row.classification]));
  assert.equal(byFile.get('legacy.php'), 'unsupported');
  assert.equal(byFile.get('skip.js'), 'excluded');
  assert.equal(byFile.get('src/a.ts'), 'zero-edge');
  assert.equal(classified.counts.unsupported, 1);
  assert.equal(classified.counts.excluded, 1);
  assert.ok(classified.metrics.blindness > 0, 'unsupported/excluded files must not vanish silently');
  const excludedRow = classified.files.find((row) => row.file === 'skip.js');
  assert.equal(excludedRow?.inScope, false);

  // An empty project is an explicit degraded scan, never a healthy empty `ok`.
  const empty = await makeRepo(t, {
    '.gitignore': '.ano/\n',
    'package.json': JSON.stringify({ name: 'si-empty', private: true }),
  });
  const emptyStore = await GraphStore.open(empty);
  try {
    await emptyStore.build();
    const outcome = emptyStore.buildOutcome!;
    assert.equal(outcome.files, 0);
    assert.equal(outcome.status, 'degraded');
    assert.notEqual(outcome.status, 'ok');
    assert.equal(emptyStore.freshness().status, 'degraded');
  } finally {
    emptyStore.close();
  }
});

// ---------------------------------------------------------------------------
// 10. Legacy snapshot / Gate evidence / explore compatibility
// ---------------------------------------------------------------------------

test('T-121/10 legacy snapshots, Gate evidence and the legacy explore shape stay compatible', async (t) => {
  // A pre-L2/pre-structure snapshot has no calls table and no caveat evidence.
  const legacy: GraphSnapshot = {
    revision: 'legacy-revision',
    sourceFingerprint: 'a'.repeat(64),
    files: { 'src/a.js': { path: 'src/a.js', hash: 'h1', dynamicLoads: 0 } },
    symbols: [{ id: 's1', file: 'src/a.js', name: 'alpha', qualifiedName: 'alpha', symbolKind: 'value', startLine: 1 }],
    edges: [],
    caveats: emptyCaveats(),
  };
  assert.equal(legacy.calls, undefined);
  assert.equal(legacy.caveats.semanticGaps, undefined);

  const session = new StructureAnalysisSession(legacy);
  try {
    assert.equal(session.isClosed, false);
    assert.equal(session.analysis.revision, 'legacy-revision');
    assert.deepEqual(session.analysis.blindSpots ?? [], [], 'a legacy snapshot without evidence has no invented blind spots');
    assert.equal(session.fileAnalysis('src/a.js')?.classification, 'zero-edge');
    assert.deepEqual(session.outline('src/a.js')?.symbols.map((symbol) => symbol.name), ['alpha']);
    assert.ok(session.impact('src/a.js'));
  } finally {
    session.close();
  }
  assert.equal(session.isClosed, true);

  const classified = analyzeStructure(legacy, { unsupportedFiles: ['legacy.php'], excludedFiles: ['skip.js'] });
  const legacyByFile = new Map(classified.files.map((row) => [row.file, row.classification as CoverageClassification]));
  assert.equal(legacyByFile.get('src/a.js'), 'zero-edge');
  assert.equal(legacyByFile.get('legacy.php'), 'unsupported');
  assert.equal(legacyByFile.get('skip.js'), 'excluded');
  assert.equal(classified.metrics.inScope, 2, 'excluded must stay out of the denominator');

  // Legacy Gate evidence: no structure segment and no risk summary still parse.
  const legacyVerdict = {
    taskId: 'T-legacy',
    status: 'done',
    level: 'T0',
    sourceFingerprint: 'b'.repeat(64),
    graphRevision: 'legacy-revision',
    freshness: { status: 'fresh', stale: 0 },
    blastRadius: { impacted: [], covered: [], uncovered: [], advisory: [] },
    policy: { minimum: 'T0', unknown: 'strict' },
    caveats: {},
    reasons: [],
  };
  const legacyStored = storedVerificationSchema.safeParse({
    idem_key: 'legacy-key',
    params: 'params',
    identity: 'identity',
    task_id: 'T-legacy',
    graph_revision: 'legacy-revision',
    test_files: ['test/a.test.ts'],
    policy: { minimum: 'T0', unknown: 'strict' },
    verdict: legacyVerdict,
  });
  assert.equal(legacyStored.success, true, JSON.stringify(legacyStored.success ? '' : legacyStored.error.issues));
  if (legacyStored.success) assert.equal(legacyStored.data.verdict.structure, undefined);
  assert.equal(blastRadiusSchema.safeParse({ impacted: [], covered: [], uncovered: [], advisory: [] }).success, true);
  assert.equal(structureEvidenceSchema.safeParse({}).success, true);

  const legacyDecision = verdictForTask({
    task: { id: 'T-legacy', status: 'in_progress', declaredFiles: ['test/a.test.ts'] },
    touched: [],
    executedTests: [],
    graph: legacy,
    freshness: { status: 'fresh', stale: 0 },
    policy: { minimum: 'T0', unknown: 'strict' },
  });
  assert.equal('structure' in legacyDecision, false, 'legacy decisions keep their exact shape');

  // The scan-free legacy explore call shape is unchanged.
  const root = await makeRepo(t, {
    '.gitignore': '.ano/\n',
    'package.json': JSON.stringify({ name: 'si-explore', private: true }),
    'src/alpha.js': 'export const alpha = 1;\n',
  });
  const result = await explore(root, 'alpha');
  assert.deepEqual(
    Object.keys(result).sort(),
    ['cache', 'caveats', 'freshness', 'graphRevision', 'impact', 'partial', 'query', 'rootResolution', 'stale', 'status', 'symbols', 'total', 'truncated'],
  );
  assert.equal(result.query, 'alpha');
  assert.equal(result.total, 1);
  assert.ok(Array.isArray(result.symbols));
  assert.equal((result.symbols as unknown[]).length, 1);

  const plan = await structureRiskPlan(root);
  assert.ok(Array.isArray(plan.rows));
  assert.ok(Array.isArray(plan.reviewItems));
  assert.equal(JSON.stringify(plan).includes('evidence_id'), false);
});
