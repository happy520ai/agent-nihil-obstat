import { existsSync } from 'node:fs';
import { ConnectStoreError } from './errors.ts';
import { resolveRoot } from './paths.ts';
import { toConnectedTask } from './records.ts';
import { assertCurrentConsistent, readActiveConnection } from './active.ts';
import { CONNECT_CAPABILITIES } from './capabilities.ts';
import { CONNECT_NOTICE } from './read.ts';
import { ConnectStore } from './store.ts';
import { CONNECT_EXPORT_SCHEMA } from './types.ts';
import type { ExportChange, ExportConnection } from './types.ts';

export async function exportConnection(root: string, now: () => string): Promise<ExportConnection> {
  const canonical = resolveRoot(root);
  const store = new ConnectStore(canonical);
  if (!existsSync(store.baseDir)) throw new ConnectStoreError('No Connect connection exists to export');
  const active = readActiveConnection(store, false);
  if (!active) throw new ConnectStoreError('No Connect connection exists to export');
  const { current, manifest } = active;
  assertCurrentConsistent(store, current, manifest);

  const versions = [];
  const allChanges: ExportChange[] = [];
  for (const version of manifest.versions) {
    const load = store.verifySnapshotVersion(current.connectionId, version);
    const files = load.snapshot.files.map((file) => ({
      path: file.path,
      hash: file.hash,
      bytes: file.bytes,
      ...(file.mediaType !== undefined ? { mediaType: file.mediaType } : {}),
      ...(file.binary !== undefined ? { binary: file.binary } : {}),
      base64: store.readBlob(file.hash).toString('base64'),
    }));
    versions.push({
      version: version.version,
      sourceDigest: version.sourceDigest,
      snapshotPath: version.snapshotPath,
      createdAt: version.createdAt,
      files,
      excluded: load.snapshot.excluded,
      records: load.snapshot.records.map((record) => record.raw),
      changes: version.changes,
    });
    allChanges.push(...version.changes);
  }

  const currentLoad = store.verifySnapshotVersion(current.connectionId, manifest.current);
  return {
    schema: CONNECT_EXPORT_SCHEMA,
    connectionId: current.connectionId,
    source: 'pm-mcp',
    root: canonical,
    current: {
      version: current.version,
      sourceDigest: current.sourceDigest,
      snapshotPath: current.snapshotPath,
    },
    versions,
    excluded: currentLoad.snapshot.excluded,
    records: currentLoad.snapshot.records.map((record) => record.raw),
    tasks: currentLoad.snapshot.records.filter((record) => record.kind === 'task').map(toConnectedTask),
    changes: allChanges,
    capabilities: [...CONNECT_CAPABILITIES],
    limitations: [
      'This bundle is not a native pm-mcp ledger and must not be treated as one.',
      'ANO does not automatically write exported data back to pm-mcp.',
      'Imported tasks are read-only and carry verification "unverified".',
      'This is not a byte-for-byte backup of .pm: rebuildable derived search cache files (.pm/index.db, .pm/index.db-wal, .pm/index.db-shm) are excluded.',
      'Binary blobs are exported for reconstruction but are not text-searchable.',
    ],
    notice: CONNECT_NOTICE,
    exportedAt: now(),
  };
}
