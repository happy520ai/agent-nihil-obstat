export {
  planConnection,
  connectProject,
  connectionStatus,
  recallConnected,
  exportConnection,
  handoffReadiness,
  createConnectEngine,
  deriveConnectionId,
  CONNECT_CAPABILITIES,
} from './engine.ts';
export type { ConnectEngine, ConnectEngineOptions, ConnectHooks, PlanOptions, ConnectOptions, RecallInput } from './engine.ts';
export { ConnectError, ConnectSourceError, ConnectLimitError, ConnectStoreError, ConnectTamperError } from './errors.ts';
export { pmMcpAdapter, DEFAULT_SCAN_LIMITS } from './adapter.ts';
export type { SourceAdapter, SourceScan, ScanLimits, ScannedFile } from './adapter.ts';
export { ConnectStore, CONNECT_DIR_REL } from './store.ts';
export { backupProject, restoreProject, verifyBackup, listBackups, backupHash, BACKUP_SCHEMA } from './backup.ts';
export type { BackupManifest, BackupVerification } from './backup.ts';
export { readCutover, writeCutover, cutoverPath, CUTOVER_SCHEMA } from './cutover.ts';
export type { CutoverConfirmation } from './cutover.ts';
export { categoryForStatus, toConnectedTask } from './records.ts';
export {
  CONNECT_SCHEMA,
  CONNECT_SNAPSHOT_SCHEMA,
  CONNECT_MANIFEST_SCHEMA,
  CONNECT_CURRENT_SCHEMA,
  CONNECT_EXPORT_SCHEMA,
  CONNECT_CHECKPOINT_SCHEMA,
} from './types.ts';
export {
  watchConnection,
  CONNECT_WATCH_SCHEMA,
  MIN_WATCH_INTERVAL_MS,
  DEFAULT_WATCH_INTERVAL_MS,
  MAX_WATCH_INTERVAL_MS,
} from './watch.ts';
export type {
  ConnectWatchOptions,
  ConnectWatchReport,
  ConnectWatchCycleRecord,
  ConnectWatchOutcome,
  ConnectWatchStopReason,
} from './watch.ts';
export type {
  ConnectSourceKind,
  ConnectTaskCategory,
  ConnectIdentity,
  ConnectedIdentity,
  ConnectionFileEntry,
  ConnectionExcludedEntry,
  ConnectionCounts,
  ConnectionPlan,
  ConnectionReport,
  ConnectionResult,
  ConnectionSummary,
  ConnectedTask,
  ConnectionStatus,
  RecallHit,
  RecallResult,
  ExportChange,
  ExportConnection,
  ExportConnectionFile,
  ExportConnectionVersion,
  HandoffReadiness,
  StoredRecord,
  StoredSnapshot,
  ManifestVersion,
  ConnectManifest,
  ConnectCurrent,
  ConnectCheckpoint,
} from './types.ts';
