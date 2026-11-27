import { recordsFingerprint } from './records.ts';
import type { ExportChange, StoredRecord, StoredSnapshot } from './types.ts';

export function diffRecords(
  previous: StoredSnapshot | null,
  next: readonly StoredRecord[],
  previousPath: string | undefined,
): ExportChange[] {
  const changes: ExportChange[] = [];
  const previousByKey = new Map<string, StoredRecord>();
  for (const record of previous?.records ?? []) previousByKey.set(`${record.kind}\u0000${record.sourceId}`, record);
  const nextByKey = new Map<string, StoredRecord>();
  for (const record of next) nextByKey.set(`${record.kind}\u0000${record.sourceId}`, record);

  for (const record of next) {
    const key = `${record.kind}\u0000${record.sourceId}`;
    const before = previousByKey.get(key);
    if (!before) {
      changes.push({ kind: 'added', recordId: record.id, sourcePath: record.sourcePath });
      continue;
    }
    if (recordsFingerprint([before]) !== recordsFingerprint([record])) {
      changes.push({ kind: 'updated', recordId: record.id, sourcePath: record.sourcePath });
    }
  }
  for (const record of previous?.records ?? []) {
    const key = `${record.kind}\u0000${record.sourceId}`;
    if (nextByKey.has(key)) continue;
    changes.push({
      kind: 'removed',
      recordId: record.id,
      sourcePath: record.sourcePath,
      ...(previousPath ? { archivedIn: previousPath } : {}),
      ...(previous ? { snapshotDigest: previous.sourceDigest } : {}),
    });
  }
  return changes;
}

export function countChanges(changes: readonly ExportChange[]): { added: number; updated: number; removed: number } {
  let added = 0;
  let updated = 0;
  let removed = 0;
  for (const change of changes) {
    if (change.kind === 'added') added += 1;
    else if (change.kind === 'updated') updated += 1;
    else removed += 1;
  }
  return { added, updated, removed };
}
