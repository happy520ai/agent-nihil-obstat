/**
 * Unknown-client degradation and the declarative external adapter entry point
 * (T-084 / MC-06, DSH semantic change T-097 / ADR-008 §8).
 *
 * Pi still has no verifiable identity or public interface, so its adapter is a
 * fixed `unknown` degradation: every capability layer stays `unavailable`, the
 * client status is `unknown`, no path is guessed, no adapter is fabricated and
 * `validated` is never reachable. A lying injected adapter cannot change that.
 *
 * DSH is no longer part of that set. `dsh` is an alias of the real product
 * `deepseek-harness` (identity `declared`, ADR-008 §8), so the permanent ban is
 * removed and the alias is served by `src/clients/deepseek-harness.ts`. The
 * `dshAdapter` export below is only a backward-compatible re-export so existing
 * wiring keeps compiling; it is no longer an unknown degradation.
 *
 * Third-party adapters may be registered through `registerExternalAdapter`.
 * Registration is strict and never trusts a declaration by default: the four
 * adapter implementations, a capability declaration and a verification
 * evidence source are all required. Even a registered adapter stays subject to
 * the ADR-007 verdict rules: self-reported `validated`/`measured` is capped
 * unless trusted measured evidence is supplied, and configuration content is
 * never executed.
 */

import {
  CAPABILITY_LAYERS,
  CLIENT_REPORT_SCHEMA,
  CORE_LAYERS,
  IDENTITY_SOURCE_KINDS,
  isCapabilityLayer,
  type CapabilityLayer,
  type ClientAdapter,
  type ClientId,
  type ClientReport,
  type ClientStatus,
  type ClientVerdict,
  type ConfigInput,
  type ConfigResult,
  type DetectInput,
  type DetectResult,
  type IdentitySource,
  type InspectInput,
  type IsolatedError,
  type LayerReport,
  type LayerReports,
  type MutableLayerReports,
  type VerifyInput,
  type VerifyResult,
  weakestVerdict,
} from './types.ts';
import { isClientId } from './registry.ts';
import { unavailableLayerReports } from './doctor.ts';
import { createDeepSeekHarnessAdapter } from './deepseek-harness.ts';

// ---------------------------------------------------------------------------
// Pi unknown degradation (DSH removed: ADR-008 §8)
// ---------------------------------------------------------------------------

export const UNKNOWN_CLIENT_IDS = ['pi'] as const;
export type UnknownClientId = (typeof UNKNOWN_CLIENT_IDS)[number];

export const UNKNOWN_CLIENT_STATUS = 'unknown' as const;
export const UNKNOWN_VERDICT_CEILING = 'degraded' as const;

export function isUnknownClientId(value: string): value is UnknownClientId {
  return (UNKNOWN_CLIENT_IDS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function dedupe(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

/** Type-safe layer replacement: avoids assigning through a union key. */
function mapLayerReports(
  layers: LayerReports | MutableLayerReports,
  transform: (entry: LayerReport, layer: CapabilityLayer) => LayerReport,
): MutableLayerReports {
  const next: Record<string, LayerReport> = { ...layers };
  for (const layer of CAPABILITY_LAYERS) {
    next[layer] = transform(next[layer] as LayerReport, layer);
  }
  return next as MutableLayerReports;
}

function unavailableVerdicts(): Record<CapabilityLayer, ClientVerdict> {
  const verdicts = {} as Record<CapabilityLayer, ClientVerdict>;
  for (const layer of CAPABILITY_LAYERS) verdicts[layer] = 'unavailable';
  return verdicts;
}

function isolated(layer: IsolatedError['layer'], code: string, message: string, at: string, source: string | null): IsolatedError {
  return { layer, code, message, at, source };
}

/** Fixed unknown report: all nine layers unavailable, status unknown. */
export function buildUnknownClientReport(id: UnknownClientId, at: string): ClientReport {
  const layers = mapLayerReports(unavailableLayerReports(at, `client:${id}`), (entry, layer) => ({
    ...entry,
    limitations: [`identity or interface unclear: ${layer} not probed`],
  }));
  return {
    schema: CLIENT_REPORT_SCHEMA,
    clientId: id,
    alias: null,
    status: UNKNOWN_CLIENT_STATUS,
    coreVerdict: 'unavailable',
    layers,
    generatedAt: at,
    limitations: [
      'identity or interface unclear: probe declared public sources only',
      'all capability layers stay unavailable and can never be validated',
      'missing to upgrade: explicit identity source, public config format, public dispatch/history interface',
    ],
    errors: [],
  };
}

/**
 * Force a report into the unknown degradation. Used as a guard so a lying
 * injected adapter can never smuggle a `validated` layer into an unknown
 * client's report. Only clients that are still unknown (`pi`) are forced;
 * `deepseek-harness`/`dsh` are evidence-driven since ADR-008 §8 and are left
 * untouched.
 */
export function enforceUnknownReport(report: ClientReport, at: string = report.generatedAt): ClientReport {
  if (!isUnknownClientId(report.clientId)) return report;
  const layers = mapLayerReports(unavailableLayerReports(at, `client:${report.clientId}`), (entry, layer) => ({
    ...entry,
    limitations: [`identity or interface unclear: ${layer} forced unavailable`],
  }));
  return {
    ...report,
    status: UNKNOWN_CLIENT_STATUS,
    coreVerdict: 'unavailable',
    layers,
    generatedAt: at,
    limitations: dedupe([
      ...report.limitations,
      'identity or interface unclear: probe declared public sources only',
      'all capability layers stay unavailable and can never be validated',
    ]),
  };
}

export interface UnknownAdapterOptions {
  readonly now?: () => string;
}

/**
 * Fixed unknown adapter for clients that are still unknown (`pi`). `detect`
 * never probes an undeclared path, `inspect` always reports the unknown
 * degradation, `config` never applies, and `verify` never fabricates a
 * handshake. DSH is not accepted here (ADR-008 §8).
 */
export function createUnknownAdapter(id: UnknownClientId, options: UnknownAdapterOptions = {}): ClientAdapter {
  if (!isUnknownClientId(id)) {
    throw new Error(`not an unknown client id: ${id}`);
  }
  const now = options.now ?? (() => new Date().toISOString());
  const at = now();

  return {
    id,
    identitySources: [],
    async detect(_input: DetectInput): Promise<DetectResult> {
      return {
        clientId: id,
        detected: false,
        executablePath: null,
        version: null,
        sources: [],
        errors: [
          isolated('client', 'E_IDENTITY_UNKNOWN', 'identity or interface unclear; no source was probed', now(), `client:${id}`),
        ],
      };
    },
    async inspect(_input: InspectInput): Promise<ClientReport> {
      return buildUnknownClientReport(id, now());
    },
    async config(_input: ConfigInput): Promise<ConfigResult> {
      return {
        mode: 'dry-run',
        changes: [],
        backupPlan: null,
        warnings: ['config refused: client identity unknown; no path is guessed'],
      };
    },
    async verify(_input: VerifyInput): Promise<VerifyResult> {
      return {
        handshake: null,
        tools: null,
        brief: null,
        verdicts: unavailableVerdicts(),
        errors: [
          isolated('mcp', 'E_IDENTITY_UNKNOWN', 'identity or interface unclear; refusing to fabricate a handshake', now(), `client:${id}`),
        ],
      };
    },
  };
}

/**
 * Backward-compatible export. `dsh` is an alias of `deepseek-harness` and is no
 * longer an unknown client (ADR-008 §8), so this is the real DeepSeek Harness
 * adapter; it only keeps existing wiring (`src/index.ts`, `src/surface`) and
 * integration tests compiling. `pi` keeps the unknown degradation.
 */
export const dshAdapter: ClientAdapter = createDeepSeekHarnessAdapter();
export const piAdapter: ClientAdapter = createUnknownAdapter('pi');

// ---------------------------------------------------------------------------
// Declarative external adapter extension entry
// ---------------------------------------------------------------------------

export interface ExternalCapabilityDeclaration {
  /** Capability layers the extension claims to implement. */
  readonly layers: readonly CapabilityLayer[];
  readonly notes?: readonly string[];
}

export interface ExternalEvidenceDeclaration {
  /** Where the verification evidence comes from (public doc URL, local probe). */
  readonly source: string;
  /** Whether a real measurement exists; false is accepted but caps verdicts. */
  readonly measured: boolean;
  /** Required when `measured` is true. */
  readonly measuredAt?: string;
  /** Client or format version; required (may be null) when measured is true. */
  readonly version?: string | null;
  readonly method?: string;
}

export interface ExternalAdapterDeclaration {
  readonly id: string;
  readonly identitySources: readonly IdentitySource[];
  readonly detect: ClientAdapter['detect'];
  readonly inspect: ClientAdapter['inspect'];
  readonly config: ClientAdapter['config'];
  readonly verify: ClientAdapter['verify'];
  readonly capabilities: ExternalCapabilityDeclaration;
  readonly evidence: ExternalEvidenceDeclaration;
}

export interface ExternalAdapterValidation {
  /** Trusted evidence source; must be non-empty. */
  readonly evidenceSource: string;
  /** Trusted measurement flag; only true lets self-reported validated survive. */
  readonly measured: boolean;
  /** Additional caller check; returning false rejects the declaration. */
  readonly check?: (declaration: ExternalAdapterDeclaration) => boolean;
}

export interface ExternalValidationIssue {
  readonly code: string;
  readonly message: string;
}

export interface ExternalValidationResult {
  readonly ok: boolean;
  readonly issues: readonly ExternalValidationIssue[];
}

export class ExternalAdapterRejectedError extends Error {
  readonly issues: readonly ExternalValidationIssue[];

  constructor(issues: readonly ExternalValidationIssue[]) {
    super(`external adapter rejected: ${issues.map((issue) => issue.code).join(', ')}`);
    this.name = 'ExternalAdapterRejectedError';
    this.issues = issues;
  }
}

function isIdentitySource(value: unknown): value is IdentitySource {
  if (!isRecord(value)) return false;
  if (typeof value.kind !== 'string' || !(IDENTITY_SOURCE_KINDS as readonly string[]).includes(value.kind)) return false;
  if (typeof value.value !== 'string' || value.value.length === 0) return false;
  if (value.detail !== undefined && typeof value.detail !== 'string' && value.detail !== null) return false;
  return true;
}

/**
 * Strict declaration validation. Any missing or malformed field is an issue;
 * nothing is defaulted and no field is trusted implicitly.
 */
export function validateExternalAdapter(
  declaration: unknown,
  validation: unknown,
): ExternalValidationResult {
  const issues: ExternalValidationIssue[] = [];
  const add = (code: string, message: string): void => {
    issues.push({ code, message });
  };

  if (!isRecord(declaration)) {
    add('DECLARATION_NOT_OBJECT', 'declaration must be an object');
    return { ok: false, issues };
  }

  const id = declaration.id;
  if (typeof id !== 'string' || id.length === 0) add('ID_MISSING', 'declaration.id must be a non-empty string');
  else if (!isClientId(id)) add('ID_UNKNOWN', `unknown client id: ${id}`);
  else if (isUnknownClientId(id)) add('ID_IDENTITY_UNKNOWN', `client id ${id} has no verified identity; external adapters cannot claim it`);

  if (!Array.isArray(declaration.identitySources) || declaration.identitySources.length === 0) {
    add('IDENTITY_SOURCES_MISSING', 'declaration.identitySources must be a non-empty array; no default sources are assumed');
  } else if (!declaration.identitySources.every(isIdentitySource)) {
    add('IDENTITY_SOURCE_INVALID', 'every identity source needs a known kind and a non-empty value');
  }

  for (const name of ['detect', 'inspect', 'config', 'verify'] as const) {
    if (typeof declaration[name] !== 'function') {
      add(`${name.toUpperCase()}_MISSING`, `declaration.${name} must be a function`);
    }
  }

  const capabilities = declaration.capabilities;
  if (!isRecord(capabilities)) {
    add('CAPABILITIES_MISSING', 'declaration.capabilities must be an object with a non-empty layers array');
  } else if (!Array.isArray(capabilities.layers) || capabilities.layers.length === 0) {
    add('CAPABILITY_LAYERS_INVALID', 'declaration.capabilities.layers must be a non-empty array');
  } else if (!capabilities.layers.every((layer) => typeof layer === 'string' && isCapabilityLayer(layer))) {
    add('CAPABILITY_LAYERS_INVALID', 'declaration.capabilities.layers contains an unknown capability layer');
  }

  const evidence = declaration.evidence;
  if (!isRecord(evidence)) {
    add('EVIDENCE_MISSING', 'declaration.evidence must be an object with a source and measured flag');
  } else {
    if (typeof evidence.source !== 'string' || evidence.source.length === 0) {
      add('EVIDENCE_SOURCE_MISSING', 'declaration.evidence.source must be a non-empty string');
    }
    if (typeof evidence.measured !== 'boolean') {
      add('EVIDENCE_MEASURED_INVALID', 'declaration.evidence.measured must be a boolean');
    } else if (evidence.measured) {
      if (typeof evidence.measuredAt !== 'string' || evidence.measuredAt.length === 0) {
        add('EVIDENCE_MEASURED_AT_MISSING', 'measured evidence requires a non-empty measuredAt timestamp');
      }
      if (!Object.prototype.hasOwnProperty.call(evidence, 'version')) {
        add('EVIDENCE_VERSION_MISSING', 'measured evidence requires an explicit version (string or null)');
      }
    }
  }

  if (!isRecord(validation)) {
    add('VALIDATION_MISSING', 'validation must be an object with evidenceSource and measured');
  } else {
    if (typeof validation.evidenceSource !== 'string' || validation.evidenceSource.length === 0) {
      add('VALIDATION_SOURCE_MISSING', 'validation.evidenceSource must be a non-empty string');
    }
    if (typeof validation.measured !== 'boolean') {
      add('VALIDATION_MEASURED_INVALID', 'validation.measured must be a boolean');
    }
    if (validation.check !== undefined && typeof validation.check !== 'function') {
      add('VALIDATION_CHECK_INVALID', 'validation.check must be a function when present');
    }
  }

  if (issues.length === 0 && isRecord(validation) && typeof validation.check === 'function') {
    try {
      if (!validation.check(declaration as unknown as ExternalAdapterDeclaration)) {
        add('VALIDATION_CHECK_FAILED', 'validation.check returned false');
      }
    } catch (error) {
      add('VALIDATION_CHECK_FAILED', `validation.check threw: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { ok: issues.length === 0, issues };
}

function capExternalReport(report: ClientReport, trusted: boolean, sourceNote: string): ClientReport {
  if (trusted) {
    return { ...report, limitations: dedupe([...report.limitations, sourceNote]) };
  }
  const layers = mapLayerReports(report.layers, (entry) => {
    if (entry.verdict !== 'validated' && entry.evidence !== 'measured') return entry;
    return {
      ...entry,
      verdict: entry.verdict === 'validated' ? 'degraded' : entry.verdict,
      evidence: entry.evidence === 'measured' ? 'assumed' : entry.evidence,
      limitations: [
        ...entry.limitations,
        'external adapter self-reported measured/validated without trusted measured evidence; capped',
      ],
    };
  });
  const capped = CAPABILITY_LAYERS.some(
    (layer) => report.layers[layer].verdict === 'validated' || report.layers[layer].evidence === 'measured',
  );
  const coreVerdict = weakestVerdict(CORE_LAYERS.map((layer) => layers[layer].verdict));
  const detected = layers.detected.verdict !== 'unavailable';
  let status: ClientStatus;
  if (!detected) status = 'unavailable';
  else if (coreVerdict === 'validated' && report.errors.length === 0) status = 'ready';
  else status = 'degraded';
  return {
    ...report,
    status,
    coreVerdict,
    layers,
    limitations: dedupe([
      ...report.limitations,
      sourceNote,
      'external adapter verdicts capped: no trusted measured evidence',
    ]),
    errors: capped
      ? [
          ...report.errors,
          isolated('client', 'E_EXTERNAL_VERDICT_CAPPED', 'self-reported validated/measured verdicts were capped', report.generatedAt, null),
        ]
      : report.errors,
  };
}

function capExternalVerify(verify: VerifyResult, trusted: boolean): VerifyResult {
  if (trusted) return verify;
  const verdicts = { ...verify.verdicts };
  let capped = false;
  for (const layer of CAPABILITY_LAYERS) {
    if (verdicts[layer] === 'validated') {
      verdicts[layer] = 'degraded';
      capped = true;
    }
  }
  return {
    ...verify,
    verdicts,
    errors: capped
      ? [
          ...verify.errors,
          isolated('mcp', 'E_EXTERNAL_VERDICT_CAPPED', 'self-reported validated verdicts were capped', new Date().toISOString(), null),
        ]
      : verify.errors,
  };
}

/**
 * Register a third-party adapter after strict validation. The returned adapter
 * delegates detection to the declaration but caps any self-reported
 * `validated`/`measured` verdict unless trusted measured evidence is present,
 * and refuses `apply` configuration. Configuration content is never executed.
 */
export function registerExternalAdapter(
  declaration: ExternalAdapterDeclaration,
  validation: ExternalAdapterValidation,
): ClientAdapter {
  const result = validateExternalAdapter(declaration, validation);
  if (!result.ok) throw new ExternalAdapterRejectedError(result.issues);

  const trusted =
    declaration.evidence.measured === true &&
    validation.measured === true &&
    typeof declaration.evidence.measuredAt === 'string' &&
    declaration.evidence.measuredAt.length > 0;
  const sourceNote = `external evidence source: ${declaration.evidence.source}; trusted validation source: ${validation.evidenceSource}`;

  return {
    id: declaration.id as ClientId,
    identitySources: declaration.identitySources,
    detect: (input) => declaration.detect(input),
    inspect: async (input) => capExternalReport(await declaration.inspect(input), trusted, sourceNote),
    config: async (input) => {
      const outcome = await declaration.config(input);
      if (outcome.mode === 'apply') {
        return {
          mode: 'dry-run',
          changes: [],
          backupPlan: null,
          warnings: ['config-refused: external adapters cannot write client configuration; use the owning config service'],
        };
      }
      return outcome;
    },
    verify: async (input) => capExternalVerify(await declaration.verify(input), trusted),
  };
}
