/**
 * ADR-007 client contract types (T-080).
 *
 * This module owns the full type surface for multi-client detection,
 * inspection, configuration and real MCP verification. Adapters implement
 * `ClientAdapter`; the registry owns identity metadata; the doctor owns
 * orchestration. Nothing here performs I/O.
 */

// ---------------------------------------------------------------------------
// Client identity
// ---------------------------------------------------------------------------

/**
 * Canonical client ids (ADR-008 §3): the 21 specified tools plus the three M11
 * legacy non-catalog clients (`opencode`/`pi`/`zcode`). Stable ids never rename.
 */
export const CLIENT_IDS = [
  'claude-code',
  'github-copilot',
  'cursor',
  'codex',
  'trae',
  'antigravity',
  'replit-agent',
  'cline',
  'kilo-code',
  'hermes-agent',
  'openclaw',
  'zed',
  'tabnine',
  'amazon-q',
  'jetbrains-ai',
  'codegeex',
  'tongyi-lingma',
  'comate',
  'qoder',
  'codebuddy',
  'deepseek-harness',
  'opencode',
  'pi',
  'zcode',
] as const;

/**
 * `dsh` is an alias of `deepseek-harness` (ADR-008 §8), never a canonical id.
 * It stays in the `ClientId` union only so existing `src/surface` wiring that
 * still spells the legacy id type-checks; `isClientId('dsh')` is false and
 * `resolveClientId('dsh')` returns `deepseek-harness`.
 */
export const LEGACY_CLIENT_ID_ALIASES = ['dsh'] as const;

export type ClientId = (typeof CLIENT_IDS)[number] | (typeof LEGACY_CLIENT_ID_ALIASES)[number];

/** Aliases map to a canonical id; they never add a `ClientId`. */
export const CLIENT_ALIASES = ['cloudcode', 'dsh'] as const;
export type ClientAlias = (typeof CLIENT_ALIASES)[number];

export const CLIENT_ALIAS_TARGET: Readonly<Record<ClientAlias, ClientId>> = {
  cloudcode: 'claude-code',
  dsh: 'deepseek-harness',
};

// ---------------------------------------------------------------------------
// Capability layers
// ---------------------------------------------------------------------------

export const CAPABILITY_LAYERS = [
  'detected',
  'configured',
  'mcp',
  'tools',
  'brief',
  'instructions',
  'orchestration',
  'history',
  'output-interception',
] as const;

export type CapabilityLayer = (typeof CAPABILITY_LAYERS)[number];

/** Core chain; the weakest of these five is the client `coreVerdict`. */
export const CORE_LAYERS = ['detected', 'configured', 'mcp', 'tools', 'brief'] as const;
export type CoreLayer = (typeof CORE_LAYERS)[number];

/** Reported separately; never participate in `coreVerdict`. */
export const EXTENSION_LAYERS = [
  'instructions',
  'orchestration',
  'history',
  'output-interception',
] as const;
export type ExtensionLayer = (typeof EXTENSION_LAYERS)[number];

export function isCapabilityLayer(value: string): value is CapabilityLayer {
  return (CAPABILITY_LAYERS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Verdicts, evidence strength and client status
// ---------------------------------------------------------------------------

/** Fixed three-value verdict. `unknown` is never a layer verdict. */
export type ClientVerdict = 'validated' | 'degraded' | 'unavailable';

/** Evidence strength, orthogonal to verdict. */
export type ClientEvidence = 'measured' | 'configured' | 'assumed' | 'absent';

/** Client-level identity/health status (`unknown` is only valid here). */
export type ClientStatus = 'ready' | 'degraded' | 'unavailable' | 'unknown';

export const VERDICT_ORDER: Readonly<Record<ClientVerdict, number>> = {
  unavailable: 0,
  degraded: 1,
  validated: 2,
};

export function weakestVerdict(verdicts: Iterable<ClientVerdict>): ClientVerdict {
  let weakest: ClientVerdict = 'validated';
  for (const verdict of verdicts) {
    if (VERDICT_ORDER[verdict] < VERDICT_ORDER[weakest]) weakest = verdict;
  }
  return weakest;
}

export function isClientVerdict(value: unknown): value is ClientVerdict {
  return value === 'validated' || value === 'degraded' || value === 'unavailable';
}

export function isClientEvidence(value: unknown): value is ClientEvidence {
  return value === 'measured' || value === 'configured' || value === 'assumed' || value === 'absent';
}

// ---------------------------------------------------------------------------
// Evidence codes E1~E9
// ---------------------------------------------------------------------------

export const EVIDENCE_CODES = ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E8', 'E9'] as const;
export type EvidenceCode = (typeof EVIDENCE_CODES)[number];

export const EVIDENCE_CODE_LAYER: Readonly<Record<EvidenceCode, CapabilityLayer>> = {
  E1: 'detected',
  E2: 'configured',
  E3: 'mcp',
  E4: 'tools',
  E5: 'brief',
  E6: 'instructions',
  E7: 'orchestration',
  E8: 'history',
  E9: 'output-interception',
};

// ---------------------------------------------------------------------------
// MCP invariants
// ---------------------------------------------------------------------------

/** The seventh tool is forbidden; this list is the single source of truth. */
export const MCP_TOOL_NAMES = ['brief', 'explore', 'recall', 'track', 'note', 'verify', 'audit'] as const;
export type McpToolName = (typeof MCP_TOOL_NAMES)[number];
export const MCP_TOOL_COUNT = 7;

export const MCP_PROTOCOL_VERSION = '2025-06-18';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const CLIENT_REPORT_SCHEMA = 'ano.client-report/1';
export const DOCTOR_REPORT_SCHEMA = 'ano.client-doctor-report/1';
export const AUTHORIZATION_SCHEMA = 'ano.client-authorization/1';

// ---------------------------------------------------------------------------
// Identity sources and config candidates (registry metadata)
// ---------------------------------------------------------------------------

export const IDENTITY_SOURCE_KINDS = [
  'executable',
  'process',
  'env',
  'config-path',
  'package-manager',
] as const;
export type IdentitySourceKind = (typeof IDENTITY_SOURCE_KINDS)[number];

export interface IdentitySource {
  readonly kind: IdentitySourceKind;
  /** Executable name, path candidate or environment variable name. */
  readonly value: string;
  readonly detail: string | null;
}

export const CONFIG_SCOPES = ['user', 'project', 'workspace'] as const;
export type ConfigScope = (typeof CONFIG_SCOPES)[number];

export const CONFIG_FORMATS = ['json', 'toml'] as const;
export type ConfigFormat = (typeof CONFIG_FORMATS)[number];

export interface ConfigCandidate {
  /** Declared path candidate. `~` is expanded against the injected home. */
  readonly path: string;
  readonly scope: ConfigScope;
  readonly format: ConfigFormat;
  /** Dotted key inside the file, e.g. `mcpServers.ano`. */
  readonly key: string;
}

/**
 * Client-level identity status. `unknown` is an intermediate state ("product
 * identity not yet verified"), not a permanent ban (ADR-008 §4.3/§8).
 */
export type ClientIdentityStatus = 'declared' | 'unverified' | 'unknown';

/** Product form (ADR-008 §3); `unknown` when the form itself is unverified. */
export const PRODUCT_FORMS = [
  'cli',
  'editor',
  'ide-plugin',
  'cloud-service',
  'agent-framework',
  'desktop-app',
  'web-ui',
  'unknown',
] as const;
export type ProductForm = (typeof PRODUCT_FORMS)[number];

/** Configuration/interface carrier (ADR-008 §3). */
export const INTERFACE_CARRIERS = [
  'mcp',
  'rules',
  'cli',
  'plugin',
  'acp',
  'sdk',
  'cordis',
  'none',
] as const;
export type InterfaceCarrier = (typeof INTERFACE_CARRIERS)[number];

/**
 * Client-level initial evidence label (ADR-008 §4.3). `unverified` = identity
 * or interface publicly documented but not measured locally; `unavailable` = no
 * usable public interface. Neither may ever be reported as `measured`/`validated`.
 */
export type ClientInitialVerdict = 'unverified' | 'unavailable';

export interface ClientDescriptor {
  readonly id: ClientId;
  readonly alias: string | null;
  readonly identityStatus: ClientIdentityStatus;
  readonly identitySources: readonly IdentitySource[];
  readonly configCandidates: readonly ConfigCandidate[];
  /** Rule/instruction paths (relative to root, or `~`/`//` absolute candidates). */
  readonly rulePaths: readonly string[];
  readonly notes: readonly string[];
  /** ADR-008 §3 product form(s). */
  readonly productForms: readonly ProductForm[];
  /** ADR-008 §3 configuration/interface carriers; empty when 待核实. */
  readonly interfaceCarriers: readonly InterfaceCarrier[];
  /** ADR-008 §3 official public sources (E0/E1); empty when not enumerated. */
  readonly officialSources: readonly string[];
  /** ADR-008 §4.3 initial client-level evidence label; never `validated`. */
  readonly initialVerdict: ClientInitialVerdict;
}

// ---------------------------------------------------------------------------
// Isolated errors
// ---------------------------------------------------------------------------

export interface IsolatedError {
  readonly layer: CapabilityLayer | 'client';
  /** Stable error code, e.g. `E3_HANDSHAKE_FAILED`. */
  readonly code: string;
  readonly message: string;
  readonly at: string;
  readonly source: string | null;
}

// ---------------------------------------------------------------------------
// detect
// ---------------------------------------------------------------------------

export interface DetectionEvidence {
  readonly source: string;
  readonly kind: IdentitySourceKind;
  readonly executablePath: string | null;
  readonly version: string | null;
  readonly detectedAt: string;
}

export interface DetectInput {
  readonly env?: Record<string, string>;
  readonly cwd?: string;
  readonly probePaths?: readonly string[];
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface DetectResult {
  readonly clientId: ClientId;
  readonly detected: boolean;
  readonly executablePath: string | null;
  readonly version: string | null;
  readonly sources: readonly DetectionEvidence[];
  readonly errors: readonly IsolatedError[];
}

// ---------------------------------------------------------------------------
// inspect / nine-layer report
// ---------------------------------------------------------------------------

export interface InspectInput {
  readonly root?: string;
  readonly env?: Record<string, string>;
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface DetectedDetails {
  readonly detected: boolean;
  readonly executablePath: string | null;
  readonly version: string | null;
  readonly sources: readonly DetectionEvidence[];
}

export interface ConfiguredDetails {
  readonly configPath: string | null;
  readonly scope: ConfigScope | null;
  readonly key: string | null;
  readonly resolvedEntry: unknown;
  readonly exists: boolean;
}

export interface McpDetails {
  readonly transport: 'stdio';
  readonly protocolVersion: string | null;
  readonly serverInfo: unknown;
  readonly latencyMs: number | null;
  readonly startedAt: string | null;
}

export interface ToolsDetails {
  readonly count: number;
  readonly names: readonly string[];
  readonly missing: readonly string[];
  readonly extra: readonly string[];
}

export interface BriefDetails {
  readonly schema: unknown;
  readonly hasProjectContext: boolean;
  readonly takeoverProjection: boolean;
  readonly hostCapability: ClientVerdict | null;
}

export interface InstructionsDetails {
  readonly rulePaths: readonly string[];
  readonly formatVersion: string | null;
  readonly hasManagedSection: boolean;
  readonly readOnly: true;
}

export type OrchestrationMode = 'native' | 'explicit-workflow' | 'none';

export interface OrchestrationDetails {
  readonly publicApi: string | null;
  readonly documented: boolean;
  readonly mode: OrchestrationMode;
  readonly measured: boolean;
}

export interface HistoryDetails {
  readonly source: string | null;
  readonly formatVersion: string | null;
  readonly sampleAuthorized: boolean;
  readonly parsedRecords: number;
  readonly privacy: string;
}

export interface OutputInterceptionDetails {
  readonly publicApi: string | null;
  readonly hooksAreToolLevel: boolean;
  readonly configured: boolean;
  readonly measured: boolean;
}

interface LayerReportBase {
  readonly verdict: ClientVerdict;
  readonly evidence: ClientEvidence;
  /** Measurement/discovery time (ISO 8601). */
  readonly at: string;
  /** Client version or config format version; explicit null when unknown. */
  readonly version: string | null;
  /** Probe source or file path. */
  readonly source: string;
  readonly limitations: readonly string[];
  readonly errors: readonly IsolatedError[];
}

export interface DetectedLayerReport extends LayerReportBase {
  readonly layer: 'detected';
  readonly code: 'E1';
  readonly details: DetectedDetails;
}

export interface ConfiguredLayerReport extends LayerReportBase {
  readonly layer: 'configured';
  readonly code: 'E2';
  readonly details: ConfiguredDetails;
}

export interface McpLayerReport extends LayerReportBase {
  readonly layer: 'mcp';
  readonly code: 'E3';
  readonly details: McpDetails;
}

export interface ToolsLayerReport extends LayerReportBase {
  readonly layer: 'tools';
  readonly code: 'E4';
  readonly details: ToolsDetails;
}

export interface BriefLayerReport extends LayerReportBase {
  readonly layer: 'brief';
  readonly code: 'E5';
  readonly details: BriefDetails;
}

export interface InstructionsLayerReport extends LayerReportBase {
  readonly layer: 'instructions';
  readonly code: 'E6';
  readonly details: InstructionsDetails;
}

export interface OrchestrationLayerReport extends LayerReportBase {
  readonly layer: 'orchestration';
  readonly code: 'E7';
  readonly details: OrchestrationDetails;
}

export interface HistoryLayerReport extends LayerReportBase {
  readonly layer: 'history';
  readonly code: 'E8';
  readonly details: HistoryDetails;
}

export interface OutputInterceptionLayerReport extends LayerReportBase {
  readonly layer: 'output-interception';
  readonly code: 'E9';
  readonly details: OutputInterceptionDetails;
}

export type LayerReport =
  | DetectedLayerReport
  | ConfiguredLayerReport
  | McpLayerReport
  | ToolsLayerReport
  | BriefLayerReport
  | InstructionsLayerReport
  | OrchestrationLayerReport
  | HistoryLayerReport
  | OutputInterceptionLayerReport;

export interface LayerReports {
  readonly detected: DetectedLayerReport;
  readonly configured: ConfiguredLayerReport;
  readonly mcp: McpLayerReport;
  readonly tools: ToolsLayerReport;
  readonly brief: BriefLayerReport;
  readonly instructions: InstructionsLayerReport;
  readonly orchestration: OrchestrationLayerReport;
  readonly history: HistoryLayerReport;
  readonly 'output-interception': OutputInterceptionLayerReport;
}

/** Mutable assembly form used while a report is being built. */
export type MutableLayerReports = { -readonly [K in keyof LayerReports]: LayerReports[K] };

export interface ClientReport {
  readonly schema: typeof CLIENT_REPORT_SCHEMA;
  readonly clientId: ClientId;
  readonly alias: string | null;
  readonly status: ClientStatus;
  readonly coreVerdict: ClientVerdict;
  readonly layers: LayerReports;
  readonly generatedAt: string;
  readonly limitations: readonly string[];
  readonly errors: readonly IsolatedError[];
}

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

export interface ConfigTarget {
  readonly scope: ConfigScope;
  /** Optional explicit path override; omitted means adapter-declared target. */
  readonly path?: string;
  readonly format?: ConfigFormat;
  readonly key?: string;
}

export interface ClientAuthorizationRef {
  readonly authorizationId: string;
  readonly root: string;
  readonly clientId: ClientId;
  readonly scope: readonly string[];
  readonly grantedBy: string;
  readonly grantedAt: string;
  readonly revokedAt: string | null;
}

export interface ConfigInput {
  readonly target: ConfigTarget;
  readonly mode: 'dry-run' | 'apply';
  readonly authorization?: ClientAuthorizationRef;
  readonly backup?: boolean;
  readonly root?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface ProposedChange {
  readonly path: string;
  readonly scope: ConfigScope;
  readonly key: string;
  readonly operation: 'add' | 'update' | 'remove' | 'none';
  readonly before: unknown;
  readonly after: unknown;
}

export interface BackupPlan {
  readonly backupId: string;
  readonly path: string;
  readonly hashAlgorithm: 'sha256';
}

export type ConfigResult =
  | {
      readonly mode: 'dry-run';
      readonly changes: readonly ProposedChange[];
      readonly backupPlan: BackupPlan | null;
      readonly warnings: readonly string[];
    }
  | {
      readonly mode: 'apply';
      readonly backupId: string;
      readonly backupHash: string;
      readonly beforeHash: string;
      readonly afterHash: string;
      readonly changes: readonly ProposedChange[];
      readonly restoredOnFailure: boolean;
    };

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

export interface McpInitializeResult {
  readonly protocolVersion: string | null;
  readonly serverInfo: unknown;
  readonly capabilities?: unknown;
}

export interface McpToolDescriptor {
  readonly name: string;
  readonly inputSchema?: unknown;
}

export interface McpToolsResult {
  readonly tools: readonly McpToolDescriptor[];
}

export interface McpCallRequest {
  readonly name: string;
  readonly arguments?: Record<string, unknown>;
}

export interface McpCallResult {
  readonly isError?: boolean;
  readonly content?: readonly unknown[];
  readonly payload?: unknown;
}

/** Test-only injection seam; production always spawns a real stdio child. */
export interface McpClientLike {
  initialize(): Promise<McpInitializeResult>;
  listTools(): Promise<McpToolsResult>;
  callTool(request: McpCallRequest): Promise<McpCallResult>;
  close(): Promise<void>;
}

export interface VerifyInput {
  readonly root?: string;
  readonly transport: 'stdio';
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Record<string, string>;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Testing seam only; when present no process is spawned. */
  readonly inject?: McpClientLike;
}

export interface McpHandshakeEvidence {
  readonly transport: 'stdio';
  readonly protocolVersion: string | null;
  readonly serverInfo: unknown;
  readonly latencyMs: number | null;
  readonly startedAt: string | null;
}

export interface ToolsEvidence {
  readonly count: number;
  readonly names: readonly string[];
  readonly missing: readonly string[];
  readonly extra: readonly string[];
}

export interface BriefEvidence {
  readonly schema: unknown;
  readonly hasProjectContext: boolean;
  readonly takeoverProjection: boolean;
  readonly hostCapability: ClientVerdict | null;
}

export interface VerifyResult {
  readonly handshake: McpHandshakeEvidence | null;
  readonly tools: ToolsEvidence | null;
  readonly brief: BriefEvidence | null;
  /** All nine layers; verify only measures mcp/tools/brief. */
  readonly verdicts: Readonly<Record<CapabilityLayer, ClientVerdict>>;
  readonly errors: readonly IsolatedError[];
}

// ---------------------------------------------------------------------------
// Adapter contract
// ---------------------------------------------------------------------------

export interface ClientAdapter {
  readonly id: ClientId;
  /** Read-only identity sources; implementations must not use undeclared ones. */
  readonly identitySources: readonly IdentitySource[];
  detect(input: DetectInput): Promise<DetectResult>;
  inspect(input: InspectInput): Promise<ClientReport>;
  config(input: ConfigInput): Promise<ConfigResult>;
  verify(input: VerifyInput): Promise<VerifyResult>;
}
