import { existsSync } from 'node:fs';
import { ConnectStoreError } from './errors.ts';
import { resolveRoot } from './paths.ts';
import { toConnectedTask } from './records.ts';
import { assertCurrentConsistent, readActiveConnection } from './active.ts';
import { CONNECT_NOTICE, emptyStatus } from './read.ts';
import { ConnectStore } from './store.ts';
import { CONNECT_SCHEMA } from './types.ts';
import type { ConnectionStatus, ConnectionSummary } from './types.ts';

export async function connectionStatus(root: string): Promise<ConnectionStatus> {
  const canonical = resolveRoot(root);
  const store = new ConnectStore(canonical);
  if (!existsSync(store.baseDir)) return emptyStatus(canonical);
  const active = readActiveConnection(store, false);
  if (!active) return emptyStatus(canonical);
  const { current, manifest } = active;
  assertCurrentConsistent(store, current, manifest);

  const connections: ConnectionSummary[] = [];
  for (const connectionId of store.listConnectionIds()) {
    const entryManifest = connectionId === current.connectionId ? manifest : store.readManifest(connectionId);
    const loads = store.verifyManifestVersions(connectionId, entryManifest);
    const entryLoad = loads[loads.length - 1];
    if (!entryLoad) throw new ConnectStoreError(`Connect manifest has no versions for ${connectionId}`);
    connections.push({
      connectionId,
      source: 'pm-mcp',
      sourceDigest: entryManifest.current.sourceDigest,
      currentVersion: entryManifest.current.version,
      versionCount: entryManifest.versions.length,
      snapshotPath: entryManifest.current.snapshotPath,
      createdAt: entryManifest.createdAt,
      updatedAt: entryManifest.updatedAt,
      files: entryLoad.snapshot.files.length,
      tasks: entryLoad.snapshot.records.filter((record) => record.kind === 'task').length,
      recordCounts: entryLoad.snapshot.recordCounts,
    });
  }

  const load = store.verifySnapshotVersion(current.connectionId, manifest.current);
  const tasks = load.snapshot.records.filter((record) => record.kind === 'task').map(toConnectedTask);
  return {
    schema: CONNECT_SCHEMA,
    connected: true,
    root: canonical,
    source: 'pm-mcp',
    connections,
    tasks,
    recordCounts: load.snapshot.recordCounts,
    excluded: load.snapshot.excluded,
    identity: load.snapshot.identity,
    warnings: load.snapshot.warnings,
    untrusted: true,
    notice: CONNECT_NOTICE,
  };
}
