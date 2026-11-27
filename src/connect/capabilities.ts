import { ConnectError } from './errors.ts';
import type { TakeoverScope, TakeoverState } from './takeover-policy.ts';
import { TAKEOVER_HOST_CAPABILITY_REASONS } from './takeover.ts';
import { CONNECT_ROLE_MATRIX_SCHEMA } from './types.ts';
import type {
  ConnectCapabilityLayer,
  ConnectLayerRoleEntry,
  ConnectLegacyWriteDecision,
  ConnectRoleMatrix,
} from './types.ts';

export const CONNECT_CAPABILITIES = ['read', 'recall', 'export'] as const;

/**
 * ADR-006 §8: the host capabilities that are known to be missing. They are
 * re-exported here so capability consumers can declare the degradation layer
 * without importing the takeover orchestration module directly.
 */
export const CONNECT_HOST_DEGRADATION_REASONS: readonly string[] = TAKEOVER_HOST_CAPABILITY_REASONS;

const LAYER_ORDER: readonly ConnectCapabilityLayer[] = ['tasks', 'memory', 'acceptance', 'dag', 'release'];

function assertLayerOrder(entries: readonly ConnectLayerRoleEntry[]): void {
  if (entries.map((entry) => entry.layer).join(',') !== LAYER_ORDER.join(',')) {
    throw new ConnectError('role matrix layers must match the ADR-006 §5 layer order');
  }
}

/**
 * ADR-006 §5 role matrix, fixed per policy state. The matrices are the single
 * source of truth for capability declarations and for the legacy-write guard.
 */
const ROLE_MATRICES: Readonly<Record<TakeoverState, readonly ConnectLayerRoleEntry[]>> = {
  disabled: [
    {
      layer: 'tasks',
      ano: 'read-only',
      legacyPm: 'primary-write',
      note: 'Connect imports tasks read-only; PM-mcp remains the primary writer.',
    },
    {
      layer: 'memory',
      ano: 'native',
      legacyPm: 'read-only',
      note: 'ANO memory is available natively; Connect recall stays read-only.',
    },
    {
      layer: 'acceptance',
      ano: 'native',
      legacyPm: 'read-only',
      note: 'ANO acceptance is available natively; legacy claims are never upgraded.',
    },
    {
      layer: 'dag',
      ano: 'read-only',
      legacyPm: 'primary-write',
      note: 'PM-mcp session/plan remains the DAG authority.',
    },
    {
      layer: 'release',
      ano: 'manual',
      legacyPm: 'manual',
      note: 'Release/attest/approve/sync/push stay with a named human.',
    },
  ],
  enforced: [
    {
      layer: 'tasks',
      ano: 'primary-write',
      legacyPm: 'read-only',
      note: 'ANO is the task primary writer; PM-mcp is a read-only role.',
    },
    {
      layer: 'memory',
      ano: 'primary-write',
      legacyPm: 'read-only',
      note: 'ANO owns memory writes; legacy memory stays read-only.',
    },
    {
      layer: 'acceptance',
      ano: 'primary-write',
      legacyPm: 'read-only',
      note: 'ANO owns acceptance writes; source claims are not upgraded.',
    },
    {
      layer: 'dag',
      ano: 'primary-write',
      legacyPm: 'read-only',
      note: 'ANO generalized DAG is the scheduler; PM-mcp stays read-only.',
    },
    {
      layer: 'release',
      ano: 'manual',
      legacyPm: 'manual',
      note: 'Release/attest/approve/sync/push stay with a named human.',
    },
  ],
  recovery: [
    {
      layer: 'tasks',
      ano: 'paused',
      legacyPm: 'primary-write',
      note: 'ANO paused first; PM-mcp is restoring primary-write (no double main write).',
    },
    {
      layer: 'memory',
      ano: 'paused',
      legacyPm: 'read-only',
      note: 'ANO memory writes are paused during recovery.',
    },
    {
      layer: 'acceptance',
      ano: 'paused',
      legacyPm: 'read-only',
      note: 'ANO acceptance writes are paused during recovery.',
    },
    {
      layer: 'dag',
      ano: 'paused',
      legacyPm: 'primary-write',
      note: 'ANO DAG scheduling is paused; PM-mcp planning resumes.',
    },
    {
      layer: 'release',
      ano: 'manual',
      legacyPm: 'manual',
      note: 'Release/attest/approve/sync/push stay with a named human.',
    },
  ],
};

/**
 * Role matrix for a policy state. `hostCapability` is the ADR-006 §8 layer:
 * anything other than `full` is reported as degraded with explicit reasons,
 * never presented as an enforced host surface.
 */
export function roleMatrixForState(
  state: TakeoverState,
  hostCapability: 'full' | 'degraded' | null = null,
): ConnectRoleMatrix {
  const layers = ROLE_MATRICES[state];
  assertLayerOrder(layers);
  const degraded = hostCapability !== 'full';
  return {
    schema: CONNECT_ROLE_MATRIX_SCHEMA,
    state,
    layers: layers.map((entry) => ({ ...entry })),
    hostCapability,
    degraded,
    degradationReasons: degraded ? [...CONNECT_HOST_DEGRADATION_REASONS] : [],
  };
}

/** Thrown by {@link assertLegacyWriteAllowed} when a legacy write would violate the role matrix. */
export class ConnectLegacyWriteBlockedError extends ConnectError {
  override readonly code = 'CONNECT_LEGACY_WRITE_BLOCKED' as const;
  readonly state: TakeoverState;
  readonly scope: TakeoverScope | 'all';
  readonly action: string;

  constructor(state: TakeoverState, scope: TakeoverScope | 'all') {
    super(`legacy PM-mcp write refused while takeover state is ${state}`);
    this.name = 'ConnectLegacyWriteBlockedError';
    this.state = state;
    this.scope = scope;
    this.action = 'route the write through ANO, or explicitly disable/recover the takeover first';
  }
}

/**
 * Non-throwing legacy-write decision (T-072 wiring point). `enforced` refuses
 * every legacy source write; `recovery` and `disabled` allow the old path so a
 * verified exit can restore PM-mcp primary-write.
 */
export function legacyWriteDecision(
  state: TakeoverState,
  scope: TakeoverScope | 'all' = 'all',
): ConnectLegacyWriteDecision {
  if (state === 'enforced') {
    return {
      allowed: false,
      state,
      scope,
      reason: 'takeover is enforced: legacy PM-mcp is read-only and ANO is the primary writer',
      action: 'route the write through ANO, or explicitly disable/recover the takeover first',
    };
  }
  return { allowed: true, state, scope };
}

/** Fail-closed legacy-write gate for ANO-side business writes to the old source. */
export function assertLegacyWriteAllowed(state: TakeoverState, scope: TakeoverScope | 'all' = 'all'): void {
  const decision = legacyWriteDecision(state, scope);
  if (!decision.allowed) throw new ConnectLegacyWriteBlockedError(state, scope);
}
