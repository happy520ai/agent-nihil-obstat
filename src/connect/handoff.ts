import { existsSync } from 'node:fs';
import { resolveRoot } from './paths.ts';
import { assertCurrentConsistent, readActiveConnection } from './active.ts';
import { CONNECT_CAPABILITIES, roleMatrixForState } from './capabilities.ts';
import { ConnectStore } from './store.ts';
import { CONNECT_SCHEMA } from './types.ts';
import type { ConnectCurrent, HandoffReadiness, HandoffTakeover } from './types.ts';
import { readMigrationSummary, reconcileMigration, planMigration } from '../ledger/migrate.ts';
import { listBackups, verifyBackup, backupHash, type BackupManifest } from './backup.ts';
import { readCutover } from './cutover.ts';
import { loadPolicy } from './takeover-store.ts';
import { computeTakeoverSourceDigest } from './takeover.ts';

/**
 * Evidence-driven handoff readiness.
 *
 * `ready` is true only when every condition holds: a consistent Connect
 * connection exists, the current source digest was migrated, the source has not
 * drifted from that migration, reconciliation reports no missing/conflicting
 * tasks, a verified backup exists, and a named human cutover confirmation binds
 * that source digest and backup. Any missing evidence becomes an actionable
 * blocker instead of a fixed `false`.
 */
export async function handoffReadiness(root: string): Promise<HandoffReadiness> {
  const canonical = resolveRoot(root);
  const store = new ConnectStore(canonical);
  const blockers: string[] = [];
  let current: ConnectCurrent | null = null;
  if (!existsSync(store.baseDir)) {
    blockers.push('No Connect connection exists for this project.');
  } else {
    const active = readActiveConnection(store, false);
    current = active?.current ?? null;
    if (active) assertCurrentConsistent(store, active.current, active.manifest);
    else blockers.push('No Connect connection exists for this project.');
  }

  let migration: Record<string, unknown> | undefined;
  let verifiedBackup: BackupManifest | undefined;
  let cutover: Awaited<ReturnType<typeof readCutover>>;

  if (current) {
    migration = readMigrationSummary(canonical);
    const plan = planMigration(canonical);
    if (!migration) {
      blockers.push('Project was not migrated into the ANO ledger; run `ano migrate apply` first.');
    } else if (String(migration.source_sha256) !== plan.sourceDigest) {
      blockers.push('Migrated source digest does not match the current migration plan; re-run `ano migrate plan/apply`.');
    }

    try {
      const reconcile = reconcileMigration(canonical) as Record<string, unknown>;
      if (reconcile.sourceUnchanged !== true) blockers.push('Source changed since migration; reconcile before handoff.');
      const missing = Array.isArray(reconcile.missing) ? reconcile.missing : [];
      const conflicts = Array.isArray(reconcile.conflicts) ? reconcile.conflicts : [];
      if (missing.length > 0) blockers.push(`Migration is missing ${missing.length} source task(s).`);
      if (conflicts.length > 0) blockers.push(`Migration has ${conflicts.length} conflicting task(s).`);
    } catch (error) {
      blockers.push(`Migration reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    for (const candidate of await listBackups(canonical)) {
      if ((await verifyBackup(canonical, candidate.id)).ok) {
        verifiedBackup = candidate;
        break;
      }
    }
    if (!verifiedBackup) blockers.push('No verified backup exists; run `ano migrate backup` before cutover.');

    cutover = await readCutover(canonical);
    if (!cutover) {
      blockers.push('No named human cutover confirmation; run `ano connect cutover confirm`.');
    } else if (cutover.sourceDigest !== plan.sourceDigest) {
      blockers.push('Cutover confirmation is bound to a different migration source digest.');
    } else if (verifiedBackup && cutover.backupHash !== backupHash(verifiedBackup)) {
      blockers.push('Cutover confirmation does not match the verified backup.');
    }
  }

  const ready = blockers.length === 0 && current !== null;
  const takeover = describeTakeover(canonical);
  return {
    schema: CONNECT_SCHEMA,
    root: canonical,
    ready,
    blockers,
    capabilities: [...CONNECT_CAPABILITIES, ...(ready ? ['handoff'] : [])],
    ...(current ? { connectionId: current.connectionId, sourceDigest: current.sourceDigest } : {}),
    ...(migration ? { migration: { sourceDigest: String(migration.source_sha256) } } : {}),
    ...(cutover ? { cutover: { name: cutover.name, role: cutover.role, confirmedAt: cutover.confirmedAt } } : {}),
    ...(takeover === undefined ? {} : { takeover }),
  };
}

/**
 * Project-takeover projection attached to handoff readiness (T-071). The old
 * Connect readiness semantics are untouched; this field only adds the role
 * declaration. A project without a persisted policy gets no field at all.
 */
function describeTakeover(root: string): HandoffTakeover | undefined {
  const policy = loadPolicy(root);
  if (policy === null) return undefined;
  const roleMatrix = roleMatrixForState(policy.state, policy.hostCapability);
  const tasks = roleMatrix.layers.find((entry) => entry.layer === 'tasks');
  let driftPending = false;
  if (policy.state === 'enforced') {
    try {
      driftPending = computeTakeoverSourceDigest(root) !== policy.baselineDigest;
    } catch {
      driftPending = false;
    }
  }
  const note = policy.state === 'enforced'
    ? 'legacy PM-mcp is read-only while takeover is enforced; ANO is the primary writer'
    : policy.state === 'recovery'
      ? 'ANO writes are paused and legacy PM-mcp is restoring primary-write'
      : 'no enforced takeover; legacy PM-mcp remains primary-write';
  return {
    state: policy.state,
    enforced: policy.state === 'enforced',
    legacyPm: tasks?.legacyPm ?? 'read-only',
    authorizationId: policy.authorization.authorizationId,
    driftPending,
    roleMatrix,
    note,
  };
}
