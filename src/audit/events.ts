import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AuditEvent, AuditEventSink, AuditResult } from './types.ts';

/**
 * Audit event interface.
 *
 * The current ledger event schema (src/ledger/event.ts) has a closed kind enum
 * that does not yet include audit events. P5 therefore stops at this sink
 * boundary: a main controller can adapt it to the ledger once that schema is
 * extended, without any audit finding gaining a plaintext field.
 */
export interface LedgerAuditInput {
  kind: 'audit.finding' | 'audit.completed';
  payload: Record<string, unknown>;
}

export function auditEvents(result: AuditResult): AuditEvent[] {
  const at = result.finishedAt;
  const events: AuditEvent[] = result.findings.map((finding) => ({
    schema: 'ano.audit.event.v1',
    type: 'finding',
    scope: result.scope,
    root: result.root,
    at,
    finding,
  }));
  events.push({
    schema: 'ano.audit.event.v1',
    type: 'summary',
    scope: result.scope,
    root: result.root,
    at,
    summary: result.summary,
    ok: result.ok,
  });
  return events;
}

/** Payloads for a future ledger adapter. No raw file content or secret is included. */
export function ledgerAuditInputs(result: AuditResult): LedgerAuditInput[] {
  return auditEvents(result).map((event) => ({
    kind: event.type === 'finding' ? 'audit.finding' : 'audit.completed',
    payload: {
      scope: event.scope,
      at: event.at,
      ...(event.finding ? { finding: event.finding } : {}),
      ...(event.summary ? { summary: event.summary } : {}),
      ...(event.ok !== undefined ? { ok: event.ok } : {}),
    },
  }));
}

export class InMemoryAuditEventSink implements AuditEventSink {
  readonly events: AuditEvent[] = [];
  record(event: AuditEvent): void { this.events.push(event); }
}

/** Append-only JSONL sink under .ano/audit; convenient for controllers that cannot write the ledger yet. */
export class JsonlAuditEventSink implements AuditEventSink {
  readonly path: string;
  constructor(root: string) { this.path = join(root, '.ano', 'audit', 'events.jsonl'); }
  async record(event: AuditEvent): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, JSON.stringify(event) + '\n', 'utf8');
  }
}

export async function emitAuditEvents(sink: AuditEventSink | undefined, result: AuditResult): Promise<void> {
  if (!sink) return;
  for (const event of auditEvents(result)) await sink.record(event);
}
