import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { canonicalJson } from '../ledger/event.ts';
import { MigrationError } from '../ledger/migrate.ts';

export const BACKUP_SCHEMA = 'ano.backup-manifest/1' as const;

export interface BackupSkippedEntry {
  path: string;
  reason: string;
}

export interface BackupManifest {
  schema: typeof BACKUP_SCHEMA;
  id: string;
  root: string;
  createdAt: string;
  pm: Array<{ path: string; sha256: string; bytes: number }>;
  ledger: Array<{ path: string; sha256: string; bytes: number }>;
  /** Sensitive files excluded from the backup; recorded explicitly, never silently absent. */
  skippedSensitive: BackupSkippedEntry[];
}

/**
 * Conservative sensitive-file policy (ADR-006 §2.5 "不自动读取秘密"): the
 * takeover backup must not collect credentials, tokens, private keys or
 * environment files even when they live under `.pm/` or the committed ledger.
 */
const SENSITIVE_DIRECTORY = /^(?:secrets?|credentials?|passwords?|tokens?|private(?:-?keys?)?)$/iu;
const SENSITIVE_FILE_NAME = /(?:^|[._-])(?:secret|secrets|credential|credentials|password|passwords|token|tokens|api[-_]?key|private[-_]?key)$/iu;
const KEY_MATERIAL = /\.(?:pem|key|p12|pfx|kdbx|ppk)$/iu;

function sensitiveReason(path: string): string | null {
  const parts = path.split('/');
  const base = parts.at(-1) ?? '';
  if (/^\.env(?:[.].*)?$/u.test(base)) return 'environment file';
  if (parts.some((segment) => SENSITIVE_DIRECTORY.test(segment))) return 'sensitive directory';
  if (/^credentials\.json$/iu.test(base)) return 'credential store';
  if (SENSITIVE_FILE_NAME.test(base)) return 'sensitive file name';
  if (KEY_MATERIAL.test(base)) return 'key material';
  if (base === 'id_rsa' || base === 'id_ed25519') return 'ssh private key';
  return null;
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

interface SnapshotTreeResult {
  included: Array<{ path: string; sha256: string; bytes: number }>;
  skippedSensitive: BackupSkippedEntry[];
}

async function snapshotTree(root: string, relative: string): Promise<SnapshotTreeResult> {
  const base = join(root, ...relative.split('/'));
  const included: Array<{ path: string; sha256: string; bytes: number }> = [];
  const skippedSensitive: BackupSkippedEntry[] = [];
  if (!existsSync(base)) return { included, skippedSensitive };
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = join(dir, entry.name);
      const rel = prefix.length > 0 ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(full, rel);
      else if (entry.isFile()) {
        const reason = sensitiveReason(rel);
        if (reason !== null) {
          skippedSensitive.push({ path: rel, reason });
          continue;
        }
        const bytes = await readFile(full);
        included.push({ path: rel, sha256: sha256(bytes), bytes: bytes.length });
      }
    }
  };
  await walk(base, '');
  return { included, skippedSensitive };
}

export function backupDir(root: string): string {
  return join(resolve(root), '.ano', 'backup');
}

export async function listBackups(root: string): Promise<BackupManifest[]> {
  const dir = backupDir(root);
  if (!existsSync(dir)) return [];
  const manifests: BackupManifest[] = [];
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!entry.isDirectory()) continue;
    try {
      manifests.push(JSON.parse(await readFile(join(dir, entry.name, 'manifest.json'), 'utf8')) as BackupManifest);
    } catch {
      // A partial backup directory is ignored, never treated as usable.
    }
  }
  return manifests;
}

/**
 * Copy `.pm` and the committed ledger into an immutable backup directory with a
 * content-hash manifest. The source tree is never modified.
 */
export async function backupProject(root: string, id = `backup-${Date.now().toString(36)}`): Promise<BackupManifest> {
  const projectRoot = resolve(root);
  const dir = join(backupDir(projectRoot), id);
  if (existsSync(dir)) throw new MigrationError(`Backup already exists: ${id}`);
  const [pmTree, ledgerTree] = await Promise.all([snapshotTree(projectRoot, '.pm'), snapshotTree(projectRoot, '.ano/ledger')]);
  const manifest: BackupManifest = {
    schema: BACKUP_SCHEMA,
    id,
    root: projectRoot,
    createdAt: new Date().toISOString(),
    pm: pmTree.included,
    ledger: ledgerTree.included,
    skippedSensitive: [...pmTree.skippedSensitive, ...ledgerTree.skippedSensitive],
  };
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const [relative, entries] of [['.pm', manifest.pm], ['.ano/ledger', manifest.ledger]] as const) {
    for (const entry of entries) {
      const source = join(projectRoot, ...relative.split('/'), ...entry.path.split('/'));
      const target = join(dir, relative, entry.path);
      await mkdir(join(target, '..'), { recursive: true });
      await cp(source, target);
    }
  }
  const verified = await verifyBackup(projectRoot, id);
  if (!verified.ok) {
    await rm(dir, { recursive: true, force: true });
    throw new MigrationError(`Backup verification failed: ${verified.errors.join(', ')}`);
  }
  return manifest;
}

export interface BackupVerification {
  ok: boolean;
  id: string;
  errors: string[];
  pm: number;
  ledger: number;
}

/** Verify every backed-up file against the manifest hashes before any restore. */
export async function verifyBackup(root: string, id: string): Promise<BackupVerification> {
  const projectRoot = resolve(root);
  const dir = join(backupDir(projectRoot), id);
  const errors: string[] = [];
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as BackupManifest;
  } catch (error) {
    return { ok: false, id, errors: [`manifest unreadable: ${error instanceof Error ? error.message : String(error)}`], pm: 0, ledger: 0 };
  }
  if (manifest.schema !== BACKUP_SCHEMA || manifest.id !== id) errors.push('manifest schema/id mismatch');
  for (const [relative, entries] of [['.pm', manifest.pm], ['.ano/ledger', manifest.ledger]] as const) {
    for (const entry of entries) {
      try {
        const bytes = await readFile(join(dir, relative, entry.path));
        if (sha256(bytes) !== entry.sha256) errors.push(`${relative}/${entry.path} hash mismatch`);
      } catch {
        errors.push(`${relative}/${entry.path} missing`);
      }
    }
  }
  return { ok: errors.length === 0, id, errors, pm: manifest.pm.length, ledger: manifest.ledger.length };
}

/**
 * Restore a verified backup. Refuses when the backup manifest or any file fails
 * verification; never deletes ledger history to fake a rollback.
 */
export async function restoreProject(root: string, id: string): Promise<BackupManifest> {
  const projectRoot = resolve(root);
  const verification = await verifyBackup(projectRoot, id);
  if (!verification.ok) throw new MigrationError(`Refusing to restore backup ${id}: ${verification.errors.join(', ')}`);
  const manifest = JSON.parse(await readFile(join(backupDir(projectRoot), id, 'manifest.json'), 'utf8')) as BackupManifest;
  for (const [relative, entries] of [['.pm', manifest.pm], ['.ano/ledger', manifest.ledger]] as const) {
    for (const entry of entries) {
      const source = join(backupDir(projectRoot), id, relative, entry.path);
      const target = join(projectRoot, ...relative.split('/'), ...entry.path.split('/'));
      await mkdir(join(target, '..'), { recursive: true });
      await cp(source, target);
    }
  }
  return manifest;
}

/** Stable identity for a backup manifest, used in evidence and confirmations. */
export function backupHash(manifest: BackupManifest): string {
  return sha256(canonicalJson({
    pm: manifest.pm,
    ledger: manifest.ledger,
    skippedSensitive: Array.isArray(manifest.skippedSensitive) ? manifest.skippedSensitive : [],
  }));
}
