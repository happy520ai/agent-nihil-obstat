import { decodeCursor } from './cursor.ts';
import type { HistoryStore } from './store.ts';
import type { MemoryProviderAdapter, ParseResult, SkippedArtifact, IndexUnit } from './types.ts';

/**
 * Provider isolation lives here, not in adapters:
 * - discovery/parse failures are contained to one provider and one unit;
 * - a marker bump clears only that provider;
 * - a failed provider keeps its previous cache rows;
 * - other providers are never reset by this provider's failure.
 *
 * Ordering is deliberate: every unit is parsed first. Only when parsing is
 * completely successful does the store atomically reset (on a marker bump),
 * write, prune and advance the provider marker. A parse failure therefore
 * leaves the previous cache and marker untouched and is reported as degraded.
 */
export interface ProviderIngestReport {
  readonly provider: string;
  readonly status: 'ok' | 'degraded' | 'failed';
  readonly marker: string;
  readonly markerChanged: boolean;
  readonly units: number;
  readonly records: number;
  readonly skipped: number;
  readonly reused: number;
  readonly cursorFallbacks: number;
  readonly fullReplays: number;
  readonly parseErrors: number;
  readonly removedUnits: number;
  readonly error?: string;
}

export interface AdapterRoot {
  readonly adapter: MemoryProviderAdapter;
  readonly root: string;
}

export async function ingestProvider(store: HistoryStore, adapter: MemoryProviderAdapter, root: string): Promise<ProviderIngestReport> {
  const provider = adapter.provider;
  if (!provider || provider !== provider.trim()) throw new Error('Adapter provider id must be non-empty and trimmed');
  const previous = store.getProvider(provider);
  const markerChanged = previous !== undefined && previous.marker !== adapter.markerVersion;
  let discovered;
  try {
    discovered = await adapter.discover(root);
  } catch (error) {
    const message = errorMessage(error);
    store.recordProviderFailure(provider, previous?.marker ?? adapter.markerVersion, previous?.formatVersion ?? adapter.formatVersion, message);
    return report(provider, 'failed', adapter.markerVersion, markerChanged, { error: message });
  }

  const skipped: SkippedArtifact[] = [...discovered.skipped];
  const staged: Array<{ unit: IndexUnit; result: ParseResult }> = [];
  const seen = new Set<string>();
  let reused = 0;
  let cursorFallbacks = 0;
  let fullReplays = 0;
  let parseErrors = 0;
  const errorMessages: string[] = [];

  for (const unit of discovered.units) {
    seen.add(unit.unitId);
    const state = store.unitCursor(provider, unit.unitId);
    const unchanged = state !== undefined && state.contentHash === unit.contentHash && !markerChanged;
    const cursor = unchanged ? decodeCursor(state.cursor, unit) : undefined;
    if (unchanged && state.cursor && cursor === undefined) cursorFallbacks += 1;
    if (unchanged && cursor !== undefined) reused += 1;
    try {
      const parsed = await adapter.parse(unit, cursor);
      if (parsed.fullReplay) fullReplays += 1;
      skipped.push(...parsed.skipped);
      staged.push({ unit, result: parsed });
    } catch (error) {
      parseErrors += 1;
      const message = errorMessage(error);
      errorMessages.push(`${unit.unitId}: ${message}`);
      skipped.push({
        provider,
        sourcePath: unit.sourcePath,
        reason: `parse-error:${message}`.slice(0, 300),
        formatVersion: unit.formatVersion,
      });
    }
  }

  if (parseErrors > 0) {
    // Degraded: never reset, prune or advance the marker. Only diagnostics and
    // the provider status change, so the previous cache stays fully usable.
    for (const artifact of skipped) store.recordSkipped(artifact);
    const status: ProviderIngestReport['status'] = 'degraded';
    const counts = store.providerCounts(provider);
    const marker = previous?.marker ?? adapter.markerVersion;
    const error = errorMessages.join('; ').slice(0, 500);
    store.recordProvider(provider, {
      marker,
      formatVersion: previous?.formatVersion ?? adapter.formatVersion,
      status,
      error,
      units: counts.units,
      records: counts.records,
      skipped: counts.skipped,
    });
    return report(provider, status, marker, markerChanged, {
      units: counts.units,
      records: 0,
      skipped: counts.skipped,
      reused,
      cursorFallbacks,
      fullReplays,
      parseErrors,
      removedUnits: 0,
      ...(error ? { error } : {}),
    });
  }

  const applied = store.applyProviderIngest(provider, {
    markerChanged,
    units: staged,
    keepUnitIds: seen,
    skipped,
    marker: adapter.markerVersion,
    formatVersion: adapter.formatVersion,
    status: 'ok',
  });
  const counts = store.providerCounts(provider);

  return report(provider, 'ok', adapter.markerVersion, markerChanged, {
    units: counts.units,
    records: applied.inserted,
    skipped: counts.skipped,
    reused,
    cursorFallbacks,
    fullReplays,
    parseErrors,
    removedUnits: applied.removedUnits,
  });
}

export async function ingestAll(store: HistoryStore, inputs: readonly AdapterRoot[]): Promise<ProviderIngestReport[]> {
  const reports: ProviderIngestReport[] = [];
  for (const input of inputs) {
    try {
      reports.push(await ingestProvider(store, input.adapter, input.root));
    } catch (error) {
      const previous = store.getProvider(input.adapter.provider);
      const message = errorMessage(error);
      store.recordProviderFailure(input.adapter.provider, previous?.marker ?? input.adapter.markerVersion, previous?.formatVersion ?? input.adapter.formatVersion, message);
      reports.push(report(input.adapter.provider, 'failed', input.adapter.markerVersion, false, { error: message }));
    }
  }
  return reports;
}

function report(provider: string, status: ProviderIngestReport['status'], marker: string, markerChanged: boolean, values: Partial<Omit<ProviderIngestReport, 'provider' | 'status' | 'marker' | 'markerChanged'>>): ProviderIngestReport {
  return {
    provider,
    status,
    marker,
    markerChanged,
    units: values.units ?? 0,
    records: values.records ?? 0,
    skipped: values.skipped ?? 0,
    reused: values.reused ?? 0,
    cursorFallbacks: values.cursorFallbacks ?? 0,
    fullReplays: values.fullReplays ?? 0,
    parseErrors: values.parseErrors ?? 0,
    removedUnits: values.removedUnits ?? 0,
    ...(values.error ? { error: values.error } : {}),
  };
}

function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replaceAll(/\s+/gu, ' ').slice(0, 200);
}
