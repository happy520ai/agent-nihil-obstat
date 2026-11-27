import assert from 'node:assert/strict';
import test from 'node:test';
import { cliCommands, humanOnlyCommands, toolCatalog } from '../../src/surface/tool-catalog.ts';

const expected = ['brief', 'explore', 'recall', 'track', 'note', 'verify', 'audit'];

test('MCP surface exposes exactly seven intentional tools', () => {
  assert.deepEqual(toolCatalog.map((tool) => tool.name), expected);
  assert.equal(new Set(expected).size, expected.length);
});

test('human release, attestation and sync capabilities are not MCP tools', () => {
  for (const command of humanOnlyCommands) {
    assert.ok(cliCommands.some((candidate) => command.startsWith(candidate)));
    assert.ok(!expected.includes(command));
  }
  assert.ok(!expected.some((name) => /approve|attest|sync|push|publish/.test(name)));
});

test('read schemas reject executable recall scripts and unknown fields', () => {
  const recall = toolCatalog.find((tool) => tool.name === 'recall');
  assert.ok(recall);
  assert.equal(recall.input.safeParse({ keyword: '账本', script: 'process.exit(0)' }).success, false);
  assert.equal(recall.input.safeParse({ keyword: '账本' }).success, true);
});

test('verify uses a strict scope discriminated union', () => {
  const verify = toolCatalog.find((tool) => tool.name === 'verify');
  assert.ok(verify);
  assert.equal(verify.input.safeParse({ scope: 'task', task_id: 'T1', argv: ['npm', 'test'], idem_key: 'T1:test', approved: true }).success, false);
  assert.equal(verify.input.safeParse({ scope: 'release', target: '0.1.0', profiles: ['A'], artifact_path: 'dist/ano.tgz', idem_key: 'R1:verify' }).success, true);
  assert.equal(verify.input.safeParse({ scope: 'release', target: '0.1.0', profiles: ['A'], artifact_path: 'dist/ano.tgz', idem_key: 'R1:verify', argv: ['rm', '-rf'] }).success, false);
  assert.equal(verify.input.safeParse({ scope: 'release', target: '0.1.0', profiles: ['A'], idem_key: 'R1:verify' }).success, false, 'a release must bind a real artifact, not only a target');
  assert.equal(verify.input.safeParse({ scope: 'release', target: '0.1.0', profiles: ['A'], artifact_path: 'dist/ano.tgz', artifact_hash: 'a'.repeat(64), idem_key: 'R1:verify' }).success, false, 'a caller-supplied artifact hash is not accepted');
});

test('verify task scope requires argv plus actual test_files and no release fields', () => {
  const verify = toolCatalog.find((tool) => tool.name === 'verify');
  assert.ok(verify);
  const base = { scope: 'task', task_id: 'T1', idem_key: 'T1:verify' };
  assert.equal(verify.input.safeParse({ ...base, argv: ['node', '--test', 'test/a.test.ts'] }).success, false, 'task scope must require test_files');
  assert.equal(verify.input.safeParse({ ...base, test_files: ['test/a.test.ts'] }).success, false, 'task scope must require argv');
  assert.equal(verify.input.safeParse({ ...base, argv: [], test_files: ['test/a.test.ts'] }).success, false, 'argv must not be empty');
  assert.equal(verify.input.safeParse({ ...base, argv: ['node', '--test', '__no_match__'], test_files: ['test/a.test.ts'] }).success, true);
  assert.equal(verify.input.safeParse({ ...base, argv: ['node', '--test', 'test/a.test.ts'], test_files: ['test/a.test.ts'], profiles: ['library'] }).success, false, 'release fields are rejected for task scope');
  assert.equal(verify.input.safeParse({ ...base, argv: ['node', '--test', 'test/a.test.ts'], test_files: ['test/a.test.ts'], target: '0.1.0' }).success, false);
});

test('memory notes require an anchor when implemented', () => {
  const note = toolCatalog.find((tool) => tool.name === 'note');
  assert.ok(note);
  const memory = { kind: 'memory', text: 'remember this', idem_key: 'M1:note' };
  assert.equal(note.input.safeParse(memory).success, false, 'memory must never be silently unanchored');
  assert.equal(note.input.safeParse({ ...memory, anchor: { file: 'src/a.ts' } }).success, true);
  assert.equal(note.input.safeParse({ ...memory, anchor: {} }).success, false, 'an anchor must name a file');
  assert.equal(note.input.safeParse({ ...memory, anchor: { file: 'src/a.ts', unknown: 1 } }).success, false, 'anchors are strict');
  assert.equal(note.input.safeParse({ kind: 'session_summary', text: 'summary', idem_key: 'S1:note' }).success, true);
  assert.equal(note.input.safeParse({ kind: 'session_summary', text: 'summary', idem_key: 'S1:note', anchor: { file: 'src/a.ts' } }).success, false, 'session summaries must not carry anchors');
});

test('brief include_memory_context is an opt-in strict branch', () => {
  const brief = toolCatalog.find((tool) => tool.name === 'brief');
  assert.ok(brief);
  assert.equal(brief.input.safeParse({}).success, true);
  assert.equal(brief.input.safeParse({ include_memory_context: true }).success, true);
  assert.equal(brief.input.safeParse({ include_memory_context: true, context_budget: 8 }).success, true);
  assert.equal(brief.input.safeParse({ include_memory_context: false }).success, false, 'the flag is a literal true');
  assert.equal(brief.input.safeParse({ context_budget: 8 }).success, false, 'a budget requires the opt-in flag');
  assert.equal(brief.input.safeParse({ include_memory_context: true, unexpected: 1 }).success, false);
});

test('recall mode=probe is strict and mutually exclusive with legacy filters', () => {
  const recall = toolCatalog.find((tool) => tool.name === 'recall');
  assert.ok(recall);
  const probe = { mode: 'probe', project_scope: 'fixture', requirements: ['local.storage.engine'] };
  assert.equal(recall.input.safeParse(probe).success, true);
  assert.equal(recall.input.safeParse({ ...probe, query: 'local.storage.engine' }).success, true);
  assert.equal(recall.input.safeParse({ mode: 'probe', project_scope: 'fixture' }).success, false, 'probe requires query or requirements');
  assert.equal(recall.input.safeParse({ ...probe, keyword: 'x' }).success, false, 'legacy filters cannot be mixed with mode=probe');
  assert.equal(recall.input.safeParse({ ...probe, source: 'connected' }).success, false, 'connected source cannot be mixed with mode=probe');
  assert.equal(recall.input.safeParse({ keyword: 'x', requirements: ['local.storage.engine'] }).success, false, 'probe fields require mode=probe');
  assert.equal(recall.input.safeParse({ keyword: 'x' }).success, true, 'legacy recall is unchanged');
});

test('note revise/relate branches are explicit and mutually exclusive', () => {
  const note = toolCatalog.find((tool) => tool.name === 'note');
  assert.ok(note);
  const revise = {
    idem_key: 'R1', operation: 'revise', kind: 'memory', text: 'storage is sqlite',
    fact_key: 'local.storage.engine', supersedes: [], reason: 'genesis',
    effective_from: null, effective_to: null,
  };
  assert.equal(note.input.safeParse(revise).success, true);
  const { supersedes: _supersedes, ...withoutSupersedes } = revise;
  assert.equal(note.input.safeParse(withoutSupersedes).success, false, 'supersedes must be explicit');
  assert.equal(note.input.safeParse({ ...revise, edge: 'depends_on' }).success, false, 'relate fields are rejected for revise');
  assert.equal(note.input.safeParse({ ...revise, kind: 'session_summary' }).success, false, 'facts cannot be session summaries');
  assert.equal(note.input.safeParse({ ...revise, effective_from: undefined }).success, false, 'effective_from must be explicit');

  const relate = { idem_key: 'R2', operation: 'relate', edge: 'depends_on', from_ref: '01A', to_ref: '01B' };
  assert.equal(note.input.safeParse(relate).success, true);
  assert.equal(note.input.safeParse({ ...relate, kind: 'memory' }).success, false, 'fact fields are rejected for relate');
  assert.equal(note.input.safeParse({ ...relate, text: 'x' }).success, false);
  assert.equal(note.input.safeParse({ kind: 'memory', text: 'x', idem_key: 'R3', fact_key: 'local.storage.engine' }).success, false, 'branch fields require operation');
  assert.equal(note.input.safeParse({ kind: 'memory', text: 'x', idem_key: 'R3', anchor: { file: 'src/a.ts' } }).success, true, 'legacy note is unchanged');
});

test('verify scope=context is strict and separate from Gate evidence fields', () => {
  const verify = toolCatalog.find((tool) => tool.name === 'verify');
  assert.ok(verify);
  const draft = { schema_version: 'anchorprobe.draft.v1', context_id: 'ctx-1', project_scope: 'fixture', claims: [] };
  const context = { scope: 'context', idem_key: 'C1', context_id: 'ctx-1', project_scope: 'fixture', draft };
  assert.equal(verify.input.safeParse(context).success, true);
  const { draft: _draft, ...withoutDraft } = context;
  assert.equal(verify.input.safeParse(withoutDraft).success, false, 'context verify requires a draft');
  assert.equal(verify.input.safeParse({ ...context, task_id: 'T1' }).success, false, 'task fields are rejected for context');
  assert.equal(verify.input.safeParse({ ...context, target: '0.1.0' }).success, false, 'release fields are rejected for context');
  assert.equal(verify.input.safeParse({ ...context, evidence_id: 'E1' }).success, false, 'context verify never carries Gate evidence');
  assert.equal(verify.input.safeParse({ scope: 'task', idem_key: 'T1', task_id: 'T1', argv: ['node'], test_files: ['test/a.test.ts'], context_id: 'ctx-1' }).success, false, 'context fields are rejected for task verify');
});
