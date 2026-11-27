import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { HlcTimestamp } from '../core/hlc.ts';

/**
 * Event kinds are an append-only vocabulary. Adding a kind does not change the
 * shape of already committed events, so existing segments keep their hashes.
 * The SQLite views schema is versioned separately (see views.ts).
 */
export const ledgerEventKinds = [
  'segment.started',
  'task.created',
  'task.updated',
  'evidence.recorded',
  'verify.started',
  'verify.finished',
  'run.lease.acquired',
  'run.lease.heartbeat',
  'run.lease.reclaimed',
  'run.lease.released',
  'migration.recorded',
  // Cross-domain facts. These are append-only additions: existing events keep
  // their bytes and hashes, and each kind has its own payload contract (see
  // payloads.ts), so none of them is reduced to a task_id.
  'note.recorded',
  'audit.finding',
  'audit.completed',
  'readiness.evidence',
  'readiness.attestation',
  'release.verdict',
  'release.approved',
  // ADR-005 §3: versioned memory facts. Appended at the tail of the vocabulary
  // so every previously committed event keeps its kind index, bytes and hash;
  // each kind has its own strict payload contract (see payloads.ts) and forces
  // an idempotency key at append time (ledger.ts).
  'memory.revised',
  'memory.related',
  'memory.conflict.resolved',
  // ADR-010 §3.2: file/symbol structure queries. Appended at the tail so every
  // previously committed event keeps its kind index, bytes and hash; the strict
  // snake_case payload contract lives in payloads.ts and the revision-bound
  // projection in views.ts.
  'structure.queried',
  // ADR-013 §4.2 / T-165: hook session engine. Appended at the tail so every
  // previously committed event keeps its kind index, bytes and hash. These two
  // kinds carry the session-start baseline and the stop check result; their
  // payloads are validated by the session engine (src/hooks/session.ts) and are
  // historical/mechanical material, never Gate evidence. See
  // LEDGER_EVENT_SCHEMA_VERSION below for the explicit schema-version event.
  'session.started',
  'session.stop_checked',
] as const;

/**
 * 显式事件 schema 升版标记（ADR-013 §4.2 / T-165：「事件 schema hash 显式升版」）。
 *
 * ADR-005 §2/ADR-010 §3.2 的追加式词汇保证旧事件的字节与哈希不变；本常量记录
 * 本次追加两个 session kind 是一次有意的 schema 版本变更。`scripts/check-schema.ts`
 * 的 `PINNED.ledgerEvents` / `PINNED.ledgerKinds` 必须在合并时同步刷新到新值，
 * 以保持「hash 显式升版」的闸门语义（该文件不归 T-165 修改，见实施规格互斥约束）。
 */
export const LEDGER_EVENT_SCHEMA_VERSION = 3 as const;

export const ledgerEventSchema = z.object({
  id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
  hlc: z.object({ physical: z.number().int().nonnegative(), logical: z.number().int().nonnegative(), actor: z.string().min(1) }).strict(),
  actor: z.string().min(1),
  kind: z.enum(ledgerEventKinds),
  payload: z.record(z.string(), z.unknown()),
  idem_key: z.string().min(1).max(128).optional(),
  prev_hash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type LedgerEvent = z.infer<typeof ledgerEventSchema>;
export type LedgerEventInput = Omit<LedgerEvent, 'id' | 'hlc' | 'actor' | 'prev_hash'>;
export const genesisHash = '0'.repeat(64);

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

export function hashEvent(event: LedgerEvent): string {
  return createHash('sha256').update(canonicalJson(event)).digest('hex');
}

export function eventChain(events: LedgerEvent[]): boolean {
  let previous = genesisHash;
  for (const event of events) {
    if (event.prev_hash !== previous || ledgerEventSchema.safeParse(event).success === false) return false;
    previous = hashEvent(event);
  }
  return true;
}

export function lastHash(events: LedgerEvent[]): string {
  return events.length === 0 ? genesisHash : hashEvent(events.at(-1)!);
}

export function timestampString(hlc: HlcTimestamp): string {
  return `${hlc.physical.toString().padStart(13, '0')}:${hlc.logical.toString().padStart(10, '0')}:${hlc.actor}`;
}
