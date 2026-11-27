export type EdgeKind = 'value-confirmed' | 'type-only' | 'unknown';
export type EdgeProvenance = 'parsed' | 'resolved' | 'heuristic';

/**
 * ADR-010 §10.2 error-code vocabulary. These are the fixed machine-readable
 * names for the structure-intelligence boundary; behaviour already exists, the
 * constants make the vocabulary explicit and testable.
 */
export const STRUCTURE_QUERY_REVISION_MISMATCH = 'STRUCTURE_QUERY_REVISION_MISMATCH';
export const STRUCTURE_EVIDENCE_STALE = 'STRUCTURE_EVIDENCE_STALE';
export const STRUCTURE_CLASSIFICATION_INVALID = 'STRUCTURE_CLASSIFICATION_INVALID';
export const STRUCTURE_BUDGET_EXCEEDED = 'STRUCTURE_BUDGET_EXCEEDED';
export const STRUCTURE_UNSUPPORTED_INPUT = 'STRUCTURE_UNSUPPORTED_INPUT';

export const STRUCTURE_ERROR_CODES = Object.freeze({
  QUERY_REVISION_MISMATCH: STRUCTURE_QUERY_REVISION_MISMATCH,
  EVIDENCE_STALE: STRUCTURE_EVIDENCE_STALE,
  CLASSIFICATION_INVALID: STRUCTURE_CLASSIFICATION_INVALID,
  BUDGET_EXCEEDED: STRUCTURE_BUDGET_EXCEEDED,
  UNSUPPORTED_INPUT: STRUCTURE_UNSUPPORTED_INPUT,
});

export type StructureErrorCode = typeof STRUCTURE_ERROR_CODES[keyof typeof STRUCTURE_ERROR_CODES];
export type Freshness = { status: 'fresh'; stale: 0 } | { status: 'stale'; stale: number } | { status: 'degraded'; stale: number; reasons: string[] };

/** L2 call-edge provenance. Only `resolved` edges may be used by T2 coverage. */
export type CallProvenance = 'resolved' | 'heuristic';
export type CallLabel =
  | 'local'
  | 'imported'
  | 'member'
  | 'this'
  | 'namespace'
  | 'new'
  | 'instance'
  | 'barrel_wildcard';

/**
 * A resolved (or explicitly heuristic) L2 call site. Call edges are stored apart
 * from import/export `edges` on purpose: a call never upgrades an import edge to
 * `value-confirmed`, and T2 must not reuse T1 import semantics.
 */
export interface CallEdge {
  /** Caller file (project-relative POSIX). */
  from: string;
  /** Callee definition file. */
  to: string;
  /** Textual callee name or member property, e.g. `parse` or `map`. */
  callee: string;
  /** 1-based source line of the call expression. */
  line: number;
  provenance: CallProvenance;
  label: CallLabel;
  /** Symbol id of the enclosing function/method, when one exists. */
  callerSymbolId?: string;
  callerQualifiedName?: string;
  /** Symbol id of the callee definition, when one exists. */
  calleeSymbolId?: string;
  calleeQualifiedName?: string;
}

/** All dependency edges point from the referring file to the referenced definition file. */
export interface GraphEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  provenance: EdgeProvenance;
  importedNames: string[];
  label?: 'barrel_wildcard' | 'conditional_import' | 'lazy_import' | 'dynamic_import' | 'sideEffect' | 'unresolved' | 'depth_limit' | 'namespace_import' | 'require' | undefined;
}

/**
 * Export role of a symbol. `export` is the `module.exports` target itself,
 * `member` is a key/member inside an exported object or an `exports.x` binding.
 */
export type ExportRole = 'export' | 'member';
/**
 * Confidence of the assignment shape, not of any callee target:
 * `exact` = the export form is a literal assignment in this file;
 * `inferred` = the exported value is an identifier/computed expression whose
 * callability cannot be proven from the literal alone.
 */
export type ExportConfidence = 'exact' | 'inferred';
/**
 * Semantic class of an exported value. `metadata` fields are display data
 * (name/id/description), `executable` values are callable symbols, and
 * `unknown` means the static shape gives no trustworthy semantics (never a
 * guessed business meaning).
 */
export type ExportFieldKind = 'metadata' | 'executable' | 'unknown';
/** Concrete CommonJS assignment form that produced a symbol. */
export type CommonjsExportSource =
  | 'module.exports[]'
  | 'module.exports{}'
  | 'module.exports.x'
  | 'exports.x'
  | 'module.exports';

export interface SymbolNode {
  id: string;
  file: string;
  name: string;
  qualifiedName: string;
  symbolKind: 'type' | 'value';
  startLine: number;
  /** Optional so pre-export-aware snapshots and fixtures stay valid. */
  role?: ExportRole;
  source?: CommonjsExportSource;
  confidence?: ExportConfidence;
  fieldKind?: ExportFieldKind;
  /** True only for callable values; metadata fields are never executable. */
  executable?: boolean;
  /** Raw metadata field values, preserved verbatim (description text included). */
  metadata?: Record<string, string>;
  /** Metadata field names carried by this symbol, for display/filtering. */
  metadataFields?: string[];
}

export interface SourceFile {
  path: string;
  hash: string;
  dynamicLoads: number;
}

/**
 * Resolution tier of a dynamic load (ADR-010 §7.3). `resolved` means the target
 * text is statically literal, `heuristic` means a candidate prefix/template can
 * be inferred, `unknown` means the expression is computed and cannot be decided
 * without running the program.
 */
export type DynamicLoadTier = 'resolved' | 'heuristic' | 'unknown';

/** Concrete dynamic-load / registry / reflection mechanism. */
export type DynamicLoadPattern =
  | 'dynamic-import'
  | 'require'
  | 'computed-require'
  | 'registry-scan'
  | 'reflection'
  | 'eval';

/** Blind-spot categories reported with a location and a reason. */
export type BlindSpotType =
  | 'dynamic-load'
  | 'registry-scan'
  | 'reflection'
  | 'eval'
  | 'zero-symbol'
  | 'unsupported'
  | 'deleted'
  | 'unknown';

/** Located semantic gap carried on the snapshot caveats (bounded by the builder). */
export interface CaveatSemanticGap {
  file: string;
  line: number;
  pattern: string;
  reason: string;
}

/** One located dynamic-load site with its three-tier classification. */
export interface CaveatDynamicLoadSite {
  file: string;
  line: number;
  pattern: DynamicLoadPattern;
  tier: DynamicLoadTier;
  reason: string;
  /** Literal specifier, inferred prefix or directory expression when known. */
  target?: string;
}

export interface GraphCaveats {
  edgeCounts: Record<EdgeKind, number>;
  heuristicEdges: number;
  unknownRatio: number;
  filesWithUnresolvableDynamicLoads: number;
  dynamicLoadCount: number;
  degradedReasons: string[];
  /**
   * Located semantic gaps (dynamic/property/scope/registry evidence). These are
   * independent of `filesWithUnresolvableDynamicLoads`: zero unresolved loads
   * never implies zero blind spots (ADR-010 §4.4/§7.3). Optional for old
   * snapshots/fixtures.
   */
  semanticGaps?: CaveatSemanticGap[];
  /** Three-tier dynamic-load counts (ADR-010 §7.3). */
  dynamicLoadKinds?: Record<DynamicLoadTier, number>;
  /** Bounded located dynamic-load sites; entries carry type/line/reason/tier. */
  dynamicLoadSites?: CaveatDynamicLoadSite[];
  /** Files whose modules are registered by a runtime directory scan. */
  registryFiles?: string[];
  /** Files using reflection/eval/computed call targets. */
  reflectionFiles?: string[];
  /** Files parsed successfully but capturing no symbol at all. */
  zeroSymbolFiles?: string[];
  /** L2 call edges, split by provenance. These never count as import edges. */
  callEdges?: number;
  resolvedCallEdges?: number;
  heuristicCallEdges?: number;
  /** Calls whose target was a type-only export; deliberately not emitted as value calls. */
  typeOnlyCallSites?: number;
  /** Calls that could not be tied to a local/imported definition. */
  unresolvedCallSites?: number;
  /** Symbols produced by CommonJS export extraction (`source` present). */
  commonjsExports?: number;
}

export interface GraphSnapshot {
  revision: string;
  sourceFingerprint: string;
  files: Record<string, SourceFile>;
  symbols: SymbolNode[];
  edges: GraphEdge[];
  caveats: GraphCaveats;
  /** L2 call edges. Optional so pre-L2 snapshots/fixtures stay replayable. */
  calls?: CallEdge[];
}

export const emptyCaveats = (): GraphCaveats => ({
  edgeCounts: { 'value-confirmed': 0, 'type-only': 0, unknown: 0 },
  heuristicEdges: 0,
  unknownRatio: 0,
  filesWithUnresolvableDynamicLoads: 0,
  dynamicLoadCount: 0,
  degradedReasons: [],
  callEdges: 0,
  resolvedCallEdges: 0,
  heuristicCallEdges: 0,
  typeOnlyCallSites: 0,
  unresolvedCallSites: 0,
});
