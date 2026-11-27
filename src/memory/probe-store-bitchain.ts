import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canonicalJson } from '../ledger/event.ts';
import {
  applyEventToDb,
  initViews,
  readMemoryEdges,
  readMemoryRecords,
  viewDigest,
  type MemoryRecord,
  type ViewReplayEntry,
} from '../ledger/views.ts';
import { anchorProbeSnapshotSchema, type AnchorProbeSnapshot } from './probe-contract.ts';
import {
  probeSnapshotIdentity,
  ProbeStoreCacheError,
  SqliteProbeStore,
  type ProbeEvidencePayload,
  type ProbeProvenanceView,
  type ProbeSnapshotIdentity,
  type ProbeStatusView,
  type ProbeStore,
} from './probe-store.ts';
import type { ProbeAnchorHealth, ProbeCandidate, ProbeEdge, ProbeEntryQuery } from './probe.ts';

/**
 * BitChain experimental ProbeStore (T-059 / AP-22).
 *
 * This is an optional, rebuildable cache of the same committed projection the
 * SQLite baseline uses. It is NOT wired into the Surface or the default probe
 * path, and it is NOT an authoritative write source: every byte of record
 * content is derived by replaying committed `ViewReplayEntry[]` events through
 * `views.ts`, exactly like `ProjectedProbeStore`. The ledger stays authoritative
 * and this file may be deleted at any time.
 *
 * Physical format (see docs/anchor-probe-bitchain-format.md):
 *   - a 128-byte header carrying magic/version/endianness, region offsets and a
 *     body hash;
 *   - an immutable record region: bounded segments of framed records, each with
 *     a fixed-size record header plus a canonical-JSON tail holding the whole
 *     projection record;
 *   - a mutable index region: a sorted record directory (ref -> exact segment
 *     offset) plus typed adjacency entries;
 *   - a canonical-JSON manifest binding the file to the committed source digest
 *     and the sampled snapshot.
 *
 * Integrity model: the header carries `body_hash` over record region + index
 * region + manifest; the manifest carries `header_hash` over the header fields
 * excluding `body_hash`. Together they cover every byte of the file. A missing,
 * truncated, bit-flipped, wrong-magic or wrong-version file throws
 * `BitChainFormatError` with an explicit code; `openProbeStoreWithFallback`
 * converts that into the SQLite baseline instead of answering from a cache it
 * cannot trust.
 *
 * Honest limits: this is pure `node:buffer`/`node:fs`, so there is no native
 * mmap and no power-loss durability claim. Writes are temp-file + rename; the
 * Windows directory-fsync limits documented for the rest of the repository
 * still apply.
 */

export const BITCHAIN_MAGIC = 'ANOBITC1';
export const BITCHAIN_FORMAT_VERSION = 1;
/** uint16 written little-endian; a byte-swapped file reads 0x3412 instead. */
export const BITCHAIN_ENDIAN_MARKER = 0x1234;
export const BITCHAIN_HEADER_BYTES = 128;
export const BITCHAIN_BODY_HASH_OFFSET = 88;
export const BITCHAIN_RECORD_HEADER_BYTES_DEFAULT = 128;
export const BITCHAIN_RECORD_HEADER_BYTES_ALLOWED = [64, 96, 128] as const;
export const BITCHAIN_SEGMENT_PAYLOAD_BYTES_DEFAULT = 65_536;
export const BITCHAIN_SEGMENT_PAYLOAD_BYTES_MIN = 1024;

const SEGMENT_MAGIC = 'ANORSEG1';
const SEGMENT_HEADER_BYTES = 64;
const INDEX_MAGIC = 'ANOINX01';
const INDEX_HEADER_BYTES = 80;
const DIRECTORY_ENTRY_BYTES = 48;
const ADJACENCY_ENTRY_BYTES = 72;
const REF_FIELD_BYTES = 32;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

/** Failure codes are stable API: callers match on them, never on message text. */
export type BitChainFailureCode =
  | 'truncated'
  | 'bad_magic'
  | 'bad_version'
  | 'bad_endian'
  | 'bad_header'
  | 'bad_bounds'
  | 'bad_body_hash'
  | 'bad_manifest'
  | 'bad_header_hash'
  | 'bad_segment'
  | 'bad_segment_hash'
  | 'bad_record'
  | 'bad_record_hash'
  | 'bad_index'
  | 'bad_index_hash'
  | 'bad_edge';

/** Raised when a BitChain cache cannot be trusted. `reason` is the diagnostic. */
export class BitChainFormatError extends Error {
  readonly code: BitChainFailureCode;
  readonly reason: string;
  constructor(code: BitChainFailureCode, reason: string) {
    super(`BitChain format error [${code}]: ${reason}`);
    this.name = 'BitChainFormatError';
    this.code = code;
    this.reason = reason;
  }
}

export interface BitChainWriteOptions {
  /** Fixed record-header size. 64/96/128 are measurement parameters, not optima. */
  readonly recordHeaderBytes?: 64 | 96 | 128;
  /** Maximum record payload bytes per segment before the writer continues in a new segment. */
  readonly segmentBytes?: number;
}

export interface BitChainWriteResult {
  readonly path: string;
  readonly recordCount: number;
  readonly edgeCount: number;
  readonly sourceDigest: string;
  readonly snapshotHash: string;
  readonly recordHeaderBytes: number;
  readonly segmentBytes: number;
  readonly recordRegionSha256: string;
  readonly indexRegionSha256: string;
}

export interface ProbeStoreFallback {
  readonly store: ProbeStore;
  readonly backend: 'bitchain' | 'sqlite';
  /** Explicit corruption reason when the BitChain cache failed closed. */
  readonly fallbackReason: string | null;
}

interface ProjectedRecords {
  readonly records: readonly MemoryRecord[];
  readonly edges: readonly { fromRef: string; toRef: string; kind: string }[];
}

interface RecordLocation {
  readonly segmentIndex: number;
  readonly offsetInSegment: number;
  readonly totalLength: number;
}

interface ParsedRecord {
  readonly record: MemoryRecord;
  readonly segmentIndex: number;
  readonly offsetInSegment: number;
  readonly totalLength: number;
}

interface ParsedBitChain {
  readonly recordHeaderBytes: number;
  readonly segmentBytes: number;
  readonly snapshot: AnchorProbeSnapshot;
  readonly candidates: readonly ProbeCandidate[];
  readonly edges: readonly ProbeEdge[];
  readonly sourceDigest: string;
  readonly snapshotHash: string;
}

/** Recompute the header `body_hash` over the three body regions. Exported for tests. */
export function bitchainBodyHash(recordRegion: Buffer, indexRegion: Buffer, manifest: Buffer): string {
  return createHash('sha256').update(recordRegion).update(indexRegion).update(manifest).digest('hex');
}

/** Recompute the manifest `header_hash` over the header fields excluding `body_hash`. */
export function bitchainHeaderHash(header: Buffer): string {
  return createHash('sha256').update(header.subarray(0, BITCHAIN_BODY_HASH_OFFSET))
    .update(header.subarray(120, BITCHAIN_HEADER_BYTES))
    .digest('hex');
}

/** Content identity rule copied from `views.ts`: sha256 over the canonical record payload. */
export function contentHashOfRecord(value: {
  kind: string;
  text: string;
  anchor?: Record<string, unknown>;
}): string {
  return createHash('sha256')
    .update(canonicalJson({
      kind: value.kind,
      text: value.text,
      ...(value.anchor === undefined ? {} : { anchor: value.anchor }),
    }))
    .digest('hex');
}

// ---------------------------------------------------------------------------
// Mapping rules (identical to probe-store.ts; duplicated so the frozen module
// is not modified and the two backends cannot drift through a shared helper).
// ---------------------------------------------------------------------------

function candidateFromRecord(record: MemoryRecord): ProbeCandidate {
  const anchor = record.anchor;
  const file = anchor !== undefined && typeof anchor.file === 'string' ? anchor.file : null;
  const symbol = anchor === undefined
    ? null
    : typeof anchor.qualifiedName === 'string'
      ? anchor.qualifiedName
      : typeof anchor.symbolId === 'string' ? anchor.symbolId : null;
  const governed = record.eligibility === 'governed';
  const source: ProbeCandidate['source'] = file === null
    ? { kind: 'native_note' }
    : { kind: 'native_note', path: file };
  const anchorHealth: ProbeAnchorHealth = { status: file === null ? 'none' : 'exact', file };
  return {
    record_ref: record.recordRef,
    fact_key: record.factKey,
    task_id: null,
    file,
    symbol,
    source,
    source_health: governed ? 'verified_at_snapshot' : 'unknown',
    status: record.status,
    content: record.text,
    content_hash: record.contentHash,
    recorded_at: record.recordedAt,
    effective_from: record.effectiveFrom,
    effective_to: record.effectiveTo,
    superseded_by: record.supersededBy ?? null,
    version: record.version,
    anchor: anchorHealth,
    qualifiers: governed ? [] : ['legacy_unreviewed'],
  };
}

function edgeKind(kind: string): ProbeEdge['kind'] {
  return kind === 'depends_on' || kind === 'explains' || kind === 'related_to' ? kind : 'unknown';
}

function matchesDimensions(candidate: ProbeCandidate, query: ProbeEntryQuery): boolean {
  if (query.fact_key !== undefined && candidate.fact_key !== query.fact_key) return false;
  if (query.task_id !== undefined && candidate.task_id !== query.task_id) return false;
  if (query.file !== undefined && candidate.file !== query.file) return false;
  if (query.symbol !== undefined && candidate.symbol !== query.symbol) return false;
  return true;
}

function evidenceOf(candidate: ProbeCandidate): ProbeEvidencePayload {
  return {
    record_ref: candidate.record_ref,
    content_hash: candidate.content_hash,
    status: candidate.status,
    source_health: candidate.source_health,
    recorded_at: candidate.recorded_at,
    effective_from: candidate.effective_from,
    source: candidate.source,
    content: candidate.content,
  };
}

function statusOf(candidate: ProbeCandidate): ProbeStatusView {
  return {
    record_ref: candidate.record_ref,
    status: candidate.status,
    eligibility: candidate.qualifiers.includes('legacy_unreviewed') ? 'legacy_unreviewed' : 'governed',
    version: candidate.version,
    superseded_by: candidate.superseded_by,
    effective_from: candidate.effective_from,
    effective_to: candidate.effective_to,
  };
}

function provenanceOf(candidate: ProbeCandidate): ProbeProvenanceView {
  return {
    record_ref: candidate.record_ref,
    source: candidate.source,
    source_health: candidate.source_health,
    qualifiers: candidate.qualifiers,
    anchor: candidate.anchor,
  };
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Code tables
// ---------------------------------------------------------------------------

const RECORD_STATUSES = ['active', 'superseded', 'conflicted', 'retracted'] as const;
const ELIGIBILITIES = ['governed', 'legacy_unreviewed'] as const;
const SOURCE_KINDS = ['native_note', 'code_read', 'connected', 'history', 'unknown'] as const;
const EDGE_KINDS = ['depends_on', 'explains', 'related_to', 'supersedes', 'conflicts_with', 'unknown'] as const;
const PROVENANCES = ['confirmed', 'heuristic', 'unknown'] as const;

function indexOfOrThrow<T extends string>(values: readonly T[], value: string, code: BitChainFailureCode, what: string): T {
  const index = (values as readonly string[]).indexOf(value);
  if (index < 0) throw new BitChainFormatError(code, `unknown ${what}: ${value}`);
  return values[index]!;
}

function statusCodeOf(status: string): number {
  return (RECORD_STATUSES as readonly string[]).indexOf(status);
}

function eligibilityCodeOf(eligibility: string): number {
  return (ELIGIBILITIES as readonly string[]).indexOf(eligibility);
}

function sourceKindCodeOf(kind: string): number {
  return (SOURCE_KINDS as readonly string[]).indexOf(kind);
}

function edgeKindFromCode(code: number): ProbeEdge['kind'] {
  if (code < 0 || code >= EDGE_KINDS.length) throw new BitChainFormatError('bad_edge', `unknown edge kind code ${String(code)}`);
  return EDGE_KINDS[code]!;
}

function provenanceFromCode(code: number): ProbeEdge['provenance'] {
  if (code < 0 || code >= PROVENANCES.length) throw new BitChainFormatError('bad_edge', `unknown edge provenance code ${String(code)}`);
  return PROVENANCES[code]!;
}

function provenanceCodeOf(provenance: ProbeEdge['provenance']): number {
  return (PROVENANCES as readonly string[]).indexOf(provenance);
}

// ---------------------------------------------------------------------------
// Small buffer helpers
// ---------------------------------------------------------------------------

function readPaddedAscii(buffer: Buffer, offset: number, length: number): string {
  const slice = buffer.subarray(offset, offset + length);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul === -1 ? slice.length : nul).toString('ascii');
}

function writePaddedAscii(buffer: Buffer, offset: number, length: number, value: string): void {
  if (Buffer.byteLength(value, 'ascii') > length) {
    throw new BitChainFormatError('bad_record', `value does not fit in ${String(length)} bytes`);
  }
  buffer.write(value, offset, length, 'ascii');
}

function readU64(buffer: Buffer, offset: number, code: BitChainFailureCode, what: string): bigint {
  if (offset < 0 || offset + 8 > buffer.length) {
    throw new BitChainFormatError(code, `${what} is outside the file`);
  }
  return buffer.readBigUInt64LE(offset);
}

function isoFromMs(ms: bigint, code: BitChainFailureCode): string {
  const value = Number(ms);
  if (!Number.isSafeInteger(value)) throw new BitChainFormatError(code, 'timestamp is not a safe integer');
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new BitChainFormatError(code, 'timestamp is not a valid date');
  return date.toISOString();
}

function nullableIsoFromMs(ms: bigint, code: BitChainFailureCode): string | null {
  return ms < 0n ? null : isoFromMs(ms, code);
}

/** Compare two optional ISO timestamps by instant, not by textual form. */
function sameInstant(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return left === right;
  return Date.parse(left) === Date.parse(right);
}

function sha256Hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

function normalizeOptions(options: BitChainWriteOptions): { recordHeaderBytes: 64 | 96 | 128; segmentBytes: number } {
  const recordHeaderBytes = options.recordHeaderBytes ?? BITCHAIN_RECORD_HEADER_BYTES_DEFAULT;
  if (!BITCHAIN_RECORD_HEADER_BYTES_ALLOWED.includes(recordHeaderBytes)) {
    throw new Error(`unsupported recordHeaderBytes ${String(options.recordHeaderBytes)}; expected 64, 96 or 128`);
  }
  const segmentBytes = options.segmentBytes ?? BITCHAIN_SEGMENT_PAYLOAD_BYTES_DEFAULT;
  if (!Number.isSafeInteger(segmentBytes) || segmentBytes < BITCHAIN_SEGMENT_PAYLOAD_BYTES_MIN || segmentBytes > 0xffff_ffff) {
    throw new Error(`unsupported segmentBytes ${String(options.segmentBytes)}; expected ${BITCHAIN_SEGMENT_PAYLOAD_BYTES_MIN}..4294967295`);
  }
  return { recordHeaderBytes, segmentBytes };
}

/** Replay committed events through the same projection the SQLite baseline uses. */
function projectEntries(entries: readonly ViewReplayEntry[]): ProjectedRecords {
  const db = new DatabaseSync(':memory:');
  try {
    initViews(db);
    for (const entry of entries) applyEventToDb(db, entry.event, entry.segment);
    return {
      records: readMemoryRecords(db),
      edges: readMemoryEdges(db).map((edge) => ({ fromRef: edge.fromRef, toRef: edge.toRef, kind: edge.edge })),
    };
  } finally {
    db.close();
  }
}

function recordTailJson(record: MemoryRecord): string {
  return canonicalJson({
    record_ref: record.recordRef,
    fact_key: record.factKey,
    kind: record.kind,
    text: record.text,
    anchor: record.anchor ?? null,
    note_id: record.noteId ?? null,
    status: record.status,
    eligibility: record.eligibility,
    supersedes_ref: record.supersedesRef ?? null,
    superseded_by: record.supersededBy ?? null,
    content_hash: record.contentHash,
    recorded_at: record.recordedAt,
    effective_from: record.effectiveFrom,
    effective_to: record.effectiveTo,
    version: record.version,
    event_id: record.eventId,
  });
}

function encodeRecord(record: MemoryRecord, recordHeaderBytes: number): Buffer {
  if (!SHA256_PATTERN.test(record.contentHash)) {
    throw new BitChainFormatError('bad_record', `record ${record.recordRef} has an invalid content hash`);
  }
  const tail = Buffer.from(recordTailJson(record), 'utf8');
  const header = Buffer.alloc(recordHeaderBytes);
  writePaddedAscii(header, 0, REF_FIELD_BYTES, record.recordRef);
  Buffer.from(record.contentHash, 'hex').copy(header, 32);
  if (recordHeaderBytes >= 96) {
    header.writeBigUInt64LE(BigInt(recordHeaderBytes), 64);
    header.writeUInt32LE(tail.length, 72);
    header[76] = statusCodeOf(record.status);
    header[77] = eligibilityCodeOf(record.eligibility);
    header[78] = sourceKindCodeOf(candidateFromRecord(record).source.kind);
    header.writeUInt32LE(record.version, 80);
    header.writeBigInt64LE(BigInt(Date.parse(record.recordedAt)), 84);
    if (recordHeaderBytes >= 128) {
      header.writeBigInt64LE(BigInt(record.effectiveFrom === null ? -1 : Date.parse(record.effectiveFrom)), 92);
      header.writeBigInt64LE(BigInt(record.effectiveTo === null ? -1 : Date.parse(record.effectiveTo)), 100);
      header.writeUInt16LE(0, 108);
    }
  }
  return Buffer.concat([header, tail]);
}

function encodeRecordRegion(
  records: readonly MemoryRecord[],
  recordHeaderBytes: number,
  segmentBytes: number,
): { region: Buffer; locations: readonly RecordLocation[] } {
  const segments: Buffer[] = [];
  const locations: RecordLocation[] = [];
  let payloadParts: Buffer[] = [];
  let payloadBytes = 0;
  let segmentRecords = 0;
  let segmentIndex = 0;

  const flush = (): void => {
    const payload = Buffer.concat(payloadParts);
    const header = Buffer.alloc(SEGMENT_HEADER_BYTES);
    header.write(SEGMENT_MAGIC, 0, 'ascii');
    header.writeBigUInt64LE(BigInt(segmentIndex), 8);
    header.writeBigUInt64LE(BigInt(segmentRecords), 16);
    header.writeBigUInt64LE(BigInt(payload.length), 24);
    createHash('sha256').update(payload).digest().copy(header, 32);
    segments.push(header, payload);
    payloadParts = [];
    payloadBytes = 0;
    segmentRecords = 0;
    segmentIndex += 1;
  };

  for (const record of records) {
    const encoded = encodeRecord(record, recordHeaderBytes);
    const framed = Buffer.allocUnsafe(4 + encoded.length);
    framed.writeUInt32LE(encoded.length, 0);
    encoded.copy(framed, 4);
    // A segment continues when the next record would overflow it. A record
    // larger than the whole segment still gets its own segment; records are
    // never split.
    if (payloadBytes > 0 && payloadBytes + framed.length > segmentBytes) flush();
    locations.push({ segmentIndex, offsetInSegment: payloadBytes, totalLength: encoded.length });
    payloadParts.push(framed);
    payloadBytes += framed.length;
    segmentRecords += 1;
  }
  if (payloadParts.length > 0) flush();
  return { region: Buffer.concat(segments), locations };
}

function encodeIndexRegion(
  locations: readonly RecordLocation[],
  records: readonly MemoryRecord[],
  edges: readonly ProbeEdge[],
): Buffer {
  const directory = Buffer.alloc(records.length * DIRECTORY_ENTRY_BYTES);
  records.forEach((record, index) => {
    const location = locations[index];
    if (location === undefined) throw new BitChainFormatError('bad_index', `missing location for ${record.recordRef}`);
    const base = index * DIRECTORY_ENTRY_BYTES;
    writePaddedAscii(directory, base, REF_FIELD_BYTES, record.recordRef);
    directory.writeBigUInt64LE(BigInt(location.segmentIndex), base + 32);
    directory.writeUInt32LE(location.offsetInSegment, base + 40);
    directory.writeUInt32LE(location.totalLength, base + 44);
  });

  const adjacency = Buffer.alloc(edges.length * ADJACENCY_ENTRY_BYTES);
  edges.forEach((edge, index) => {
    const base = index * ADJACENCY_ENTRY_BYTES;
    writePaddedAscii(adjacency, base, REF_FIELD_BYTES, edge.from);
    writePaddedAscii(adjacency, base + REF_FIELD_BYTES, REF_FIELD_BYTES, edge.to);
    adjacency[base + 64] = (EDGE_KINDS as readonly string[]).indexOf(edge.kind);
    adjacency[base + 65] = provenanceCodeOf(edge.provenance);
  });

  const body = Buffer.concat([directory, adjacency]);
  const header = Buffer.alloc(INDEX_HEADER_BYTES);
  header.write(INDEX_MAGIC, 0, 'ascii');
  header.writeUInt16LE(BITCHAIN_FORMAT_VERSION, 8);
  header.writeUInt16LE(0, 10);
  header.writeBigUInt64LE(BigInt(records.length), 12);
  header.writeBigUInt64LE(BigInt(edges.length), 20);
  header.writeBigUInt64LE(BigInt(INDEX_HEADER_BYTES), 28);
  header.writeBigUInt64LE(BigInt(INDEX_HEADER_BYTES + directory.length), 36);
  createHash('sha256').update(header.subarray(0, 48)).update(body).digest().copy(header, 48);
  return Buffer.concat([header, body]);
}

function buildFile(
  entries: readonly ViewReplayEntry[],
  snapshot: AnchorProbeSnapshot,
  options: BitChainWriteOptions,
): { file: Buffer; result: Omit<BitChainWriteResult, 'path'> } {
  const params = normalizeOptions(options);
  const projected = projectEntries(entries);
  const records = [...projected.records].sort((left, right) => compareStrings(left.recordRef, right.recordRef));
  const edges: ProbeEdge[] = projected.edges
    .map((edge) => ({ from: edge.fromRef, to: edge.toRef, kind: edgeKind(edge.kind), provenance: 'confirmed' as const }))
    .sort((left, right) =>
      compareStrings(left.from, right.from) || compareStrings(left.to, right.to) || compareStrings(left.kind, right.kind));

  const sourceDigest = viewDigest(entries);
  const snapshotHash = createHash('sha256').update(canonicalJson(snapshot)).digest('hex');
  const { region: recordRegion, locations } = encodeRecordRegion(records, params.recordHeaderBytes, params.segmentBytes);
  const indexRegion = encodeIndexRegion(locations, records, edges);
  const recordRegionSha256 = sha256Hex(recordRegion);
  const indexRegionSha256 = sha256Hex(indexRegion);

  const header = Buffer.alloc(BITCHAIN_HEADER_BYTES);
  header.write(BITCHAIN_MAGIC, 0, 'ascii');
  header.writeUInt16LE(BITCHAIN_FORMAT_VERSION, 8);
  header.writeUInt16LE(BITCHAIN_ENDIAN_MARKER, 10);
  header.writeUInt32LE(params.recordHeaderBytes, 12);
  header.writeBigUInt64LE(BigInt(params.segmentBytes), 16);
  header.writeBigUInt64LE(BigInt(BITCHAIN_HEADER_BYTES), 24);
  header.writeBigUInt64LE(BigInt(recordRegion.length), 32);
  const indexOffset = BITCHAIN_HEADER_BYTES + recordRegion.length;
  header.writeBigUInt64LE(BigInt(indexOffset), 40);
  header.writeBigUInt64LE(BigInt(indexRegion.length), 48);
  const manifestOffset = indexOffset + indexRegion.length;
  header.writeBigUInt64LE(BigInt(manifestOffset), 56);
  header.writeBigUInt64LE(BigInt(records.length), 72);
  header.writeBigUInt64LE(BigInt(edges.length), 80);
  // body_hash (88..119) stays zero until the manifest exists.

  // The manifest contains header_hash, and header_hash covers the manifest
  // length field. Break the cycle with a fixed-width placeholder: a sha256 hex
  // digest is always 64 bytes, so swapping the placeholder for the real digest
  // cannot change the manifest length.
  const manifestFields = {
    format: 'anchorprobe.bitchain.v1',
    format_version: BITCHAIN_FORMAT_VERSION,
    header_bytes: BITCHAIN_HEADER_BYTES,
    record_header_bytes: params.recordHeaderBytes,
    segment_bytes: params.segmentBytes,
    record_count: records.length,
    edge_count: edges.length,
    source_digest: sourceDigest,
    snapshot,
    snapshot_hash: snapshotHash,
    record_region_sha256: recordRegionSha256,
    index_region_sha256: indexRegionSha256,
  };
  const placeholder = Buffer.from(canonicalJson({ ...manifestFields, header_hash: '0'.repeat(64) }), 'utf8');
  header.writeBigUInt64LE(BigInt(placeholder.length), 64);
  const headerHash = bitchainHeaderHash(header);
  const manifest = Buffer.from(canonicalJson({ ...manifestFields, header_hash: headerHash }), 'utf8');
  if (manifest.length !== placeholder.length) {
    throw new BitChainFormatError('bad_header', 'manifest length changed while inserting the header hash');
  }
  const bodyHash = createHash('sha256').update(recordRegion).update(indexRegion).update(manifest).digest();
  bodyHash.copy(header, BITCHAIN_BODY_HASH_OFFSET);

  const file = Buffer.concat([header, recordRegion, indexRegion, manifest]);
  return {
    file,
    result: {
      recordCount: records.length,
      edgeCount: edges.length,
      sourceDigest,
      snapshotHash,
      recordHeaderBytes: params.recordHeaderBytes,
      segmentBytes: params.segmentBytes,
      recordRegionSha256,
      indexRegionSha256,
    },
  };
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

function parseRecordTail(raw: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new BitChainFormatError('bad_record', 'record tail is not valid JSON');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new BitChainFormatError('bad_record', 'record tail is not an object');
  }
  return value as Record<string, unknown>;
}

function stringField(tail: Record<string, unknown>, key: string): string {
  const value = tail[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new BitChainFormatError('bad_record', `record field ${key} is not a non-empty string`);
  }
  return value;
}

function nullableStringField(tail: Record<string, unknown>, key: string): string | null {
  const value = tail[key];
  if (value === null) return null;
  if (typeof value === 'string') return value;
  throw new BitChainFormatError('bad_record', `record field ${key} is not a string or null`);
}

function intField(tail: Record<string, unknown>, key: string): number {
  const value = tail[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new BitChainFormatError('bad_record', `record field ${key} is not a nonnegative integer`);
  }
  return value;
}

function nullableIsoField(tail: Record<string, unknown>, key: string): string | null {
  const value = tail[key];
  if (value === null) return null;
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return value;
  throw new BitChainFormatError('bad_record', `record field ${key} is not an ISO datetime or null`);
}

function enumField<T extends string>(tail: Record<string, unknown>, key: string, allowed: readonly T[]): T {
  return indexOfOrThrow(allowed, stringField(tail, key), 'bad_record', key);
}

function parseStoredRecord(recordBytes: Buffer, recordHeaderBytes: number): MemoryRecord {
  if (recordBytes.length < recordHeaderBytes) {
    throw new BitChainFormatError('bad_record', 'record is shorter than its fixed header');
  }
  const header = recordBytes.subarray(0, recordHeaderBytes);
  const tailBytes = recordBytes.subarray(recordHeaderBytes);
  const recordRef = readPaddedAscii(header, 0, REF_FIELD_BYTES);
  if (recordRef.length === 0) throw new BitChainFormatError('bad_record', 'record header has an empty record_ref');
  const headerHashValue = header.subarray(32, 64).toString('hex');
  if (!SHA256_PATTERN.test(headerHashValue)) {
    throw new BitChainFormatError('bad_record', `record ${recordRef} has an invalid content hash`);
  }
  if (recordHeaderBytes >= 96) {
    const declaredOffset = Number(header.readBigUInt64LE(64));
    const declaredLength = header.readUInt32LE(72);
    if (declaredOffset !== recordHeaderBytes || declaredLength !== tailBytes.length) {
      throw new BitChainFormatError('bad_record', `record ${recordRef} header offsets do not match the framed length`);
    }
  }

  const tail = parseRecordTail(tailBytes.toString('utf8'));
  const tailRef = stringField(tail, 'record_ref');
  if (tailRef !== recordRef) {
    throw new BitChainFormatError('bad_record', `record ${recordRef} tail names a different record_ref`);
  }
  const kind = stringField(tail, 'kind');
  const text = stringField(tail, 'text');
  const status = enumField(tail, 'status', RECORD_STATUSES);
  const eligibility = enumField(tail, 'eligibility', ELIGIBILITIES);
  const contentHash = stringField(tail, 'content_hash');
  if (!SHA256_PATTERN.test(contentHash) || contentHash !== headerHashValue) {
    throw new BitChainFormatError('bad_record', `record ${recordRef} content hash does not match its fixed header`);
  }
  const recordedAt = stringField(tail, 'recorded_at');
  if (Number.isNaN(Date.parse(recordedAt))) {
    throw new BitChainFormatError('bad_record', `record ${recordRef} recorded_at is not an ISO datetime`);
  }
  const version = intField(tail, 'version');
  const factKey = nullableStringField(tail, 'fact_key');
  const noteId = nullableStringField(tail, 'note_id');
  const supersedesRef = nullableStringField(tail, 'supersedes_ref');
  const supersededBy = nullableStringField(tail, 'superseded_by');
  const effectiveFrom = nullableIsoField(tail, 'effective_from');
  const effectiveTo = nullableIsoField(tail, 'effective_to');
  const eventId = stringField(tail, 'event_id');
  const anchorValue = tail.anchor;
  if (anchorValue !== null && anchorValue !== undefined) {
    if (typeof anchorValue !== 'object' || Array.isArray(anchorValue)) {
      throw new BitChainFormatError('bad_record', `record ${recordRef} anchor is not an object or null`);
    }
  }
  const anchor = anchorValue === null || anchorValue === undefined ? undefined : anchorValue as Record<string, unknown>;

  const record: MemoryRecord = {
    recordRef,
    factKey,
    kind,
    text,
    status,
    eligibility,
    contentHash,
    recordedAt,
    effectiveFrom,
    effectiveTo,
    version,
    eventId,
    ...(anchor === undefined ? {} : { anchor }),
    ...(noteId === null ? {} : { noteId }),
    ...(supersedesRef === null ? {} : { supersedesRef }),
    ...(supersededBy === null ? {} : { supersededBy }),
  };

  // Fast-header fields are a cache of the tail, never the source of truth.
  if (recordHeaderBytes >= 96) {
    if (header[76] !== statusCodeOf(status)) throw new BitChainFormatError('bad_record', `record ${recordRef} status disagrees with its fixed header`);
    if (header[77] !== eligibilityCodeOf(eligibility)) throw new BitChainFormatError('bad_record', `record ${recordRef} eligibility disagrees with its fixed header`);
    if (header.readUInt32LE(80) !== version) throw new BitChainFormatError('bad_record', `record ${recordRef} version disagrees with its fixed header`);
    if (!sameInstant(isoFromMs(header.readBigInt64LE(84), 'bad_record'), recordedAt)) {
      throw new BitChainFormatError('bad_record', `record ${recordRef} recorded_at disagrees with its fixed header`);
    }
    if (header[78] !== sourceKindCodeOf(candidateFromRecord(record).source.kind)) {
      throw new BitChainFormatError('bad_record', `record ${recordRef} source kind disagrees with its fixed header`);
    }
  }
  if (recordHeaderBytes >= 128) {
    if (!sameInstant(nullableIsoFromMs(header.readBigInt64LE(92), 'bad_record'), effectiveFrom)) {
      throw new BitChainFormatError('bad_record', `record ${recordRef} effective_from disagrees with its fixed header`);
    }
    if (!sameInstant(nullableIsoFromMs(header.readBigInt64LE(100), 'bad_record'), effectiveTo)) {
      throw new BitChainFormatError('bad_record', `record ${recordRef} effective_to disagrees with its fixed header`);
    }
  }

  // The digest is a checksum over the stored原文, not a substitute for it.
  const recomputed = contentHashOfRecord({ kind, text, ...(anchor === undefined ? {} : { anchor }) });
  if (recomputed !== contentHash) {
    throw new BitChainFormatError('bad_record_hash', `record ${recordRef} content hash does not match its stored content`);
  }
  return record;
}

function parseRecordRegion(region: Buffer, recordHeaderBytes: number): readonly ParsedRecord[] {
  const records: ParsedRecord[] = [];
  let offset = 0;
  let expectedSegment = 0;
  while (offset < region.length) {
    if (region.length - offset < SEGMENT_HEADER_BYTES) {
      throw new BitChainFormatError('bad_segment', 'truncated segment header');
    }
    if (region.subarray(offset, offset + 8).toString('ascii') !== SEGMENT_MAGIC) {
      throw new BitChainFormatError('bad_segment', `bad segment magic at offset ${String(offset)}`);
    }
    const segmentIndex = Number(readU64(region, offset + 8, 'bad_segment', 'segment index'));
    const recordCount = Number(readU64(region, offset + 16, 'bad_segment', 'segment record count'));
    const payloadLength = Number(readU64(region, offset + 24, 'bad_segment', 'segment payload length'));
    if (segmentIndex !== expectedSegment) {
      throw new BitChainFormatError('bad_segment', `segment ${String(segmentIndex)} is out of sequence`);
    }
    const payloadStart = offset + SEGMENT_HEADER_BYTES;
    const payloadEnd = payloadStart + payloadLength;
    if (!Number.isSafeInteger(payloadEnd) || payloadEnd > region.length) {
      throw new BitChainFormatError('bad_segment', `segment ${String(segmentIndex)} payload is outside the record region`);
    }
    const payload = region.subarray(payloadStart, payloadEnd);
    const expected = region.subarray(offset + 32, offset + 64);
    if (!createHash('sha256').update(payload).digest().equals(expected)) {
      throw new BitChainFormatError('bad_segment_hash', `segment ${String(segmentIndex)} payload hash mismatch`);
    }
    let position = 0;
    for (let index = 0; index < recordCount; index += 1) {
      if (position + 4 > payload.length) throw new BitChainFormatError('bad_record', `segment ${String(segmentIndex)} record framing is truncated`);
      const totalLength = payload.readUInt32LE(position);
      if (position + 4 + totalLength > payload.length) {
        throw new BitChainFormatError('bad_record', `segment ${String(segmentIndex)} record ${String(index)} is truncated`);
      }
      const recordBytes = payload.subarray(position + 4, position + 4 + totalLength);
      records.push({
        record: parseStoredRecord(recordBytes, recordHeaderBytes),
        segmentIndex,
        offsetInSegment: position,
        totalLength,
      });
      position += 4 + totalLength;
    }
    if (position !== payload.length) {
      throw new BitChainFormatError('bad_segment', `segment ${String(segmentIndex)} has ${String(payload.length - position)} trailing bytes`);
    }
    offset = payloadEnd;
    expectedSegment += 1;
  }
  return records;
}

interface ParsedIndex {
  readonly refs: readonly string[];
  readonly locations: readonly RecordLocation[];
  readonly adjacency: readonly ProbeEdge[];
}

function parseIndexRegion(region: Buffer): ParsedIndex {
  if (region.length < INDEX_HEADER_BYTES) throw new BitChainFormatError('bad_index', 'index region is shorter than its header');
  if (region.subarray(0, 8).toString('ascii') !== INDEX_MAGIC) throw new BitChainFormatError('bad_index', 'bad index magic');
  if (region.readUInt16LE(8) !== BITCHAIN_FORMAT_VERSION) throw new BitChainFormatError('bad_index', 'bad index version');
  const recordCount = Number(readU64(region, 12, 'bad_index', 'index record count'));
  const edgeCount = Number(readU64(region, 20, 'bad_index', 'index edge count'));
  const directoryOffset = Number(readU64(region, 28, 'bad_index', 'directory offset'));
  const adjacencyOffset = Number(readU64(region, 36, 'bad_index', 'adjacency offset'));
  const expectedHash = createHash('sha256').update(region.subarray(0, 48)).update(region.subarray(INDEX_HEADER_BYTES)).digest();
  if (!region.subarray(48, 80).equals(expectedHash)) throw new BitChainFormatError('bad_index_hash', 'index region hash mismatch');
  if (directoryOffset !== INDEX_HEADER_BYTES) throw new BitChainFormatError('bad_index', 'directory offset is not the index header end');
  if (adjacencyOffset !== INDEX_HEADER_BYTES + recordCount * DIRECTORY_ENTRY_BYTES) {
    throw new BitChainFormatError('bad_index', 'adjacency offset does not follow the directory');
  }
  if (adjacencyOffset + edgeCount * ADJACENCY_ENTRY_BYTES !== region.length) {
    throw new BitChainFormatError('bad_index', 'adjacency region does not end at the index region end');
  }

  const refs: string[] = [];
  const locations: RecordLocation[] = [];
  for (let index = 0; index < recordCount; index += 1) {
    const base = directoryOffset + index * DIRECTORY_ENTRY_BYTES;
    refs.push(readPaddedAscii(region, base, REF_FIELD_BYTES));
    locations.push({
      segmentIndex: Number(readU64(region, base + 32, 'bad_index', 'directory segment index')),
      offsetInSegment: region.readUInt32LE(base + 40),
      totalLength: region.readUInt32LE(base + 44),
    });
  }
  for (let index = 1; index < refs.length; index += 1) {
    if (!(refs[index - 1]! < refs[index]!)) {
      throw new BitChainFormatError('bad_index', 'directory refs are not strictly sorted and unique');
    }
  }

  const adjacency: ProbeEdge[] = [];
  for (let index = 0; index < edgeCount; index += 1) {
    const base = adjacencyOffset + index * ADJACENCY_ENTRY_BYTES;
    const from = readPaddedAscii(region, base, REF_FIELD_BYTES);
    const to = readPaddedAscii(region, base + REF_FIELD_BYTES, REF_FIELD_BYTES);
    if (from.length === 0 || to.length === 0) throw new BitChainFormatError('bad_edge', 'adjacency entry has an empty endpoint');
    adjacency.push({
      from,
      to,
      kind: edgeKindFromCode(region[base + 64]!),
      provenance: provenanceFromCode(region[base + 65]!),
    });
  }
  adjacency.sort((left, right) =>
    compareStrings(left.from, right.from) || compareStrings(left.to, right.to) || compareStrings(left.kind, right.kind));
  return { refs, locations, adjacency };
}

function parseBitChainFile(file: Buffer): ParsedBitChain {
  if (file.length < BITCHAIN_HEADER_BYTES) {
    throw new BitChainFormatError('truncated', `file is ${String(file.length)} bytes, shorter than the ${String(BITCHAIN_HEADER_BYTES)}-byte header`);
  }
  if (file.subarray(0, 8).toString('ascii') !== BITCHAIN_MAGIC) {
    throw new BitChainFormatError('bad_magic', 'file magic is not ANOBITC1');
  }
  if (file.readUInt16LE(8) !== BITCHAIN_FORMAT_VERSION) {
    throw new BitChainFormatError('bad_version', `file version ${String(file.readUInt16LE(8))} is not ${String(BITCHAIN_FORMAT_VERSION)}`);
  }
  if (file.readUInt16LE(10) !== BITCHAIN_ENDIAN_MARKER) {
    throw new BitChainFormatError('bad_endian', 'file endianness marker does not match little-endian');
  }
  const recordHeaderBytes = file.readUInt32LE(12);
  if (!BITCHAIN_RECORD_HEADER_BYTES_ALLOWED.includes(recordHeaderBytes as 64 | 96 | 128)) {
    throw new BitChainFormatError('bad_header', `record header size ${String(recordHeaderBytes)} is not 64, 96 or 128`);
  }
  const segmentBytes = Number(readU64(file, 16, 'bad_bounds', 'segment size'));
  const recordOffset = Number(readU64(file, 24, 'bad_bounds', 'record region offset'));
  const recordLength = Number(readU64(file, 32, 'bad_bounds', 'record region length'));
  const indexOffset = Number(readU64(file, 40, 'bad_bounds', 'index region offset'));
  const indexLength = Number(readU64(file, 48, 'bad_bounds', 'index region length'));
  const manifestOffset = Number(readU64(file, 56, 'bad_bounds', 'manifest offset'));
  const manifestLength = Number(readU64(file, 64, 'bad_bounds', 'manifest length'));
  const recordCount = Number(readU64(file, 72, 'bad_bounds', 'record count'));
  const edgeCount = Number(readU64(file, 80, 'bad_bounds', 'edge count'));

  if (recordOffset !== BITCHAIN_HEADER_BYTES) throw new BitChainFormatError('bad_bounds', 'record region does not start after the header');
  if (indexOffset !== recordOffset + recordLength) throw new BitChainFormatError('bad_bounds', 'index region is not contiguous with the record region');
  if (manifestOffset !== indexOffset + indexLength) throw new BitChainFormatError('bad_bounds', 'manifest is not contiguous with the index region');
  if (manifestOffset + manifestLength !== file.length) throw new BitChainFormatError('bad_bounds', 'manifest does not end at the file end');
  if (![segmentBytes, recordLength, indexLength, manifestLength, recordCount, edgeCount].every(Number.isSafeInteger)) {
    throw new BitChainFormatError('bad_bounds', 'header numeric field is not a safe integer');
  }

  const recordRegion = file.subarray(recordOffset, recordOffset + recordLength);
  const indexRegion = file.subarray(indexOffset, indexOffset + indexLength);
  const manifestBytes = file.subarray(manifestOffset, manifestOffset + manifestLength);

  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    throw new BitChainFormatError('bad_manifest', 'manifest is not valid JSON');
  }
  if (manifestValue === null || typeof manifestValue !== 'object' || Array.isArray(manifestValue)) {
    throw new BitChainFormatError('bad_manifest', 'manifest is not an object');
  }
  const manifest = manifestValue as Record<string, unknown>;
  const headerHash = bitchainHeaderHash(file.subarray(0, BITCHAIN_HEADER_BYTES));
  if (manifest.header_hash !== headerHash) {
    throw new BitChainFormatError('bad_header_hash', 'manifest header_hash does not match the header');
  }
  if (!file.subarray(BITCHAIN_BODY_HASH_OFFSET, BITCHAIN_BODY_HASH_OFFSET + 32)
    .equals(createHash('sha256').update(recordRegion).update(indexRegion).update(manifestBytes).digest())) {
    throw new BitChainFormatError('bad_body_hash', 'header body_hash does not match the record/index/manifest regions');
  }
  if (manifest.format !== 'anchorprobe.bitchain.v1' || manifest.format_version !== BITCHAIN_FORMAT_VERSION) {
    throw new BitChainFormatError('bad_manifest', 'manifest format is not anchorprobe.bitchain.v1');
  }
  if (manifest.header_bytes !== BITCHAIN_HEADER_BYTES || manifest.record_header_bytes !== recordHeaderBytes
    || manifest.segment_bytes !== segmentBytes || manifest.record_count !== recordCount || manifest.edge_count !== edgeCount) {
    throw new BitChainFormatError('bad_manifest', 'manifest counts or parameters disagree with the header');
  }
  if (manifest.record_region_sha256 !== sha256Hex(recordRegion) || manifest.index_region_sha256 !== sha256Hex(indexRegion)) {
    throw new BitChainFormatError('bad_manifest', 'manifest region hash disagrees with the region bytes');
  }
  const snapshotParse = anchorProbeSnapshotSchema.safeParse(manifest.snapshot);
  if (!snapshotParse.success) throw new BitChainFormatError('bad_manifest', 'manifest snapshot is not a valid AnchorProbeSnapshot');
  const snapshot = snapshotParse.data;
  const snapshotHash = createHash('sha256').update(canonicalJson(snapshot)).digest('hex');
  if (manifest.snapshot_hash !== snapshotHash) {
    throw new BitChainFormatError('bad_manifest', 'manifest snapshot_hash does not match the snapshot');
  }
  const sourceDigest = manifest.source_digest;
  if (typeof sourceDigest !== 'string' || !SHA256_PATTERN.test(sourceDigest)) {
    throw new BitChainFormatError('bad_manifest', 'manifest source_digest is not a sha256 hex digest');
  }

  const parsedRecords = parseRecordRegion(recordRegion, recordHeaderBytes);
  const parsedIndex = parseIndexRegion(indexRegion);
  if (parsedRecords.length !== recordCount || parsedIndex.refs.length !== recordCount || parsedIndex.adjacency.length !== edgeCount) {
    throw new BitChainFormatError('bad_index', 'record/edge counts disagree with the header');
  }

  const byLocation = new Map<string, ParsedRecord>();
  for (const parsed of parsedRecords) {
    byLocation.set(`${parsed.segmentIndex}:${parsed.offsetInSegment}`, parsed);
  }
  if (byLocation.size !== parsedRecords.length) throw new BitChainFormatError('bad_record', 'duplicate record location');

  const refSet = new Set<string>();
  const candidates: ProbeCandidate[] = [];
  for (let index = 0; index < parsedIndex.refs.length; index += 1) {
    const ref = parsedIndex.refs[index]!;
    const location = parsedIndex.locations[index]!;
    const parsed = byLocation.get(`${location.segmentIndex}:${location.offsetInSegment}`);
    if (parsed === undefined) throw new BitChainFormatError('bad_index', `directory entry ${ref} points at no record`);
    if (parsed.record.recordRef !== ref) throw new BitChainFormatError('bad_index', `directory entry ${ref} points at ${parsed.record.recordRef}`);
    if (parsed.totalLength !== location.totalLength) throw new BitChainFormatError('bad_index', `directory entry ${ref} has a stale length`);
    if (refSet.has(ref)) throw new BitChainFormatError('bad_index', `duplicate directory ref ${ref}`);
    refSet.add(ref);
    candidates.push(candidateFromRecord(parsed.record));
  }
  for (const edge of parsedIndex.adjacency) {
    if (!refSet.has(edge.from) || !refSet.has(edge.to)) {
      throw new BitChainFormatError('bad_edge', `edge ${edge.from} -> ${edge.to} does not resolve inside this ledger`);
    }
  }

  return {
    recordHeaderBytes,
    segmentBytes,
    snapshot,
    candidates,
    edges: parsedIndex.adjacency,
    sourceDigest,
    snapshotHash,
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class BitChainProbeStore implements ProbeStore {
  readonly filePath: string;
  private recordHeaderBytesValue: number;
  private segmentBytesValue: number;
  private snapshotValue: AnchorProbeSnapshot;
  private candidatesValue: readonly ProbeCandidate[] = [];
  private edgesValue: readonly ProbeEdge[] = [];
  private byRefValue = new Map<string, ProbeCandidate>();
  private sourceDigestValue = '';
  private snapshotHashValue = '';
  private closed = false;

  private constructor(filePath: string) {
    this.filePath = filePath;
    this.recordHeaderBytesValue = BITCHAIN_RECORD_HEADER_BYTES_DEFAULT;
    this.segmentBytesValue = BITCHAIN_SEGMENT_PAYLOAD_BYTES_DEFAULT;
    this.snapshotValue = {
      project_scope: '',
      ledger_digest: '0'.repeat(64),
      graph_revision: null,
      source_fingerprint: null,
      connected_digest: null,
    };
  }

  static databasePath(root: string): string {
    return join(resolve(root), '.ano', 'cache', 'probe-store.bitchain');
  }

  /** Open and fully validate a BitChain file. Corruption throws BitChainFormatError. */
  static open(filePath: string): BitChainProbeStore {
    const store = new BitChainProbeStore(filePath);
    store.load();
    return store;
  }

  /**
   * Rebuild the file from committed events. The record region is regenerated
   * from the replay, never patched in place; the index region is rebuilt from
   * the same replay. The old file is replaced atomically (temp + rename).
   */
  static write(
    filePath: string,
    entries: readonly ViewReplayEntry[],
    snapshot: AnchorProbeSnapshot,
    options: BitChainWriteOptions = {},
  ): BitChainWriteResult {
    const { file, result } = buildFile(entries, snapshot, options);
    mkdirSync(dirname(resolve(filePath)), { recursive: true });
    const temporary = `${filePath}.tmp-${process.pid}`;
    writeFileSync(temporary, file);
    renameSync(temporary, filePath);
    return { path: filePath, ...result };
  }

  get snapshot(): AnchorProbeSnapshot {
    this.assertOpen();
    return this.snapshotValue;
  }

  candidates(query?: ProbeEntryQuery): readonly ProbeCandidate[] {
    this.assertOpen();
    if (query === undefined || Object.keys(query).length === 0) return this.candidatesValue;
    return this.candidatesValue.filter((candidate) => matchesDimensions(candidate, query));
  }

  adjacency(ref?: string): readonly ProbeEdge[] {
    this.assertOpen();
    if (ref === undefined) return this.edgesValue;
    return this.edgesValue.filter((edge) => edge.from === ref || edge.to === ref);
  }

  evidence(recordRef: string): ProbeEvidencePayload | undefined {
    this.assertOpen();
    const candidate = this.byRefValue.get(recordRef);
    return candidate === undefined ? undefined : evidenceOf(candidate);
  }

  status(recordRef: string): ProbeStatusView | undefined {
    this.assertOpen();
    const candidate = this.byRefValue.get(recordRef);
    return candidate === undefined ? undefined : statusOf(candidate);
  }

  provenance(recordRef: string): ProbeProvenanceView | undefined {
    this.assertOpen();
    const candidate = this.byRefValue.get(recordRef);
    return candidate === undefined ? undefined : provenanceOf(candidate);
  }

  snapshotIdentity(): ProbeSnapshotIdentity {
    this.assertOpen();
    return probeSnapshotIdentity(this.snapshotValue);
  }

  /** True when the file still describes exactly this committed log and snapshot. */
  isFresh(entries: readonly ViewReplayEntry[], snapshot: AnchorProbeSnapshot): boolean {
    this.assertOpen();
    return this.sourceDigestValue === viewDigest(entries)
      && this.snapshotHashValue === createHash('sha256').update(canonicalJson(snapshot)).digest('hex');
  }

  /** Return `fresh` when intact, otherwise rewrite from committed events and reload. */
  refresh(entries: readonly ViewReplayEntry[], snapshot: AnchorProbeSnapshot): 'fresh' | 'rebuilt' {
    this.assertOpen();
    if (this.isFresh(entries, snapshot)) return 'fresh';
    BitChainProbeStore.write(this.filePath, entries, snapshot, {
      recordHeaderBytes: this.recordHeaderBytesValue as 64 | 96 | 128,
      segmentBytes: this.segmentBytesValue,
    });
    this.load();
    return 'rebuilt';
  }

  get recordHeaderBytes(): number {
    return this.recordHeaderBytesValue;
  }

  get segmentBytes(): number {
    return this.segmentBytesValue;
  }

  get sourceDigest(): string {
    return this.sourceDigestValue;
  }

  get snapshotHash(): string {
    return this.snapshotHashValue;
  }

  get recordCount(): number {
    return this.candidatesValue.length;
  }

  get edgeCount(): number {
    return this.edgesValue.length;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.candidatesValue = [];
    this.edgesValue = [];
    this.byRefValue = new Map();
  }

  private load(): void {
    const parsed = parseBitChainFile(readFileSync(this.filePath));
    this.recordHeaderBytesValue = parsed.recordHeaderBytes;
    this.segmentBytesValue = parsed.segmentBytes;
    this.snapshotValue = parsed.snapshot;
    this.candidatesValue = parsed.candidates;
    this.edgesValue = parsed.edges;
    this.byRefValue = new Map(parsed.candidates.map((candidate) => [candidate.record_ref, candidate]));
    this.sourceDigestValue = parsed.sourceDigest;
    this.snapshotHashValue = parsed.snapshotHash;
  }

  private assertOpen(): void {
    if (this.closed) throw new ProbeStoreCacheError('BitChainProbeStore is closed');
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT';
}

/**
 * Open the experimental BitChain cache, rebuilding it when it is absent or
 * stale. A corrupt file fails closed to the SQLite baseline and reports the
 * explicit reason; it is never answered from, and never silently rewritten.
 */
export function openProbeStoreWithFallback(
  root: string,
  entries: readonly ViewReplayEntry[],
  snapshot: AnchorProbeSnapshot,
): ProbeStoreFallback {
  const path = BitChainProbeStore.databasePath(root);
  try {
    const store = BitChainProbeStore.open(path);
    if (!store.isFresh(entries, snapshot)) store.refresh(entries, snapshot);
    return { store, backend: 'bitchain', fallbackReason: null };
  } catch (error) {
    if (error instanceof BitChainFormatError) {
      const sqlite = SqliteProbeStore.open(root);
      sqlite.rebuild(entries, snapshot);
      return { store: sqlite, backend: 'sqlite', fallbackReason: `${error.code}: ${error.reason}` };
    }
    if (isNotFound(error)) {
      BitChainProbeStore.write(path, entries, snapshot);
      return { store: BitChainProbeStore.open(path), backend: 'bitchain', fallbackReason: null };
    }
    throw error;
  }
}
