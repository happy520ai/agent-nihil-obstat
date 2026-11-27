import type { TakeoverScope, TakeoverState } from './takeover-policy.ts';

export const CONNECT_SCHEMA = 'ano.connect/1' as const;
export const CONNECT_SNAPSHOT_SCHEMA = 'ano.connect-snapshot/1' as const;
export const CONNECT_MANIFEST_SCHEMA = 'ano.connect-manifest/1' as const;
export const CONNECT_CURRENT_SCHEMA = 'ano.connect-current/1' as const;
export const CONNECT_EXPORT_SCHEMA = 'ano.connect-export/1' as const;
export const CONNECT_CHECKPOINT_SCHEMA = 'ano.connect-checkpoint/1' as const;

export type ConnectSourceKind = 'pm-mcp';

export type ConnectTaskCategory = 'todo' | 'in_progress' | 'completed' | 'cancelled' | 'unknown';

/** Stable identity for one imported source instance. It namespaces every derived id. */
export interface ConnectIdentity {
  tool: ConnectSourceKind;
  /** Short hash of the canonical project root (workspace instance). */
  instance: string;
  /** Human-readable project slug derived from .pm/project.json. Display only; may change on rename. */
  project: string;
  /** Original source project name; older snapshots may omit it. */
  displayName?: string;
  /** Short hash of the stable project key, stable even when the display name changes. */
  projectId: string;
  /** Stable project identity: a stable project.json id field, otherwise the canonical root. */
  projectKey: string;
}

/**
 * A source file that is deliberately not archived because it is a rebuildable
 * derived cache. It is inventoried (path/size) but excluded from the digest.
 */
export interface ConnectionExcludedEntry {
  path: string;
  reason: 'derived-cache';
  bytes: number;
}

export interface ConnectedIdentity extends ConnectIdentity {
  kind: string;
  id: string;
}

export interface ConnectionFileEntry {
  path: string;
  hash: string;
  bytes: number;
  mediaType?: string;
  binary?: boolean;
}

export interface ConnectionCounts {
  files: number;
  totalBytes: number;
  textFiles: number;
  binaryFiles: number;
  excluded: number;
  excludedBytes: number;
  records: number;
  tasks: number;
}

export interface ConnectionPlan {
  schema: typeof CONNECT_SCHEMA;
  root: string;
  source: ConnectSourceKind;
  connectionId: string;
  sourceDigest: string;
  files: ConnectionFileEntry[];
  excluded: ConnectionExcludedEntry[];
  counts: ConnectionCounts;
  warnings: string[];
  capabilities: string[];
  canConnect: boolean;
  identity: ConnectIdentity;
}

export interface ConnectionReport {
  connected: boolean;
  reason?: string;
  version: number;
  snapshotPath: string;
  previousDigest?: string;
  files: number;
  totalBytes: number;
  records: number;
  tasks: number;
  recordCounts: Record<string, number>;
  excluded: ConnectionExcludedEntry[];
  changes: { added: number; updated: number; removed: number };
  warnings: string[];
  resumedFromCheckpoint: boolean;
}

export interface ConnectionResult {
  schema: typeof CONNECT_SCHEMA;
  connectionId: string;
  source: ConnectSourceKind;
  sourceDigest: string;
  duplicate: boolean;
  sourceUnchanged: boolean;
  report: ConnectionReport;
}

export interface ConnectionSummary {
  connectionId: string;
  source: ConnectSourceKind;
  sourceDigest: string;
  currentVersion: number;
  versionCount: number;
  snapshotPath: string;
  createdAt: string;
  updatedAt: string;
  files: number;
  tasks: number;
  recordCounts: Record<string, number>;
}

export interface ConnectedTask {
  id: string;
  sourceId: string;
  title: string;
  /** Original status string from the source, preserved verbatim. */
  status: string;
  category: ConnectTaskCategory;
  verification: 'unverified';
  sourcePath: string;
  raw: Record<string, unknown>;
  identity: ConnectedIdentity;
  milestone?: string;
  priority?: string;
  type?: string;
}

export interface ConnectionStatus {
  schema: typeof CONNECT_SCHEMA;
  connected: boolean;
  root: string;
  source: ConnectSourceKind;
  connections: ConnectionSummary[];
  tasks: ConnectedTask[];
  recordCounts: Record<string, number>;
  excluded: ConnectionExcludedEntry[];
  identity?: ConnectIdentity;
  warnings: string[];
  untrusted: true;
  notice: string;
}

export interface RecallHit {
  id: string;
  kind: string;
  text: string;
  sourcePath: string;
  snapshotDigest: string;
  version: number;
  truncated: boolean;
  recordId: string;
  sourceId: string;
}

export interface RecallResult {
  schema: typeof CONNECT_SCHEMA;
  root: string;
  query: string;
  results: RecallHit[];
  total: number;
  truncated: boolean;
  limit: number;
  untrusted: true;
  notice: string;
}

export interface ExportChange {
  kind: 'added' | 'updated' | 'removed';
  recordId: string;
  sourcePath: string;
  archivedIn?: string;
  snapshotDigest?: string;
}

export interface ExportConnectionFile {
  path: string;
  hash: string;
  bytes: number;
  mediaType?: string;
  binary?: boolean;
  base64: string;
}

export interface ExportConnectionVersion {
  version: number;
  sourceDigest: string;
  snapshotPath: string;
  createdAt: string;
  files: ExportConnectionFile[];
  excluded: ConnectionExcludedEntry[];
  records: Record<string, unknown>[];
  changes: ExportChange[];
}

export interface ExportConnection {
  schema: typeof CONNECT_EXPORT_SCHEMA;
  connectionId: string;
  source: ConnectSourceKind;
  root: string;
  current: { version: number; sourceDigest: string; snapshotPath: string };
  versions: ExportConnectionVersion[];
  excluded: ConnectionExcludedEntry[];
  records: Record<string, unknown>[];
  tasks: ConnectedTask[];
  changes: ExportChange[];
  capabilities: string[];
  limitations: string[];
  notice: string;
  exportedAt: string;
}

export interface HandoffReadiness {
  schema: typeof CONNECT_SCHEMA;
  root: string;
  ready: boolean;
  blockers: string[];
  capabilities: string[];
  connectionId?: string;
  sourceDigest?: string;
  migration?: { sourceDigest: string; backupId?: string; backupHash?: string };
  cutover?: { name: string; role: string; confirmedAt: string };
  /**
   * Optional takeover projection (T-071). Absent for projects without a
   * takeover policy so old callers cannot misread Connect readiness as an
   * enforced takeover.
   */
  takeover?: HandoffTakeover;
}

export interface StoredRecord {
  id: string;
  kind: string;
  sourceId: string;
  title: string;
  status: string;
  category: ConnectTaskCategory;
  sourcePath: string;
  text: string;
  raw: Record<string, unknown>;
  identity: ConnectedIdentity;
}

export interface StoredSnapshot {
  schema: typeof CONNECT_SNAPSHOT_SCHEMA;
  connectionId: string;
  source: ConnectSourceKind;
  sourceDigest: string;
  identity: ConnectIdentity;
  files: ConnectionFileEntry[];
  excluded: ConnectionExcludedEntry[];
  records: StoredRecord[];
  recordCounts: Record<string, number>;
  warnings: string[];
}

export interface ManifestVersion {
  version: number;
  sourceDigest: string;
  snapshotPath: string;
  snapshotHash: string;
  createdAt: string;
  files: number;
  records: number;
  previousDigest: string | null;
  changes: ExportChange[];
}

export interface ConnectManifest {
  schema: typeof CONNECT_MANIFEST_SCHEMA;
  connectionId: string;
  source: ConnectSourceKind;
  identity: ConnectIdentity;
  root: string;
  createdAt: string;
  updatedAt: string;
  current: ManifestVersion;
  versions: ManifestVersion[];
}

export interface ConnectCurrent {
  schema: typeof CONNECT_CURRENT_SCHEMA;
  connectionId: string;
  sourceDigest: string;
  version: number;
  snapshotPath: string;
  snapshotHash: string;
  updatedAt: string;
}

export interface ConnectCheckpoint {
  schema: typeof CONNECT_CHECKPOINT_SCHEMA;
  runId: string;
  connectionId: string;
  sourceDigest: string;
  phase: 'staging' | 'snapshot' | 'complete';
  totalFiles: number;
  batchSize: number;
  nextBatch: number;
  files: ConnectionFileEntry[];
  snapshotPath?: string;
  snapshotHash?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectCapabilities {
  read: true;
  recall: true;
  export: true;
  handoff: false;
}

// ---- takeover-aware Connect extensions (T-071) ---------------------------
//
// These are the handoff/watch-facing projection of a persisted takeover
// policy. They reuse takeover-policy.ts's state/scope vocabulary instead of
// redefining it, and every addition is optional so existing Connect consumers
// keep compiling and behaving unchanged.

export const CONNECT_ROLE_MATRIX_SCHEMA = 'ano.connect-role-matrix/1' as const;
export const CONNECT_DRIFT_SCHEMA = 'ano.connect-drift/1' as const;
export const CONNECT_DRIFT_WATCH_SCHEMA = 'ano.connect-drift-watch/1' as const;

/** Capability layers that ADR-006 §5 assigns a main-write role to. */
export type ConnectCapabilityLayer = 'tasks' | 'memory' | 'acceptance' | 'dag' | 'release';

/**
 * Role of one side for one layer:
 * - `primary-write`: authoritative writer for the layer
 * - `read-only`: reads allowed, writes refused with an actionable hint
 * - `paused`: writer temporarily suspended (recovery)
 * - `native`: available but not the main-write switch (ANO-native layers)
 * - `manual`: only a named human may act (release/attest/approve/sync/push)
 */
export type ConnectLayerRole = 'primary-write' | 'read-only' | 'paused' | 'native' | 'manual';

export interface ConnectLayerRoleEntry {
  layer: ConnectCapabilityLayer;
  ano: ConnectLayerRole;
  legacyPm: ConnectLayerRole;
  note: string;
}

export interface ConnectRoleMatrix {
  schema: typeof CONNECT_ROLE_MATRIX_SCHEMA;
  state: TakeoverState;
  layers: ConnectLayerRoleEntry[];
  hostCapability: 'full' | 'degraded' | null;
  /** ADR-006 §8: the host layer is not enforceable and must be reported as degraded. */
  degraded: boolean;
  degradationReasons: string[];
}

export interface ConnectLegacyWriteDecision {
  allowed: boolean;
  state: TakeoverState;
  scope: TakeoverScope | 'all';
  /** Present when `allowed` is false. */
  reason?: string;
  /** Actionable hint for the caller (T-072 wiring point). */
  action?: string;
}

/** Handoff-facing takeover projection; injected only when a policy exists. */
export interface HandoffTakeover {
  state: TakeoverState;
  enforced: boolean;
  legacyPm: ConnectLayerRole;
  authorizationId: string;
  driftPending: boolean;
  roleMatrix: ConnectRoleMatrix;
  note: string;
}

export type ConnectDriftFileKind = 'added' | 'modified' | 'removed';

/** One localized legacy-source difference (path granularity, never line-level). */
export interface ConnectDriftFile {
  path: string;
  kind: ConnectDriftFileKind;
  baselineSha256?: string;
  currentSha256?: string;
  baselineBytes?: number;
  currentBytes?: number;
}

export interface ConnectDriftReport {
  schema: typeof CONNECT_DRIFT_SCHEMA;
  root: string;
  state: TakeoverState;
  authorizationId: string;
  /** Legacy source digest bound at takeover time (the policy baseline). */
  baselineDigest: string;
  /** Freshly recomputed legacy source digest, same digest function as takeover. */
  currentDigest: string;
  drifted: boolean;
  files: ConnectDriftFile[];
  detectedAt: string;
  /** Suggested policy state for the orchestration layer; never applied automatically. */
  recommendation: 'none' | 'recovery';
  /** Drift invalidates the migration reconcile as an acceptance basis (ADR-006 §6.3). */
  reconcileStale: boolean;
  backupId?: string;
  backupHash?: string;
  note: string;
}

export type ConnectDriftWatchStopReason = 'drift' | 'max-cycles' | 'aborted' | 'error';

export interface ConnectDriftWatchOptions {
  /** Project root that owns .pm and .ano/takeover. */
  root: string;
  /** Delay between cycles in milliseconds. Clamped to [MIN_WATCH_INTERVAL_MS, MAX_WATCH_INTERVAL_MS]. */
  intervalMs?: number;
  /** Deterministic test hook: stop after this many cycles. Omit to run until aborted. */
  maxCycles?: number;
  /** AbortSignal stops the foreground loop promptly (between cycles). */
  signal?: AbortSignal;
  /** Migration source paths; defaults to the project's migration sources. */
  sources?: readonly string[];
  /** Persist the first drift report under .ano/takeover/drift/. Default true. */
  writeReport?: boolean;
  /** Observed once when drift is first detected. */
  onDetect?: (report: ConnectDriftReport) => void;
}

export interface ConnectDriftWatchReport {
  schema: typeof CONNECT_DRIFT_WATCH_SCHEMA;
  root: string;
  /** Effective interval after clamping. */
  intervalMs: number;
  maxCycles?: number;
  /** Number of cycles that ran. */
  cycles: number;
  stopped: ConnectDriftWatchStopReason;
  report?: ConnectDriftReport;
  error?: string;
}
