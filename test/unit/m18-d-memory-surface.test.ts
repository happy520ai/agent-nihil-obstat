import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Ledger } from '../../src/ledger/ledger.ts';
import { ANCHOR_PROBE_REQUEST_SCHEMA_VERSION, type AnchorProbeSnapshot } from '../../src/memory/probe-contract.ts';
import {
  memoryFactSurface,
  memoryProbeSource,
  memoryProbeSurface,
  noteRelateSurface,
  noteReviseSurface,
  recallConnectedSurface,
  recallSurface,
} from '../../src/surface/memory.ts';
import { cleanup, gitProject, temp } from '../helpers/m18-d-fixtures.ts';

async function ledgerFor(root: string): Promise<Ledger> {
  return Ledger.open(root);
}

/** Type narrowing for deliberately malformed inputs (missing/excess fields). */
function asReviseInput(value: object): Parameters<typeof noteReviseSurface>[1] {
  return value as Parameters<typeof noteReviseSurface>[1];
}
function asRelateInput(value: object): Parameters<typeof noteRelateSurface>[1] {
  return value as Parameters<typeof noteRelateSurface>[1];
}
function asFactInput(value: object): Parameters<typeof memoryFactSurface>[1] {
  return value as Parameters<typeof memoryFactSurface>[1];
}

test('M18-D recallConnected rejects non-connected sources, foreign fields and bad limits', async () => {
  const root = await temp('ano m18d recall ');
  try {
    await assert.rejects(recallConnectedSurface(root, {}), /requires source='connected'/);
    await assert.rejects(recallConnectedSurface(root, { source: 'connected', keyword: 'x' }), /does not accept field "keyword"/);
    await assert.rejects(recallConnectedSurface(root, { source: 'connected', query: '' }), /non-empty/);
    await assert.rejects(recallConnectedSurface(root, { source: 'connected', query: 'a'.repeat(4097) }), /4096/);
    await assert.rejects(recallConnectedSurface(root, { source: 'connected', query: 'ok', limit: 0 }), /between 1 and 100/);
    await assert.rejects(recallConnectedSurface(root, { source: 'connected', query: 'ok', limit: 101 }), /between 1 and 100/);
    await assert.rejects(recallConnectedSurface(root, { source: 'connected', query: 'ok', limit: 1.5 }), /between 1 and 100/);
  } finally {
    await cleanup(root);
  }
});

test('M18-D recallSurface fails closed on a missing root, a non-package root and a non-Git root', async () => {
  const missingBase = await temp('ano m18d missing ');
  const missing = join(missingBase, 'gone');
  await assert.rejects(recallSurface(missing, {}), /Project root does not exist/);

  const plain = await temp('ano m18d plain ');
  try {
    await assert.rejects(recallSurface(plain, {}), /No package\.json/);
    await writeFile(join(plain, 'package.json'), JSON.stringify({ name: 'plain' }));
    await assert.rejects(recallSurface(plain, {}), /Git work tree is required/);
  } finally {
    await cleanup(plain);
  }

  // A real Git project without synthetic fixtures is not configured, never an error.
  const root = await gitProject();
  try {
    const result = await recallSurface(root, {});
    assert.equal(result.status, 'not_configured');
    assert.deepEqual(result.hits, []);
  } finally {
    await cleanup(root);
  }
});

test('M18-D revise input validation rejects bad idem keys, supersedes declarations and intervals', async () => {
  const root = await gitProject();
  let ledger: Ledger | undefined;
  try {
    ledger = await ledgerFor(root);
    const base = {
      fact_key: 'local.storage.engine',
      kind: 'memory' as const,
      text: 'sqlite',
      reason: 'genesis',
      effective_from: null,
      effective_to: null,
    };
    await assert.rejects(noteReviseSurface(ledger, { ...base, idem_key: 'x'.repeat(129), supersedes: [] }), /idem_key/);
    const { effective_from: _from, effective_to: _to, ...withoutInterval } = base;
    await assert.rejects(noteReviseSurface(ledger, asReviseInput({ ...withoutInterval, idem_key: 'R1', supersedes: [] })), /effective_from/);
    await assert.rejects(
      noteReviseSurface(ledger, { ...base, idem_key: 'R1', supersedes: [], effective_from: '2026-02-01T00:00:00.000Z', effective_to: '2026-01-01T00:00:00.000Z' }),
      /effective_from must not be after effective_to/,
    );
    await assert.rejects(noteReviseSurface(ledger, { ...base, idem_key: 'R1', supersedes: ['nope'] }), /supersedes must be an explicit array/);
    await assert.rejects(noteReviseSurface(ledger, asReviseInput({ ...base, idem_key: 'R1', supersedes: [], unknown: 1 })), /does not accept field "unknown"/);
  } finally {
    ledger?.close();
    await cleanup(root);
  }
});

test('M18-D relate input validation rejects malformed refs and reasons', async () => {
  const root = await gitProject();
  let ledger: Ledger | undefined;
  try {
    ledger = await ledgerFor(root);
    const refA = `01J${'A'.repeat(23)}`;
    const refB = `01J${'B'.repeat(23)}`;
    const base = { idem_key: 'RL1', edge: 'depends_on' as const, from_ref: refA, to_ref: refB };
    await assert.rejects(noteRelateSurface(ledger, { ...base, from_ref: 'bad' }), /from_ref must be a ledger event id/);
    await assert.rejects(noteRelateSurface(ledger, { ...base, to_ref: 'bad' }), /to_ref must be a ledger event id/);
    await assert.rejects(noteRelateSurface(ledger, { ...base, edge: 'friends' as never }), /edge must be one of/);
    await assert.rejects(noteRelateSurface(ledger, { ...base, reason: '' }), /reason must be 1\.\.2000/);
    await assert.rejects(noteRelateSurface(ledger, { ...base, reason: 'x'.repeat(2001) }), /reason must be 1\.\.2000/);
    await assert.rejects(noteRelateSurface(ledger, asRelateInput({ ...base, extra: 1 })), /does not accept field "extra"/);
  } finally {
    ledger?.close();
    await cleanup(root);
  }
});

test('M18-D fact read validation rejects malformed keys and temporal combinations', async () => {
  const root = await gitProject();
  let ledger: Ledger | undefined;
  try {
    ledger = await ledgerFor(root);
    await assert.rejects(memoryFactSurface(ledger, { fact_key: 'BAD KEY' }), /fact_key must match/);
    await assert.rejects(memoryFactSurface(ledger, { fact_key: 'local.storage.engine', mode: 'historical' }), /historical requires as_of/);
    await assert.rejects(memoryFactSurface(ledger, { fact_key: 'local.storage.engine', as_of: '2026-01-01T00:00:00.000Z' }), /as_of requires mode historical/);
    await assert.rejects(
      memoryFactSurface(ledger, { fact_key: 'local.storage.engine', mode: 'historical', as_of: '2026-01-01T00:00:00.000Z', now: '2026-01-01T00:00:00.000Z' }),
      /now applies to current reads only/,
    );
    await assert.rejects(memoryFactSurface(ledger, asFactInput({ fact_key: 'local.storage.engine', nope: 1 })), /does not accept field "nope"/);
    const unknown = await memoryFactSurface(ledger, { fact_key: 'local.storage.engine' });
    assert.equal(unknown.fact.found, false);
    assert.equal(unknown.versions.length, 0);
  } finally {
    ledger?.close();
    await cleanup(root);
  }
});

test('M18-D memoryProbeSource resolves a symbol-table relocation through the anchor source', async () => {
  const root = await gitProject();
  let ledger: Ledger | undefined;
  try {
    ledger = await ledgerFor(root);
    const appended = await ledger.append({
      kind: 'note.recorded',
      payload: {
        note_id: 'd'.repeat(64),
        kind: 'decision',
        text: 'relocated anchor',
        created_at: '2026-11-25T00:00:00.000Z',
        anchor: { file: 'src/alpha.ts', qualifiedName: 'beta' },
      },
    }, 'm18d:relocate:note');
    const snapshot = {
      project_scope: 'local',
      ledger_digest: 'a'.repeat(64),
      graph_revision: null,
      source_fingerprint: null,
      connected_digest: null,
    } as AnchorProbeSnapshot;
    const source = memoryProbeSource(ledger, snapshot, {
      anchorSource: {
        findSymbolById: () => undefined,
        findSymbolByQualifiedName: (qualifiedName, file) =>
          file === 'src/alpha.ts' && qualifiedName === 'beta'
            ? { id: 'sym-beta', file, name: 'beta', qualifiedName }
            : undefined,
        readFile: () => undefined,
        symbolFreshness: 'fresh',
      },
    });
    const candidate = source.entries().find((entry) => entry.record_ref === appended.event?.id);
    assert.ok(candidate, 'the governed note is a probe candidate');
    assert.equal(candidate.anchor.status, 'relocated');
    assert.equal(candidate.source_health, 'verified_at_snapshot');
  } finally {
    ledger?.close();
    await cleanup(root);
  }
});

test('M18-D a forward correction over a retracted head is refused instead of reporting success', async () => {
  const root = await gitProject();
  let ledger: Ledger | undefined;
  try {
    ledger = await ledgerFor(root);
    const base = {
      idem_key: 'm18d:retract:genesis',
      fact_key: 'local.storage.engine',
      kind: 'memory' as const,
      text: 'engine v1',
      reason: 'genesis',
      effective_from: null,
      effective_to: null,
    };
    const genesis = await noteReviseSurface(ledger, { ...base, supersedes: [] });
    await ledger.append({
      kind: 'memory.revised',
      payload: { intent: 'retract', fact_key: 'local.storage.engine', supersedes: [genesis.eventId], reason: 'mis-classified' },
    }, 'm18d:retract:retract');
    await assert.rejects(
      noteReviseSurface(ledger, { ...base, idem_key: 'm18d:retract:correct', supersedes: [genesis.eventId], text: 'engine v2' }),
      /not superseded/,
    );
  } finally {
    ledger?.close();
    await cleanup(root);
  }
});

test('M18-D memoryProbeSource exposes the projection candidates and memoryProbeSurface validates the request envelope', async () => {
  const root = await gitProject();
  let ledger: Ledger | undefined;
  try {
    ledger = await ledgerFor(root);
    const snapshot = {
      project_scope: 'local',
      ledger_digest: 'a'.repeat(64),
      graph_revision: null,
      source_fingerprint: null,
      connected_digest: null,
    } as AnchorProbeSnapshot;
    const source = memoryProbeSource(ledger, snapshot);
    assert.deepEqual(source.entries(), []);
    assert.deepEqual(source.edges(), []);

    assert.throws(
      () => memoryProbeSurface(ledger!, { schema_version: 'wrong', request_id: 'r1', root, project_scope: 'local' }),
      /schema validation/,
    );
    assert.throws(
      () => memoryProbeSurface(ledger!, {
        schema_version: ANCHOR_PROBE_REQUEST_SCHEMA_VERSION,
        request_id: 'r1',
        root: join(root, 'elsewhere'),
        project_scope: 'local',
      }),
      /does not match the open ledger/,
    );
  } finally {
    ledger?.close();
    await cleanup(root);
  }
});
