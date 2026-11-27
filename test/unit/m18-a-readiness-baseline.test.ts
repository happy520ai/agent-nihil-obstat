/**
 * T-153 分片 A：readiness/baseline 审批拒绝、证明完整性与验证分支。
 *
 * 使用真实临时项目根与真实 ledger-shaped verifier；所有 hash 均由测试按文件
 * 字节重算，不修改源码。每个场景独立 tmp 根，审批后按需篡改证据以走真实失败路径。
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { canonicalJson } from '../../src/ledger/event.ts';
import {
  approveBaseline,
  BaselineError,
  draftPath,
  listBaselines,
  loadApprovedBaseline,
  loadBaselineDraft,
  releaseApprovedPayload,
  saveBaselineDraft,
  verifyBaseline,
  type ApprovalInput,
  type BaselineDraft,
  type ReleaseApprovalEvent,
} from '../../src/readiness/baseline.ts';

const AT = '2026-11-25T00:00:00.000Z';
const EVENT_ID = '00000000000000000000000000';
const TARGET = 'release-v1';

function rootFor(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'ano-m18-baseline-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function attestation(overrides: Partial<ApprovalInput> = {}): ApprovalInput {
  return { human: true, tty: true, name: 'Alice', role: 'release-owner', scope: 'release', statement: 'I approve v1', ...overrides };
}

interface DraftFixture {
  readonly draft: BaselineDraft;
  readonly criterionPath: string;
  readonly reportPaths: readonly string[];
}

function buildDraft(root: string, options: {
  criterionPath?: string;
  criterionContent?: string;
  metric?: string;
  target?: number;
} = {}): DraftFixture {
  const criterionPath = options.criterionPath ?? 'evidence/metrics.json';
  const criterionContent = options.criterionContent ?? JSON.stringify({ lines: 99 }, null, 2);
  mkdirSync(join(root, criterionPath, '..'), { recursive: true });
  writeFileSync(join(root, criterionPath), criterionContent);

  const reportPaths = ['.ano/quality.json', '.ano/coverage.json', '.ano/build.json'];
  for (const path of reportPaths) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), `${JSON.stringify({ report: path }, null, 2)}\n`);
  }

  const draft: BaselineDraft = {
    schemaVersion: 1,
    version: 1,
    createdAt: AT,
    criteria: [{
      id: 'lines',
      metric: options.metric ?? 'lines',
      operator: '>=',
      target: options.target ?? 95,
      evidence: { path: criterionPath, sha256: sha256(criterionContent), kind: 'report' },
    }],
    reports: {
      quality: { path: reportPaths[0]!, sha256: sha256(readFileSync(join(root, reportPaths[0]!))), kind: 'report' },
      coverage: { path: reportPaths[1]!, sha256: sha256(readFileSync(join(root, reportPaths[1]!))), kind: 'coverage' },
      build: { path: reportPaths[2]!, sha256: sha256(readFileSync(join(root, reportPaths[2]!))), kind: 'build' },
    },
  };
  return { draft, criterionPath, reportPaths };
}

function verifierFor(draft: BaselineDraft): () => ReleaseApprovalEvent {
  const payload = releaseApprovedPayload(draft, { ...attestation(), approvedAt: AT }, TARGET);
  return () => ({ event_id: EVENT_ID, kind: 'release.approved', payload });
}

function approveFixture(t: TestContext, options: Parameters<typeof buildDraft>[1] = {}) {
  const root = rootFor(t);
  const fixture = buildDraft(root, options);
  saveBaselineDraft(root, fixture.draft);
  const record = approveBaseline(root, 1, attestation(), {
    tty: true,
    approvedAt: AT,
    target: TARGET,
    verifier: verifierFor(fixture.draft),
  });
  return { root, ...fixture, record, verifier: verifierFor(fixture.draft) };
}

function expectBaselineCode(run: () => unknown, code: string, pattern?: RegExp): void {
  assert.throws(
    run,
    (error: unknown) => error instanceof BaselineError && error.code === code && (pattern === undefined || pattern.test(error.message)),
    `expected BaselineError ${code}${pattern ? ` matching ${pattern}` : ''}`,
  );
}

test('T-153 baseline 审批拒绝矩阵：TTY/授权/账本逐项显式 code', (t) => {
  const root = rootFor(t);
  const fixture = buildDraft(root);
  saveBaselineDraft(root, fixture.draft);
  const options = { tty: true, approvedAt: AT, target: TARGET };
  const verifier = verifierFor(fixture.draft);

  expectBaselineCode(
    () => approveBaseline(root, 1, attestation(), Object.assign({ ...options, verifier }, { stdin: { isTTY: true } })),
    'BASELINE_INVALID',
    /stream objects/u,
  );
  expectBaselineCode(() => approveBaseline(root, 1, attestation(), { ...options, tty: 'yes' as unknown as boolean, verifier }), 'BASELINE_INVALID', /boolean assertion/u);
  expectBaselineCode(() => approveBaseline(root, 1, attestation(), { ...options, tty: false, verifier }), 'BASELINE_TTY_REQUIRED');
  expectBaselineCode(() => approveBaseline(root, 1, attestation({ role: '' }), { ...options, verifier }), 'BASELINE_APPROVAL_REQUIRED');
  expectBaselineCode(() => approveBaseline(root, 1, attestation(), { ...options }), 'BASELINE_LEDGER_VERIFIER_REQUIRED');
  expectBaselineCode(() => approveBaseline(root, 1, attestation(), { ...options, verifier: () => { throw new Error('ledger down'); } }), 'BASELINE_LEDGER_UNVERIFIED', /verifier failed/u);
  expectBaselineCode(() => approveBaseline(root, 1, attestation(), { ...options, verifier: () => null }), 'BASELINE_LEDGER_UNVERIFIED', /No matching/u);
  expectBaselineCode(() => approveBaseline(root, 1, attestation(), { ...options, verifier: () => ({}) as unknown as ReleaseApprovalEvent }), 'BASELINE_LEDGER_MISMATCH', /malformed/u);
  expectBaselineCode(
    () => approveBaseline(root, 1, attestation(), { ...options, ledgerEventId: EVENT_ID, verifier: () => ({ event_id: '11111111111111111111111111', kind: 'release.approved', payload: releaseApprovedPayload(fixture.draft, { ...attestation(), approvedAt: AT }, TARGET) }) }),
    'BASELINE_LEDGER_MISMATCH',
    /does not match the proof event id/u,
  );
  const mismatched = releaseApprovedPayload(fixture.draft, { ...attestation(), approvedAt: AT }, TARGET);
  mismatched.target = 'another-target';
  expectBaselineCode(
    () => approveBaseline(root, 1, attestation(), { ...options, verifier: () => ({ event_id: EVENT_ID, kind: 'release.approved', payload: mismatched }) }),
    'BASELINE_LEDGER_MISMATCH',
    /payload does not match/u,
  );
  expectBaselineCode(() => approveBaseline(root, 1, attestation(), { ...options, approvedAt: 'not-a-date', verifier }), 'BASELINE_INVALID', /Approved-at/u);

  expectBaselineCode(() => releaseApprovedPayload(fixture.draft, { ...attestation(), approvedAt: AT }, ''), 'BASELINE_INVALID', /target must be/u);
  expectBaselineCode(() => releaseApprovedPayload(fixture.draft, { ...attestation(), approvedAt: AT }, 'x'.repeat(201)), 'BASELINE_INVALID', /target must be/u);
});

test('T-153 已批准基线证明字段被篡改时完整性校验拒绝', (t) => {
  const fixture = approveFixture(t);
  const loaded = loadApprovedBaseline(fixture.root, 1, { verifier: fixture.verifier });
  assert.equal(loaded.proof.approver, 'Alice');

  const approvedPath = join(fixture.root, '.ano', 'readiness', 'baselines', '000001.approved.json');
  const raw = JSON.parse(readFileSync(approvedPath, 'utf8')) as Record<string, unknown>;
  const proof = { ...(raw['proof'] as Record<string, unknown>), approver: 'Mallory' };
  const tampered = { ...raw, proof } as Record<string, unknown>;
  delete tampered['contentSha256'];
  tampered['contentSha256'] = sha256(canonicalJson(tampered));
  writeFileSync(approvedPath, `${JSON.stringify(tampered, null, 2)}\n`);

  expectBaselineCode(() => loadApprovedBaseline(fixture.root, 1, { verifier: fixture.verifier }), 'BASELINE_INTEGRITY', /proof field approver/u);
  assert.equal(existsSync(draftPath(fixture.root, 1)), false);
});

test('T-153 verifyBaseline：报告缺失、非 JSON 证据、指标缺失/字符串/未达标/证据失效', (t) => {
  const reportFixture = approveFixture(t);
  rmSync(join(reportFixture.root, '.ano/coverage.json'));
  const reportResult = verifyBaseline(reportFixture.root, 1, { verifier: reportFixture.verifier });
  assert.equal(reportResult.valid, false);
  assert.equal(reportResult.reportsValid, false);
  assert.match(reportResult.problems.join('; '), /report-invalid:\.ano\/coverage\.json/u);

  const notJson = approveFixture(t, { criterionPath: 'evidence/plain.txt', criterionContent: 'this is not json' });
  const notJsonResult = verifyBaseline(notJson.root, 1, { verifier: notJson.verifier });
  assert.equal(notJsonResult.valid, false);
  assert.match(notJsonResult.problems.join('; '), /evidence-not-json:lines/u);

  const missingMetric = approveFixture(t, { criterionContent: JSON.stringify({ other: 1 }) });
  const missingResult = verifyBaseline(missingMetric.root, 1, { verifier: missingMetric.verifier });
  assert.equal(missingResult.valid, false);
  assert.match(missingResult.problems.join('; '), /metric-missing:lines/u);

  const stringMetric = approveFixture(t, { criterionContent: JSON.stringify({ lines: 'PASS' }) });
  const stringResult = verifyBaseline(stringMetric.root, 1, { verifier: stringMetric.verifier });
  assert.equal(stringResult.valid, false);
  assert.match(stringResult.problems.join('; '), /machine-pass-must-be-numeric/u);

  const failing = approveFixture(t, { criterionContent: JSON.stringify({ lines: 10 }), target: 95 });
  const failingResult = verifyBaseline(failing.root, 1, { verifier: failing.verifier });
  assert.equal(failingResult.valid, false);
  assert.deepEqual(failingResult.criteria[0], { id: 'lines', status: 'machine', actual: 10, pass: false });
  assert.match(failingResult.problems.join('; '), /criterion-failed:lines/u);

  const vanished = approveFixture(t);
  rmSync(join(vanished.root, vanished.criterionPath));
  const vanishedResult = verifyBaseline(vanished.root, 1, { verifier: vanished.verifier });
  assert.equal(vanishedResult.valid, false);
  assert.match(vanishedResult.problems.join('; '), /evidence-invalid:lines/u);

  const stale = approveFixture(t);
  writeFileSync(join(stale.root, stale.criterionPath), JSON.stringify({ lines: 10 }));
  const staleResult = verifyBaseline(stale.root, 1, { verifier: stale.verifier });
  assert.equal(staleResult.valid, false);
  assert.match(staleResult.problems.join('; '), /evidence-hash-mismatch:lines/u);
});

test('T-153 listBaselines 同时列出同版本 draft/approved 并稳定排序', (t) => {
  const root = rootFor(t);
  const directory = join(root, '.ano', 'readiness', 'baselines');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, '000002.draft.json'), '{}\n');
  writeFileSync(join(directory, '000001.approved.json'), '{}\n');
  writeFileSync(join(directory, '000001.draft.json'), '{}\n');
  writeFileSync(join(directory, 'notes.txt'), 'ignored\n');

  const listings = listBaselines(root);
  assert.deepEqual(listings.map((entry) => `${entry.version}:${entry.status}`), ['1:approved', '1:draft', '2:draft']);
});

test('T-153 draft 结构/路径/哈希与版本不变量逐项拒绝', (t) => {
  const root = rootFor(t);
  const fixture = buildDraft(root);
  const good = fixture.draft;
  const criterion = good.criteria[0]!;

  expectBaselineCode(
    () => saveBaselineDraft(root, { ...good, criteria: [criterion, criterion] }),
    'BASELINE_INVALID',
    /Duplicate criterion id/u,
  );
  expectBaselineCode(
    () => saveBaselineDraft(root, { ...good, reports: { ...good.reports, coverage: good.reports.quality } }),
    'BASELINE_INVALID',
    /distinct files/u,
  );
  expectBaselineCode(
    () => saveBaselineDraft(root, {
      ...good,
      reports: { ...good.reports, quality: { ...good.reports.quality, path: '.ano/readiness/baselines/000001.draft.json' } },
    }),
    'BASELINE_INVALID',
    /cannot point at the baseline store/u,
  );
  expectBaselineCode(
    () => saveBaselineDraft(root, { ...good, reports: { ...good.reports, build: { ...good.reports.build, kind: 'report' } } }),
    'BASELINE_INVALID',
    /build\.kind/u,
  );
  expectBaselineCode(
    () => saveBaselineDraft(root, {
      ...good,
      criteria: [{ ...criterion, evidence: { ...criterion.evidence, path: '../escape.json' } }],
    }),
    'BASELINE_INVALID',
    /stay inside the project/u,
  );
  expectBaselineCode(
    () => saveBaselineDraft(root, {
      ...good,
      criteria: [{ ...criterion, evidence: { ...criterion.evidence, sha256: '0'.repeat(64) } }],
    }),
    'BASELINE_EVIDENCE_MISMATCH',
  );

  const directory = join(root, '.ano', 'readiness', 'baselines');
  mkdirSync(directory, { recursive: true });
  writeFileSync(draftPath(root, 1), '{bad json');
  expectBaselineCode(() => loadBaselineDraft(root, 1), 'BASELINE_INVALID', /not valid JSON/u);
  expectBaselineCode(() => loadBaselineDraft(root, 2), 'BASELINE_INVALID', /does not exist/u);

  writeFileSync(join(directory, '000001.approved.json'), '{}\n');
  expectBaselineCode(() => saveBaselineDraft(root, good), 'BASELINE_IMMUTABLE');
});
