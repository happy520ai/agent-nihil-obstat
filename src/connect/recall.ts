import { existsSync } from 'node:fs';
import { canonicalJson } from './canonical.ts';
import { resolveRoot } from './paths.ts';
import { assertCurrentConsistent, readActiveConnection } from './active.ts';
import { clamp, CONNECT_NOTICE, emptyRecall, truncate, type RecallQuery } from './read.ts';
import { ConnectStore } from './store.ts';
import { CONNECT_SCHEMA } from './types.ts';
import type { RecallHit, RecallResult } from './types.ts';

export async function recallConnected(root: string, input: RecallQuery = {}): Promise<RecallResult> {
  const canonical = resolveRoot(root);
  const store = new ConnectStore(canonical);
  if (!existsSync(store.baseDir)) return emptyRecall(canonical, input);
  const active = readActiveConnection(store, false);
  if (!active) return emptyRecall(canonical, input);
  const { current, manifest } = active;
  assertCurrentConsistent(store, current, manifest);

  const query = (input.query ?? '').trim().toLowerCase();
  const limit = clamp(input.limit ?? 20, 1, 100, 20);
  const maxChars = 500;
  const loaded = manifest.versions
    .slice()
    .sort((a, b) => b.version - a.version)
    .map((version) => ({ version, load: store.verifySnapshotVersion(current.connectionId, version) }));

  const hits: RecallHit[] = [];
  for (const { version, load } of loaded) {
    for (const record of load.snapshot.records) {
      if (query.length > 0) {
        const haystack = [record.kind, record.sourceId, record.title, record.status, record.sourcePath, record.text, canonicalJson(record.raw)].join('\n').toLowerCase();
        if (!haystack.includes(query)) continue;
      }
      const truncated = truncate(record.text.length > 0 ? record.text : record.title, maxChars);
      hits.push({
        id: `${record.id}@v${version.version}`,
        kind: record.kind,
        text: truncated.text,
        sourcePath: record.sourcePath,
        snapshotDigest: version.sourceDigest,
        version: version.version,
        truncated: truncated.truncated,
        recordId: record.id,
        sourceId: record.sourceId,
      });
    }
  }
  const total = hits.length;
  const limited = hits.slice(0, limit);
  return {
    schema: CONNECT_SCHEMA,
    root: canonical,
    query: input.query ?? '',
    results: limited,
    total,
    truncated: total > limited.length,
    limit,
    untrusted: true,
    notice: CONNECT_NOTICE,
  };
}
