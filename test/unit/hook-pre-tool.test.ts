import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { Ledger } from '../../src/ledger/ledger.ts';
import {
  currentExploredFiles,
  exploredState,
  initViews,
  readLatestStructureQueryRevision,
  readStructureQueries,
} from '../../src/ledger/views.ts';
import { defaultViewsPath, readExploredProjection } from '../../src/memory/explored-state.ts';
import {
  decidePreTool,
  SUPPORTED_PRE_TOOL_EXTENSIONS,
} from '../../src/hooks/pre-tool.ts';
import {
  hookDecisionSchema,
  type HookDecision,
  type HookInput,
  type HookMode,
} from '../../src/hooks/contract.ts';
import type { Freshness } from '../../src/structure/types.ts';
import type { PreToolContext } from '../../src/hooks/pre-tool.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FRESH: Freshness = { status: 'fresh', stale: 0 };
const REV = 'rev-current';

function removeTempRoot(root: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try { rmSync(root, { recursive: true, force: true }); return; }
    catch { if (attempt >= 9) return; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); }
  }
}

function input(targetPaths: string[]): HookInput {
  return { event: 'pre-tool', client: 'zcode', hostSessionId: 'sess-1', cwd: '/', targetPaths };
}

function ctx(overrides: Partial<PreToolContext> = {}): PreToolContext {
  return {
    mode: 'advisory',
    root: '/project',
    freshness: FRESH,
    revision: REV,
    exists: () => true,
    exploredFiles: [],
    ...overrides,
  };
}

function kindOf(decision: HookDecision): HookDecision['kind'] { return decision.kind; }

// ---------------------------------------------------------------------------
// Rule 1: outside root / unresolvable -> ask (both modes, never allow)
// ---------------------------------------------------------------------------

test('规则1：越界路径 advisory→ask / strict→ask（绝不 allow，统一不猜）', () => {
  for (const mode of ['advisory', 'strict'] as HookMode[]) {
    for (const target of ['/etc/passwd', '../outside.ts', '', '/project/../escape.ts']) {
      const decision = decidePreTool(input([target]), ctx({ mode }));
      assert.equal(kindOf(decision), 'ask', `${mode} ${target}`);
      assert.equal(decision.degraded?.code, 'HOOK_ROOT_AMBIGUOUS');
      assert.equal(hookDecisionSchema.safeParse(decision).success, true);
    }
  }
});

test('规则1：可解析的项目内路径不触发越界（正反）', () => {
  const decision = decidePreTool(input(['src/a.ts']), ctx());
  assert.notEqual(decision.degraded?.code, 'HOOK_ROOT_AMBIGUOUS');
});

// ---------------------------------------------------------------------------
// Rule 2: exempt -> allow
// ---------------------------------------------------------------------------

test('规则2：默认豁免 *.md / docs/** / 非源码资产 → allow（正反）', () => {
  for (const target of ['README.md', 'docs/guide.md', 'notes.txt', 'image.png', 'config.yaml']) {
    const decision = decidePreTool(input([target]), ctx());
    assert.equal(kindOf(decision), 'allow', target);
    assert.equal(decision.degraded, undefined, target);
  }
  // 正例对照：源码文件不豁免，继续执行后续规则
  const source = decidePreTool(input(['src/a.ts']), ctx());
  assert.notEqual(kindOf(source), 'allow');
});

test('规则2：hooks.exempt 自定义 glob 生效；.ano/** 不被默认豁免放行', () => {
  const custom = decidePreTool(input(['generated/schema.ts']), ctx({ exempt: ['generated/**'] }));
  assert.equal(kindOf(custom), 'allow');
  const anoInternal = decidePreTool(input(['.ano/cache/views.db']), ctx({ exempt: [] }));
  assert.notEqual(kindOf(anoInternal), 'allow');
  // 未配置的源码路径不因自定义 exempt 意外放行
  assert.notEqual(kindOf(decidePreTool(input(['src/a.ts']), ctx({ exempt: ['generated/**'] }))), 'allow');
});

// ---------------------------------------------------------------------------
// Rule 3: new file -> allow
// ---------------------------------------------------------------------------

test('规则3：目标文件不存在 → allow；存在则继续后续规则（正反）', () => {
  const exists = (p: string): boolean => !p.endsWith('new.ts');
  const base = ctx({ exists });
  assert.equal(kindOf(decidePreTool(input(['src/new.ts']), base)), 'allow');
  assert.notEqual(kindOf(decidePreTool(input(['src/existing.ts']), base)), 'allow');
});

// ---------------------------------------------------------------------------
// Rule 4: unsupported language -> allow + degraded
// ---------------------------------------------------------------------------

test('规则4：非 TS/JS 源码 allow + UNSUPPORTED_LANGUAGE；TS/JS 不带此降级（正反）', () => {
  const decision = decidePreTool(input(['src/tool.py']), ctx());
  assert.equal(kindOf(decision), 'allow');
  assert.equal(decision.degraded?.code, 'UNSUPPORTED_LANGUAGE');
  for (const extension of SUPPORTED_PRE_TOOL_EXTENSIONS) {
    const supported = decidePreTool(input([`src/a${extension}`]), ctx());
    assert.notEqual(supported.degraded?.code, 'UNSUPPORTED_LANGUAGE', extension);
  }
});

test('规则4：受支持语言当前未探查时 advisory ask / strict deny（不放行）', () => {
  for (const mode of ['advisory', 'strict'] as HookMode[]) {
    const decision = decidePreTool(input(['src/a.ts']), ctx({ mode }));
    assert.equal(kindOf(decision), mode === 'advisory' ? 'ask' : 'deny');
  }
});

// ---------------------------------------------------------------------------
// Rule 5: stale/degraded graph -> ask
// ---------------------------------------------------------------------------

test('规则5：stale 图 → ask + GRAPH_STALE；即使文件已探查也不放行（正反）', () => {
  const decision = decidePreTool(input(['src/a.ts']), ctx({
    freshness: { status: 'stale', stale: 3 },
    exploredFiles: ['src/a.ts'],
  }));
  assert.equal(kindOf(decision), 'ask');
  assert.equal(decision.degraded?.code, 'GRAPH_STALE');

  const fresh = decidePreTool(input(['src/a.ts']), ctx({
    freshness: FRESH,
    exploredFiles: ['src/a.ts'],
  }));
  assert.equal(kindOf(fresh), 'allow');
});

test('规则5：degraded 图 → ask + GRAPH_DEGRADED（strict 同样 ask，规则5优先于规则7）', () => {
  for (const mode of ['advisory', 'strict'] as HookMode[]) {
    const decision = decidePreTool(input(['src/a.ts']), ctx({
      mode,
      freshness: { status: 'degraded', stale: 1, reasons: ['partial scan'] },
    }));
    assert.equal(kindOf(decision), 'ask', mode);
    assert.equal(decision.degraded?.code, 'GRAPH_DEGRADED', mode);
  }
});

// ---------------------------------------------------------------------------
// Rule 6: current-revision explored -> allow
// ---------------------------------------------------------------------------

test('规则6：当前 revision 已探查文件 → allow；未探查文件 → 规则7', () => {
  const base = ctx({ exploredFiles: ['src/explored.ts'] });
  assert.equal(kindOf(decidePreTool(input(['src/explored.ts']), base)), 'allow');
  assert.notEqual(kindOf(decidePreTool(input(['src/unexplored.ts']), base)), 'allow');
  // 投影路径规范化：反斜杠 / ./ 前缀不应制造假阴性
  assert.equal(kindOf(decidePreTool(input(['src\\explored.ts']), base)), 'allow');
});

// ---------------------------------------------------------------------------
// Rule 7: otherwise advisory ask / strict deny with remedy
// ---------------------------------------------------------------------------

test('规则7：advisory→ask / strict→deny，两者都给出 explore 补救动作（正反）', () => {
  const ask = decidePreTool(input(['src/a.ts']), ctx({ mode: 'advisory' }));
  assert.equal(kindOf(ask), 'ask');
  assert.match(ask.kind === 'ask' ? ask.reason : '', /explore|探查/u);

  const deny = decidePreTool(input(['src/a.ts']), ctx({ mode: 'strict' }));
  assert.equal(kindOf(deny), 'deny');
  assert.match(deny.kind === 'deny' ? deny.remedy : '', /explore/u);

  const explored = decidePreTool(input(['src/a.ts']), ctx({ mode: 'strict', exploredFiles: ['src/a.ts'] }));
  assert.equal(kindOf(explored), 'allow');
});

// ---------------------------------------------------------------------------
// Determinism, schema, multi-target, revision invalidation
// ---------------------------------------------------------------------------

test('同一输入重复判定结果一致（10 次 deepEqual，advisory 与 strict 各测）', () => {
  for (const mode of ['advisory', 'strict'] as HookMode[]) {
    const i = input(['src/a.ts', 'docs/guide.md']);
    const c = ctx({ mode, exploredFiles: [] });
    const first = decidePreTool(i, c);
    for (let n = 0; n < 10; n += 1) assert.deepEqual(decidePreTool(i, c), first);
  }
});

test('所有规则输出均通过 hookDecisionSchema；多目标按输入顺序取首个阻断', () => {
  const cases: Array<[HookInput, PreToolContext]> = [
    [input(['/outside.ts']), ctx()],
    [input(['README.md']), ctx()],
    [input(['src/new.ts']), ctx({ exists: () => false })],
    [input(['src/tool.py']), ctx()],
    [input(['src/a.ts']), ctx({ freshness: { status: 'stale', stale: 1 } })],
    [input(['src/a.ts']), ctx({ exploredFiles: ['src/a.ts'] })],
    [input(['src/a.ts']), ctx({ mode: 'strict' })],
  ];
  for (const [i, c] of cases) assert.equal(hookDecisionSchema.safeParse(decidePreTool(i, c)).success, true);

  const mixed = decidePreTool(input(['README.md', 'src/unexplored.ts', 'src/also.ts']), ctx());
  assert.equal(kindOf(mixed), 'ask');
  const allAllowed = decidePreTool(input(['README.md', 'src/tool.py', 'src/new.ts']), ctx({ exists: () => false }));
  assert.equal(kindOf(allAllowed), 'allow');
});

test('revision 变化后旧的 explored 证据失效：旧 revision 允许，新 revision 拒绝', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ano-pre-tool-revision-'));
  try {
    const ledger = await Ledger.open(root, { sessionId: 'S1', actor: 'A', clock: () => 1000 });
    await ledger.append({
      kind: 'structure.queried',
      payload: {
        granularity: 'file', file: 'src/a.ts', graph_revision: REV,
        query: 'outline', result: { total: 1, returned: 1, truncated: false, impact: [], classification: 'parsed' },
      },
    }, 'structure:query:v1:old');
    ledger.close();

    const viewsPath = defaultViewsPath(root);
    const readCtx = (revision: string, mode: HookMode = 'advisory'): PreToolContext => ({
      mode, root, freshness: FRESH, revision, exists: () => true,
    });
    assert.equal(kindOf(decidePreTool(input(['src/a.ts']), readCtx(REV))), 'allow');
    const changed = decidePreTool(input(['src/a.ts']), readCtx('rev-next'));
    assert.equal(kindOf(changed), 'ask'); // advisory 的兜底规则7
    assert.equal(kindOf(decidePreTool(input(['src/a.ts']), readCtx('rev-next', 'strict'))), 'deny');
  } finally {
    removeTempRoot(root);
  }
});

// ---------------------------------------------------------------------------
// Zero writes: no Ledger segment, no .ano/ledger, no views schema mutation
// ---------------------------------------------------------------------------

test('零写：判定前后项目根内不新增 .ano/ledger segment、不改动 views.db 字节', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ano-pre-tool-zero-write-'));
  try {
    const ledger = await Ledger.open(root, { sessionId: 'S1', actor: 'A', clock: () => 1000 });
    await ledger.append({
      kind: 'structure.queried',
      payload: {
        granularity: 'file', file: 'src/a.ts', graph_revision: REV,
        query: 'outline', result: { total: 1, returned: 1, truncated: false, impact: [], classification: 'parsed' },
      },
    }, 'structure:query:v1:zero');
    ledger.close();

    const ledgerDir = join(root, '.ano', 'ledger');
    const viewsPath = defaultViewsPath(root);
    const segmentsBefore = readdirSync(ledgerDir).sort();
    const { readFileSync } = await import('node:fs');
    const viewsBytesBefore = Buffer.from(readFileSync(viewsPath));

    const scenarios: Array<[HookInput, PreToolContext]> = [
      [input(['/outside.ts']), ctx({ root })],
      [input(['src/a.ts']), { mode: 'strict', root, freshness: FRESH, revision: REV }],
      [input(['src/b.ts']), { mode: 'advisory', root, freshness: { status: 'stale', stale: 2 }, revision: REV }],
    ];
    for (const [i, c] of scenarios) decidePreTool(i, c);

    assert.deepEqual(readdirSync(ledgerDir).sort(), segmentsBefore, 'no new ledger segment');
    assert.deepEqual(Buffer.from(readFileSync(viewsPath)), viewsBytesBefore, 'views.db unchanged');

    // 未初始化的项目：判定后仍然不存在 .ano/ledger
    const emptyRoot = join(root, 'empty');
    mkdirSync(emptyRoot);
    decidePreTool(input(['src/a.ts']), { mode: 'strict', root: emptyRoot, freshness: FRESH, revision: REV });
    assert.equal(existsSync(join(emptyRoot, '.ano', 'ledger')), false);
    assert.equal(existsSync(defaultViewsPath(emptyRoot)), false);
  } finally {
    removeTempRoot(root);
  }
});

// ---------------------------------------------------------------------------
// 抽取保护测试：readExploredProjection 与 service.readStructureProjection 同值
// ---------------------------------------------------------------------------

function serviceProjectionReplica(viewsPath: string, revision: string) {
  if (!existsSync(viewsPath)) {
    return { graphRevision: revision, exploredFiles: [], staleFiles: [], fileQueries: 0, lastRevision: null };
  }
  const db = new DatabaseSync(viewsPath);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    initViews(db);
    const state = exploredState(db, revision);
    return {
      graphRevision: revision,
      exploredFiles: state.explored,
      staleFiles: state.stale,
      fileQueries: readStructureQueries(db, { granularity: 'file' }).length,
      lastRevision: readLatestStructureQueryRevision(db),
    };
  } finally { db.close(); }
}

test('抽取不改行为：readExploredProjection 与 service.readStructureProjection 逻辑同值（含缺库/缺表/旧 revision）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ano-pre-tool-projection-'));
  try {
    const viewsPath = defaultViewsPath(root);
    // 缺库：两边都返回空投影
    assert.deepEqual(readExploredProjection(viewsPath, REV), serviceProjectionReplica(viewsPath, REV));

    // 缺表（空 db）：两边都返回空投影
    mkdirSync(dirname(viewsPath), { recursive: true });
    const empty = new DatabaseSync(viewsPath);
    empty.close();
    assert.deepEqual(readExploredProjection(viewsPath, REV), serviceProjectionReplica(viewsPath, REV));

    const ledger = await Ledger.open(root, { sessionId: 'S1', actor: 'A', clock: () => 1000 });
    for (const [file, revision, key] of [
      ['src/a.ts', REV, 'structure:query:v1:a'],
      ['src/b.ts', 'rev-old', 'structure:query:v1:b'],
    ] as const) {
      await ledger.append({
        kind: 'structure.queried',
        payload: {
          granularity: 'file', file, graph_revision: revision, query: 'outline',
          result: { total: 1, returned: 1, truncated: false, impact: [], classification: 'parsed' },
        },
      }, key);
    }
    ledger.close();

    for (const revision of [REV, 'rev-old', 'rev-unknown']) {
      assert.deepEqual(
        readExploredProjection(viewsPath, revision),
        serviceProjectionReplica(viewsPath, revision),
        `revision ${revision}`,
      );
    }
    assert.deepEqual(
      readExploredProjection(viewsPath, REV).exploredFiles,
      currentExploredFiles(new DatabaseSync(viewsPath, { readOnly: true }), REV),
    );
  } finally {
    removeTempRoot(root);
  }
});

test('只读边界：readExploredProjection 不创建数据库文件；只读句柄不可写 views', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ano-pre-tool-readonly-'));
  try {
    const viewsPath = defaultViewsPath(root);
    const projection = readExploredProjection(viewsPath, REV);
    assert.equal(existsSync(viewsPath), false, 'no views.db created');
    assert.deepEqual(projection.exploredFiles, []);

    // 探测 readOnly 边界：已存在库时，只读句柄上的写入必须失败
    mkdirSync(dirname(viewsPath), { recursive: true });
    const writable = new DatabaseSync(viewsPath);
    initViews(writable);
    writable.close();
    const db = new DatabaseSync(viewsPath, { readOnly: true });
    assert.throws(() => db.exec("CREATE TABLE should_not_exist (x TEXT)"), /readonly/i);
    db.close();
  } finally {
    removeTempRoot(root);
  }
});
