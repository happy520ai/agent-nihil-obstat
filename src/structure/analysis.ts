import { createHash } from 'node:crypto';
import { GraphStore, type GraphStoreOpenOptions } from './store.ts';
import { SUPPORTED_EXTENSIONS } from './extractors/ts.ts';
import type { ScanStatus } from '../core/project-scan.ts';
import type { BlindSpotType, DynamicLoadTier, Freshness, GraphSnapshot, StructureErrorCode, SymbolNode } from './types.ts';
import { STRUCTURE_CLASSIFICATION_INVALID, STRUCTURE_EVIDENCE_STALE, STRUCTURE_QUERY_REVISION_MISMATCH } from './types.ts';

/**
 * ADR-010 §4/§5/§8: single-snapshot batch structure analysis.
 *
 * One `GraphSnapshot` produces every file-level result (symbol counts,
 * incoming/outgoing imports and calls, direct/transitive dependents, unchanged
 * blast radius and the nine-way coverage classification). The module never
 * reopens the graph store: `openStructureAnalyzer` opens once, calls
 * `ensureFresh`/`snapshot` once and hands back a session that reuses the
 * prebuilt reverse indexes for every file-level outline/impact query.
 */

export const COVERAGE_CLASSIFICATIONS = [
  'parsed',
  'zero-symbol',
  'zero-edge',
  'dynamic-only',
  'unsupported',
  'excluded',
  'deleted',
  'degraded',
  'unknown',
] as const;

export type CoverageClassification = (typeof COVERAGE_CLASSIFICATIONS)[number];

/**
 * Fail-closed guard for the nine-way classification (ADR-010 §4/§10.2). Every
 * derived row passes through it; an unknown value can never be reported as a
 * valid coverage class.
 */
export function assertValidClassification(value: unknown): asserts value is CoverageClassification {
  if (typeof value !== 'string' || !(COVERAGE_CLASSIFICATIONS as readonly string[]).includes(value)) {
    throw Object.assign(
      new Error(`Invalid structure classification: ${String(value)}`),
      { code: STRUCTURE_CLASSIFICATION_INVALID },
    );
  }
}

/**
 * Revision-mismatch vocabulary (ADR-010 §10.2): query/previous evidence bound
 * to a different graph revision must never be treated as current.
 */
export function structureQueryRevisionCode(evidenceRevision: string | undefined, graphRevision: string): StructureErrorCode | undefined {
  if (evidenceRevision === undefined || evidenceRevision === graphRevision) return undefined;
  return STRUCTURE_QUERY_REVISION_MISMATCH;
}

/** Stale-evidence vocabulary (ADR-010 §10.2): old-revision evidence is flagged, never reused. */
export function structureEvidenceStaleCode(stale: boolean): StructureErrorCode | undefined {
  return stale ? STRUCTURE_EVIDENCE_STALE : undefined;
}

/** Location-bound evidence for a semantic gap (ADR-010 §4.2). */
export interface SemanticGap {
  readonly line: number;
  readonly pattern: string;
  readonly reason: string;
}

/** Patterns that make static analysis insufficient as the main judgment. */
const UNKNOWN_MAIN_PATTERNS: ReadonlySet<string> = new Set([
  'registry',
  'reflection',
  'eval',
  'computed-require',
  'computed_require',
  'dynamic-require',
  'dynamic_require',
]);

/** Blind-spot categories that downgrade a file to `unknown` (ADR-010 §4.2). */
const UNKNOWN_MAIN_TYPES: ReadonlySet<BlindSpotType> = new Set(['registry-scan', 'reflection', 'eval']);

/** Caller-supplied located evidence for one file (T-116 blind-spot input). */
export interface BlindSpotInput {
  readonly type: BlindSpotType;
  readonly line?: number;
  readonly pattern?: string;
  readonly reason: string;
  readonly tier?: DynamicLoadTier;
  readonly target?: string;
}

/** One reported blind spot: always a type, a location and a reason. */
export interface BlindSpot {
  readonly file: string;
  readonly type: BlindSpotType;
  readonly line?: number;
  readonly pattern?: string;
  readonly reason: string;
  readonly tier?: DynamicLoadTier;
  readonly target?: string;
}

/** Three-tier dynamic-load counts (ADR-010 §7.3). */
export interface DynamicLoadSummary {
  readonly resolved: number;
  readonly heuristic: number;
  readonly unknown: number;
}

/** A finding that is either automatically decidable or needs a human. */
export interface CoverageFinding {
  readonly file: string;
  readonly type: BlindSpotType;
  readonly line?: number;
  readonly pattern?: string;
  readonly reason: string;
  readonly tier?: DynamicLoadTier;
  readonly target?: string;
}

/** Explicit coverage conclusion: zero unresolved loads is never "all healthy". */
export interface CoverageConclusion {
  readonly unresolvedDynamicLoads: number;
  readonly dynamicLoads: DynamicLoadSummary;
  readonly blindSpotCount: number;
  readonly statement: string;
}

export interface FileIo {
  readonly incoming: number;
  readonly outgoing: number;
  readonly resolvedOutgoing: number;
}

export interface FileAnalysis {
  readonly file: string;
  readonly classification: CoverageClassification;
  readonly symbols: number;
  /** Real dependency edges plus `resolved` call edges (ADR-010 §4.2). */
  readonly staticEdges: number;
  readonly fanout: number;
  readonly dynamicLoads: number;
  readonly unresolvedDynamicLoads: number;
  readonly imports: FileIo;
  readonly calls: FileIo;
  /** Reverse counts for this file as the touched root. */
  readonly directDependents: number;
  readonly transitiveDependents: number;
  /** False only for `excluded` (ADR-010 §4.6). */
  readonly inScope: boolean;
  readonly semanticGaps: readonly SemanticGap[];
  readonly flags: readonly string[];
  readonly evidenceRevision: string;
}

export interface RiskWeights {
  readonly direct?: number;
  readonly transitive?: number;
  readonly touched?: number;
  readonly fanoutCap?: number;
  readonly fanoutDivisor?: number;
  readonly complexityCap?: number;
  readonly complexityDivisor?: number;
  readonly blindPenalty?: number;
  readonly advisoryPenalty?: number;
}

export interface RiskThresholds {
  readonly high?: number;
  readonly medium?: number;
  readonly highFanout?: number;
}

export interface FileRisk {
  readonly file: string;
  readonly classification: CoverageClassification;
  readonly direct: number;
  readonly transitive: number;
  readonly fanout: number;
  readonly symbols: number;
  readonly riskScore: number;
  readonly level: 'high' | 'medium' | 'low';
  /** Every additive term, so the score is explainable rather than a black box. */
  readonly parts: {
    readonly direct: number;
    readonly transitive: number;
    readonly touched: number;
    readonly coveragePenalty: number;
    readonly fanoutTerm: number;
    readonly complexityTerm: number;
    readonly impactScore: number;
  };
}

export interface FanoutTop {
  readonly file: string;
  readonly fanout: number;
}

export interface StructureMetrics {
  readonly inScope: number;
  readonly touched: number;
  readonly direct: number;
  readonly transitive: number;
  readonly unchanged: number;
  readonly fanout: readonly FanoutTop[];
  readonly blindness: number;
  readonly explored: number;
  readonly maxDepth: number;
  readonly depthLimited: boolean;
}

export interface ImpactReport {
  readonly touched: readonly string[];
  /** Depth-1 reverse dependents, roots excluded. */
  readonly direct: readonly string[];
  /** Bounded reverse closure minus roots (includes `direct`). */
  readonly transitive: readonly string[];
  readonly unchanged: readonly string[];
  readonly depthLimited: boolean;
}

export interface StructureAnalysis {
  readonly revision: string;
  readonly sourceFingerprint: string;
  readonly maxDepth: number;
  readonly depthLimited: boolean;
  readonly elapsedMs: number;
  /** Path-sorted file rows. */
  readonly files: readonly FileAnalysis[];
  /** Risk-ordered rows (score desc, fanout desc, path Buffer order). */
  readonly risks: readonly FileRisk[];
  readonly metrics: StructureMetrics;
  readonly counts: Readonly<Record<CoverageClassification, number>>;
  readonly closure: ImpactReport;
  readonly inScopeFiles: readonly string[];
  readonly notes: readonly string[];
  /** Located blind spots (dynamic/registry/reflection/zero-symbol/unsupported/deleted). */
  readonly blindSpots?: readonly BlindSpot[];
  /** Three-tier dynamic-load counts; independent of the unresolved counter. */
  readonly dynamicLoads?: DynamicLoadSummary;
  /** Extractor-side dynamic-load total (may exceed located evidence when unwired). */
  readonly sourceDynamicLoads?: number;
  readonly zeroSymbolFiles?: readonly string[];
  readonly unsupportedFiles?: readonly string[];
  /** Explicitly listed so a coverage report can never silently omit them. */
  readonly deletedFiles?: readonly string[];
  readonly excludedFiles?: readonly string[];
  /** Automatically decidable findings: resolved loads, zero symbols, deletions. */
  readonly staticFindings?: readonly CoverageFinding[];
  /** Findings that require human confirmation: heuristic/unknown/registry/reflection. */
  readonly manualReview?: readonly CoverageFinding[];
  /** Evidence-based conclusion; absence of unresolved loads is not health. */
  readonly coverageConclusion?: CoverageConclusion;
}

export interface SymbolOutline {
  readonly id: string;
  readonly name: string;
  readonly qualifiedName: string;
  readonly symbolKind: SymbolNode['symbolKind'];
  readonly startLine: number;
  readonly incomingCalls: number;
  readonly outgoingCalls: number;
}

export interface FileOutline {
  readonly file: string;
  readonly classification: CoverageClassification;
  readonly symbols: readonly SymbolOutline[];
  readonly imports: FileIo;
  readonly calls: FileIo;
  readonly fanout: number;
  readonly dependents: { readonly direct: number; readonly transitive: number };
  readonly semanticGaps: readonly SemanticGap[];
  readonly evidenceRevision: string;
}

export interface FileImpact {
  readonly file: string;
  readonly classification: CoverageClassification;
  readonly direct: readonly string[];
  readonly transitive: readonly string[];
  readonly unchanged: readonly string[];
  readonly depthLimited: boolean;
}

export interface StructureAnalysisOptions {
  /** Touched roots `T`; defaults to an empty set at this layer. */
  readonly touched?: readonly string[];
  /** Reverse closure bound; defaults to 3 (ADR-010 §5.1). */
  readonly maxDepth?: number;
  /** Previous snapshot, used to detect `deleted` files (ENOENT history). */
  readonly previous?: GraphSnapshot;
  /** Resolved scan exclusion predicate (ADR-009 §5). */
  readonly excluded?: (relativePath: string) => boolean;
  /** Excluded candidates to report; they never enter the denominator. */
  readonly excludedFiles?: readonly string[];
  /** Scan candidates whose extension/grammar could not be parsed. */
  readonly unsupportedFiles?: readonly string[];
  /** Explicit degraded files; `caveats.degradedReasons` is merged in. */
  readonly degradedFiles?: readonly string[];
  readonly unresolvedDynamicLoads?: Readonly<Record<string, number>>;
  readonly semanticGaps?: Readonly<Record<string, readonly SemanticGap[]>>;
  /**
   * Located dynamic-load / registry / reflection evidence per file. Merged with
   * `snapshot.caveats` evidence and the legacy `semanticGaps`; it never depends
   * on the unresolved-load counter.
   */
  readonly blindSpots?: Readonly<Record<string, readonly BlindSpotInput[]>>;
  /** File-level explored set (T-112 projection); only `file` granularity counts. */
  readonly exploredFiles?: readonly string[];
  readonly fanoutTop?: number;
  readonly weights?: RiskWeights;
  readonly thresholds?: RiskThresholds;
  readonly now?: () => number;
}

interface NormalizedOptions {
  touched: readonly string[];
  maxDepth: number;
  previous: GraphSnapshot | undefined;
  excluded: ((relativePath: string) => boolean) | undefined;
  excludedFiles: readonly string[];
  unsupportedFiles: readonly string[];
  degradedFiles: readonly string[];
  unresolvedDynamicLoads: Readonly<Record<string, number>> | undefined;
  semanticGaps: Readonly<Record<string, readonly SemanticGap[]>> | undefined;
  blindSpots: Readonly<Record<string, readonly BlindSpotInput[]>> | undefined;
  exploredFiles: readonly string[];
  fanoutTop: number;
  weights: {
    direct: number;
    transitive: number;
    touched: number;
    fanoutCap: number;
    fanoutDivisor: number;
    complexityCap: number;
    complexityDivisor: number;
    blindPenalty: number;
    advisoryPenalty: number;
  };
  thresholds: { high: number; medium: number; highFanout: number };
  now: () => number;
}

function normalizeOptions(options: StructureAnalysisOptions): NormalizedOptions {
  const weights = options.weights ?? {};
  const thresholds = options.thresholds ?? {};
  return {
    touched: options.touched ?? [],
    maxDepth: Math.max(0, Math.floor(options.maxDepth ?? 3)),
    previous: options.previous,
    excluded: options.excluded,
    excludedFiles: options.excludedFiles ?? [],
    unsupportedFiles: options.unsupportedFiles ?? [],
    degradedFiles: options.degradedFiles ?? [],
    unresolvedDynamicLoads: options.unresolvedDynamicLoads,
    semanticGaps: options.semanticGaps,
    blindSpots: options.blindSpots,
    exploredFiles: options.exploredFiles ?? [],
    fanoutTop: Math.max(0, Math.floor(options.fanoutTop ?? 10)),
    weights: {
      direct: weights.direct ?? 1,
      transitive: weights.transitive ?? 2,
      touched: weights.touched ?? 3,
      fanoutCap: weights.fanoutCap ?? 50,
      fanoutDivisor: weights.fanoutDivisor ?? 10,
      complexityCap: weights.complexityCap ?? 200,
      complexityDivisor: weights.complexityDivisor ?? 50,
      blindPenalty: weights.blindPenalty ?? 2,
      advisoryPenalty: weights.advisoryPenalty ?? 1,
    },
    thresholds: {
      high: thresholds.high ?? 20,
      medium: thresholds.medium ?? 8,
      highFanout: thresholds.highFanout ?? 50,
    },
    now: options.now ?? Date.now,
  };
}

function isSupportedExtension(file: string): boolean {
  const lower = file.toLowerCase();
  return SUPPORTED_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

function isAdvisory(edge: { readonly kind: string; readonly provenance: string }): boolean {
  // Mirrors `src/gate/blast.ts` so structure and Gate agree on the main caliber.
  return edge.kind === 'unknown' || edge.provenance === 'heuristic';
}

function dedupeSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function hasUnknownMainGap(gaps: readonly SemanticGap[] | undefined): boolean {
  if (gaps === undefined) return false;
  return gaps.some((gap) => UNKNOWN_MAIN_PATTERNS.has(gap.pattern.toLowerCase()));
}

/**
 * Per-file degradation is derived from `caveats.degradedReasons`, which is the
 * only per-file degradation record the snapshot carries. Directory reasons mark
 * every retained file beneath them; `unreadable`/`parse-failed` reasons name
 * the file directly.
 */
export function collectDegradedFiles(snapshot: GraphSnapshot): Set<string> {
  const result = new Set<string>();
  const known = Object.keys(snapshot.files);
  for (const reason of snapshot.caveats.degradedReasons) {
    if (reason.startsWith('fingerprint-degraded:')) {
      const rest = reason.slice('fingerprint-degraded:'.length);
      const directory = rest.replace(/:[^:]*$/, '');
      if (directory === '.' || directory === '') {
        for (const file of known) result.add(file);
        continue;
      }
      for (const file of known) {
        if (file === directory || file.startsWith(`${directory}/`)) result.add(file);
      }
      continue;
    }
    if (reason.startsWith('changed-during-build:')) {
      result.add(reason.slice('changed-during-build:'.length));
      continue;
    }
    const match = /^(unreadable|parse-failed):(.+)$/.exec(reason);
    if (match === null) continue;
    const rest = match[2]!;
    let best: string | undefined;
    for (const file of known) {
      if (rest === file || rest.startsWith(`${file}:`)) {
        if (best === undefined || file.length > best.length) best = file;
      }
    }
    if (best !== undefined) result.add(best);
  }
  return result;
}

export interface FileFacts {
  symbols: number;
  staticEdges: number;
  fanout: number;
  dynamicLoads: number;
  unresolvedDynamicLoads: number;
  imports: FileIo;
  calls: FileIo;
}

interface MutableFileIo {
  incoming: number;
  outgoing: number;
  resolvedOutgoing: number;
}

function emptyIo(): MutableFileIo {
  return { incoming: 0, outgoing: 0, resolvedOutgoing: 0 };
}

/**
 * Pure per-file measurement, independent of the shared reverse index. Exported
 * so tests can assert batch rows equal a from-scratch single-file baseline.
 */
export function measureFile(snapshot: GraphSnapshot, file: string, unresolvedOverride?: number, symbolCount?: number): FileFacts {
  const sourceFile = snapshot.files[file];
  const edges = snapshot.edges;
  const calls = snapshot.calls ?? [];
  const imports = emptyIo();
  const callIo = emptyIo();
  const fanoutTargets = new Set<string>();
  let staticEdges = 0;
  for (const edge of edges) {
    if (edge.from === file && edge.to !== '<dynamic>') {
      staticEdges += 1;
      imports.outgoing += 1;
      fanoutTargets.add(edge.to);
      if (edge.provenance === 'resolved') imports.resolvedOutgoing += 1;
    }
    if (edge.to === file && edge.from !== file) imports.incoming += 1;
  }
  for (const call of calls) {
    if (call.from === file) {
      callIo.outgoing += 1;
      if (call.provenance === 'resolved') {
        staticEdges += 1;
        callIo.resolvedOutgoing += 1;
        fanoutTargets.add(call.to);
      }
    }
    if (call.to === file && call.from !== file) callIo.incoming += 1;
  }
  const unresolvedDynamicLoads = unresolvedOverride ?? edges.filter((edge) => edge.from === file && edge.to === '<dynamic>').length;
  return {
    symbols: symbolCount ?? snapshot.symbols.filter((symbol) => symbol.file === file).length,
    staticEdges,
    fanout: fanoutTargets.size,
    dynamicLoads: sourceFile?.dynamicLoads ?? 0,
    unresolvedDynamicLoads,
    imports,
    calls: callIo,
  };
}

interface ReverseIndexes {
  /** Main caliber: non-advisory dependency edges plus `resolved` call edges. */
  main: Map<string, Set<string>>;
  /** Advisory caliber, reported but never counted in direct/transitive. */
  advisory: Map<string, Set<string>>;
}

function buildReverseIndexes(snapshot: GraphSnapshot): ReverseIndexes {
  const main = new Map<string, Set<string>>();
  const advisory = new Map<string, Set<string>>();
  const link = (map: Map<string, Set<string>>, to: string, from: string): void => {
    const sources = map.get(to);
    if (sources === undefined) map.set(to, new Set([from]));
    else sources.add(from);
  };
  for (const edge of snapshot.edges) {
    if (edge.to === '<dynamic>' || edge.from === edge.to) continue;
    link(isAdvisory(edge) ? advisory : main, edge.to, edge.from);
  }
  for (const call of snapshot.calls ?? []) {
    if (call.from === call.to) continue;
    // A call edge is main only when resolved; heuristic calls stay advisory.
    link(call.provenance === 'resolved' ? main : advisory, call.to, call.from);
  }
  return { main, advisory };
}

export interface ClosureResult {
  found: Set<string>;
  direct: Set<string>;
  depthLimited: boolean;
}

/**
 * Bounded reverse BFS. `found` includes the roots; `direct` holds depth-1
 * discoveries only. Cycles are absorbed by the visited set and the depth bound
 * is hard, so a ring can never explode.
 */
export function reverseClosure(
  reverse: Map<string, Set<string>>,
  roots: Iterable<string>,
  maxDepth: number,
  inScope: ReadonlySet<string>,
): ClosureResult {
  const found = new Set<string>();
  const direct = new Set<string>();
  const queue: Array<{ file: string; depth: number }> = [];
  for (const root of roots) {
    if (found.has(root)) continue;
    found.add(root);
    queue.push({ file: root, depth: 0 });
  }
  let depthLimited = false;
  for (let index = 0; index < queue.length; index += 1) {
    const node = queue[index]!;
    const predecessors = reverse.get(node.file);
    if (node.depth >= maxDepth) {
      if (predecessors !== undefined) {
        for (const previous of predecessors) {
          if (!found.has(previous) && inScope.has(previous)) {
            depthLimited = true;
            break;
          }
        }
      }
      continue;
    }
    if (predecessors === undefined) continue;
    for (const previous of predecessors) {
      if (found.has(previous)) continue;
      found.add(previous);
      if (node.depth + 1 === 1) direct.add(previous);
      queue.push({ file: previous, depth: node.depth + 1 });
    }
  }
  return { found, direct, depthLimited };
}

function impactReport(
  reverse: Map<string, Set<string>>,
  roots: readonly string[],
  maxDepth: number,
  inScope: ReadonlySet<string>,
  inScopeFiles: readonly string[],
): ImpactReport {
  const rootSet = new Set(roots);
  const { found, direct, depthLimited } = reverseClosure(reverse, roots, maxDepth, inScope);
  const transitive = [...found].filter((file) => !rootSet.has(file)).sort();
  const directSorted = [...direct].filter((file) => !rootSet.has(file)).sort();
  const unchanged = inScopeFiles.filter((file) => !found.has(file)).sort();
  return { touched: [...roots], direct: directSorted, transitive, unchanged, depthLimited };
}

function comparePath(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right));
}

function coveragePenaltyOf(classification: CoverageClassification, weights: NormalizedOptions['weights']): number {
  if (classification === 'zero-symbol' || classification === 'unknown' || classification === 'unsupported') return weights.blindPenalty;
  if (classification === 'zero-edge' || classification === 'dynamic-only' || classification === 'degraded') return weights.advisoryPenalty;
  return 0;
}

function riskLevelOf(
  score: number,
  fanout: number,
  transitive: number,
  impactScore: number,
  penalty: number,
  blindPenalty: number,
  thresholds: NormalizedOptions['thresholds'],
): 'high' | 'medium' | 'low' {
  if (score >= thresholds.high) return 'high';
  if (penalty === blindPenalty && impactScore > 0) return 'high';
  if (fanout >= thresholds.highFanout && transitive > 0) return 'high';
  if (score >= thresholds.medium) return 'medium';
  return 'low';
}

/** Maps a semantic-gap pattern onto a reportable blind-spot type. */
function gapPatternToType(pattern: string): BlindSpotType {
  const value = pattern.toLowerCase();
  if (value.includes('registry')) return 'registry-scan';
  if (value === 'reflection') return 'reflection';
  if (value === 'eval') return 'eval';
  if (value.includes('require') || value.includes('import')) return 'dynamic-load';
  return 'unknown';
}

function spotKey(file: string, spot: Omit<BlindSpot, 'file'>): string {
  return `${file}\0${spot.type}\0${spot.line ?? ''}\0${spot.pattern ?? ''}\0${spot.reason}`;
}

interface BlindSpotIndex {
  byFile: Map<string, BlindSpot[]>;
  dynamicLoadKinds: { resolved: number; heuristic: number; unknown: number };
  /** Dynamic loads counted from source files/caveats, regardless of evidence. */
  sourceTotal: number;
}

/**
 * Merges every evidence source into per-file blind spots. `unresolvedDynamicLoads`
 * is deliberately not consulted: registry/reflection/eval evidence exists even
 * when the unresolved counter is zero (ADR-010 §4.4).
 */
function buildBlindSpotIndex(snapshot: GraphSnapshot, normalized: NormalizedOptions): BlindSpotIndex {
  const byFile = new Map<string, BlindSpot[]>();
  const seen = new Set<string>();
  const kinds = { resolved: 0, heuristic: 0, unknown: 0 };
  const add = (spot: BlindSpot): void => {
    const key = spotKey(spot.file, spot);
    if (seen.has(key)) return;
    seen.add(key);
    const list = byFile.get(spot.file);
    if (list === undefined) byFile.set(spot.file, [spot]);
    else list.push(spot);
  };
  const caveats = snapshot.caveats;
  for (const gap of caveats.semanticGaps ?? []) {
    add({ file: gap.file, type: gapPatternToType(gap.pattern), line: gap.line, pattern: gap.pattern, reason: gap.reason });
  }
  for (const site of caveats.dynamicLoadSites ?? []) {
    add({
      file: site.file, type: 'dynamic-load', line: site.line, pattern: site.pattern,
      reason: site.reason, tier: site.tier,
      ...(site.target !== undefined ? { target: site.target } : {}),
    });
  }
  for (const file of caveats.registryFiles ?? []) {
    if ((byFile.get(file) ?? []).some((spot) => spot.type === 'registry-scan')) continue;
    add({ file, type: 'registry-scan', reason: 'runtime directory registry' });
  }
  for (const file of caveats.reflectionFiles ?? []) {
    if ((byFile.get(file) ?? []).some((spot) => spot.type === 'reflection' || spot.type === 'eval')) continue;
    add({ file, type: 'reflection', reason: 'reflection or eval usage' });
  }
  for (const file of caveats.zeroSymbolFiles ?? []) {
    if ((byFile.get(file) ?? []).some((spot) => spot.type === 'zero-symbol')) continue;
    add({ file, type: 'zero-symbol', reason: 'parsed with zero captured symbols' });
  }
  for (const [file, gaps] of Object.entries(normalized.semanticGaps ?? {})) {
    for (const gap of gaps) add({ file, type: gapPatternToType(gap.pattern), line: gap.line, pattern: gap.pattern, reason: gap.reason });
  }
  for (const [file, inputs] of Object.entries(normalized.blindSpots ?? {})) {
    for (const input of inputs) {
      add({
        file,
        type: input.type,
        ...(input.line !== undefined ? { line: input.line } : {}),
        ...(input.pattern !== undefined ? { pattern: input.pattern } : {}),
        reason: input.reason,
        ...(input.tier !== undefined ? { tier: input.tier } : {}),
        ...(input.target !== undefined ? { target: input.target } : {}),
      });
    }
  }
  // Located evidence wins; aggregate caveat counts are only a fallback when no
  // site was carried at all (for example an older snapshot).
  const locatedDynamicLoads = [...byFile.values()]
    .flat()
    .filter((spot) => spot.type === 'dynamic-load');
  if (locatedDynamicLoads.length > 0) {
    for (const spot of locatedDynamicLoads) {
      const tier: DynamicLoadTier = spot.tier ?? 'unknown';
      kinds[tier] += 1;
    }
  } else if (caveats.dynamicLoadKinds !== undefined) {
    kinds.resolved = caveats.dynamicLoadKinds.resolved ?? 0;
    kinds.heuristic = caveats.dynamicLoadKinds.heuristic ?? 0;
    kinds.unknown = caveats.dynamicLoadKinds.unknown ?? 0;
  }
  let sourceTotal = 0;
  for (const file of Object.values(snapshot.files)) sourceTotal += file.dynamicLoads;
  if (caveats.dynamicLoadCount > sourceTotal) sourceTotal = caveats.dynamicLoadCount;
  return { byFile, dynamicLoadKinds: kinds, sourceTotal };
}

function hasMainGap(spots: readonly BlindSpot[] | undefined): boolean {
  if (spots === undefined) return false;
  return spots.some((spot) => UNKNOWN_MAIN_TYPES.has(spot.type)
    || UNKNOWN_MAIN_PATTERNS.has((spot.pattern ?? '').toLowerCase()));
}

function compareBlindSpot(left: BlindSpot, right: BlindSpot): number {
  return comparePath(left.file, right.file)
    || (left.line ?? 0) - (right.line ?? 0)
    || left.type.localeCompare(right.type)
    || (left.pattern ?? '').localeCompare(right.pattern ?? '');
}

function compareFinding(left: CoverageFinding, right: CoverageFinding): number {
  return compareBlindSpot(left, right);
}

/**
 * Batch analysis over one snapshot. Shared reverse indexes are built once and
 * reused for every file row and for the touched-set closure.
 */
export function analyzeStructure(snapshot: GraphSnapshot, options: StructureAnalysisOptions = {}): StructureAnalysis {
  const normalized = normalizeOptions(options);
  const start = normalized.now();

  const excludedSet = new Set(normalized.excludedFiles);
  const unsupportedSet = new Set(normalized.unsupportedFiles);
  const derivedDegraded = collectDegradedFiles(snapshot);
  const degradedSet = new Set([...derivedDegraded, ...normalized.degradedFiles]);
  const previousFiles = normalized.previous === undefined ? undefined : new Set(Object.keys(normalized.previous.files));
  const snapshotFiles = Object.keys(snapshot.files);

  const candidates = dedupeSorted([
    ...snapshotFiles,
    ...excludedSet,
    ...unsupportedSet,
    ...(previousFiles === undefined ? [] : [...previousFiles].filter((file) => !snapshot.files[file])),
  ]);

  const indexes = buildReverseIndexes(snapshot);
  const symbolCounts = new Map<string, number>();
  for (const symbol of snapshot.symbols) symbolCounts.set(symbol.file, (symbolCounts.get(symbol.file) ?? 0) + 1);

  const isExcludedFile = (file: string): boolean => excludedSet.has(file) || (normalized.excluded?.(file) ?? false);
  const inScopeFiles = candidates.filter((file) => !isExcludedFile(file)).sort(comparePath);
  const inScopeSet = new Set(inScopeFiles);

  const dependents = new Map<string, { direct: number; transitive: number }>();
  for (const file of candidates) {
    if (isExcludedFile(file)) continue;
    if (!indexes.main.has(file) && !indexes.advisory.has(file)) continue;
    const { found, direct } = reverseClosure(indexes.main, [file], normalized.maxDepth, inScopeSet);
    found.delete(file);
    direct.delete(file);
    dependents.set(file, { direct: direct.size, transitive: found.size });
  }

  const blindSpotIndex = buildBlindSpotIndex(snapshot, normalized);
  const rows: FileAnalysis[] = [];
  for (const file of candidates) {
    const inSnapshot = snapshot.files[file] !== undefined;
    const excluded = excludedSet.has(file) || (normalized.excluded?.(file) ?? false);
    const deleted = previousFiles !== undefined && previousFiles.has(file) && !inSnapshot;
    const unsupported = !inSnapshot && !deleted && (unsupportedSet.has(file) || !isSupportedExtension(file));
    const degraded = degradedSet.has(file);
    const gaps = normalized.semanticGaps?.[file];
    const spots = blindSpotIndex.byFile.get(file);
    const unknown = hasMainGap(spots) || hasUnknownMainGap(gaps);
    const facts = inSnapshot
      ? measureFile(snapshot, file, normalized.unresolvedDynamicLoads?.[file], symbolCounts.get(file))
      : {
        symbols: 0,
        staticEdges: 0,
        fanout: 0,
        dynamicLoads: 0,
        unresolvedDynamicLoads: 0,
        imports: emptyIo(),
        calls: emptyIo(),
      };
    // Evidence may be located even when the extractor's counter is zero; a
    // missing count never cancels a real registry/reflection/dynamic signal.
    const evidenceDynamicLoads = (spots ?? []).filter((spot) => spot.type === 'dynamic-load').length;
    const effectiveDynamicLoads = Math.max(facts.dynamicLoads, evidenceDynamicLoads);

    let classification: CoverageClassification;
    if (excluded) classification = 'excluded';
    else if (deleted) classification = 'deleted';
    else if (unsupported) classification = 'unsupported';
    else if (degraded) classification = 'degraded';
    else if (facts.symbols === 0) classification = 'zero-symbol';
    // A located registry/reflection/eval/computed-require signal makes the
    // coverage undecidable regardless of edge counts, so `unknown` outranks the
    // advisory `dynamic-only`/`zero-edge` classes and stays inside `blindness`.
    else if (unknown) classification = 'unknown';
    else if (facts.staticEdges === 0 && effectiveDynamicLoads > 0) classification = 'dynamic-only';
    else if (facts.staticEdges === 0 && effectiveDynamicLoads === 0) classification = 'zero-edge';
    else classification = 'parsed';
    assertValidClassification(classification);

    const fileDependents = dependents.get(file) ?? { direct: 0, transitive: 0 };
    rows.push({
      file,
      classification,
      symbols: facts.symbols,
      staticEdges: facts.staticEdges,
      fanout: facts.fanout,
      dynamicLoads: facts.dynamicLoads,
      unresolvedDynamicLoads: facts.unresolvedDynamicLoads,
      imports: facts.imports,
      calls: facts.calls,
      directDependents: fileDependents.direct,
      transitiveDependents: fileDependents.transitive,
      inScope: classification !== 'excluded',
      ...(gaps !== undefined ? { semanticGaps: [...gaps].sort((left, right) => left.line - right.line || left.pattern.localeCompare(right.pattern)) } : { semanticGaps: [] }),
      flags: classification === 'deleted' ? ['deleted-file'] : [],
      evidenceRevision: snapshot.revision,
    });
  }

  // Classification-derived blind spots guarantee that zero-symbol / unsupported /
  // deleted files are never omitted, even when no extractor evidence was wired.
  const spotDedupe = new Set<string>();
  const allSpots: BlindSpot[] = [];
  const pushSpot = (spot: BlindSpot): void => {
    const key = spotKey(spot.file, spot);
    if (spotDedupe.has(key)) return;
    spotDedupe.add(key);
    allSpots.push(spot);
  };
  for (const list of blindSpotIndex.byFile.values()) for (const spot of list) pushSpot(spot);
  for (const row of rows) {
    if (row.classification === 'zero-symbol') pushSpot({ file: row.file, type: 'zero-symbol', reason: 'parsed with zero captured symbols' });
    else if (row.classification === 'unsupported') pushSpot({ file: row.file, type: 'unsupported', reason: 'extension unsupported or grammar could not be parsed' });
    else if (row.classification === 'deleted') pushSpot({ file: row.file, type: 'deleted', reason: 'file disappeared after the previous snapshot (ENOENT)' });
  }
  allSpots.sort(compareBlindSpot);

  const deletedFiles = rows.filter((row) => row.classification === 'deleted').map((row) => row.file).sort(comparePath);
  const excludedFiles = rows.filter((row) => row.classification === 'excluded').map((row) => row.file).sort(comparePath);
  const unsupportedFiles = rows.filter((row) => row.classification === 'unsupported').map((row) => row.file).sort(comparePath);
  const zeroSymbolFiles = dedupeSorted([
    ...rows.filter((row) => row.classification === 'zero-symbol').map((row) => row.file),
    ...(snapshot.caveats.zeroSymbolFiles ?? []),
  ]);

  const staticFindings: CoverageFinding[] = [];
  const manualReview: CoverageFinding[] = [];
  for (const spot of allSpots) {
    if (spot.type === 'dynamic-load' && spot.tier === 'resolved') staticFindings.push(spot);
    else if (spot.type === 'dynamic-load') manualReview.push(spot);
    else if (spot.type === 'registry-scan' || spot.type === 'reflection' || spot.type === 'eval') manualReview.push(spot);
    else if (spot.type === 'zero-symbol' || spot.type === 'unsupported' || spot.type === 'deleted') staticFindings.push(spot);
  }
  staticFindings.sort(compareFinding);
  manualReview.sort(compareFinding);

  const dynamicLoadKinds = blindSpotIndex.dynamicLoadKinds;
  const dynamicTotal = dynamicLoadKinds.resolved + dynamicLoadKinds.heuristic + dynamicLoadKinds.unknown;
  const dynamicLoads: DynamicLoadSummary = {
    resolved: dynamicLoadKinds.resolved,
    heuristic: dynamicLoadKinds.heuristic,
    unknown: dynamicLoadKinds.unknown,
  };
  const unresolvedDynamicLoads = rows.reduce((sum, row) => sum + row.unresolvedDynamicLoads, 0);
  const blindSpotCount = allSpots.length;
  let conclusionStatement: string;
  if (unresolvedDynamicLoads === 0 && blindSpotCount > 0) {
    conclusionStatement = `unresolvedDynamicLoads=0 with ${blindSpotCount} located blind spot(s); absence of unresolved dynamic loads is not a clean bill of health`;
  } else if (blindSpotCount === 0 && dynamicTotal === 0 && unresolvedDynamicLoads === 0) {
    conclusionStatement = 'no dynamic-load or blind-spot evidence detected within extraction bounds; this is not proof of absence';
  } else {
    conclusionStatement = `${unresolvedDynamicLoads} unresolved dynamic load(s), ${dynamicTotal} located dynamic-load site(s), ${blindSpotCount} located blind spot(s)`;
  }

  const touched = dedupeSorted(normalized.touched);

  const closure = impactReport(indexes.main, touched, normalized.maxDepth, inScopeSet, inScopeFiles);

  const counts = Object.fromEntries(COVERAGE_CLASSIFICATIONS.map((kind) => [kind, 0])) as Record<CoverageClassification, number>;
  for (const row of rows) counts[row.classification] += 1;

  const touchedSet = new Set(touched);
  const risks: FileRisk[] = rows.map((row) => {
    const penalty = coveragePenaltyOf(row.classification, normalized.weights);
    const fanoutTerm = Math.min(row.fanout, normalized.weights.fanoutCap) / normalized.weights.fanoutDivisor;
    const complexityTerm = Math.min(row.symbols, normalized.weights.complexityCap) / normalized.weights.complexityDivisor;
    const impactScore = normalized.weights.direct * row.directDependents
      + normalized.weights.transitive * row.transitiveDependents
      + normalized.weights.touched * (touchedSet.has(row.file) ? 1 : 0);
    const riskScore = impactScore + penalty + fanoutTerm + complexityTerm;
    return {
      file: row.file,
      classification: row.classification,
      direct: row.directDependents,
      transitive: row.transitiveDependents,
      fanout: row.fanout,
      symbols: row.symbols,
      riskScore,
      level: riskLevelOf(riskScore, row.fanout, row.transitiveDependents, impactScore, penalty, normalized.weights.blindPenalty, normalized.thresholds),
      parts: {
        direct: normalized.weights.direct * row.directDependents,
        transitive: normalized.weights.transitive * row.transitiveDependents,
        touched: normalized.weights.touched * (touchedSet.has(row.file) ? 1 : 0),
        coveragePenalty: penalty,
        fanoutTerm,
        complexityTerm,
        impactScore,
      },
    };
  });
  risks.sort((left, right) => right.riskScore - left.riskScore
    || right.fanout - left.fanout
    || comparePath(left.file, right.file));

  const blindCount = counts['zero-symbol'] + counts.unknown + counts.unsupported;
  const exploredSet = new Set(normalized.exploredFiles);
  const exploredInScope = inScopeFiles.filter((file) => exploredSet.has(file)).length;
  const fanoutTop = rows
    .filter((row) => row.fanout > 0)
    .sort((left, right) => right.fanout - left.fanout || comparePath(left.file, right.file))
    .slice(0, normalized.fanoutTop)
    .map((row) => ({ file: row.file, fanout: row.fanout }));

  const notes: string[] = [];
  if (inScopeFiles.length === 0) notes.push('in-scope-empty:classification-denominator-is-zero');
  if (closure.depthLimited) notes.push(`depth-limit:maxDepth=${normalized.maxDepth}`);
  if (counts.excluded > 0) notes.push(`excluded-out-of-denominator:${counts.excluded}`);
  if (counts.deleted > 0) notes.push(`deleted-history:${counts.deleted}`);
  if (counts.degraded > 0) notes.push(`degraded-files:${counts.degraded}`);
  if (unresolvedDynamicLoads === 0 && blindSpotCount > 0) notes.push(`dynamic-risk-without-unresolved:${blindSpotCount}`);
  if (blindSpotIndex.sourceTotal > dynamicTotal) notes.push(`dynamic-evidence-gap:${blindSpotIndex.sourceTotal - dynamicTotal}`);

  const elapsedMs = Math.max(0, normalized.now() - start);
  return {
    revision: snapshot.revision,
    sourceFingerprint: snapshot.sourceFingerprint,
    maxDepth: normalized.maxDepth,
    depthLimited: closure.depthLimited,
    elapsedMs,
    files: rows.sort((left, right) => comparePath(left.file, right.file)),
    risks,
    metrics: {
      inScope: inScopeFiles.length,
      touched: touched.length,
      direct: closure.direct.length,
      transitive: closure.transitive.length,
      unchanged: closure.unchanged.length,
      fanout: fanoutTop,
      blindness: inScopeFiles.length === 0 ? 0 : blindCount / inScopeFiles.length,
      explored: inScopeFiles.length === 0 ? 0 : exploredInScope / inScopeFiles.length,
      maxDepth: normalized.maxDepth,
      depthLimited: closure.depthLimited,
    },
    counts,
    closure,
    inScopeFiles,
    notes,
    blindSpots: allSpots,
    dynamicLoads,
    sourceDynamicLoads: blindSpotIndex.sourceTotal,
    zeroSymbolFiles,
    unsupportedFiles,
    deletedFiles,
    excludedFiles,
    staticFindings,
    manualReview,
    coverageConclusion: {
      unresolvedDynamicLoads,
      dynamicLoads,
      blindSpotCount,
      statement: conclusionStatement,
    },
  };
}

/**
 * Independent single-file baseline: re-measures one file from the snapshot
 * without the shared reverse index. Batch rows must equal this row field for
 * field, which is asserted by the unit tests.
 */
export function analyzeFileBaseline(snapshot: GraphSnapshot, file: string, options: StructureAnalysisOptions = {}): FileAnalysis {
  const normalized = normalizeOptions(options);
  const excludedSet = new Set(normalized.excludedFiles);
  const unsupportedSet = new Set(normalized.unsupportedFiles);
  const degradedSet = new Set([...collectDegradedFiles(snapshot), ...normalized.degradedFiles]);
  const previousFiles = normalized.previous === undefined ? undefined : new Set(Object.keys(normalized.previous.files));
  const inSnapshot = snapshot.files[file] !== undefined;
  const excluded = excludedSet.has(file) || (normalized.excluded?.(file) ?? false);
  const deleted = previousFiles !== undefined && previousFiles.has(file) && !inSnapshot;
  const unsupported = !inSnapshot && !deleted && (unsupportedSet.has(file) || !isSupportedExtension(file));
  const degraded = degradedSet.has(file);
  const gaps = normalized.semanticGaps?.[file];
  const spots = buildBlindSpotIndex(snapshot, normalized).byFile.get(file);
  const unknown = hasMainGap(spots) || hasUnknownMainGap(gaps);
  const facts = inSnapshot ? measureFile(snapshot, file, normalized.unresolvedDynamicLoads?.[file]) : {
    symbols: 0,
    staticEdges: 0,
    fanout: 0,
    dynamicLoads: 0,
    unresolvedDynamicLoads: 0,
    imports: emptyIo(),
    calls: emptyIo(),
  };
  const evidenceDynamicLoads = (spots ?? []).filter((spot) => spot.type === 'dynamic-load').length;
  const effectiveDynamicLoads = Math.max(facts.dynamicLoads, evidenceDynamicLoads);
  let classification: CoverageClassification;
  if (excluded) classification = 'excluded';
  else if (deleted) classification = 'deleted';
  else if (unsupported) classification = 'unsupported';
  else if (degraded) classification = 'degraded';
  else if (facts.symbols === 0) classification = 'zero-symbol';
  // Keep the batch and the single-file baseline identical: located main-gap
  // evidence outranks the advisory dynamic-only/zero-edge classes.
  else if (unknown) classification = 'unknown';
  else if (facts.staticEdges === 0 && effectiveDynamicLoads > 0) classification = 'dynamic-only';
  else if (facts.staticEdges === 0 && effectiveDynamicLoads === 0) classification = 'zero-edge';
  else classification = 'parsed';
  assertValidClassification(classification);

  const baselineCandidates = dedupeSorted([
    ...Object.keys(snapshot.files),
    ...unsupportedSet,
    ...(previousFiles === undefined ? [] : [...previousFiles].filter((file) => !snapshot.files[file])),
  ]);
  const inScopeSet = new Set(baselineCandidates.filter((candidate) => !(excludedSet.has(candidate) || (normalized.excluded?.(candidate) ?? false))));
  const reverse = new Map<string, Set<string>>();
  const link = (to: string, from: string): void => {
    const sources = reverse.get(to);
    if (sources === undefined) reverse.set(to, new Set([from]));
    else sources.add(from);
  };
  for (const edge of snapshot.edges) {
    if (edge.to === '<dynamic>' || edge.from === edge.to) continue;
    if (isAdvisory(edge)) continue;
    link(edge.to, edge.from);
  }
  for (const call of snapshot.calls ?? []) {
    if (call.from === call.to || call.provenance !== 'resolved') continue;
    link(call.to, call.from);
  }
  let directDependents = 0;
  let transitiveDependents = 0;
  if (classification !== 'excluded') {
    const { found, direct } = reverseClosure(reverse, [file], normalized.maxDepth, inScopeSet);
    found.delete(file);
    direct.delete(file);
    directDependents = direct.size;
    transitiveDependents = found.size;
  }

  return {
    file,
    classification,
    symbols: facts.symbols,
    staticEdges: facts.staticEdges,
    fanout: facts.fanout,
    dynamicLoads: facts.dynamicLoads,
    unresolvedDynamicLoads: facts.unresolvedDynamicLoads,
    imports: facts.imports,
    calls: facts.calls,
    directDependents,
    transitiveDependents,
    inScope: classification !== 'excluded',
    ...(gaps !== undefined ? { semanticGaps: [...gaps].sort((left, right) => left.line - right.line || left.pattern.localeCompare(right.pattern)) } : { semanticGaps: [] }),
    flags: classification === 'deleted' ? ['deleted-file'] : [],
    evidenceRevision: snapshot.revision,
  };
}

/**
 * Session over one snapshot. Holds the prebuilt reverse indexes so file-level
 * outline/impact queries never rebuild a closure or reopen the store.
 */
export class StructureAnalysisSession {
  readonly analysis: StructureAnalysis;
  private readonly snapshot: GraphSnapshot;
  private readonly normalized: NormalizedOptions;
  private readonly indexes: ReverseIndexes;
  private readonly inScopeSet: Set<string>;
  private readonly byFile: Map<string, FileAnalysis>;
  private readonly closeHandle: (() => void) | undefined;
  /** Captured once from the store; a pure snapshot session leaves it undefined. */
  readonly freshness: Freshness | undefined;
  readonly outcome: StructureAnalysisOutcome | undefined;
  /** ADR-010 §10.2 codes observed when the session opened (revision mismatch / stale). */
  readonly structureErrorCodes: readonly StructureErrorCode[];
  private closed = false;

  constructor(snapshot: GraphSnapshot, options: StructureAnalysisOptions = {}, closeHandle?: () => void, store?: StructureAnalysisStore, analysisOverride?: StructureAnalysis) {
    this.snapshot = snapshot;
    this.normalized = normalizeOptions(options);
    this.analysis = analysisOverride ?? analyzeStructure(snapshot, options);
    this.indexes = buildReverseIndexes(snapshot);
    this.inScopeSet = new Set(this.analysis.inScopeFiles);
    this.byFile = new Map(this.analysis.files.map((row) => [row.file, row]));
    this.closeHandle = closeHandle;
    this.freshness = store?.freshness?.();
    const outcome = store?.buildOutcome;
    this.outcome = outcome === undefined ? undefined : { status: outcome.status, cache: outcome.cache, stale: outcome.stale, partial: outcome.partial };
    const codes = new Set<StructureErrorCode>();
    const mismatch = structureQueryRevisionCode(options.previous?.revision, snapshot.revision);
    if (mismatch !== undefined) codes.add(mismatch);
    const stale = structureEvidenceStaleCode((outcome?.stale ?? false) || this.freshness?.status === 'stale');
    if (stale !== undefined) codes.add(stale);
    this.structureErrorCodes = [...codes];
  }

  /** True after `close()`; queries on a closed session fail fast. */
  get isClosed(): boolean {
    return this.closed;
  }

  fileAnalysis(file: string): FileAnalysis | null {
    this.assertOpen();
    return this.byFile.get(file) ?? null;
  }

  outline(file: string): FileOutline | null {
    this.assertOpen();
    const row = this.byFile.get(file);
    if (row === undefined) return null;
    const symbols: SymbolOutline[] = this.snapshot.symbols
      .filter((symbol) => symbol.file === file)
      .map((symbol) => ({
        id: symbol.id,
        name: symbol.name,
        qualifiedName: symbol.qualifiedName,
        symbolKind: symbol.symbolKind,
        startLine: symbol.startLine,
        incomingCalls: (this.snapshot.calls ?? []).filter((call) => call.calleeSymbolId === symbol.id).length,
        outgoingCalls: (this.snapshot.calls ?? []).filter((call) => call.callerSymbolId === symbol.id).length,
      }))
      .sort((left, right) => left.startLine - right.startLine
        || left.symbolKind.localeCompare(right.symbolKind)
        || left.qualifiedName.localeCompare(right.qualifiedName)
        || left.id.localeCompare(right.id));
    return {
      file,
      classification: row.classification,
      symbols,
      imports: row.imports,
      calls: row.calls,
      fanout: row.fanout,
      dependents: { direct: row.directDependents, transitive: row.transitiveDependents },
      semanticGaps: row.semanticGaps,
      evidenceRevision: row.evidenceRevision,
    };
  }

  impact(file: string, maxDepth: number = this.normalized.maxDepth): FileImpact | null {
    this.assertOpen();
    const row = this.byFile.get(file);
    if (row === undefined) return null;
    const report = impactReport(this.indexes.main, [file], Math.max(0, Math.floor(maxDepth)), this.inScopeSet, this.analysis.inScopeFiles);
    return {
      file,
      classification: row.classification,
      direct: report.direct,
      transitive: report.transitive,
      unchanged: report.unchanged,
      depthLimited: report.depthLimited,
    };
  }

  impactSets(touched: readonly string[], maxDepth: number = this.normalized.maxDepth): ImpactReport {
    this.assertOpen();
    return impactReport(
      this.indexes.main,
      dedupeSorted(touched),
      Math.max(0, Math.floor(maxDepth)),
      this.inScopeSet,
      this.analysis.inScopeFiles,
    );
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.closeHandle?.();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('StructureAnalysisSession is closed');
  }
}

/** Minimal store contract the analyzer needs; `GraphStore` satisfies it. */
export interface StructureAnalysisStore {
  ensureFresh(): Promise<unknown>;
  snapshot(): GraphSnapshot;
  readonly revision: string;
  close(): void;
  freshness?(): Freshness;
  readonly buildOutcome?: {
    readonly status: ScanStatus;
    readonly cache: 'hit' | 'miss';
    readonly stale: boolean;
    readonly partial: boolean;
  } | undefined;
}

export interface StructureAnalysisOutcome {
  readonly status: ScanStatus;
  readonly cache: 'hit' | 'miss';
  readonly stale: boolean;
  readonly partial: boolean;
}

export interface StructureAnalysisStoreSeam {
  open(root: string, options?: GraphStoreOpenOptions): Promise<StructureAnalysisStore>;
}

/** Default seam: the real `GraphStore.open`. */
export const graphStoreSeam: StructureAnalysisStoreSeam = {
  open: (root, options) => GraphStore.open(root, options),
};

export interface OpenStructureAnalyzerOptions extends StructureAnalysisOptions {
  readonly seam?: StructureAnalysisStoreSeam;
  readonly storeOptions?: GraphStoreOpenOptions;
  /**
   * Revision-scoped batch cache. On a hit the exact same `StructureAnalysis`
   * object is reused; on a miss it is computed once from the single snapshot
   * and stored for the next identical request.
   */
  readonly cache?: StructureAnalysisCache;
}

/**
 * Opens the store exactly once, refreshes it once and takes one snapshot. The
 * returned session reuses that snapshot for every later query; `close()`
 * releases the store.
 */
export async function openStructureAnalyzer(root: string, options: OpenStructureAnalyzerOptions = {}): Promise<StructureAnalysisSession> {
  const seam = options.seam ?? graphStoreSeam;
  const store = await seam.open(root, options.storeOptions);
  try {
    await store.ensureFresh();
    const snapshot = store.snapshot();
    let analysis = options.cache?.get(snapshot.revision, options);
    if (analysis === undefined) {
      analysis = analyzeStructure(snapshot, options);
      options.cache?.set(snapshot.revision, options, analysis);
    }
    return new StructureAnalysisSession(snapshot, options, () => store.close(), store, analysis);
  } catch (error) {
    store.close();
    throw error;
  }
}

/**
 * Deterministic identity of one batch-analysis request. The graph revision is
 * prepended by the cache; this payload covers every output-affecting input:
 * touched roots, depth, exclusion/degradation sets, located evidence, fanout,
 * risk weights and thresholds. `now`/`elapsedMs` are deliberately absent, and
 * the `excluded` predicate is represented only by its presence because
 * functions cannot be serialized.
 */
export function structureAnalysisCacheKey(input: StructureAnalysisOptions): string {
  const weights = input.weights ?? {};
  const thresholds = input.thresholds ?? {};
  const gaps = input.semanticGaps === undefined
    ? null
    : Object.keys(input.semanticGaps).sort().map((file) => [
      file,
      [...(input.semanticGaps?.[file] ?? [])].sort((left, right) =>
        left.line - right.line || left.pattern.localeCompare(right.pattern) || left.reason.localeCompare(right.reason)),
    ]);
  const spots = input.blindSpots === undefined
    ? null
    : Object.keys(input.blindSpots).sort().map((file) => [
      file,
      [...(input.blindSpots?.[file] ?? [])].sort((left, right) =>
        left.type.localeCompare(right.type)
        || (left.line ?? 0) - (right.line ?? 0)
        || (left.pattern ?? '').localeCompare(right.pattern ?? '')
        || left.reason.localeCompare(right.reason)
        || (left.tier ?? '').localeCompare(right.tier ?? '')),
    ]);
  const unresolved = input.unresolvedDynamicLoads === undefined
    ? null
    : Object.keys(input.unresolvedDynamicLoads).sort().map((file) => [file, input.unresolvedDynamicLoads?.[file] ?? 0]);
  const payload = {
    touched: [...(input.touched ?? [])].sort(),
    maxDepth: input.maxDepth ?? 3,
    excludedFiles: [...(input.excludedFiles ?? [])].sort(),
    unsupportedFiles: [...(input.unsupportedFiles ?? [])].sort(),
    degradedFiles: [...(input.degradedFiles ?? [])].sort(),
    exploredFiles: [...(input.exploredFiles ?? [])].sort(),
    previousRevision: input.previous?.revision ?? null,
    hasExcludedPredicate: input.excluded !== undefined,
    semanticGaps: gaps,
    blindSpots: spots,
    unresolvedDynamicLoads: unresolved,
    fanoutTop: input.fanoutTop ?? 10,
    weights: {
      direct: weights.direct ?? 1,
      transitive: weights.transitive ?? 2,
      touched: weights.touched ?? 3,
      fanoutCap: weights.fanoutCap ?? 50,
      fanoutDivisor: weights.fanoutDivisor ?? 10,
      complexityCap: weights.complexityCap ?? 200,
      complexityDivisor: weights.complexityDivisor ?? 50,
      blindPenalty: weights.blindPenalty ?? 2,
      advisoryPenalty: weights.advisoryPenalty ?? 1,
    },
    thresholds: {
      high: thresholds.high ?? 20,
      medium: thresholds.medium ?? 8,
      highFanout: thresholds.highFanout ?? 50,
    },
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export interface StructureAnalysisCache {
  get(revision: string, input: StructureAnalysisOptions): StructureAnalysis | undefined;
  set(revision: string, input: StructureAnalysisOptions, analysis: StructureAnalysis): void;
  /** Drop one revision, or everything when omitted. */
  invalidate(revision?: string): void;
  readonly size: number;
}

/** Revision-scoped cache: a graph revision change invalidates old entries. */
export function createStructureAnalysisCache(): StructureAnalysisCache {
  const entries = new Map<string, StructureAnalysis>();
  return {
    get(revision, input) {
      return entries.get(`${revision}\0${structureAnalysisCacheKey(input)}`);
    },
    set(revision, input, analysis) {
      entries.set(`${revision}\0${structureAnalysisCacheKey(input)}`, analysis);
    },
    invalidate(revision) {
      if (revision === undefined) {
        entries.clear();
        return;
      }
      const prefix = `${revision}\0`;
      for (const key of [...entries.keys()]) {
        if (key.startsWith(prefix)) entries.delete(key);
      }
    },
    get size() {
      return entries.size;
    },
  };
}
