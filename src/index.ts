export { toolCatalog, cliCommands, humanOnlyCommands } from './surface/tool-catalog.ts';
export {
  brief,
  recall,
  recallProbe,
  note,
  noteRevise,
  noteRelate,
  memoryFact,
  memoryProbe,
  verifyContext,
  probeManifestToFrozenContext,
  takeoverGrant,
  takeoverApply,
  takeoverDisable,
  takeoverRecover,
  takeoverRevoke,
  takeoverStatusSurface,
  assertLegacyConnectWriteAllowed,
} from './surface/service.ts';
export type { BriefSurfaceInput, RecallProbeSurfaceInput, ContextVerifySurfaceInput, TakeoverGrantSurfaceInput, TakeoverApplySurfaceInput } from './surface/service.ts';
export {
  readTakeoverSurface,
  takeoverSurfaceField,
  assertTakeoverAllowsNativeWrite,
  type TakeoverSurfaceStatus,
  type TakeoverSurfaceSnapshot,
  type TakeoverSurfaceState,
  type TakeoverPrimaryWriter,
  type TakeoverLegacyRole,
  type TakeoverScopeOwner,
  type TakeoverScopeName,
} from './surface/memory.ts';
export {
  roleMatrixForState,
  legacyWriteDecision,
  assertLegacyWriteAllowed,
  ConnectLegacyWriteBlockedError,
  CONNECT_HOST_DEGRADATION_REASONS,
} from './connect/capabilities.ts';
export {
  detectLegacyDrift,
  watchDrift,
  writeDriftReport,
} from './connect/watch.ts';
export type {
  ConnectRoleMatrix,
  ConnectLayerRoleEntry,
  ConnectLayerRole,
  ConnectCapabilityLayer,
  ConnectLegacyWriteDecision,
  ConnectDriftReport,
  ConnectDriftFile,
  ConnectDriftFileKind,
  ConnectDriftWatchOptions,
  ConnectDriftWatchReport,
  ConnectDriftWatchStopReason,
} from './connect/types.ts';
export {
  runTakeover,
  takeoverStatus,
  computeTakeoverSourceDigest,
  TakeoverError,
  TakeoverSourceDriftError,
  TakeoverPhaseError,
  TAKEOVER_RUN_SCHEMA,
  TAKEOVER_STATUS_SCHEMA,
  type TakeoverRunOptions,
  type TakeoverRunResult,
  type TakeoverStatus,
  type TakeoverHostCapability,
  type TakeoverPhaseSummary,
} from './connect/takeover.ts';
export type {
  TakeoverState,
  TakeoverScope,
  TakeoverPhase,
  TakeoverAuthorization,
  TakeoverPolicy,
  TakeoverTransaction,
} from './connect/takeover-policy.ts';
export { Ledger, type LedgerTask, type LedgerEvidence } from './ledger/ledger.ts';
export { planMigration, reconcileMigration, migrateProject, MIGRATION_KEY_PREFIX, DEFAULT_MIGRATION_SOURCES, MigrationError } from './ledger/migrate.ts';
export type { MigrationPlan, MigrationResult, MigrationOptions, MigrationSource, MigrationTaskPlan } from './ledger/migrate.ts';
export { GraphStore } from './structure/store.ts';
export { fingerprintTree } from './core/fingerprint.ts';
export { verifyTask, type VerifyRequest } from './gate/verify.ts';
export { verdictForTask } from './gate/verdict.ts';
export { impact, testCoverage, blastRadius } from './gate/blast.ts';
export { runAudit, findingIdentity } from './audit/index.ts';
export { scanSecurity, securityRules } from './audit/security.ts';
export { scanLicenses, classifySpdx } from './audit/license.ts';
export { scanDependencies } from './audit/deps.ts';
export { scanDrift, packageEntries } from './audit/drift.ts';
export { loadGovernancePolicy, scanGovernance } from './audit/governance.ts';
export { mergeFindings, listFindings, resolveFinding, findingStorePath } from './audit/findings.ts';
export { auditEvents, ledgerAuditInputs, InMemoryAuditEventSink, JsonlAuditEventSink } from './audit/events.ts';
export {
  approveBaseline,
  saveBaselineDraft,
  loadBaselineDraft,
  loadApprovedBaseline,
  verifyBaseline,
  listBaselines,
  isInteractiveTty,
  BASELINE_SCHEMA_VERSION,
  BaselineError,
} from './readiness/baseline.ts';
export { detectInstallation, doctor } from './surface/doctor.ts';
export { exportProject } from './surface/export.ts';
export { startUiServer, renderPanel, escapeHtml, UI_HOST, UI_CSP } from './surface/ui.ts';
export {
  planConnection,
  connectProject,
  connectionStatus,
  recallConnected,
  exportConnection,
  handoffReadiness,
  backupProject,
  restoreProject,
  verifyBackup,
  listBackups,
  backupHash,
  readCutover,
  writeCutover,
  CONNECT_CAPABILITIES,
  ConnectError,
  ConnectSourceError,
  ConnectLimitError,
  ConnectStoreError,
  ConnectTamperError,
} from './connect/index.ts';
export type {
  ConnectSourceKind,
  ConnectTaskCategory,
  ConnectIdentity,
  ConnectedIdentity,
  ConnectionFileEntry,
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
  PlanOptions,
  ConnectOptions,
  RecallInput,
} from './connect/index.ts';
export type {
  AuditScope,
  AuditFinding,
  AuditResult,
  AuditEvent,
  AuditEventSink,
  AuditRunOptions,
  AuditContext,
  AuditGraphView,
  GovernancePolicy,
  OnlineScanner,
} from './audit/types.ts';
export type { BaselineDraft, ApprovedBaseline, BaselineVerification, ApprovalInput } from './readiness/baseline.ts';
export type { GraphSnapshot, GraphEdge, Freshness } from './structure/types.ts';

// ============================================================================
// ADR-007 multi-client contract (T-080~T-084 frozen modules, T-085 entry).
// Re-exported for library consumers; the MCP tool count stays at seven.
// ============================================================================
export {
  CLIENT_IDS,
  CLIENT_ALIASES,
  CLIENT_ALIAS_TARGET,
  CAPABILITY_LAYERS,
  CORE_LAYERS,
  EXTENSION_LAYERS,
  EVIDENCE_CODES,
  EVIDENCE_CODE_LAYER,
  MCP_TOOL_NAMES,
  MCP_TOOL_COUNT,
  MCP_PROTOCOL_VERSION,
  CLIENT_REPORT_SCHEMA,
  DOCTOR_REPORT_SCHEMA,
  AUTHORIZATION_SCHEMA,
  VERDICT_ORDER,
  weakestVerdict,
  isCapabilityLayer,
  isClientVerdict,
  isClientEvidence,
} from './clients/types.ts';
export type {
  ClientId,
  ClientAlias,
  CapabilityLayer,
  CoreLayer,
  ExtensionLayer,
  ClientVerdict,
  ClientEvidence,
  ClientStatus,
  EvidenceCode,
  IdentitySourceKind,
  IdentitySource,
  ConfigCandidate,
  ConfigScope,
  ConfigFormat,
  ClientDescriptor,
  ClientIdentityStatus,
  IsolatedError,
  DetectionEvidence,
  DetectInput,
  DetectResult,
  InspectInput,
  DetectedDetails,
  ConfiguredDetails,
  McpDetails,
  ToolsDetails,
  BriefDetails,
  InstructionsDetails,
  OrchestrationMode,
  OrchestrationDetails,
  HistoryDetails,
  OutputInterceptionDetails,
  LayerReport,
  LayerReports,
  MutableLayerReports,
  ClientReport,
  ConfigTarget,
  ClientAuthorizationRef,
  ConfigInput,
  ProposedChange,
  BackupPlan,
  ConfigResult,
  McpInitializeResult,
  McpToolDescriptor,
  McpToolsResult,
  McpCallRequest,
  McpCallResult,
  McpClientLike,
  VerifyInput,
  McpHandshakeEvidence,
  ToolsEvidence,
  BriefEvidence,
  VerifyResult,
  ClientAdapter,
} from './clients/types.ts';
export { defaultRegistry, createRegistry, getDescriptor, listDescriptors, resolveClientId, UnknownClientError } from './clients/registry.ts';
export type { ClientRegistry } from './clients/registry.ts';
export {
  doctorClients,
  doctorClient,
  genericDetect,
  discoverClientConfig,
  verifyStdioMcp,
  unavailableLayerReports,
  registerAllClientAdapters,
} from './clients/doctor.ts';
export type { DoctorRunOptions, DoctorReport, ConfigDiscovery, ClientAdapterAssemblyOptions } from './clients/doctor.ts';
export {
  CLIENT_TAKEOVER_CAPABILITIES_SCHEMA,
  CLIENT_CAPABILITY_COLUMNS,
  HOST_AUTO_INTERCEPTION_AVAILABLE,
  HOST_AUTO_APPROVAL_AVAILABLE,
  HOST_AUTO_SESSION_DAEMON_AVAILABLE,
  mapClientCapabilities,
  mapDoctorReport,
  clientTakeoverCapabilities,
  CLIENT_ACCESS_PLAN_SCHEMA,
  CLIENT_ACCESS_ROUTES,
  planClientAccess,
  planAccessReport,
  clientAccessPlans,
} from './clients/capabilities.ts';
export type {
  ClientCapabilityColumn,
  ClientCapabilityJudgement,
  ClientTakeoverCapabilities,
  ClientTakeoverCapabilitiesReport,
  ClientAccessRoute,
  ClientAccessTarget,
  ClientAccessBackupPlan,
  ClientAccessPlan,
  ClientAccessPlanSummary,
  ClientAccessPlanReport,
  ClientAccessPlanOptions,
} from './clients/capabilities.ts';
export {
  CLIENT_CONFIG_BACKUP_SCHEMA,
  CLIENT_CONFIG_INSTALL_SCHEMA,
  CLIENT_CONFIG_SCOPES,
  ClientConfigError,
  applyClientConfig,
  planClientConfig,
  readClientConfig,
  discoverClientConfig as discoverClientConfigTargets,
  backupClientConfig,
  verifyClientConfigBackup,
  readClientConfigBackup,
  listClientConfigBackups,
  restoreClientConfig,
  restoreFromBackup,
  parseTomlDocument,
  assertSafeTargetPath,
  checkClientConfigAuthorization,
  resolveClientConfigRoot,
  atomicWriteFile,
} from './clients/config.ts';
export type {
  ClientConfigScopeName,
  ClientConfigFormat,
  ClientConfigScope,
  ClientConfigTarget,
  ClientConfigAuthorization,
  ClientConfigServiceEntry,
  ClientConfigSnapshot,
  ClientConfigChange,
  ClientConfigPlan,
  ClientConfigResult,
  ClientConfigBackup,
  ClientConfigBackupVerification,
  ClientConfigDiscovery,
  ClientConfigIo,
  ClientConfigHooks,
  ClientConfigApplyOptions,
  ClientConfigErrorCode,
  ClientConfigRestoreOptions,
} from './clients/config.ts';
export {
  installClientConfig,
  uninstallClientConfig,
  readInstallRecord,
  writeInstallRecord,
  restoreClientConfig as restoreClientConfigFromBackup,
  installClientBatch,
} from './clients/install.ts';
export type {
  ClientInstallOptions,
  ClientInstallAction,
  ClientInstallResult,
  ClientInstallRecord,
  ClientBatchInstallOptions,
  ClientBatchSkipped,
  ClientBatchInstallSummary,
  ClientBatchInstallResult,
} from './clients/install.ts';
export {
  claudeCodeAdapter,
  createClaudeCodeAdapter,
  claudeCodeConfigTarget,
  CLAUDE_CODE_IDENTITY_SOURCES,
  CLAUDE_CODE_SERVER_PATH,
  CLAUDE_CODE_SERVER_NAME,
} from './clients/claude-code.ts';
export type { ClaudeCodeAdapterOptions } from './clients/claude-code.ts';
export {
  codexAdapter,
  createCodexAdapter,
  codexConfigTarget,
  CODEX_IDENTITY_SOURCES,
  CODEX_SERVER_PATH,
  CODEX_SERVER_NAME,
} from './clients/codex.ts';
export type { CodexAdapterOptions } from './clients/codex.ts';
export {
  cursorAdapter,
  CURSOR_IDENTITY_SOURCES,
  CURSOR_SERVER_PATH,
  CURSOR_SERVER_NAME,
  CURSOR_USER_CONFIG,
  CURSOR_PROJECT_CONFIG,
  CURSOR_RULE_PATHS,
} from './clients/cursor.ts';
export {
  opencodeAdapter,
  OPENCODE_IDENTITY_SOURCES,
  OPENCODE_SERVER_PATH,
  OPENCODE_SERVER_NAME,
  OPENCODE_USER_CONFIG,
  OPENCODE_PROJECT_CONFIG,
  OPENCODE_PROJECT_ALT_CONFIG,
  OPENCODE_RULE_PATHS,
} from './clients/opencode.ts';
export {
  qoderAdapter,
  createQoderAdapter,
  QODER_CLIENT_ID,
  QODER_EXECUTABLE_NAMES,
  QODER_CONFIG_CANDIDATES,
  QODER_MCP_KEY,
  QODER_MEASURED_FACT_PREFIX,
  QODER_CONFIG_FACT_PREFIX,
  QODER_PUBLIC_ASSUMPTION_PREFIX,
  QODER_CONFIG_REFUSED_PREFIX,
} from './clients/qoder.ts';
export type { QoderAdapterOptions, QoderFs, QoderConfigCandidateDeclaration } from './clients/qoder.ts';
export {
  dshAdapter,
  piAdapter,
  createUnknownAdapter,
  buildUnknownClientReport,
  enforceUnknownReport,
  registerExternalAdapter,
  validateExternalAdapter,
  ExternalAdapterRejectedError,
  UNKNOWN_CLIENT_IDS,
  UNKNOWN_CLIENT_STATUS,
  UNKNOWN_VERDICT_CEILING,
  isUnknownClientId,
} from './clients/unknown.ts';
export type {
  UnknownClientId,
  UnknownAdapterOptions,
  ExternalCapabilityDeclaration,
  ExternalEvidenceDeclaration,
  ExternalAdapterDeclaration,
  ExternalAdapterValidation,
  ExternalValidationIssue,
  ExternalValidationResult,
} from './clients/unknown.ts';
export {
  clientDoctorReport,
  clientDoctorSingle,
  clientAccessPlanReport,
  resolveClientTarget,
  createClientAuthorization,
  clientInstallSurface,
  clientRestoreSurface,
} from './surface/service.ts';
export type {
  ClientSurfaceEnvironment,
  ClientDoctorOptions,
  ClientTargetOptions,
  ClientTargetResolution,
  ClientAuthorizationGrantInput,
  ClientInstallSurfaceInput,
  ClientInstallSurfaceResult,
  ClientRestoreSurfaceInput,
  ClientRestoreSurfaceResult,
} from './surface/service.ts';

export const projectStatus = { phase: 'P7', release: 'alpha', verified: 'local-only' } as const;
