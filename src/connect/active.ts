import { existsSync } from 'node:fs';
import { ConnectStoreError, ConnectTamperError } from './errors.ts';
import { ConnectStore } from './store.ts';
import type { ConnectCurrent, ConnectManifest } from './types.ts';

export interface ActiveConnection {
  current: ConnectCurrent;
  manifest: ConnectManifest;
}

export function readActiveConnection(store: ConnectStore, repair: boolean): ActiveConnection | null {
  if (!existsSync(store.currentPath)) {
    const ids = store.listConnectionIds();
    if (ids.length === 0) return null;
    // First-commit crash window: manifests exist but current was never written.
    // Project the latest verified manifest state; persist the repair only in
    // the connect path (repair=true), never during a read.
    let best: { manifest: ConnectManifest; updatedAt: string } | null = null;
    for (const id of ids) {
      const manifest = store.readManifest(id);
      store.verifySnapshotVersion(id, manifest.current);
      if (
        best === null
        || manifest.current.createdAt > best.updatedAt
        || (manifest.current.createdAt === best.updatedAt && manifest.connectionId < best.manifest.connectionId)
      ) {
        best = { manifest, updatedAt: manifest.current.createdAt };
      }
    }
    if (!best) throw new ConnectStoreError('Connect storage has connection manifests but no readable current state');
    const projected = projectedCurrent(best.manifest);
    if (repair) store.writeCurrent(projected);
    return { current: projected, manifest: best.manifest };
  }
  const current = store.readCurrent();
  if (!current) throw new ConnectStoreError('Connect current pointer disappeared while reading');
  const manifest = store.readManifest(current.connectionId);
  const reconciled = reconcileCurrent(store, current, manifest, repair);
  return { current: reconciled, manifest };
}

/**
 * Crash-window recovery for the commit order snapshot -> manifest -> current.
 * If the manifest is ahead of the current pointer, the manifest's current
 * version is a complete commit (its snapshot was written and verified first),
 * so advance the pointer. If the pointer is ahead or unknown, fail closed.
 */
function projectedCurrent(manifest: ConnectManifest): ConnectCurrent {
  return {
    schema: 'ano.connect-current/1',
    connectionId: manifest.connectionId,
    sourceDigest: manifest.current.sourceDigest,
    version: manifest.current.version,
    snapshotPath: manifest.current.snapshotPath,
    snapshotHash: manifest.current.snapshotHash,
    updatedAt: manifest.current.createdAt,
  };
}

function reconcileCurrent(store: ConnectStore, current: ConnectCurrent, manifest: ConnectManifest, repair: boolean): ConnectCurrent {
  if (
    current.sourceDigest === manifest.current.sourceDigest
    && current.snapshotHash === manifest.current.snapshotHash
    && current.snapshotPath === manifest.current.snapshotPath
  ) {
    return current;
  }
  const currentVersion = manifest.versions.find((version) => version.sourceDigest === current.sourceDigest);
  if (!currentVersion) {
    throw new ConnectStoreError('Connect current pointer references a digest absent from the manifest');
  }
  if (manifest.current.version <= currentVersion.version) {
    throw new ConnectStoreError('Connect current pointer is ahead of the manifest; refusing to guess');
  }
  const load = store.verifySnapshotVersion(manifest.connectionId, manifest.current);
  if (load.snapshot.connectionId !== manifest.connectionId) {
    throw new ConnectTamperError('Recovering manifest current snapshot has a connection mismatch');
  }
  const repaired = projectedCurrent(manifest);
  if (repair) store.writeCurrent(repaired);
  return repaired;
}

export function assertCurrentConsistent(store: ConnectStore, current: ConnectCurrent, manifest: ConnectManifest): void {
  if (current.connectionId !== manifest.connectionId) {
    throw new ConnectStoreError('Connect current pointer does not match its manifest');
  }
  if (manifest.current.sourceDigest !== current.sourceDigest) {
    throw new ConnectStoreError('Connect current pointer does not match the manifest current version');
  }
  if (manifest.current.snapshotHash !== current.snapshotHash || manifest.current.snapshotPath !== current.snapshotPath) {
    throw new ConnectStoreError('Connect current pointer has conflicting snapshot metadata');
  }
  const load = store.loadSnapshot(current.connectionId, current.sourceDigest);
  if (load.hash !== current.snapshotHash) {
    throw new ConnectStoreError('Connect current snapshot fails its recorded hash');
  }
  store.verifySnapshotFiles(load.snapshot);
}
