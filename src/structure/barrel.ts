import type { EdgeProvenance } from './types.ts';
import { resolveSpecifier, type ResolutionContext } from './imports.ts';
import type { ParsedFile, SymbolKind } from './extractors/ts.ts';

export const MAX_BARREL_DEPTH = 12;

export type BarrelLabel = 'barrel_wildcard' | 'depth_limit';

export interface ExportResolution {
  /** Definition file reached through the barrel chain. */
  file: string;
  kind: SymbolKind;
  provenance: Extract<EdgeProvenance, 'resolved' | 'heuristic'>;
  label?: BarrelLabel;
  typeOnly: boolean;
  /** Local declaration name at `file`, after following aliases/barrels. */
  localName?: string;
}

type Lookup = { found: ExportResolution } | { limit: 'cycle' | 'depth'; file: string } | undefined;

interface WalkState {
  modules: Map<string, ParsedFile>;
  context: ResolutionContext;
  visited: Set<string>;
  depth: number;
  viaWildcard: boolean;
}

function resolvedPath(context: ResolutionContext, from: string, specifier: string): string | undefined {
  const resolution = resolveSpecifier(context, from, specifier);
  return resolution.status === 'resolved' || resolution.status === 'heuristic' ? resolution.path : undefined;
}

function withTypeOnly(resolution: ExportResolution, typeOnly: boolean): ExportResolution {
  if (!typeOnly || resolution.typeOnly) return resolution;
  return { ...resolution, typeOnly: true, kind: 'type' };
}

function lookup(state: WalkState, moduleFile: string, name: string): Lookup {
  if (state.depth > MAX_BARREL_DEPTH) return { limit: 'depth', file: moduleFile };
  if (state.visited.has(moduleFile)) return { limit: 'cycle', file: moduleFile };
  const module = state.modules.get(moduleFile);
  if (!module) return undefined;
  const visited = new Set(state.visited);
  visited.add(moduleFile);
  const next = (file: string, viaWildcard: boolean): WalkState => ({
    modules: state.modules,
    context: state.context,
    visited,
    depth: state.depth + 1,
    viaWildcard,
  });
  const explicit = module.namedExports.find((entry) => entry.exportName === name && !entry.wildcard);
  if (explicit) {
    if (explicit.namespace) {
      if (!explicit.from) return undefined;
      const target = resolvedPath(state.context, moduleFile, explicit.from);
      if (!target) return undefined;
      return {
        found: {
          file: target,
          kind: 'value',
          provenance: 'heuristic',
          label: 'barrel_wildcard',
          typeOnly: explicit.typeOnly,
        },
      };
    }
    if (explicit.from) {
      const target = resolvedPath(state.context, moduleFile, explicit.from);
      if (!target) return undefined;
      const result = lookup(next(target, state.viaWildcard), target, explicit.importedName ?? name);
      if (!result) return undefined;
      if ('limit' in result) return result;
      return { found: withTypeOnly(result.found, explicit.typeOnly) };
    }
    if (explicit.localName) {
      const definition = module.definitions.find((candidate) => candidate.name === explicit.localName);
      // A local export with no matching definition cannot be confirmed; report it as
      // unresolved (the caller turns this into a visible unknown edge).
      if (!definition) return undefined;
      return {
        found: {
          file: moduleFile,
          // The export entry records this declaration's kind, which is more precise
          // than the merged definition map (interface + const stays value).
          kind: explicit.kind,
          provenance: state.viaWildcard ? 'heuristic' : 'resolved',
          ...(state.viaWildcard ? { label: 'barrel_wildcard' as const } : {}),
          typeOnly: explicit.typeOnly,
          localName: explicit.localName,
        },
      };
    }
    return undefined;
  }
  let limit: { limit: 'cycle' | 'depth'; file: string } | undefined;
  for (const wildcard of module.namedExports.filter((entry) => entry.wildcard && entry.from)) {
    const target = resolvedPath(state.context, moduleFile, wildcard.from as string);
    if (!target) continue;
    const result = lookup(next(target, true), target, name);
    if (result && 'found' in result) {
      const found = withTypeOnly(result.found, wildcard.typeOnly);
      return { found: { ...found, provenance: 'heuristic', label: 'barrel_wildcard' } };
    }
    if (result && 'limit' in result) limit = result;
  }
  return limit;
}

/**
 * Follows named re-exports (and wildcard re-exports as heuristics) from `moduleFile`
 * until the file that actually declares `name` is found.
 */
export function resolveExportedName(
  modules: Map<string, ParsedFile>,
  context: ResolutionContext,
  moduleFile: string,
  name: string,
): ExportResolution | undefined {
  const result = lookup({ modules, context, visited: new Set(), depth: 0, viaWildcard: false }, moduleFile, name);
  if (!result) return undefined;
  if ('found' in result) return result.found;
  return { file: result.file, kind: 'value', provenance: 'heuristic', label: 'depth_limit', typeOnly: false };
}

export interface WildcardTarget {
  file: string;
  typeOnly: boolean;
}

/** Resolves every `export * from` target of a module, retaining source order. */
export function wildcardTargets(modules: Map<string, ParsedFile>, context: ResolutionContext, moduleFile: string): WildcardTarget[] {
  const module = modules.get(moduleFile);
  if (!module) return [];
  const targets: WildcardTarget[] = [];
  for (const entry of module.namedExports) {
    if (!entry.wildcard || !entry.from) continue;
    const target = resolvedPath(context, moduleFile, entry.from);
    if (target) targets.push({ file: target, typeOnly: entry.typeOnly });
  }
  return targets;
}
