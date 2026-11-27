import type { GraphEdge, GraphSnapshot } from '../structure/types.ts';
import { analyzeStructure, type StructureAnalysis } from '../structure/analysis.ts';
import { assessRisk, type RiskLevel, type RiskPlan, type RiskThresholdOptions, type RiskWeightOptions } from '../structure/risk.ts';

export interface CoveragePolicy {
  minimum: 'T0' | 'T1';
  unknown: 'strict' | 'advisory';
}

/**
 * Optional ADR-010 §5 grading attached to a blast radius. Advisory only: it is
 * never execution evidence and never produces an `evidence_id`.
 */
export interface BlastRiskSummary {
  readonly revision: string;
  readonly levels: Readonly<Record<string, RiskLevel>>;
  readonly counts: Readonly<Record<RiskLevel, number>>;
  /** High-risk centers ordered by fanout desc, then path Buffer order. */
  readonly highCenters: readonly string[];
  /** High/medium files no test reaches through resolved value-confirmed imports. */
  readonly testGaps: readonly string[];
  readonly reviewCount: number;
}

export interface BlastRadius {
  impacted: string[];
  covered: string[];
  uncovered: string[];
  advisory: string[];
  /** Absent unless `options.risk` was supplied; existing callers are unaffected. */
  risk?: BlastRiskSummary;
}

export interface BlastRiskRequest {
  /** Precomputed analysis; defaults to one batch `analyzeStructure` over `snapshot`. */
  readonly analysis?: StructureAnalysis;
  readonly weights?: RiskWeightOptions;
  readonly thresholds?: RiskThresholdOptions;
  readonly testFiles?: readonly string[];
}

export interface BlastOptions {
  readonly risk?: BlastRiskRequest;
}

export function impact(snapshot: GraphSnapshot, touched: Iterable<string>): string[] {
  const reverse = new Map<string, string[]>();
  for (const edge of snapshot.edges) {
    const sources = reverse.get(edge.to) ?? [];
    sources.push(edge.from);
    reverse.set(edge.to, sources);
  }
  const found = new Set(touched);
  const queue = [...found];
  for (let index = 0; index < queue.length; index += 1) {
    for (const source of reverse.get(queue[index]!) ?? []) {
      if (!found.has(source)) {
        found.add(source);
        queue.push(source);
      }
    }
  }
  return [...found].sort();
}

/**
 * Forward reachability along `value-confirmed`/`resolved` import edges. This is
 * exactly the closure `testCoverage` uses, exposed so risk.ts can reuse the same
 * caliber instead of implementing a second one.
 */
export function reachableFrom(snapshot: GraphSnapshot, roots: Iterable<string>): Set<string> {
  const covered = new Set(roots);
  const queue = [...covered];
  for (let index = 0; index < queue.length; index += 1) {
    for (const edge of snapshot.edges) {
      if (edge.from === queue[index] && edge.kind === 'value-confirmed' && edge.provenance === 'resolved' && !covered.has(edge.to)) {
        covered.add(edge.to);
        queue.push(edge.to);
      }
    }
  }
  return covered;
}

export function testCoverage(snapshot: GraphSnapshot, executedTests: Iterable<string>): Set<string> {
  return reachableFrom(snapshot, executedTests);
}

function isAdvisory(edge: GraphEdge): boolean {
  return edge.kind === 'unknown' || edge.provenance === 'heuristic';
}

function summarizeRisk(plan: RiskPlan): BlastRiskSummary {
  const levels: Record<string, RiskLevel> = {};
  for (const row of plan.rows) levels[row.file] = row.level;
  const highCenters = plan.rows
    .filter((row) => row.level === 'high')
    .sort((left, right) => right.fanout - left.fanout || Buffer.from(left.file).compare(Buffer.from(right.file)))
    .map((row) => row.file);
  return {
    revision: plan.revision,
    levels,
    counts: plan.counts,
    highCenters,
    testGaps: plan.testGaps,
    reviewCount: plan.reviewItems.length,
  };
}

export function blastRadius(snapshot: GraphSnapshot, touched: Iterable<string>, executedTests: Iterable<string>, policy: CoveragePolicy, options: BlastOptions = {}): BlastRadius {
  const impacted = impact(snapshot, touched);
  const covered = testCoverage(snapshot, executedTests);
  const advisory = new Set<string>();
  if (policy.unknown === 'advisory') {
    const queue = [...touched];
    const seen = new Set(queue);
    for (let index = 0; index < queue.length; index += 1) {
      for (const edge of snapshot.edges.filter((candidate) => candidate.to === queue[index] && isAdvisory(candidate))) {
        if (!seen.has(edge.from)) {
          seen.add(edge.from);
          queue.push(edge.from);
          advisory.add(edge.from);
        }
      }
    }
  }
  const required = impacted.filter((file) => policy.minimum === 'T0' || covered.has(file) || advisory.has(file));
  const result: BlastRadius = { impacted, covered: impacted.filter((file) => covered.has(file)), uncovered: impacted.filter((file) => !required.includes(file)), advisory: [...advisory].sort() };

  // Risk grading is opt-in so every existing caller keeps the exact old shape.
  if (options.risk === undefined) return result;
  const touchedSorted = [...new Set(touched)].sort();
  const analysis = options.risk.analysis ?? analyzeStructure(snapshot, { touched: touchedSorted });
  const plan = assessRisk(analysis, {
    snapshot,
    ...(options.risk.weights !== undefined ? { weights: options.risk.weights } : {}),
    ...(options.risk.thresholds !== undefined ? { thresholds: options.risk.thresholds } : {}),
    ...(options.risk.testFiles !== undefined ? { testFiles: options.risk.testFiles } : {}),
  });
  return { ...result, risk: summarizeRisk(plan) };
}
