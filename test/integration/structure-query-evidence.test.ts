import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { canonicalJson, genesisHash, hashEvent, type LedgerEvent } from '../../src/ledger/event.ts';
import { Ledger } from '../../src/ledger/ledger.ts';
import { replayLedger } from '../../src/ledger/replay.ts';
import { GraphStore } from '../../src/structure/store.ts';
import { currentExploredFiles, exploredState, initViews, readStructureQueries } from '../../src/ledger/views.ts';
import { buildMemoryBrief } from '../../src/memory/brief.ts';
import { brief, structureFileQuery, type BriefSurfaceInput } from '../../src/surface/service.ts';
import { checkSchemaPins, PINNED } from '../../scripts/check-schema.ts';

/**
 * ADR-010 / T-112 acceptance: a real file-level outline/impact query commits a
 * revision-bound `structure.queried` event, `brief` derives exploredFiles from
 * that projection (never from caller input), symbol queries cannot manufacture
 * file coverage, an idempotent retry returns the same event, and a graph
 * revision change makes the old evidence stale until the file is re-queried.
 */

const FIXTURE: Record<string, string> = {
  '.gitignore': '.ano/\n',
  'package.json': JSON.stringify({ name: 'structure-evidence-fixture', private: true }, null, 2),
  'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.' } }, null, 2),
  'src/a.ts': "import { b } from './b.js';\nexport const a = b + 1;\n",
  'src/b.ts': 'export const b = 1;\n',
  'src/c.ts': 'export const c = 3;\n',
};

function git(root: string, args: readonly string[]): void {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
}

async function project(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ano-structure-evidence-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  for (const [path, content] of Object.entries(FIXTURE)) {
    const absolute = join(root, ...path.split('/'));
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'ano@localhost'], ['config', 'user.name', 'ano'], ['add', '.'], ['commit', '-qm', 'base']]) {
    git(root, args);
  }
  return root;
}

interface BriefShape {
  memory: {
    structure: { graphRevision: string | null; exploredFiles: string[]; staleCount: number; fileQueries: number };
    unexploredChanges: { explored: number; modifiedWithoutExplore: string[]; warning: string | null };
  };
}

function briefShape(root: string): Promise<BriefShape> {
  return brief(root) as unknown as Promise<BriefShape>;
}

function committedStructureEvents(root: string): LedgerEvent[] {
  return replayLedger(join(root, '.ano', 'ledger')).entries.map((entry) => entry.event).filter((event) => event.kind === 'structure.queried');
}

function viewsDb(root: string): DatabaseSync {
  const db = new DatabaseSync(join(root, '.ano', 'cache', 'views.db'));
  initViews(db);
  return db;
}

function readRows(root: string) {
  const db = viewsDb(root);
  try { return readStructureQueries(db); } finally { db.close(); }
}

function exploredAt(root: string, revision: string): string[] {
  const db = viewsDb(root);
  try { return currentExploredFiles(db, revision); } finally { db.close(); }
}

test('file query evidence drives exploredFiles, per-file warnings, idempotency and revision invalidation', async (t) => {
  const root = await project(t);
  // b.ts is the only touched file: every warning below is about this one file.
  await writeFile(join(root, 'src', 'b.ts'), 'export const b = 2;\n');

  // No query yet: touched but unexplored, warning present, explored = 0.
  const before = await briefShape(root);
  assert.deepEqual(before.memory.structure.exploredFiles, []);
  assert.equal(before.memory.structure.staleCount, 0);
  assert.deepEqual(before.memory.unexploredChanges.modifiedWithoutExplore, ['src/b.ts']);
  assert.match(before.memory.unexploredChanges.warning ?? '', /without a structure query/u);

  // ADR-010 §3.4: caller-supplied exploredFiles can never manufacture coverage.
  const forged = (await brief(root, { exploredFiles: ['src/b.ts'] } as unknown as BriefSurfaceInput)) as unknown as BriefShape;
  assert.deepEqual(forged.memory.structure.exploredFiles, []);
  assert.deepEqual(forged.memory.unexploredChanges.modifiedWithoutExplore, ['src/b.ts']);
  assert.match(forged.memory.unexploredChanges.warning ?? '', /without a structure query/u);
  const direct = buildMemoryBrief({
    notes: [],
    anchorSource: { findSymbolById: () => undefined, findSymbolByQualifiedName: () => undefined, readFile: () => undefined },
    touchedFiles: ['src/b.ts'],
    exploredFiles: ['src/b.ts'],
  });
  assert.deepEqual(direct.unexploredChanges.exploredFiles, []);
  assert.match(direct.unexploredChanges.warning ?? '', /without a structure query/u);

  // Real file-level outline query: evidence lands in the ledger and the
  // projection clears the warning for exactly this file.
  const outline = await structureFileQuery(root, { file: 'src/b.ts', kind: 'outline' });
  assert.equal(outline.evidenceError, undefined);
  assert.equal(outline.evidence?.duplicate, false);
  assert.ok(outline.evidence?.eventId);
  assert.equal(outline.classification, 'zero-edge');

  const eventsAfterOutline = committedStructureEvents(root);
  assert.equal(eventsAfterOutline.length, 1);
  const committed = eventsAfterOutline[0]!;
  assert.equal(committed.payload.granularity, 'file');
  assert.equal(committed.payload.file, 'src/b.ts');
  assert.equal(committed.payload.graph_revision, outline.graphRevision);
  assert.equal(committed.payload.query, 'outline:src/b.ts');
  assert.equal(committed.idem_key !== undefined, true);
  assert.equal(typeof committed.payload.result, 'object');

  const afterOutline = await briefShape(root);
  assert.deepEqual(afterOutline.memory.structure.exploredFiles, ['src/b.ts']);
  assert.equal(afterOutline.memory.structure.staleCount, 0);
  assert.deepEqual(afterOutline.memory.unexploredChanges.modifiedWithoutExplore, []);
  assert.equal(afterOutline.memory.unexploredChanges.warning, null);
  assert.equal(afterOutline.memory.unexploredChanges.explored, 1);
  assert.deepEqual(exploredAt(root, outline.graphRevision), ['src/b.ts']);

  // Same key + same parameters: duplicate, no extra event, no double count.
  const replay = await structureFileQuery(root, { file: 'src/b.ts', kind: 'outline' });
  assert.equal(replay.evidence?.duplicate, true);
  assert.equal(replay.evidence?.eventId, outline.evidence?.eventId);
  assert.equal(committedStructureEvents(root).length, 1);

  // Same file through the impact path is still file-granularity evidence and
  // keeps the per-file warning cleared.
  const impact = await structureFileQuery(root, { file: 'src/b.ts', kind: 'impact' });
  assert.equal(impact.evidence?.duplicate, false);
  assert.equal(impact.query, 'impact:src/b.ts');
  const eventsAfterImpact = committedStructureEvents(root);
  assert.equal(eventsAfterImpact.length, 2);
  assert.ok(eventsAfterImpact.every((event) => event.payload.granularity === 'file'));
  const afterImpact = await briefShape(root);
  assert.deepEqual(afterImpact.memory.structure.exploredFiles, ['src/b.ts']);
  assert.equal(afterImpact.memory.unexploredChanges.warning, null);

  // Symbol-level query through the same surface: recorded, but never file coverage.
  const symbol = await structureFileQuery(root, { file: 'src/c.ts', kind: 'outline', ref: 'c' });
  assert.equal(symbol.evidenceError, undefined);
  assert.equal(symbol.ref, 'c');
  const symbolRows = readRows(root).filter((row) => row.granularity === 'symbol');
  assert.equal(symbolRows.length, 1);
  assert.equal(symbolRows[0]?.file, 'src/c.ts');
  assert.equal(symbolRows[0]?.ref, 'c');
  assert.deepEqual(exploredAt(root, symbol.graphRevision), ['src/b.ts']);
  const afterSymbol = await briefShape(root);
  assert.deepEqual(afterSymbol.memory.structure.exploredFiles, ['src/b.ts']);

  // ADR-010 §3.3: a graph revision change makes the old evidence stale; the
  // warning returns until the file is queried again at the new revision.
  const revisionBefore = outline.graphRevision;
  await writeFile(join(root, 'src', 'b.ts'), 'export const b = 3;\n');
  // A real consumer rebuilds the graph after source edits; that rebuild is what
  // produces the new revision that invalidates the old evidence.
  const rebuild = await GraphStore.open(root);
  await rebuild.build();
  rebuild.close();
  const stale = await briefShape(root);
  assert.notEqual(stale.memory.structure.graphRevision, revisionBefore);
  assert.deepEqual(stale.memory.structure.exploredFiles, []);
  assert.equal(stale.memory.structure.staleCount, 1);
  assert.match(stale.memory.unexploredChanges.warning ?? '', /without a structure query/u);
  const db = viewsDb(root);
  let state: { explored: string[]; stale: string[] };
  try { state = exploredState(db, stale.memory.structure.graphRevision as string); } finally { db.close(); }
  assert.deepEqual(state.stale, ['src/b.ts']);

  const requery = await structureFileQuery(root, { file: 'src/b.ts', kind: 'outline' });
  assert.equal(requery.evidenceError, undefined);
  assert.equal(requery.evidence?.duplicate, false);
  assert.notEqual(requery.graphRevision, revisionBefore);
  assert.deepEqual(exploredAt(root, requery.graphRevision), ['src/b.ts']);
  const afterRequery = await briefShape(root);
  assert.deepEqual(afterRequery.memory.structure.exploredFiles, ['src/b.ts']);
  assert.equal(afterRequery.memory.structure.staleCount, 0);
  assert.equal(afterRequery.memory.unexploredChanges.warning, null);
});

test('structure query persistence failure is surfaced without failing the query', async (t) => {
  const root = await project(t);
  const ok = await structureFileQuery(root, { file: 'src/b.ts', kind: 'outline' });
  assert.equal(ok.evidenceError, undefined);

  // Replace the derived views cache with a directory so the ledger cannot open
  // it; the read-only query must still return its result.
  await rm(join(root, '.ano', 'cache', 'views.db'));
  await mkdir(join(root, '.ano', 'cache', 'views.db'));
  const failed = await structureFileQuery(root, { file: 'src/c.ts', kind: 'outline' });
  assert.equal(failed.query, 'outline:src/c.ts');
  assert.equal(failed.evidence, undefined);
  assert.equal(typeof failed.evidenceError, 'string');
  assert.match(failed.evidenceError ?? '', /.+/u);
});

test('projection rebuild matches incremental state; legacy hashes and schema pins stay fixed', async (t) => {
  const root = await project(t);
  const queried = await structureFileQuery(root, { file: 'src/b.ts', kind: 'outline' });
  assert.equal(queried.evidenceError, undefined);
  const incremental = readRows(root);

  await rm(join(root, '.ano', 'cache'), { recursive: true, force: true });
  const reopened = await Ledger.open(root);
  reopened.close();
  const rebuilt = readRows(root);
  assert.deepEqual(rebuilt, incremental);
  assert.equal(rebuilt[0]?.graphRevision, queried.graphRevision);

  // Committed pre-structure events keep their exact canonical bytes and hash.
  const legacy: LedgerEvent = {
    id: '00000000Z848MK0DSY8N656PK1',
    hlc: { physical: 1000, logical: 0, actor: 'A' },
    actor: 'A',
    kind: 'task.created',
    payload: { task_id: 'T-legacy', declared_files: ['src/a.ts'] },
    prev_hash: genesisHash,
  };
  assert.equal(canonicalJson(legacy), '{"actor":"A","hlc":{"actor":"A","logical":0,"physical":1000},"id":"00000000Z848MK0DSY8N656PK1","kind":"task.created","payload":{"declared_files":["src/a.ts"],"task_id":"T-legacy"},"prev_hash":"0000000000000000000000000000000000000000000000000000000000000000"}');
  assert.equal(hashEvent(legacy), 'd44a88cc30d027dddf1e532341ac1c1b2612e04e8b217c0780d20dc28d2e400b');

  // Schema pin gate: the new kind is pinned explicitly and the seven tool
  // hashes did not move.
  const pin = checkSchemaPins();
  assert.equal(pin.ok, true, pin.problems.join('; '));
  assert.deepEqual(pin.current.ledgerKinds.slice(-2), ['session.started', 'session.stop_checked']);
  assert.deepEqual(pin.current.tools, PINNED.tools);
});
