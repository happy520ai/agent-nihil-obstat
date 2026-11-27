import type { Cursor, IndexUnit } from './types.ts';

export const CURSOR_VERSION = 1;

export function makeCursor(unit: Pick<IndexUnit, 'unitId' | 'contentHash'>, line: number): Cursor {
  return { v: CURSOR_VERSION, unitId: unit.unitId, contentHash: unit.contentHash, line };
}

/** Structural validation plus the identity checks that bind a cursor to a unit. */
export function isValidCursor(value: unknown, unit: Pick<IndexUnit, 'unitId' | 'contentHash'>): value is Cursor {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<Cursor>;
  return candidate.v === CURSOR_VERSION
    && candidate.unitId === unit.unitId
    && candidate.contentHash === unit.contentHash
    && typeof candidate.line === 'number'
    && Number.isInteger(candidate.line)
    && candidate.line >= 0;
}

/**
 * Any malformed or stale cursor degrades to a full replay. The caller receives
 * `undefined`, not an exception, so one corrupt cache row cannot poison a unit.
 */
export function decodeCursor(raw: string | null | undefined, unit: Pick<IndexUnit, 'unitId' | 'contentHash'>): Cursor | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isValidCursor(parsed, unit) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
