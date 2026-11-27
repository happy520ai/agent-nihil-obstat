import { createHash } from 'node:crypto';

/** Deterministic JSON used for schema hashes, evidence refs and verdict hashes. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

export function sha256Text(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function sha256Canonical(value: unknown): string {
  return sha256Text(canonicalJson(value));
}
