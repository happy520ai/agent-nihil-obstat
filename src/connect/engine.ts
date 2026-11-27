import { withFileLock } from '../core/lock.ts';
import { canonicalJson, sha256Hex } from './canonical.ts';
import { ConnectSourceError, ConnectStoreError } from './errors.ts';
import { pmMcpAdapter, DEFAULT_SCAN_LIMITS, type ScanLimits, type SourceAdapter, type SourceScan } from './adapter.ts';
import { extractRecords } from './records.ts';
import { ConnectStore } from './store.ts';
import { readActiveConnection } from './active.ts';
import { countChanges, diffRecords } from './changes.ts';
import { clamp } from './read.ts';
import { connectionStatus as readConnectionStatus } from './status.ts';
import { recallConnected as runRecallConnected } from './recall.ts';
import { exportConnection as runExportConnection } from './export.ts';
import { handoffReadiness as readHandoffReadiness } from './handoff.ts';
import { CONNECT_CAPABILITIES } from './capabilities.ts';
import type {
  ConnectCurrent,
  ConnectIdentity,
  ConnectManifest,
  ConnectCheckpoint,
  ConnectionFileEntry,
  ConnectionPlan,
  ConnectionReport,
  ConnectionResult,
  ConnectionStatus,
  ExportConnection,
  HandoffReadiness,
  RecallResult,
  StoredSnapshot,
} from './types.ts';
import { CONNECT_SCHEMA } from './types.ts';

export { CONNECT_CAPABILITIES } from './capabilities.ts';

export interface PlanOptions {
  source?: 'pm-mcp';
}

export interface ConnectOptions {
  source?: 'pm-mcp';
  expectedDigest?: string;
}

export interface RecallInput {
  query?: string;
  limit?: number;
}

export interface ConnectHooks {
  /** Test/fault-injection hook invoked after a batch is durably checkpointed. */
  afterBatch?: (info: { batchIndex: number; totalBatches: number; files: ConnectionFileEntry[] }) => void | Promise<void>;
  /** Fault injection: snapshot is on disk but the checkpoint does not reference it yet. */
  afterSnapshotWritten?: (info: { sourceDigest: string; snapshotPath: string }) => void | Promise<void>;
  /** Fault injection: snapshot bytes are written, checkpoint update has not happened. */
  beforeSnapshotCheckpoint?: (info: { sourceDigest: string; snapshotPath: string }) => void | Promise<void>;
  /** Fault injection: manifest is committed but the current pointer is not written yet. */
  afterManifestWritten?: (info: { version: number; sourceDigest: string }) => void | Promise<void>;
}

export interface ConnectEngineOptions {
  adapter?: SourceAdapter;
  batchSize?: number;
  maxFileBytes?: number;
  maxFiles?: number;
  maxTotalBytes?: number;
  maxDepth?: number;
  now?: () => string;
  hooks?: ConnectHooks;
}

/**
 * Same-process writes are serialized so the file lock's blocking wait can never
 * stall the event loop while another connect is committing. Cross-process
 * writers still coordinate through .ano/connect/lock.
 */
let connectWriteQueue: Promise<unknown> = Promise.resolve();
function serializeConnectWrite<T>(operation: () => Promise<T>): Promise<T> {
  const run = connectWriteQueue.then(operation, operation);
  connectWriteQueue = run.then(() => undefined, () => undefined);
  return run;
}

export function deriveConnectionId(identity: ConnectIdentity): string {
  // Deliberately excludes the mutable display slug: a project rename must not
  // change the connectionId or any derived task id.
  return `CN-${sha256Hex(canonicalJson({ tool: identity.tool, instance: identity.instance, projectKey: identity.projectKey })).slice(0, 16)}`;
}

function fileEntries(scan: SourceScan): ConnectionFileEntry[] {
  return scan.files.map((file) => ({
    path: file.path,
    hash: file.hash,
    bytes: file.bytes,
    mediaType: file.mediaType,
    binary: file.binary,
  }));
}

class ConnectEngineImpl {
  private readonly adapter: SourceAdapter;
  private readonly limits: ScanLimits;
  private readonly batchSize: number;
  private readonly now: () => string;
  private readonly hooks: ConnectHooks;

  constructor(options: ConnectEngineOptions = {}) {
    this.adapter = options.adapter ?? pmMcpAdapter;
    this.limits = {
      maxFileBytes: options.maxFileBytes ?? DEFAULT_SCAN_LIMITS.maxFileBytes,
      maxFiles: options.maxFiles ?? DEFAULT_SCAN_LIMITS.maxFiles,
      maxTotalBytes: options.maxTotalBytes ?? DEFAULT_SCAN_LIMITS.maxTotalBytes,
      maxDepth: options.maxDepth ?? DEFAULT_SCAN_LIMITS.maxDepth,
    };
    this.batchSize = clamp(options.batchSize ?? 16, 1, 1000, 16);
    this.now = options.now ?? (() => new Date().toISOString());
    this.hooks = options.hooks ?? {};
  }

  async planConnection(root: string, options: PlanOptions = {}): Promise<ConnectionPlan> {
    assertSource(options.source);
    const scan = await this.adapter.scan(root, this.limits);
    const connectionId = deriveConnectionId(scan.identity);
    const extracted = extractRecords(scan, connectionId);
    return {
      schema: CONNECT_SCHEMA,
      root: scan.root,
      source: 'pm-mcp',
      connectionId,
      sourceDigest: scan.sourceDigest,
      files: fileEntries(scan),
      excluded: scan.excluded,
      counts: {
        files: scan.counts.files,
        totalBytes: scan.counts.totalBytes,
        textFiles: scan.counts.textFiles,
        binaryFiles: scan.counts.binaryFiles,
        excluded: scan.counts.excluded,
        excludedBytes: scan.counts.excludedBytes,
        records: extracted.records.length,
        tasks: extracted.recordCounts['task'] ?? 0,
      },
      warnings: [...scan.warnings, ...extracted.warnings],
      capabilities: [...CONNECT_CAPABILITIES],
      canConnect: true,
      identity: scan.identity,
    };
  }

  async connectProject(root: string, options: ConnectOptions = {}): Promise<ConnectionResult> {
    assertSource(options.source);
    const initial = await this.adapter.scan(root, this.limits);
    const connectionId = deriveConnectionId(initial.identity);
    if (options.expectedDigest !== undefined && options.expectedDigest !== initial.sourceDigest) {
      return changedResult(connectionId, initial.sourceDigest);
    }
    const store = new ConnectStore(initial.root);
    store.prepare();
    return serializeConnectWrite(() => withFileLock(store.lockPath, () => this.commit(store, initial.root, connectionId, options.expectedDigest)));
  }

  private async commit(
    store: ConnectStore,
    root: string,
    connectionId: string,
    expectedDigest: string | undefined,
  ): Promise<ConnectionResult> {
    const fresh = await this.adapter.scan(root, this.limits);
    const rederived = deriveConnectionId(fresh.identity);
    if (rederived !== connectionId) {
      return changedResult(rederived, fresh.sourceDigest);
    }
    if (expectedDigest !== undefined && expectedDigest !== fresh.sourceDigest) {
      return changedResult(connectionId, fresh.sourceDigest);
    }

    const active = readActiveConnection(store, true);
    let manifest: ConnectManifest | null = active?.manifest ?? null;
    if (active && active.current.connectionId !== connectionId) {
      // The active connection belongs to a different identity; start a new one.
      manifest = null;
    }
    const currentDigest = manifest?.current.sourceDigest ?? null;

    if (manifest !== null && currentDigest === fresh.sourceDigest) {
      const load = store.loadSnapshot(connectionId, fresh.sourceDigest);
      const tasks = load.snapshot.records.filter((record) => record.kind === 'task');
      return {
        schema: CONNECT_SCHEMA,
        connectionId,
        source: 'pm-mcp',
        sourceDigest: fresh.sourceDigest,
        duplicate: true,
        sourceUnchanged: true,
        report: {
          connected: true,
          version: manifest.current.version,
          snapshotPath: manifest.current.snapshotPath,
          ...(manifest.current.previousDigest ? { previousDigest: manifest.current.previousDigest } : {}),
          files: load.snapshot.files.length,
          totalBytes: load.snapshot.files.reduce((sum, file) => sum + file.bytes, 0),
          records: load.snapshot.records.length,
          tasks: tasks.length,
          recordCounts: load.snapshot.recordCounts,
          excluded: load.snapshot.excluded,
          changes: { added: 0, updated: 0, removed: 0 },
          warnings: [...fresh.warnings, ...load.snapshot.warnings],
          resumedFromCheckpoint: false,
        },
      };
    }

    const extracted = extractRecords(fresh, connectionId);
    const runId = `run-${connectionId}-${fresh.sourceDigest}`;
    const files = fileEntries(fresh);
    const totalBatches = Math.max(1, Math.ceil(files.length / this.batchSize));
    let checkpoint: ConnectCheckpoint | null = store.readCheckpoint(runId);
    const resumable = checkpoint !== null
      && checkpoint.connectionId === connectionId
      && checkpoint.sourceDigest === fresh.sourceDigest
      && checkpoint.totalFiles === files.length
      && checkpoint.batchSize === this.batchSize;
    if (!resumable) {
      checkpoint = {
        schema: 'ano.connect-checkpoint/1',
        runId,
        connectionId,
        sourceDigest: fresh.sourceDigest,
        phase: 'staging',
        totalFiles: files.length,
        batchSize: this.batchSize,
        nextBatch: 0,
        files,
        createdAt: this.now(),
        updatedAt: this.now(),
      };
      store.writeCheckpoint(checkpoint);
    }
    if (!checkpoint) throw new ConnectStoreError('Connect checkpoint unavailable');
    const stage: ConnectCheckpoint = checkpoint;
    let resumed = stage.phase !== 'staging' || stage.nextBatch > 0;

    if (stage.phase === 'staging') {
      for (let index = stage.nextBatch; index < totalBatches; index += 1) {
        const batchFiles = files.slice(index * this.batchSize, (index + 1) * this.batchSize);
        const sourceBatch = fresh.files.slice(index * this.batchSize, (index + 1) * this.batchSize);
        for (let fileIndex = 0; fileIndex < batchFiles.length; fileIndex += 1) {
          const entry = batchFiles[fileIndex];
          const source = sourceBatch[fileIndex];
          if (!entry || !source) throw new ConnectStoreError('Batch staging index mismatch');
          store.putBlob(entry.hash, source.content);
        }
        stage.nextBatch = index + 1;
        stage.updatedAt = this.now();
        store.writeCheckpoint({ ...stage });
        if (this.hooks.afterBatch) {
          await this.hooks.afterBatch({ batchIndex: index, totalBatches, files: batchFiles });
        }
      }
      stage.phase = 'snapshot';
      stage.updatedAt = this.now();
      store.writeCheckpoint({ ...stage });
    }

    // Every blob must verify against its recorded SHA-256 before anything is published.
    for (const file of fresh.files) store.readBlob(file.hash);

    const previousDigest = manifest?.current.sourceDigest ?? null;
    const previous = previousDigest ? store.loadSnapshot(connectionId, previousDigest).snapshot : null;
    const changes = diffRecords(previous, extracted.records, previousDigest ? store.storedPathForSnapshot(connectionId, previousDigest) : undefined);

    let snapshot: StoredSnapshot | null = null;
    if (stage.phase === 'snapshot' && stage.snapshotPath && stage.snapshotHash) {
      try {
        const existing = store.loadSnapshot(connectionId, fresh.sourceDigest);
        if (existing.hash === stage.snapshotHash && existing.snapshot.connectionId === connectionId) {
          snapshot = existing.snapshot;
        }
      } catch {
        // A missing/corrupt snapshot referenced by a checkpoint is rebuilt below.
      }
    }
    if (!snapshot) {
      // Immutable content snapshot: no createdAt/previousDigest/changes here, so
      // the same sourceDigest always produces identical bytes and A->B->A reuses it.
      snapshot = {
        schema: 'ano.connect-snapshot/1',
        connectionId,
        source: 'pm-mcp',
        sourceDigest: fresh.sourceDigest,
        identity: fresh.identity,
        files,
        excluded: fresh.excluded,
        records: extracted.records,
        recordCounts: extracted.recordCounts,
        warnings: [...fresh.warnings, ...extracted.warnings],
      };
      const written = store.writeSnapshot(connectionId, snapshot);
      stage.snapshotPath = store.toRootRelative(written.path);
      stage.snapshotHash = written.hash;
      if (this.hooks.beforeSnapshotCheckpoint) {
        await this.hooks.beforeSnapshotCheckpoint({ sourceDigest: fresh.sourceDigest, snapshotPath: stage.snapshotPath });
      }
      stage.phase = 'snapshot';
      stage.updatedAt = this.now();
      store.writeCheckpoint({ ...stage });
      if (this.hooks.afterSnapshotWritten) await this.hooks.afterSnapshotWritten({ sourceDigest: fresh.sourceDigest, snapshotPath: stage.snapshotPath });
    }

    const version = (manifest?.current.version ?? 0) + 1;
    const snapshotPath = stage.snapshotPath ?? store.storedPathForSnapshot(connectionId, fresh.sourceDigest);
    const snapshotHash = stage.snapshotHash ?? store.loadSnapshot(connectionId, fresh.sourceDigest).hash;
    const versionEntry = {
      version,
      sourceDigest: fresh.sourceDigest,
      snapshotPath,
      snapshotHash,
      createdAt: this.now(),
      files: files.length,
      records: extracted.records.length,
      previousDigest,
      changes,
    };
    const versions = manifest ? [...manifest.versions, versionEntry] : [versionEntry];
    const nextManifest: ConnectManifest = {
      schema: 'ano.connect-manifest/1',
      connectionId,
      source: 'pm-mcp',
      identity: fresh.identity,
      root: fresh.root,
      createdAt: manifest?.createdAt ?? this.now(),
      updatedAt: this.now(),
      current: versionEntry,
      versions,
    };
    store.writeManifest(nextManifest);
    if (this.hooks.afterManifestWritten) await this.hooks.afterManifestWritten({ version, sourceDigest: fresh.sourceDigest });
    const currentPointer: ConnectCurrent = {
      schema: 'ano.connect-current/1',
      connectionId,
      sourceDigest: fresh.sourceDigest,
      version,
      snapshotPath,
      snapshotHash,
      updatedAt: this.now(),
    };
    store.writeCurrent(currentPointer);
    stage.phase = 'complete';
    stage.updatedAt = this.now();
    store.writeCheckpoint({ ...stage });
    store.removeCheckpoint(runId);

    const changeCounts = countChanges(changes);
    return {
      schema: CONNECT_SCHEMA,
      connectionId,
      source: 'pm-mcp',
      sourceDigest: fresh.sourceDigest,
      duplicate: false,
      sourceUnchanged: true,
      report: {
        connected: true,
        version,
        snapshotPath,
        ...(previousDigest ? { previousDigest } : {}),
        files: files.length,
        totalBytes: fresh.counts.totalBytes,
        records: extracted.records.length,
        tasks: extracted.recordCounts['task'] ?? 0,
        recordCounts: extracted.recordCounts,
        excluded: fresh.excluded,
        changes: changeCounts,
        warnings: snapshot.warnings,
        resumedFromCheckpoint: resumed,
      },
    };
  }

  async connectionStatus(root: string): Promise<ConnectionStatus> {
    return readConnectionStatus(root);
  }

  async recallConnected(root: string, input: RecallInput = {}): Promise<RecallResult> {
    return runRecallConnected(root, input);
  }

  async exportConnection(root: string): Promise<ExportConnection> {
    return runExportConnection(root, this.now);
  }

  async handoffReadiness(root: string): Promise<HandoffReadiness> {
    return readHandoffReadiness(root);
  }
}

function assertSource(source: string | undefined): void {
  if (source !== undefined && source !== 'pm-mcp') {
    throw new ConnectSourceError(`Unsupported Connect source: ${source}`);
  }
}

function changedResult(connectionId: string, sourceDigest: string): ConnectionResult {
  return {
    schema: CONNECT_SCHEMA,
    connectionId,
    source: 'pm-mcp',
    sourceDigest,
    duplicate: false,
    sourceUnchanged: false,
    report: {
      connected: false,
      reason: 'source-changed',
      version: 0,
      snapshotPath: '',
      files: 0,
      totalBytes: 0,
      records: 0,
      tasks: 0,
      recordCounts: {},
      excluded: [],
      changes: { added: 0, updated: 0, removed: 0 },
      warnings: ['Source digest does not match expectedDigest; nothing was written.'],
      resumedFromCheckpoint: false,
    },
  };
}

export interface ConnectEngine {
  planConnection(root: string, options?: PlanOptions): Promise<ConnectionPlan>;
  connectProject(root: string, options?: ConnectOptions): Promise<ConnectionResult>;
  connectionStatus(root: string): Promise<ConnectionStatus>;
  recallConnected(root: string, input?: RecallInput): Promise<RecallResult>;
  exportConnection(root: string): Promise<ExportConnection>;
  handoffReadiness(root: string): Promise<HandoffReadiness>;
}

export function createConnectEngine(options: ConnectEngineOptions = {}): ConnectEngine {
  return new ConnectEngineImpl(options);
}

const defaultEngine = createConnectEngine();

export function planConnection(root: string, options?: PlanOptions): Promise<ConnectionPlan> {
  return defaultEngine.planConnection(root, options);
}

export function connectProject(root: string, options?: ConnectOptions): Promise<ConnectionResult> {
  return defaultEngine.connectProject(root, options);
}

export function connectionStatus(root: string): Promise<ConnectionStatus> {
  return defaultEngine.connectionStatus(root);
}

export function recallConnected(root: string, input?: RecallInput): Promise<RecallResult> {
  return defaultEngine.recallConnected(root, input);
}

export function exportConnection(root: string): Promise<ExportConnection> {
  return defaultEngine.exportConnection(root);
}

export function handoffReadiness(root: string): Promise<HandoffReadiness> {
  return defaultEngine.handoffReadiness(root);
}
