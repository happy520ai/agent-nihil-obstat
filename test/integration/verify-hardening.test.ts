import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { executeEvidence, normalizeEvidencePath, redactArgv, redactSecrets } from '../../src/gate/evidence.ts';
import {
  blastRadiusSchema,
  blastRiskSummarySchema,
  reviewItemSchema,
  storedVerificationSchema,
  structureCoverageGapSchema,
  structureEvidenceSchema,
} from '../../src/gate/types.ts';
import { ledgerPayloadIssues } from '../../src/ledger/payloads.ts';

const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE';
const GITHUB_TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
const OPENAI_TOKEN = 'sk-abcdefghijklmnopqrstuvwxyz0123456789';

test('argv redaction removes flags, assignments, URLs and known credential shapes', () => {
  const redacted = redactArgv([
    process.execPath,
    '--test',
    'test/a.test.ts',
    `--token=${AWS_KEY}`,
    '--password',
    'hunter2',
    `TOKEN=${GITHUB_TOKEN}`,
    'https://user:pass@example.com/report',
  ]);
  assert.equal(redacted[0], process.execPath);
  assert.equal(redacted[1], '--test');
  assert.equal(redacted[2], 'test/a.test.ts');
  assert.equal(redacted[3], '--token=[redacted]');
  assert.equal(redacted[4], '--password');
  assert.equal(redacted[5], '[redacted]');
  assert.equal(redacted[6], 'TOKEN=[redacted]');
  assert.equal(redacted[7], 'https://[redacted]@example.com/report');
  assert.ok(!redacted.join(' ').includes(AWS_KEY));
  assert.ok(!redacted.join(' ').includes('hunter2'));
  assert.ok(!redacted.join(' ').includes(GITHUB_TOKEN));
  assert.match(redactSecrets(`error: api_key=${OPENAI_TOKEN} Authorization: Bearer ${GITHUB_TOKEN}`), /api_key=\[redacted\].*Authorization: \[redacted\]/);
});

test('evidence persists redacted argv and a normalized cwd without changing the executed command', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'ano redact '));
  const evidence = await executeEvidence({
    argv: [process.execPath, '-e', 'console.log("# tests 1\\n# pass 1")', '--', `--token=${AWS_KEY}`, '--password', 'hunter2'],
    cwd,
    timeoutMs: 10_000,
  }, 'a'.repeat(64), 'graph-1');
  assert.equal(evidence.ok, true, JSON.stringify(evidence));
  assert.equal(evidence.argv[0], process.execPath);
  assert.equal(evidence.argv[4], '--token=[redacted]');
  assert.equal(evidence.argv[5], '--password');
  assert.equal(evidence.argv[6], '[redacted]');
  assert.equal(evidence.cwd, normalizeEvidencePath(cwd));
  assert.equal(evidence.cwd, resolve(cwd).replaceAll('\\', '/'));
  assert.ok(!JSON.stringify(evidence).includes(AWS_KEY));
  assert.ok(!JSON.stringify(evidence).includes('hunter2'));

  const failed = await executeEvidence({
    argv: [process.execPath, '-e', `console.error("Error: password=hunter2 ${AWS_KEY}");process.exit(1)`],
    cwd,
    timeoutMs: 10_000,
  }, 'b'.repeat(64), 'graph-1');
  assert.equal(failed.ok, false);
  assert.match(failed.failureExcerpt ?? '', /Error/);
  assert.ok(!String(failed.failureExcerpt).includes(AWS_KEY));
  assert.ok(!String(failed.failureExcerpt).includes('hunter2'));
});

test('a real Node test runner still executes after redaction hardening', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'ano real-runner '));
  await writeFile(join(cwd, 'real.test.ts'), "import test from 'node:test';import assert from 'node:assert/strict';test('real', () => assert.equal(1, 1));\n");
  const evidence = await executeEvidence({ argv: [process.execPath, '--test', 'real.test.ts'], cwd, timeoutMs: 20_000 }, 'c'.repeat(64), 'graph-real');
  assert.equal(evidence.ok, true, JSON.stringify(evidence));
  assert.deepEqual(evidence.argv, [process.execPath, '--test', 'real.test.ts']);
  assert.deepEqual(evidence.counts, { tests: 1, pass: 1, fail: 0, cancelled: 0, skipped: 0, todo: 0 });
});

const legacyBlastRadius = { impacted: ['src/a.ts'], covered: [], uncovered: ['src/a.ts'], advisory: [] };

test('blast radius schema parses legacy evidence and accepts additive structural risk', () => {
  assert.equal(blastRadiusSchema.safeParse(legacyBlastRadius).success, true, 'old evidence without risk must stay valid');
  assert.equal(blastRadiusSchema.safeParse({ ...legacyBlastRadius, unexpected: true }).success, false, 'the schema stays strict');

  const summary = {
    revision: 'rev-1',
    levels: { 'src/a.ts': 'high' },
    counts: { high: 1, medium: 0, low: 0 },
    highCenters: ['src/a.ts'],
    testGaps: ['src/a.ts'],
    reviewCount: 2,
  };
  const parsed = blastRadiusSchema.safeParse({ ...legacyBlastRadius, risk: summary });
  assert.equal(parsed.success, true, JSON.stringify(parsed.success ? null : parsed.error.issues));
  assert.equal(blastRiskSummarySchema.safeParse({ ...summary, evidence_id: 'x' }).success, false, 'risk summary never carries an evidence id');
  assert.equal(blastRiskSummarySchema.safeParse({ ...summary, counts: { high: 1 } }).success, false, 'counts must keep all three levels');
});

test('structure coverage evidence is strict, separates types and records the explicit difference set', () => {
  const gap = {
    executedTests: ['test/a.test.ts'],
    highRiskFiles: ['src/hub.js'],
    coveredHighRisk: [],
    uncoveredHighRisk: ['src/hub.js'],
    testGaps: ['src/hub.js'],
  };
  assert.equal(structureCoverageGapSchema.safeParse(gap).success, true);
  assert.equal(structureCoverageGapSchema.safeParse({ ...gap, evidenceId: 'x' }).success, false);
  const structure = {
    riskSummary: {
      revision: 'rev-1',
      levels: { 'src/hub.js': 'high' },
      counts: { high: 1, medium: 0, low: 0 },
      highCenters: ['src/hub.js'],
      testGaps: ['src/hub.js'],
      reviewCount: 1,
    },
    coverageGap: gap,
    reviewItems: [{
      kind: 'dynamic-load',
      file: 'src/hub.js',
      line: 1,
      pattern: 'require',
      reason: 'computed specifier',
      suggestedAction: 'confirm dynamic targets',
      evidenceRevision: 'rev-1',
      origin: 'manual-review',
    }],
    policyEffect: 'blocked',
  };
  assert.equal(structureEvidenceSchema.safeParse(structure).success, true, 'structure evidence must validate');
  assert.equal(structureEvidenceSchema.safeParse({ ...structure, evidence_id: 'x' }).success, false);
  assert.equal(reviewItemSchema.safeParse({ ...structure.reviewItems[0], evidence_id: 'a'.repeat(64) }).success, false, 'review items are not Gate evidence');
});

test('stored verification schema parses legacy verdicts without risk or structure', () => {
  const legacy = {
    idem_key: 'k1',
    params: 'p1',
    identity: 'i1',
    task_id: 'T',
    graph_revision: 'g1',
    test_files: ['test/a.test.ts'],
    policy: { minimum: 'T1', unknown: 'strict' },
    verdict: {
      taskId: 'T',
      status: 'done',
      level: 'T0',
      sourceFingerprint: 'a'.repeat(64),
      graphRevision: 'g1',
      freshness: { status: 'fresh', stale: 0 },
      blastRadius: legacyBlastRadius,
      policy: { minimum: 'T1', unknown: 'strict' },
      caveats: {},
      reasons: [],
    },
  };
  assert.equal(storedVerificationSchema.safeParse(legacy).success, true, 'legacy stored verdicts remain parseable');
  // The payload layer is untouched: no new event kind, no new required field.
  assert.deepEqual(ledgerPayloadIssues('evidence.recorded', { task_id: 'T', evidence: legacy }), []);
});
