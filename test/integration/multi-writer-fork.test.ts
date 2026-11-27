import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import test, { type TestContext } from 'node:test';
import { canonicalJson, hashEvent, type LedgerEvent } from '../../src/ledger/event.ts';
import { Ledger } from '../../src/ledger/ledger.ts';
import { replayLedger } from '../../src/ledger/replay.ts';
import { viewDigest } from '../../src/ledger/views.ts';
import {
  MWHA_ADJUDICATION_SCHEMA_VERSION,
  MWHA_EVENT_SCHEMA_VERSION,
  type MwhaAdjudication,
  type MwhaBranch,
  type MwhaWriterEvent,
} from '../../src/memory/ha-protocol.ts';
import { MultiWriterLog } from '../../src/memory/multi-writer.ts';

/**
 * T-135 integration: two independent real ledgers (tmpdirs) produce committed
 * events whose existing `hashEvent` values become two competing branches of one
 * multi-writer slot. The merge retains every branch, adjudicates explicitly and
 * replays deterministically, while the source ledger bytes and hashes stay
 * byte-for-byte identical.
 */

const WRITER_ID = 'w1';
const EPOCH = 1;
const TERM = 1;
const LOCAL_SEQ = 7;

async function rootFor(t: TestContext, prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function notePayload(label: string): Record<string, unknown> {
  return {
    note_id: sha256Hex(`fork-note:${label}`),
    kind: 'decision',
    text: `multi-writer fork fixture ${label}`,
    created_at: '2026-11-24T00:00:00.000Z',
    anchor: { file: 'src/example.ts', symbolId: `sym-${label}` },
  };
}

/** Relative path -> sha256 of raw bytes, for exact byte-level immutability checks. */
function fingerprintDirectory(directory: string): Map<string, string> {
  const files = new Map<string, string>();
  if (!existsSync(directory)) return files;
  const walk = (relativePath: string): void => {
    const absolute = relativePath.length === 0 ? directory : join(directory, relativePath);
    for (const name of readdirSync(absolute).sort()) {
      const childRelative = relativePath.length === 0 ? name : `${relativePath}/${name}`;
      const childAbsolute = join(directory, childRelative);
      if (statSync(childAbsolute).isDirectory()) walk(childRelative);
      else files.set(childRelative, sha256Hex(readFileSync(childAbsolute)));
    }
  };
  walk('');
  return files;
}

function writerEvent(hash: string): MwhaWriterEvent {
  return {
    schema_version: MWHA_EVENT_SCHEMA_VERSION,
    identity: { writer_id: WRITER_ID, epoch: EPOCH, term: TERM, local_seq: LOCAL_SEQ, ledger_event_hash: hash },
    leader: { term: TERM, leader_id: WRITER_ID, epoch: EPOCH },
  };
}

function adjudicationFor(branches: readonly MwhaBranch[], selectedBranchId: string): MwhaAdjudication {
  return {
    schema_version: MWHA_ADJUDICATION_SCHEMA_VERSION,
    conflict_key: { writer_id: WRITER_ID, epoch: EPOCH, local_seq: LOCAL_SEQ },
    branches: [...branches],
    branch_hashes: branches.map((branch) => branch.ledger_event_hash),
    status: 'resolved',
    selected_branch_id: selectedBranchId,
    resolution_reason: 'integration fixture selects the first retained branch',
  };
}

interface FixtureLedger {
  root: string;
  ledger: Ledger;
  event: LedgerEvent;
  hash: string;
  ledgerFingerprint: Map<string, string>;
  viewDigest: string;
}

async function committedFixtureLedger(t: TestContext, prefix: string, label: string): Promise<FixtureLedger> {
  const root = await rootFor(t, prefix);
  const ledger = await Ledger.open(root, { actor: `writer-${label}`, sessionId: `session-${label}` });
  const appended = await ledger.append({ kind: 'note.recorded', payload: notePayload(label) });
  assert.ok(appended.event, 'fixture ledger append must produce an event');
  const event = appended.event;
  const replay = replayLedger(join(root, '.ano', 'ledger'));
  const replayed = replay.entries.find((entry) => entry.event.id === event.id);
  assert.ok(replayed, 'the committed event must replay from disk');
  assert.equal(canonicalJson(replayed.event), canonicalJson(event), 'replayed bytes must equal the appended event');

  return {
    root,
    ledger,
    event,
    hash: hashEvent(event),
    ledgerFingerprint: fingerprintDirectory(join(root, '.ano', 'ledger')),
    viewDigest: viewDigest(replay.entries),
  };
}

test('real ledger fork is retained, adjudicated and replayed deterministically without touching ledger bytes', { timeout: 60_000 }, async (t) => {
  const first = await committedFixtureLedger(t, 'ano-mw-fork-a-', 'alpha');
  const second = await committedFixtureLedger(t, 'ano-mw-fork-b-', 'beta');

  assert.notEqual(first.hash, second.hash, 'the two committed ledger events must differ');

  try {
  // Two nodes claim the same (writer_id, epoch, local_seq): a real fork.
  const left = new MultiWriterLog();
  const right = new MultiWriterLog();
  const appendPair = (log: MultiWriterLog, firstHash: string, secondHash: string, firstCommit: number, secondCommit: number): void => {
    log.append({
      event: writerEvent(firstHash),
      ledgerEvent: firstHash === first.hash ? first.event : second.event,
      ledgerEventHash: firstHash,
      commitIndex: firstCommit,
      evidenceId: `ev-${firstHash.slice(0, 12)}`,
    });
    log.append({
      event: writerEvent(secondHash),
      ledgerEvent: secondHash === second.hash ? second.event : first.event,
      ledgerEventHash: secondHash,
      commitIndex: secondCommit,
      evidenceId: `ev-${secondHash.slice(0, 12)}`,
    });
  };
  appendPair(left, first.hash, second.hash, 7, 8);
  appendPair(right, second.hash, first.hash, 8, 7);

  // Full branch retention and conflict status.
  for (const log of [left, right]) {
    assert.equal(log.size, 2);
    const forks = log.forkReport();
    assert.equal(forks.conflicts.length, 1);
    assert.deepEqual(
      forks.conflicts[0]!.branches.map((branch) => branch.ledger_event_hash),
      [first.hash, second.hash].sort(),
    );
    const state = log.replay().states.find((candidate) => candidate.conflict_key.writer_id === WRITER_ID)!;
    assert.equal(state.status, 'conflicted');
    assert.equal(state.winning_branch_id, null);
    assert.equal(state.evidence_id, null);
    assert.deepEqual([...state.referenced_branch_hashes].sort(), [first.hash, second.hash].sort());
  }

  // Replay determinism across arrival permutations and repeated replay.
  const leftProjection = left.replay();
  const rightProjection = right.replay();
  assert.equal(leftProjection.hash, left.replay().hash);
  assert.equal(leftProjection.hash, rightProjection.hash);
  assert.deepEqual(leftProjection.states, rightProjection.states);
  assert.deepEqual(leftProjection.entries, rightProjection.entries);

  // Duplicate ingest has zero side effects.
  const sizeBefore = left.size;
  const hashBefore = left.replay().hash;
  const duplicateReport = left.ingest([
    { entry: left.getEntries()[0]!.entry, ledgerEvent: left.getEntries()[0]!.ledgerEvent, ledgerEventHash: left.getEntries()[0]!.ledgerEventHash },
    { entry: left.getEntries()[1]!.entry, ledgerEvent: left.getEntries()[1]!.ledgerEvent, ledgerEventHash: left.getEntries()[1]!.ledgerEventHash },
  ]);
  assert.equal(duplicateReport.duplicates, 2);
  assert.equal(duplicateReport.applied, 0);
  assert.equal(left.size, sizeBefore);
  assert.equal(left.replay().hash, hashBefore);

  // Explicit adjudication over the complete branch set converges both replicas.
  const branches = left.forkReport().conflicts[0]!.branches;
  const adjudication = adjudicationFor(branches, branches[0]!.branch_id);
  const storedLeft = left.adjudicate(adjudication, { evidenceId: 'ev-final-A' });
  const storedRight = right.adjudicate(adjudication, { evidenceId: 'ev-final-A' });
  assert.equal(storedLeft.branches.length, 2);
  assert.equal(storedRight.branches.length, 2);

  const convergedLeft = left.replay();
  const convergedRight = right.replay();
  assert.equal(convergedLeft.hash, convergedRight.hash, 'adjudicated projection stays deterministic');
  const convergedState = convergedLeft.states.find((candidate) => candidate.conflict_key.writer_id === WRITER_ID)!;
  assert.equal(convergedState.status, 'committed');
  assert.equal(convergedState.winning_branch_id, branches[0]!.branch_id);
  assert.equal(convergedState.evidence_id, 'ev-final-A');
  assert.equal(convergedState.produces_gate_evidence, true);
  assert.deepEqual([...convergedState.referenced_branch_hashes].sort(), [first.hash, second.hash].sort());
  assert.equal(convergedState.adjudication?.adjudication.selected_branch_id, branches[0]!.branch_id);

  // Old ledger events: bytes, canonical JSON and hashEvent results are unchanged.
  for (const fixture of [first, second]) {
    const ledgerDir = join(fixture.root, '.ano', 'ledger');
    assert.deepEqual(fingerprintDirectory(ledgerDir), fixture.ledgerFingerprint, 'ledger bytes changed during merge/replay');
    const replay = replayLedger(ledgerDir);
    assert.equal(viewDigest(replay.entries), fixture.viewDigest);
    const expected = fixture.event;
    const actual = replay.entries.find((entry) => entry.event.id === expected.id)!.event;
    assert.equal(canonicalJson(actual), canonicalJson(expected));
    assert.equal(hashEvent(actual), fixture.hash);
    assert.equal(hashEvent(actual), hashEvent(expected));
  }

  // The merge never rewrote the supplied ledger event objects: their hashes are
  // still exactly the values captured when they were committed.
  assert.equal(hashEvent(first.event), first.hash);
  assert.equal(hashEvent(second.event), second.hash);
  } finally {
    first.ledger.close();
    second.ledger.close();
  }
});
