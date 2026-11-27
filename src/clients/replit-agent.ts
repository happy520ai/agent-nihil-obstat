/**
 * Replit Agent client adapter (ADR-008 §3/§5, M12/T-094).
 *
 * Replit Agent is a cloud-only service. The official documentation
 * (`https://docs.replit.com/replitai/agent`, fetched 2026-11-23) describes a
 * Web/Project-Editor chat workflow and does not publish a local MCP server
 * configuration, a local CLI, or a public HTTP API for the agent.
 *
 * Therefore this adapter:
 * - declares no local identity source and never guesses one;
 * - never generates a local MCP/config file (doing so would be an invalid
 *   config for a cloud-only product);
 * - keeps configured/mcp/tools/brief/instructions/history/output-interception
 *   unavailable and never reports a cloud capability as validated local control;
 * - offers an explicit Web workflow fallback in `orchestration`
 *   (`mode:'explicit-workflow'`).
 *
 * `verify` still delegates to the shared injectable stdio verifier so the
 * mechanism can be tested synthetically; a synthetic pass is never a Replit
 * compatibility claim.
 */

import { resolve } from 'node:path';
import {
  CLIENT_REPORT_SCHEMA,
  CORE_LAYERS,
  EXTENSION_LAYERS,
  MCP_TOOL_NAMES,
  weakestVerdict,
  type BriefLayerReport,
  type ClientAdapter,
  type ClientReport,
  type ClientVerdict,
  type ConfigInput,
  type ConfigResult,
  type DetectInput,
  type DetectResult,
  type HistoryLayerReport,
  type InspectInput,
  type InstructionsLayerReport,
  type MutableLayerReports,
  type OrchestrationLayerReport,
  type OutputInterceptionLayerReport,
  type VerifyInput,
  type VerifyResult,
} from './types.ts';
import { verifyStdioMcp } from './doctor.ts';

// ---------------------------------------------------------------------------
// Declared identity and configuration metadata
// ---------------------------------------------------------------------------

/** No local identity source is publicly documented for Replit Agent. */
export const REPLIT_AGENT_IDENTITY_SOURCES = [] as const;

export const REPLIT_AGENT_CLOUD_ONLY_NOTE =
  'Replit Agent is cloud-only: no local MCP server configuration, local CLI, or public agent HTTP API is publicly documented';

export const REPLIT_AGENT_WORKFLOW_NOTE =
  'explicit workflow only: drive the Replit Web agent manually; this adapter does not claim local or automated takeover';

// ---------------------------------------------------------------------------
// detect
// ---------------------------------------------------------------------------

function runDetect(): DetectResult {
  return {
    clientId: 'replit-agent',
    detected: false,
    executablePath: null,
    version: null,
    sources: [],
    errors: [],
  };
}

// ---------------------------------------------------------------------------
// Layer builders
// ---------------------------------------------------------------------------

function buildDetectedLayer(at: string): MutableLayerReports['detected'] {
  return {
    layer: 'detected',
    code: 'E1',
    verdict: 'unavailable',
    evidence: 'absent',
    at,
    version: null,
    source: 'client:replit-agent',
    limitations: [
      REPLIT_AGENT_CLOUD_ONLY_NOTE,
      'no local identity source is declared; a Web/account login is not probed',
    ],
    errors: [],
    details: { detected: false, executablePath: null, version: null, sources: [] },
  };
}

function buildConfiguredLayer(at: string): MutableLayerReports['configured'] {
  return {
    layer: 'configured',
    code: 'E2',
    verdict: 'unavailable',
    evidence: 'absent',
    at,
    version: null,
    source: 'client:replit-agent',
    limitations: [REPLIT_AGENT_CLOUD_ONLY_NOTE, 'no local config file is generated for a cloud-only service'],
    errors: [],
    details: { configPath: null, scope: null, key: null, resolvedEntry: null, exists: false },
  };
}

function unavailableMcpLayer(at: string): MutableLayerReports['mcp'] {
  return {
    layer: 'mcp',
    code: 'E3',
    verdict: 'unavailable',
    evidence: 'absent',
    at,
    version: null,
    source: 'inspect:cloud-only',
    limitations: [REPLIT_AGENT_CLOUD_ONLY_NOTE],
    errors: [],
    details: { transport: 'stdio', protocolVersion: null, serverInfo: null, latencyMs: null, startedAt: null },
  };
}

function unavailableToolsLayer(at: string): MutableLayerReports['tools'] {
  return {
    layer: 'tools',
    code: 'E4',
    verdict: 'unavailable',
    evidence: 'absent',
    at,
    version: null,
    source: 'inspect:cloud-only',
    limitations: [REPLIT_AGENT_CLOUD_ONLY_NOTE],
    errors: [],
    details: { count: 0, names: [], missing: [...MCP_TOOL_NAMES], extra: [] },
  };
}

function unavailableBriefLayer(at: string): BriefLayerReport {
  return {
    layer: 'brief',
    code: 'E5',
    verdict: 'unavailable',
    evidence: 'absent',
    at,
    version: null,
    source: 'inspect:cloud-only',
    limitations: [REPLIT_AGENT_CLOUD_ONLY_NOTE],
    errors: [],
    details: { schema: null, hasProjectContext: false, takeoverProjection: false, hostCapability: null },
  };
}

function buildInstructionsLayer(at: string): InstructionsLayerReport {
  return {
    layer: 'instructions',
    code: 'E6',
    verdict: 'unavailable',
    evidence: 'absent',
    at,
    version: null,
    source: 'client:replit-agent',
    limitations: [REPLIT_AGENT_CLOUD_ONLY_NOTE, 'no local rule/instruction path exists'],
    errors: [],
    details: { rulePaths: [], formatVersion: null, hasManagedSection: false, readOnly: true },
  };
}

function buildOrchestrationLayer(at: string): OrchestrationLayerReport {
  return {
    layer: 'orchestration',
    code: 'E7',
    verdict: 'degraded',
    evidence: 'assumed',
    at,
    version: null,
    source: 'adr-007:explicit-workflow-fallback',
    limitations: [
      REPLIT_AGENT_CLOUD_ONLY_NOTE,
      REPLIT_AGENT_WORKFLOW_NOTE,
      'cloud agent capability is not local control and is never reported as validated local takeover',
    ],
    errors: [],
    details: { publicApi: null, documented: false, mode: 'explicit-workflow', measured: false },
  };
}

function buildHistoryLayer(at: string): HistoryLayerReport {
  return {
    layer: 'history',
    code: 'E8',
    verdict: 'unavailable',
    evidence: 'absent',
    at,
    version: null,
    source: 'adr-007:no-authorized-sample',
    limitations: [
      'requires an authorized sample or a public format; synthetic fixtures do not upgrade this layer',
      'real session content and secrets are never read',
    ],
    errors: [],
    details: { source: null, formatVersion: null, sampleAuthorized: false, parsedRecords: 0, privacy: 'not-read' },
  };
}

function buildOutputInterceptionLayer(at: string): OutputInterceptionLayerReport {
  return {
    layer: 'output-interception',
    code: 'E9',
    verdict: 'unavailable',
    evidence: 'absent',
    at,
    version: null,
    source: 'adr-007:no-public-interface',
    limitations: [
      'no public Replit Agent output-interception interface was verified',
      'tool-level hooks are not output interception',
    ],
    errors: [],
    details: { publicApi: null, hooksAreToolLevel: true, configured: false, measured: false },
  };
}

function buildReport(at: string): ClientReport {
  const layers: MutableLayerReports = {
    detected: buildDetectedLayer(at),
    configured: buildConfiguredLayer(at),
    mcp: unavailableMcpLayer(at),
    tools: unavailableToolsLayer(at),
    brief: unavailableBriefLayer(at),
    instructions: buildInstructionsLayer(at),
    orchestration: buildOrchestrationLayer(at),
    history: buildHistoryLayer(at),
    'output-interception': buildOutputInterceptionLayer(at),
  };
  const coreVerdict = weakestVerdict(CORE_LAYERS.map((layer) => layers[layer].verdict));
  const limitations: string[] = [
    REPLIT_AGENT_CLOUD_ONLY_NOTE,
    REPLIT_AGENT_WORKFLOW_NOTE,
    'inspect is read-only; no local MCP handshake, config write, rule write or takeover is performed',
  ];
  for (const layer of EXTENSION_LAYERS) {
    const report = layers[layer];
    if (report.verdict === 'unavailable') {
      limitations.push(`${layer} unavailable: ${report.limitations[0] ?? 'not measured'}`);
    }
  }
  return {
    schema: CLIENT_REPORT_SCHEMA,
    clientId: 'replit-agent',
    alias: null,
    status: 'unavailable',
    coreVerdict,
    layers,
    generatedAt: at,
    limitations,
    errors: [],
  };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const replitAgentAdapter: ClientAdapter = {
  id: 'replit-agent',
  identitySources: REPLIT_AGENT_IDENTITY_SOURCES,

  async detect(_input: DetectInput): Promise<DetectResult> {
    return runDetect();
  },

  async inspect(input: InspectInput): Promise<ClientReport> {
    // Root is resolved only for a stable report source; nothing is read.
    if (input.root !== undefined) resolve(input.root);
    return buildReport(new Date().toISOString());
  },

  async config(input: ConfigInput): Promise<ConfigResult> {
    const warnings: string[] = [
      REPLIT_AGENT_CLOUD_ONLY_NOTE,
      `${REPLIT_AGENT_WORKFLOW_NOTE}; no local configuration was generated`,
    ];
    if (input.mode === 'apply') {
      warnings.push('apply refused (cloud-only service has no local config interface); dry-run only; zero write');
    }
    return { mode: 'dry-run', changes: [], backupPlan: null, warnings };
  },

  async verify(input: VerifyInput): Promise<VerifyResult> {
    return verifyStdioMcp(input);
  },
};
