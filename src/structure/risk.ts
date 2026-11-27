import type { CoverageClassification, StructureAnalysis } from './analysis.ts';
import type { BlindSpotType, GraphSnapshot } from './types.ts';

/**
 * ADR-010 §5: explainable risk grading, reverse-mapped test recommendations and
 * a manual-review checklist.
 *
 * Hard boundary (ADR-010 §2.1/§5.5): everything produced here is advisory input
 * for humans and Gate consumers. It never becomes execution evidence, never
 * carries an `evidence_id`, and never enters a completion channel on its own.
 */

export type RiskLevel = 'high' | 'medium' | 'low';

/** What a human should do with a graded file; low files are explicitly skippable. */
export type RiskDisposition = 'review-and-test' | 'test' | 'skip';

export interface RiskWeights {
  readonly direct: number;
  readonly transitive: number;
  readonly touched: number;
  /** zero-symbol / unknown / unsupported. */
  readonly blindPenalty: number;
  /** zero-edge / dynamic-only / degraded. */
  readonly advisoryPenalty: number;
  /** Per high-impact consumer sharing a file. */
  readonly sharedPerConsumer: number;
  /** Cap on how many sharing consumers can add score. */
  readonly sharedConsumerCap: number;
  readonly fanoutCap: number;
  readonly fanoutDivisor: number;
  readonly complexityCap: number;
  readonly complexityDivisor: number;
}

export interface RiskThresholds {
  readonly high: number;
  readonly medium: number;
  readonly highFanout: number;
}

/** Partial overrides; every field falls back to the exported default constant. */
export interface RiskWeightOptions {
  readonly direct?: number;
  readonly transitive?: number;
  readonly touched?: number;
  readonly blindPenalty?: number;
  readonly advisoryPenalty?: number;
  readonly sharedPerConsumer?: number;
  readonly sharedConsumerCap?: number;
  readonly fanoutCap?: number;
  readonly fanoutDivisor?: number;
  readonly complexityCap?: number;
  readonly complexityDivisor?: number;
}

export interface RiskThresholdOptions {
  readonly high?: number;
  readonly medium?: number;
  readonly highFanout?: number;
}

export const DEFAULT_RISK_WEIGHTS: RiskWeights = Object.freeze({
  direct: 1,
  transitive: 2,
  touched: 3,
  blindPenalty: 2,
  advisoryPenalty: 1,
  sharedPerConsumer: 2,
  sharedConsumerCap: 3,
  fanoutCap: 50,
  fanoutDivisor: 10,
  complexityCap: 200,
  complexityDivisor: 50,
});

export const DEFAULT_RISK_THRESHOLDS: RiskThresholds = Object.freeze({
  high: 20,
  medium: 8,
  highFanout: 50,
});

/** Every additive term of a single-file risk score. */
export interface RiskParts {
  readonly direct: number;
  readonly transitive: number;
  readonly touched: number;
  readonly impactScore: number;
  readonly coverageBlindness: number;
  readonly sharedDependencies: number;
  readonly fanoutTerm: number;
  readonly complexityTerm: number;
  readonly riskScore: number;
}

export interface RiskRecommendation {
  /** Why this file matters (consumers, blind spot, fanout), precise and deterministic. */
  readonly reason: string;
  /** Test files whose forward resolved closure reaches this file. */
  readonly coveringTests: readonly string[];
  /** True when no test reaches the file; never fabricated into a guess. */
  readonly noCoveringTest: boolean;
  readonly riskLevel: RiskLevel;
}

export interface RiskRow {
  readonly file: string;
  readonly classification: CoverageClassification;
  readonly level: RiskLevel;
  readonly riskScore: number;
  readonly parts: RiskParts;
  readonly direct: number;
  readonly transitive: number;
  readonly fanout: number;
  readonly symbols: number;
  readonly touched: boolean;
  /** High-impact consumers sharing this file (explains `sharedDependencies`). */
  readonly sharedBy: readonly string[];
  readonly recommendation: RiskRecommendation;
  readonly disposition: RiskDisposition;
  readonly rationale: string;
  readonly reviewKinds: readonly ReviewKind[];
}

export type ReviewKind =
  | 'blind-spot'
  | 'dynamic-load'
  | 'registry'
  | 'reflection'
  | 'eval'
  | 'zero-symbol'
  | 'zero-edge'
  | 'deleted'
  | 'test-gap'
  | 'high-fanout';

export type ReviewOrigin = 'manual-review' | 'classification' | 'test-gap' | 'risk-level';

/**
 * One human-review entry. Deliberately has no `evidenceId`/`evidence_id` field:
 * manual review is an input, not Gate evidence (ADR-010 §2.1/§6).
 */
export interface ReviewItem {
  readonly kind: ReviewKind;
  readonly file: string;
  readonly line?: number;
  readonly pattern?: string;
  readonly classification?: CoverageClassification;
  readonly reason: string;
  readonly suggestedAction: string;
  readonly evidenceRevision: string;
  readonly origin: ReviewOrigin;
}

/** Aggregate recommendation per test file (test -> covered risk files). */
export interface RecommendedTest {
  readonly testFile: string;
  readonly covers: readonly string[];
  readonly reason: string;
  readonly riskLevel: RiskLevel;
}

export interface RiskPlan {
  readonly revision: string;
  readonly weights: RiskWeights;
  readonly thresholds: RiskThresholds;
  /** Deterministic order: score desc, fanout desc, path Buffer order. */
  readonly rows: readonly RiskRow[];
  readonly recommendations: readonly RecommendedTest[];
  readonly reviewItems: readonly ReviewItem[];
  /** High/medium files with no reachable test file. */
  readonly testGaps: readonly string[];
  readonly counts: Readonly<Record<RiskLevel, number>>;
  /** Number of low-risk files that may skip mandatory tests. */
  readonly skippedLow: number;
  readonly notes: readonly string[];
  readonly snapshotRevisionMatched: boolean;
}

export interface RiskOptions {
  /** Needed for shared-dependency identity, IIFE detection and reverse test mapping. */
  readonly snapshot?: GraphSnapshot;
  readonly weights?: RiskWeightOptions;
  readonly thresholds?: RiskThresholdOptions;
  /** Defaults to test-looking paths among `snapshot.files`. */
  readonly testFiles?: readonly string[];
}

const SUGGESTED_ACTIONS: Readonly<Record<ReviewKind, string>> = {
  'blind-spot': '人工确认静态不可判定的目标集合，并在可行处补充定位证据',
  'dynamic-load': '确认动态加载目标集合；无法静态解析时补集成测试或显式注册表',
  registry: '确认运行时注册表扫描的实际范围与加载顺序',
  reflection: '确认反射调用目标；必要时以具名映射替代反射',
  eval: '确认 eval/动态执行输入来源；无法静态判定则隔离并人工复核',
  'zero-symbol': '检查是否为 IIFE/嵌套作用域或 CommonJS 导出对象未提取；增强提取后重跑分析',
  'zero-edge': '确认孤立文件是否为入口/脚本；必要时补冒烟测试',
  deleted: '确认是否有意删除；若为误删则恢复并更新引用',
  'test-gap': '无可达测试文件；新增针对该文件的测试或记录明确豁免理由',
  'high-fanout': '高风险共享中心；优先回归直接依赖方并审查共享契约',
};

function comparePath(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right));
}

function normalizeWeights(options?: RiskWeightOptions): RiskWeights {
  const defaults = DEFAULT_RISK_WEIGHTS;
  if (options === undefined) return defaults;
  return {
    direct: options.direct ?? defaults.direct,
    transitive: options.transitive ?? defaults.transitive,
    touched: options.touched ?? defaults.touched,
    blindPenalty: options.blindPenalty ?? defaults.blindPenalty,
    advisoryPenalty: options.advisoryPenalty ?? defaults.advisoryPenalty,
    sharedPerConsumer: options.sharedPerConsumer ?? defaults.sharedPerConsumer,
    sharedConsumerCap: options.sharedConsumerCap ?? defaults.sharedConsumerCap,
    fanoutCap: options.fanoutCap ?? defaults.fanoutCap,
    fanoutDivisor: options.fanoutDivisor ?? defaults.fanoutDivisor,
    complexityCap: options.complexityCap ?? defaults.complexityCap,
    complexityDivisor: options.complexityDivisor ?? defaults.complexityDivisor,
  };
}

function normalizeThresholds(options?: RiskThresholdOptions): RiskThresholds {
  const defaults = DEFAULT_RISK_THRESHOLDS;
  if (options === undefined) return defaults;
  return {
    high: options.high ?? defaults.high,
    medium: options.medium ?? defaults.medium,
    highFanout: options.highFanout ?? defaults.highFanout,
  };
}

function formatScore(value: number): number {
  return Number(value.toFixed(4));
}

/** Advisory edges are excluded from the main impact caliber (ADR-010 §5.1). */
function isAdvisoryEdge(edge: { kind: string; provenance: string }): boolean {
  return edge.kind === 'unknown' || edge.provenance === 'heuristic';
}

function penaltyOf(classification: CoverageClassification, weights: RiskWeights): number {
  if (classification === 'zero-symbol' || classification === 'unknown' || classification === 'unsupported') return weights.blindPenalty;
  if (classification === 'zero-edge' || classification === 'dynamic-only' || classification === 'degraded') return weights.advisoryPenalty;
  return 0;
}

function riskLevelOf(
  score: number,
  fanout: number,
  transitive: number,
  impactScore: number,
  blindness: number,
  weights: RiskWeights,
  thresholds: RiskThresholds,
): RiskLevel {
  if (score >= thresholds.high) return 'high';
  if (blindness === weights.blindPenalty && impactScore > 0) return 'high';
  if (fanout >= thresholds.highFanout && transitive > 0) return 'high';
  if (score >= thresholds.medium) return 'medium';
  return 'low';
}

/** ADR-010 §5.3 test-file recognition, applied to project-relative POSIX paths. */
export function isTestFile(file: string): boolean {
  const normalized = file.replaceAll('\\', '/');
  const base = normalized.slice(normalized.lastIndexOf('/') + 1);
  if (/\.(test|spec)\.[^.]+$/.test(base)) return true;
  const segments = normalized.split('/').filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === '__tests__')) return true;
  if (segments[0] === 'test' || segments[0] === 'tests') return true;
  if (segments.length >= 2) {
    const parent = segments[segments.length - 2];
    if (parent === 'test' || parent === 'tests') return true;
  }
  return false;
}

/** Files whose captured symbols carry an IIFE/nested scope (`<file>#<iife>...`). */
export function detectIifeFiles(snapshot: GraphSnapshot): string[] {
  const files = new Set<string>();
  for (const symbol of snapshot.symbols) {
    if (symbol.qualifiedName.includes('#<iife>')) files.add(symbol.file);
  }
  return [...files].sort(comparePath);
}

function collectTestFiles(snapshot: GraphSnapshot): string[] {
  return Object.keys(snapshot.files).filter(isTestFile).sort(comparePath);
}

interface MutableReverse {
  reverse: Map<string, Set<string>>;
  forward: Map<string, Set<string>>;
}

/**
 * Main-caliber adjacency built once. Reverse drives shared-dependency identity;
 * forward (value-confirmed resolved import edges only) mirrors the existing
 * `blast.testCoverage` closure so recommendations reuse the same semantics.
 */
function buildAdjacency(snapshot: GraphSnapshot): MutableReverse {
  const reverse = new Map<string, Set<string>>();
  const forward = new Map<string, Set<string>>();
  const link = (map: Map<string, Set<string>>, key: string, value: string): void => {
    const set = map.get(key);
    if (set === undefined) map.set(key, new Set([value]));
    else set.add(value);
  };
  for (const edge of snapshot.edges) {
    if (edge.to === '<dynamic>' || edge.from === edge.to) continue;
    if (!isAdvisoryEdge(edge)) link(reverse, edge.to, edge.from);
    if (edge.kind === 'value-confirmed' && edge.provenance === 'resolved') link(forward, edge.from, edge.to);
  }
  for (const call of snapshot.calls ?? []) {
    if (call.from === call.to || call.provenance !== 'resolved') continue;
    link(reverse, call.to, call.from);
  }
  return { reverse, forward };
}

function forwardClosure(forward: Map<string, Set<string>>, root: string): Set<string> {
  const seen = new Set<string>([root]);
  const queue = [root];
  for (let index = 0; index < queue.length; index += 1) {
    for (const next of forward.get(queue[index]!) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

function kindOfBlindSpot(type: BlindSpotType): ReviewKind {
  if (type === 'registry-scan') return 'registry';
  if (type === 'reflection') return 'reflection';
  if (type === 'eval') return 'eval';
  if (type === 'dynamic-load') return 'dynamic-load';
  if (type === 'zero-symbol') return 'zero-symbol';
  if (type === 'deleted') return 'deleted';
  return 'blind-spot';
}

interface DraftRow {
  file: string;
  classification: CoverageClassification;
  level: RiskLevel;
  riskScore: number;
  parts: RiskParts;
  direct: number;
  transitive: number;
  fanout: number;
  symbols: number;
  touched: boolean;
  sharedBy: readonly string[];
  recommendation: RiskRecommendation;
  disposition: RiskDisposition;
  rationale: string;
}

interface ReviewSeed {
  kind: ReviewKind;
  file: string;
  line?: number;
  pattern?: string;
  classification?: CoverageClassification;
  reason: string;
  origin: ReviewOrigin;
}

function seedKey(seed: ReviewSeed): string {
  return `${seed.file}\0${seed.kind}\0${seed.line ?? ''}\0${seed.pattern ?? ''}\0${seed.reason}`;
}

function compareSeed(left: ReviewSeed, right: ReviewSeed): number {
  return comparePath(left.file, right.file)
    || left.kind.localeCompare(right.kind)
    || (left.line ?? 0) - (right.line ?? 0)
    || (left.pattern ?? '').localeCompare(right.pattern ?? '')
    || left.reason.localeCompare(right.reason);
}

function buildReviewSeeds(
  analysis: StructureAnalysis,
  drafts: readonly DraftRow[],
  iifeFiles: readonly string[],
  testGaps: ReadonlySet<string>,
  thresholds: RiskThresholds,
): ReviewSeed[] {
  const seeds: ReviewSeed[] = [];
  const byFile = new Map(drafts.map((row) => [row.file, row]));

  // Human-confirmation findings carried by the analyzer: heuristic/unknown
  // dynamic loads plus registry/reflection/eval locations.
  for (const finding of analysis.manualReview ?? []) {
    if (byFile.get(finding.file) === undefined) continue;
    seeds.push({
      kind: kindOfBlindSpot(finding.type),
      file: finding.file,
      ...(finding.line !== undefined ? { line: finding.line } : {}),
      ...(finding.pattern !== undefined ? { pattern: finding.pattern } : {}),
      reason: finding.reason,
      origin: 'manual-review',
    });
  }

  // Classification-derived blind spots. Zero-symbol stays a review item even
  // though the analyzer also lists it under static findings: extraction gaps
  // need a human decision, not a silent pass.
  for (const row of drafts) {
    if (row.classification === 'zero-symbol') {
      seeds.push({
        kind: 'zero-symbol',
        file: row.file,
        classification: row.classification,
        reason: 'parsed with zero captured symbols; possible IIFE/nested-scope or CommonJS export-object extraction gap',
        origin: 'classification',
      });
    } else if (row.classification === 'unknown') {
      seeds.push({
        kind: 'blind-spot',
        file: row.file,
        classification: row.classification,
        reason: 'static semantics insufficient (registry/reflection/eval/computed require)',
        origin: 'classification',
      });
    } else if (row.classification === 'unsupported') {
      seeds.push({
        kind: 'blind-spot',
        file: row.file,
        classification: row.classification,
        reason: 'extension or grammar could not produce trustworthy symbols/edges',
        origin: 'classification',
      });
    } else if (row.classification === 'deleted') {
      seeds.push({
        kind: 'deleted',
        file: row.file,
        classification: row.classification,
        reason: 'file disappeared after the previous snapshot; confirm intentional deletion',
        origin: 'classification',
      });
    } else if (row.classification === 'zero-edge') {
      seeds.push({
        kind: 'zero-edge',
        file: row.file,
        classification: row.classification,
        reason: 'isolated file with symbols but no static dependency edges',
        origin: 'classification',
      });
    }
  }

  // Captured IIFE scopes still hide nested dynamic/registry targets; flag them
  // so the blind spot is reviewed instead of silently treated as healthy.
  for (const file of iifeFiles) {
    if (byFile.get(file) === undefined) continue;
    seeds.push({
      kind: 'blind-spot',
      file,
      pattern: 'iife-nested-scope',
      reason: 'IIFE/nested-scope symbols were captured; nested dynamic/registry targets may still be invisible',
      origin: 'classification',
    });
  }

  // Test gaps and high-risk hubs are inputs, not evidence.
  for (const file of testGaps) {
    seeds.push({
      kind: 'test-gap',
      file,
      reason: 'no test file reaches this risk file through resolved value-confirmed imports',
      origin: 'test-gap',
    });
  }
  for (const row of drafts) {
    if (row.level !== 'high') continue;
    const hub = row.fanout >= thresholds.highFanout || row.sharedBy.length >= 2;
    if (!hub) continue;
    seeds.push({
      kind: 'high-fanout',
      file: row.file,
      reason: `high-risk shared center (fanout ${row.fanout}, ${row.sharedBy.length} high-impact consumer(s))`,
      origin: 'risk-level',
    });
  }

  return seeds;
}

function finalizeReviewItems(seeds: readonly ReviewSeed[], revision: string): ReviewItem[] {
  const seen = new Set<string>();
  const items: ReviewItem[] = [];
  for (const seed of seeds) {
    const key = seedKey(seed);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      kind: seed.kind,
      file: seed.file,
      ...(seed.line !== undefined ? { line: seed.line } : {}),
      ...(seed.pattern !== undefined ? { pattern: seed.pattern } : {}),
      ...(seed.classification !== undefined ? { classification: seed.classification } : {}),
      reason: seed.reason,
      suggestedAction: SUGGESTED_ACTIONS[seed.kind],
      evidenceRevision: revision,
      origin: seed.origin,
    });
  }
  items.sort((left, right) => comparePath(left.file, right.file)
    || left.kind.localeCompare(right.kind)
    || (left.line ?? 0) - (right.line ?? 0)
    || left.reason.localeCompare(right.reason));
  return items;
}

function recommendationFor(
  row: DraftRow,
  coveringTests: readonly string[],
  weights: RiskWeights,
  thresholds: RiskThresholds,
): { recommendation: RiskRecommendation; disposition: RiskDisposition; rationale: string } {
  const segments: string[] = [];
  if (row.touched) segments.push('touched file');
  if (row.direct > 0) segments.push(`${row.direct} direct dependent(s)`);
  if (row.transitive > 0) segments.push(`${row.transitive} transitive dependent(s)`);
  if (row.sharedBy.length > 0) segments.push(`shared by ${row.sharedBy.length} high-impact file(s)`);
  if (row.parts.coverageBlindness > 0) segments.push(`${row.classification} blind spot`);
  if (row.fanout > 0) segments.push(`fanout ${row.fanout}`);
  let reason = segments.length > 0 ? segments.join('; ') : 'no dependents, fanout or blind-spot evidence';
  const noCoveringTest = coveringTests.length === 0;
  if (noCoveringTest) {
    reason += '; noCoveringTest=true (no reachable test file)';
  } else {
    reason += `; covering tests: ${coveringTests.join(', ')}`;
  }
  if (row.level === 'low') reason += '; low risk: no mandatory tests';

  const disposition: RiskDisposition = row.level === 'high' ? 'review-and-test' : row.level === 'medium' ? 'test' : 'skip';
  let rationale: string;
  if (disposition === 'skip') {
    rationale = `skip: riskScore ${formatScore(row.riskScore)} < medium ${thresholds.medium}; no mandatory tests`
      + ` (weights fanout<=${weights.fanoutCap}/${weights.fanoutDivisor}, complexity<=${weights.complexityCap}/${weights.complexityDivisor})`;
  } else if (disposition === 'test') {
    rationale = `test: riskScore ${formatScore(row.riskScore)} in [${thresholds.medium}, ${thresholds.high}); run related covering tests`;
  } else {
    rationale = `review-and-test: riskScore ${formatScore(row.riskScore)} >= ${thresholds.high} or blind/high-fanout rule; run covering tests and clear manual-review items`;
  }
  return {
    recommendation: { reason, coveringTests, noCoveringTest, riskLevel: row.level },
    disposition,
    rationale,
  };
}

/**
 * Grades one `StructureAnalysis` into an explainable risk plan.
 *
 * The base decomposition mirrors ADR-010 §5.2 and adds an explicit
 * `sharedDependencies` term (high-impact consumers sharing a file) plus a
 * detailed `coverageBlindness` classification. Nothing here produces Gate
 * evidence: review items carry a graph revision but no `evidence_id`.
 */
export function assessRisk(analysis: StructureAnalysis, options: RiskOptions = {}): RiskPlan {
  const weights = normalizeWeights(options.weights);
  const thresholds = normalizeThresholds(options.thresholds);
  const snapshot = options.snapshot;
  const notes: string[] = ['risk-not-evidence:review-items-are-inputs-only'];

  const touchedSet = new Set(analysis.closure.touched);
  const graded = analysis.files.filter((row) => row.classification !== 'excluded');
  const excludedCount = analysis.files.length - graded.length;
  if (excludedCount > 0) notes.push(`excluded-out-of-risk-grading:${excludedCount}`);
  if (analysis.depthLimited) notes.push(`depth-limit:maxDepth=${analysis.maxDepth}`);

  const snapshotRevisionMatched = snapshot !== undefined && snapshot.revision === analysis.revision;
  if (snapshot === undefined) {
    notes.push('snapshot-unavailable:test-recommendations-disabled');
    notes.push('snapshot-unavailable:shared-dependencies-disabled');
    notes.push('snapshot-unavailable:iife-detection-disabled');
  } else if (!snapshotRevisionMatched) {
    notes.push(`revision-mismatch:snapshot=${snapshot.revision},analysis=${analysis.revision}`);
  }

  // High-impact consumers: graded high by the analyzer, or central enough to
  // have transitive dependents themselves.
  const highImpact = new Set<string>();
  for (const risk of analysis.risks) if (risk.level === 'high') highImpact.add(risk.file);
  for (const row of analysis.files) if (row.transitiveDependents > 0) highImpact.add(row.file);

  const adjacency = snapshot === undefined ? undefined : buildAdjacency(snapshot);
  const reverse = adjacency?.reverse;
  const testFiles = options.testFiles ?? (snapshot === undefined ? [] : collectTestFiles(snapshot));
  const reach = new Map<string, Set<string>>();
  if (adjacency !== undefined) {
    for (const testFile of testFiles) reach.set(testFile, forwardClosure(adjacency.forward, testFile));
  }

  const drafts: DraftRow[] = [];
  for (const source of graded) {
    const direct = source.directDependents;
    const transitive = source.transitiveDependents;
    const touched = touchedSet.has(source.file);
    const weightedDirect = weights.direct * direct;
    const weightedTransitive = weights.transitive * transitive;
    const weightedTouched = weights.touched * (touched ? 1 : 0);
    const impactScore = weightedDirect + weightedTransitive + weightedTouched;
    const coverageBlindness = penaltyOf(source.classification, weights);

    let sharedBy: string[] = [];
    if (reverse !== undefined) {
      sharedBy = [...(reverse.get(source.file) ?? [])]
        .filter((consumer) => consumer !== source.file && highImpact.has(consumer))
        .sort(comparePath);
    }
    const sharedDependencies = Math.min(sharedBy.length, weights.sharedConsumerCap) * weights.sharedPerConsumer;
    const fanoutTerm = Math.min(source.fanout, weights.fanoutCap) / weights.fanoutDivisor;
    const complexityTerm = Math.min(source.symbols, weights.complexityCap) / weights.complexityDivisor;
    const riskScore = impactScore + coverageBlindness + sharedDependencies + fanoutTerm + complexityTerm;
    const level = riskLevelOf(riskScore, source.fanout, transitive, impactScore, coverageBlindness, weights, thresholds);

    const coveringTests = testFiles
      .filter((testFile) => (reach.get(testFile) ?? new Set<string>()).has(source.file))
      .sort(comparePath);
    const draft: DraftRow = {
      file: source.file,
      classification: source.classification,
      level,
      riskScore,
      parts: {
        direct: weightedDirect,
        transitive: weightedTransitive,
        touched: weightedTouched,
        impactScore,
        coverageBlindness,
        sharedDependencies,
        fanoutTerm,
        complexityTerm,
        riskScore,
      },
      direct,
      transitive,
      fanout: source.fanout,
      symbols: source.symbols,
      touched,
      sharedBy,
      recommendation: { reason: '', coveringTests, noCoveringTest: coveringTests.length === 0, riskLevel: level },
      disposition: 'skip',
      rationale: '',
    };
    const shaped = recommendationFor(draft, coveringTests, weights, thresholds);
    drafts.push({ ...draft, recommendation: shaped.recommendation, disposition: shaped.disposition, rationale: shaped.rationale });
  }
  drafts.sort((left, right) => right.riskScore - left.riskScore
    || right.fanout - left.fanout
    || comparePath(left.file, right.file));

  const testGaps = new Set<string>(
    drafts.filter((row) => row.level !== 'low' && row.recommendation.noCoveringTest).map((row) => row.file),
  );
  const iifeFiles = snapshot === undefined ? [] : detectIifeFiles(snapshot);
  const seeds = buildReviewSeeds(analysis, drafts, iifeFiles, testGaps, thresholds);
  const reviewItems = finalizeReviewItems(seeds, analysis.revision);
  const kindsByFile = new Map<string, Set<ReviewKind>>();
  for (const item of reviewItems) {
    const set = kindsByFile.get(item.file);
    if (set === undefined) kindsByFile.set(item.file, new Set([item.kind]));
    else set.add(item.kind);
  }

  const rows: RiskRow[] = drafts.map((draft) => ({
    file: draft.file,
    classification: draft.classification,
    level: draft.level,
    riskScore: draft.riskScore,
    parts: draft.parts,
    direct: draft.direct,
    transitive: draft.transitive,
    fanout: draft.fanout,
    symbols: draft.symbols,
    touched: draft.touched,
    sharedBy: draft.sharedBy,
    recommendation: draft.recommendation,
    disposition: draft.disposition,
    rationale: draft.rationale,
    reviewKinds: [...(kindsByFile.get(draft.file) ?? [])].sort(),
  }));
  rows.sort((left, right) => right.riskScore - left.riskScore
    || right.fanout - left.fanout
    || comparePath(left.file, right.file));

  // Aggregate recommendations per test file, excluding skippable low-risk files.
  const recommendable = rows.filter((row) => row.level !== 'low');
  const levelByFile = new Map(rows.map((row) => [row.file, row.level]));
  const aggregated: RecommendedTest[] = [];
  for (const testFile of testFiles) {
    const covers = recommendable
      .filter((row) => row.recommendation.coveringTests.includes(testFile))
      .map((row) => row.file)
      .sort(comparePath);
    if (covers.length === 0) continue;
    const riskLevel: RiskLevel = covers.some((file) => levelByFile.get(file) === 'high') ? 'high' : 'medium';
    aggregated.push({
      testFile,
      covers,
      reason: `reaches ${covers.length} affected file(s): ${covers.join(', ')}`,
      riskLevel,
    });
  }
  aggregated.sort((left, right) => right.covers.length - left.covers.length
    || comparePath(left.testFile, right.testFile));

  const counts: Record<RiskLevel, number> = { high: 0, medium: 0, low: 0 };
  for (const row of rows) counts[row.level] += 1;

  return {
    revision: analysis.revision,
    weights,
    thresholds,
    rows,
    recommendations: aggregated,
    reviewItems,
    testGaps: [...testGaps].sort(comparePath),
    counts,
    skippedLow: counts.low,
    notes,
    snapshotRevisionMatched,
  };
}
