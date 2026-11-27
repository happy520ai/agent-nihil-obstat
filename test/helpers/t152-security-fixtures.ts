/**
 * T-152 / QF-03 security-branch fixtures.
 *
 * Shared builders for the two exclusive T-152 test files. Nothing here writes
 * to `.pm/`, `src/` or the repository; every helper is pure or tmpdir-bound.
 */

import { ledgerEventSchema, type LedgerEvent } from '../../src/ledger/event.ts';
import {
  ANCHOR_PROBE_REQUEST_SCHEMA_VERSION,
  type AnchorProbeClusterMetadata,
  type AnchorProbeSnapshot,
} from '../../src/memory/probe-contract.ts';
import type { ProbeCandidate, ProbeEdge, ProbeEntryQuery } from '../../src/memory/probe.ts';
import {
  probeSnapshotIdentity,
  type ProbeEvidencePayload,
  type ProbeProvenanceView,
  type ProbeStatusView,
  type ProbeStore,
} from '../../src/memory/probe-store.ts';

export const T152_HASH_A = 'a'.repeat(64);
export const T152_HASH_B = 'b'.repeat(64);
export const T152_HASH_C = 'c'.repeat(64);
export const T152_HASH_D = 'd'.repeat(64);
export const T152_AT = '2026-11-21T00:00:00.000Z';

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function t152Ulid(seed: number): string {
  let value = seed >>> 0;
  let out = '';
  for (let index = 0; index < 26; index += 1) {
    out = ULID_ALPHABET[value % 32] + out;
    value = Math.floor(value / 32) + index * 7 + 1;
  }
  return out;
}

export function t152LedgerEvent(label: string, seed: number): LedgerEvent {
  return ledgerEventSchema.parse({
    id: t152Ulid(seed),
    hlc: { physical: 1_700_000_000_000 + seed, logical: 0, actor: 't152-writer' },
    actor: 't152-writer',
    kind: 'note.recorded',
    payload: { label, seed },
    idem_key: `t152-${label}`,
    prev_hash: '0'.repeat(64),
  });
}

export function t152Snapshot(overrides: Partial<AnchorProbeClusterMetadata> = {}): AnchorProbeSnapshot {
  const metadata: AnchorProbeClusterMetadata = {
    schema_version: 'anchorprobe.cluster.v1',
    project_scope: 'proj',
    cluster_epoch: 'epoch-1',
    commit_index: 0,
    replica_id: 'local',
    replica_commit_index: 0,
    consistency: 'local',
    max_lag: null,
    partial: false,
    failed_nodes: [],
    evidence_digest: T152_HASH_A,
    ...overrides,
  };
  return {
    project_scope: metadata.project_scope,
    ledger_digest: T152_HASH_A,
    graph_revision: null,
    source_fingerprint: T152_HASH_B,
    connected_digest: null,
    cluster: metadata,
  };
}

/** Snapshot with no cluster metadata at all, to exercise scope fallbacks. */
export function t152BareSnapshot(projectScope: string): AnchorProbeSnapshot {
  return {
    project_scope: projectScope,
    ledger_digest: T152_HASH_A,
    graph_revision: null,
    source_fingerprint: T152_HASH_B,
    connected_digest: null,
  };
}

export function t152Candidate(recordRef: string, contentHash = T152_HASH_A): ProbeCandidate {
  return {
    record_ref: recordRef,
    fact_key: 'local.storage.engine',
    task_id: null,
    file: null,
    symbol: null,
    source: { kind: 'native_note' },
    source_health: 'verified_at_snapshot',
    status: 'active',
    content: `content of ${recordRef}`,
    content_hash: contentHash,
    recorded_at: T152_AT,
    effective_from: null,
    effective_to: null,
    superseded_by: null,
    version: null,
    anchor: { status: 'none', file: null },
    qualifiers: [],
  };
}

export function t152Request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: ANCHOR_PROBE_REQUEST_SCHEMA_VERSION,
    request_id: 't152-req',
    root: 'F:/project',
    project_scope: 'proj',
    required_facts: ['local.storage.engine'],
    ...overrides,
  };
}

function matchesQuery(query: ProbeEntryQuery, record: ProbeCandidate): boolean {
  if (query.fact_key !== undefined && record.fact_key !== query.fact_key) return false;
  if (query.task_id !== undefined && record.task_id !== query.task_id) return false;
  if (query.file !== undefined && record.file !== query.file) return false;
  if (query.symbol !== undefined && record.symbol !== query.symbol) return false;
  return true;
}

export class T152FakeStore implements ProbeStore {
  private readonly records: readonly ProbeCandidate[];
  private readonly snapshotValue: AnchorProbeSnapshot;
  private readonly edgeList: readonly ProbeEdge[];
  private readonly commitIndexFn?: (() => number | undefined) | undefined;

  constructor(records: readonly ProbeCandidate[], options: { snapshot?: AnchorProbeSnapshot; edges?: readonly ProbeEdge[]; replicaCommitIndex?: () => number | undefined } = {}) {
    this.records = records;
    this.snapshotValue = options.snapshot ?? t152Snapshot();
    this.edgeList = options.edges ?? [];
    this.commitIndexFn = options.replicaCommitIndex;
  }

  get snapshot(): AnchorProbeSnapshot {
    return this.snapshotValue;
  }

  replicaCommitIndex(): number | undefined {
    if (this.commitIndexFn !== undefined) return this.commitIndexFn();
    return this.snapshotValue.cluster?.replica_commit_index;
  }

  candidates(query?: ProbeEntryQuery): readonly ProbeCandidate[] {
    if (query === undefined || Object.keys(query).length === 0) return this.records;
    return this.records.filter((record) => matchesQuery(query, record));
  }

  adjacency(): readonly ProbeEdge[] {
    return this.edgeList;
  }

  evidence(recordRef: string): ProbeEvidencePayload | undefined {
    const record = this.find(recordRef);
    return record === undefined
      ? undefined
      : {
        record_ref: record.record_ref,
        content_hash: record.content_hash,
        status: record.status,
        source_health: record.source_health,
        recorded_at: record.recorded_at,
        effective_from: record.effective_from,
        source: record.source,
        content: record.content,
      };
  }

  status(recordRef: string): ProbeStatusView | undefined {
    const record = this.find(recordRef);
    return record === undefined
      ? undefined
      : {
        record_ref: record.record_ref,
        status: record.status,
        eligibility: record.qualifiers.includes('legacy_unreviewed') ? 'legacy_unreviewed' : 'governed',
        version: record.version,
        superseded_by: record.superseded_by,
        effective_from: record.effective_from,
        effective_to: record.effective_to,
      };
  }

  provenance(recordRef: string): ProbeProvenanceView | undefined {
    const record = this.find(recordRef);
    return record === undefined
      ? undefined
      : {
        record_ref: record.record_ref,
        source: record.source,
        source_health: record.source_health,
        qualifiers: record.qualifiers,
        anchor: record.anchor,
      };
  }

  snapshotIdentity() {
    return probeSnapshotIdentity(this.snapshotValue);
  }

  private find(recordRef: string): ProbeCandidate | undefined {
    return this.records.find((record) => record.record_ref === recordRef);
  }
}

export function t152CodeOf(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) return String((error as { code?: unknown }).code);
  return undefined;
}
