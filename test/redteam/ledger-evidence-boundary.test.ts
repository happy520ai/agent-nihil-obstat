import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { fingerprintTree } from '../../src/core/fingerprint.ts';
import { ulid } from '../../src/core/ulid.ts';
import { scanSegment } from '../../src/ledger/append.ts';
import { eventChain, genesisHash, hashEvent, type LedgerEvent } from '../../src/ledger/event.ts';
import { GateEvidenceError, Ledger, LedgerIntegrityError } from '../../src/ledger/ledger.ts';
import { replayLedger } from '../../src/ledger/replay.ts';
import { VIEW_SCHEMA_VERSION } from '../../src/ledger/views.ts';
import { encodeBatch, encodeEvents, parseSegment } from '../../src/ledger/segment.ts';

const sha = (fill: string): string => fill.repeat(64).slice(0, 64);

async function rootFor(t: TestContext, prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function ledgerDir(root: string): string { return join(root, '.ano', 'ledger'); }
async function segmentNames(root: string): Promise<string[]> {
  return (await readdir(ledgerDir(root)).catch(() => [] as string[])).filter((name) => name.endsWith('.jsonl')).sort();
}
async function committedEvents(root: string): Promise<LedgerEvent[]> {
  const events: LedgerEvent[] = [];
  for (const name of await segmentNames(root)) {
    const scanned = scanSegment(await readFile(join(ledgerDir(root), name)));
    assert.equal(scanned.ignoredTail, false, `${name} must not have an uncommitted tail`);
    assert.equal(eventChain(scanned.events), true, `${name} must have a valid hash chain`);
    events.push(...scanned.events);
  }
  return events;
}
async function write(root: string, path: string, source: string): Promise<void> {
  const target = join(root, ...path.split('/'));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, source);
}
function git(root: string, args: string[]): void {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
}
async function initRepo(root: string): Promise<void> {
  await write(root, '.gitignore', '.ano/\n');
  await write(root, 'package.json', JSON.stringify({ private: true, type: 'module' }));
  await write(root, 'src/a.ts', 'export const a = 1;\n');
  await write(root, 'test/a.test.ts', "import test from 'node:test';test('a', () => {});\n");
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'ano@localhost'], ['config', 'user.name', 'ano'], ['add', '.'], ['commit', '-qm', 'base']]) git(root, args);
}
function gateEvidence(root: string, taskId: string, id: string, fingerprint: string, options: { verification?: boolean } = {}): Record<string, unknown> {
  const at = new Date().toISOString();
  const verdict = { taskId, status: 'done', level: 'T1', evidenceId: id, sourceFingerprint: fingerprint, graphRevision: 'graph-1', freshness: { status: 'fresh', stale: 0 }, blastRadius: { covered: [], uncovered: [] }, policy: { minimum: 'T1', unknown: 'strict' }, caveats: {}, reasons: [] };
  const evidence: Record<string, unknown> = {
    id,
    argv: ['node', '--test', 'test/a.test.ts'],
    cwd: root,
    sourceFingerprint: fingerprint,
    graphRevision: 'graph-1',
    environment: { node: process.version, platform: process.platform, arch: process.arch },
    startedAt: at,
    finishedAt: at,
    durationMs: 1,
    exitCode: 0,
    signal: null,
    timedOut: false,
    counts: { tests: 1, pass: 1 },
    ok: true,
    outputDigest: sha('c'),
  };
  if (options.verification !== false) {
    evidence.verification = { idem_key: `gate-${id}`, params: 'params', identity: 'identity', test_files: ['test/a.test.ts'], policy: { minimum: 'T1', unknown: 'strict' }, verdict };
  }
  return evidence;
}
function rechain(events: LedgerEvent[], mutateHead: (event: LedgerEvent) => LedgerEvent): LedgerEvent[] {
  let previous = genesisHash;
  return events.map((event, index) => {
    const body = index === 0 ? mutateHead(event) : event;
    const next: LedgerEvent = { ...body, prev_hash: previous };
    previous = hashEvent(next);
    return next;
  });
}

// ---------------------------------------------------------------------------
// 1. Cross-domain append-only events and their views
// ---------------------------------------------------------------------------

test('cross-domain events carry independent payload contracts and rebuild into views', async (t) => {
  const root = await rootFor(t, 'ano-boundary-events-');
  const ledger = await Ledger.open(root, { sessionId: 'EVIDENCE', clock: () => 1_000 });
  const noteId = sha('1');
  const findingId = sha('2');
  const evidenceRef = sha('3');
  const attestationRef = sha('4');
  const verdictHash = sha('5');
  const approvalRef = sha('6');
  const artifactHash = sha('7');
  try {
    const note = await ledger.append({
      kind: 'note.recorded',
      payload: {
        note_id: noteId,
        kind: 'decision',
        text: 'keep the ledger append-only',
        created_at: new Date(1_000).toISOString(),
        anchor: { file: 'src/ledger/event.ts', symbolId: 'fn:hashEvent', contentFragmentHash: sha('8') },
      },
    }, 'note-1');
    assert.equal(note.duplicate, false);
    assert.equal(ledger.getNote(noteId)?.kind, 'decision');
    assert.equal((ledger.getNote(noteId)?.anchor as Record<string, unknown>).file, 'src/ledger/event.ts');

    await ledger.append({
      kind: 'audit.finding',
      payload: {
        scope: 'security',
        at: new Date(1_000).toISOString(),
        finding: { id: findingId, scope: 'security', rule: 'secret.scan', severity: 'high', message: 'hash-only finding', fingerprint: sha('9'), status: 'open', path: 'src/a.ts', line: 3 },
      },
    }, 'audit-finding-1');
    assert.equal(ledger.getAuditFinding(findingId)?.fingerprint, sha('9'));
    assert.equal(ledger.getAuditFinding(findingId)?.severity, 'high');

    await ledger.append({
      kind: 'audit.completed',
      payload: { scope: 'security', at: new Date(1_000).toISOString(), ok: false, summary: { high: 1, medium: 0, low: 0, info: 0, total: 1 } },
    }, 'audit-completed-1');
    assert.equal(ledger.listAuditRuns().length, 1);
    assert.equal(ledger.listAuditRuns()[0]?.ok, false);

    await ledger.append({
      kind: 'readiness.evidence',
      payload: {
        requirement_id: 'common.tests',
        kind: 'ci_run',
        result: 'pass',
        evidence_ref: evidenceRef,
        source_fingerprint: sha('a'),
        artifact_hash: artifactHash,
        timestamp: new Date(1_000).toISOString(),
      },
    }, 'readiness-evidence-1');
    assert.equal(ledger.getReadinessEvidence(evidenceRef)?.requirementId, 'common.tests');
    assert.equal(ledger.listReadinessEvidence('common.tests').length, 1);

    await ledger.append({
      kind: 'readiness.attestation',
      payload: {
        attestation_ref: attestationRef,
        attestation: {
          requirement_ids: ['ops.oncall'],
          signer: { name: 'Ada', role: 'SRE' },
          signed_at: new Date(1_000).toISOString(),
          expires_at: new Date(1_000 + 86_400_000).toISOString(),
          artifact_hash: artifactHash,
          release_target: 'local-alpha',
        },
      },
    }, 'readiness-attestation-1');
    assert.equal(ledger.getReadinessAttestation(attestationRef)?.signer.name, 'Ada');
    assert.deepEqual(ledger.getReadinessAttestation(attestationRef)?.requirementIds, ['ops.oncall']);

    // camelCase release payloads are accepted and normalized to the stored shape.
    await ledger.append({
      kind: 'release.verdict',
      payload: {
        target: 'local-alpha',
        artifactHash,
        sourceFingerprint: sha('a'),
        verdict: 'conditional',
        verdictHash,
        summary: { machine: 1, attested: 1, missing: 0 },
        caveats: ['local only'],
      },
    }, 'release-verdict-1');
    assert.equal(ledger.getReleaseVerdict(verdictHash)?.verdict, 'conditional');
    assert.deepEqual(ledger.getReleaseVerdict(verdictHash)?.caveats, ['local only']);

    await ledger.append({
      kind: 'release.approved',
      payload: {
        target: 'local-alpha',
        artifactHash,
        verdictHash,
        approver: 'Ada',
        approvedAt: new Date(1_000).toISOString(),
        approvalRef,
      },
    }, 'release-approved-1');
    assert.equal(ledger.getReleaseApproval(approvalRef)?.approver, 'Ada');
    assert.equal(ledger.listReleaseApprovals().length, 1);
  } finally {
    ledger.close();
  }

  // Cache schema is versioned and rebuilt from the log, not from a side store.
  const db = new DatabaseSync(join(root, '.ano', 'cache', 'views.db'));
  try { assert.equal(Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version), VIEW_SCHEMA_VERSION); }
  finally { db.close(); }
  await rm(join(root, '.ano', 'cache'), { recursive: true, force: true });
  const rebuilt = await Ledger.open(root, { sessionId: 'EVIDENCE-READ', clock: () => 2_000 });
  try {
    assert.equal(rebuilt.getNote(noteId)?.text, 'keep the ledger append-only');
    assert.equal(rebuilt.getAuditFinding(findingId)?.id, findingId);
    assert.equal(rebuilt.listAuditRuns().length, 1);
    assert.equal(rebuilt.getReadinessEvidence(evidenceRef)?.result, 'pass');
    assert.equal(rebuilt.getReadinessAttestation(attestationRef)?.releaseTarget, 'local-alpha');
    assert.equal(rebuilt.getReleaseVerdict(verdictHash)?.verdict, 'conditional');
    assert.equal(rebuilt.getReleaseApproval(approvalRef)?.approver, 'Ada');
  } finally {
    rebuilt.close();
  }
});

test('each cross-domain payload rejects missing or forged fields without appending', async (t) => {
  const root = await rootFor(t, 'ano-boundary-invalid-');
  const ledger = await Ledger.open(root, { sessionId: 'INVALID', clock: () => 1_000 });
  try {
    const before = (await committedEvents(root)).length;
    const at = new Date(1_000).toISOString();
    await assert.rejects(
      ledger.append({ kind: 'note.recorded', payload: { note_id: sha('1'), kind: 'decision', text: 'x', created_at: at } }),
      /memory anchor/,
    );
    await assert.rejects(
      ledger.append({ kind: 'note.recorded', payload: { note_id: sha('1'), kind: 'session_summary', text: 'x', created_at: at, anchor: { file: 'src/a.ts' } } }),
      /must not carry an anchor/,
    );
    await assert.rejects(
      ledger.append({ kind: 'audit.finding', payload: { scope: 'security', at, finding: { id: sha('2'), scope: 'security', rule: 'r', severity: 'low', message: 'm', status: 'open' } } }),
      /fingerprint/,
    );
    await assert.rejects(
      ledger.append({ kind: 'audit.finding', payload: { scope: 'security', at, finding: { id: sha('2'), scope: 'security', rule: 'r', severity: 'low', message: 'm', fingerprint: sha('3'), status: 'open', secret: 'plaintext' } } }),
      /payload is invalid/,
    );
    await assert.rejects(
      ledger.append({ kind: 'audit.completed', payload: { scope: 'security', at, ok: true, summary: { high: 0, medium: 0, low: 0, total: 0 } } }),
      /payload is invalid/,
    );
    await assert.rejects(
      ledger.append({ kind: 'readiness.evidence', payload: { requirement_id: 'common.tests', kind: 'ci_run', result: 'pass', timestamp: at } }),
      /payload is invalid/,
    );
    await assert.rejects(
      ledger.append({ kind: 'readiness.attestation', payload: { attestation_ref: sha('4'), requirement_id: 'x' } }),
      /payload is invalid/,
    );
    await assert.rejects(
      ledger.append({ kind: 'release.verdict', payload: { target: 't', artifact_hash: sha('1'), verdict: 'ready', summary: { machine: 0, attested: 0, missing: 0 } } }),
      /payload is invalid/,
    );
    await assert.rejects(
      ledger.append({ kind: 'release.approved', payload: { target: 't', artifact_hash: sha('1'), verdict_hash: sha('2'), approver: 'x', approved_at: at, approval_ref: sha('3') } }),
      /payload is invalid/,
    );
    assert.equal((await committedEvents(root)).length, before, 'rejected payloads must not append events');
  } finally {
    ledger.close();
  }
});

test('a content-addressed note id cannot be reused with different text', async (t) => {
  const root = await rootFor(t, 'ano-boundary-note-conflict-');
  const ledger = await Ledger.open(root, { sessionId: 'NOTE', clock: () => 1_000 });
  try {
    const noteId = sha('1');
    const at = new Date(1_000).toISOString();
    await ledger.append({ kind: 'note.recorded', payload: { note_id: noteId, kind: 'decision', text: 'first', created_at: at, anchor: { file: 'src/a.ts' } } }, 'note-key');
    await assert.rejects(
      ledger.append({ kind: 'note.recorded', payload: { note_id: noteId, kind: 'decision', text: 'second', created_at: at, anchor: { file: 'src/a.ts' } } }, 'other-key'),
      /Conflicting note.recorded/,
    );
    assert.equal(ledger.getNote(noteId)?.text, 'first');
  } finally {
    ledger.close();
  }
});

// ---------------------------------------------------------------------------
// 2. Historical hash and header compatibility
// ---------------------------------------------------------------------------

test('adding event kinds does not change the hash of a legacy event', () => {
  const legacy: LedgerEvent = {
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    hlc: { physical: 1, logical: 0, actor: 'A' },
    actor: 'A',
    kind: 'task.created',
    payload: { task_id: 'T', declared_files: [] },
    prev_hash: genesisHash,
  };
  assert.equal(hashEvent(legacy), 'd5c800980fc30af5c13a30519debb3c1a1796a88a3e2b529cdd1ecefd62700fe');
  assert.equal(eventChain([legacy]), true);
  assert.equal(parseSegment(encodeBatch('legacy', [legacy])).events.length, 1);
});

test('a segment header without observed stays replayable', async (t) => {
  const root = await rootFor(t, 'ano-boundary-legacy-header-');
  const header: LedgerEvent = { id: ulid(1, Buffer.alloc(10, 1)), hlc: { physical: 1, logical: 0, actor: 'OLD' }, actor: 'OLD', kind: 'segment.started', payload: { session_id: 'OLD', started_at: new Date(1).toISOString(), actor: 'OLD' }, prev_hash: genesisHash };
  const created: LedgerEvent = { id: ulid(2, Buffer.alloc(10, 2)), hlc: { physical: 2, logical: 0, actor: 'OLD' }, actor: 'OLD', kind: 'task.created', payload: { task_id: 'OLD', declared_files: ['src/old.ts'] }, prev_hash: hashEvent(header) };
  await mkdir(ledgerDir(root), { recursive: true });
  await writeFile(join(ledgerDir(root), '2020-01-01T00-00-00-000Z-OLD.jsonl'), encodeEvents([header, created]));
  const replay = replayLedger(ledgerDir(root));
  assert.deepEqual(replay.observedIssues, []);
  const ledger = await Ledger.open(root, { sessionId: 'READ', clock: () => 3 });
  try { assert.equal(ledger.getTask('OLD')?.status, 'todo'); }
  finally { ledger.close(); }
});

// ---------------------------------------------------------------------------
// 3. Completion requires recorded Gate evidence bound to current source
// ---------------------------------------------------------------------------

test('completion rejects bare status, self-reported verdicts and forged evidence', async (t) => {
  const root = await rootFor(t, 'ano-boundary-gate-');
  await initRepo(root);
  const ledger = await Ledger.open(root, { sessionId: 'GATE', clock: () => 1_000 });
  try {
    await ledger.createTask('T', ['src/a.ts', 'test/a.test.ts']);
    await ledger.updateTask('T', { status: 'in_progress' });
    await assert.rejects(ledger.updateTask('T', { status: 'done' }), GateEvidenceError);
    await assert.rejects(
      ledger.updateTask('T', { status: 'done', verdict: { status: 'done', evidenceId: 'missing' } }),
      /not recorded/,
    );
    await assert.rejects(ledger.append({ kind: 'task.updated', payload: { task_id: 'T', status: 'done' } }), GateEvidenceError);
    assert.equal(ledger.getTask('T')?.status, 'in_progress');

    const fingerprint = (await fingerprintTree(root)).hash;
    // A bare {ok:true} evidence row is not Gate evidence: it carries no verdict.
    await ledger.append({ kind: 'evidence.recorded', payload: { task_id: 'T', evidence: { id: 'forged-bare', ok: true, sourceFingerprint: fingerprint }, test_files: ['test/a.test.ts'] } }, 'forged-bare');
    await assert.rejects(
      ledger.updateTask('T', { status: 'done', verdict: { taskId: 'T', status: 'done', evidenceId: 'forged-bare', sourceFingerprint: fingerprint } }),
      /Gate verification metadata/,
    );

    // A Gate-shaped row whose fingerprint does not describe this tree is stale.
    const stale = gateEvidence(root, 'T', 'forged-stale', sha('f'));
    await ledger.append({ kind: 'evidence.recorded', payload: { task_id: 'T', evidence: stale, test_files: ['test/a.test.ts'] } }, 'forged-stale');
    await assert.rejects(
      ledger.updateTask('T', { status: 'done', verdict: { taskId: 'T', status: 'done', evidenceId: 'forged-stale', sourceFingerprint: sha('f') } }),
      /source changed/,
    );
    assert.equal(ledger.getTask('T')?.status, 'in_progress');
  } finally {
    ledger.close();
  }
});

test('Gate evidence completes a task; source edits require reopen and re-verification', async (t) => {
  const root = await rootFor(t, 'ano-boundary-gate-flow-');
  await initRepo(root);
  const ledger = await Ledger.open(root, { sessionId: 'FLOW', clock: () => 1_000 });
  try {
    await ledger.createTask('T', ['src/a.ts', 'test/a.test.ts']);
    await ledger.updateTask('T', { status: 'in_progress' });
    const fingerprint = (await fingerprintTree(root)).hash;
    const evidence = gateEvidence(root, 'T', 'gate-evidence-1', fingerprint);
    await ledger.append({ kind: 'evidence.recorded', payload: { task_id: 'T', evidence, test_files: ['test/a.test.ts'] } }, 'gate-evidence-1');

    // A test-created, untracked non-source artifact is allowed by the Gate's own
    // source-drift rule and must not block completion.
    await writeFile(join(root, 'artifact.txt'), 'x');
    const completed = await ledger.updateTask('T', {
      status: 'done',
      verdict: { taskId: 'T', status: 'done', evidenceId: 'gate-evidence-1', sourceFingerprint: fingerprint },
    }, 'gate-done-1');
    assert.equal(completed.status, 'done');
    assert.equal(completed.verdict && (completed.verdict as Record<string, unknown>).status, 'done');

    // A source rewrite invalidates the evidence fingerprint; the old done event
    // is history, but a second completion with the same evidence is refused.
    await write(root, 'src/a.ts', 'export const a = 2;\n');
    await assert.rejects(
      ledger.updateTask('T', { status: 'done', verdict: { taskId: 'T', status: 'done', evidenceId: 'gate-evidence-1', sourceFingerprint: fingerprint } }, 'gate-done-stale'),
      /source changed/,
    );

    const reopened = await ledger.reopenTask('T');
    assert.equal(reopened.status, 'in_progress');
    assert.equal(reopened.verdict, undefined, 'reopen clears the completion verdict');
    assert.equal((await ledger.reopenTask('T')).status, 'in_progress', 'reopen is idempotent while in progress');
    await assert.rejects(ledger.reopenTask('missing'), /Unknown task/);

    // New source state needs new evidence.
    const nextFingerprint = (await fingerprintTree(root)).hash;
    assert.notEqual(nextFingerprint, fingerprint);
    const nextEvidence = gateEvidence(root, 'T', 'gate-evidence-2', nextFingerprint);
    await ledger.append({ kind: 'evidence.recorded', payload: { task_id: 'T', evidence: nextEvidence, test_files: ['test/a.test.ts'] } }, 'gate-evidence-2');
    const again = await ledger.updateTask('T', {
      status: 'done',
      verdict: { taskId: 'T', status: 'done', evidenceId: 'gate-evidence-2', sourceFingerprint: nextFingerprint },
    }, 'gate-done-2');
    assert.equal(again.status, 'done');

    // The completed history is append-only: both done transitions are present.
    const updates = (await committedEvents(root)).filter((event) => event.kind === 'task.updated' && event.payload.status === 'done');
    assert.equal(updates.length, 2);
    assert.equal(updates.every((event) => event.payload.verdict !== undefined), true);
  } finally {
    ledger.close();
  }
});

test('a verdict for another task or a non-done verdict is refused', async (t) => {
  const root = await rootFor(t, 'ano-boundary-gate-cross-');
  await initRepo(root);
  const ledger = await Ledger.open(root, { sessionId: 'CROSS', clock: () => 1_000 });
  try {
    await ledger.createTask('A-TASK', ['src/a.ts']);
    await ledger.createTask('B-TASK', ['src/a.ts']);
    const fingerprint = (await fingerprintTree(root)).hash;
    const evidence = gateEvidence(root, 'A-TASK', 'cross-evidence', fingerprint);
    await ledger.append({ kind: 'evidence.recorded', payload: { task_id: 'A-TASK', evidence, test_files: ['test/a.test.ts'] } }, 'cross-evidence');
    await assert.rejects(
      ledger.updateTask('B-TASK', { status: 'done', verdict: { taskId: 'B-TASK', status: 'done', evidenceId: 'cross-evidence' } }),
      /belongs to A-TASK/,
    );
    await assert.rejects(
      ledger.updateTask('A-TASK', { status: 'done', verdict: { taskId: 'A-TASK', status: 'blocked', evidenceId: 'cross-evidence' } }),
      /verdict.status "done"/,
    );
    assert.equal(ledger.getTask('A-TASK')?.status, 'todo');
  } finally {
    ledger.close();
  }
});

// ---------------------------------------------------------------------------
// 4. Observed segment heads fail closed on deletion/tamper
// ---------------------------------------------------------------------------

test('a segment header observes the head hashes of all segments it could see', async (t) => {
  const root = await rootFor(t, 'ano-boundary-observed-');
  const first = await Ledger.open(root, { sessionId: 'OBS_A', clock: () => 1_000 });
  await first.createTask('A', ['src/a.ts']);
  first.close();
  const firstPath = (await segmentNames(root))[0]!;
  const firstEvents = scanSegment(await readFile(join(ledgerDir(root), firstPath))).events;

  const second = await Ledger.open(root, { sessionId: 'OBS_B', clock: () => 1_001 });
  await second.createTask('B', ['src/b.ts']);
  second.close();
  const secondPath = (await segmentNames(root)).find((name) => name.includes('OBS_B'))!;
  const secondHeader = scanSegment(await readFile(join(ledgerDir(root), secondPath))).events[0]!;
  const observed = secondHeader.payload.observed as Record<string, string>;
  assert.equal(observed[firstPath], hashEvent(firstEvents[0]!), 'observed head is the first event hash');
  assert.equal(Object.hasOwn(observed, secondPath), false, 'a header does not observe itself');

  // A segment created later was not observed by the older header: not an error.
  const third = await Ledger.open(root, { sessionId: 'OBS_C', clock: () => 1_002 });
  await third.createTask('C', ['src/c.ts']);
  third.close();
  const reopened = await Ledger.open(root, { sessionId: 'OBS_READ', clock: () => 1_003 });
  try { assert.deepEqual(reopened.getTasks().map((task) => task.id), ['A', 'B', 'C']); }
  finally { reopened.close(); }
});

test('deleting an observed segment fails closed with an explicit degraded error', async (t) => {
  const root = await rootFor(t, 'ano-boundary-observed-delete-');
  const first = await Ledger.open(root, { sessionId: 'DEL_A', clock: () => 1_000 });
  await first.createTask('A', ['src/a.ts']);
  first.close();
  const victim = (await segmentNames(root))[0]!;
  const second = await Ledger.open(root, { sessionId: 'DEL_B', clock: () => 1_001 });
  await second.createTask('B', ['src/b.ts']);
  second.close();

  await rm(join(ledgerDir(root), victim));
  await assert.rejects(Ledger.open(root, { sessionId: 'DEL_READ', clock: () => 1_002 }), (error: unknown) => {
    assert.ok(error instanceof LedgerIntegrityError);
    assert.match(error.message, /degraded/);
    assert.match(error.message, /observed segment .* is missing/);
    return true;
  });

  // The explicit degrade mode reports the same fact without serving a view.
  const degraded = replayLedger(ledgerDir(root), { onObservedIssue: 'degrade' });
  assert.equal(degraded.observedIssues.length, 1);
  assert.equal(degraded.observedIssues[0]?.path, victim);
  assert.equal(degraded.observedIssues[0]?.reason, 'missing');
});

test('replacing an observed segment head is detected even with a valid local chain', async (t) => {
  const root = await rootFor(t, 'ano-boundary-observed-tamper-');
  const first = await Ledger.open(root, { sessionId: 'TAM_A', clock: () => 1_000 });
  await first.createTask('A', ['src/a.ts']);
  first.close();
  const victim = (await segmentNames(root))[0]!;
  const second = await Ledger.open(root, { sessionId: 'TAM_B', clock: () => 1_001 });
  await second.createTask('B', ['src/b.ts']);
  second.close();

  const original = scanSegment(await readFile(join(ledgerDir(root), victim))).events;
  const tampered = rechain(original, (event) => ({ ...event, payload: { ...event.payload, started_at: new Date(999).toISOString() } }));
  assert.equal(eventChain(tampered), true, 'the replacement has a self-consistent chain');
  await writeFile(join(ledgerDir(root), victim), encodeEvents(tampered));
  await assert.rejects(Ledger.open(root, { sessionId: 'TAM_READ', clock: () => 1_002 }), /different head hash/);
});

// ---------------------------------------------------------------------------
// 5. CRLF compatibility for the new events
// ---------------------------------------------------------------------------

test('a CRLF checkout of cross-domain events parses and replays identically', async (t) => {
  const root = await rootFor(t, 'ano-boundary-crlf-');
  const ledger = await Ledger.open(root, { sessionId: 'CRLF_EVENT', clock: () => 1_000 });
  const noteId = sha('1');
  await ledger.append({ kind: 'note.recorded', payload: { note_id: noteId, kind: 'memory', text: 'crlf', created_at: new Date(1_000).toISOString(), anchor: { file: 'src/a.ts' } } }, 'crlf-note');
  ledger.close();
  const name = (await segmentNames(root))[0]!;
  const path = join(ledgerDir(root), name);
  const lf = await readFile(path);
  const crlf = Buffer.from(lf.toString('utf8').replaceAll('\n', '\r\n'), 'utf8');
  const lfScanned = scanSegment(lf);
  const crlfScanned = scanSegment(crlf);
  assert.deepEqual(crlfScanned.events, lfScanned.events);
  assert.equal(crlfScanned.ignoredTail, false);
  assert.equal(eventChain(crlfScanned.events), true);
  assert.deepEqual(parseSegment(crlf).events, parseSegment(lf).events);
  await writeFile(path, crlf);
  const reopened = await Ledger.open(root, { sessionId: 'CRLF_READ', clock: () => 1_001 });
  try { assert.equal(reopened.getNote(noteId)?.text, 'crlf'); }
  finally { reopened.close(); }
});
