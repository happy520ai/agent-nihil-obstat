import { tokenizeText } from './tokenizer.ts';

/**
 * AnchorProbe relation candidate classifier (P4 / AP-21).
 *
 * Read-side proposal engine: it classifies the relationship between a source
 * record (new or proposed content) and an existing target record into
 * `unrelated / continuation / cross_link / supersede_candidate`.
 *
 * Hard boundaries (ADR-005 §6/§7, docs/anchor-probe-integration.md §9.1):
 * - The classifier never writes the ledger and never evaluates the deterministic
 *   append preconditions. `ledger_precondition` is always `not_checked`.
 * - `supersede_candidate` is a proposal only. Submission requires an explicit
 *   actor and the Ledger precondition check; the classifier has no approval or
 *   replacement authority.
 * - Unconfirmed pairs are reported as `needs_review`; no definitive label is
 *   fabricated for an ambiguous pair.
 * - No GPU, cloud or native dependency is required: the rule layer is pure local
 *   computation over the injected index, and the model layer is an optional
 *   injected adapter that only ever sees a bounded candidate slice.
 * - The 2-bit label encoding is a storage/transport convenience. It is NOT
 *   evidence of any inference/reasoning optimization.
 *
 * The rule layer reuses the existing tokenizer/index vocabulary; it does not
 * introduce a new index or a heavy dependency. Candidate count and scope are
 * bounded by an explicit budget so the model layer cannot be asked to compare an
 * unbounded set.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const relationLabels = ['unrelated', 'continuation', 'cross_link', 'supersede_candidate'] as const;
export type RelationLabel = (typeof relationLabels)[number];

/**
 * `classified` means a definitive label was produced (including `unrelated`,
 * which is a verdict, not a write proposal). `needs_review` means the pair is
 * deliberately left unresolved.
 */
export const relationDecisionStatuses = ['classified', 'needs_review'] as const;
export type RelationDecisionStatus = (typeof relationDecisionStatuses)[number];

export const relationConfidenceBases = ['rule_score', 'explicit_input', 'model', 'unknown'] as const;
export type RelationConfidenceBasis = (typeof relationConfidenceBases)[number];

export const relationDecisionLayers = ['rule', 'explicit', 'model'] as const;
export type RelationDecisionLayer = (typeof relationDecisionLayers)[number];

/** Ledger `memory.related` edge vocabulary (ADR-005 §4.2). */
export const relationEdgeKinds = ['depends_on', 'explains', 'related_to'] as const;
export type RelationEdgeKind = (typeof relationEdgeKinds)[number];

/** Incoming index edges may also carry probe-only relation kinds. */
export const relationIndexEdgeKinds = [...relationEdgeKinds, 'supersedes', 'conflicts_with', 'unknown'] as const;
export type RelationIndexEdgeKind = (typeof relationIndexEdgeKinds)[number];

export const relationRecordStatuses = ['active', 'superseded', 'conflicted', 'retracted', 'proposed', 'unknown'] as const;
export type RelationRecordStatus = (typeof relationRecordStatuses)[number];

export const relationEligibilities = ['governed', 'legacy_unreviewed', 'unknown'] as const;
export type RelationEligibility = (typeof relationEligibilities)[number];

export const relationErrorKinds = [
  'false_supersede',
  'missed_relation',
  'wrong_pass',
  'wrong_block',
  'overconfident_definitive',
] as const;
export type RelationErrorKind = (typeof relationErrorKinds)[number];

export const RELATION_CALIBRATION_SCHEMA_VERSION = 'anchorprobe.relation-calibration.v1';

// ---------------------------------------------------------------------------
// Records, index and budget
// ---------------------------------------------------------------------------

/**
 * One record as seen by the classifier. `scope` is the structural project
 * namespace (ADR-005 §5): cross-scope candidates are excluded before any model
 * comparison. `explicit` carries caller-declared input, which the rule layer
 * honours but never treats as approval.
 */
export interface RelationRecord {
  readonly record_ref: string;
  readonly scope: string;
  readonly fact_key: string | null;
  readonly kind: string | null;
  readonly text: string;
  readonly symbol: string | null;
  readonly file: string | null;
  readonly status: RelationRecordStatus;
  readonly eligibility: RelationEligibility;
  readonly recorded_at: string | null;
  readonly effective_from: string | null;
  readonly effective_to: string | null;
  readonly explicit?: RelationExplicitInput;
}

/** Caller-declared input. It can steer a label but never bypasses the ledger. */
export interface RelationExplicitInput {
  readonly relation?: RelationLabel;
  readonly edge?: RelationEdgeKind;
  readonly supersedes?: readonly string[];
  readonly reason?: string;
}

export interface RelationEdge {
  readonly from_ref: string;
  readonly to_ref: string;
  readonly kind: RelationIndexEdgeKind;
}

export interface RelationEntryQuery {
  readonly fact_key?: string;
  readonly file?: string;
  readonly symbol?: string;
}

/**
 * Minimal index port. It mirrors the existing probe candidate source shape so
 * the classifier can consume the same entity/lexical index without owning it.
 */
export interface RelationIndexSource {
  entries(query?: RelationEntryQuery): readonly RelationRecord[];
  edges(): readonly RelationEdge[];
}

export interface RelationIndex {
  readonly entries: readonly RelationRecord[];
  readonly edges: readonly RelationEdge[];
}

/**
 * Candidate bounds. Every knob is a hard ceiling, not a target: the selector
 * truncates deterministically and reports that it did so.
 */
export interface RelationCandidateBudget {
  readonly max_candidates: number;
  readonly max_per_fact_key: number;
  readonly max_lexical_matches: number;
  readonly max_model_comparisons: number;
}

export const defaultRelationCandidateBudget: RelationCandidateBudget = {
  max_candidates: 16,
  max_per_fact_key: 4,
  max_lexical_matches: 32,
  max_model_comparisons: 8,
};

const LEXICAL_RELATION_THRESHOLD = 0.45;
const LEXICAL_STRONG_THRESHOLD = 0.7;
const HEURISTIC_SUPERSEDE_THRESHOLD = 0.75;
const DEFAULT_LOW_CONFIDENCE_THRESHOLD = 0.5;
const DEFAULT_MODEL_CONFIDENCE_THRESHOLD = 0.6;
const MAX_REPORT_EXAMPLES = 8;

function resolveBudget(partial?: Partial<RelationCandidateBudget>): RelationCandidateBudget {
  const merged: RelationCandidateBudget = { ...defaultRelationCandidateBudget, ...partial };
  return {
    max_candidates: Math.max(1, Math.floor(merged.max_candidates)),
    max_per_fact_key: Math.max(1, Math.floor(merged.max_per_fact_key)),
    max_lexical_matches: Math.max(0, Math.floor(merged.max_lexical_matches)),
    max_model_comparisons: Math.max(0, Math.floor(merged.max_model_comparisons)),
  };
}

/** Adapt a probe-like source to the classifier index port, stamping the scope. */
export function relationIndexFromSource(source: RelationIndexSource, scope: string): RelationIndex {
  const entries = source.entries({}).map((entry) => (entry.scope === '' ? { ...entry, scope } : entry));
  return { entries, edges: source.edges() };
}

export function relationIndexFromEntries(entries: readonly RelationRecord[], edges: readonly RelationEdge[] = []): RelationIndex {
  return { entries, edges };
}

// ---------------------------------------------------------------------------
// Candidate selection (bounded coarse screen)
// ---------------------------------------------------------------------------

export interface RelationCandidateSelection {
  readonly source_ref: string;
  readonly scope: string;
  readonly candidates: readonly RelationRecord[];
  /** Scope-matched, non-self records examined. */
  readonly considered: number;
  readonly scope_excluded: number;
  readonly self_excluded: number;
  readonly lexical_only: number;
  readonly truncated: boolean;
  readonly budget: RelationCandidateBudget;
}

interface ScoredRecord {
  readonly record: RelationRecord;
  readonly score: number;
  readonly signals: readonly string[];
  readonly lexical: number;
}

function compareScored(left: ScoredRecord, right: ScoredRecord): number {
  if (left.score !== right.score) return right.score - left.score;
  if (left.record.record_ref === right.record.record_ref) return 0;
  return left.record.record_ref < right.record.record_ref ? -1 : 1;
}

/**
 * Coarse screen over the injected index. Scope filtering happens first, then a
 * deterministic signal score (fact key / symbol / file / indexed edge / lexical
 * overlap). Lexical-only matches are capped separately so a broad vocabulary
 * overlap cannot crowd out entity matches. The result is always bounded by the
 * budget and reports truncation.
 */
export function selectRelationCandidates(
  source: RelationRecord,
  index: RelationIndex,
  budget: Partial<RelationCandidateBudget> = {},
): RelationCandidateSelection {
  const resolved = resolveBudget(budget);
  const scope = source.scope;
  const inScope = index.entries.filter((entry) => entry.scope === scope);
  const scopeExcluded = index.entries.length - inScope.length;
  const others = inScope.filter((entry) => entry.record_ref !== source.record_ref);
  const selfExcluded = inScope.length - others.length;

  const undirected = new Set<string>();
  for (const edge of index.edges) {
    undirected.add(`${edge.from_ref}|${edge.to_ref}`);
    undirected.add(`${edge.to_ref}|${edge.from_ref}`);
  }

  const strong: ScoredRecord[] = [];
  const lexicalOnly: ScoredRecord[] = [];
  for (const record of others) {
    const sameFact = source.fact_key !== null && record.fact_key === source.fact_key;
    const sameSymbol = source.symbol !== null && record.symbol === source.symbol;
    const sameFile = source.file !== null && record.file === source.file;
    const hasEdge = undirected.has(`${source.record_ref}|${record.record_ref}`);
    const lexical = lexicalScore(source.text, record.text);
    const signals: string[] = [];
    if (sameFact) signals.push('same_fact_key');
    if (sameSymbol) signals.push('same_symbol');
    if (sameFile) signals.push('same_file');
    if (hasEdge) signals.push('indexed_edge');
    if (signals.length === 0 && lexical < LEXICAL_RELATION_THRESHOLD) continue;
    const score = (sameFact ? 4 : 0) + (sameSymbol ? 2 : 0) + (sameFile ? 1 : 0) + (hasEdge ? 2 : 0) + lexical * 2;
    const scored: ScoredRecord = { record, score, signals, lexical };
    if (signals.length > 0) strong.push(scored);
    else lexicalOnly.push(scored);
  }

  strong.sort(compareScored);
  lexicalOnly.sort(compareScored);
  const keptLexical = lexicalOnly.slice(0, resolved.max_lexical_matches);
  const merged = [...strong, ...keptLexical];
  merged.sort(compareScored);

  const perFact = new Map<string, number>();
  const capped: RelationRecord[] = [];
  let droppedPerFact = 0;
  for (const item of merged) {
    const key = item.record.fact_key ?? '';
    const count = perFact.get(key) ?? 0;
    if (count >= resolved.max_per_fact_key) {
      droppedPerFact += 1;
      continue;
    }
    perFact.set(key, count + 1);
    capped.push(item.record);
  }

  const candidates = capped.slice(0, resolved.max_candidates);
  return {
    source_ref: source.record_ref,
    scope,
    candidates,
    considered: others.length,
    scope_excluded: scopeExcluded,
    self_excluded: selfExcluded,
    lexical_only: lexicalOnly.length,
    truncated: capped.length > candidates.length
      || lexicalOnly.length > keptLexical.length
      || droppedPerFact > 0,
    budget: resolved,
  };
}

// ---------------------------------------------------------------------------
// Rule layer
// ---------------------------------------------------------------------------

interface PairSignals {
  readonly sameFact: boolean;
  readonly sameSymbol: boolean;
  readonly sameFile: boolean;
  readonly hasEdge: boolean;
  readonly lexical: number;
}

export interface RelationClassifyOptions {
  readonly scope?: string;
  readonly edges?: readonly RelationEdge[];
  readonly low_confidence_threshold?: number;
  readonly model?: RelationModelAdapter;
  readonly budget?: Partial<RelationCandidateBudget>;
}

export interface RelationDecision {
  readonly source_ref: string;
  readonly target_ref: string;
  readonly scope: string;
  /** Null exactly when `status` is `needs_review`. */
  readonly label: RelationLabel | null;
  readonly status: RelationDecisionStatus;
  /** Null means the confidence is unknown, never a fabricated precision. */
  readonly confidence: number | null;
  readonly confidence_basis: RelationConfidenceBasis;
  readonly layer: RelationDecisionLayer;
  readonly reasons: readonly string[];
  readonly signals: readonly string[];
  readonly edge: RelationEdgeKind | null;
  /** Always `not_checked`: the classifier never evaluates Ledger preconditions. */
  readonly ledger_precondition: 'not_checked';
}

function lexicalScore(sourceText: string, targetText: string): number {
  const left = new Set(tokenizeText(sourceText));
  const right = new Set(tokenizeText(targetText));
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function computePairSignals(source: RelationRecord, target: RelationRecord, edges: readonly RelationEdge[]): PairSignals {
  const sameFact = source.fact_key !== null && source.fact_key === target.fact_key;
  const sameSymbol = source.symbol !== null && source.symbol === target.symbol;
  const sameFile = source.file !== null && source.file === target.file;
  const hasEdge = edges.some((edge) => (
    (edge.from_ref === source.record_ref && edge.to_ref === target.record_ref)
    || (edge.from_ref === target.record_ref && edge.to_ref === source.record_ref)
  ));
  return { sameFact, sameSymbol, sameFile, hasEdge, lexical: lexicalScore(source.text, target.text) };
}

function signalNames(signals: PairSignals): string[] {
  const names: string[] = [];
  if (signals.sameFact) names.push('same_fact_key');
  if (signals.sameSymbol) names.push('same_symbol');
  if (signals.sameFile) names.push('same_file');
  if (signals.hasEdge) names.push('indexed_edge');
  if (signals.lexical >= LEXICAL_RELATION_THRESHOLD) names.push('lexical_overlap');
  return names;
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(0.99, Math.max(0, value));
}

function classified(
  source: RelationRecord,
  target: RelationRecord,
  scope: string,
  label: RelationLabel,
  confidence: number | null,
  basis: RelationConfidenceBasis,
  layer: RelationDecisionLayer,
  reasons: readonly string[],
  signals: readonly string[],
  edge: RelationEdgeKind | null,
): RelationDecision {
  return {
    source_ref: source.record_ref,
    target_ref: target.record_ref,
    scope,
    label,
    status: 'classified',
    confidence: confidence === null ? null : clampConfidence(confidence),
    confidence_basis: basis,
    layer,
    reasons,
    signals,
    edge,
    ledger_precondition: 'not_checked',
  };
}

function needsReview(
  source: RelationRecord,
  target: RelationRecord,
  scope: string,
  confidence: number | null,
  basis: RelationConfidenceBasis,
  layer: RelationDecisionLayer,
  reasons: readonly string[],
  signals: readonly string[],
): RelationDecision {
  return {
    source_ref: source.record_ref,
    target_ref: target.record_ref,
    scope,
    label: null,
    status: 'needs_review',
    confidence: confidence === null ? null : clampConfidence(confidence),
    confidence_basis: basis,
    layer,
    reasons,
    signals,
    edge: null,
    ledger_precondition: 'not_checked',
  };
}

function explicitRelationConflict(relation: RelationLabel, signals: PairSignals): string | null {
  if (relation === 'unrelated' && (signals.sameFact || signals.sameSymbol || signals.sameFile || signals.hasEdge)) {
    return 'explicit_unrelated_conflicts_with_shared_entity';
  }
  if (relation === 'continuation' && !signals.sameFact) {
    return 'explicit_continuation_requires_same_fact_key';
  }
  if (relation === 'cross_link' && signals.sameFact) {
    return 'explicit_cross_link_conflicts_with_same_fact_key';
  }
  return null;
}

/**
 * Rule + explicit-input classification for one pair. This function is pure and
 * synchronous; it never touches the ledger and never claims a precondition
 * passed. Low confidence, ambiguous lexical-only matches, conflicted/retracted/
 * superseded targets and explicit/rule contradictions all resolve to
 * `needs_review` rather than a fabricated label.
 */
export function classifyRelationPair(
  source: RelationRecord,
  target: RelationRecord,
  options: RelationClassifyOptions = {},
): RelationDecision {
  const scope = options.scope ?? source.scope;
  const threshold = options.low_confidence_threshold ?? DEFAULT_LOW_CONFIDENCE_THRESHOLD;
  const edges = options.edges ?? [];
  const signals = computePairSignals(source, target, edges);
  const names = signalNames(signals);
  const explicit = source.explicit;

  if (source.scope !== target.scope) {
    return needsReview(source, target, scope, null, 'unknown', 'rule', ['scope_mismatch'], names);
  }
  if (target.status === 'conflicted') {
    return needsReview(source, target, scope, null, 'rule_score', 'rule', ['target_conflicted'], names);
  }

  if (explicit?.relation !== undefined) {
    const conflict = explicitRelationConflict(explicit.relation, signals);
    if (conflict !== null) {
      return needsReview(source, target, scope, 0.5, 'explicit_input', 'explicit', [conflict], names);
    }
    const edge = explicit.relation === 'cross_link' ? explicit.edge ?? 'related_to' : null;
    return classified(
      source,
      target,
      scope,
      explicit.relation,
      0.95,
      'explicit_input',
      'explicit',
      [explicit.reason ?? `explicit_${explicit.relation}`],
      names,
      edge,
    );
  }

  if (explicit?.supersedes?.includes(target.record_ref) === true) {
    const reasons = [explicit.reason ?? 'explicit_supersedes'];
    return classified(source, target, scope, 'supersede_candidate', 0.92, 'explicit_input', 'explicit', reasons, names, null);
  }

  if (signals.sameFact) {
    if (target.status === 'retracted') {
      return needsReview(source, target, scope, 0.4, 'rule_score', 'rule', ['target_retracted'], names);
    }
    if (target.status === 'superseded') {
      return needsReview(source, target, scope, 0.4, 'rule_score', 'rule', ['target_superseded'], names);
    }
    if (
      signals.lexical >= HEURISTIC_SUPERSEDE_THRESHOLD
      && source.status === 'proposed'
      && target.status === 'active'
      && source.kind !== null
      && source.kind === target.kind
    ) {
      return classified(source, target, scope, 'supersede_candidate', 0.65, 'rule_score', 'rule', ['same_fact_high_overlap'], names, null);
    }
    const confidence = 0.7 + 0.25 * signals.lexical;
    if (confidence < threshold) {
      return needsReview(source, target, scope, confidence, 'rule_score', 'rule', ['low_confidence_same_fact'], names);
    }
    return classified(source, target, scope, 'continuation', confidence, 'rule_score', 'rule', ['same_fact_key'], names, null);
  }

  if (signals.sameSymbol || signals.sameFile || signals.hasEdge) {
    const confidence = 0.6 + 0.3 * signals.lexical
      + (signals.sameSymbol ? 0.1 : 0)
      + (signals.hasEdge ? 0.1 : 0);
    if (confidence < threshold) {
      return needsReview(source, target, scope, confidence, 'rule_score', 'rule', ['low_confidence_cross_link'], names);
    }
    return classified(source, target, scope, 'cross_link', confidence, 'rule_score', 'rule', ['shared_entity'], names, null);
  }

  if (signals.lexical >= LEXICAL_STRONG_THRESHOLD) {
    const confidence = 0.5 + 0.4 * signals.lexical;
    if (confidence < threshold) {
      return needsReview(source, target, scope, confidence, 'rule_score', 'rule', ['low_confidence_lexical'], names);
    }
    return classified(source, target, scope, 'cross_link', confidence, 'rule_score', 'rule', ['lexical_overlap'], names, null);
  }

  if (signals.lexical >= LEXICAL_RELATION_THRESHOLD) {
    return needsReview(source, target, scope, 0.5 + 0.4 * signals.lexical, 'rule_score', 'rule', ['ambiguous_lexical_only'], names);
  }

  const confidence = 0.95 - 0.6 * signals.lexical;
  if (confidence < threshold) {
    return needsReview(source, target, scope, confidence, 'rule_score', 'rule', ['low_confidence_unrelated'], names);
  }
  return classified(source, target, scope, 'unrelated', confidence, 'rule_score', 'rule', ['no_shared_signal'], names, null);
}

// ---------------------------------------------------------------------------
// Model layer (injectable, bounded)
// ---------------------------------------------------------------------------

export interface RelationModelCandidate {
  readonly source: RelationRecord;
  readonly target: RelationRecord;
  readonly rule: RelationDecision;
  readonly scope: string;
}

export interface RelationModelDecision {
  /** Null means the model cannot confirm a label. */
  readonly label: RelationLabel | null;
  readonly confidence: number | null;
  readonly reason?: string;
}

/**
 * Replaceable adapter. The classifier only ever feeds it the bounded candidate
 * slice from `selectRelationCandidates`; the model cannot widen the scope.
 */
export interface RelationModelAdapter {
  readonly name: string;
  classify(candidate: RelationModelCandidate): RelationModelDecision | Promise<RelationModelDecision>;
}

/**
 * Merge a model decision over the deterministic rule baseline. A confident
 * model label overrides the rule label; a null or low-confidence model decision
 * never fabricates certainty, so it either abstains or falls back to the rule.
 */
export function mergeRelationModelDecision(
  rule: RelationDecision,
  model: RelationModelDecision,
  threshold: number = DEFAULT_MODEL_CONFIDENCE_THRESHOLD,
): RelationDecision {
  if (model.label === null) {
    return {
      ...rule,
      label: null,
      status: 'needs_review',
      layer: 'model',
      reasons: [...rule.reasons, model.reason ?? 'model_unconfirmed'],
    };
  }
  if (model.confidence !== null && model.confidence >= threshold) {
    return {
      ...rule,
      label: model.label,
      status: 'classified',
      confidence: model.confidence,
      confidence_basis: 'model',
      layer: 'model',
      reasons: [...rule.reasons, model.reason ?? 'model_override'],
    };
  }
  return { ...rule, reasons: [...rule.reasons, 'model_low_confidence'] };
}

export interface RelationClassifyResult {
  readonly source: RelationRecord;
  readonly scope: string;
  readonly selection: RelationCandidateSelection;
  readonly rule_decisions: readonly RelationDecision[];
  readonly model_decisions: readonly RelationDecision[];
  readonly decisions: readonly RelationDecision[];
  readonly model_comparisons: number;
  readonly model: string | null;
}

/**
 * Full bounded run: coarse screen, rule classification for every selected
 * candidate, and model comparison for at most `max_model_comparisons` of them.
 * Candidates beyond the model slice keep their rule decision.
 */
export async function classifyRelation(
  source: RelationRecord,
  index: RelationIndex,
  options: RelationClassifyOptions = {},
): Promise<RelationClassifyResult> {
  const scope = options.scope ?? source.scope;
  const budget = resolveBudget(options.budget);
  const edges = options.edges ?? index.edges;
  const selection = selectRelationCandidates(source, index, budget);
  const ruleDecisions = selection.candidates.map((target) => classifyRelationPair(source, target, {
    scope,
    edges,
    ...(options.low_confidence_threshold !== undefined
      ? { low_confidence_threshold: options.low_confidence_threshold }
      : {}),
  }));

  const modelDecisions: RelationDecision[] = [];
  if (options.model !== undefined) {
    const limit = Math.min(selection.candidates.length, budget.max_model_comparisons);
    for (let index_ = 0; index_ < limit; index_ += 1) {
      const target = selection.candidates[index_]!;
      const rule = ruleDecisions[index_]!;
      const modelDecision = await options.model.classify({ source, target, rule, scope });
      modelDecisions.push(mergeRelationModelDecision(rule, modelDecision, DEFAULT_MODEL_CONFIDENCE_THRESHOLD));
    }
  }

  const decisions = ruleDecisions.map((rule, position) => modelDecisions[position] ?? rule);
  return {
    source,
    scope,
    selection,
    rule_decisions: ruleDecisions,
    model_decisions: modelDecisions,
    decisions,
    model_comparisons: modelDecisions.length,
    model: options.model?.name ?? null,
  };
}

// ---------------------------------------------------------------------------
// Proposal (never a submission)
// ---------------------------------------------------------------------------

export interface RelationProposal {
  readonly kind: 'memory.revised' | 'memory.related';
  readonly label: RelationLabel;
  readonly from_ref: string;
  readonly to_ref: string;
  readonly edge: RelationEdgeKind | null;
  readonly supersedes: readonly string[];
  readonly reason: string;
  readonly status: 'proposal_only';
  readonly auto_submit: false;
  readonly requires_explicit_actor: true;
  /** Always `not_checked`: submission still has to pass the Ledger precondition. */
  readonly ledger_precondition: 'not_checked';
  readonly note: string;
}

/**
 * Build a write proposal from a decision. `unrelated` and `needs_review`
 * decisions produce no proposal. Every proposal is explicitly non-submitting:
 * `supersede_candidate` still requires the Ledger deterministic precondition
 * check and an explicit actor (ADR-005 §6/§7).
 */
export function buildRelationProposal(decision: RelationDecision): RelationProposal | null {
  if (decision.status !== 'classified' || decision.label === null || decision.label === 'unrelated') return null;
  const reason = decision.reasons.length > 0 ? decision.reasons.join('; ') : 'relation proposed by classifier';
  const base = {
    label: decision.label,
    from_ref: decision.source_ref,
    to_ref: decision.target_ref,
    status: 'proposal_only' as const,
    auto_submit: false as const,
    requires_explicit_actor: true as const,
    ledger_precondition: 'not_checked' as const,
    note: 'ADR-005 §6: classifier output is a proposal only; submission requires an explicit actor and the Ledger deterministic precondition check.',
  };
  if (decision.label === 'supersede_candidate') {
    return { ...base, kind: 'memory.revised', edge: null, supersedes: [decision.target_ref], reason };
  }
  return { ...base, kind: 'memory.related', edge: decision.edge ?? 'related_to', supersedes: [], reason };
}

// ---------------------------------------------------------------------------
// 2-bit label encoding (transport convenience, NOT inference evidence)
// ---------------------------------------------------------------------------

const LABEL_TO_CODE: Readonly<Record<RelationLabel, number>> = {
  unrelated: 0,
  continuation: 1,
  cross_link: 2,
  supersede_candidate: 3,
};

const CODE_TO_LABEL: Readonly<Record<number, RelationLabel>> = {
  0: 'unrelated',
  1: 'continuation',
  2: 'cross_link',
  3: 'supersede_candidate',
};

/**
 * Compact 2-bit encoding for storage/transport. This is a representation choice
 * only; it is NOT evidence of any inference or reasoning optimization
 * (docs/anchor-probe-integration.md §9.1). Do not cite it as a performance or
 * reasoning result.
 */
export function encodeRelationLabel(label: RelationLabel): number {
  return LABEL_TO_CODE[label];
}

/** Inverse of `encodeRelationLabel`; null for a code outside the 2-bit range. */
export function decodeRelationLabel(code: number): RelationLabel | null {
  if (!Number.isInteger(code) || code < 0 || code > 3) return null;
  return CODE_TO_LABEL[code] ?? null;
}

// ---------------------------------------------------------------------------
// Calibration report
// ---------------------------------------------------------------------------

export interface RelationCalibrationCase {
  readonly id: string;
  readonly source: RelationRecord;
  readonly target: RelationRecord;
  /** Human/synthetic ground truth; `needs_review` is a valid truth. */
  readonly expected: RelationLabel | 'needs_review';
  readonly edges?: readonly RelationEdge[];
}

export interface RelationCalibrationDataset {
  readonly name: string;
  readonly cases: readonly RelationCalibrationCase[];
}

export interface RelationConfidenceBucket {
  readonly lower: number;
  readonly upper: number;
  readonly count: number;
  readonly correct: number;
  readonly accuracy: number | null;
  readonly average_confidence: number | null;
}

export interface RelationErrorExample {
  readonly case_id: string;
  readonly expected: string;
  readonly predicted: string;
  readonly confidence: number | null;
  readonly kind: RelationErrorKind;
}

export interface RelationLayerMetrics {
  readonly layer: 'rule' | 'model';
  readonly evaluated: number;
  /** Definitive predictions that matched the truth. */
  readonly correct: number;
  /** Predictions that produced a label (including `unrelated`). */
  readonly definitive: number;
  /** Predictions that deliberately abstained. */
  readonly needs_review: number;
  readonly abstention_rate: number | null;
  /** `correct / definitive`; null when nothing definitive was predicted. */
  readonly accuracy: number | null;
  /** Predicted supersede, truth was not supersede (would wrongly replace). */
  readonly false_supersede: number;
  /** Truth was a relation, predicted unrelated (relation suppressed). */
  readonly missed_relation: number;
  /** Predicted a relation, truth was unrelated (relation invented). */
  readonly wrong_pass: number;
  /** Predicted unrelated, truth was supersede_candidate (replacement suppressed). */
  readonly wrong_block: number;
  /** Truth was needs_review but a definitive label was fabricated. */
  readonly overconfident_definitive: number;
  readonly by_label: Readonly<Record<RelationLabel, number>>;
  readonly by_truth: Readonly<Record<string, number>>;
  readonly confusion: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly calibration: readonly RelationConfidenceBucket[];
  readonly examples: readonly RelationErrorExample[];
}

export interface RelationCalibrationReport {
  readonly schema_version: typeof RELATION_CALIBRATION_SCHEMA_VERSION;
  readonly generated_at: string;
  readonly dataset: { readonly name: string; readonly size: number };
  readonly rule_layer: RelationLayerMetrics;
  readonly model_layer: RelationLayerMetrics | null;
  readonly model: { readonly name: string; readonly comparisons: number } | null;
  readonly budget: RelationCandidateBudget;
  readonly encoding: { readonly bits: 2; readonly experimental: true; readonly inference_evidence: false };
  readonly notes: readonly string[];
}

export interface RelationCalibrationOptions {
  readonly model?: RelationModelAdapter;
  readonly low_confidence_threshold?: number;
  readonly now?: string;
}

interface LayerEntry {
  readonly caseId: string;
  readonly expected: RelationLabel | 'needs_review';
  readonly decision: RelationDecision;
}

const CONFIDENCE_BUCKETS: readonly { lower: number; upper: number }[] = [
  { lower: 0, upper: 0.5 },
  { lower: 0.5, upper: 0.7 },
  { lower: 0.7, upper: 0.9 },
  { lower: 0.9, upper: 1.0 },
];

function bucketIndexFor(confidence: number): number {
  if (confidence < 0.5) return 0;
  if (confidence < 0.7) return 1;
  if (confidence < 0.9) return 2;
  return 3;
}

function buildLayerMetrics(layer: 'rule' | 'model', entries: readonly LayerEntry[]): RelationLayerMetrics {
  const byLabel: Record<RelationLabel, number> = { unrelated: 0, continuation: 0, cross_link: 0, supersede_candidate: 0 };
  const byTruth: Record<string, number> = {};
  const confusion: Record<string, Record<string, number>> = {};
  const examples: RelationErrorExample[] = [];
  const bucketPredictions: number[][] = CONFIDENCE_BUCKETS.map(() => []);
  const bucketCorrect: number[] = CONFIDENCE_BUCKETS.map(() => 0);
  let correct = 0;
  let definitive = 0;
  let needsReview = 0;
  let falseSupersede = 0;
  let missedRelation = 0;
  let wrongPass = 0;
  let wrongBlock = 0;
  let overconfident = 0;

  const pushExample = (entry: LayerEntry, kind: RelationErrorKind, predicted: string): void => {
    if (examples.length >= MAX_REPORT_EXAMPLES) return;
    examples.push({
      case_id: entry.caseId,
      expected: entry.expected,
      predicted,
      confidence: entry.decision.confidence,
      kind,
    });
  };

  for (const entry of entries) {
    const truth = entry.expected;
    const decision = entry.decision;
    const predicted = decision.label ?? 'needs_review';
    byTruth[truth] = (byTruth[truth] ?? 0) + 1;
    const truthRow = confusion[truth] ?? {};
    truthRow[predicted] = (truthRow[predicted] ?? 0) + 1;
    confusion[truth] = truthRow;

    if (decision.label === null) {
      needsReview += 1;
      continue;
    }

    definitive += 1;
    byLabel[decision.label] += 1;
    const isCorrect = decision.label === truth;
    if (isCorrect) correct += 1;

    if (truth === 'needs_review') {
      overconfident += 1;
      pushExample(entry, 'overconfident_definitive', predicted);
    } else if (decision.label === 'supersede_candidate' && truth !== 'supersede_candidate') {
      falseSupersede += 1;
      pushExample(entry, 'false_supersede', predicted);
    } else if (decision.label === 'unrelated' && truth !== 'unrelated') {
      missedRelation += 1;
      if (truth === 'supersede_candidate') {
        wrongBlock += 1;
        pushExample(entry, 'wrong_block', predicted);
      } else {
        pushExample(entry, 'missed_relation', predicted);
      }
    } else if (decision.label !== 'unrelated' && truth === 'unrelated') {
      wrongPass += 1;
      pushExample(entry, 'wrong_pass', predicted);
    }

    if (decision.confidence !== null) {
      const bucket = bucketIndexFor(decision.confidence);
      bucketPredictions[bucket]!.push(decision.confidence);
      if (isCorrect) bucketCorrect[bucket]! += 1;
    }
  }

  const calibration: RelationConfidenceBucket[] = CONFIDENCE_BUCKETS.map((bounds, index) => {
    const predictions = bucketPredictions[index]!;
    const count = predictions.length;
    const correctInBucket = bucketCorrect[index]!;
    const sum = predictions.reduce((total, value) => total + value, 0);
    return {
      lower: bounds.lower,
      upper: bounds.upper,
      count,
      correct: correctInBucket,
      accuracy: count > 0 ? correctInBucket / count : null,
      average_confidence: count > 0 ? sum / count : null,
    };
  });

  return {
    layer,
    evaluated: entries.length,
    correct,
    definitive,
    needs_review: needsReview,
    abstention_rate: entries.length > 0 ? needsReview / entries.length : null,
    accuracy: definitive > 0 ? correct / definitive : null,
    false_supersede: falseSupersede,
    missed_relation: missedRelation,
    wrong_pass: wrongPass,
    wrong_block: wrongBlock,
    overconfident_definitive: overconfident,
    by_label: byLabel,
    by_truth: byTruth,
    confusion,
    calibration,
    examples,
  };
}

/**
 * Evaluate a labeled dataset through the rule layer and (optionally) the model
 * layer, reporting each layer separately. The dataset is synthetic calibration
 * material, not a performance claim.
 */
export async function evaluateRelationCalibration(
  dataset: RelationCalibrationDataset,
  options: RelationCalibrationOptions = {},
): Promise<RelationCalibrationReport> {
  const threshold = options.low_confidence_threshold ?? DEFAULT_LOW_CONFIDENCE_THRESHOLD;
  const ruleEntries: LayerEntry[] = [];
  const modelEntries: LayerEntry[] = [];

  for (const item of dataset.cases) {
    const rule = classifyRelationPair(item.source, item.target, {
      scope: item.source.scope,
      edges: item.edges ?? [],
      low_confidence_threshold: threshold,
    });
    ruleEntries.push({ caseId: item.id, expected: item.expected, decision: rule });
    if (options.model !== undefined) {
      const modelDecision = await options.model.classify({
        source: item.source,
        target: item.target,
        rule,
        scope: item.source.scope,
      });
      modelEntries.push({
        caseId: item.id,
        expected: item.expected,
        decision: mergeRelationModelDecision(rule, modelDecision, DEFAULT_MODEL_CONFIDENCE_THRESHOLD),
      });
    }
  }

  const modelLayer = options.model !== undefined
    ? buildLayerMetrics('model', modelEntries)
    : null;

  return {
    schema_version: RELATION_CALIBRATION_SCHEMA_VERSION,
    generated_at: options.now ?? new Date().toISOString(),
    dataset: { name: dataset.name, size: dataset.cases.length },
    rule_layer: buildLayerMetrics('rule', ruleEntries),
    model_layer: modelLayer,
    model: options.model !== undefined ? { name: options.model.name, comparisons: modelEntries.length } : null,
    budget: resolveBudget(),
    encoding: { bits: 2, experimental: true, inference_evidence: false },
    notes: [
      'Labels are proposals only; supersede_candidate still requires the Ledger deterministic precondition check (ADR-005 §6/§7).',
      'The classifier never evaluates or claims Ledger preconditions; ledger_precondition is always not_checked.',
      'Unconfirmed pairs are reported as needs_review; no definitive label is fabricated.',
      'Rule and model layers are reported separately; model_layer is null when no adapter is injected.',
      '2-bit label encoding is a storage/transport convenience only and is NOT evidence of inference optimization (docs/anchor-probe-integration.md §9.1).',
      'Dataset is synthetic calibration material; these metrics are not performance or accuracy claims about any real model.',
    ],
  };
}
