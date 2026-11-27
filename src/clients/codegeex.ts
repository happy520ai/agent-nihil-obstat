/**
 * CodeGeeX adapter (T-096 / CX-06, ADR-008 §3 #16).
 *
 * Product reality (E0/E1, verified 2026-11-23):
 * - CodeGeeX is an IDE-plugin product line (VS Code / JetBrains) plus a cloud
 *   playground and a local model-inference stack. The official repository
 *   (https://github.com/zai-org/CodeGeeX) and the VS Code extension repository
 *   (https://github.com/CodeGeeX/codegeex-vscode-extension) document code
 *   completion / translation / prompt assistance and contain no MCP server
 *   interface or local configuration file.
 * - Therefore no public local MCP interface is declared. This adapter declares
 *   no identity source and no config candidate: it refuses to guess a plugin
 *   directory, refuses to generate an invalid MCP config, and degrades to an
 *   explicit IDE-plugin/cloud workflow.
 * - Chinese product/enterprise promotion is E0: it proves product identity and
 *   positioning only, never an interface.
 *
 * Hard boundaries: no configuration content is executed, no file is written,
 * no undeclared path is probed, and no layer is upgraded to `validated`.
 */

import {
  CLIENT_REPORT_SCHEMA,
  CORE_LAYERS,
  weakestVerdict,
  type ClientAdapter,
  type ClientId,
  type ClientReport,
  type ClientStatus,
  type ConfigInput,
  type ConfigResult,
  type DetectInput,
  type DetectResult,
  type InspectInput,
  type IsolatedError,
  type MutableLayerReports,
  type VerifyInput,
  type VerifyResult,
} from './types.ts';
import { unavailableLayerReports, verifyStdioMcp } from './doctor.ts';

export const CODEGEEX_CLIENT_ID: ClientId = 'codegeex';

/**
 * No public local MCP interface is documented. The adapter declares no
 * executable, no config path and no rule path; `detect` never guesses one.
 */
export const CODEGEEX_IDENTITY_SOURCES = [] as const;

export const CODEGEEX_CONFIG_CANDIDATES = [] as const;

export const CODEGEEX_RULE_PATHS = [] as const;

export const CODEGEEX_OFFICIAL_SOURCES: readonly string[] = Object.freeze([
  'https://codegeex.cn/',
  'https://github.com/zai-org/CodeGeeX',
  'https://github.com/CodeGeeX/codegeex-vscode-extension',
]);

/** Reported limitation prefixes; tests and docs rely on these exact labels. */
export const CODEGEEX_PUBLIC_ASSUMPTION_PREFIX = 'public-assumption:';
export const CODEGEEX_CONFIG_REFUSED_PREFIX = 'config-refused:';

function dedupe(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function isolated(layer: IsolatedError['layer'], code: string, message: string, at: string, source: string | null): IsolatedError {
  return { layer, code, message, at, source };
}

const DEGRADATION_LIMITATIONS: readonly string[] = Object.freeze([
  'CodeGeeX is an IDE-plugin product (VS Code/JetBrains) plus cloud/local inference; no public local MCP interface is documented (E1: official repositories, 2026-11-23)',
  'CodeGeeX 的模型/云端能力不是宿主接管能力；不把模型能力误当宿主能力',
  'configured/mcp/tools/brief stay unavailable: refusing to generate an invalid MCP config for a host without a public local interface',
  'Chinese product/enterprise promotion is E0 identity evidence only and does not prove any interface',
  'degraded path: explicit IDE-plugin / cloud workflow; local takeover is not claimed',
]);

/**
 * CodeGeeX adapter. `detect` never guesses a plugin directory; `inspect`
 * reports the explicit IDE-plugin-only degradation; `config` refuses to invent
 * an MCP target; `verify` never fabricates a handshake.
 */
export function createCodegeexAdapter(options: { readonly now?: () => string } = {}): ClientAdapter {
  const now = options.now ?? (() => new Date().toISOString());

  const adapter: ClientAdapter = {
    id: CODEGEEX_CLIENT_ID,
    identitySources: CODEGEEX_IDENTITY_SOURCES,

    async detect(_input: DetectInput): Promise<DetectResult> {
      const at = now();
      return {
        clientId: CODEGEEX_CLIENT_ID,
        detected: false,
        executablePath: null,
        version: null,
        sources: [],
        errors: [
          isolated(
            'detected',
            'E1_NO_PUBLIC_LOCAL_INTERFACE',
            'CodeGeeX is IDE-plugin-only with no declared public local interface; no plugin directory or config path was guessed',
            at,
            null,
          ),
        ],
      };
    },

    async inspect(_input: InspectInput): Promise<ClientReport> {
      const at = now();
      const base = unavailableLayerReports(at, `client:${CODEGEEX_CLIENT_ID}`);
      const layers: MutableLayerReports = {
        detected: {
          ...base.detected,
          limitations: ['no declared CodeGeeX identity source; IDE-plugin-only product, no public local interface enumerated'],
        },
        configured: {
          ...base.configured,
          limitations: ['no public local MCP interface documented; no invalid MCP config is generated'],
        },
        mcp: {
          ...base.mcp,
          limitations: ['no public local MCP interface documented; mcp layer stays unavailable'],
        },
        tools: {
          ...base.tools,
          limitations: ['no public local MCP interface documented; tools/list is not reachable'],
        },
        brief: {
          ...base.brief,
          limitations: ['no public local MCP interface documented; brief is not callable'],
        },
        instructions: {
          ...base.instructions,
          limitations: ['no public CodeGeeX rule/instruction path documented; plugin settings are not probed'],
        },
        orchestration: {
          ...base.orchestration,
          limitations: ['no public dispatch interface; explicit IDE-plugin/cloud workflow only'],
        },
        history: base.history,
        'output-interception': base['output-interception'],
      };
      const coreVerdict = weakestVerdict(CORE_LAYERS.map((layer) => layers[layer].verdict));
      const status: ClientStatus = 'unavailable';
      return {
        schema: CLIENT_REPORT_SCHEMA,
        clientId: CODEGEEX_CLIENT_ID,
        alias: null,
        status,
        coreVerdict,
        layers,
        generatedAt: at,
        limitations: dedupe([
          ...DEGRADATION_LIMITATIONS,
          'synthetic or injected stdio servers would prove mechanism only, never real CodeGeeX compatibility',
        ]),
        errors: [
          isolated(
            'client',
            'E_IDENTITY_NO_PUBLIC_INTERFACE',
            'CodeGeeX has no declared public local interface; all capability layers stay unavailable',
            at,
            `client:${CODEGEEX_CLIENT_ID}`,
          ),
        ],
      };
    },

    async config(_input: ConfigInput): Promise<ConfigResult> {
      return {
        mode: 'dry-run',
        changes: [],
        backupPlan: null,
        warnings: [
          `${CODEGEEX_CONFIG_REFUSED_PREFIX} no public local MCP interface; refusing to generate an invalid MCP config or guess a path`,
        ],
      };
    },

    async verify(input: VerifyInput): Promise<VerifyResult> {
      return verifyStdioMcp(input);
    },
  };

  return adapter;
}

export const codegeexAdapter: ClientAdapter = createCodegeexAdapter();
