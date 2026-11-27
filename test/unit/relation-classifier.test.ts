import assert from 'node:assert/strict';
import fs from 'node:fs';
import test, { describe } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ulid } from '../../src/core/ulid.ts';
import { canonicalJson, genesisHash, hashEvent, type LedgerEvent } from '../../src/ledger/event.ts';
import {
  assertMemoryAppendPreconditions,
  deriveMemoryProjection,
  MemoryPreconditionError,
} from '../../src/ledger/ledger.ts';
import {
  RELATION_CALIBRATION_SCHEMA_VERSION,
  buildRelationProposal,
  classifyRelation,
  classifyRelationPair,
  decodeRelationLabel,
  defaultRelationCandidateBudget,
  encodeRelationLabel,
  evaluateRelationCalibration,
  mergeRelationModelDecision,
  relationIndexFromEntries,
  relationIndexFromSource,
  relationLabels,
  selectRelationCandidates,
  type RelationCalibrationCase,
  type RelationCalibrationDataset,
  type RelationDecision,
  type RelationEdge,
  type RelationIndexSource,
  type RelationLabel,
  type RelationModelAdapter,
  type RelationModelCandidate,
  type RelationModelDecision,
  type RelationRecord,
} from '../../src/memory/relation-classifier.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function record(ref: string, overrides: Partial<RelationRecord> = {}): RelationRecord {
  return {
    record_ref: ref,
    scope: 'proj-a',
    fact_key: 'local.storage.engine',
    kind: 'decision',
    text: 'Use SQLite for the local ledger store.',
    symbol: 'localLedger',
    file: 'src/ledger/ledger.ts',
    status: 'proposed',
    eligibility: 'governed',
    recorded_at: '2026-11-22T00:00:00.000Z',
    effective_from: null,
    effective_to: null,
    ...overrides,
  };
}

function envelope(id: string, kind: LedgerEvent['kind'], payload: Record<string, unknown>, prevHash = genesisHash, physical = 1000, actor = 'A', idemKey?: string): LedgerEvent {
  return { id, hlc: { physical, logical: 0, actor }, actor, kind, payload, prev_hash: prevHash, ...(idemKey ? { idem_key: idemKey } : {}) };
}

function spyModel(name: string, decide: (candidate: RelationModelCandidate) => RelationModelDecision): { adapter: RelationModelAdapter; seen: readonly string[] } {
  const seen: string[] = [];
  return {
    seen,
    adapter: {
      name,
      classify: (candidate: RelationModelCandidate): RelationModelDecision => {
        seen.push(candidate.target.record_ref);
        return decide(candidate);
      },
    },
  };
}

interface RawFixture {
  name: string;
  cases: Array<{
    id: string;
    expected: string;
    source: RelationRecord;
    target: RelationRecord;
    edges?: RelationEdge[];
  }>;
}

function isRelationExpected(value: string): value is RelationLabel | 'needs_review' {
  return value === 'needs_review' || (relationLabels as readonly string[]).includes(value);
}

function loadDataset(): RelationCalibrationDataset {
  const path = fileURLToPath(new URL('../fixtures/anchor-probe-relations.json', import.meta.url));
  const raw = JSON.parse(fs.readFileSync(path, 'utf8')) as RawFixture;
  const cases: RelationCalibrationCase[] = [];
  for (const item of raw.cases) {
    if (!isRelationExpected(item.expected)) throw new Error(`fixture case ${item.id} has unknown expected label ${item.expected}`);
    if (item.source.record_ref === item.target.record_ref) throw new Error(`fixture case ${item.id} relates a record to itself`);
    cases.push({
      id: item.id,
      expected: item.expected,
      source: item.source,
      target: item.target,
      ...(item.edges !== undefined ? { edges: item.edges } : {}),
    });
  }
  return { name: raw.name, cases };
}

// ---------------------------------------------------------------------------
// Vocabulary and 2-bit encoding
// ---------------------------------------------------------------------------

describe('relation vocabulary and 2-bit encoding', () => {
  test('the label vocabulary is exactly the four AP-21 labels', () => {
    assert.deepEqual([...relationLabels], ['unrelated', 'continuation', 'cross_link', 'supersede_candidate']);
  });

  test('2-bit encoding round-trips every label and rejects out-of-range codes', () => {
    const expected: Record<string, number> = {
      unrelated: 0,
      continuation: 1,
      cross_link: 2,
      supersede_candidate: 3,
    };
    for (const label of relationLabels) {
      const code = encodeRelationLabel(label);
      assert.equal(code, expected[label]);
      assert.equal(decodeRelationLabel(code), label);
    }
    assert.equal(decodeRelationLabel(4), null);
    assert.equal(decodeRelationLabel(-1), null);
    assert.equal(decodeRelationLabel(1.5), null);
  });
});

// ---------------------------------------------------------------------------
// Bounded candidate selection
// ---------------------------------------------------------------------------

describe('bounded candidate selection', () => {
  test('scope filtering and every budget ceiling are enforced', () => {
    const source = record(ulid());
    const entries: RelationRecord[] = [];
    for (let index = 0; index < 40; index += 1) {
      entries.push(record(ulid(), { fact_key: 'local.storage.engine', text: 'shared ledger engine text' }));
    }
    for (let index = 0; index < 10; index += 1) {
      entries.push(record(ulid(), { scope: 'proj-b', fact_key: 'local.storage.engine', text: 'shared ledger engine text' }));
    }

    const selection = selectRelationCandidates(source, relationIndexFromEntries(entries), {
      max_candidates: 5,
      max_per_fact_key: 2,
      max_lexical_matches: 3,
      max_model_comparisons: 2,
    });

    assert.equal(selection.candidates.length <= 5, true);
    assert.equal(selection.candidates.length, 2, 'the per-fact ceiling binds before the global ceiling');
    assert.equal(selection.scope_excluded, 10);
    assert.equal(selection.self_excluded, 0);
    assert.equal(selection.candidates.every((candidate) => candidate.scope === 'proj-a'), true);
    assert.equal(selection.candidates.some((candidate) => candidate.record_ref === source.record_ref), false);
    assert.equal(selection.truncated, true);
  });

  test('lexical-only matches are capped separately from entity matches', () => {
    const source = record(ulid(), { fact_key: 'local.ui.theme', text: 'alpha beta gamma delta' });
    const entries: RelationRecord[] = [];
    for (let index = 0; index < 10; index += 1) {
      entries.push(record(ulid(), {
        fact_key: `local.other.${index}`,
        text: 'alpha beta gamma epsilon',
        symbol: null,
        file: null,
      }));
    }
    const selection = selectRelationCandidates(source, relationIndexFromEntries(entries), {
      max_candidates: 16,
      max_per_fact_key: 4,
      max_lexical_matches: 3,
      max_model_comparisons: 8,
    });
    assert.equal(selection.lexical_only, 10);
    assert.equal(selection.candidates.length, 3);
    assert.equal(selection.truncated, true);
  });

  test('relationIndexFromSource adapts a probe-like source and stamps the scope', () => {
    const probeLike: RelationIndexSource = {
      entries: () => [record(ulid(), { scope: '' }), record(ulid(), { scope: '' })],
      edges: () => [],
    };
    const index = relationIndexFromSource(probeLike, 'proj-a');
    assert.equal(index.entries.length, 2);
    assert.equal(index.entries.every((entry) => entry.scope === 'proj-a'), true);
  });
});

// ---------------------------------------------------------------------------
// Rule layer classification
// ---------------------------------------------------------------------------

describe('rule layer classification', () => {
  const source = record('01AAAAAAAAAAAAAAAAAAAAAAAA');
  const target = record('01BBBBBBBBBBBBBBBBBBBBBBBB', { status: 'active' });

  test('same fact key with moderate overlap is continuation', () => {
    const continuationSource = record(source.record_ref, { text: 'Use SQLite for the local ledger store; it is deterministic and file-based.' });
    const continuationTarget = record(target.record_ref, { text: 'Use SQLite for the local ledger store.', status: 'active' });
    const decision = classifyRelationPair(continuationSource, continuationTarget);
    assert.equal(decision.label, 'continuation');
    assert.equal(decision.status, 'classified');
    assert.equal(decision.layer, 'rule');
    assert.equal(decision.ledger_precondition, 'not_checked');
    assert.equal(decision.confidence !== null && decision.confidence > 0.5, true);
  });

  test('explicit supersedes is a proposal, not an approval', () => {
    const proposing = record(source.record_ref, {
      explicit: { supersedes: [target.record_ref], reason: 'replace with the FTS5 version' },
    });
    const decision = classifyRelationPair(proposing, target);
    assert.equal(decision.label, 'supersede_candidate');
    assert.equal(decision.layer, 'explicit');
    assert.equal(decision.ledger_precondition, 'not_checked');

    const proposal = buildRelationProposal(decision);
    assert.ok(proposal);
    assert.equal(proposal.kind, 'memory.revised');
    assert.equal(proposal.status, 'proposal_only');
    assert.equal(proposal.auto_submit, false);
    assert.equal(proposal.requires_explicit_actor, true);
    assert.equal(proposal.ledger_precondition, 'not_checked');
    assert.deepEqual(proposal.supersedes, [target.record_ref]);
  });

  test('high same-fact overlap from a proposed record is a heuristic supersede candidate', () => {
    const proposing = record(source.record_ref, { text: 'Migrate the ledger store from JSON files to SQLite with FTS5.' });
    const head = record(target.record_ref, { text: 'Migrate the ledger store from JSON files to SQLite.', status: 'active' });
    const decision = classifyRelationPair(proposing, head);
    assert.equal(decision.label, 'supersede_candidate');
    assert.equal(decision.layer, 'rule');
    assert.equal(decision.confidence_basis, 'rule_score');
  });

  test('shared symbol across different facts is cross_link', () => {
    const crossSource = record(source.record_ref, { fact_key: 'local.cache.policy', symbol: 'cachePolicy' });
    const crossTarget = record(target.record_ref, { fact_key: 'local.storage.engine', symbol: 'cachePolicy', status: 'active' });
    const decision = classifyRelationPair(crossSource, crossTarget);
    assert.equal(decision.label, 'cross_link');
    const proposal = buildRelationProposal(decision);
    assert.ok(proposal);
    assert.equal(proposal.kind, 'memory.related');
    assert.equal(proposal.edge, 'related_to');
    assert.equal(proposal.ledger_precondition, 'not_checked');
  });

  test('an indexed edge is a cross_link even without lexical overlap', () => {
    const edgeSource = record(source.record_ref, { fact_key: 'local.deploy.target', symbol: 'deployTarget', text: 'Deploy target is the staging directory.' });
    const edgeTarget = record(target.record_ref, { fact_key: 'local.storage.engine', symbol: 'ledgerStore', text: 'The ledger store is a single SQLite file.', status: 'active' });
    const edges: RelationEdge[] = [{ from_ref: edgeSource.record_ref, to_ref: edgeTarget.record_ref, kind: 'related_to' }];
    const decision = classifyRelationPair(edgeSource, edgeTarget, { edges });
    assert.equal(decision.label, 'cross_link');
    assert.equal(decision.signals.includes('indexed_edge'), true);
  });

  test('disjoint records are unrelated', () => {
    const disjointSource = record(source.record_ref, { fact_key: 'local.ui.theme', symbol: 'theme', file: 'src/ui/theme.ts', text: 'The interface uses a high-contrast palette.' });
    const disjointTarget = record(target.record_ref, { fact_key: 'local.network.proxy', symbol: 'proxy', file: 'src/net/proxy.ts', text: 'The proxy must not rewrite request bodies.', status: 'active' });
    const decision = classifyRelationPair(disjointSource, disjointTarget);
    assert.equal(decision.label, 'unrelated');
    assert.equal(buildRelationProposal(decision), null);
  });

  test('explicit cross_link carries the declared edge kind', () => {
    const explicitSource = record(source.record_ref, {
      fact_key: 'local.deploy.target',
      explicit: { relation: 'cross_link', edge: 'depends_on', reason: 'deployment depends on the ledger store' },
    });
    const decision = classifyRelationPair(explicitSource, target);
    assert.equal(decision.label, 'cross_link');
    assert.equal(decision.edge, 'depends_on');
    const proposal = buildRelationProposal(decision);
    assert.ok(proposal);
    assert.equal(proposal.edge, 'depends_on');
  });

  test('conflicted, retracted and superseded targets stay needs_review', () => {
    for (const status of ['conflicted', 'retracted', 'superseded'] as const) {
      const decision = classifyRelationPair(source, record(target.record_ref, { status }));
      assert.equal(decision.status, 'needs_review', status);
      assert.equal(decision.label, null, status);
      assert.equal(buildRelationProposal(decision), null);
    }
  });

  test('explicit input that contradicts the signals is retained as needs_review', () => {
    const conflicting = record(source.record_ref, { explicit: { relation: 'unrelated', reason: 'caller says unrelated' } });
    const decision = classifyRelationPair(conflicting, target);
    assert.equal(decision.status, 'needs_review');
    assert.equal(decision.label, null);
    assert.equal(decision.reasons.some((reason) => reason.includes('explicit_unrelated_conflicts')), true);
  });

  test('cross-scope pairs are needs_review and never classified', () => {
    const otherScope = record(target.record_ref, { scope: 'proj-b', status: 'active' });
    const decision = classifyRelationPair(source, otherScope);
    assert.equal(decision.status, 'needs_review');
    assert.equal(decision.reasons.includes('scope_mismatch'), true);
  });

  test('ambiguous lexical-only overlap stays needs_review instead of inventing a label', () => {
    const ambiguousSource = record(source.record_ref, { fact_key: 'local.ui.theme', symbol: 'theme', file: 'src/ui/theme.ts', text: 'alpha beta gamma' });
    const ambiguousTarget = record(target.record_ref, { fact_key: 'local.storage.engine', symbol: 'ledgerStore', file: 'src/ledger/ledger.ts', text: 'alpha beta delta', status: 'active' });
    const decision = classifyRelationPair(ambiguousSource, ambiguousTarget);
    assert.equal(decision.status, 'needs_review');
    assert.equal(decision.label, null);
    assert.equal(decision.reasons.includes('ambiguous_lexical_only'), true);
  });
});

// ---------------------------------------------------------------------------
// Ledger precondition is not bypassed
// ---------------------------------------------------------------------------

describe('supersede_candidate still requires the Ledger deterministic precondition', () => {
  const FACT = 'local.storage.engine';
  const GENESIS = '01AAAAAAAAAAAAAAAAAAAAAAAA';
  const HEAD = '01BBBBBBBBBBBBBBBBBBBBBBBB';

  function ledgerState(): ReturnType<typeof deriveMemoryProjection> {
    const genesisPayload: Record<string, unknown> = {
      intent: 'revise',
      fact_key: FACT,
      record: { text: 'v1 sqlite ledger', kind: 'decision' },
      supersedes: [],
      reason: 'genesis',
      effective_from: null,
      effective_to: null,
    };
    const headPayload: Record<string, unknown> = {
      intent: 'revise',
      fact_key: FACT,
      record: { text: 'v2 sqlite ledger with fts5', kind: 'decision' },
      supersedes: [GENESIS],
      reason: 'linear revision',
      effective_from: null,
      effective_to: null,
    };
    const genesisEvent = envelope(GENESIS, 'memory.revised', genesisPayload, genesisHash, 1000, 'A', 'idem-genesis');
    const headEvent = envelope(HEAD, 'memory.revised', headPayload, hashEvent(genesisEvent), 2000, 'A', 'idem-head');
    return deriveMemoryProjection([
      { event: genesisEvent, segment: 'fixture.jsonl' },
      { event: headEvent, segment: 'fixture.jsonl' },
    ]);
  }

  test('the classifier never reports a precondition as passed, and the real check still rejects a stale prior', () => {
    const state = ledgerState();
    const source = record(GENESIS, { explicit: { supersedes: [GENESIS], reason: 'replace' } });
    const target = record(GENESIS, { status: 'active' });
    const decision = classifyRelationPair(source, target);
    assert.equal(decision.label, 'supersede_candidate');
    assert.equal(decision.ledger_precondition, 'not_checked');

    const proposal = buildRelationProposal(decision);
    assert.ok(proposal);
    assert.equal(proposal.ledger_precondition, 'not_checked');
    assert.equal(proposal.auto_submit, false);
    assert.equal(proposal.requires_explicit_actor, true);

    const proposedPayload: Record<string, unknown> = {
      intent: 'revise',
      fact_key: FACT,
      record: { text: 'v3 proposed replacement', kind: 'decision' },
      supersedes: proposal.supersedes,
      reason: 'classifier proposal',
      effective_from: null,
      effective_to: null,
    };
    // The proposal names a stale prior (the genesis record, no longer head), so
    // the deterministic Ledger check rejects it. The classifier cannot bypass.
    assert.throws(
      () => assertMemoryAppendPreconditions(state, 'memory.revised', proposedPayload),
      (error: unknown) => {
        assert.ok(error instanceof MemoryPreconditionError);
        assert.match(error.message, /stale prior|current head/u);
        return true;
      },
    );

    // Naming the actual head passes the same check, proving the gate is real and
    // is the only path from proposal to submission.
    assert.doesNotThrow(() => assertMemoryAppendPreconditions(state, 'memory.revised', {
      ...proposedPayload,
      supersedes: [HEAD],
    }));
  });

  test('no fixture-driven decision claims a ledger precondition passed', async () => {
    const dataset = loadDataset();
    const report = await evaluateRelationCalibration(dataset, { now: '2026-11-22T00:00:00.000Z' });
    for (const item of dataset.cases) {
      const decision = classifyRelationPair(item.source, item.target, { edges: item.edges ?? [] });
      assert.equal(decision.ledger_precondition, 'not_checked', item.id);
    }
    assert.equal(report.rule_layer.evaluated, dataset.cases.length);
  });
});

// ---------------------------------------------------------------------------
// Model layer
// ---------------------------------------------------------------------------

describe('injectable model layer', () => {
  test('the model only sees the bounded candidate slice', async () => {
    const source = record(ulid());
    const entries: RelationRecord[] = [];
    for (let index = 0; index < 20; index += 1) {
      entries.push(record(ulid(), { fact_key: 'local.storage.engine', text: 'shared ledger engine text' }));
    }
    const spy = spyModel('bounded-spy', ({ rule }) => ({ label: rule.label, confidence: 0.8 }));
    const result = await classifyRelation(source, relationIndexFromEntries(entries), {
      budget: { max_candidates: 16, max_per_fact_key: 20, max_model_comparisons: 8 },
      model: spy.adapter,
    });
    assert.equal(result.selection.candidates.length, 16);
    assert.equal(result.model_comparisons, 8);
    assert.equal(spy.seen.length, 8);
    assert.equal(result.model_decisions.length, 8);
    assert.equal(result.decisions.length, 16);
    assert.equal(result.model, 'bounded-spy');
  });

  test('a confident model label overrides the rule label', () => {
    const rule: RelationDecision = {
      source_ref: 's',
      target_ref: 't',
      scope: 'proj-a',
      label: 'continuation',
      status: 'classified',
      confidence: 0.8,
      confidence_basis: 'rule_score',
      layer: 'rule',
      reasons: ['same_fact_key'],
      signals: ['same_fact_key'],
      edge: null,
      ledger_precondition: 'not_checked',
    };
    const merged = mergeRelationModelDecision(rule, { label: 'cross_link', confidence: 0.9, reason: 'model_override' });
    assert.equal(merged.label, 'cross_link');
    assert.equal(merged.confidence_basis, 'model');
    assert.equal(merged.layer, 'model');
    assert.equal(merged.ledger_precondition, 'not_checked');
  });

  test('a null or low-confidence model decision never fabricates certainty', () => {
    const rule = classifyRelationPair(record('01AAAAAAAAAAAAAAAAAAAAAAAA'), record('01BBBBBBBBBBBBBBBBBBBBBBBB', { status: 'active' }));
    const abstained = mergeRelationModelDecision(rule, { label: null, confidence: null, reason: 'model_unconfirmed' });
    assert.equal(abstained.status, 'needs_review');
    assert.equal(abstained.label, null);
    const lowConfidence = mergeRelationModelDecision(rule, { label: 'cross_link', confidence: 0.2 });
    assert.equal(lowConfidence.label, rule.label);
    assert.equal(lowConfidence.layer, 'rule');
    assert.equal(lowConfidence.reasons.includes('model_low_confidence'), true);
  });
});

// ---------------------------------------------------------------------------
// Calibration report
// ---------------------------------------------------------------------------

describe('calibration report', () => {
  const imperfectModel: RelationModelAdapter = {
    name: 'fixture-imperfect-model',
    classify: ({ source, target, rule }: RelationModelCandidate): RelationModelDecision => {
      if (source.explicit?.supersedes?.includes(target.record_ref) === true) {
        return { label: 'unrelated', confidence: 0.9, reason: 'model_misses_supersede' };
      }
      if (rule.label === null) return { label: null, confidence: null, reason: 'model_abstain' };
      return { label: rule.label, confidence: 0.8, reason: 'model_agrees' };
    },
  };

  test('the synthetic dataset is well-formed and covers every label and needs_review', () => {
    const dataset = loadDataset();
    assert.equal(dataset.cases.length, 22);
    const ids = new Set(dataset.cases.map((item) => item.id));
    assert.equal(ids.size, dataset.cases.length);
    const expected = new Set<RelationLabel | 'needs_review'>(dataset.cases.map((item) => item.expected));
    const labels: readonly (RelationLabel | 'needs_review')[] = [...relationLabels, 'needs_review'];
    for (const label of labels) {
      assert.equal(expected.has(label), true, label);
    }
    for (const item of dataset.cases) {
      assert.equal(item.source.record_ref !== item.target.record_ref, true, item.id);
      assert.equal(item.source.scope === item.target.scope, item.id !== '17-scope-mismatch', item.id);
    }
  });

  test('rule and model layers are reported separately with consistent metric invariants', async () => {
    const dataset = loadDataset();
    const report = await evaluateRelationCalibration(dataset, { model: imperfectModel, now: '2026-11-22T00:00:00.000Z' });

    assert.equal(report.schema_version, RELATION_CALIBRATION_SCHEMA_VERSION);
    assert.equal(report.dataset.size, dataset.cases.length);
    assert.equal(report.model?.name, 'fixture-imperfect-model');
    assert.equal(report.model?.comparisons, dataset.cases.length);
    assert.equal(report.model_layer?.layer, 'model');
    assert.equal(report.rule_layer.layer, 'rule');

    for (const layer of [report.rule_layer, report.model_layer]) {
      assert.ok(layer);
      const metrics = layer as NonNullable<typeof layer>;
      assert.equal(metrics.definitive + metrics.needs_review, metrics.evaluated);
      assert.equal(metrics.accuracy, metrics.definitive > 0 ? metrics.correct / metrics.definitive : null);
      assert.equal(metrics.abstention_rate, metrics.evaluated > 0 ? metrics.needs_review / metrics.evaluated : null);
      const bucketCount = metrics.calibration.reduce((total, bucket) => total + bucket.count, 0);
      const confidenceCount = metrics.calibration.reduce((total, bucket) => total + bucket.count, 0);
      assert.equal(bucketCount, confidenceCount);
      assert.ok(metrics.examples.length <= 8);
    }

    // The rule layer measures the three designed adversarial errors.
    assert.equal(report.rule_layer.false_supersede, 1);
    assert.equal(report.rule_layer.missed_relation, 1);
    assert.equal(report.rule_layer.wrong_pass, 1);
    assert.equal(report.rule_layer.wrong_block, 0);
    assert.equal(report.rule_layer.needs_review, 6);

    // The imperfect model layer misses explicit supersede proposals.
    assert.equal(report.model_layer?.wrong_block, 3);
    assert.equal(report.model_layer?.missed_relation, 4);
    assert.equal(report.model_layer?.false_supersede, 1);
  });

  test('confidence buckets partition the definitive predictions and carry accuracy', async () => {
    const dataset = loadDataset();
    const report = await evaluateRelationCalibration(dataset, { now: '2026-11-22T00:00:00.000Z' });
    const rule = report.rule_layer;
    const total = rule.calibration.reduce((sum, bucket) => sum + bucket.count, 0);
    assert.equal(total, rule.definitive);
    assert.deepEqual(rule.calibration.map((bucket) => bucket.lower), [0, 0.5, 0.7, 0.9]);
    for (const bucket of rule.calibration) {
      if (bucket.count > 0) {
        assert.equal(bucket.accuracy, bucket.correct / bucket.count);
        assert.equal(typeof bucket.average_confidence, 'number');
      } else {
        assert.equal(bucket.accuracy, null);
        assert.equal(bucket.average_confidence, null);
      }
    }
  });

  test('the report marks the 2-bit encoding as experimental and not inference evidence', async () => {
    const dataset = loadDataset();
    const report = await evaluateRelationCalibration(dataset, { now: '2026-11-22T00:00:00.000Z' });
    assert.deepEqual(report.encoding, { bits: 2, experimental: true, inference_evidence: false });
    assert.equal(report.notes.some((note) => note.includes('NOT evidence of inference optimization')), true);
    assert.equal(report.notes.some((note) => note.includes('Ledger deterministic precondition')), true);
  });

  test('model_layer is null when no adapter is injected', async () => {
    const dataset = loadDataset();
    const report = await evaluateRelationCalibration(dataset, { now: '2026-11-22T00:00:00.000Z' });
    assert.equal(report.model_layer, null);
    assert.equal(report.model, null);
    assert.equal(report.budget.max_candidates, defaultRelationCandidateBudget.max_candidates);
  });
});

// ---------------------------------------------------------------------------
// Determinism / no hidden dependency
// ---------------------------------------------------------------------------

test('the same pair classifies identically across runs (pure local rules)', () => {
  const first = classifyRelationPair(
    record('01AAAAAAAAAAAAAAAAAAAAAAAA', { fact_key: 'local.storage.engine', text: 'Use SQLite with FTS5 for the ledger.' }),
    record('01BBBBBBBBBBBBBBBBBBBBBBBB', { fact_key: 'local.storage.engine', text: 'Use SQLite for the ledger.', status: 'active' }),
  );
  const second = classifyRelationPair(
    record('01AAAAAAAAAAAAAAAAAAAAAAAA', { fact_key: 'local.storage.engine', text: 'Use SQLite with FTS5 for the ledger.' }),
    record('01BBBBBBBBBBBBBBBBBBBBBBBB', { fact_key: 'local.storage.engine', text: 'Use SQLite for the ledger.', status: 'active' }),
  );
  assert.deepEqual(canonicalJson(first), canonicalJson(second));
});
