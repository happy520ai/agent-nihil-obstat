#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { z } from 'zod';
import { toolCatalog } from '../src/surface/tool-catalog.ts';
import { canonicalJson, ledgerEventSchema } from '../src/ledger/event.ts';

/**
 * Schema pinning gate.
 *
 * Every MCP tool input schema and the closed ledger event schema are hashed in
 * canonical JSON form. Changing a field, enum member, strictness or description
 * of the schema changes the hash and fails this check until the pin below is
 * updated deliberately (which is the explicit schema-version event).
 */

type AnySchema = z.ZodType<unknown, unknown>;

export const EXPECTED_TOOL_NAMES = ['brief', 'explore', 'recall', 'track', 'note', 'verify', 'audit'] as const;

export interface SchemaPins {
  tools: Record<string, string>;
  ledgerEvents: string;
  ledgerKinds: string[];
}

export function schemaJson(schema: AnySchema): unknown {
  return z.toJSONSchema(schema, { io: 'input' });
}

export function schemaHash(schema: AnySchema): string {
  return createHash('sha256').update(canonicalJson(schemaJson(schema))).digest('hex');
}

export function currentPins(): SchemaPins {
  const tools: Record<string, string> = {};
  for (const tool of toolCatalog) tools[tool.name] = schemaHash(tool.input);
  const ledgerJson = schemaJson(ledgerEventSchema) as { properties?: { kind?: { enum?: unknown[] } } };
  const kinds = Array.isArray(ledgerJson.properties?.kind?.enum)
    ? ledgerJson.properties.kind.enum.map(String)
    : [];
  return { tools, ledgerEvents: schemaHash(ledgerEventSchema), ledgerKinds: kinds };
}

/** Filled by `node scripts/check-schema.ts --print`; update only with a deliberate schema version change. */
export const PINNED: SchemaPins = {
  tools: {
    brief: 'eb334daa53a67d57e6b098b0945a3d4529940921cb01d63215dbc0c60709b506',
    explore: 'cb3ae02fc86590300f507d6d5ada9045af904f92879c93606102b8705a418fcd',
    // Connect v1 adds opt-in source/query/limit and connection lifecycle operations.
    // The seven tool names and Gate/ledger event contracts remain unchanged.
    // AP-13 (T-050) adds the opt-in include_memory_context branch; task/release
    // verification fields are unchanged and mutually exclusive with scope=context.
    recall: 'a963c7d99d57ad4c10415fad99c80c65547c198eaf8e56c70f10bfe86e21dbf2',
    // M7 adds native task update/complete/cancel/reopen and PM->ANO migration
    // operations. The seven tool names and Gate/ledger event contracts are unchanged.
    // T-072 adds the strict takeover lifecycle branch (grant/apply/status/recover/
    // disable/revoke) to the same `track` tool; the tool count stays at seven.
    track: 'eba0e1f0f34f6331c2870965eeb374c9ed6f7a8d34ad585e04e2bfd649084260',
    // AP-13 adds explicit operation=revise|relate branches alongside the legacy
    // fact-note shape; the branch fields are mutually exclusive.
    note: '94b949bbfe3cccb9df49d3a578c5cfb559d27593d95a442155d2743477cea9fe',
    // Task-only opt-in coverage tier: `tier: 'T0'|'T1'` is accepted for
    // scope=task and rejected on release/context. Default remains T1 strict.
    verify: 'aac8660799141ea7a23d11e2ab315da4738e0e9a96ffc232096fdc698b25f28b',
    audit: 'dc952225268657ace0971b1d868ee475fc019714dca9d1d1aaaec8973cc9035f',
  },
  // ADR-010 §3.2 schema-version event: `structure.queried` appended at the tail.
  // ADR-013 §4.2 schema-version event: `session.started` and `session.stop_checked`
  // appended afterward. Only the ledger event enum changed; seven tool schemas remain.
  ledgerEvents: 'c1783ba3cc69c4dd5031ad55e0edd8363881ff3bd1097eef9277b19254231195',
  ledgerKinds: [
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
    'note.recorded',
    'audit.finding',
    'audit.completed',
    'readiness.evidence',
    'readiness.attestation',
    'release.verdict',
    'release.approved',
    'memory.revised',
    'memory.related',
    'memory.conflict.resolved',
    'structure.queried',
    'session.started',
    'session.stop_checked',
  ],
};

export interface SchemaCheckResult { ok: boolean; problems: string[]; current: SchemaPins }

export function checkSchemaPins(pinned: SchemaPins = PINNED): SchemaCheckResult {
  const current = currentPins();
  const problems: string[] = [];
  const names = toolCatalog.map((tool) => tool.name);
  if (names.length !== 7) problems.push(`expected exactly 7 tools, found ${names.length}`);
  if (JSON.stringify(names) !== JSON.stringify([...EXPECTED_TOOL_NAMES])) problems.push(`tool names changed: ${names.join(',')}`);
  for (const name of EXPECTED_TOOL_NAMES) {
    if (!pinned.tools[name]) problems.push(`missing pinned hash for tool ${name}`);
    else if (current.tools[name] !== pinned.tools[name]) problems.push(`tool schema changed: ${name} (${pinned.tools[name]} -> ${current.tools[name]})`);
  }
  for (const name of Object.keys(pinned.tools)) if (!EXPECTED_TOOL_NAMES.includes(name as typeof EXPECTED_TOOL_NAMES[number])) problems.push(`unexpected pinned tool: ${name}`);
  if (current.ledgerEvents !== pinned.ledgerEvents) problems.push(`ledger event schema changed: ${pinned.ledgerEvents} -> ${current.ledgerEvents}`);
  if (JSON.stringify(current.ledgerKinds) !== JSON.stringify(pinned.ledgerKinds)) problems.push(`ledger event kinds changed: ${pinned.ledgerKinds.join(',')} -> ${current.ledgerKinds.join(',')}`);
  for (const name of EXPECTED_TOOL_NAMES) if (/approve|attest|sync|push|publish/.test(name)) problems.push(`human-only capability exposed as a tool: ${name}`);
  return { ok: problems.length === 0, problems, current };
}

const invokedPath = process.argv[1];
if (invokedPath && pathToFileURL(resolve(invokedPath)).href === import.meta.url) {
  if (process.argv.includes('--print')) {
    console.log(JSON.stringify(currentPins(), null, 2));
  } else {
    const result = checkSchemaPins();
    if (result.ok) {
      console.log(`Schema pins match: 7 tools + ledger event schema (${result.current.ledgerKinds.length} kinds).`);
    } else {
      console.error('Schema pin check failed (schema changes must be explicit and versioned):');
      for (const problem of result.problems) console.error(`- ${problem}`);
      process.exitCode = 1;
    }
  }
}
