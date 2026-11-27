import { analyzeStructure } from '../structure/analysis.ts';
import { assessRisk, type ReviewItem, type RiskPlan, type RiskThresholdOptions, type RiskWeightOptions } from '../structure/risk.ts';
import { blastRadius, testCoverage, type BlastRiskSummary, type CoveragePolicy } from './blast.ts';
import type { StructureEvidence } from './types.ts';
import type { Evidence, TaskVerdict } from './types.ts';
import type { GraphSnapshot, Freshness } from '../structure/types.ts';

export interface TaskState {
  id: string;
  status: 'todo' | 'in_progress' | 'done' | 'cancelled';
  declaredFiles: string[];
}

/**
 * Opt-in ADR-010 §5 grading consumed by the Gate. Weights/thresholds only tune
 * how risk is explained; they can never replace execution evidence.
 */
export interface StructureRiskRequest {
  readonly weights?: RiskWeightOptions;
  readonly thresholds?: RiskThresholdOptions;
  readonly testFiles?: readonly string[];
}

function describeReviewItem(item: ReviewItem): string {
  const location = item.line !== undefined ? `:${item.line}` : '';
  return `${item.file} (${item.kind}${item.pattern ? `/${item.pattern}` : ''}${location})`;
}

/**
 * Maps structural blind spots onto the existing `unknown` policy. No parallel
 * policy is introduced: `strict` may block on unreviewed high-risk manual-review
 * findings, `advisory` only records warnings.
 */
function structureEffects(plan: RiskPlan, policy: CoveragePolicy): { reasons: string[]; warnings: string[] } {
  const levelByFile = new Map(plan.rows.map((row) => [row.file, row.level]));
  const manual: ReviewItem[] = [];
  const other: ReviewItem[] = [];
  for (const item of plan.reviewItems) {
    if (levelByFile.get(item.file) !== 'high') continue;
    if (item.origin === 'manual-review') manual.push(item);
    else other.push(item);
  }
  const reasons: string[] = [];
  const warnings: string[] = [];
  for (const item of other) {
    warnings.push(`High-risk structure finding needs human review: ${describeReviewItem(item)}`);
  }
  for (const item of manual) {
    if (policy.unknown === 'strict') {
      reasons.push(`Unreviewed high-risk structure blind spot blocks completion: ${describeReviewItem(item)}; unknown=strict requires manual review first`);
    } else {
      warnings.push(`Advisory high-risk structure blind spot: ${describeReviewItem(item)}; unknown=advisory records without blocking`);
    }
  }
  return { reasons, warnings };
}

export function verdictForTask(input: {
  task: TaskState;
  touched: string[];
  executedTests: string[];
  evidence?: Evidence;
  graph: GraphSnapshot;
  freshness: Freshness;
  policy: CoveragePolicy;
  /** ADR-010 §5/§6 opt-in structural coverage evidence. */
  structure?: StructureRiskRequest;
  /** Caller-supplied review claims are counted and ignored; they never gate. */
  untrustedReviewItems?: readonly unknown[];
}): TaskVerdict {
  const touched = [...new Set([...input.task.declaredFiles, ...input.touched])].sort();
  const executedTests = [...new Set(input.executedTests)].sort();
  let blast = blastRadius(input.graph, touched, executedTests, input.policy);
  const reasons: string[] = [];
  if (!input.evidence) reasons.push('No execution evidence was recorded.');
  if (input.evidence && !input.evidence.ok) reasons.push('The latest execution failed, timed out, or reported skipped/cancelled/todo work.');
  if (input.evidence && input.evidence.sourceFingerprint !== input.graph.sourceFingerprint) reasons.push('Evidence source fingerprint does not match current source.');
  if (input.evidence && input.evidence.graphRevision !== input.graph.revision) reasons.push('Evidence graph revision does not match current graph.');
  if (input.freshness.status !== 'fresh') reasons.push(`Graph is ${input.freshness.status}; a stale/degraded graph cannot support completion.`);
  if (input.task.status === 'cancelled' || input.task.status === 'todo') reasons.push(`Task state is ${input.task.status}.`);
  if (input.policy.minimum === 'T1' && blast.uncovered.length > 0) reasons.push(`Files lack value-confirmed test reachability: ${blast.uncovered.join(', ')}`);

  let structure: StructureEvidence | undefined;
  const warnings: string[] = [];
  const riskRequest = input.structure;
  if (riskRequest !== undefined) {
    // Recompute from the current snapshot; caller-supplied grading is never trusted.
    const analysis = analyzeStructure(input.graph, { touched });
    const plan = assessRisk(analysis, {
      snapshot: input.graph,
      ...(riskRequest.weights !== undefined ? { weights: riskRequest.weights } : {}),
      ...(riskRequest.thresholds !== undefined ? { thresholds: riskRequest.thresholds } : {}),
      ...(riskRequest.testFiles !== undefined ? { testFiles: riskRequest.testFiles } : {}),
    });
    blast = blastRadius(input.graph, touched, executedTests, input.policy, {
      risk: {
        analysis,
        ...(riskRequest.weights !== undefined ? { weights: riskRequest.weights } : {}),
        ...(riskRequest.thresholds !== undefined ? { thresholds: riskRequest.thresholds } : {}),
        ...(riskRequest.testFiles !== undefined ? { testFiles: riskRequest.testFiles } : {}),
      },
    });

    // Actual test coverage versus the structurally high-risk set. `testCoverage`
    // starts from the executed tests themselves, so a high-risk file is covered
    // only when a real executed test reaches it through resolved imports.
    const reachable = testCoverage(input.graph, executedTests);
    const highRiskFiles = plan.rows.filter((row) => row.level === 'high').map((row) => row.file);
    const coveredHighRisk = highRiskFiles.filter((file) => reachable.has(file));
    const uncoveredHighRisk = highRiskFiles.filter((file) => !reachable.has(file));

    const effects = structureEffects(plan, input.policy);
    reasons.push(...effects.reasons);
    warnings.push(...effects.warnings);

    let structureBlocked = effects.reasons.length > 0;
    if (uncoveredHighRisk.length > 0) {
      const message = `High-risk files have no executed-test coverage: ${uncoveredHighRisk.join(', ')}`;
      if (input.policy.unknown === 'strict') {
        reasons.push(message);
        structureBlocked = true;
      } else {
        warnings.push(message);
      }
    }

    const riskSummary: BlastRiskSummary | undefined = blast.risk;
    structure = {
      ...(riskSummary !== undefined ? { riskSummary } : {}),
      coverageGap: {
        executedTests,
        highRiskFiles,
        coveredHighRisk,
        uncoveredHighRisk,
        ...(plan.testGaps.length > 0 ? { testGaps: plan.testGaps } : {}),
      },
      reviewItems: plan.reviewItems,
      ...(input.untrustedReviewItems !== undefined ? { untrustedReviewItems: input.untrustedReviewItems.length } : {}),
      policyEffect: structureBlocked ? 'blocked' : warnings.length > 0 ? 'warned' : 'recorded',
    };
  }

  const level = input.policy.minimum === 'T1' && input.evidence?.ok && blast.uncovered.length === 0 ? 'T1' : input.evidence?.ok ? 'T0' : 'none';
  return {
    taskId: input.task.id,
    status: reasons.length === 0 ? 'done' : 'blocked',
    level,
    ...(input.evidence ? { evidenceId: input.evidence.id } : {}),
    sourceFingerprint: input.graph.sourceFingerprint,
    graphRevision: input.graph.revision,
    freshness: input.freshness,
    blastRadius: blast,
    policy: input.policy,
    caveats: input.graph.caveats,
    reasons,
    ...(structure !== undefined ? { structure } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
