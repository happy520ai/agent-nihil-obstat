/**
 * T-159 / MNT-03: unified resource accounting and bounded shutdown.
 *
 * The probe stack owns four kinds of local resources: pending requests, open
 * sockets, live child processes and timers. Each owner already exposes its own
 * counters (`resourceWatermarks`); this module only aggregates them so a caller
 * can assert "everything this scope owns returned to zero" after normal work,
 * cancellation, timeouts, crashes and repeated close.
 *
 * Boundaries:
 * - it reports only the sources registered with it; it is not a machine-wide
 *   process/socket inventory;
 * - `close()` runs registered cleanups exactly once and is idempotent;
 * - process signal installation is opt-in, never automatic, and re-raises the
 *   original signal so host termination semantics are preserved;
 * - nothing here changes `DistributedProbeAnswer.resources_released`, which is
 *   a per-answer logical flag and never proves a cluster was shut down.
 */

export interface ResourceSnapshot {
  readonly pendingRequests: number;
  readonly openSockets: number;
  readonly liveChildren: number;
  readonly activeTimers: number;
}

export interface ResourceSource {
  /** Missing fields count as zero; unknown counters are not inferred. */
  resourceWatermarks(): Partial<ResourceSnapshot>;
}

export type ResourceCleanup = () => void | Promise<void>;

export class ResourceRegistryError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`[${code}] ${message}`);
    this.name = 'ResourceRegistryError';
    this.code = code;
  }
}

const EMPTY: ResourceSnapshot = {
  pendingRequests: 0,
  openSockets: 0,
  liveChildren: 0,
  activeTimers: 0,
};

export class ResourceRegistry {
  readonly #sources = new Set<ResourceSource>();
  readonly #cleanups = new Set<ResourceCleanup>();
  #closed = false;

  get closed(): boolean {
    return this.#closed;
  }

  /** Track one resource owner; returns an idempotent unregister function. */
  register(source: ResourceSource): () => void {
    if (this.#closed) {
      throw new ResourceRegistryError('RESOURCE_REGISTRY_CLOSED', 'cannot register a source after close()');
    }
    this.#sources.add(source);
    return () => {
      this.#sources.delete(source);
    };
  }

  /** Register a shutdown action; returns an idempotent unregister function. */
  registerCleanup(cleanup: ResourceCleanup): () => void {
    if (this.#closed) {
      throw new ResourceRegistryError('RESOURCE_REGISTRY_CLOSED', 'cannot register a cleanup after close()');
    }
    this.#cleanups.add(cleanup);
    return () => {
      this.#cleanups.delete(cleanup);
    };
  }

  /** Sum of every registered source; absent counters count as zero. */
  snapshot(): ResourceSnapshot {
    let pendingRequests = 0;
    let openSockets = 0;
    let liveChildren = 0;
    let activeTimers = 0;
    for (const source of this.#sources) {
      const watermarks = source.resourceWatermarks();
      pendingRequests += watermarks.pendingRequests ?? 0;
      openSockets += watermarks.openSockets ?? 0;
      liveChildren += watermarks.liveChildren ?? 0;
      activeTimers += watermarks.activeTimers ?? 0;
    }
    return { pendingRequests, openSockets, liveChildren, activeTimers };
  }

  /**
   * Run every cleanup once (LIFO), then drop the sources. A failing cleanup
   * does not stop the others; failures surface as one AggregateError.
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const cleanups = [...this.#cleanups].reverse();
    this.#cleanups.clear();
    const errors: unknown[] = [];
    for (const cleanup of cleanups) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    this.#sources.clear();
    if (errors.length > 0) {
      throw new AggregateError(errors, 'one or more resource cleanups failed');
    }
  }
}

export interface ProcessCleanupOptions {
  /** Default `['SIGINT','SIGTERM']`; SIGKILL cannot be handled. */
  readonly signals?: readonly NodeJS.Signals[];
}

export const RESOURCE_PROCESS_CLEANUP_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

/**
 * The narrow process surface the installer needs. It exists so the signal
 * choreography is testable without relying on OS signal delivery: Windows
 * forcibly terminates a process on SIGTERM instead of invoking JS handlers.
 */
export interface ProcessCleanupTarget {
  readonly pid: number;
  on(signal: NodeJS.Signals, listener: () => void): unknown;
  removeListener(signal: NodeJS.Signals, listener: () => void): unknown;
  kill(pid: number, signal: NodeJS.Signals): boolean;
}

/**
 * Install cleanup handlers on the supplied process-like target. On the first
 * handled signal: dispose the handlers, run `registry.close()` and re-raise the
 * same signal so the default termination behaviour is preserved.
 */
export function installProcessCleanupOn(
  target: ProcessCleanupTarget,
  registry: ResourceRegistry,
  options: ProcessCleanupOptions = {},
): () => void {
  const signals = options.signals ?? RESOURCE_PROCESS_CLEANUP_SIGNALS;
  const handlers = new Map<NodeJS.Signals, () => void>();
  let installed = true;
  const dispose = (): void => {
    if (!installed) return;
    installed = false;
    for (const [signal, handler] of handlers) target.removeListener(signal, handler);
    handlers.clear();
  };
  for (const signal of signals) {
    const handler = (): void => {
      dispose();
      const reRaise = (): void => {
        target.kill(target.pid, signal);
      };
      // Re-raise whether cleanup succeeded or not: swallowing the signal would
      // turn a failure into a silent hang.
      void registry.close().then(reRaise, reRaise);
    };
    handlers.set(signal, handler);
    target.on(signal, handler);
  }
  return dispose;
}

/** Install the cleanup on the real process (opt-in; never automatic). */
export function installProcessCleanup(
  registry: ResourceRegistry,
  options: ProcessCleanupOptions = {},
): () => void {
  return installProcessCleanupOn(process as unknown as ProcessCleanupTarget, registry, options);
}

/** Adapter for an object that already implements `resourceWatermarks`. */
export function resourceSourceOf(owner: ResourceSource): ResourceSource {
  return {
    resourceWatermarks: () => ({ ...EMPTY, ...owner.resourceWatermarks() }),
  };
}
