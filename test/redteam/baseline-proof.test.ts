import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { canonicalJson } from '../../src/ledger/event.ts';
import {
  approveBaseline,
  approvedPath,
  BaselineError,
  isInteractiveTty,
  loadApprovedBaseline,
  loadBaselineDraft,
  releaseApprovedPayload,
  saveBaselineDraft,
  verifyBaseline,
  type Approval,
  type ApprovalInput,
  type ApprovedBaseline,
  type BaselineDraft,
  type ReleaseApprovalEvent,
  type ReleaseApprovalVerifier,
  type ReleaseApprovedPayload,
} from '../../src/readiness/baseline.ts';

const APPROVED_AT = '2026-02-01T00:00:00.000Z';
const ATTESTATION: ApprovalInput = {
  human: true,
  tty: true,
  name: 'Release Human',
  role: 'release-owner',
  scope: 'fixture@1.0.0',
  statement: 'I reviewed the quality, coverage and build reports.',
};
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'ano baseline proof '));
}
async function write(root: string, path: string, source: string): Promise<void> {
  const target = join(root, ...path.split('/'));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, source);
}
function hashCanonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
async function fileHash(root: string, path: string): Promise<string> {
  return createHash('sha256').update(await readFile(join(root, ...path.split('/')))).digest('hex');
}
function ledgerEventId(sequence: number): string {
  let value = sequence;
  let id = '';
  for (let index = 0; index < 26; index += 1) {
    id = CROCKFORD[value % 32] + id;
    value = Math.floor(value / 32);
  }
  return id;
}

interface ControlledLedger {
  verifier: ReleaseApprovalVerifier;
  issue: (expected: ReleaseApprovedPayload) => ReleaseApprovalEvent;
}

/** Simulates the controlled ledger: only events issued here are visible. */
function controlledLedger(): ControlledLedger {
  const events: ReleaseApprovalEvent[] = [];
  let sequence = 0;
  return {
    verifier: (request) => events.find((event) =>
      (request.eventId === undefined || event.event_id === request.eventId)
      && canonicalJson(event.payload) === canonicalJson(request.expected)) ?? null,
    issue: (expected) => {
      const event: ReleaseApprovalEvent = { event_id: ledgerEventId(++sequence), kind: 'release.approved', payload: expected };
      events.push(event);
      return event;
    },
  };
}

async function fixture(): Promise<{ root: string; hashes: Record<string, string> }> {
  const root = await tempRoot();
  await write(root, 'reports/quality.json', JSON.stringify({ counts: { tests: 10, pass: 10, fail: 0 } }));
  await write(root, 'reports/coverage.json', JSON.stringify({ summary: { lines: { pct: 92.5 } } }));
  await write(root, 'reports/build.json', JSON.stringify({ exitCode: 0 }));
  return {
    root,
    hashes: {
      quality: await fileHash(root, 'reports/quality.json'),
      coverage: await fileHash(root, 'reports/coverage.json'),
      build: await fileHash(root, 'reports/build.json'),
    },
  };
}

function draftFrom(hashes: Record<string, string>, version = 1): BaselineDraft {
  return {
    schemaVersion: 1,
    version,
    createdAt: '2026-01-01T00:00:00.000Z',
    criteria: [
      { id: 'tests.pass', metric: 'counts.pass', operator: '>=', target: 10, evidence: { path: 'reports/quality.json', sha256: hashes.quality!, kind: 'test' } },
      { id: 'coverage.lines', metric: 'summary.lines.pct', operator: '>=', target: 90, evidence: { path: 'reports/coverage.json', sha256: hashes.coverage!, kind: 'coverage' } },
      { id: 'build.exit', metric: 'exitCode', operator: '==', target: 0, evidence: { path: 'reports/build.json', sha256: hashes.build!, kind: 'build' } },
    ],
    reports: {
      quality: { path: 'reports/quality.json', sha256: hashes.quality!, kind: 'report' },
      coverage: { path: 'reports/coverage.json', sha256: hashes.coverage!, kind: 'coverage' },
      build: { path: 'reports/build.json', sha256: hashes.build!, kind: 'build' },
    },
  };
}

/** Builds the payload and the release.approved event the orchestrator would write. */
function issueFor(ledger: ControlledLedger, draft: BaselineDraft, approval: Approval = { ...ATTESTATION, approvedAt: APPROVED_AT }): ReleaseApprovalEvent {
  return ledger.issue(releaseApprovedPayload(draft, approval));
}

/** Agent-forged file: every hash is self-consistent, only ledger provenance is absent. */
function forgedApprovedRecord(draft: BaselineDraft, approval: Approval, eventId: string): ApprovedBaseline {
  const payload = releaseApprovedPayload(draft, approval);
  const subject = { ...draft, status: 'approved' as const, approval };
  const proof = {
    schema: 'ano.baseline.approval-proof.v1' as const,
    approver: payload.approver,
    approvedAt: payload.approved_at,
    approvalRef: payload.approval_ref,
    artifactSha256: payload.artifact_hash,
    subjectSha256: payload.verdict_hash,
    target: payload.target,
    baselineId: payload.baseline_id,
    baselineVersion: payload.baseline_version,
    ledgerEventId: eventId,
  };
  return { ...subject, proof, contentSha256: hashCanonical({ ...subject, proof }) };
}

function code(name: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof BaselineError && error.code === name;
}

test('secure default: no ledger verifier means approval, load and verify all refuse', async () => {
  const { root, hashes } = await fixture();
  try {
    saveBaselineDraft(root, draftFrom(hashes, 1));

    assert.throws(
      () => approveBaseline(root, 1, ATTESTATION, { tty: true }),
      code('BASELINE_LEDGER_VERIFIER_REQUIRED'),
    );
    assert.equal(existsSync(approvedPath(root, 1)), false);

    const ledger = controlledLedger();
    issueFor(ledger, loadBaselineDraft(root, 1));
    approveBaseline(root, 1, ATTESTATION, { tty: true, approvedAt: APPROVED_AT, verifier: ledger.verifier });

    assert.throws(() => loadApprovedBaseline(root, 1), code('BASELINE_LEDGER_VERIFIER_REQUIRED'));
    assert.throws(() => verifyBaseline(root, 1), code('BASELINE_LEDGER_VERIFIER_REQUIRED'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('no proof: an approved-shaped file without proof fails the strict schema', async () => {
  const { root, hashes } = await fixture();
  try {
    saveBaselineDraft(root, draftFrom(hashes, 1));
    const ledger = controlledLedger();
    issueFor(ledger, loadBaselineDraft(root, 1));
    approveBaseline(root, 1, ATTESTATION, { tty: true, approvedAt: APPROVED_AT, verifier: ledger.verifier });

    const raw = JSON.parse(await readFile(approvedPath(root, 1), 'utf8')) as Record<string, unknown>;
    delete raw.proof;
    await writeFile(approvedPath(root, 1), JSON.stringify(raw, null, 2), 'utf8');
    assert.throws(() => loadApprovedBaseline(root, 1, { verifier: ledger.verifier }), code('BASELINE_INTEGRITY'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('forged proof with correct hashes has no provenance and is refused without the ledger event', async () => {
  const { root, hashes } = await fixture();
  try {
    saveBaselineDraft(root, draftFrom(hashes, 1));
    const draft = loadBaselineDraft(root, 1);
    const approval: Approval = { ...ATTESTATION, approvedAt: APPROVED_AT };
    const realLedger = controlledLedger();
    const event = issueFor(realLedger, draft, approval);
    const forged = forgedApprovedRecord(draft, approval, event.event_id);
    await write(root, '.ano/readiness/baselines/000001.approved.json', JSON.stringify(forged, null, 2));

    // Every hash re-computes correctly, yet an empty/agent-controlled ledger finds no event.
    const emptyLedger = controlledLedger();
    assert.throws(() => loadApprovedBaseline(root, 1, { verifier: emptyLedger.verifier }), code('BASELINE_LEDGER_UNVERIFIED'));

    // The same file is accepted only when the matching controlled-ledger event exists.
    const accepted = loadApprovedBaseline(root, 1, { verifier: realLedger.verifier });
    assert.equal(accepted.proof.ledgerEventId, event.event_id);
    assert.equal(accepted.proof.subjectSha256, releaseApprovedPayload(draft, approval).verdict_hash);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an event for one version cannot authorize another, and mismatched payloads are refused', async () => {
  const { root, hashes } = await fixture();
  try {
    saveBaselineDraft(root, draftFrom(hashes, 1));
    const firstLedger = controlledLedger();
    issueFor(firstLedger, loadBaselineDraft(root, 1));
    approveBaseline(root, 1, ATTESTATION, { tty: true, approvedAt: APPROVED_AT, verifier: firstLedger.verifier });

    saveBaselineDraft(root, draftFrom(hashes, 2));
    assert.throws(
      () => approveBaseline(root, 2, ATTESTATION, {
        tty: true,
        approvedAt: '2026-02-02T00:00:00.000Z',
        verifier: firstLedger.verifier,
      }),
      code('BASELINE_LEDGER_UNVERIFIED'),
    );

    const wrongApprover: ReleaseApprovalVerifier = (request) => ({
      event_id: request.eventId ?? ledgerEventId(999),
      kind: 'release.approved',
      payload: { ...request.expected, approver: 'Mallory' },
    });
    assert.throws(
      () => approveBaseline(root, 2, ATTESTATION, {
        tty: true,
        approvedAt: '2026-02-02T00:00:00.000Z',
        verifier: wrongApprover,
      }),
      code('BASELINE_LEDGER_MISMATCH'),
    );

    const malformed: ReleaseApprovalVerifier = () => ({ event_id: 'not-a-ulid' } as unknown as ReleaseApprovalEvent);
    assert.throws(
      () => approveBaseline(root, 2, ATTESTATION, {
        tty: true,
        approvedAt: '2026-02-02T00:00:00.000Z',
        verifier: malformed,
      }),
      code('BASELINE_LEDGER_MISMATCH'),
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('TTY streams are never approval evidence: non-TTY, stream objects and undefined TTY refuse', async () => {
  const { root, hashes } = await fixture();
  try {
    saveBaselineDraft(root, draftFrom(hashes, 1));
    const ledger = controlledLedger();
    issueFor(ledger, loadBaselineDraft(root, 1));

    assert.equal(typeof isInteractiveTty(), 'boolean');
    assert.throws(
      () => approveBaseline(root, 1, ATTESTATION, { tty: false, verifier: ledger.verifier }),
      code('BASELINE_TTY_REQUIRED'),
    );

    const streamOptions = {
      tty: true,
      stdin: { isTTY: true },
      stdout: { isTTY: true },
      verifier: ledger.verifier,
    } as unknown as Parameters<typeof approveBaseline>[3];
    assert.throws(() => approveBaseline(root, 1, ATTESTATION, streamOptions), code('BASELINE_INVALID'));

    const objectTty = {
      tty: { isTTY: true },
      verifier: ledger.verifier,
    } as unknown as Parameters<typeof approveBaseline>[3];
    assert.throws(() => approveBaseline(root, 1, ATTESTATION, objectTty), code('BASELINE_INVALID'));

    assert.equal(existsSync(approvedPath(root, 1)), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a hand-written PASS verdict cannot become a machine pass even with a valid ledger proof', async () => {
  const { root, hashes } = await fixture();
  try {
    await write(root, 'reports/hand-pass.json', JSON.stringify({ result: 'PASS' }));
    const passHash = await fileHash(root, 'reports/hand-pass.json');
    const draft = draftFrom(hashes, 1);
    draft.criteria = [{ id: 'hand', metric: 'result', operator: '==', target: 1, evidence: { path: 'reports/hand-pass.json', sha256: passHash, kind: 'test' } }];
    saveBaselineDraft(root, draft);

    const ledger = controlledLedger();
    issueFor(ledger, loadBaselineDraft(root, 1));
    const approved = approveBaseline(root, 1, ATTESTATION, { tty: true, approvedAt: APPROVED_AT, verifier: ledger.verifier });
    assert.equal(approved.proof.ledgerEventId.length, 26);

    const evaluated = verifyBaseline(root, 1, { verifier: ledger.verifier });
    assert.equal(evaluated.valid, false);
    assert.equal(evaluated.approvalVerified, true);
    assert.ok(evaluated.problems.some((problem) => problem.includes('machine-pass-must-be-numeric')), JSON.stringify(evaluated.problems));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('legacy invariants still hold: immutable approvals, strict versions, report-hash invalidation', async () => {
  const { root, hashes } = await fixture();
  try {
    saveBaselineDraft(root, draftFrom(hashes, 1));
    const firstLedger = controlledLedger();
    issueFor(firstLedger, loadBaselineDraft(root, 1));
    const approved = approveBaseline(root, 1, ATTESTATION, { tty: true, approvedAt: APPROVED_AT, verifier: firstLedger.verifier });
    assert.equal(verifyBaseline(root, 1, { verifier: firstLedger.verifier }).valid, true);

    assert.throws(
      () => approveBaseline(root, 1, ATTESTATION, { tty: true, approvedAt: APPROVED_AT, verifier: firstLedger.verifier }),
      code('BASELINE_IMMUTABLE'),
    );
    assert.throws(() => saveBaselineDraft(root, draftFrom(hashes, 1)), code('BASELINE_IMMUTABLE'));

    await write(root, 'reports/quality.json', JSON.stringify({ counts: { tests: 10, pass: 9, fail: 1 } }));
    const invalidated = verifyBaseline(root, 1, { verifier: firstLedger.verifier });
    assert.equal(invalidated.valid, false);
    assert.ok(invalidated.problems.some((problem) => problem.startsWith('report-hash-mismatch')));

    await write(root, 'reports/quality.json', JSON.stringify({ counts: { tests: 10, pass: 10, fail: 0 } }));
    saveBaselineDraft(root, draftFrom(hashes, 2));
    const secondLedger = controlledLedger();
    issueFor(secondLedger, loadBaselineDraft(root, 2), { ...ATTESTATION, approvedAt: '2026-02-02T00:00:00.000Z' });
    const second = approveBaseline(root, 2, ATTESTATION, { tty: true, approvedAt: '2026-02-02T00:00:00.000Z', verifier: secondLedger.verifier });
    assert.equal(second.version, 2);

    const raw = JSON.parse(await readFile(approvedPath(root, 2), 'utf8')) as Record<string, unknown>;
    raw.notes = 'tampered after approval';
    await writeFile(approvedPath(root, 2), JSON.stringify(raw, null, 2), 'utf8');
    assert.throws(() => loadApprovedBaseline(root, 2, { verifier: secondLedger.verifier }), code('BASELINE_INTEGRITY'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
