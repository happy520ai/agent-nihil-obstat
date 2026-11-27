import { resolveAnchor, type AnchorResolution, type AnchorSource, type MemoryAnchor } from './anchor.ts';
import type { MemoryNote, MemoryNoteKind } from './note.ts';
import type { HistorySummary, MemoryCounts, ProviderState } from './types.ts';

/**
 * Memory brief aggregation for the main controller. It is not registered as a
 * Surface tool here; `src/surface/memory.ts` owns note/recall wiring, and the
 * controller can merge this object into its existing brief response using
 * `Ledger.listNotes()` plus an anchor source it trusts.
 *
 * Output sections:
 * - focus: caller-supplied focus/checkpoint data, passed through;
 * - knowledge: anchors relevant to touched/focus files, plus every stale anchor;
 * - caches: history.db provider status and freshness signal;
 * - unexploredChanges: touched files that were not part of a structure query.
 */
/**
 * ADR-010 §3.4: projection-derived structure evidence. `exploredFiles` is the
 * revision-bound file-level query set owned by the ledger projection
 * (`views.currentExploredFiles`); it is never accepted from an MCP caller.
 * `staleFiles` are files whose latest file-level evidence predates the current
 * graph revision. The surface passes this in after reading the projection.
 */
export interface MemoryBriefStructure {
  readonly graphRevision: string | null;
  readonly exploredFiles: readonly string[];
  readonly staleFiles: readonly string[];
  readonly fileQueries: number;
  readonly lastRevision: string | null;
}

export interface MemoryBriefInput {
  readonly focus?: unknown;
  readonly notes: readonly MemoryNote[];
  readonly anchorSource: AnchorSource;
  readonly touchedFiles?: readonly string[];
  readonly focusFiles?: readonly string[];
  /**
   * Legacy read-only compatibility input. It is intersected with the
   * projection-derived set and can never manufacture coverage on its own
   * (ADR-010 §3.4): when no projection is supplied the explored set is empty.
   */
  readonly exploredFiles?: readonly string[];
  readonly structure?: MemoryBriefStructure;
  readonly history?: Pick<HistorySummary, 'ftsAvailable' | 'rebuilt' | 'providers' | 'counts' | 'skippedArtifacts'>;
  readonly now?: string;
}

export interface BriefNoteProvenance {
  readonly kind: 'memory-note';
  readonly noteId: string;
}

export interface BriefNote {
  readonly id: string;
  readonly kind: MemoryNoteKind;
  readonly text: string;
  readonly createdAt: string;
  readonly anchor: MemoryAnchor | undefined;
  /** Null for session summaries, which intentionally carry no anchor. */
  readonly resolution: AnchorResolution | null;
  /** Note text is untrusted data: callers must never execute or evaluate it. */
  readonly untrusted: true;
  readonly provenance: BriefNoteProvenance;
}

export type HistoryFreshness = 'fresh' | 'stale' | 'rebuilt' | 'degraded' | 'failed' | 'unknown';

export interface MemoryBrief {
  readonly generatedAt: string;
  readonly focus: unknown;
  readonly knowledge: {
    readonly relevant: readonly BriefNote[];
    readonly stale: readonly BriefNote[];
    readonly counts: Readonly<Record<MemoryNoteKind, number>>;
  };
  readonly caches: {
    readonly history: {
      readonly status: HistoryFreshness;
      readonly ftsAvailable: boolean | null;
      readonly rebuilt: boolean | null;
      readonly providers: readonly ProviderState[];
      readonly failedProviders: readonly string[];
      readonly degradedProviders: readonly string[];
      readonly counts: MemoryCounts | null;
      readonly skippedArtifacts: number;
    };
  };
  readonly unexploredChanges: {
    readonly touched: number;
    readonly explored: number;
    /** Projection-derived file-level explored set at the current revision. */
    readonly exploredFiles: readonly string[];
    readonly modifiedWithoutExplore: readonly string[];
    readonly warning: string | null;
  };
  /**
   * ADR-010 §3.4: revision-bound structure query summary. `exploredFiles` here
   * is the same projection set used for the warning; it is never caller input.
   */
  readonly structure: {
    readonly graphRevision: string | null;
    readonly exploredFiles: readonly string[];
    readonly fileQueries: number;
    readonly lastRevision: string | null;
    readonly staleCount: number;
  };
  readonly limitations: readonly string[];
}

const KIND_ORDER: readonly MemoryNoteKind[] = ['decision', 'pitfall', 'memory', 'session_summary'];

export function buildMemoryBrief(input: MemoryBriefInput): MemoryBrief {
  const touched = normalizeFiles(input.touchedFiles ?? []);
  const focusFiles = normalizeFiles(input.focusFiles ?? []);
  // ADR-010 §3.4: the projection is authoritative. A legacy caller-supplied
  // list may only narrow it (intersection); it can never widen it or survive an
  // empty projection, so a caller can never claim coverage that no
  // `structure.queried(file, revision=R)` event supports. When the caller
  // supplies no list the projection alone drives the explored set.
  const projectedExplored = new Set(normalizeFiles(input.structure?.exploredFiles ?? []));
  const claimedExplored = normalizeFiles(input.exploredFiles ?? []);
  const explored = claimedExplored.length === 0
    ? projectedExplored
    : new Set(claimedExplored.filter((file) => projectedExplored.has(file)));
  const exploredFiles = [...projectedExplored].sort();
  const filter = new Set([...touched, ...focusFiles]);

  const resolved: BriefNote[] = input.notes.map((note) => ({
    id: note.id,
    kind: note.kind,
    text: note.text,
    createdAt: note.createdAt,
    anchor: note.anchor,
    resolution: note.anchor ? resolveAnchor(note.anchor, input.anchorSource) : null,
    untrusted: true,
    provenance: { kind: 'memory-note', noteId: note.id },
  }));

  const stale = resolved.filter((note) => note.resolution?.status === 'stale');
  const usable = resolved.filter((note) => note.resolution?.status !== 'stale');
  const relevant = (filter.size === 0 ? usable : usable.filter((note) => note.resolution === null || (note.resolution.file !== null && filter.has(note.resolution.file))))
    .sort((left, right) => KIND_ORDER.indexOf(left.kind) - KIND_ORDER.indexOf(right.kind) || right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id));

  const counts: Record<MemoryNoteKind, number> = { decision: 0, pitfall: 0, memory: 0, session_summary: 0 };
  for (const note of input.notes) counts[note.kind] += 1;

  const modifiedWithoutExplore = touched.filter((file) => !explored.has(file));
  const history = input.history;
  const providers = history?.providers ?? [];
  const failedProviders = providers.filter((provider) => provider.status === 'failed').map((provider) => provider.provider);
  const degradedProviders = providers.filter((provider) => provider.status === 'degraded').map((provider) => provider.provider);
  // A provider that failed or degraded during ingest must never be reported as
  // fresh. Skipped artifacts stay visible through the count below.
  const status: HistoryFreshness = history === undefined
    ? 'unknown'
    : history.rebuilt
      ? 'rebuilt'
      : failedProviders.length > 0
        ? 'failed'
        : degradedProviders.length > 0
          ? 'degraded'
          : 'fresh';

  return {
    generatedAt: input.now ?? new Date().toISOString(),
    focus: input.focus ?? null,
    knowledge: { relevant, stale, counts },
    caches: {
      history: {
        status,
        ftsAvailable: history?.ftsAvailable ?? null,
        rebuilt: history?.rebuilt ?? null,
        providers,
        failedProviders,
        degradedProviders,
        counts: history?.counts ?? null,
        skippedArtifacts: history?.skippedArtifacts.length ?? 0,
      },
    },
    unexploredChanges: {
      touched: touched.length,
      explored: touched.filter((file) => explored.has(file)).length,
      exploredFiles,
      modifiedWithoutExplore,
      warning: modifiedWithoutExplore.length > 0
        ? `Modified ${modifiedWithoutExplore.length} file(s) without a structure query`
        : null,
    },
    structure: {
      graphRevision: input.structure?.graphRevision ?? null,
      exploredFiles,
      fileQueries: input.structure?.fileQueries ?? 0,
      lastRevision: input.structure?.lastRevision ?? null,
      staleCount: normalizeFiles(input.structure?.staleFiles ?? []).length,
    },
    limitations: [
      'Memory notes are recorded through noteSurface; this aggregator does not read the ledger, so callers must pass Ledger.listNotes() output.',
      'history.db session adapters are synthetic-fixture only; no real client format is claimed.',
      'exploredFiles is derived from committed structure.queried events at the current graph revision; a caller-supplied exploredFiles list is intersected with that projection and can never manufacture coverage.',
    ],
  };
}

function normalizeFiles(files: readonly string[]): string[] {
  return [...new Set(files.map((file) => file.replaceAll('\\', '/').replace(/^\.\//, '')).filter((file) => file.length > 0))];
}
