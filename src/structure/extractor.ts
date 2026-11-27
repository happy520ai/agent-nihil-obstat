import { createHash } from 'node:crypto';
import { readFile as readFileFromDisk } from 'node:fs/promises';
import { join } from 'node:path';
import type { SourceFingerprint } from '../core/fingerprint.ts';
import { emptyCaveats, STRUCTURE_UNSUPPORTED_INPUT, type CallEdge, type CallLabel, type CallProvenance, type CaveatSemanticGap, type EdgeKind, type EdgeProvenance, type GraphCaveats, type GraphEdge, type GraphSnapshot, type SourceFile, type SymbolNode } from './types.ts';
import { caveatEvidenceFromParsed, createTsExtractor, SUPPORTED_EXTENSIONS, type LocalCall, type LocalDefinition, type LocalMember, type ParsedFile, type TsExtractor } from './extractors/ts.ts';
import { createPythonExtractor, PYTHON_EXTENSIONS, type PythonExtractor, type PythonParsedFile } from './extractors/python.ts';

/** Consumed by structure analysis (T-113/T-115/T-116) to classify CJS export symbols. */
export type { CommonjsExportItem } from './extractors/ts.ts';
import { createResolutionContext, resolveSpecifier, type ResolutionContext } from './imports.ts';
import { buildPythonImportEdges, createPythonResolutionContext, pythonModuleName } from './imports-python.ts';
import { resolveExportedName, wildcardTargets } from './barrel.ts';

export type EdgeLabel = NonNullable<GraphEdge['label']>;

/**
 * Bump when extraction semantics change so unchanged files cannot reuse old
 * parses. `p4-caveats-v1` added `ParsedFile.blindSpots`/`scope.semanticGaps`
 * evidence; `p5-python-l1-v1` adds the opt-in Python L0/L1 dispatch and splits
 * the parse cache by the structure flag, so a TS-only build never reuses a
 * Python-enabled parse (and vice versa).
 */
export const EXTRACTOR_VERSION = 'p5-python-l1-v1';

/** Parse-cache version suffix for builds that opted into Python structure. */
export const EXTRACTOR_VERSION_PYTHON = `${EXTRACTOR_VERSION}+python`;

/**
 * ADR-014 §5.5: Python structure stays closed until PY-12 flips it after the
 * two-level support gate. `buildSnapshot` accepts an explicit input override
 * only as a test seam; production callers never enable it here.
 */
export const ENABLE_PYTHON_STRUCTURE = false;

/**
 * Single source of truth for structure-supported extensions. The immutable
 * TS-only baseline is always available to the test seam; the public default
 * follows `ENABLE_PYTHON_STRUCTURE`, so hooks and freshness checks cannot drift
 * from the builder when the flag is opened (ADR-014 §5.5/§7).
 */
export const TS_STRUCTURE_EXTENSIONS: readonly string[] = Object.freeze([...SUPPORTED_EXTENSIONS]);

const PYTHON_STRUCTURE_EXTENSIONS: readonly string[] = Object.freeze([...PYTHON_EXTENSIONS]);
const PYTHON_ENABLED_EXTENSIONS: readonly string[] = Object.freeze([...TS_STRUCTURE_EXTENSIONS, ...PYTHON_STRUCTURE_EXTENSIONS]);

export const SUPPORTED_STRUCTURE_EXTENSIONS: readonly string[] = ENABLE_PYTHON_STRUCTURE
  ? PYTHON_ENABLED_EXTENSIONS
  : TS_STRUCTURE_EXTENSIONS;

/**
 * Extensions the structure builder may parse. The no-argument form follows the
 * build-time flag and returns the public default list by identity; passing
 * `false` is the only way to request the frozen TS-only baseline.
 */
export function supportedStructureExtensions(enabled: boolean = ENABLE_PYTHON_STRUCTURE): readonly string[] {
  return enabled ? PYTHON_ENABLED_EXTENSIONS : TS_STRUCTURE_EXTENSIONS;
}

export interface BuildReport {
  /** `incremental` means every unchanged file was served from the content-hash cache. */
  mode: 'full' | 'incremental';
  files: number;
  parsed: number;
  /** Files served from the persisted content-hash parse cache without reparsing. */
  reused: number;
  /** Files whose previous snapshot data was retained because reading/parsing failed. */
  retained: number;
  degraded: boolean;
  /**
   * Files whose nested-scope extraction captured no declaration at all
   * (`zero-symbol` candidates). Optional for compatibility with older callers.
   */
  zeroDeclarationFiles?: number;
  /**
   * Files with captured declarations but no static dependency
   * (`zero-edge`/`dynamic-only` candidates). Optional for compatibility.
   */
  zeroStaticDependencyFiles?: number;
}

export interface ParsedCacheEntry { hash: string; version?: string; parsed: ParsedFile }
export type ParsedCache = Record<string, ParsedCacheEntry>;

export interface BuildSnapshotInput {
  root: string;
  fingerprint: SourceFingerprint;
  previous?: GraphSnapshot;
  /**
   * Content-hash keyed parse cache. A file is only served from it when both the
   * previous snapshot hash and the cache hash equal the fingerprint hash.
   */
  parsedCache?: ParsedCache;
  wasmDirectory?: string;
  /** Test seam for read-failure degradation; defaults to node:fs/promises readFile. */
  readFile?: (absolutePath: string) => Promise<string>;
  /**
   * Test seam only: exercise Python L0/L1 fixtures with an explicit opt-in.
   * Production calls omit it, so `ENABLE_PYTHON_STRUCTURE` stays false.
   */
  enablePythonStructure?: boolean;
}

export interface BuildSnapshotOutput {
  snapshot: GraphSnapshot;
  report: BuildReport;
  /** Successfully parsed/cached modules to persist for the next incremental build. */
  parsedFiles: ParsedCache;
}

interface EdgeAccumulator {
  from: string;
  to: string;
  kind: EdgeKind;
  provenance: EdgeProvenance;
  label?: EdgeLabel;
  names: Set<string>;
}

function sha256(...parts: string[]): string {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part).update('\0');
  return hash.digest('hex');
}

export function symbolId(file: string, kind: string, name: string, qualifiedName: string): string {
  return sha256(file, kind, name, qualifiedName);
}

function errorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'UNKNOWN';
}

function isSupported(path: string, extensions: readonly string[]): boolean {
  return extensions.some((extension) => path.endsWith(extension));
}

function isPythonPath(path: string): boolean {
  return PYTHON_EXTENSIONS.some((extension) => path.endsWith(extension));
}

function isPythonParsedFile(parsed: ParsedFile): parsed is PythonParsedFile {
  return (parsed as { language?: unknown }).language === 'python';
}

function edgeKey(edge: Pick<GraphEdge, 'from' | 'to' | 'kind' | 'provenance' | 'label'>): string {
  return `${edge.from}\0${edge.to}\0${edge.kind}\0${edge.provenance}\0${edge.label ?? ''}`;
}

class EdgeSet {
  private readonly map = new Map<string, EdgeAccumulator>();

  add(from: string, to: string, kind: EdgeKind, provenance: EdgeProvenance, names: Iterable<string> = [], label?: EdgeLabel): void {
    const key = edgeKey({ from, to, kind, provenance, ...(label !== undefined ? { label } : {}) });
    let entry = this.map.get(key);
    if (!entry) {
      entry = { from, to, kind, provenance, ...(label !== undefined ? { label } : {}), names: new Set() };
      this.map.set(key, entry);
    }
    for (const name of names) entry.names.add(name);
  }

  values(): GraphEdge[] {
    return [...this.map.values()]
      .map((entry) => ({
        from: entry.from,
        to: entry.to,
        kind: entry.kind,
        provenance: entry.provenance,
        importedNames: [...entry.names].sort(),
        ...(entry.label !== undefined ? { label: entry.label } : {}),
      }))
      .sort((a, b) => Buffer.from(`${a.from}\0${a.to}\0${a.kind}\0${a.provenance}\0${a.label ?? ''}`)
        .compare(Buffer.from(`${b.from}\0${b.to}\0${b.kind}\0${b.provenance}\0${b.label ?? ''}`)));
  }
}

function callKey(edge: CallEdge): string {
  return [
    edge.from,
    edge.to,
    edge.callerSymbolId ?? '',
    edge.calleeSymbolId ?? '',
    edge.callee,
    edge.calleeQualifiedName ?? '',
    edge.provenance,
    edge.label,
    String(edge.line),
  ].join('\0');
}

class CallEdgeSet {
  private readonly map = new Map<string, CallEdge>();

  add(edge: CallEdge): void {
    const key = callKey(edge);
    if (!this.map.has(key)) this.map.set(key, edge);
  }

  values(): CallEdge[] {
    return [...this.map.values()].sort((a, b) => Buffer.from(callKey(a)).compare(Buffer.from(callKey(b))));
  }
}

function addImportEdges(
  edges: EdgeSet,
  parsed: ParsedFile,
  context: ResolutionContext,
  modules: Map<string, ParsedFile>,
  unresolvedDynamicByFile: Map<string, number>,
): void {
  const from = parsed.file;
  for (const entry of parsed.imports) {
    if (entry.dynamic || entry.require) {
      if (!entry.literal || entry.specifier === undefined) {
        unresolvedDynamicByFile.set(from, (unresolvedDynamicByFile.get(from) ?? 0) + 1);
        edges.add(from, '<dynamic>', 'unknown', 'parsed', [], entry.dynamic ? 'dynamic_import' : 'unresolved');
        continue;
      }
      const resolution = resolveSpecifier(context, from, entry.specifier);
      if (resolution.status === 'external') {
        edges.add(from, entry.specifier, 'unknown', 'parsed', [], 'dynamic_import');
        continue;
      }
      if (resolution.status === 'unresolved' || !resolution.path) {
        unresolvedDynamicByFile.set(from, (unresolvedDynamicByFile.get(from) ?? 0) + 1);
        edges.add(from, entry.specifier, 'unknown', 'parsed', [], 'unresolved');
        continue;
      }
      // A literal CommonJS `require('./x')` that resolved statically loads the
      // whole target module, so it is a confirmed dependency fact (ADR-010 §5.1)
      // and belongs in the direct/transitive main caliber. Dynamic `import()`
      // and heuristic resolutions stay advisory (`unknown`/`heuristic`).
      if (entry.require && entry.literal && resolution.status === 'resolved') {
        edges.add(from, resolution.path, 'value-confirmed', 'resolved', [], 'require');
        continue;
      }
      edges.add(from, resolution.path, 'unknown', 'heuristic', [], 'dynamic_import');
      continue;
    }
    if (entry.specifier === undefined) {
      edges.add(from, '<dynamic>', 'unknown', 'parsed', entry.importedNames, 'unresolved');
      continue;
    }
    const resolution = resolveSpecifier(context, from, entry.specifier);
    if (resolution.status === 'external') {
      edges.add(from, entry.specifier, 'unknown', 'parsed', entry.importedNames, 'unresolved');
      continue;
    }
    if (resolution.status === 'unresolved' || !resolution.path) {
      edges.add(from, entry.specifier, 'unknown', 'parsed', entry.importedNames, 'unresolved');
      continue;
    }
    const baseProvenance: EdgeProvenance = resolution.status === 'heuristic' ? 'heuristic' : 'resolved';
    if (entry.sideEffect) {
      edges.add(from, resolution.path, 'value-confirmed', baseProvenance, [], 'sideEffect');
      continue;
    }
    for (const name of entry.importedNames) {
      const declaredTypeOnly = entry.typeOnly || entry.typeOnlyNames.includes(name);
      if (name === '*') {
        // `import * as ns` loads the module but tells us nothing about which names are
        // used, so it must never claim value-confirmed coverage for the target file.
        if (declaredTypeOnly) edges.add(from, resolution.path, 'type-only', baseProvenance, ['*']);
        else edges.add(from, resolution.path, 'unknown', baseProvenance, ['*'], 'namespace_import');
        continue;
      }
      const found = resolveExportedName(modules, context, resolution.path, name);
      if (!found) {
        edges.add(from, resolution.path, 'unknown', baseProvenance, [name], 'unresolved');
        continue;
      }
      const kind: EdgeKind = declaredTypeOnly || found.typeOnly ? 'type-only' : found.provenance === 'heuristic' ? 'unknown' : 'value-confirmed';
      const provenance: EdgeProvenance = found.provenance === 'heuristic' || baseProvenance === 'heuristic' ? 'heuristic' : 'resolved';
      edges.add(from, found.file, kind, provenance, [name], found.label);
    }
  }
}

function addReexportEdges(edges: EdgeSet, parsed: ParsedFile, context: ResolutionContext, modules: Map<string, ParsedFile>): void {
  const from = parsed.file;
  for (const target of wildcardTargets(modules, context, from)) {
    edges.add(from, target.file, 'unknown', 'heuristic', [], 'barrel_wildcard');
  }
  for (const entry of parsed.namedExports) {
    if (entry.wildcard) {
      if (!entry.from) continue;
      const resolution = resolveSpecifier(context, from, entry.from);
      // Wildcards never traverse; an external or unresolvable target still has to be
      // visible in the graph instead of silently disappearing.
      if (resolution.status === 'unresolved' || resolution.status === 'external') {
        edges.add(from, entry.from, 'unknown', 'parsed', [], 'unresolved');
      }
      continue;
    }
    if (!entry.from) continue;
    const resolution = resolveSpecifier(context, from, entry.from);
    if (resolution.status === 'external') {
      edges.add(from, entry.from, 'unknown', 'parsed', [entry.importedName ?? entry.exportName], 'unresolved');
      continue;
    }
    if (resolution.status === 'unresolved' || !resolution.path) {
      edges.add(from, entry.from, 'unknown', 'parsed', [entry.importedName ?? entry.exportName], 'unresolved');
      continue;
    }
    if (entry.namespace) {
      edges.add(from, resolution.path, 'unknown', 'heuristic', ['*'], 'barrel_wildcard');
      continue;
    }
    const importedName = entry.importedName ?? entry.exportName;
    const found = resolveExportedName(modules, context, resolution.path, importedName);
    if (!found) {
      edges.add(from, resolution.path, 'unknown', 'parsed', [importedName], 'unresolved');
      continue;
    }
    const heuristic = found.provenance === 'heuristic' || resolution.status === 'heuristic';
    const kind: EdgeKind = entry.typeOnly || found.typeOnly ? 'type-only' : heuristic ? 'unknown' : 'value-confirmed';
    const provenance: EdgeProvenance = heuristic ? 'heuristic' : 'resolved';
    edges.add(from, found.file, kind, provenance, [importedName], found.label);
  }
}

interface ImportBindingInfo { specifier: string; importedName: string; typeOnly: boolean; namespace: boolean }

function importBindings(parsed: ParsedFile): Map<string, ImportBindingInfo> {
  const bindings = new Map<string, ImportBindingInfo>();
  for (const entry of parsed.imports) {
    if (entry.specifier === undefined) continue;
    for (let index = 0; index < entry.localNames.length; index += 1) {
      const local = entry.localNames[index];
      if (local === undefined || local === '*') continue;
      const importedName = entry.importedNames[index] ?? local;
      bindings.set(local, {
        specifier: entry.specifier,
        importedName,
        typeOnly: entry.typeOnly || entry.typeOnlyNames.includes(importedName),
        namespace: importedName === '*',
      });
    }
  }
  return bindings;
}

interface ModuleIndex {
  definitionsByName: Map<string, LocalDefinition>;
  definitionsByQualified: Map<string, LocalDefinition>;
  membersByName: Map<string, LocalMember[]>;
  membersByQualified: Map<string, LocalMember>;
}

function indexModule(parsed: ParsedFile): ModuleIndex {
  const index: ModuleIndex = {
    definitionsByName: new Map(),
    definitionsByQualified: new Map(),
    membersByName: new Map(),
    membersByQualified: new Map(),
  };
  for (const definition of parsed.definitions) {
    if (!index.definitionsByName.has(definition.name)) index.definitionsByName.set(definition.name, definition);
    index.definitionsByQualified.set(definition.qualifiedName, definition);
  }
  for (const member of parsed.members ?? []) {
    const members = index.membersByName.get(member.name) ?? [];
    members.push(member);
    index.membersByName.set(member.name, members);
    index.membersByQualified.set(member.qualifiedName, member);
  }
  return index;
}

interface ResolvedSymbol {
  file: string;
  symbolId: string;
  name: string;
  qualifiedName: string;
}

interface CallTarget {
  file: string;
  symbol: ResolvedSymbol;
  provenance: CallProvenance;
  label: CallLabel;
}

interface CallStats { typeOnly: number; unresolved: number }

function symbolForDefinition(file: string, definition: LocalDefinition): ResolvedSymbol {
  return {
    file,
    symbolId: symbolId(file, definition.kind, definition.name, definition.qualifiedName),
    name: definition.name,
    qualifiedName: definition.qualifiedName,
  };
}

function symbolForMember(file: string, member: LocalMember): ResolvedSymbol {
  return {
    file,
    symbolId: symbolId(file, 'value', member.name, member.qualifiedName),
    name: member.name,
    qualifiedName: member.qualifiedName,
  };
}

/** Projects every parse product that becomes a graph symbol, CJS exports included. */
function pushParsedSymbols(symbols: SymbolNode[], file: string, parsed: ParsedFile): void {
  for (const definition of parsed.definitions) {
    symbols.push({
      id: symbolId(file, definition.kind, definition.name, definition.qualifiedName),
      file,
      name: definition.name,
      qualifiedName: definition.qualifiedName,
      symbolKind: definition.kind,
      startLine: definition.startLine,
    });
  }
  for (const member of parsed.members ?? []) {
    symbols.push({
      id: symbolId(file, 'value', member.name, member.qualifiedName),
      file,
      name: member.name,
      qualifiedName: member.qualifiedName,
      symbolKind: 'value',
      startLine: member.startLine,
    });
  }
  for (const item of parsed.commonjsExports ?? []) {
    symbols.push({
      id: symbolId(file, 'value', item.name, item.qualifiedName),
      file,
      name: item.name,
      qualifiedName: item.qualifiedName,
      symbolKind: 'value',
      startLine: item.startLine,
      role: item.role,
      source: item.source,
      confidence: item.confidence,
      fieldKind: item.fieldKind,
      executable: item.executable,
      ...(item.metadata !== undefined ? { metadata: item.metadata } : {}),
      ...(item.metadataFields !== undefined ? { metadataFields: item.metadataFields } : {}),
    });
  }
}

/**
 * Python L1 symbols carry their module name (ADR-014 §5.1): a class method in
 * `src/pkg/mod.py` is `pkg.mod:Class.method`. The parse object itself stays
 * untouched because the Python resolver consumes its local qualified names.
 */
function pushPythonSymbols(symbols: SymbolNode[], file: string, parsed: PythonParsedFile, moduleName: string): void {
  // ADR-014 §5.1 lists the module itself as an L1 symbol. The parser already
  // records its metadata; this projects it without inventing a fake definition.
  symbols.push({
    id: symbolId(file, 'value', parsed.module.name, moduleName),
    file,
    name: parsed.module.name,
    qualifiedName: moduleName,
    symbolKind: 'value',
    startLine: 1,
  });
  for (const definition of parsed.definitions) {
    const qualifiedName = `${moduleName}:${definition.qualifiedName}`;
    symbols.push({
      id: symbolId(file, definition.kind, definition.name, qualifiedName),
      file,
      name: definition.name,
      qualifiedName,
      symbolKind: definition.kind,
      startLine: definition.startLine,
    });
  }
}

/** Append resolver caveats without disturbing the existing TS evidence order. */
function mergeSemanticGaps(base: CaveatSemanticGap[], extra: readonly CaveatSemanticGap[]): CaveatSemanticGap[] {
  if (extra.length === 0) return base;
  const key = (gap: CaveatSemanticGap): string => `${gap.file}\0${gap.line}\0${gap.pattern}\0${gap.reason}`;
  const seen = new Set(base.map(key));
  const merged = [...base];
  for (const gap of extra) {
    const identity = key(gap);
    if (seen.has(identity)) continue;
    seen.add(identity);
    merged.push(gap);
  }
  return merged;
}

function localCaller(parsed: ParsedFile, call: LocalCall, index: ModuleIndex): { id?: string; qualifiedName?: string; index: ModuleIndex } {
  if (call.callerQualifiedName === undefined) return { index };
  const definition = index.definitionsByQualified.get(call.callerQualifiedName)
    ?? index.membersByQualified.get(call.callerQualifiedName);
  if (!definition) return { qualifiedName: call.callerQualifiedName, index };
  return {
    id: symbolId(parsed.file, definition.kind, definition.name, definition.qualifiedName),
    qualifiedName: definition.qualifiedName,
    index,
  };
}

/**
 * Resolves L2 call sites against same-file definitions and explicit imports only.
 * Namespace members, `this.method()`, imported class members and `new Class()`
 * bindings are resolved when a matching definition exists. Anything else stays
 * out of the call graph (or is recorded as heuristic when ambiguous).
 */
function addCallEdges(
  calls: CallEdgeSet,
  parsed: ParsedFile,
  context: ResolutionContext,
  modules: Map<string, ParsedFile>,
  indexes: Map<string, ModuleIndex>,
  stats: CallStats,
): void {
  const from = parsed.file;
  const bindings = importBindings(parsed);
  const localIndex = indexes.get(from) ?? indexModule(parsed);
  const instances = new Map((parsed.instances ?? []).map((instance) => [instance.name, instance.className]));

  const targetFromFileExport = (targetFile: string, exportName: string, classMember?: string): CallTarget | 'type' | undefined => {
    const found = resolveExportedName(modules, context, targetFile, exportName);
    if (!found) return undefined;
    if (found.typeOnly || found.kind === 'type') return 'type';
    const targetIndex = indexes.get(found.file);
    if (!targetIndex) return undefined;
    const localName = found.localName ?? exportName;
    if (classMember !== undefined) {
      const member = targetIndex.membersByQualified.get(`${localName}.${classMember}`)
        ?? targetIndex.membersByName.get(classMember)?.find((candidate) => candidate.qualifiedName.startsWith(`${localName}.`));
      if (!member) return undefined;
      return {
        file: found.file,
        symbol: symbolForMember(found.file, member),
        provenance: found.provenance === 'heuristic' ? 'heuristic' : 'resolved',
        label: found.provenance === 'heuristic' ? 'barrel_wildcard' : 'member',
      };
    }
    const definition = targetIndex.definitionsByQualified.get(localName)
      ?? targetIndex.definitionsByName.get(localName);
    if (definition) {
      if (definition.kind === 'type') return 'type';
      return {
        file: found.file,
        symbol: symbolForDefinition(found.file, definition),
        provenance: found.provenance === 'heuristic' ? 'heuristic' : 'resolved',
        label: found.provenance === 'heuristic' ? 'barrel_wildcard' : 'imported',
      };
    }
    return undefined;
  };

  const targetFromLocal = (localName: string, classMember?: string): CallTarget | 'type' | undefined => {
    if (classMember !== undefined) {
      const member = localIndex.membersByQualified.get(`${localName}.${classMember}`);
      if (member) return { file: from, symbol: symbolForMember(from, member), provenance: 'resolved', label: 'member' };
      return undefined;
    }
    const definition = localIndex.definitionsByQualified.get(localName) ?? localIndex.definitionsByName.get(localName);
    if (!definition) return undefined;
    if (definition.kind === 'type') return 'type';
    return { file: from, symbol: symbolForDefinition(from, definition), provenance: 'resolved', label: 'local' };
  };

  const addTarget = (call: LocalCall, target: CallTarget, caller: { id?: string; qualifiedName?: string }): void => {
    calls.add({
      from,
      to: target.file,
      callee: call.callee,
      line: call.line,
      provenance: target.provenance,
      label: target.label,
      ...(caller.id !== undefined ? { callerSymbolId: caller.id } : {}),
      ...(caller.qualifiedName !== undefined ? { callerQualifiedName: caller.qualifiedName } : {}),
      calleeSymbolId: target.symbol.symbolId,
      calleeQualifiedName: target.symbol.qualifiedName,
    });
  };

  for (const call of parsed.calls ?? []) {
    const caller = localCaller(parsed, call, localIndex);
    if (call.kind === 'name' || call.kind === 'new') {
      const local = targetFromLocal(call.callee);
      if (local === 'type') { stats.typeOnly += 1; continue; }
      if (local) { addTarget(call, local, caller); continue; }
      const binding = bindings.get(call.callee);
      if (!binding) { stats.unresolved += 1; continue; }
      if (binding.typeOnly) { stats.typeOnly += 1; continue; }
      const resolution = resolveSpecifier(context, from, binding.specifier);
      if (resolution.status === 'external' || resolution.status === 'unresolved' || !resolution.path) {
        stats.unresolved += 1;
        continue;
      }
      const target = binding.namespace
        ? call.kind === 'new' ? targetFromFileExport(resolution.path, call.callee) : undefined
        : targetFromFileExport(resolution.path, binding.importedName);
      if (target === 'type') { stats.typeOnly += 1; continue; }
      if (!target) { stats.unresolved += 1; continue; }
      const provenance: CallProvenance = resolution.status === 'heuristic' || target.provenance === 'heuristic' ? 'heuristic' : 'resolved';
      addTarget(call, { ...target, provenance, ...(binding.namespace ? { label: provenance === 'heuristic' ? 'barrel_wildcard' : 'namespace' as const } : {}) }, caller);
      continue;
    }

    const receiver = call.receiver;
    if (receiver === undefined) { stats.unresolved += 1; continue; }
    if (receiver === 'this') {
      const classQualified = call.callerClassName;
      if (classQualified === undefined) { stats.unresolved += 1; continue; }
      const member = caller.index.membersByQualified.get(`${classQualified}.${call.callee}`);
      if (!member) { stats.unresolved += 1; continue; }
      addTarget(call, { file: from, symbol: symbolForMember(from, member), provenance: 'resolved', label: 'this' }, caller);
      continue;
    }
    if (receiver === 'super') { stats.unresolved += 1; continue; }

    const binding = bindings.get(receiver);
    if (binding) {
      if (binding.typeOnly) { stats.typeOnly += 1; continue; }
      const resolution = resolveSpecifier(context, from, binding.specifier);
      if (resolution.status === 'external' || resolution.status === 'unresolved' || !resolution.path) {
        stats.unresolved += 1;
        continue;
      }
      if (binding.namespace) {
        const target = targetFromFileExport(resolution.path, call.callee);
        if (target === 'type') { stats.typeOnly += 1; continue; }
        if (!target) { stats.unresolved += 1; continue; }
        const provenance: CallProvenance = resolution.status === 'heuristic' || target.provenance === 'heuristic' ? 'heuristic' : 'resolved';
        addTarget(call, { ...target, provenance, label: provenance === 'heuristic' ? 'barrel_wildcard' : 'namespace' }, caller);
        continue;
      }
      const target = targetFromFileExport(resolution.path, binding.importedName, call.callee);
      if (target === 'type') { stats.typeOnly += 1; continue; }
      if (!target) { stats.unresolved += 1; continue; }
      const provenance: CallProvenance = resolution.status === 'heuristic' || target.provenance === 'heuristic' ? 'heuristic' : 'resolved';
      addTarget(call, { ...target, provenance }, caller);
      continue;
    }

    const localClass = targetFromLocal(receiver, call.callee);
    if (localClass === 'type') { stats.typeOnly += 1; continue; }
    if (localClass) { addTarget(call, localClass, caller); continue; }

    const instanceClass = instances.get(receiver);
    if (instanceClass !== undefined) {
      const local = targetFromLocal(instanceClass, call.callee);
      if (local === 'type') { stats.typeOnly += 1; continue; }
      if (local) { addTarget(call, { ...local, label: 'instance' }, caller); continue; }
      const [head, ...tail] = instanceClass.split('.');
      const instanceBinding = head !== undefined ? bindings.get(head) : undefined;
      const importedClass = instanceBinding === undefined
        ? undefined
        : tail.length === 0 ? instanceBinding.importedName : instanceBinding.namespace && tail.length === 1 ? tail[0] : undefined;
      if (instanceBinding && importedClass !== undefined) {
        const resolution = resolveSpecifier(context, from, instanceBinding.specifier);
        if (resolution.status === 'resolved' || resolution.status === 'heuristic') {
          const target = targetFromFileExport(resolution.path!, importedClass, call.callee);
          if (target === 'type') { stats.typeOnly += 1; continue; }
          if (target) {
            const provenance: CallProvenance = resolution.status === 'heuristic' || target.provenance === 'heuristic' ? 'heuristic' : 'resolved';
            addTarget(call, { ...target, provenance, label: 'instance' }, caller);
            continue;
          }
        }
      }
    }

    // Last resort: exactly one same-file member with this name is weak evidence,
    // so it stays heuristic and can never satisfy T2.
    const sameName = caller.index.membersByName.get(call.callee);
    if (sameName && sameName.length === 1) {
      const member = sameName[0]!;
      addTarget(call, { file: from, symbol: symbolForMember(from, member), provenance: 'heuristic', label: 'member' }, caller);
      continue;
    }
    stats.unresolved += 1;
  }
}

function retainedData(previous: GraphSnapshot, file: string, edges: GraphEdge[], calls: CallEdge[]): { file?: SourceFile; symbols: SymbolNode[]; edges: GraphEdge[]; calls: CallEdge[] } {
  const previousFile = previous.files[file];
  return {
    ...(previousFile ? { file: previousFile } : {}),
    symbols: previous.symbols.filter((symbol) => symbol.file === file),
    edges: edges.filter((edge) => edge.from === file),
    calls: calls.filter((edge) => edge.from === file),
  };
}

export async function buildSnapshot(input: BuildSnapshotInput): Promise<BuildSnapshotOutput> {
  const readFile = input.readFile ?? ((path: string) => readFileFromDisk(path, 'utf8'));
  const previous: GraphSnapshot = input.previous ?? {
    revision: '',
    sourceFingerprint: '',
    files: {},
    symbols: [],
    edges: [],
    caveats: emptyCaveats(),
    calls: [],
  };
  const previousCalls = previous.calls ?? [];
  const parsedCache = input.parsedCache ?? {};
  const pythonEnabled = input.enablePythonStructure ?? ENABLE_PYTHON_STRUCTURE;
  const cacheVersion = pythonEnabled ? EXTRACTOR_VERSION_PYTHON : EXTRACTOR_VERSION;
  const supportedExtensions = supportedStructureExtensions(pythonEnabled);
  const sourceFiles = input.fingerprint.files.filter((file) => isSupported(file.path, supportedExtensions));
  // A readdir failure at the root is reported as '.', which must retain *every*
  // previous file; sub-directory failures retain that subtree.
  const degradedDirectories = input.fingerprint.degraded.map((entry) => entry.path);
  const files: Record<string, SourceFile> = {};
  const symbols: SymbolNode[] = [];
  const retainedEdges: GraphEdge[] = [];
  const retainedCalls: CallEdge[] = [];
  const parsedFiles: ParsedCache = {};
  const extractor = await createTsExtractor(input.wasmDirectory !== undefined ? { wasmDirectory: input.wasmDirectory } : {});
  const degradedReasons: string[] = input.fingerprint.degraded.map((entry) => `fingerprint-degraded:${entry.path}:${entry.code}`);
  const parsedModules = new Map<string, ParsedFile>();
  const unresolvedDynamicByFile = new Map<string, number>();
  // Python grammar/parser loading is opt-in and skipped entirely when no
  // Python file is in scope; an init failure degrades instead of failing the
  // whole graph build or silently producing zero Python symbols.
  let pythonExtractor: PythonExtractor | undefined;
  if (pythonEnabled && sourceFiles.some((file) => isPythonPath(file.path))) {
    try {
      pythonExtractor = await createPythonExtractor(input.wasmDirectory !== undefined ? { wasmDirectory: input.wasmDirectory } : {});
    } catch (error) {
      degradedReasons.push(`python-extractor-init-failed:${error instanceof Error ? error.message : String(error)}:${STRUCTURE_UNSUPPORTED_INPUT}`);
    }
  }
  let parsedCount = 0;
  let reusedCount = 0;
  let retainedCount = 0;
  for (const [path, previousFile] of Object.entries(previous.files)) {
    if (sourceFiles.some((file) => file.path === path)) continue;
    const affected = degradedDirectories.some((directory) => directory === '.' || path === directory || path.startsWith(`${directory}/`));
    if (affected) {
      files[path] = previousFile;
      symbols.push(...previous.symbols.filter((symbol) => symbol.file === path));
      retainedEdges.push(...previous.edges.filter((edge) => edge.from === path));
      retainedCalls.push(...previousCalls.filter((edge) => edge.from === path));
      const cached = parsedCache[path];
      if (cached) parsedFiles[path] = cached;
      retainedCount += 1;
    }
  }

  try {
    for (const entry of sourceFiles) {
      if (files[entry.path] && input.fingerprint.degraded.length > 0) continue;
      const previousFile = previous.files[entry.path];
      const cached = parsedCache[entry.path];
      if (previousFile !== undefined && cached !== undefined && previousFile.hash === entry.hash && cached.hash === entry.hash && cached.version === cacheVersion) {
        // Content hash unchanged: reuse the parse result and recompute edges only.
        files[entry.path] = { path: entry.path, hash: entry.hash, dynamicLoads: cached.parsed.dynamicLoads };
        parsedModules.set(entry.path, cached.parsed);
        parsedFiles[entry.path] = cached;
        // Python symbols need the module-qualified projection built after the
        // resolver context exists, so they are pushed in the post-parse pass.
        if (!isPythonParsedFile(cached.parsed)) pushParsedSymbols(symbols, entry.path, cached.parsed);
        if ((cached.parsed.unresolvedDynamicLoads ?? 0) > 0) unresolvedDynamicByFile.set(entry.path, cached.parsed.unresolvedDynamicLoads);
        reusedCount += 1;
        continue;
      }
      let source: string;
      try {
        source = await readFile(join(input.root, entry.path));
      } catch (error) {
        if (errorCode(error) === 'ENOENT') {
          // Only an explicit ENOENT means the file was deleted; drop it instead of
          // carrying stale data forward (an I/O error is handled below).
          continue;
        }
        degradedReasons.push(`unreadable:${entry.path}:${errorCode(error)}`);
        const retained = retainedData(previous, entry.path, previous.edges, previousCalls);
        if (retained.file) files[entry.path] = retained.file;
        symbols.push(...retained.symbols);
        retainedEdges.push(...retained.edges);
        retainedCalls.push(...retained.calls);
        if (retained.file) {
          retainedCount += 1;
          if (cached !== undefined) parsedFiles[entry.path] = cached;
        }
        continue;
      }
      const contentHash = createHash('sha256').update(source).digest('hex');
      if (contentHash !== entry.hash) {
        degradedReasons.push(`changed-during-build:${entry.path}`);
        const retained = retainedData(previous, entry.path, previous.edges, previousCalls);
        if (retained.file) files[entry.path] = retained.file;
        symbols.push(...retained.symbols);
        retainedEdges.push(...retained.edges);
        retainedCalls.push(...retained.calls);
        if (retained.file) {
          retainedCount += 1;
          if (cached !== undefined) parsedFiles[entry.path] = cached;
        }
        continue;
      }
      let parsed: ParsedFile;
      try {
        if (isPythonPath(entry.path)) {
          if (pythonExtractor === undefined) throw new Error('Python structure extractor unavailable');
          parsed = pythonExtractor.parse(entry.path, source);
        } else {
          parsed = extractor.parse(entry.path, source);
        }
      } catch (error) {
        // ADR-010 §10.2 vocabulary on the existing free-form reason field: the
        // parse threw, so this file is explicit unsupported input. The legacy
        // `parse-failed:` prefix/message stays intact for compatibility.
        degradedReasons.push(`parse-failed:${entry.path}:${error instanceof Error ? error.message : String(error)}:${STRUCTURE_UNSUPPORTED_INPUT}`);
        const retained = retainedData(previous, entry.path, previous.edges, previousCalls);
        if (retained.file) files[entry.path] = retained.file;
        symbols.push(...retained.symbols);
        retainedEdges.push(...retained.edges);
        retainedCalls.push(...retained.calls);
        if (retained.file) {
          retainedCount += 1;
          if (cached !== undefined) parsedFiles[entry.path] = cached;
        }
        continue;
      }
      parsedModules.set(entry.path, parsed);
      parsedFiles[entry.path] = { hash: entry.hash, version: cacheVersion, parsed };
      files[entry.path] = { path: entry.path, hash: entry.hash, dynamicLoads: parsed.dynamicLoads };
      if (parsed.unresolvedDynamicLoads > 0) unresolvedDynamicByFile.set(entry.path, parsed.unresolvedDynamicLoads);
      if (!isPythonParsedFile(parsed)) pushParsedSymbols(symbols, entry.path, parsed);
      parsedCount += 1;
    }
  } finally {
    extractor.close();
    pythonExtractor?.close();
  }

  const context = await createResolutionContext(input.root, Object.keys(files));
  const edges = new EdgeSet();
  const callEdges = new CallEdgeSet();
  const callStats: CallStats = { typeOnly: 0, unresolved: 0 };
  const indexes = new Map<string, ModuleIndex>();
  for (const [path, parsed] of parsedModules) indexes.set(path, indexModule(parsed));
  for (const parsed of parsedModules.values()) {
    // Python L0/L1 edges are produced only by the Python resolver below; the
    // TS resolver, barrel logic and L2 call graph must never see a Python file.
    if (isPythonParsedFile(parsed)) continue;
    addImportEdges(edges, parsed, context, parsedModules, unresolvedDynamicByFile);
    addReexportEdges(edges, parsed, context, parsedModules);
    addCallEdges(callEdges, parsed, context, parsedModules, indexes, callStats);
  }

  // Python opt-in: module naming and L0/L1 edges come from the Python resolver,
  // never a duplicate implementation here. ADR-014 §8 keeps Python L2 out.
  const pythonModules = new Map<string, PythonParsedFile>();
  for (const [path, parsed] of parsedModules) if (isPythonParsedFile(parsed)) pythonModules.set(path, parsed);
  let pythonCaveats: CaveatSemanticGap[] = [];
  if (pythonEnabled && pythonModules.size > 0) {
    let pythonContext: Awaited<ReturnType<typeof createPythonResolutionContext>> | undefined;
    try {
      pythonContext = await createPythonResolutionContext(input.root, Object.keys(files));
      const result = await buildPythonImportEdges(pythonContext, pythonModules);
      for (const edge of result.edges) edges.add(edge.from, edge.to, edge.kind, edge.provenance, edge.importedNames, edge.label);
      pythonCaveats = result.caveats;
    } catch (error) {
      degradedReasons.push(`python-edges-failed:${error instanceof Error ? error.message : String(error)}`);
    }
    // Push symbols even when edge building degraded, so the graph never
    // silently reports zero Python declarations for parsed files.
    for (const [path, parsed] of pythonModules) {
      const moduleName = pythonContext !== undefined
        ? pythonModuleName(pythonContext, path)
        : path.replace(/\.pyi?$/u, '').replaceAll('/', '.');
      pushPythonSymbols(symbols, path, parsed, moduleName);
    }
  }
  for (const edge of retainedEdges) {
    edges.add(edge.from, edge.to, edge.kind, edge.provenance, edge.importedNames, edge.label);
  }
  for (const call of retainedCalls) callEdges.add(call);
  const edgeList = edges.values();
  const callList = callEdges.values();

  const uniqueSymbols = new Map<string, SymbolNode>();
  for (const symbol of symbols) uniqueSymbols.set(symbol.id, symbol);
  const symbolList = [...uniqueSymbols.values()].sort((a, b) => a.file.localeCompare(b.file)
    || a.symbolKind.localeCompare(b.symbolKind)
    || a.name.localeCompare(b.name)
    || a.id.localeCompare(b.id));

  const sortedFiles: Record<string, SourceFile> = {};
  for (const path of Object.keys(files).sort()) {
    const file = files[path];
    if (file) sortedFiles[path] = file;
  }

  const caveats: GraphCaveats = emptyCaveats();
  for (const edge of edgeList) caveats.edgeCounts[edge.kind] += 1;
  caveats.heuristicEdges = edgeList.filter((edge) => edge.provenance === 'heuristic').length;
  caveats.unknownRatio = edgeList.length === 0 ? 0 : caveats.edgeCounts.unknown / edgeList.length;
  caveats.dynamicLoadCount = Object.values(sortedFiles).reduce((sum, file) => sum + file.dynamicLoads, 0);
  caveats.filesWithUnresolvableDynamicLoads = unresolvedDynamicByFile.size;
  caveats.degradedReasons = [...new Set(degradedReasons)].sort();
  caveats.callEdges = callList.length;
  caveats.resolvedCallEdges = callList.filter((edge) => edge.provenance === 'resolved').length;
  caveats.heuristicCallEdges = callList.filter((edge) => edge.provenance === 'heuristic').length;
  caveats.typeOnlyCallSites = callStats.typeOnly;
  caveats.unresolvedCallSites = callStats.unresolved;
  caveats.commonjsExports = symbolList.filter((symbol) => symbol.source !== undefined).length;

  // T-116 production wiring: project the extractor's located blind-spot
  // evidence onto the snapshot caveats so analysis never depends on a caller
  // injecting it by hand. Evidence is collected from every persisted parse,
  // including content-hash reuse and retained/degraded files, in path order so
  // the snapshot revision stays deterministic and historical evidence is not
  // dropped when only some files changed.
  const evidenceParsed = Object.keys(parsedFiles).sort().map((path) => parsedFiles[path]!.parsed);
  const evidence = caveatEvidenceFromParsed(evidenceParsed);
  caveats.semanticGaps = mergeSemanticGaps(evidence.semanticGaps, pythonCaveats);
  caveats.dynamicLoadKinds = evidence.dynamicLoadKinds;
  caveats.dynamicLoadSites = evidence.dynamicLoadSites;
  caveats.registryFiles = evidence.registryFiles;
  caveats.reflectionFiles = evidence.reflectionFiles;
  caveats.zeroSymbolFiles = evidence.zeroSymbolFiles;

  const body = {
    sourceFingerprint: input.fingerprint.hash,
    files: sortedFiles,
    symbols: symbolList,
    edges: edgeList,
    calls: callList,
    caveats,
  };
  const revision = sha256(JSON.stringify(body));
  const snapshot: GraphSnapshot = { revision, ...body };
  const degraded = caveats.degradedReasons.length > 0;
  // Per-file coverage signals are extracted by ts.ts; aggregated here so a
  // caller can distinguish "no declaration" from "declarations but no edges".
  let zeroDeclarationFiles = 0;
  let zeroStaticDependencyFiles = 0;
  for (const parsed of parsedModules.values()) {
    if (parsed.scope?.zeroDeclaration === true) zeroDeclarationFiles += 1;
    else if (parsed.scope?.zeroStaticDependency === true) zeroStaticDependencyFiles += 1;
  }
  return {
    snapshot,
    report: {
      mode: parsedCount === 0 && reusedCount > 0 && !degraded ? 'incremental' : 'full',
      files: Object.keys(sortedFiles).length,
      parsed: parsedCount,
      reused: reusedCount,
      retained: retainedCount,
      degraded,
      zeroDeclarationFiles,
      zeroStaticDependencyFiles,
    },
    parsedFiles,
  };
}
