/**
 * Shared redaction for client configuration entries (M12/T-101, D3 fix).
 *
 * A `configured` layer reports the discovered `ano` entry as inert data, but
 * it must never echo secret values. Environment values, header values and
 * other credential containers are reduced to their key names; only a fixed
 * allow-list of non-secret fields is copied. The shape matches the Qoder
 * adapter's `redactEntry` (the M11 reference behaviour) and is applied
 * uniformly by every adapter and by the registry discovery path.
 */

/** Non-secret entry fields that are safe to copy verbatim. */
export const CLIENT_ENTRY_SAFE_KEYS = [
  'type',
  'command',
  'args',
  'cwd',
  'url',
  'transport',
  'enabled',
  'timeout',
] as const;

/** Credential-bearing containers that are reported by key name only. */
export const CLIENT_ENTRY_SECRET_CONTAINERS = [
  'env',
  'environment',
  'headers',
  'authentication',
  'auth',
] as const;

/**
 * Redacted view of a client MCP entry. Secret container values are never
 * copied; only their sorted key names are reported.
 */
export function redactClientConfigEntry(entry: unknown): Record<string, unknown> {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return { valueKind: Array.isArray(entry) ? 'array' : typeof entry };
  }
  const record = entry as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of CLIENT_ENTRY_SAFE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(record, key)) out[key] = record[key];
  }
  for (const key of CLIENT_ENTRY_SECRET_CONTAINERS) {
    const value = record[key];
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      out[`${key}Keys`] = Object.keys(value as Record<string, unknown>).sort();
    }
  }
  out['redacted'] = true;
  return out;
}
