import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GraphSnapshot } from '../structure/types.ts';

/**
 * Anchor relocation has three decreasing-confidence levels:
 *   1. symbol_id                -> exact
 *   2. qualified_name + file    -> renamed symbol id, same definition
 *   3. file + content fragment  -> renamed/moved within the same file
 * Any failure is reported as `stale`; we never silently point at a different
 * file or an unrelated symbol.
 */
export interface MemoryAnchor {
  readonly file: string;
  readonly symbolId?: string;
  readonly qualifiedName?: string;
  readonly contentFragmentHash?: string;
  /** Internal relocation material; optional and not required by the tool schema. */
  readonly contentFragment?: string;
}

export interface AnchorSymbol {
  readonly id: string;
  readonly file: string;
  readonly name: string;
  readonly qualifiedName: string;
}

export interface AnchorSource {
  findSymbolById(id: string): AnchorSymbol | undefined;
  findSymbolByQualifiedName(qualifiedName: string, file: string): AnchorSymbol | undefined;
  readFile(file: string): string | undefined;
  /**
   * Freshness of the symbol table behind this source. Omitted means the table
   * is trusted (historical behaviour). Only `fresh` may back an `exact` or
   * symbol-table `relocated` result; a stale/degraded table is reported as
   * `stale` so an outdated symbol hit never masquerades as fresh evidence.
   */
  readonly symbolFreshness?: AnchorSymbolFreshness;
}

/** Graph freshness projected onto the symbol table. */
export type AnchorSymbolFreshness = 'fresh' | 'stale' | 'degraded' | 'unknown';

export type AnchorResolution =
  | { readonly status: 'exact'; readonly level: 1; readonly file: string; readonly symbol: AnchorSymbol; readonly anchor: MemoryAnchor }
  | { readonly status: 'relocated'; readonly level: 2 | 3; readonly file: string; readonly symbol?: AnchorSymbol; readonly anchor: MemoryAnchor; readonly reason: 'renamed-symbol-id' | 'fragment-match' | 'file-hash-match' }
  | { readonly status: 'stale'; readonly level: 0; readonly file: string | null; readonly anchor: MemoryAnchor; readonly reason: 'file-missing' | 'relocation-failed' | 'insufficient-anchor-evidence' | 'stale-symbol-table' };

export function resolveAnchor(anchor: MemoryAnchor, source: AnchorSource): AnchorResolution {
  const symbolTableFresh = source.symbolFreshness === undefined || source.symbolFreshness === 'fresh';

  if (symbolTableFresh && anchor.symbolId) {
    const symbol = source.findSymbolById(anchor.symbolId);
    if (symbol) return { status: 'exact', level: 1, file: symbol.file, symbol, anchor };
  }

  if (symbolTableFresh && anchor.qualifiedName) {
    const symbol = source.findSymbolByQualifiedName(anchor.qualifiedName, anchor.file);
    if (symbol) return { status: 'relocated', level: 2, file: symbol.file, symbol, anchor, reason: 'renamed-symbol-id' };
  }

  const content = source.readFile(anchor.file);
  if (content === undefined) return { status: 'stale', level: 0, file: null, anchor, reason: 'file-missing' };

  // Content evidence is read from the current file, so it stays trustworthy
  // even when the symbol table is stale.
  if (anchor.contentFragment && anchor.contentFragmentHash) {
    if (sha256(anchor.contentFragment) === anchor.contentFragmentHash && content.includes(anchor.contentFragment)) {
      return { status: 'relocated', level: 3, file: anchor.file, anchor, reason: 'fragment-match' };
    }
  }
  if (anchor.contentFragmentHash && sha256(content) === anchor.contentFragmentHash) {
    return { status: 'relocated', level: 3, file: anchor.file, anchor, reason: 'file-hash-match' };
  }

  if (!symbolTableFresh && (anchor.symbolId || anchor.qualifiedName)) {
    return { status: 'stale', level: 0, file: anchor.file, anchor, reason: 'stale-symbol-table' };
  }
  if (!anchor.symbolId && !anchor.qualifiedName && !anchor.contentFragmentHash) {
    return { status: 'stale', level: 0, file: anchor.file, anchor, reason: 'insufficient-anchor-evidence' };
  }
  return { status: 'stale', level: 0, file: anchor.file, anchor, reason: 'relocation-failed' };
}

/** Build a source from a structure snapshot plus a project-relative file reader. */
export function anchorSourceFromGraph(
  snapshot: Pick<GraphSnapshot, 'symbols'>,
  readFile: (file: string) => string | undefined,
  symbolFreshness?: AnchorSymbolFreshness,
): AnchorSource {
  const byId = new Map<string, AnchorSymbol>();
  const byNameAndFile = new Map<string, AnchorSymbol>();
  for (const symbol of snapshot.symbols) {
    const entry: AnchorSymbol = { id: symbol.id, file: symbol.file, name: symbol.name, qualifiedName: symbol.qualifiedName };
    byId.set(entry.id, entry);
    byNameAndFile.set(`${entry.file}\0${entry.qualifiedName}`, entry);
  }
  return {
    findSymbolById: (id) => byId.get(id),
    findSymbolByQualifiedName: (qualifiedName, file) => byNameAndFile.get(`${file}\0${qualifiedName}`),
    readFile,
    ...(symbolFreshness === undefined ? {} : { symbolFreshness }),
  };
}

/** File-system adapter for local briefs; reads only project-relative paths. */
export function anchorSourceFromFileSystem(root: string, symbols: readonly AnchorSymbol[] = [], symbolFreshness?: AnchorSymbolFreshness): AnchorSource {
  const byId = new Map(symbols.map((symbol) => [symbol.id, symbol]));
  const byNameAndFile = new Map(symbols.map((symbol) => [`${symbol.file}\0${symbol.qualifiedName}`, symbol]));
  return {
    findSymbolById: (id) => byId.get(id),
    findSymbolByQualifiedName: (qualifiedName, file) => byNameAndFile.get(`${file}\0${qualifiedName}`),
    readFile: (file) => {
      try { return readFileSync(join(root, file), 'utf8'); } catch { return undefined; }
    },
    ...(symbolFreshness === undefined ? {} : { symbolFreshness }),
  };
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
