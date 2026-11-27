import { createHash } from 'node:crypto';

/** Deterministic JSON helpers shared by source digests, snapshots and checkpoints. */

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) sorted[key] = sortValue(source[key]);
    return sorted;
  }
  return value;
}

/** Stable stringify: object keys sorted recursively, no whitespace. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function stableJson(value: unknown): string {
  return `${JSON.stringify(sortValue(value), null, 2)}\n`;
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function slugify(value: string, maxLength = 64): string {
  const slug = value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
  return slug.length > 0 ? slug : 'item';
}

export function assertPlainObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}
