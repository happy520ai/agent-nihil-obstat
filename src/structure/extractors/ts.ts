import { createRequire } from 'node:module';
import { basename, join } from 'node:path';
import { Language, Parser, type Node } from 'web-tree-sitter';
import type {
  BlindSpotType,
  CaveatDynamicLoadSite,
  CaveatSemanticGap,
  CommonjsExportSource,
  DynamicLoadPattern,
  DynamicLoadTier,
  ExportConfidence,
  ExportFieldKind,
  ExportRole,
  GraphCaveats,
} from '../types.ts';
import { STRUCTURE_BUDGET_EXCEEDED } from '../types.ts';

export type SymbolKind = 'type' | 'value';
export interface LocalDefinition { name: string; qualifiedName: string; kind: SymbolKind; startLine: number }
/** Methods/object members are kept out of the export table but become graph symbols. */
export interface LocalMember { name: string; qualifiedName: string; kind: 'value'; startLine: number }
export type LocalCallKind = 'name' | 'member' | 'new';
/** Raw L2 call site; name resolution happens once every module has been parsed. */
export interface LocalCall {
  kind: LocalCallKind;
  /** Textual function name or member property. */
  callee: string;
  /** Receiver text for `recv.callee()` / `new recv.Callee()`. */
  receiver?: string;
  /** Enclosing function/method qualified name, when statically known. */
  callerQualifiedName?: string;
  /** Enclosing class qualified name, for `this.method()` resolution. */
  callerClassName?: string;
  line: number;
}
/** Local `const x = new Class()` bindings, used for conservative method resolution. */
export interface LocalInstance { name: string; className: string; line: number }
export interface NamedExport {
  exportName: string; localName?: string; kind: SymbolKind; typeOnly: boolean;
  from?: string; importedName?: string; wildcard?: boolean; namespace?: boolean;
}
export interface ParsedImport {
  specifier?: string; importedNames: string[]; localNames: string[]; typeOnlyNames: string[];
  typeOnly: boolean; sideEffect: boolean; namespace: boolean; dynamic: boolean;
  require: boolean; literal: boolean; line: number;
}
/**
 * Semantic patterns that nested-scope extraction could not resolve statically.
 * They are recorded with a location and never upgraded to resolved semantics.
 */
export type ScopeGapPattern =
  | 'dynamic-property'
  | 'eval'
  | 'computed-member'
  | 'unresolved-identifier'
  | 'depth-limit';

/** Location-bound evidence for one uncapturable nested-scope construct. */
export interface ScopeSemanticGap {
  line: number;
  pattern: ScopeGapPattern;
  reason: string;
}

/**
 * Result of descending into IIFE / nested function scopes (ADR-010 §7.2).
 * Consumed by structure analysis (T-116) to distinguish `zero-symbol` from
 * `zero-edge` and to surface explicit `unknown` evidence.
 */
export interface ScopeExtraction {
  /** Immediately-invoked function-like expressions entered. */
  iifeCount: number;
  /** Declarations captured inside those scopes. */
  localDefinitions: number;
  /** Object-literal members captured inside those scopes. */
  localMembers: number;
  /** No declaration captured anywhere in the file. */
  zeroDeclaration: boolean;
  /** Declarations exist but no literal import/require and no resolvable local call. */
  zeroStaticDependency: boolean;
  /** Uncapturable constructs; never guessed into resolved semantics. */
  semanticGaps: ScopeSemanticGap[];
}

/**
 * One located construct that static analysis cannot fully decide (ADR-010 §7.3).
 * `tier` applies to dynamic loads: resolved / heuristic / unknown. Registry,
 * reflection and eval evidence is always `unknown` because the target depends on
 * runtime data. Never upgraded into a resolved import/call edge.
 */
export interface ParsedBlindSpot {
  kind: BlindSpotType;
  tier: DynamicLoadTier;
  line: number;
  pattern: string;
  reason: string;
  /** Literal specifier, inferred prefix or directory expression when known. */
  target?: string;
}

export interface ParsedFile {
  file: string; definitions: LocalDefinition[]; namedExports: NamedExport[];
  imports: ParsedImport[]; dynamicLoads: number; unresolvedDynamicLoads: number;
  /** Optional so hand-built fixtures from earlier phases remain valid. */
  members?: LocalMember[]; calls?: LocalCall[]; instances?: LocalInstance[];
  /** CommonJS export targets extracted from `module.exports` / `exports.x` assignments. */
  commonjsExports?: CommonjsExportItem[];
  /** IIFE / nested-scope extraction signals (ADR-010 §7.2). */
  scope?: ScopeExtraction;
  /**
   * Located dynamic-load / registry / reflection evidence (ADR-010 §7.3).
   * Independent of `unresolvedDynamicLoads`; consumed by structure analysis.
   */
  blindSpots?: ParsedBlindSpot[];
}

/** One extracted CommonJS export target (the target itself or one object member). */
export interface CommonjsExportItem {
  name: string;
  qualifiedName: string;
  role: ExportRole;
  source: CommonjsExportSource;
  confidence: ExportConfidence;
  fieldKind: ExportFieldKind;
  /** True only for callable values; metadata fields are never executable. */
  executable: boolean;
  startLine: number;
  /** Raw metadata values (name/id/description), preserved verbatim. */
  metadata?: Record<string, string>;
  metadataFields?: string[];
}
interface ImportBinding { specifier: string; importedName: string; typeOnly: boolean; namespace: boolean }
export interface TsExtractor { parse(file: string, source: string): ParsedFile; close(): void }
export interface TsExtractorOptions { wasmDirectory?: string }

const require = createRequire(import.meta.url);
const grammarByExtension: Record<string, string> = {
  '.ts': 'tree-sitter-typescript.wasm', '.tsx': 'tree-sitter-tsx.wasm',
  '.js': 'tree-sitter-javascript.wasm', '.jsx': 'tree-sitter-javascript.wasm',
  '.mjs': 'tree-sitter-javascript.wasm', '.cjs': 'tree-sitter-javascript.wasm',
};
export const SUPPORTED_EXTENSIONS = Object.freeze(Object.keys(grammarByExtension));
const declarationTypes = new Set(['interface_declaration', 'type_alias_declaration', 'class_declaration', 'function_declaration', 'generator_function_declaration', 'enum_declaration', 'lexical_declaration', 'variable_declaration', 'module', 'internal_module', 'ambient_declaration']);
const typeDeclarations = new Set(['interface_declaration', 'type_alias_declaration']);
let initialized: Promise<void> | undefined;

function children(node: Node): Node[] { return node.namedChildren.filter((item): item is Node => item !== null); }
function child(node: Node, type: string): Node | undefined { return children(node).find((item) => item.type === type); }
function hasToken(node: Node, type: string): boolean {
  for (let index = 0; index < node.childCount; index += 1) if (node.child(index)?.type === type) return true;
  return false;
}
function literal(node: Node | null | undefined): string | undefined {
  if (node?.type !== 'string') return undefined;
  return child(node, 'string_fragment')?.text ?? node.text.slice(1, -1);
}
function grammarFor(file: string): string | undefined {
  const extension = SUPPORTED_EXTENSIONS.find((candidate) => file.toLowerCase().endsWith(candidate));
  return extension ? grammarByExtension[extension] : undefined;
}
function namesOfDeclaration(node: Node): Node[] {
  const name = node.childForFieldName('name');
  return name ? [name] : children(node).filter((item) => item.type === 'identifier' || item.type === 'type_identifier');
}
function mergeExport(exports: Map<string, NamedExport>, entry: NamedExport): void {
  const existing = exports.get(entry.exportName);
  if (!existing) { exports.set(entry.exportName, entry); return; }
  if (entry.kind === 'value') existing.kind = 'value';
  if (!entry.typeOnly) existing.typeOnly = false;
  if (entry.from !== undefined) existing.from = entry.from;
  if (entry.importedName !== undefined) existing.importedName = entry.importedName;
  if (entry.wildcard) existing.wildcard = true;
  if (entry.namespace) existing.namespace = true;
}
function bindings(node: Node): string[] {
  if (node.type === 'identifier' || node.type === 'shorthand_property_identifier_pattern') return [node.text];
  // `const { a = fallback } = x`: only the shorthand pattern binds; `fallback` is a default value.
  if (node.type === 'object_assignment_pattern') {
    const left = children(node)[0];
    return left ? bindings(left) : [];
  }
  // `const { a: local = fallback } = x`: only the value pattern binds; the key never does.
  if (node.type === 'pair_pattern') {
    const value = node.childForFieldName('value') ?? children(node)[1];
    return value ? bindings(value) : [];
  }
  if (node.type === 'assignment_pattern') {
    const left = node.childForFieldName('left') ?? children(node)[0];
    return left ? bindings(left) : [];
  }
  return children(node).flatMap(bindings);
}
function addDefinition(definitions: Map<string, LocalDefinition>, name: string, kind: SymbolKind, line: number): void {
  const existing = definitions.get(name);
  if (existing) {
    if (kind === 'value') existing.kind = 'value';
    existing.startLine = Math.min(existing.startLine, line);
  } else definitions.set(name, { name, qualifiedName: name, kind, startLine: line });
}
function declaration(node: Node, definitions: Map<string, LocalDefinition>, exported: boolean, typeOnly: boolean, exports: Map<string, NamedExport>): void {
  if (node.type === 'ambient_declaration') {
    const inner = children(node).find((item) => declarationTypes.has(item.type));
    if (inner) declaration(inner, definitions, exported, typeOnly, exports);
    return;
  }
  if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
    const declarators = node.type === 'lexical_declaration' ? children(node) : [node];
    for (const item of declarators) {
      if (item.type !== 'variable_declarator') continue;
      const pattern = item.childForFieldName('name') ?? children(item)[0];
      if (!pattern) continue;
      for (const name of bindings(pattern)) {
        addDefinition(definitions, name, 'value', item.startPosition.row + 1);
        if (exported) mergeExport(exports, { exportName: name, localName: name, kind: 'value', typeOnly });
      }
    }
    return;
  }
  const kind: SymbolKind = typeDeclarations.has(node.type) ? 'type' : 'value';
  for (const nameNode of namesOfDeclaration(node)) {
    addDefinition(definitions, nameNode.text, kind, node.startPosition.row + 1);
    // Use this declaration's own kind: a separate same-named declaration elsewhere
    // must not silently upgrade a type-only export into a value export.
    if (exported) mergeExport(exports, { exportName: nameNode.text, localName: nameNode.text, kind, typeOnly: typeOnly || kind === 'type' });
  }
}
function importClause(node: Node, statementTypeOnly: boolean): Pick<ParsedImport, 'importedNames' | 'localNames' | 'typeOnlyNames' | 'namespace'> {
  const importedNames: string[] = [];
  const localNames: string[] = [];
  const typeOnlyNames: string[] = [];
  let namespace = false;
  const defaultName = children(node).find((item) => item.type === 'identifier');
  if (defaultName) { importedNames.push('default'); localNames.push(defaultName.text); }
  const named = child(node, 'named_imports');
  if (named) for (const specifier of children(named)) {
    if (specifier.type !== 'import_specifier') continue;
    const original = specifier.childForFieldName('name');
    if (!original) continue;
    const alias = specifier.childForFieldName('alias');
    importedNames.push(original.text);
    localNames.push(alias?.text ?? original.text);
    if (statementTypeOnly || hasToken(specifier, 'type')) typeOnlyNames.push(original.text);
  }
  const namespaceNode = child(node, 'namespace_import');
  if (namespaceNode) {
    namespace = true;
    importedNames.push('*');
    localNames.push(children(namespaceNode).find((item) => item.type === 'identifier')?.text ?? '*');
  }
  return { importedNames, localNames, typeOnlyNames, namespace };
}
function* calls(node: Node, ctx: NestedContext, depth = 0): Generator<Node> {
  if (depth > MAX_AST_WALK_DEPTH) {
    recordAstBudgetGap(ctx, node, `AST walk deeper than ${MAX_AST_WALK_DEPTH}`);
    return;
  }
  if (node.type === 'call_expression') yield node;
  for (const item of children(node)) yield* calls(item, ctx, depth + 1);
}

// ============================================================================
// IIFE / nested-scope extraction (ADR-010 §7.2)
//
// A file whose top level is only an IIFE must still yield symbols and edges:
// the extractor descends into immediately-invoked function bodies, records
// local declarations/members with scope-qualified names and never promotes a
// local symbol to an ESM export. Constructs static analysis cannot capture are
// recorded as located `unknown` gaps instead of being guessed.
// ============================================================================

const MAX_SCOPE_DEPTH = 16;
const MAX_SCOPE_NODES = 200_000;
/**
 * Bound for whole-AST recursive walkers (`analyzeAst`, `collectBlindSpots`,
 * `collectIifeScopes`, `calls`). Tree-sitter itself is native, but one JS frame
 * per AST level still overflows the stack on adversarial chains/objects before
 * any node budget can fire. 1000 levels is far above realistic source nesting
 * and comfortably inside the JS stack ceiling, so legitimate files keep full
 * fidelity while pathological shapes stop with an explicit budget gap.
 */
const MAX_AST_WALK_DEPTH = 1000;

function unwrapParentheses(node: Node | null | undefined): Node | undefined {
  let current = node;
  while (current?.type === 'parenthesized_expression') {
    const inner = children(current)[0];
    if (!inner) return current;
    current = inner;
  }
  return current ?? undefined;
}

function isFunctionExpression(node: Node | null | undefined): boolean {
  return node?.type === 'function_expression'
    || node?.type === 'generator_function'
    || node?.type === 'arrow_function';
}

function functionBody(node: Node | null | undefined): Node | undefined {
  if (!node) return undefined;
  return node.childForFieldName('body') ?? child(node, 'statement_block');
}

/** Body of an immediately-invoked function expression, if `node` is one. */
function iifeBodyOf(node: Node | null | undefined): Node | undefined {
  if (node?.type !== 'call_expression' && node?.type !== 'new_expression') return undefined;
  const calleeField = node.childForFieldName('function') ?? node.childForFieldName('constructor');
  const callee = unwrapParentheses(calleeField);
  return isFunctionExpression(callee) ? functionBody(callee) : undefined;
}

interface IifeScope { body: Node; prefix: string }

/**
 * Pre-order collection gives every IIFE a stable, source-ordered scope name:
 * `<file>#<iife>` for the first, `<file>#<iife2>`, `<file>#<iife3>`, ... after.
 * The same source always yields the same names, independent of map ordering.
 */
function collectIifeScopes(root: Node, file: string, ctx: NestedContext): IifeScope[] {
  const scopes: IifeScope[] = [];
  const visit = (node: Node, depth: number): void => {
    if (depth > MAX_AST_WALK_DEPTH) {
      recordAstBudgetGap(ctx, node, `AST walk deeper than ${MAX_AST_WALK_DEPTH}`);
      return;
    }
    const body = iifeBodyOf(node);
    if (body !== undefined) {
      const index = scopes.length + 1;
      scopes.push({ body, prefix: `${file}#${index === 1 ? '<iife>' : `<iife${index}>`}` });
    }
    for (const item of children(node)) visit(item, depth + 1);
  };
  visit(root, 0);
  return scopes;
}

interface NestedContext {
  definitions: Map<string, LocalDefinition>;
  members: LocalMember[];
  gaps: ScopeSemanticGap[];
  nodes: number;
  limitReached: boolean;
  localDefinitions: number;
  localMembers: number;
}

function qualify(parent: string | undefined, name: string): string {
  return parent !== undefined ? `${parent}.${name}` : name;
}

function addNestedDefinition(ctx: NestedContext, qualifiedName: string, name: string, line: number): void {
  ctx.localDefinitions += 1;
  const existing = ctx.definitions.get(qualifiedName);
  if (existing) {
    existing.startLine = Math.min(existing.startLine, line);
    return;
  }
  ctx.definitions.set(qualifiedName, { name, qualifiedName, kind: 'value', startLine: line });
}

function addNestedMember(ctx: NestedContext, name: string, qualifiedName: string, line: number): void {
  ctx.localMembers += 1;
  ctx.members.push({ name, qualifiedName, kind: 'value', startLine: line });
}

function recordGap(ctx: NestedContext, line: number, pattern: ScopeGapPattern, reason: string): void {
  if (ctx.gaps.length >= 1000) return;
  if (ctx.gaps.some((gap) => gap.line === line && gap.pattern === pattern)) return;
  ctx.gaps.push({ line, pattern, reason });
}

/** ADR-010 §10.2 vocabulary embedded in the existing free-form reason field. */
function budgetReason(reason: string): string {
  return `${reason} [${STRUCTURE_BUDGET_EXCEEDED}]`;
}

/** Explicit budget evidence for a whole-AST walker that stopped descending. */
function recordAstBudgetGap(ctx: NestedContext, node: Node, reason: string): void {
  if (ctx.limitReached) return;
  recordGap(ctx, node.startPosition.row + 1, 'depth-limit', budgetReason(reason));
  ctx.limitReached = true;
}

/** Object-literal members stay queryable but keep their scope-qualified names. */
function extractNestedObject(ctx: NestedContext, objectNode: Node, baseQualified: string, depth: number): void {
  // Same two gates as `extractNestedNode`: a nested object must not bypass the
  // node/depth budget (ADR-010 §10.2 `STRUCTURE_BUDGET_EXCEEDED`).
  if (ctx.nodes <= 0 || depth > MAX_SCOPE_DEPTH) {
    recordGap(
      ctx,
      objectNode.startPosition.row + 1,
      'depth-limit',
      budgetReason(ctx.nodes <= 0 ? 'nested-scope node budget exhausted' : `nested scope deeper than ${MAX_SCOPE_DEPTH}`),
    );
    ctx.limitReached = true;
    return;
  }
  for (const item of children(objectNode)) {
    if (ctx.nodes <= 0) {
      recordGap(ctx, item.startPosition.row + 1, 'depth-limit', budgetReason('nested-scope node budget exhausted'));
      ctx.limitReached = true;
      return;
    }
    ctx.nodes -= 1;
    if (item.type === 'pair') {
      const key = propertyName(item.childForFieldName('key'));
      if (key === undefined) continue;
      const qualifiedName = `${baseQualified}.${key}`;
      const line = item.startPosition.row + 1;
      addNestedMember(ctx, key, qualifiedName, line);
      const value = item.childForFieldName('value');
      if (value?.type === 'object') extractNestedObject(ctx, value, qualifiedName, depth + 1);
      else if (value) extractNestedNode(ctx, value, qualifiedName, isFunctionExpression(value) ? depth + 1 : depth);
      continue;
    }
    if (item.type === 'shorthand_property_identifier' || item.type === 'shorthand_property_identifier_pattern') {
      addNestedMember(ctx, item.text, `${baseQualified}.${item.text}`, item.startPosition.row + 1);
      continue;
    }
    if (item.type === 'method_definition') {
      const key = declarationName(item);
      if (key === undefined) continue;
      const qualifiedName = `${baseQualified}.${key}`;
      addNestedMember(ctx, key, qualifiedName, item.startPosition.row + 1);
      for (const memberChild of children(item)) extractNestedNode(ctx, memberChild, qualifiedName, depth + 1);
      continue;
    }
    // Spread elements and computed keys have no stable name: never guessed.
  }
}

/**
 * Depth-bounded descent through one IIFE body. Nested IIFE invocations are
 * skipped here because `collectIifeScopes` already gave them their own root.
 */
function extractNestedNode(ctx: NestedContext, node: Node, parent: string, depth: number): void {
  if (ctx.nodes <= 0) {
    if (!ctx.limitReached) {
      recordGap(ctx, node.startPosition.row + 1, 'depth-limit', budgetReason('nested-scope node budget exhausted'));
      ctx.limitReached = true;
    }
    return;
  }
  ctx.nodes -= 1;
  if (depth > MAX_SCOPE_DEPTH) {
    if (!ctx.limitReached) {
      recordGap(ctx, node.startPosition.row + 1, 'depth-limit', budgetReason(`nested scope deeper than ${MAX_SCOPE_DEPTH}`));
      ctx.limitReached = true;
    }
    return;
  }
  if (iifeBodyOf(node) !== undefined) return;

  if (node.type === 'call_expression') {
    const fn = node.childForFieldName('function');
    if (fn?.type === 'identifier' && fn.text === 'eval') {
      recordGap(ctx, node.startPosition.row + 1, 'eval', 'eval() cannot be captured statically');
    } else if (fn?.type === 'subscript_expression') {
      recordGap(ctx, node.startPosition.row + 1, 'computed-member', 'computed call target cannot be captured statically');
    }
  }
  if (node.type === 'subscript_expression') {
    const index = node.childForFieldName('index') ?? children(node)[1];
    if (index !== undefined && index.type !== 'string' && index.type !== 'number') {
      recordGap(ctx, node.startPosition.row + 1, 'dynamic-property', 'computed property access cannot be captured statically');
    }
  }

  switch (node.type) {
    case 'function_declaration':
    case 'generator_function_declaration': {
      const name = declarationName(node);
      const nextParent = name !== undefined ? qualify(parent, name) : parent;
      if (name !== undefined) addNestedDefinition(ctx, nextParent, name, node.startPosition.row + 1);
      for (const item of children(node)) extractNestedNode(ctx, item, nextParent, depth + 1);
      return;
    }
    case 'class_declaration': {
      const name = declarationName(node);
      if (name === undefined) {
        for (const item of children(node)) extractNestedNode(ctx, item, parent, depth + 1);
        return;
      }
      const classQualified = qualify(parent, name);
      addNestedDefinition(ctx, classQualified, name, node.startPosition.row + 1);
      const body = child(node, 'class_body');
      if (body) for (const item of children(body)) extractNestedNode(ctx, item, classQualified, depth + 1);
      return;
    }
    case 'method_definition': {
      const name = declarationName(node);
      if (name === undefined) return;
      const qualifiedName = qualify(parent, name);
      addNestedMember(ctx, name, qualifiedName, node.startPosition.row + 1);
      for (const item of children(node)) extractNestedNode(ctx, item, qualifiedName, depth + 1);
      return;
    }
    case 'public_field_definition':
    case 'field_definition': {
      const name = declarationName(node) ?? node.childForFieldName('property')?.text;
      const value = node.childForFieldName('value');
      if (name === undefined) return;
      const qualifiedName = qualify(parent, name);
      if (value && isFunctionExpression(value)) addNestedMember(ctx, name, qualifiedName, node.startPosition.row + 1);
      if (value) extractNestedNode(ctx, value, qualifiedName, depth + 1);
      return;
    }
    case 'lexical_declaration':
    case 'variable_declaration': {
      // Both declaration kinds wrap their bindings in `variable_declarator`
      // named children (`var` included).
      const declarators = children(node);
      for (const item of declarators) {
        if (item.type !== 'variable_declarator') continue;
        const pattern = item.childForFieldName('name') ?? children(item)[0];
        if (!pattern) continue;
        const names = bindings(pattern);
        const value = item.childForFieldName('value') ?? children(item)[1];
        const line = item.startPosition.row + 1;
        let singleQualified: string | undefined;
        for (const name of names) {
          const qualifiedName = qualify(parent, name);
          addNestedDefinition(ctx, qualifiedName, name, line);
          singleQualified = qualifiedName;
        }
        if (value !== undefined) {
          if (names.length === 1 && singleQualified !== undefined && value.type === 'object') {
            extractNestedObject(ctx, value, singleQualified, depth);
          } else {
            // Only a callable value opens a new function scope; other
            // expressions stay at the current scope depth.
            extractNestedNode(ctx, value, singleQualified ?? parent, isFunctionExpression(value) ? depth + 1 : depth);
          }
        }
      }
      return;
    }
    case 'object':
    case 'pair':
    case 'shorthand_property_identifier':
    case 'shorthand_property_identifier_pattern':
      // Object members are only expanded from a named binding; never guessed here.
      return;
    default:
      // Expression/statement wrappers do not open a new declaration scope, so
      // they keep the current depth; the node budget still bounds the walk.
      for (const item of children(node)) extractNestedNode(ctx, item, parent, depth);
  }
}


// ============================================================================
// Dynamic loads, registry scans and reflection (ADR-010 §7.3)
//
// A missing/unresolved dynamic load count is not a health signal: literal
// `require('./x')`, prefix-inferable templates, fully computed specifiers,
// directory registries and reflection are recorded separately with a location
// and a three-tier resolution verdict. None of them is upgraded into a graph
// edge; they feed structure coverage as explicit blind spots.
// ============================================================================

const MAX_BLIND_SPOTS = 1000;
const MAX_BLIND_SPOT_NODES = 50_000;
const MAX_CAVEAT_EVIDENCE = 5000;

const REFLECT_METHODS: ReadonlySet<string> = new Set([
  'get', 'set', 'has', 'apply', 'construct', 'ownKeys', 'defineProperty', 'deleteProperty',
]);
const REGISTRY_RECEIVERS: ReadonlySet<string> = new Set(['fs', 'node:fs', 'fsp', 'fsPromises']);

interface SpecifierClass {
  tier: DynamicLoadTier;
  reason: string;
  target?: string;
}

function templateLiteralText(node: Node): { text: string; dynamic: boolean } {
  let text = '';
  let dynamic = false;
  for (const item of children(node)) {
    if (item.type === 'string_fragment') text += item.text;
    else if (item.type === 'template_substitution') dynamic = true;
  }
  return { text, dynamic };
}

/** Literal string fragments of a `+`/template expression, for prefix inference. */
function literalFragments(node: Node): string[] {
  const parts: string[] = [];
  const visit = (current: Node): void => {
    if (current.type === 'string') {
      const value = literal(current);
      if (value !== undefined) parts.push(value);
      return;
    }
    if (current.type === 'template_string') {
      const value = templateLiteralText(current);
      if (!value.dynamic) parts.push(value.text);
      return;
    }
    if (current.type === 'binary_expression') for (const item of children(current)) visit(item);
  };
  visit(node);
  return parts;
}

/**
 * Three-tier verdict for one dynamic-load argument. Only a literal string or a
 * substitution-free template is `resolved`; a template/concatenation with a
 * literal fragment is `heuristic`; everything else is `unknown`.
 */
function classifyDynamicArgument(arg: Node | null | undefined): SpecifierClass {
  const node = unwrapParentheses(arg);
  if (node === undefined) return { tier: 'unknown', reason: 'no statically readable argument' };
  if (node.type === 'string') {
    const value = literal(node);
    if (value !== undefined) return { tier: 'resolved', target: value, reason: 'literal specifier' };
  }
  if (node.type === 'template_string') {
    const value = templateLiteralText(node);
    if (!value.dynamic) return { tier: 'resolved', target: value.text, reason: 'literal template specifier' };
    return { tier: 'heuristic', target: value.text, reason: 'template specifier with a dynamic segment' };
  }
  if (node.type === 'binary_expression') {
    const fragments = literalFragments(node);
    if (fragments.length > 0) return { tier: 'heuristic', target: fragments.join(''), reason: 'concatenation with a literal fragment' };
    return { tier: 'unknown', target: node.text.slice(0, 120), reason: 'computed concatenation is not statically resolvable' };
  }
  if (node.type === 'call_expression') {
    return { tier: 'unknown', target: node.text.slice(0, 120), reason: 'specifier is computed by a call expression' };
  }
  return { tier: 'unknown', target: node.text.slice(0, 120), reason: 'computed specifier is not statically resolvable' };
}

function dynamicPattern(base: 'dynamic-import' | 'require', verdict: SpecifierClass): DynamicLoadPattern {
  return verdict.tier === 'unknown' ? 'computed-require' : base;
}

/** Depth-unbounded pre-order walk collecting located blind-spot evidence. */
function collectBlindSpots(root: Node, file: string, ctx: NestedContext): ParsedBlindSpot[] {
  const spots: ParsedBlindSpot[] = [];
  const seen = new Set<string>();
  let budget = MAX_BLIND_SPOT_NODES;
  const push = (spot: ParsedBlindSpot): void => {
    if (spots.length >= MAX_BLIND_SPOTS) return;
    const key = `${spot.line}\0${spot.kind}\0${spot.pattern}\0${spot.target ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    spots.push(spot);
  };
  const lineOf = (node: Node): number => node.startPosition.row + 1;
  const visit = (node: Node, depth: number): void => {
    if (depth > MAX_AST_WALK_DEPTH) {
      recordAstBudgetGap(ctx, node, `AST walk deeper than ${MAX_AST_WALK_DEPTH}`);
      return;
    }
    if (budget <= 0) {
      recordGap(ctx, node.startPosition.row + 1, 'depth-limit', budgetReason('AST walk node budget exhausted'));
      return;
    }
    budget -= 1;
    if (node.type === 'call_expression') {
      const fn = node.childForFieldName('function');
      const args = node.childForFieldName('arguments') ?? child(node, 'arguments');
      const first = args ? children(args)[0] : undefined;
      const line = lineOf(node);
      if (fn?.type === 'import') {
        const verdict = classifyDynamicArgument(first);
        push({
          kind: 'dynamic-load', tier: verdict.tier, line,
          pattern: dynamicPattern('dynamic-import', verdict),
          reason: `import(): ${verdict.reason}`,
          ...(verdict.target !== undefined ? { target: verdict.target } : {}),
        });
      } else if (fn?.type === 'identifier' && fn.text === 'require') {
        const verdict = classifyDynamicArgument(first);
        push({
          kind: 'dynamic-load', tier: verdict.tier, line,
          pattern: dynamicPattern('require', verdict),
          reason: `require(): ${verdict.reason}`,
          ...(verdict.target !== undefined ? { target: verdict.target } : {}),
        });
      } else if (fn?.type === 'identifier' && fn.text === 'eval') {
        push({ kind: 'eval', tier: 'unknown', line, pattern: 'eval', reason: 'eval() executes a computed program string' });
      } else if (fn?.type === 'identifier' && fn.text === 'Function') {
        push({ kind: 'reflection', tier: 'unknown', line, pattern: 'reflection', reason: 'Function() builds executable code from a computed string' });
      } else if (fn?.type === 'subscript_expression') {
        push({ kind: 'reflection', tier: 'unknown', line, pattern: 'computed-member', reason: 'call through a computed member cannot be resolved statically' });
      } else if (fn?.type === 'member_expression') {
        const object = fn.childForFieldName('object');
        const property = fn.childForFieldName('property');
        const method = property?.type === 'property_identifier' ? property.text : undefined;
        const receiver = object?.type === 'identifier' ? object.text : undefined;
        if (receiver === 'Reflect' && method !== undefined) {
          push({ kind: 'reflection', tier: 'unknown', line, pattern: 'reflection', reason: `Reflect.${method} dispatches on runtime keys` });
        } else if ((method === 'readdirSync' || method === 'readdir') && (receiver === undefined || REGISTRY_RECEIVERS.has(receiver))) {
          push({
            kind: 'registry-scan', tier: 'unknown', line, pattern: 'registry-scan',
            reason: 'directory scan can register modules at runtime',
            ...(first !== undefined ? { target: first.text.slice(0, 160) } : {}),
          });
        }
      } else if (fn?.type === 'identifier' && (fn.text === 'readdirSync' || fn.text === 'readdir')) {
        push({
          kind: 'registry-scan', tier: 'unknown', line, pattern: 'registry-scan',
          reason: 'directory scan can register modules at runtime',
          ...(first !== undefined ? { target: first.text.slice(0, 160) } : {}),
        });
      }
    } else if (node.type === 'new_expression') {
      const constructor = node.childForFieldName('constructor') ?? children(node)[0];
      if (constructor?.type === 'identifier' && constructor.text === 'Function') {
        push({ kind: 'reflection', tier: 'unknown', line: lineOf(node), pattern: 'reflection', reason: 'new Function() builds executable code from a computed string' });
      }
    }
    for (const item of children(node)) visit(item, depth + 1);
  };
  visit(root, 0);
  return spots.sort((left, right) => left.line - right.line
    || left.kind.localeCompare(right.kind)
    || left.pattern.localeCompare(right.pattern));
}

/** Caveats-shaped evidence aggregated from parsed files (consumed by analysis). */
export interface ParsedCaveatEvidence {
  semanticGaps: CaveatSemanticGap[];
  dynamicLoadKinds: Record<DynamicLoadTier, number>;
  dynamicLoadSites: CaveatDynamicLoadSite[];
  registryFiles: string[];
  reflectionFiles: string[];
  zeroSymbolFiles: string[];
}

/**
 * Projects `ParsedFile` signals onto the optional `GraphCaveats` evidence
 * fields. Kept here so the extractor owns the pattern vocabulary; the graph
 * builder (T-119) can merge it without re-deriving semantics.
 */
export function caveatEvidenceFromParsed(parsedFiles: Iterable<ParsedFile>): ParsedCaveatEvidence {
  const semanticGaps: CaveatSemanticGap[] = [];
  const dynamicLoadSites: CaveatDynamicLoadSite[] = [];
  const dynamicLoadKinds: Record<DynamicLoadTier, number> = { resolved: 0, heuristic: 0, unknown: 0 };
  const registryFiles = new Set<string>();
  const reflectionFiles = new Set<string>();
  const zeroSymbolFiles = new Set<string>();
  for (const parsed of parsedFiles) {
    if (parsed.scope?.zeroDeclaration === true) zeroSymbolFiles.add(parsed.file);
    for (const gap of parsed.scope?.semanticGaps ?? []) {
      if (semanticGaps.length >= MAX_CAVEAT_EVIDENCE) break;
      semanticGaps.push({ file: parsed.file, line: gap.line, pattern: gap.pattern, reason: gap.reason });
    }
    for (const spot of parsed.blindSpots ?? []) {
      if (spot.kind === 'dynamic-load') {
        dynamicLoadKinds[spot.tier] += 1;
        if (dynamicLoadSites.length < MAX_CAVEAT_EVIDENCE) {
          dynamicLoadSites.push({
            file: parsed.file, line: spot.line, pattern: spot.pattern as DynamicLoadPattern, tier: spot.tier, reason: spot.reason,
            ...(spot.target !== undefined ? { target: spot.target } : {}),
          });
        }
      } else if (spot.kind === 'registry-scan') {
        registryFiles.add(parsed.file);
        if (semanticGaps.length < MAX_CAVEAT_EVIDENCE) {
          semanticGaps.push({ file: parsed.file, line: spot.line, pattern: 'registry-scan', reason: spot.reason });
        }
      } else if (spot.kind === 'reflection' || spot.kind === 'eval') {
        reflectionFiles.add(parsed.file);
        if (semanticGaps.length < MAX_CAVEAT_EVIDENCE) {
          semanticGaps.push({ file: parsed.file, line: spot.line, pattern: spot.pattern, reason: spot.reason });
        }
      }
    }
  }
  return {
    semanticGaps,
    dynamicLoadKinds,
    dynamicLoadSites,
    registryFiles: [...registryFiles].sort(),
    reflectionFiles: [...reflectionFiles].sort(),
    zeroSymbolFiles: [...zeroSymbolFiles].sort(),
  };
}

/** Object fields that carry display metadata rather than executable behaviour. */
const metadataFieldNames = new Set(['name', 'id', 'description']);

interface CommonjsContext {
  file: string;
  definitions: Map<string, LocalDefinition>;
  items: CommonjsExportItem[];
}

function propertyName(node: Node | null | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === 'string') return literal(node);
  if (node.type === 'property_identifier' || node.type === 'identifier') return node.text;
  return undefined;
}

/** Raw literal text for metadata values; description strings are preserved verbatim. */
function rawLiteralValue(node: Node | null | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === 'string') return literal(node);
  if (node.type === 'number' || node.type === 'true' || node.type === 'false' || node.type === 'null') return node.text;
  return undefined;
}

function callableValue(node: Node | null | undefined): boolean {
  return node?.type === 'arrow_function'
    || node?.type === 'function_expression'
    || node?.type === 'generator_function'
    || node?.type === 'function_declaration'
    || node?.type === 'class'
    || node?.type === 'class_declaration';
}

function collectMetadata(objectNode: Node): { values: Record<string, string>; fields: string[] } {
  const values: Record<string, string> = {};
  const fields: string[] = [];
  for (const child of children(objectNode)) {
    if (child.type !== 'pair') continue;
    const key = propertyName(child.childForFieldName('key'));
    if (key === undefined || !metadataFieldNames.has(key)) continue;
    fields.push(key);
    const raw = rawLiteralValue(child.childForFieldName('value'));
    if (raw !== undefined) values[key] = raw;
  }
  return { values, fields };
}

function withMetadata(item: CommonjsExportItem, metadata: { values: Record<string, string>; fields: string[] }): CommonjsExportItem {
  if (metadata.fields.length === 0) return item;
  return { ...item, metadata: { ...metadata.values }, metadataFields: [...metadata.fields] };
}

function cjsAssignmentTarget(node: Node | null | undefined): { kind: 'module.exports' | 'exports.member' | 'module.exports.member'; member?: string } | undefined {
  if (!node || node.type !== 'member_expression') return undefined;
  const object = node.childForFieldName('object');
  const property = node.childForFieldName('property');
  if (!object || !property || property.type !== 'property_identifier') return undefined;
  if (object.type === 'identifier' && object.text === 'module' && property.text === 'exports') return { kind: 'module.exports' };
  if (object.type === 'identifier' && object.text === 'exports') return { kind: 'exports.member', member: property.text };
  if (object.type === 'member_expression') {
    const innerObject = object.childForFieldName('object');
    const innerProperty = object.childForFieldName('property');
    if (innerObject?.type === 'identifier' && innerObject.text === 'module'
      && innerProperty?.type === 'property_identifier' && innerProperty.text === 'exports') {
      return { kind: 'module.exports.member', member: property.text };
    }
  }
  return undefined;
}

/**
 * One object member. `name`/`id`/`description` with literal values are metadata;
 * callables are executable symbols; anything else stays `unknown` (no invented
 * business meaning). Nested objects recurse so their members stay queryable.
 */
function memberItem(
  ctx: CommonjsContext,
  name: string,
  qualifiedName: string,
  source: CommonjsExportSource,
  value: Node | null | undefined,
  line: number,
): CommonjsExportItem {
  const base = { name, qualifiedName, source, startLine: line };
  if (value && metadataFieldNames.has(name)) {
    const raw = rawLiteralValue(value);
    if (raw !== undefined) {
      return { ...base, role: 'member', confidence: 'exact', fieldKind: 'metadata', executable: false, metadata: { [name]: raw }, metadataFields: [name] };
    }
  }
  if (callableValue(value)) {
    return { ...base, role: 'member', confidence: 'exact', fieldKind: 'executable', executable: true };
  }
  if (value?.type === 'identifier') {
    const definition = ctx.definitions.get(value.text);
    if (definition?.kind === 'value') {
      return { ...base, role: 'member', confidence: 'exact', fieldKind: 'executable', executable: true };
    }
    return { ...base, role: 'member', confidence: 'inferred', fieldKind: 'unknown', executable: false };
  }
  if (value?.type === 'object') {
    return { ...base, role: 'member', confidence: 'exact', fieldKind: 'unknown', executable: false };
  }
  if (value?.type === 'call_expression' || value?.type === 'new_expression') {
    return { ...base, role: 'member', confidence: 'inferred', fieldKind: 'unknown', executable: false };
  }
  // Literal shape is exact, but an unknown field name keeps `unknown` semantics.
  return { ...base, role: 'member', confidence: 'exact', fieldKind: 'unknown', executable: false };
}

function extractObjectMembers(ctx: CommonjsContext, objectNode: Node, baseQualified: string, source: CommonjsExportSource, gapCtx: NestedContext, depth: number): { values: Record<string, string>; fields: string[] } {
  if (depth > MAX_AST_WALK_DEPTH) {
    recordAstBudgetGap(gapCtx, objectNode, `AST walk deeper than ${MAX_AST_WALK_DEPTH}`);
    return { values: {}, fields: [] };
  }
  const metadata = collectMetadata(objectNode);
  for (const child of children(objectNode)) {
    if (child.type === 'pair') {
      const key = propertyName(child.childForFieldName('key'));
      const value = child.childForFieldName('value');
      if (key === undefined) continue;
      const qualifiedName = `${baseQualified}.${key}`;
      ctx.items.push(memberItem(ctx, key, qualifiedName, source, value, child.startPosition.row + 1));
      if (value?.type === 'object') extractObjectMembers(ctx, value, qualifiedName, source, gapCtx, depth + 1);
      continue;
    }
    if (child.type === 'shorthand_property_identifier') {
      ctx.items.push(memberItem(ctx, child.text, `${baseQualified}.${child.text}`, source, undefined, child.startPosition.row + 1));
      continue;
    }
    if (child.type === 'method_definition') {
      const key = declarationName(child);
      if (key !== undefined) ctx.items.push({ name: key, qualifiedName: `${baseQualified}.${key}`, role: 'member', source, confidence: 'exact', fieldKind: 'executable', executable: true, startLine: child.startPosition.row + 1 });
      continue;
    }
    // spread elements / computed keys have no stable name: never guessed.
  }
  return metadata;
}

/**
 * CommonJS export extraction for the four literal forms:
 * `module.exports = [ ... ]`, `module.exports = { ... }`, `exports.x = ...`,
 * `module.exports.x = ...` and `module.exports = fn`. It only records literal
 * fields and function positions; it never promotes a local declaration to an
 * ESM export and never guesses semantics for unknown fields.
 *
 * Assignments nested inside IIFE bodies are real module exports too; traversal
 * is pre-order so source order (and therefore stable naming) is preserved.
 */
function extractCommonjsExports(ctx: CommonjsContext, root: Node, gapCtx: NestedContext): void {
  const visit = (node: Node, depth: number): void => {
    if (depth > MAX_SCOPE_DEPTH) return;
    if (node.type === 'expression_statement') {
      processCommonjsExpression(ctx, node, gapCtx);
      // Keep descending: an IIFE body is an expression statement whose function
      // body may contain real `module.exports` assignments.
      for (const item of children(node)) visit(item, depth + 1);
      return;
    }
    for (const item of children(node)) visit(item, depth + 1);
  };
  visit(root, 0);
}

function processCommonjsExpression(ctx: CommonjsContext, node: Node, gapCtx: NestedContext): void {
  const assignment = children(node).find((item) => item.type === 'assignment_expression');
  if (!assignment) return;
  const target = cjsAssignmentTarget(assignment.childForFieldName('left'));
  const right = assignment.childForFieldName('right');
  if (!target || !right) return;
  const line = assignment.startPosition.row + 1;
  if (target.kind === 'module.exports') {
    if (right.type === 'array') {
      ctx.items.push({ name: 'default', qualifiedName: `${ctx.file}#default`, role: 'export', source: 'module.exports[]', confidence: 'exact', fieldKind: 'unknown', executable: false, startLine: line });
      let index = 0;
      for (const element of children(right)) {
        const qualifiedName = `${ctx.file}#default[${index}]`;
        const elementLine = element.startPosition.row + 1;
        if (element.type === 'object') {
          const metadata = collectMetadata(element);
          ctx.items.push(withMetadata({
            name: metadata.values.name ?? metadata.values.id ?? `#${index}`,
            qualifiedName,
            role: 'export',
            source: 'module.exports[]',
            confidence: metadata.values.name !== undefined ? 'exact' : 'inferred',
            fieldKind: 'unknown',
            executable: false,
            startLine: elementLine,
          }, metadata));
          extractObjectMembers(ctx, element, qualifiedName, 'module.exports[]', gapCtx, 0);
        } else if (callableValue(element)) {
          ctx.items.push({ name: `#${index}`, qualifiedName, role: 'export', source: 'module.exports[]', confidence: 'exact', fieldKind: 'executable', executable: true, startLine: elementLine });
        } else {
          ctx.items.push({ name: `#${index}`, qualifiedName, role: 'export', source: 'module.exports[]', confidence: 'exact', fieldKind: 'unknown', executable: false, startLine: elementLine });
        }
        index += 1;
      }
      return;
    }
    if (right.type === 'object') {
      ctx.items.push({ name: 'default', qualifiedName: `${ctx.file}#default`, role: 'export', source: 'module.exports{}', confidence: 'exact', fieldKind: 'unknown', executable: false, startLine: line });
      extractObjectMembers(ctx, right, `${ctx.file}#default`, 'module.exports{}', gapCtx, 0);
      return;
    }
    if (callableValue(right)) {
      const name = declarationName(right) ?? 'default';
      ctx.items.push({ name, qualifiedName: `${ctx.file}#default`, role: 'export', source: 'module.exports', confidence: 'exact', fieldKind: 'executable', executable: true, startLine: line });
      return;
    }
    if (right.type === 'identifier') {
      const executable = ctx.definitions.get(right.text)?.kind === 'value';
      ctx.items.push({ name: right.text, qualifiedName: `${ctx.file}#default`, role: 'export', source: 'module.exports', confidence: executable ? 'exact' : 'inferred', fieldKind: executable ? 'executable' : 'unknown', executable, startLine: line });
      return;
    }
    ctx.items.push({ name: 'default', qualifiedName: `${ctx.file}#default`, role: 'export', source: 'module.exports', confidence: 'inferred', fieldKind: 'unknown', executable: false, startLine: line });
    return;
  }
  const member = target.member;
  if (member === undefined) return;
  const source: CommonjsExportSource = target.kind === 'exports.member' ? 'exports.x' : 'module.exports.x';
  ctx.items.push(memberItem(ctx, member, `${ctx.file}#exports.${member}`, source, right, line));
}


interface CallScope {
  callerQualifiedName?: string;
  callerClassName?: string;
  /** IIFE root prefix (`<file>#<iife>`); local names stay scoped under it. */
  prefix?: string;
}

function simpleBindingName(node: Node | null | undefined): string | undefined {
  return node?.type === 'identifier' ? node.text : undefined;
}

function declarationName(node: Node): string | undefined {
  return node.childForFieldName('name')?.text;
}

/** Appends `name` to the active IIFE/caller scope; top level stays unqualified. */
function scopeName(scope: CallScope, name: string): string {
  const base = scope.prefix ?? scope.callerQualifiedName;
  return base !== undefined ? `${base}.${name}` : name;
}

function withName(scope: CallScope, name: string): CallScope {
  return { ...scope, callerQualifiedName: scopeName(scope, name) };
}

function callFromExpression(node: Node, scope: CallScope): LocalCall | undefined {
  const fn = node.childForFieldName('function');
  if (!fn) return undefined;
  const base = {
    ...(scope.callerQualifiedName !== undefined ? { callerQualifiedName: scope.callerQualifiedName } : {}),
    ...(scope.callerClassName !== undefined ? { callerClassName: scope.callerClassName } : {}),
    line: node.startPosition.row + 1,
  };
  if (fn.type === 'identifier') {
    // Dynamic import()/require() are L0 file-level loads, not L2 call edges.
    if (fn.text === 'import' || fn.text === 'require') return undefined;
    return { kind: 'name', callee: fn.text, ...base };
  }
  if (fn.type !== 'member_expression') return undefined;
  const object = fn.childForFieldName('object');
  const property = fn.childForFieldName('property');
  if (!object || !property) return undefined;
  if (property.type !== 'property_identifier' && property.type !== 'identifier') return undefined;
  return { kind: 'member', callee: property.text, receiver: object.text, ...base };
}

function newFromExpression(node: Node, scope: CallScope): LocalCall | undefined {
  const constructor = node.childForFieldName('constructor') ?? children(node)[0];
  if (!constructor) return undefined;
  const base = {
    ...(scope.callerQualifiedName !== undefined ? { callerQualifiedName: scope.callerQualifiedName } : {}),
    ...(scope.callerClassName !== undefined ? { callerClassName: scope.callerClassName } : {}),
    line: node.startPosition.row + 1,
  };
  if (constructor.type === 'identifier') return { kind: 'new', callee: constructor.text, ...base };
  if (constructor.type !== 'member_expression') return undefined;
  const object = constructor.childForFieldName('object');
  const property = constructor.childForFieldName('property');
  if (!object || !property) return undefined;
  if (property.type !== 'property_identifier' && property.type !== 'identifier') return undefined;
  return { kind: 'new', callee: property.text, receiver: object.text, ...base };
}

interface AstState {
  members: LocalMember[];
  callSites: LocalCall[];
  instances: LocalInstance[];
  /**
   * IIFE body start index -> stable scope prefix, so calls tie to scoped
   * symbols. Tree-sitter `Node` wrappers are not identity-stable, hence the
   * primitive key.
   */
  iifePrefixes: Map<number, string>;
}

function analyzeMethod(node: Node, scope: CallScope, state: AstState, ctx: NestedContext, depth: number): void {
  const name = declarationName(node);
  const qualifiedName = name === undefined
    ? scope.callerQualifiedName
    : scope.callerClassName !== undefined ? `${scope.callerClassName}.${name}` : name;
  const inner: CallScope = {
    ...scope,
    ...(qualifiedName !== undefined ? { callerQualifiedName: qualifiedName } : {}),
  };
  // Inside an IIFE the object-literal member was already registered with its
  // scope-qualified name; never also emit an unscoped duplicate that would look
  // like a module-level symbol.
  if (name !== undefined && qualifiedName !== undefined && !(scope.prefix !== undefined && scope.callerClassName === undefined)) {
    state.members.push({ name, qualifiedName, kind: 'value', startLine: node.startPosition.row + 1 });
  }
  for (const child of children(node)) analyzeAst(child, inner, state, ctx, depth + 1);
}

/**
 * Walks the file once to collect L2 call sites, class members and local
 * `new Class()` bindings. Caller scopes are qualified (`Class.method`,
 * `<file>#<iife>.outer.inner`) so call edges can be tied to stable symbol ids.
 * The walk is depth-bounded (`MAX_AST_WALK_DEPTH`): adversarial chains/objects
 * stop with an explicit budget gap instead of overflowing the JS stack.
 */
function analyzeAst(node: Node, scope: CallScope, state: AstState, ctx: NestedContext, depth: number): void {
  if (depth > MAX_AST_WALK_DEPTH) {
    recordAstBudgetGap(ctx, node, `AST walk deeper than ${MAX_AST_WALK_DEPTH}`);
    return;
  }
  if (node.type === 'class_declaration' || node.type === 'class') {
    const name = declarationName(node);
    const classQualified = name !== undefined ? scopeName(scope, name) : undefined;
    const classScope: CallScope = classQualified !== undefined
      ? { ...scope, ...(classQualified !== undefined ? { callerQualifiedName: classQualified, callerClassName: classQualified } : {}) }
      : scope;
    for (const child of children(node)) {
      if (child.type === 'class_body') {
        for (const member of children(child)) analyzeAst(member, classScope, state, ctx, depth + 1);
      } else analyzeAst(child, scope, state, ctx, depth + 1);
    }
    return;
  }
  if (node.type === 'method_definition') {
    analyzeMethod(node, scope, state, ctx, depth);
    return;
  }
  if (node.type === 'public_field_definition' || node.type === 'field_definition') {
    const name = declarationName(node);
    const value = node.childForFieldName('value') ?? children(node).find((item) => item.type === 'arrow_function' || item.type === 'function_expression' || item.type === 'generator_function');
    if (name !== undefined && value && (value.type === 'arrow_function' || value.type === 'function_expression' || value.type === 'generator_function')) {
      const qualifiedName = scopeName(scope, name);
      state.members.push({ name, qualifiedName, kind: 'value', startLine: node.startPosition.row + 1 });
      analyzeAst(value, { ...scope, callerQualifiedName: qualifiedName }, state, ctx, depth + 1);
      return;
    }
    for (const child of children(node)) analyzeAst(child, scope, state, ctx, depth + 1);
    return;
  }
  if (node.type === 'function_declaration' || node.type === 'generator_function_declaration' || node.type === 'function_expression') {
    const name = declarationName(node);
    const inner = name !== undefined ? withName(scope, name) : scope;
    for (const child of children(node)) analyzeAst(child, inner, state, ctx, depth + 1);
    return;
  }
  if (node.type === 'variable_declarator') {
    const name = simpleBindingName(node.childForFieldName('name'));
    const value = node.childForFieldName('value') ?? children(node)[1];
    if (name !== undefined && value && (value.type === 'arrow_function' || value.type === 'function_expression' || value.type === 'generator_function')) {
      analyzeAst(value, withName(scope, name), state, ctx, depth + 1);
      return;
    }
    if (name !== undefined && value?.type === 'new_expression') {
      const constructed = newFromExpression(value, scope);
      if (constructed) {
        state.instances.push({ name, className: constructed.receiver ? `${constructed.receiver}.${constructed.callee}` : constructed.callee, line: constructed.line });
      }
    }
    if (value) analyzeAst(value, scope, state, ctx, depth + 1);
    return;
  }
  if (node.type === 'call_expression' || node.type === 'new_expression') {
    // An immediately-invoked function expression is a nested scope root, not a
    // call target: descend into its body with the IIFE-qualified scope.
    const iifeBody = iifeBodyOf(node);
    if (iifeBody !== undefined) {
      const prefix = state.iifePrefixes.get(iifeBody.startIndex);
      if (prefix !== undefined) {
        const inner: CallScope = {
          ...(prefix !== undefined ? { prefix } : {}),
          ...(scope.callerClassName !== undefined ? { callerClassName: scope.callerClassName } : {}),
        };
        for (const child of children(node)) analyzeAst(child, inner, state, ctx, depth + 1);
        return;
      }
    }
    const call = node.type === 'call_expression' ? callFromExpression(node, scope) : newFromExpression(node, scope);
    if (call) state.callSites.push(call);
    for (const child of children(node)) analyzeAst(child, scope, state, ctx, depth + 1);
    return;
  }
  for (const child of children(node)) analyzeAst(child, scope, state, ctx, depth + 1);
}

function parseFile(parser: Parser, file: string, source: string): ParsedFile {
  const tree = parser.parse(source);
  if (!tree) throw new Error(`No parse tree for ${file}`);
  try {
    const definitions = new Map<string, LocalDefinition>();
    const members: LocalMember[] = [];
    const callSites: LocalCall[] = [];
    const instances: LocalInstance[] = [];
    const exports = new Map<string, NamedExport>();
    const imports: ParsedImport[] = [];
    const importBindings = new Map<string, ImportBinding>();
    const recordBindings = (entry: ParsedImport): void => {
      if (entry.specifier === undefined) return;
      for (let index = 0; index < entry.localNames.length; index += 1) {
        const local = entry.localNames[index]!;
        const importedName = entry.importedNames[index] ?? local;
        if (local === '*') continue;
        importBindings.set(local, {
          specifier: entry.specifier,
          importedName,
          typeOnly: entry.typeOnly || entry.typeOnlyNames.includes(importedName),
          namespace: importedName === '*',
        });
      }
    };
    let dynamicLoads = 0;
    let unresolvedDynamicLoads = 0;
    // Pass 1: imports and plain declarations. Import bindings must be known before
    // `export { X }` is rewritten, even when the export statement precedes the import.
    for (const node of children(tree.rootNode)) {
      if (node.type === 'import_statement') {
        const typeOnly = hasToken(node, 'type');
        const specifier = literal(node.childForFieldName('source'));
        const clause = child(node, 'import_clause');
        const requireClause = child(node, 'import_require_clause');
        if (clause) {
          const imported = importClause(clause, typeOnly);
          const entry: ParsedImport = { ...(specifier === undefined ? {} : { specifier }), ...imported, typeOnly, sideEffect: imported.importedNames.length === 0 && !typeOnly, dynamic: false, require: false, literal: specifier !== undefined, line: node.startPosition.row + 1 };
          imports.push(entry);
          recordBindings(entry);
        }
        else if (requireClause) {
          const match = /require\(\s*(['"])(.*?)\1\s*\)/.exec(requireClause.text);
          const entry: ParsedImport = { ...(match ? { specifier: match[2]! } : {}), importedNames: ['*'], localNames: [children(requireClause).find((item) => item.type === 'identifier')?.text ?? '*'], typeOnlyNames: [], typeOnly: false, sideEffect: false, namespace: true, dynamic: false, require: true, literal: Boolean(match), line: node.startPosition.row + 1 };
          imports.push(entry);
          recordBindings(entry);
          dynamicLoads += 1;
          if (!match) unresolvedDynamicLoads += 1;
        } else imports.push({ ...(specifier === undefined ? {} : { specifier }), importedNames: [], localNames: [], typeOnlyNames: [], typeOnly: false, sideEffect: true, namespace: false, dynamic: false, require: false, literal: specifier !== undefined, line: node.startPosition.row + 1 });
      }
      if (declarationTypes.has(node.type)) declaration(node, definitions, false, false, exports);
    }
    // Pass 2: export statements, with the full definition/import tables available.
    for (const node of children(tree.rootNode)) {
      if (node.type !== 'export_statement') continue;
      const specifier = literal(node.childForFieldName('source'));
      const typeOnly = hasToken(node, 'type');
      const declared = node.childForFieldName('declaration')
        ?? children(node).find((item) => declarationTypes.has(item.type))
        ?? child(node, 'lexical_declaration');
      const isDefault = hasToken(node, 'default');
      if (declared) declaration(declared, definitions, !isDefault, typeOnly, exports);
      if (isDefault) {
        const name = declared ? namesOfDeclaration(declared)[0]?.text : undefined;
        const declaredKind: SymbolKind = declared && typeDeclarations.has(declared.type) ? 'type' : 'value';
        if (name) mergeExport(exports, { exportName: 'default', localName: name, kind: declaredKind, typeOnly: typeOnly || declaredKind === 'type' });
        else {
          addDefinition(definitions, 'default', 'value', node.startPosition.row + 1);
          mergeExport(exports, { exportName: 'default', localName: 'default', kind: 'value', typeOnly });
        }
      }
      const exportClause = child(node, 'export_clause');
      if (exportClause) for (const item of children(exportClause)) {
        if (item.type !== 'export_specifier') continue;
        const original = item.childForFieldName('name') ?? children(item)[0];
        if (!original) continue;
        const alias = item.childForFieldName('alias');
        const entryTypeOnly = typeOnly || hasToken(item, 'type');
        const local = definitions.get(original.text);
        // `export { X }` where X came from an import: forward to the defining module
        // (and keep the imported type-only-ness), never point at this forwarding file.
        const binding = specifier === undefined && local === undefined ? importBindings.get(original.text) : undefined;
        if (binding) {
          const bindingTypeOnly = entryTypeOnly || binding.typeOnly;
          mergeExport(exports, {
            exportName: alias?.text ?? original.text,
            kind: bindingTypeOnly ? 'type' : 'value',
            typeOnly: bindingTypeOnly,
            from: binding.specifier,
            importedName: binding.importedName,
            ...(binding.namespace ? { namespace: true } : {}),
          });
          continue;
        }
        mergeExport(exports, { exportName: alias?.text ?? original.text, kind: entryTypeOnly ? 'type' : local?.kind ?? 'value', typeOnly: entryTypeOnly || local?.kind === 'type', ...(specifier === undefined ? { localName: original.text } : { from: specifier, importedName: original.text }) });
      }
      const namespaceExport = child(node, 'namespace_export');
      if (namespaceExport && specifier !== undefined) {
        const alias = children(namespaceExport).find((item) => item.type === 'identifier');
        if (alias) mergeExport(exports, { exportName: alias.text, kind: 'value', typeOnly: false, from: specifier, importedName: '*', namespace: true });
      }
      if (!declared && !exportClause && !namespaceExport && !isDefault && specifier !== undefined) mergeExport(exports, { exportName: '*', kind: 'value', typeOnly, from: specifier, wildcard: true });
    }
    // Shared per-file gap/budget state. Whole-AST walkers record their explicit
    // depth-limit evidence here too, so a pathological shape is never silently
    // truncated and never overflows the JS stack before the budget fires.
    const nestedContext: NestedContext = {
      definitions,
      members,
      gaps: [],
      nodes: MAX_SCOPE_NODES,
      limitReached: false,
      localDefinitions: 0,
      localMembers: 0,
    };
    // Pass 3: CommonJS export targets (`module.exports` / `exports.x`). Runs
    // after top-level declarations so identifier-valued members can be checked
    // against local definitions; it adds symbols without touching ESM export
    // semantics. Traversal is recursive so real assignments inside an IIFE are
    // still recognised as module exports.
    const commonjsContext: CommonjsContext = { file, definitions, items: [] };
    extractCommonjsExports(commonjsContext, tree.rootNode, nestedContext);
    for (const call of calls(tree.rootNode, nestedContext)) {
      const fn = call.childForFieldName('function');
      if (!fn || (fn.type !== 'import' && !(fn.type === 'identifier' && fn.text === 'require'))) continue;
      const args = call.childForFieldName('arguments') ?? child(call, 'arguments');
      const argChildren = args ? children(args) : [];
      const specifier = literal(argChildren[0]);
      dynamicLoads += 1;
      if (specifier === undefined) unresolvedDynamicLoads += 1;
      imports.push({ ...(specifier === undefined ? {} : { specifier }), importedNames: [], localNames: [], typeOnlyNames: [], typeOnly: false, sideEffect: false, namespace: false, line: call.startPosition.row + 1, dynamic: fn.type === 'import', require: fn.type === 'identifier', literal: specifier !== undefined });
    }
    // Pass 4: IIFE / nested-scope descent (ADR-010 §7.2). Local declarations and
    // object members get scope-qualified names; they never become exports.
    const iifeScopes = collectIifeScopes(tree.rootNode, file, nestedContext);
    const iifePrefixes = new Map<number, string>();
    for (const scopeEntry of iifeScopes) {
      iifePrefixes.set(scopeEntry.body.startIndex, scopeEntry.prefix);
      extractNestedNode(nestedContext, scopeEntry.body, scopeEntry.prefix, 0);
    }
    analyzeAst(tree.rootNode, {}, { members, callSites, instances, iifePrefixes }, nestedContext, 0);

    // Explicit unknown evidence: identifier calls/receivers that no static
    // definition or import binding can explain are recorded, never resolved.
    const knownNames = new Set<string>();
    for (const definition of definitions.values()) knownNames.add(definition.name);
    for (const member of members) knownNames.add(member.name);
    const boundNames = new Set<string>();
    for (const entry of imports) for (const name of entry.localNames) boundNames.add(name);
    let hasResolvableCall = false;
    for (const call of callSites) {
      if (call.kind === 'name' || call.kind === 'new') {
        if (knownNames.has(call.callee) || boundNames.has(call.callee)) hasResolvableCall = true;
        else recordGap(nestedContext, call.line, 'unresolved-identifier', `${call.callee} has no static definition`);
      } else if (call.receiver !== undefined && call.receiver !== 'this' && call.receiver !== 'super') {
        if (knownNames.has(call.receiver) || boundNames.has(call.receiver)) hasResolvableCall = true;
        else recordGap(nestedContext, call.line, 'unresolved-identifier', `${call.receiver}.${call.callee} receiver has no static definition`);
      }
    }

    const declarationCount = definitions.size + members.length + commonjsContext.items.length;
    const scope: ScopeExtraction = {
      iifeCount: iifeScopes.length,
      localDefinitions: nestedContext.localDefinitions,
      localMembers: nestedContext.localMembers,
      zeroDeclaration: declarationCount === 0,
      zeroStaticDependency: declarationCount > 0 && imports.length === 0 && !hasResolvableCall,
      semanticGaps: [...nestedContext.gaps].sort((a, b) => a.line - b.line || a.pattern.localeCompare(b.pattern)),
    };
    return {
      file,
      definitions: [...definitions.values()].sort((a, b) => a.startLine - b.startLine || a.name.localeCompare(b.name)),
      namedExports: [...exports.values()].sort((a, b) => a.exportName.localeCompare(b.exportName)),
      imports,
      dynamicLoads,
      unresolvedDynamicLoads,
      members: members.sort((a, b) => a.startLine - b.startLine || a.qualifiedName.localeCompare(b.qualifiedName)),
      calls: callSites.sort((a, b) => a.line - b.line || a.callee.localeCompare(b.callee)),
      instances: instances.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name)),
      // Source order is the declaration order: stable across runs and independent
      // of locale-aware string sorting.
      commonjsExports: commonjsContext.items,
      scope,
      blindSpots: collectBlindSpots(tree.rootNode, file, nestedContext),
    };
  } finally { tree.delete(); }
}

export async function createTsExtractor(options: TsExtractorOptions = {}): Promise<TsExtractor> {
  initialized ??= Parser.init(options.wasmDirectory ? { locateFile: (name: string) => join(options.wasmDirectory!, basename(name)) } : undefined);
  await initialized;
  const parsers = new Map<string, Parser>();
  for (const grammar of new Set(Object.values(grammarByExtension))) {
    const path = options.wasmDirectory ? join(options.wasmDirectory, grammar) : require.resolve(`tree-sitter-wasms/out/${grammar}`);
    const language = await Language.load(path);
    const parser = new Parser();
    parser.setLanguage(language);
    parsers.set(grammar, parser);
  }
  return {
    parse(file, source) {
      const grammar = grammarFor(file);
      const parser = grammar ? parsers.get(grammar) : undefined;
      if (!parser) throw new Error(`Unsupported extension: ${file}`);
      return parseFile(parser, file, source);
    },
    close() { for (const parser of parsers.values()) parser.delete(); parsers.clear(); },
  };
}
