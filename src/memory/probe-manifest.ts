import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { canonicalJson } from '../ledger/event.ts';
import {
  anchorProbeAliasRefSchema,
  anchorProbeBudgetSchema,
  anchorProbeConflictStatuses,
  anchorProbeCoverageStatuses,
  anchorProbeRecordStatuses,
  anchorProbeRequirementsOrigins,
  anchorProbeRequestSchema,
  anchorProbeResponseSchema,
  anchorProbeTemporalModes,
  assertClusterProjectScope,
  type AnchorProbeRequest,
  type AnchorProbeResponse,
} from './probe-contract.ts';

/**
 * Server-side frozen Probe manifest store (P2 / AP-11).
 *
 * A frozen manifest is the server's own record of one AnchorProbe run: the
 * validated request (the rules), the validated response (the evidence), a
 * complete alias→record reference map, an explicit freshness block and a
 * canonical-JSON body digest — written atomically to
 * `.ano/memory/probes/<context_id>.json`. Clients never re-submit payloads:
 * a consumer presents only a context id and the server decides, from this
 * file alone, whether the context is usable (`ok`), `unknown`, `expired`,
 * `cross_scope` or `digest_mismatch`. Every failure branch returns the reason
 * and no evidence text; failures never fabricate a usable context.
 *
 * Lifecycle boundaries (ADR-005 §10, integration plan §11.4):
 * - The manifest is derived material, not an authoritative write source. Every
 *   `record_ref`/`content_hash` in it resolves through the versioned memory
 *   projection read paths (`memoryFactSurface` / `memoryProbeSurface`,
 *   ADR-005 §5 identity table); the authoritative ledger lives in
 *   `.ano/ledger` and this store never reads, writes or cleans it.
 * - The store directory is `.ano/memory/probes`, deliberately outside
 *   `.ano/cache`: manifests are managed by TTL/capacity rules here, not by
 *   "delete the cache" bulk cleanup.
 * - Long-term reproduction is only available through an explicit authorized
 *   export (`exportForReproduction`), which copies an intact manifest outside
 *   the managed directory. Everything inside the directory may be expired,
 *   evicted or deleted at any time.
 *
 * Integrity model: `body_digest` is sha256 over the canonical JSON of the
 * whole body (including freshness), so any on-disk modification of evidence,
 * rules or lifecycle metadata is detectable at read time. Freezing an
 * already-frozen context id is idempotent for semantically identical material
 * (it renews freshness) and refused for different bytes, mirroring the ledger
 * idempotency contract; an unreadable or foreign file occupying the id is
 * never silently overwritten.
 */

export const PROBE_MANIFEST_SCHEMA_VERSION = 'anchorprobe.manifest.v1';

/**
 * Server-issued context ids are `ctx-<hex>` (probe core). Storage accepts the
 * filesystem-safe subset of the AP-02 identifier vocabulary: no separators and
 * no ':' (invalid on Windows paths), and `..` is rejected below so a context id
 * can never name anything but one file in one directory.
 */
export const PROBE_MANIFEST_CONTEXT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export const PROBE_MANIFEST_MIN_TTL_MS = 1_000;
export const PROBE_MANIFEST_MAX_TTL_MS = 2_592_000_000; // 30 days
export const PROBE_MANIFEST_DEFAULT_TTL_MS = 86_400_000; // 24 hours

export const PROBE_MANIFEST_MIN_MAX_COUNT = 1;
export const PROBE_MANIFEST_MAX_COUNT_LIMIT = 10_000;
export const PROBE_MANIFEST_DEFAULT_MAX_COUNT = 64;

export const PROBE_MANIFEST_MIN_MAX_TOTAL_BYTES = 1_024;
export const PROBE_MANIFEST_MAX_TOTAL_BYTES_LIMIT = 1_073_741_824; // 1 GiB
export const PROBE_MANIFEST_DEFAULT_MAX_TOTAL_BYTES = 16_777_216; // 16 MiB

const ISO_DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/u;

export class ProbeManifestError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ProbeManifestError';
  }
}

/** Freezing cannot proceed within the declared capacity limits. */
export class ProbeManifestCapacityError extends ProbeManifestError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ProbeManifestCapacityError';
  }
}

/** The context id already holds different (or unreadable) bytes; never overwritten. */
export class ProbeManifestConflictError extends ProbeManifestError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ProbeManifestConflictError';
  }
}

const boundedId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u, 'expected a bounded identifier');
const factKey = z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,127}$/u, 'expected a dotted fact key');
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u, 'expected a lowercase sha256 hex digest');
const iso = z.string().datetime();

const contextIdSchema = z.string()
  .regex(PROBE_MANIFEST_CONTEXT_ID_PATTERN, 'expected a bounded filesystem-safe context id such as ctx-<hex>')
  .refine((value) => !value.includes('..'), 'context id must not contain path segments');

export const probeManifestBindingSchema = z.object({
  project_scope: boundedId,
  root: z.string().min(1).max(4096),
}).strict();
export type ProbeManifestBinding = z.infer<typeof probeManifestBindingSchema>;

const referenceEntrySchema = z.object({
  ref: anchorProbeAliasRefSchema,
  kind: z.enum(['active_evidence', 'deprecated_tombstone']),
  record_ref: boundedId,
  content_hash: sha256,
  status: z.enum(anchorProbeRecordStatuses),
  superseded_by: boundedId.nullable(),
}).strict();

const conflictEntrySchema = z.object({
  conflict_id: boundedId,
  fact_key: factKey,
  record_refs: z.array(boundedId).min(1).max(64),
  status: z.enum(anchorProbeConflictStatuses),
}).strict();

export const probeManifestReferenceMapSchema = z.object({
  entries: z.array(referenceEntrySchema),
  conflicts: z.array(conflictEntrySchema),
  unresolved_conflict_ids: z.array(boundedId),
}).strict();
export type ProbeManifestReferenceMap = z.infer<typeof probeManifestReferenceMapSchema>;
export type ProbeManifestReferenceEntry = z.infer<typeof referenceEntrySchema>;

/**
 * The rules the probe ran under, frozen verbatim from the validated request
 * plus the coverage verdict. Evidence returned outside these rules would be a
 * different context, so they are part of the digest.
 */
export const probeManifestRulesSchema = z.object({
  request_id: boundedId,
  required_facts: z.array(factKey),
  temporal_mode: z.enum(anchorProbeTemporalModes),
  as_of: iso.nullable(),
  budget: anchorProbeBudgetSchema,
  coverage_status: z.enum(anchorProbeCoverageStatuses),
  coverage_requirements_origin: z.enum(anchorProbeRequirementsOrigins),
}).strict();
export type ProbeManifestRules = z.infer<typeof probeManifestRulesSchema>;

/**
 * Source freshness at freeze time: the sampled snapshot digests (verbatim from
 * the response) plus per-source health counts. `snapshot_fresh` at read time
 * compares `ledger_digest` against the caller's current ledger digest.
 */
export const probeManifestFreshnessSchema = z.object({
  frozen_at: iso,
  expires_at: iso,
  ledger_digest: sha256,
  graph_revision: sha256.nullable(),
  source_fingerprint: sha256.nullable(),
  connected_digest: sha256.nullable(),
  verified_sources: z.number().int().nonnegative(),
  stale_sources: z.number().int().nonnegative(),
  unknown_sources: z.number().int().nonnegative(),
}).strict();
export type ProbeManifestFreshness = z.infer<typeof probeManifestFreshnessSchema>;

/**
 * Distributed cluster identity frozen with the context (T-124 / ADR-011 §5).
 *
 * Digest choice: this segment participates in `body_digest` rather than getting
 * a separate `cluster_digest`. `body_digest` is already sha256 over the
 * canonical whole body, so the cluster identity is covered exactly once and the
 * existing read/duplicate/export integrity path stays authoritative; a second
 * digest would duplicate that verification without changing the trust
 * decision. The narrow field set (epoch/commit point/replica/evidence digest)
 * is what T-125~T-129 compare; `project_scope` and `partial` live on
 * `response.snapshot.cluster` and are cross-checked at freeze/read time.
 */
export const probeManifestClusterSchema = z.object({
  cluster_epoch: z.union([z.string().max(128), z.number().int().nonnegative()]),
  commit_index: z.number().int().nonnegative(),
  replica_id: boundedId,
  evidence_digest: sha256,
}).strict();
export type ProbeManifestCluster = z.infer<typeof probeManifestClusterSchema>;

export const probeManifestBodySchema = z.object({
  schema_version: z.literal(PROBE_MANIFEST_SCHEMA_VERSION),
  context_id: contextIdSchema,
  binding: probeManifestBindingSchema,
  rules: probeManifestRulesSchema,
  freshness: probeManifestFreshnessSchema,
  reference_map: probeManifestReferenceMapSchema,
  response: anchorProbeResponseSchema,
  /** Optional distributed cluster identity; absent for legacy contexts. */
  cluster: probeManifestClusterSchema.optional(),
}).strict();
export type ProbeManifestBody = z.infer<typeof probeManifestBodySchema>;

export const frozenProbeManifestSchema = z.object({
  ...probeManifestBodySchema.shape,
  body_digest: sha256,
}).strict();
export type FrozenProbeManifest = z.infer<typeof frozenProbeManifestSchema>;

function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function isoNow(value?: string): string {
  if (value === undefined) return new Date().toISOString();
  if (typeof value !== 'string' || !ISO_DATETIME_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
    throw new ProbeManifestError(`expected an ISO-8601 UTC datetime, got ${JSON.stringify(value)}`);
  }
  return value;
}

function toMillis(isoDatetime: string): number {
  const ms = Date.parse(isoDatetime);
  if (Number.isNaN(ms)) throw new ProbeManifestError(`expected a parseable datetime, got ${JSON.stringify(isoDatetime)}`);
  return ms;
}

function boundedInt(value: number, min: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ProbeManifestError(`${label} must be an integer in [${min}, ${max}], got ${value}`);
  }
  return value;
}

function assertSafeContextId(contextId: string): void {
  if (typeof contextId !== 'string' || !PROBE_MANIFEST_CONTEXT_ID_PATTERN.test(contextId) || contextId.includes('..')) {
    throw new ProbeManifestError(`context id ${JSON.stringify(contextId)} is not a filesystem-safe probe context id`);
  }
}

function buildReferenceMap(response: AnchorProbeResponse): ProbeManifestReferenceMap {
  const entries: ProbeManifestReferenceEntry[] = [];
  for (const evidence of response.active_evidence) {
    entries.push({
      ref: evidence.ref,
      kind: 'active_evidence',
      record_ref: evidence.record_ref,
      content_hash: evidence.content_hash,
      status: evidence.status,
      superseded_by: null,
    });
  }
  for (const tombstone of response.deprecated_tombstones) {
    entries.push({
      ref: tombstone.ref,
      kind: 'deprecated_tombstone',
      record_ref: tombstone.record_ref,
      content_hash: tombstone.content_hash,
      status: tombstone.status,
      superseded_by: tombstone.superseded_by,
    });
  }
  const conflicts = response.conflicts.map((conflict) => ({
    conflict_id: conflict.conflict_id,
    fact_key: conflict.fact_key,
    record_refs: [...conflict.record_refs],
    status: conflict.status,
  }));
  return {
    entries,
    conflicts,
    unresolved_conflict_ids: [...response.coverage_gate.unresolved_conflicts],
  };
}

function buildRules(request: AnchorProbeRequest, response: AnchorProbeResponse): ProbeManifestRules {
  return {
    request_id: request.request_id,
    required_facts: [...(request.required_facts ?? [])],
    temporal_mode: request.temporal_mode,
    as_of: request.as_of ?? null,
    budget: { ...request.budget },
    coverage_status: response.coverage_gate.status,
    coverage_requirements_origin: response.coverage_gate.requirements_origin,
  };
}

function buildFreshness(response: AnchorProbeResponse, frozenAt: string, expiresAt: string): ProbeManifestFreshness {
  let verified = 0;
  let stale = 0;
  let unknown = 0;
  for (const evidence of response.active_evidence) {
    if (evidence.source_health === 'verified_at_snapshot') verified += 1;
    else if (evidence.source_health === 'stale') stale += 1;
    else unknown += 1;
  }
  return {
    frozen_at: frozenAt,
    expires_at: expiresAt,
    ledger_digest: response.snapshot.ledger_digest,
    graph_revision: response.snapshot.graph_revision,
    source_fingerprint: response.snapshot.source_fingerprint,
    connected_digest: response.snapshot.connected_digest,
    verified_sources: verified,
    stale_sources: stale,
    unknown_sources: unknown,
  };
}

function bodyDigest(body: ProbeManifestBody): string {
  return sha256Hex(canonicalJson(body));
}

/**
 * Narrow the response's cluster metadata to the four fields the manifest
 * freezes; `undefined` when the snapshot is a legacy one without a cluster
 * segment (the optional body field is then omitted entirely).
 */
function buildCluster(response: AnchorProbeResponse): ProbeManifestCluster | undefined {
  const cluster = response.snapshot.cluster;
  if (cluster === undefined) return undefined;
  return {
    cluster_epoch: cluster.cluster_epoch,
    commit_index: cluster.commit_index,
    replica_id: cluster.replica_id,
    evidence_digest: cluster.evidence_digest,
  };
}

/**
 * Identity of the frozen material excluding lifecycle metadata: re-freezing
 * the same evidence under the same context id renews freshness instead of
 * conflicting, while any change to rules, reference map, binding or evidence
 * bytes is a different manifest.
 */
function semanticIdentity(body: ProbeManifestBody): string {
  const { freshness: _freshness, ...rest } = body;
  return canonicalJson(rest);
}

function atomicWrite(file: string, text: string): void {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, text, 'utf8');
  renameSync(temporary, file);
}

function assertInside(directory: string, file: string): void {
  const resolved = resolve(file);
  if (!resolved.startsWith(`${resolve(directory)}${sep}`)) {
    throw new ProbeManifestError(`refusing to operate outside ${directory}: ${resolved}`);
  }
}

function assertOutside(directory: string, target: string): void {
  const resolved = resolve(target);
  if (resolved === resolve(directory) || resolved.startsWith(`${resolve(directory)}${sep}`)) {
    throw new ProbeManifestError(`probe manifest export target must live outside ${directory}`);
  }
}

export interface ProbeManifestStoreOptions {
  /** Absolute project root the store is bound to (usually the ledger root). */
  readonly root: string;
  /** Time-to-live for frozen manifests; bounded, 24h by default. */
  readonly ttlMs?: number;
  /** Maximum number of manifests kept; oldest are evicted beyond it. */
  readonly maxCount?: number;
  /** Maximum total serialized size of all manifests; oldest are evicted beyond it. */
  readonly maxTotalBytes?: number;
}

export interface ProbeManifestFreezeInput {
  /** The request the probe ran under; parsed against the AP-02 contract and frozen as the rules. */
  readonly request: unknown;
  /** The probe response to freeze; parsed against the AP-02 contract; client payloads are never trusted. */
  readonly response: unknown;
  /** Deterministic freeze clock; defaults to the real time. */
  readonly now?: string;
}

export interface ProbeManifestFreezeResult {
  readonly context_id: string;
  readonly body_digest: string;
  readonly frozen_at: string;
  readonly expires_at: string;
  readonly bytes: number;
  /** True when a semantically identical manifest was already frozen and only freshness was renewed. */
  readonly duplicate: boolean;
  /** Manifests removed before this freeze: expired ones first, then oldest-by-frozen_at. */
  readonly evicted: readonly string[];
}

export interface ProbeManifestReadOptions {
  /** Deterministic read clock; defaults to the real time. */
  readonly now?: string;
  /** Current ledger digest; when given, `snapshot_fresh` reports whether the frozen snapshot still matches. */
  readonly currentLedgerDigest?: string;
}

/**
 * Read verdicts are exhaustive and fail-closed: only `ok` carries the
 * manifest and its evidence text. `unknown`, `expired`, `cross_scope`,
 * `digest_mismatch`, `schema_mismatch` and `corrupt` carry diagnostics only.
 */
export type ProbeManifestReadResult =
  | { readonly status: 'ok'; readonly manifest: FrozenProbeManifest; readonly age_ms: number; readonly snapshot_fresh: boolean | null }
  | { readonly status: 'unknown'; readonly context_id: string }
  | { readonly status: 'expired'; readonly context_id: string; readonly expires_at: string }
  | { readonly status: 'digest_mismatch'; readonly context_id: string; readonly detail: string }
  | { readonly status: 'cross_scope'; readonly context_id: string; readonly manifest_scope: string; readonly manifest_root: string }
  | { readonly status: 'schema_mismatch'; readonly context_id: string; readonly manifest_version: string }
  | { readonly status: 'corrupt'; readonly context_id: string; readonly detail: string };

export interface ProbeManifestExportOptions {
  /** Must be deliberately `true`; exports are the only long-term reproduction path. */
  readonly authorize: boolean;
  /** Expected project scope; a manifest bound to another scope is refused. */
  readonly expectedProjectScope: string;
  /** Deterministic clock for the intactness check; defaults to the real time. */
  readonly now?: string;
}

export interface ProbeManifestExportResult {
  readonly context_id: string;
  readonly target_path: string;
  readonly body_digest: string;
  readonly frozen_at: string;
  readonly expires_at: string;
  /** `expired` exports are honest historical artifacts; tampered ones are refused. */
  readonly source_status: 'ok' | 'expired';
}

export interface ProbeManifestSweepOptions {
  readonly now?: string;
}

export interface ProbeManifestSweepReport {
  readonly now: string;
  readonly removed_expired: readonly string[];
  readonly removed_capacity: readonly string[];
  /** Incomplete atomic-write leftovers; never valid manifests. */
  readonly removed_temp: readonly string[];
}

interface ScannedManifest {
  readonly contextId: string;
  readonly manifest: FrozenProbeManifest;
  readonly bytes: number;
}

/**
 * Internal read verdict; identical to {@link ProbeManifestReadResult} except
 * that `expired` also carries the verified manifest for the export path.
 */
type InternalVerdict =
  | { readonly status: 'ok'; readonly manifest: FrozenProbeManifest; readonly ageMs: number }
  | { readonly status: 'expired'; readonly manifest: FrozenProbeManifest; readonly expiresAt: string }
  | { readonly status: 'unknown' }
  | { readonly status: 'corrupt'; readonly detail: string }
  | { readonly status: 'digest_mismatch'; readonly detail: string }
  | { readonly status: 'cross_scope'; readonly manifestScope: string; readonly manifestRoot: string }
  | { readonly status: 'schema_mismatch'; readonly manifestVersion: string };

function frozenAtAscending(a: ScannedManifest, b: ScannedManifest): number {
  const aMs = toMillis(a.manifest.freshness.frozen_at);
  const bMs = toMillis(b.manifest.freshness.frozen_at);
  if (aMs !== bMs) return aMs - bMs;
  return a.contextId.localeCompare(b.contextId);
}

export class ProbeManifestStore {
  readonly #root: string;
  readonly #directory: string;
  readonly #ttlMs: number;
  readonly #maxCount: number;
  readonly #maxTotalBytes: number;

  constructor(options: ProbeManifestStoreOptions) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new ProbeManifestError('probe manifest store options must be an object');
    }
    if (typeof options.root !== 'string' || options.root.length === 0) {
      throw new ProbeManifestError('probe manifest store root must be a non-empty path');
    }
    this.#root = resolve(options.root);
    this.#directory = join(this.#root, '.ano', 'memory', 'probes');
    this.#ttlMs = boundedInt(options.ttlMs ?? PROBE_MANIFEST_DEFAULT_TTL_MS, PROBE_MANIFEST_MIN_TTL_MS, PROBE_MANIFEST_MAX_TTL_MS, 'ttlMs');
    this.#maxCount = boundedInt(options.maxCount ?? PROBE_MANIFEST_DEFAULT_MAX_COUNT, PROBE_MANIFEST_MIN_MAX_COUNT, PROBE_MANIFEST_MAX_COUNT_LIMIT, 'maxCount');
    this.#maxTotalBytes = boundedInt(
      options.maxTotalBytes ?? PROBE_MANIFEST_DEFAULT_MAX_TOTAL_BYTES,
      PROBE_MANIFEST_MIN_MAX_TOTAL_BYTES,
      PROBE_MANIFEST_MAX_TOTAL_BYTES_LIMIT,
      'maxTotalBytes',
    );
  }

  get root(): string {
    return this.#root;
  }

  get directory(): string {
    return this.#directory;
  }

  /**
   * Freeze one validated probe run. The request and response are re-validated
   * against the AP-02 contracts and cross-checked against each other and
   * against this store's root — client-supplied or inconsistent payloads are
   * rejected before anything is written. Expired manifests are removed first;
   * then the oldest manifests are evicted until the new one fits the count and
   * byte capacity. Nothing is written when the manifest alone exceeds the byte
   * capacity.
   */
  freeze(input: ProbeManifestFreezeInput): ProbeManifestFreezeResult {
    const frozenAt = isoNow(input.now);
    let request: AnchorProbeRequest;
    try {
      request = anchorProbeRequestSchema.parse(input.request);
    } catch (error) {
      throw new ProbeManifestError('freeze rejected the request: it does not satisfy the AP-02 request contract', { cause: error });
    }
    let response: AnchorProbeResponse;
    try {
      response = anchorProbeResponseSchema.parse(input.response);
    } catch (error) {
      throw new ProbeManifestError('freeze rejected the response: it does not satisfy the AP-02 context contract; client payloads are never trusted', { cause: error });
    }
    if (resolve(request.root) !== this.#root) {
      throw new ProbeManifestError(`freeze request root ${request.root} does not match the store root ${this.#root}`);
    }
    if (request.request_id !== response.request_id) {
      throw new ProbeManifestError(`freeze request_id ${request.request_id} does not match the response ${response.request_id}`);
    }
    if (request.context_id !== undefined && request.context_id !== response.context_id) {
      throw new ProbeManifestError(`freeze request context_id ${request.context_id} does not match the response ${response.context_id}`);
    }
    if (request.project_scope !== response.snapshot.project_scope) {
      throw new ProbeManifestError(`freeze request project_scope ${request.project_scope} does not match the response snapshot ${response.snapshot.project_scope}`);
    }
    if (response.snapshot.cluster !== undefined) {
      try {
        assertClusterProjectScope(response.snapshot.cluster, request.project_scope);
      } catch (error) {
        throw new ProbeManifestError(
          'freeze rejected cluster metadata: its project_scope does not match the request/snapshot scope (SCOPE_DENIED)',
          { cause: error },
        );
      }
    }
    const contextId = response.context_id;
    assertSafeContextId(contextId);

    const file = this.#pathFor(contextId);
    const expiresAt = new Date(toMillis(frozenAt) + this.#ttlMs).toISOString();
    const cluster = buildCluster(response);
    const body: ProbeManifestBody = {
      schema_version: PROBE_MANIFEST_SCHEMA_VERSION,
      context_id: contextId,
      binding: { project_scope: request.project_scope, root: this.#root },
      rules: buildRules(request, response),
      freshness: buildFreshness(response, frozenAt, expiresAt),
      reference_map: buildReferenceMap(response),
      response,
      ...(cluster === undefined ? {} : { cluster }),
    };
    const digest = bodyDigest(body);
    const manifest: FrozenProbeManifest = { ...body, body_digest: digest };
    const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
    const bytes = Buffer.byteLength(serialized, 'utf8');
    if (bytes > this.#maxTotalBytes) {
      throw new ProbeManifestCapacityError(`probe manifest for ${contextId} is ${bytes} bytes, above the ${this.#maxTotalBytes} byte capacity limit`);
    }

    mkdirSync(this.#directory, { recursive: true });
    if (existsSync(file)) {
      let existing: FrozenProbeManifest;
      try {
        existing = frozenProbeManifestSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
      } catch (error) {
        throw new ProbeManifestConflictError(`probe manifest file for ${contextId} exists but is not a valid manifest; delete it explicitly before re-freezing`, { cause: error });
      }
      const { body_digest: _existingDigest, ...existingBody } = existing;
      if (semanticIdentity(existingBody) !== semanticIdentity(body)) {
        throw new ProbeManifestConflictError(`context ${contextId} is already frozen with different material (body_digest ${existing.body_digest}); delete the manifest explicitly before re-freezing`);
      }
      atomicWrite(file, serialized);
      return { context_id: contextId, body_digest: digest, frozen_at: frozenAt, expires_at: expiresAt, bytes, duplicate: true, evicted: [] };
    }

    const evicted = this.#makeRoom(bytes, toMillis(frozenAt));
    atomicWrite(file, serialized);
    return { context_id: contextId, body_digest: digest, frozen_at: frozenAt, expires_at: expiresAt, bytes, duplicate: false, evicted };
  }

  /**
   * Decide, from the stored file alone, whether a context is usable. The body
   * digest is verified before any other verdict, so tampered manifests are
   * never presented as anything but `digest_mismatch`. The internal verdict
   * keeps the manifest for `ok` and `expired`: export needs the frozen body of
   * an expired-but-intact artifact, while the public read result carries
   * evidence only for `ok`.
   */
  read(contextId: string, expectedProjectScope: string, options: ProbeManifestReadOptions = {}): ProbeManifestReadResult {
    const verdict = this.#verdict(contextId, expectedProjectScope, isoNow(options.now));
    switch (verdict.status) {
      case 'unknown':
        return { status: 'unknown', context_id: contextId };
      case 'corrupt':
        return { status: 'corrupt', context_id: contextId, detail: verdict.detail };
      case 'digest_mismatch':
        return { status: 'digest_mismatch', context_id: contextId, detail: verdict.detail };
      case 'cross_scope':
        return { status: 'cross_scope', context_id: contextId, manifest_scope: verdict.manifestScope, manifest_root: verdict.manifestRoot };
      case 'schema_mismatch':
        return { status: 'schema_mismatch', context_id: contextId, manifest_version: verdict.manifestVersion };
      case 'expired':
        return { status: 'expired', context_id: contextId, expires_at: verdict.expiresAt };
      case 'ok': {
        const snapshotFresh = options.currentLedgerDigest === undefined
          ? null
          : verdict.manifest.response.snapshot.ledger_digest === options.currentLedgerDigest;
        return { status: 'ok', manifest: verdict.manifest, age_ms: verdict.ageMs, snapshot_fresh: snapshotFresh };
      }
    }
  }

  /** Delete one manifest. Only exact `<context_id>.json` inside the store directory is removable. */
  delete(contextId: string): boolean {
    assertSafeContextId(contextId);
    const file = this.#pathFor(contextId);
    if (!existsSync(file)) return false;
    unlinkSync(file);
    return true;
  }

  /**
   * Remove expired manifests, enforce count/byte capacity and drop incomplete
   * `.tmp` leftovers. Only files that verifiably are probe manifests (schema
   * valid, digest intact) are ever removed as manifests; unknown files in the
   * directory are left untouched.
   */
  sweep(options: ProbeManifestSweepOptions = {}): ProbeManifestSweepReport {
    const now = isoNow(options.now);
    const nowMs = toMillis(now);
    const removedExpired: string[] = [];
    const removedCapacity: string[] = [];
    const removedTemp: string[] = [];
    if (!existsSync(this.#directory)) {
      return { now, removed_expired: removedExpired, removed_capacity: removedCapacity, removed_temp: removedTemp };
    }
    const { manifests, tempNames } = this.#scan();
    for (const name of tempNames) {
      const temp = join(this.#directory, name);
      assertInside(this.#directory, temp);
      unlinkSync(temp);
      removedTemp.push(name);
    }
    const surviving: ScannedManifest[] = [];
    for (const item of manifests) {
      if (toMillis(item.manifest.freshness.expires_at) <= nowMs) {
        const file = join(this.#directory, `${item.contextId}.json`);
        assertInside(this.#directory, file);
        unlinkSync(file);
        removedExpired.push(item.contextId);
        continue;
      }
      surviving.push(item);
    }
    const ordered = [...surviving].sort(frozenAtAscending);
    let totalBytes = ordered.reduce((sum, item) => sum + item.bytes, 0);
    let index = 0;
    while (index < ordered.length && (ordered.length - index > this.#maxCount || totalBytes > this.#maxTotalBytes)) {
      const victim = ordered[index]!;
      const file = join(this.#directory, `${victim.contextId}.json`);
      assertInside(this.#directory, file);
      unlinkSync(file);
      removedCapacity.push(victim.contextId);
      totalBytes -= victim.bytes;
      index += 1;
    }
    return { now, removed_expired: removedExpired, removed_capacity: removedCapacity, removed_temp: removedTemp };
  }

  /**
   * Copy an intact manifest to an explicit absolute path outside the managed
   * directory. This is the only long-term reproduction path: everything inside
   * the store is derived, TTL-bounded material. Expired-but-intact manifests
   * may be exported as historical artifacts (the copy carries the original
   * freshness block); tampered, corrupt or cross-scope manifests are refused.
   */
  exportForReproduction(contextId: string, targetPath: string, options: ProbeManifestExportOptions): ProbeManifestExportResult {
    if (options === undefined || options === null || typeof options !== 'object' || options.authorize !== true) {
      throw new ProbeManifestError('probe manifest export requires explicit authorization (authorize: true)');
    }
    if (typeof targetPath !== 'string' || !isAbsolute(targetPath)) {
      throw new ProbeManifestError('probe manifest export target must be an absolute path');
    }
    const verdict = this.#verdict(contextId, options.expectedProjectScope, isoNow(options.now));
    if (verdict.status === 'unknown') throw new ProbeManifestError(`probe manifest ${contextId} is unknown; nothing to export`);
    if (verdict.status !== 'ok' && verdict.status !== 'expired') {
      throw new ProbeManifestError(`probe manifest ${contextId} is not intact (verdict ${verdict.status}); refusing to export`);
    }
    const target = resolve(targetPath);
    assertOutside(this.#directory, target);
    mkdirSync(dirname(target), { recursive: true });
    atomicWrite(target, `${JSON.stringify(verdict.manifest, null, 2)}\n`);
    return {
      context_id: contextId,
      target_path: target,
      body_digest: verdict.manifest.body_digest,
      frozen_at: verdict.manifest.freshness.frozen_at,
      expires_at: verdict.manifest.freshness.expires_at,
      source_status: verdict.status,
    };
  }

  #verdict(contextId: string, expectedProjectScope: string, now: string): InternalVerdict {
    const nowMs = toMillis(now);
    if (typeof expectedProjectScope !== 'string' || expectedProjectScope.length === 0) {
      throw new ProbeManifestError('expectedProjectScope must be a non-empty string');
    }
    if (!PROBE_MANIFEST_CONTEXT_ID_PATTERN.test(contextId) || contextId.includes('..')) {
      return { status: 'unknown' };
    }
    const file = this.#pathFor(contextId);
    if (!existsSync(file)) return { status: 'unknown' };
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch (error) {
      return { status: 'corrupt', detail: `manifest file is unreadable: ${error instanceof Error ? error.message : String(error)}` };
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(text);
    } catch {
      return { status: 'corrupt', detail: 'manifest file is not valid JSON' };
    }
    if (typeof parsedJson === 'object' && parsedJson !== null && !Array.isArray(parsedJson)) {
      const version = (parsedJson as { schema_version?: unknown }).schema_version;
      if (typeof version === 'string' && version !== PROBE_MANIFEST_SCHEMA_VERSION) {
        return { status: 'schema_mismatch', manifestVersion: version };
      }
    }
    let manifest: FrozenProbeManifest;
    try {
      manifest = frozenProbeManifestSchema.parse(parsedJson);
    } catch (error) {
      return { status: 'corrupt', detail: `manifest does not satisfy ${PROBE_MANIFEST_SCHEMA_VERSION}: ${error instanceof Error ? error.message : String(error)}` };
    }
    const { body_digest: storedDigest, ...body } = manifest;
    if (bodyDigest(body) !== storedDigest) {
      return { status: 'digest_mismatch', detail: `stored body_digest ${storedDigest} does not match the recomputed body digest` };
    }
    if (manifest.context_id !== contextId || manifest.response.context_id !== manifest.context_id) {
      return { status: 'digest_mismatch', detail: 'stored context identity does not match the requested context id' };
    }
    if (Number.isNaN(Date.parse(manifest.freshness.frozen_at)) || Number.isNaN(Date.parse(manifest.freshness.expires_at))) {
      return { status: 'corrupt', detail: 'freshness timestamps are not parseable datetimes' };
    }
    if (manifest.binding.root !== this.#root || manifest.binding.project_scope !== expectedProjectScope) {
      return { status: 'cross_scope', manifestScope: manifest.binding.project_scope, manifestRoot: manifest.binding.root };
    }
    // The frozen response's own cluster metadata must name the same scope as
    // the binding; a foreign cluster segment can never ride along.
    const snapshotCluster = manifest.response.snapshot.cluster;
    if (snapshotCluster !== undefined && snapshotCluster.project_scope !== manifest.binding.project_scope) {
      return { status: 'cross_scope', manifestScope: snapshotCluster.project_scope, manifestRoot: manifest.binding.root };
    }
    if (nowMs > toMillis(manifest.freshness.expires_at)) {
      return { status: 'expired', manifest, expiresAt: manifest.freshness.expires_at };
    }
    return { status: 'ok', manifest, ageMs: nowMs - toMillis(manifest.freshness.frozen_at) };
  }

  #pathFor(contextId: string): string {
    const file = join(this.#directory, `${contextId}.json`);
    assertInside(this.#directory, file);
    return file;
  }

  /**
   * List the identifiable, digest-verified manifests in the store directory
   * plus the `.tmp` leftovers. Unparseable, digest-broken or foreign-named
   * files are skipped (never removed automatically).
   */
  #scan(): { manifests: ScannedManifest[]; tempNames: string[] } {
    const manifests: ScannedManifest[] = [];
    const tempNames: string[] = [];
    if (!existsSync(this.#directory)) return { manifests, tempNames };
    for (const entry of readdirSync(this.#directory, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (entry.name.endsWith('.tmp')) {
        tempNames.push(entry.name);
        continue;
      }
      if (!entry.name.endsWith('.json')) continue;
      const contextId = entry.name.slice(0, -'.json'.length);
      if (!PROBE_MANIFEST_CONTEXT_ID_PATTERN.test(contextId) || contextId.includes('..')) continue;
      const file = join(this.#directory, entry.name);
      let manifest: FrozenProbeManifest;
      try {
        const parsed = frozenProbeManifestSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
        const { body_digest: storedDigest, ...body } = parsed;
        if (bodyDigest(body) !== storedDigest) continue;
        if (Number.isNaN(Date.parse(body.freshness.frozen_at)) || Number.isNaN(Date.parse(body.freshness.expires_at))) continue;
        manifest = { ...body, body_digest: storedDigest };
      } catch {
        continue;
      }
      manifests.push({ contextId, manifest, bytes: statSync(file).size });
    }
    return { manifests, tempNames };
  }

  /**
   * Make room for an incoming manifest: remove expired manifests, then evict
   * oldest-first until count and byte capacity admit it. Callers guarantee
   * `incomingBytes <= maxTotalBytes`, so the loop always terminates with room
   * to spare.
   */
  #makeRoom(incomingBytes: number, nowMs: number): string[] {
    const evicted: string[] = [];
    const { manifests } = this.#scan();
    const surviving: ScannedManifest[] = [];
    for (const item of manifests) {
      if (toMillis(item.manifest.freshness.expires_at) <= nowMs) {
        const file = join(this.#directory, `${item.contextId}.json`);
        assertInside(this.#directory, file);
        unlinkSync(file);
        evicted.push(item.contextId);
        continue;
      }
      surviving.push(item);
    }
    const ordered = [...surviving].sort(frozenAtAscending);
    let totalBytes = ordered.reduce((sum, item) => sum + item.bytes, 0);
    let index = 0;
    while (index < ordered.length && (ordered.length - index + 1 > this.#maxCount || totalBytes + incomingBytes > this.#maxTotalBytes)) {
      const victim = ordered[index]!;
      const file = join(this.#directory, `${victim.contextId}.json`);
      assertInside(this.#directory, file);
      unlinkSync(file);
      evicted.push(victim.contextId);
      totalBytes -= victim.bytes;
      index += 1;
    }
    return evicted;
  }
}
