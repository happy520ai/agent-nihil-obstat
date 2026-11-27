/**
 * Tabnine client adapter (ADR-008 §3/§5/§6, M12/T-093).
 *
 * Tabnine is an IDE plugin + cloud agent product. The T-092 registry declares
 * no executable/config identity source and no config candidate, and ADR-008 §3
 * records no public MCP interface. This adapter therefore:
 * - `detect`: reports `unavailable` (no declared source, no guessed path);
 * - `inspect`: reports nine layers with every interface layer `unavailable`
 *   and only `orchestration` degraded to `explicit-workflow` as a manual
 *   fallback;
 * - `config`: never writes; it always returns a dry-run result with zero
 *   changes, even for `mode:'apply'`;
 * - `verify`: delegates to `doctor.verifyStdioMcp`, which refuses to fabricate
 *   a handshake without a real or injected command.
 *
 * Hard boundary: Tabnine completion/cloud-agent marketing (E0/E1 product docs)
 * is never treated as an ANO MCP/Agent takeover interface, and no `validated`
 * capability is fabricated.
 */

import {
  CLIENT_REPORT_SCHEMA,
  CORE_LAYERS,
  EXTENSION_LAYERS,
  MCP_TOOL_NAMES,
  weakestVerdict,
  type BriefLayerReport,
  type BackupPlan,
  type ClientAdapter,
  type ClientReport,
  type ConfigInput,
  type ConfigResult,
  type DetectInput,
  type DetectResult,
  type HistoryLayerReport,
  type InspectInput,
  type InstructionsLayerReport,
  type IsolatedError,
  type MutableLayerReports,
  type OrchestrationLayerReport,
  type OutputInterceptionLayerReport,
  type VerifyInput,
  type VerifyResult,
} from './types.ts';
import { verifyStdioMcp } from './doctor.ts';

export const TABNINE_SERVER_NAME = 'ano';

/**
 * Read-only identity sources. Matches the T-092 registry descriptor for
 * `tabnine` (empty: no public local source is declared).
 */
export const TABNINE_IDENTITY_SOURCES = [] as const;

function unavailableError(at: string): IsolatedError {
  return {
    layer: 'detected',
    code: 'E1_NO_DECLARED_SOURCE',
    message: 'no declared Tabnine source exists; IDE-plugin + cloud product, paths are not guessed',
    at,
    source: null,
  };
}

function buildReport(at: string, detect: DetectResult): ClientReport {
  const limitations: string[] = [
    'Tabnine is IDE-plugin + cloud only: no public MCP interface is documented (E0/E1 product docs only)',
    'Tabnine completion/cloud-agent capability is not ANO agent takeover and is never reported as such',
    'no local configuration path is declared or guessed',
  ];

  const detected: MutableLayerReports['detected'] = {
    layer: 'detected',
    code: 'E1',
    verdict: 'unavailable',
    evidence: 'absent',
    at,
    version: null,
    source: 'client:tabnine',
    limitations: ['no declared Tabnine source was found; IDE-plugin + cloud product, paths were not guessed'],
    errors: detect.errors,
    details: { detected: false, executablePath: null, version: null, sources: [] },
  };

  const configured: MutableLayerReports['configured'] = {
    layer: 'configured',
    code: 'E2',
    verdict: 'unavailable',
    evidence: 'absent',
    at,
    version: null,
    source: 'adr-008:no-public-config-interface',
    limitations: ['no public MCP configuration interface; configured is not guessed'],
    errors: [],
    details: { configPath: null, scope: null, key: null, resolvedEntry: null, exists: false },
  };

  const mcp: MutableLayerReports['mcp'] = {
    layer: 'mcp',
    code: 'E3',
    verdict: 'unavailable',
    evidence: 'absent',
    at,
    version: null,
    source: 'adr-008:no-public-mcp-interface',
    limitations: ['no public Tabnine MCP interface; refusing to generate an invalid MCP configuration'],
    errors: [],
    details: { transport: 'stdio', protocolVersion: null, serverInfo: null, latencyMs: null, startedAt: null },
  };

  const tools: MutableLayerReports['tools'] = {
    layer: 'tools',
    code: 'E4',
    verdict: 'unavailable',
    evidence: 'absent',
    at,
    version: null,
    source: 'adr-008:no-public-mcp-interface',
    limitations: ['no MCP host interface; tools/list is not applicable'],
    errors: [],
    details: { count: 0, names: [], missing: [...MCP_TOOL_NAMES], extra: [] },
  };

  const brief: BriefLayerReport = {
    layer: 'brief',
    code: 'E5',
    verdict: 'unavailable',
    evidence: 'absent',
    at,
    version: null,
    source: 'adr-008:no-public-mcp-interface',
    limitations: ['no MCP host interface; brief is not applicable'],
    errors: [],
    details: { schema: null, hasProjectContext: false, takeoverProjection: false, hostCapability: null },
  };

  const instructions: InstructionsLayerReport = {
    layer: 'instructions',
    code: 'E6',
    verdict: 'unavailable',
    evidence: 'absent',
    at,
    version: null,
    source: 'adr-008:no-declared-rule-file',
    limitations: ['no public Tabnine rule/instruction file is declared; the path is not guessed'],
    errors: [],
    details: { rulePaths: [], formatVersion: null, hasManagedSection: false, readOnly: true },
  };

  const orchestration: OrchestrationLayerReport = {
    layer: 'orchestration',
    code: 'E7',
    verdict: 'degraded',
    evidence: 'assumed',
    at,
    version: null,
    source: 'adr-008:explicit-workflow-fallback',
    limitations: [
      'no public Tabnine subagent/dispatch interface was verified',
      'Tabnine cloud agent is not a local ANO DAG; explicit manual workflow only',
    ],
    errors: [],
    details: { publicApi: null, documented: false, mode: 'explicit-workflow', measured: false },
  };

  const history: HistoryLayerReport = {
    layer: 'history',
    code: 'E8',
    verdict: 'unavailable',
    evidence: 'absent',
    at,
    version: null,
    source: 'adr-008:no-authorized-sample',
    limitations: [
      'requires an authorized sample or a public format; synthetic fixtures do not upgrade this layer',
      'real session content and secrets are never read',
    ],
    errors: [],
    details: { source: null, formatVersion: null, sampleAuthorized: false, parsedRecords: 0, privacy: 'not-read' },
  };

  const outputInterception: OutputInterceptionLayerReport = {
    layer: 'output-interception',
    code: 'E9',
    verdict: 'unavailable',
    evidence: 'absent',
    at,
    version: null,
    source: 'adr-008:no-public-interface',
    limitations: [
      'no public Tabnine output-interception interface was verified',
      'tool-level hooks are not output interception',
    ],
    errors: [],
    details: { publicApi: null, hooksAreToolLevel: true, configured: false, measured: false },
  };

  const layers: MutableLayerReports = {
    detected,
    configured,
    mcp,
    tools,
    brief,
    instructions,
    orchestration,
    history,
    'output-interception': outputInterception,
  };
  const coreVerdict = weakestVerdict(CORE_LAYERS.map((layer) => layers[layer].verdict));
  for (const layer of EXTENSION_LAYERS) {
    const report = layers[layer];
    if (report.verdict === 'unavailable') {
      limitations.push(`${layer} unavailable: ${report.limitations[0] ?? 'not measured'}`);
    }
  }
  return {
    schema: CLIENT_REPORT_SCHEMA,
    clientId: 'tabnine',
    alias: null,
    status: 'unavailable',
    coreVerdict,
    layers,
    generatedAt: at,
    limitations,
    errors: [...detect.errors],
  };
}

function dryRunZeroWrite(reason: string): ConfigResult {
  const backupPlan: BackupPlan | null = null;
  return {
    mode: 'dry-run',
    changes: [],
    backupPlan,
    warnings: [
      'Tabnine is IDE-plugin + cloud only and has no public MCP configuration interface; refusing to generate an invalid config',
      `${reason}; zero write`,
    ],
  };
}

export const tabnineAdapter: ClientAdapter = {
  id: 'tabnine',
  identitySources: TABNINE_IDENTITY_SOURCES,

  async detect(_input: DetectInput): Promise<DetectResult> {
    const at = new Date().toISOString();
    return {
      clientId: 'tabnine',
      detected: false,
      executablePath: null,
      version: null,
      sources: [],
      errors: [unavailableError(at)],
    };
  },

  async inspect(_input: InspectInput): Promise<ClientReport> {
    const at = new Date().toISOString();
    return buildReport(
      at,
      {
        clientId: 'tabnine',
        detected: false,
        executablePath: null,
        version: null,
        sources: [],
        errors: [unavailableError(at)],
      },
    );
  },

  async config(input: ConfigInput): Promise<ConfigResult> {
    return dryRunZeroWrite(input.mode === 'apply' ? 'apply refused' : 'dry-run only');
  },

  async verify(input: VerifyInput): Promise<VerifyResult> {
    return verifyStdioMcp(input);
  },
};
