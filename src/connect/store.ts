import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { sha256Hex } from './canonical.ts';
import { ConnectStoreError, ConnectTamperError } from './errors.ts';
import { assertRealDirectory, assertSafeExistingDirectory, assertSafeRelative, ensureSafeDirectory, safeChild } from './paths.ts';
import type { ConnectCheckpoint, ConnectCurrent, ConnectManifest, ManifestVersion, StoredSnapshot } from './types.ts';

export const CONNECT_DIR_REL = '.ano/connect';

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ConnectStoreError(`${label} must be a non-empty string`);
  }
  return value;
}

function requireHash(value: unknown, label: string): string {
  const hash = requireString(value, label);
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new ConnectTamperError(`${label} is not a sha256 hex digest: ${hash}`);
  return hash;
}

export interface SnapshotLoad {
  snapshot: StoredSnapshot;
  hash: string;
  path: string;
}

/**
 * Content-addressed, append-only connect store:
 *   .ano/connect/blobs/<sha256>                 raw immutable file bytes
 *   .ano/connect/snapshots/<connectionId>/<digest>.json
 *   .ano/connect/connections/<connectionId>/manifest.json
 *   .ano/connect/current.json                   atomic active pointer
 *   .ano/connect/checkpoints/<runId>.json       batch staging checkpoint
 */
export class ConnectStore {
  readonly root: string;
  readonly baseDir: string;

  constructor(root: string) {
    this.root = resolve(root);
    this.baseDir = safeChild(this.root, '.ano', 'connect');
  }

  /** Create and validate the store layout. Writes only inside the authorized root. */
  prepare(): void {
    assertRealDirectory(this.root, 'Project root');
    const anoDir = safeChild(this.root, '.ano');
    if (existsSync(anoDir)) {
      assertRealDirectory(anoDir, '.ano');
    } else {
      ensureSafeDirectory(anoDir);
    }
    ensureSafeDirectory(this.baseDir);
    ensureSafeDirectory(safeChild(this.baseDir, 'blobs'));
    ensureSafeDirectory(safeChild(this.baseDir, 'snapshots'));
    ensureSafeDirectory(safeChild(this.baseDir, 'connections'));
    ensureSafeDirectory(safeChild(this.baseDir, 'checkpoints'));
  }

  get lockPath(): string {
    return safeChild(this.baseDir, 'lock');
  }

  get currentPath(): string {
    return safeChild(this.baseDir, 'current.json');
  }

  connectionDir(connectionId: string): string {
    return safeChild(this.baseDir, 'connections', connectionId);
  }

  manifestPath(connectionId: string): string {
    return safeChild(this.connectionDir(connectionId), 'manifest.json');
  }

  snapshotPath(connectionId: string, sourceDigest: string): string {
    return safeChild(this.baseDir, 'snapshots', connectionId, `${sourceDigest}.json`);
  }

  checkpointPath(runId: string): string {
    return safeChild(this.baseDir, 'checkpoints', `${runId}.json`);
  }

  toRootRelative(absolute: string): string {
    return relative(this.root, absolute).split(sep).join('/');
  }

  /** Refuse to read through any symlinked parent component or terminal link. */
  private assertSafeFile(path: string): void {
    assertSafeExistingDirectory(dirname(path));
    let stats;
    try {
      stats = lstatSync(path);
    } catch {
      return; // absence is reported by the caller
    }
    if (stats.isSymbolicLink()) {
      throw new ConnectStoreError(`Refusing to read through a symbolic link/junction: ${this.toRootRelative(path)}`);
    }
  }

  readJsonFile(path: string): unknown {
    this.assertSafeFile(path);
    let raw: Buffer;
    try {
      raw = readFileSync(path);
    } catch {
      throw new ConnectStoreError(`Missing connect store file: ${this.toRootRelative(path)}`);
    }
    try {
      return JSON.parse(raw.toString('utf8')) as unknown;
    } catch (error) {
      throw new ConnectTamperError(`Connect store file is not valid JSON: ${this.toRootRelative(path)} (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  writeAtomic(path: string, data: string | Buffer): void {
    assertSafeExistingDirectory(dirname(path));
    if (existsSync(path)) {
      if (lstatSync(path).isSymbolicLink()) {
        throw new ConnectStoreError(`Refusing to replace a symbolic link: ${this.toRootRelative(path)}`);
      }
    }
    const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
    const descriptor = openSync(temp, 'wx');
    try {
      const payload = typeof data === 'string' ? Buffer.from(data) : data;
      writeSync(descriptor, payload);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    try {
      renameSync(temp, path);
    } catch (error) {
      try { unlinkSync(temp); } catch { /* best effort */ }
      throw error;
    }
  }

  // ---- current pointer -------------------------------------------------

  readCurrent(): ConnectCurrent | null {
    if (!existsSync(this.currentPath)) return null;
    const value = this.readJsonFile(this.currentPath);
    if (!isObject(value) || value.schema !== 'ano.connect-current/1') {
      throw new ConnectTamperError('Connect current pointer has an unknown schema');
    }
    return value as unknown as ConnectCurrent;
  }

  writeCurrent(current: ConnectCurrent): void {
    this.writeAtomic(this.currentPath, `${JSON.stringify(current, null, 2)}\n`);
  }

  // ---- manifest -------------------------------------------------------

  readManifest(connectionId: string): ConnectManifest {
    const path = this.manifestPath(connectionId);
    const value = this.readJsonFile(path);
    if (!isObject(value) || value.schema !== 'ano.connect-manifest/1') {
      throw new ConnectTamperError(`Connect manifest has an unknown schema: ${this.toRootRelative(path)}`);
    }
    if (requireString(value.connectionId, 'manifest.connectionId') !== connectionId) {
      throw new ConnectTamperError('Connect manifest connectionId mismatch');
    }
    return value as unknown as ConnectManifest;
  }

  writeManifest(manifest: ConnectManifest): void {
    this.writeAtomic(this.ensureParent(this.manifestPath(manifest.connectionId)), `${JSON.stringify(manifest, null, 2)}\n`);
  }

  listConnectionIds(): string[] {
    const dir = safeChild(this.baseDir, 'connections');
    if (!existsSync(dir)) return [];
    assertSafeExistingDirectory(dir);
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => {
        if (entry.isSymbolicLink()) {
          throw new ConnectStoreError(`Refusing to traverse a symbolic link/junction in the connect store: ${entry.name}`);
        }
        return entry.isDirectory();
      })
      .map((entry) => entry.name)
      .sort();
  }

  // ---- snapshots ------------------------------------------------------

  loadSnapshot(connectionId: string, sourceDigest: string): SnapshotLoad {
    const path = this.snapshotPath(connectionId, sourceDigest);
    if (!existsSync(path)) {
      throw new ConnectStoreError(`Missing connect snapshot for digest ${sourceDigest}`);
    }
    this.assertSafeFile(path);
    let raw: Buffer;
    try {
      raw = readFileSync(path);
    } catch {
      throw new ConnectStoreError(`Cannot read connect snapshot for digest ${sourceDigest}`);
    }
    const hash = sha256Hex(raw);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8')) as unknown;
    } catch (error) {
      throw new ConnectTamperError(`Connect snapshot is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!isObject(parsed) || parsed.schema !== 'ano.connect-snapshot/1') {
      throw new ConnectTamperError('Connect snapshot has an unknown schema');
    }
    const snapshot = parsed as unknown as StoredSnapshot;
    if (snapshot.sourceDigest !== sourceDigest) {
      throw new ConnectTamperError(`Snapshot digest mismatch: expected ${sourceDigest}`);
    }
    if (snapshot.connectionId !== connectionId) {
      throw new ConnectTamperError(`Snapshot connection mismatch: expected ${connectionId}`);
    }
    return { snapshot, hash, path };
  }

  writeSnapshot(connectionId: string, snapshot: StoredSnapshot): { path: string; hash: string; existed: boolean } {
    const path = this.ensureParent(this.snapshotPath(connectionId, snapshot.sourceDigest));
    const data = `${JSON.stringify(snapshot, null, 2)}\n`;
    const nextHash = sha256Hex(data);
    if (existsSync(path)) {
      let existing: Buffer;
      try {
        existing = readFileSync(path);
      } catch {
        throw new ConnectStoreError(`Cannot read existing snapshot: ${this.toRootRelative(path)}`);
      }
      const existingHash = sha256Hex(existing);
      if (existingHash !== nextHash) {
        throw new ConnectTamperError(`Snapshot already exists with different content: ${this.toRootRelative(path)}`);
      }
      return { path, hash: existingHash, existed: true };
    }
    this.writeAtomic(path, data);
    return { path, hash: nextHash, existed: false };
  }

  verifySnapshotFiles(snapshot: StoredSnapshot): void {
    for (const file of snapshot.files) this.readBlob(file.hash);
  }

  /** Verify one manifest version against its immutable snapshot and every blob. */
  verifySnapshotVersion(connectionId: string, version: ManifestVersion): SnapshotLoad {
    const load = this.loadSnapshot(connectionId, version.sourceDigest);
    if (load.hash !== version.snapshotHash) {
      throw new ConnectTamperError(`Snapshot hash mismatch for version ${version.version}: expected ${version.snapshotHash}`);
    }
    if (load.snapshot.sourceDigest !== version.sourceDigest) {
      throw new ConnectTamperError(`Snapshot digest mismatch for version ${version.version}`);
    }
    if (load.snapshot.connectionId !== connectionId) {
      throw new ConnectTamperError(`Snapshot connection mismatch for version ${version.version}`);
    }
    this.verifySnapshotFiles(load.snapshot);
    return load;
  }

  /** Verify every historical version of a manifest; any corruption fails closed. */
  verifyManifestVersions(connectionId: string, manifest: ConnectManifest): SnapshotLoad[] {
    return manifest.versions.map((version) => this.verifySnapshotVersion(connectionId, version));
  }

  // ---- blobs ----------------------------------------------------------

  blobPath(hash: string): string {
    return safeChild(this.baseDir, 'blobs', requireHash(hash, 'blob hash'));
  }

  putBlob(hash: string, content: Buffer): 'written' | 'existing' {
    const path = this.blobPath(hash);
    if (existsSync(path)) {
      this.assertSafeFile(path);
      let existing: Buffer;
      try {
        existing = readFileSync(path);
      } catch {
        throw new ConnectStoreError(`Cannot read existing blob: ${hash}`);
      }
      if (existing.length !== content.length || sha256Hex(existing) !== hash) {
        throw new ConnectTamperError(`Existing blob fails SHA-256 verification: ${hash}`);
      }
      return 'existing';
    }
    this.writeAtomic(path, content);
    return 'written';
  }

  readBlob(hash: string): Buffer {
    const path = this.blobPath(hash);
    this.assertSafeFile(path);
    let content: Buffer;
    try {
      content = readFileSync(path);
    } catch {
      throw new ConnectStoreError(`Missing content-addressed blob: ${hash}`);
    }
    if (sha256Hex(content) !== hash) {
      throw new ConnectTamperError(`Blob fails SHA-256 verification: ${hash}`);
    }
    return content;
  }

  // ---- checkpoints ----------------------------------------------------

  readCheckpoint(runId: string): ConnectCheckpoint | null {
    const path = this.checkpointPath(runId);
    if (!existsSync(path)) return null;
    const value = this.readJsonFile(path);
    if (!isObject(value) || value.schema !== 'ano.connect-checkpoint/1') {
      throw new ConnectTamperError('Connect checkpoint has an unknown schema');
    }
    return value as unknown as ConnectCheckpoint;
  }

  writeCheckpoint(checkpoint: ConnectCheckpoint): void {
    this.writeAtomic(this.checkpointPath(checkpoint.runId), `${JSON.stringify(checkpoint, null, 2)}\n`);
  }

  removeCheckpoint(runId: string): void {
    const path = this.checkpointPath(runId);
    if (!existsSync(path)) return;
    try {
      unlinkSync(path);
    } catch {
      // A stale checkpoint is harmless: duplicate detection is digest-based.
    }
  }

  private ensureParent(path: string): string {
    ensureSafeDirectory(dirname(path));
    return path;
  }

  storedPathForSnapshot(connectionId: string, sourceDigest: string): string {
    return this.toRootRelative(this.snapshotPath(connectionId, sourceDigest));
  }
}
