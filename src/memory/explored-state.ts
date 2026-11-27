import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { exploredState, readLatestStructureQueryRevision, readStructureQueries } from '../ledger/views.ts';
import type { MemoryBriefStructure } from './brief.ts';

/**
 * T-164 / ADR-010 §3.4 / ADR-013 §4.3: pure-read extraction of the
 * revision-bound `exploredFiles` projection built by
 * `src/surface/service.ts::readStructureProjection` from the ledger views
 * cache. `service.ts` is a churn hotspot reserved for T-170 and is NOT edited
 * here; this module is the reusable, strictly read-only twin.
 *
 * 抽取不改行为: the returned values are built by the same three projection
 * readers (`exploredState` / `readStructureQueries` /
 * `readLatestStructureQueryRevision`) with the same empty-cache fallback and
 * the same revision binding. `test/unit/hook-pre-tool.test.ts` pins the
 * value-level equivalence against the service logic.
 *
 * 零写边界: unlike the service path (which opens a read-write handle and calls
 * `initViews`), this module opens the cache with `readOnly: true` and never
 * calls `initViews`. It therefore cannot create/reset schema, hold a Ledger
 * write handle, rebuild the graph, or create a `.ano/ledger` segment. A missing
 * or unreadable derived cache is an empty projection, never an error and never
 * a trigger for a rebuild — downstream rules fail closed instead.
 */

/** Empty projection with the exact shape used by `service.readStructureProjection`. */
function emptyProjection(revision: string): MemoryBriefStructure {
  return { graphRevision: revision, exploredFiles: [], staleFiles: [], fileQueries: 0, lastRevision: null };
}

function hasProjectionTables(db: DatabaseSync): boolean {
  for (const table of ['explored_files', 'structure_queries']) {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { name?: unknown } | undefined;
    if (row?.name !== table) return false;
  }
  return true;
}

/**
 * Read the current structure projection from `viewsPath` without writing to it.
 * `revision` is the caller-supplied current graph revision; evidence recorded
 * at any other revision is reported as `staleFiles`, never `exploredFiles`.
 */
export function readExploredProjection(viewsPath: string, revision: string): MemoryBriefStructure {
  if (!existsSync(viewsPath)) return emptyProjection(revision);
  let db: DatabaseSync | undefined;
  try {
    // Read-only handle: cannot start a Ledger segment, reset views or create
    // schema. This is the hard boundary that keeps pre-tool strictly read-only.
    db = new DatabaseSync(viewsPath, { readOnly: true });
    if (!hasProjectionTables(db)) return emptyProjection(revision);
    const state = exploredState(db, revision);
    return {
      graphRevision: revision,
      exploredFiles: state.explored,
      staleFiles: state.stale,
      fileQueries: readStructureQueries(db, { granularity: 'file' }).length,
      lastRevision: readLatestStructureQueryRevision(db),
    };
  } catch {
    // Derived cache unreadable/corrupt yields no coverage; the hook fails
    // closed downstream (rule 7), it never throws or rebuilds.
    return emptyProjection(revision);
  } finally {
    db?.close();
  }
}

/** Views cache path for a project root, mirroring `Ledger.viewsPath`. */
export function defaultViewsPath(root: string): string {
  return join(resolve(root), '.ano', 'cache', 'views.db');
}
