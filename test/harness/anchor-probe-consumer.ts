import { Ledger } from '../../src/ledger/ledger.ts';
import { ProbeManifestStore } from '../../src/memory/probe-manifest.ts';
import {
  runConsumer,
  type ConsumerBudgetOverrides,
  type ConsumerEvent,
  type ConsumerModelAdapter,
  type ConsumerModelGenerateInput,
  type ConsumerModelRepairInput,
  type ConsumerProbeAdapter,
  type ConsumerProbeRunInput,
  type ConsumerProbeRunResult,
  type ConsumerRunResult,
  type ConsumerSnapshotSampleInput,
} from '../../src/memory/consumer.ts';
import type { ContextDraftClaim } from '../../src/memory/context-verify.ts';
import type { AnchorProbeSnapshot } from '../../src/memory/probe-contract.ts';
import { memoryProbeSurface } from '../../src/surface/memory.ts';
import { probeManifestToFrozenContext } from '../../src/surface/service.ts';
import { anchorProbeSnapshotSampler } from '../../src/surface/anchor-probe.ts';

/**
 * Local Consumer harness (P3 / AP-17 / T-054).
 *
 * This module wires the library-level `runConsumer` state machine (T-053) to
 * the real host components:
 *   - `createConsumerHarnessProbe` adapts `memoryProbeSurface` (read-only
 *     AnchorProbe over the versioned memory projection) plus the real
 *     `ProbeManifestStore` (freeze + read-back) into the `ConsumerProbeAdapter`
 *     port; `sampleSnapshot` re-samples the ledger commit digest, graph
 *     revision/source fingerprint and authorized Connect digest through the
 *     real `anchorProbeSnapshotSampler`.
 *   - `createTestModel` is a controllable model adapter used to script drafts,
 *     repair drafts, hangs and backend errors without binding a real model API.
 *   - `presentAndSimulate` is the presentation/execution pre-check gate: it
 *     only ever receives `displayable_claims` from an `ALLOWED` run.
 *
 * Boundaries (see docs/anchor-probe-integration.md §14):
 *   - this harness is NOT a host automatic interception mechanism. MCP cannot
 *     stop a client from emitting text after a call returns; nothing here
 *     changes ZCode/MCP configuration, and a prompt asking an agent to call a
 *     tool is not treated as enforcement;
 *   - the output is deliberately not Gate-shaped: no `evidence_id`, `verdict`
 *     or `task_id` is produced, and nothing here triggers done/approve/cutover;
 *   - claim/evidence text is inert untrusted input. `presentAndSimulate` hands
 *     claims to a simulated execution pre-check; it never interprets claim text
 *     as a command.
 *
 * Conventions follow the surrounding code: snake_case, strict objects,
 * explicit null for unknown values.
 */

/** Re-samples the four snapshot digests. Defaults to the real Surface sampler. */
export type ConsumerHarnessSnapshotSampler = (
  root: string,
  projectScope: string,
) => Promise<AnchorProbeSnapshot> | AnchorProbeSnapshot;

const defaultSnapshotSampler: ConsumerHarnessSnapshotSampler = (root, projectScope) =>
  anchorProbeSnapshotSampler.sample(root, projectScope).then((sample) => sample.snapshot);

export interface ConsumerHarnessProbeOptions {
  /** Open ledger bound to the harness root. */
  readonly ledger: Ledger;
  /** Explicit project scope; must match the probe request. */
  readonly projectScope: string;
  /** Deterministic clock shared by the probe, freeze, read and verify. */
  readonly now: string;
  /** Manifest store; defaults to a real store bound to the ledger root. */
  readonly store?: ProbeManifestStore;
  /** Snapshot sampler; defaults to the real Surface sampler. */
  readonly sampler?: ConsumerHarnessSnapshotSampler;
}

export interface ConsumerHarnessProbeAdapter extends ConsumerProbeAdapter {
  readonly root: string;
  readonly store: ProbeManifestStore;
  /** How many full probe runs this adapter performed. */
  readonly runCount: number;
  /** How many snapshot re-samples this adapter performed. */
  readonly sampleCount: number;
}

/**
 * Build a real `ConsumerProbeAdapter`. `run` performs one read-only probe,
 * freezes the response through `ProbeManifestStore`, reads the frozen manifest
 * back and projects it onto the `FrozenContextManifest` shape the consumer
 * validates. `sampleSnapshot` re-samples the four real digests.
 */
export function createConsumerHarnessProbe(options: ConsumerHarnessProbeOptions): ConsumerHarnessProbeAdapter {
  const root = options.ledger.root;
  const store = options.store ?? new ProbeManifestStore({ root });
  const sampler = options.sampler ?? defaultSnapshotSampler;
  let runCount = 0;
  let sampleCount = 0;

  const run = async (input: ConsumerProbeRunInput): Promise<ConsumerProbeRunResult> => {
    runCount += 1;
    const snapshot = await sampler(root, input.request.project_scope);
    const response = memoryProbeSurface(options.ledger, input.request, { snapshot, now: input.now });
    const frozen = store.freeze({ request: input.request, response, now: input.now });
    const read = store.read(frozen.context_id, input.request.project_scope, { now: input.now });
    if (read.status !== 'ok') {
      throw new Error(`harness probe could not read back frozen context ${frozen.context_id}: ${read.status}`);
    }
    return { manifest: probeManifestToFrozenContext(read.manifest), response };
  };

  const sampleSnapshot = async (input: ConsumerSnapshotSampleInput): Promise<AnchorProbeSnapshot> => {
    sampleCount += 1;
    return await sampler(root, input.request.project_scope);
  };

  return {
    run,
    sampleSnapshot,
    get runCount() {
      return runCount;
    },
    get sampleCount() {
      return sampleCount;
    },
    root,
    store,
  };
}

export type TestModelGenerate = (input: ConsumerModelGenerateInput) => unknown | Promise<unknown>;
export type TestModelRepair = (input: ConsumerModelRepairInput) => unknown | Promise<unknown>;

/** Controllable model adapter; every call is recorded verbatim. */
export interface TestModelAdapter extends ConsumerModelAdapter {
  readonly generateCalls: readonly ConsumerModelGenerateInput[];
  readonly repairCalls: readonly ConsumerModelRepairInput[];
}

/**
 * Build a scripted model adapter. The callbacks decide the draft, so a test can
 * return a clean draft, a blocked draft, a repaired draft, garbage, a hanging
 * promise or a thrown backend error. The consumer buffers and validates every
 * returned value; garbage never becomes an exception or a displayed answer.
 */
export function createTestModel(options: {
  readonly generate: TestModelGenerate;
  readonly repair?: TestModelRepair;
}): TestModelAdapter {
  const generateCalls: ConsumerModelGenerateInput[] = [];
  const repairCalls: ConsumerModelRepairInput[] = [];
  const adapter: TestModelAdapter = {
    generate(input: ConsumerModelGenerateInput): unknown {
      generateCalls.push(input);
      return options.generate(input);
    },
    generateCalls,
    repairCalls,
  };
  if (options.repair !== undefined) {
    const repair = options.repair;
    adapter.repair = (input: ConsumerModelRepairInput): unknown => {
      repairCalls.push(input);
      return repair(input);
    };
  }
  return adapter;
}

export interface ConsumerHarnessOptions {
  readonly ledger: Ledger;
  readonly projectScope: string;
  /** Deterministic clock; defaults to the real time. */
  readonly now?: string;
  readonly store?: ProbeManifestStore;
  readonly sampler?: ConsumerHarnessSnapshotSampler;
}

export interface ConsumerHarnessRunOptions {
  /** Raw AP-02 request; validated by the consumer itself. */
  readonly request: unknown;
  readonly model: ConsumerModelAdapter;
  readonly budget?: ConsumerBudgetOverrides;
  readonly observer?: (event: ConsumerEvent) => void;
}

/** The local harness: real probe adapter plus one shared deterministic clock. */
export interface ConsumerHarness {
  readonly probe: ConsumerHarnessProbeAdapter;
  readonly store: ProbeManifestStore;
  readonly root: string;
  readonly now: string;
  run(options: ConsumerHarnessRunOptions): Promise<ConsumerRunResult>;
}

export function createConsumerHarness(options: ConsumerHarnessOptions): ConsumerHarness {
  const now = options.now ?? new Date().toISOString();
  const probe = createConsumerHarnessProbe({
    ledger: options.ledger,
    projectScope: options.projectScope,
    now,
    ...(options.store === undefined ? {} : { store: options.store }),
    ...(options.sampler === undefined ? {} : { sampler: options.sampler }),
  });
  return {
    probe,
    store: probe.store,
    root: probe.root,
    now,
    run: ({ request, model, budget, observer }) => runConsumer({
      request,
      probe,
      model,
      ...(budget === undefined ? {} : { budget }),
      now,
      ...(observer === undefined ? {} : { observer }),
    }),
  };
}

export interface ConsumerPresentationOutcome {
  /** Claims a host may render; empty unless the run outcome is ALLOWED. */
  readonly presented: readonly ContextDraftClaim[];
  /** Claims handed to the execution pre-check; empty unless ALLOWED. */
  readonly executed: readonly ContextDraftClaim[];
  /** Non-null when the gate refused to present anything. */
  readonly refused_reason: string | null;
}

/**
 * Presentation/execution gate. It only ever receives `displayable_claims` from
 * a run whose outcome is `ALLOWED`. Because the v1 verifier never returns
 * ALLOW, a clean draft resolves to NEEDS_REVIEW and this gate presents and
 * executes nothing — an honest result, never a fabricated permission.
 *
 * "Executed" means handed to an execution pre-check; claim text is inert data
 * and is never parsed as a command.
 */
export function presentAndSimulate(result: ConsumerRunResult): ConsumerPresentationOutcome {
  if (result.outcome !== 'ALLOWED') {
    return {
      presented: [],
      executed: [],
      refused_reason: `outcome_${result.outcome.toLowerCase()}`,
    };
  }
  const claims = [...result.displayable_claims];
  return { presented: claims, executed: claims, refused_reason: null };
}
