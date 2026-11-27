/**
 * Python L1 extractor (M23 / PY-07, ADR-014 §5).
 *
 * Static only: a `tree-sitter-python` WASM syntax tree is walked; the analysed
 * code is never interpreted, no interpreter is spawned and no virtualenv /
 * `site-packages` content is read. The result extends the shared `ParsedFile`
 * shape so later wiring (PY-08/PY-09) can consume it without changing the TS
 * extractor contract, while Python-specific data (import context, provenance,
 * `__all__`, blind spots, budgets) is carried by local extension types.
 *
 * Feature flag: extraction is opt-in. This module exports no flag and wires
 * nothing; `ENABLE_PYTHON_STRUCTURE` stays closed (ADR-014 §5.5) until PY-12.
 */

import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { Language, Parser, type Node } from 'web-tree-sitter';
import type { DynamicLoadTier } from '../types.ts';
import { STRUCTURE_BUDGET_EXCEEDED } from '../types.ts';
import type {
  LocalDefinition,
  ParsedBlindSpot,
  ParsedFile,
  ParsedImport,
  ScopeExtraction,
  ScopeGapPattern,
  ScopeSemanticGap,
  SymbolKind,
} from './ts.ts';

export type PythonSymbolForm = 'class' | 'function' | 'assignment' | 'type-alias';

/** Python L1 symbol. Methods carry `ownerClass` and a dotted `qualifiedName`. */
export interface PythonDefinition extends LocalDefinition {
  form: PythonSymbolForm;
  /** `async def` only. */
  isAsync?: boolean;
  /** Decorator names in source order, arguments and calls stripped. */
  decorators?: string[];
  /** Nearest enclosing class qualified name for methods. */
  ownerClass?: string;
  /** Declared in a `.pyi` stub. */
  stub?: boolean;
  /** Declared inside `if TYPE_CHECKING:` (not bound at runtime). */
  typeOnly?: boolean;
  /**
   * Declared under a runtime conditional (`if`/`try`/loop at module scope), so
   * the name may be absent at import time. The later resolver must not treat
   * `from module import name` as value-confirmed.
   */
  conditional?: boolean;
}

export type PythonImportContext = 'module' | 'type-checking' | 'conditional-import' | 'lazy-import';
/**
 * Edge provenance the later Python resolver (PY-08) must honour.
 * `heuristic` and `type-only` must never be upgraded to `value-confirmed`.
 */
export type PythonImportProvenance = 'value-confirmed' | 'type-only' | 'heuristic';
export type PythonHeuristicLabel = 'barrel_wildcard' | 'conditional_import' | 'lazy_import';

/** One name binding produced by an import statement. */
export interface PythonImportBinding {
  /** Name bound in the importing module (`import a.b` binds `a`). */
  localName: string;
  /** Dotted name as written (`a.b`, imported name, or `*`). */
  importedName: string;
  /** True when an explicit `as` alias was used. */
  aliased: boolean;
}

/**
 * Raw Python import record. `specifier` keeps the written form including
 * leading dots (`'..pkg.mod'`) so `resolvePythonSpecifier` can consume it.
 * `importedNames`/`localNames` are NOT positionally paired for `import a.b`;
 * use `bindings` for the exact binding pairs.
 */
export interface PythonImportRecord extends ParsedImport {
  form: 'import' | 'from';
  /** Module text without leading dots; `''` for `from . import x`. */
  module: string;
  /** Leading-dot count; `0` for absolute imports. */
  level: number;
  wildcard: boolean;
  context: PythonImportContext;
  provenance: PythonImportProvenance;
  heuristic?: PythonHeuristicLabel;
  /** True when the containing source file is a `.pyi` stub. */
  stub: boolean;
  bindings: PythonImportBinding[];
  /**
   * Qualifying class/function path when the import binds a non-global name
   * (class body or function body). Undefined means the import executes at
   * module scope and may bind a module global. The load edge is still real;
   * only re-export/`from module import name` resolution must ignore scoped
   * records because the name is not a module attribute.
   */
  scope?: string;
}

/** One module-level assignment target. */
export interface PythonAssignment {
  name: string;
  /** Assignment target as written (e.g. `A, B`). */
  target: string;
  line: number;
  /** Inside `try`/`if`/`for`/`while`/`match` at module scope. */
  conditional: boolean;
  /** Inside `if TYPE_CHECKING:` at module scope. */
  typeChecking: boolean;
}

/** Effective literal `__all__` value. */
export interface PythonDunderAll {
  /** Names in first-seen order, deduplicated. */
  names: string[];
  /** False when any contributing statement is not fully literal. */
  literal: boolean;
  line: number;
}

export interface PythonModuleInfo {
  path: string;
  /** Basename without extension; directory name for `__init__.py(i)`. */
  name: string;
  isPackage: boolean;
  isStub: boolean;
}

export interface PythonSyntaxInfo {
  /** Authoritative parser error flag (`rootNode.hasError`). */
  hasError: boolean;
  /**
   * Located `ERROR` / `MISSING` nodes seen by the bounded AST walk. The parser
   * can flag an internal error with no such node, so this may be 0 while
   * `hasError` is true.
   */
  errorCount: number;
  firstErrorLine?: number;
}

export interface PythonBudgetInfo {
  astDepthLimit: number;
  scopeDepthLimit: number;
  depthLimitExceeded: boolean;
  scopeLimitExceeded: boolean;
}

/** Static caveat for `sys.path` mutation; PY-08 must surface it as a caveat. */
export interface PythonSysPathMutation {
  line: number;
  method: 'insert' | 'append' | 'extend' | 'assign';
  reason: string;
}

/** Same `ParsedFile` shape plus Python-specific resolver inputs. */
export interface PythonParsedFile extends ParsedFile {
  language: 'python';
  module: PythonModuleInfo;
  definitions: PythonDefinition[];
  /** Python-specific records; still assignable to `ParsedFile.imports`. */
  imports: PythonImportRecord[];
  assignments: PythonAssignment[];
  dunderAll?: PythonDunderAll;
  sysPathMutations: PythonSysPathMutation[];
  syntax: PythonSyntaxInfo;
  budgets: PythonBudgetInfo;
  /** True for `.pyi`; all import records are type-only. */
  stub: boolean;
}

export interface PythonExtractor {
  parse(file: string, source: string): PythonParsedFile;
  close(): void;
}
export interface PythonExtractorOptions {
  wasmDirectory?: string;
}

const require = createRequire(import.meta.url);
const PYTHON_GRAMMAR = 'tree-sitter-python.wasm';

export const PYTHON_EXTENSIONS = Object.freeze(['.py', '.pyi']);
/** Same AST budget as the TS extractor (ADR-010 / ADR-014 §5.5). */
export const PYTHON_AST_DEPTH_LIMIT = 1000;
export const PYTHON_SCOPE_DEPTH_LIMIT = 16;

const MAX_SCOPE_NODES = 200_000;
const MAX_BLIND_SPOTS = 1000;
const MAX_BLIND_SPOT_NODES = 50_000;
const MAX_LITERAL_STRINGS = 50;
const MAX_TARGET_TEXT = 160;
const MAX_ALL_COLLECTION_DEPTH = 64;

const REGISTRY_NAMES: ReadonlySet<string> = new Set([
  'INSTALLED_APPS',
  'MIDDLEWARE',
  'MIDDLEWARE_CLASSES',
  'ROOT_URLCONF',
  'EXTENSIONS',
  'PLUGINS',
  'entry_points',
]);

let initialized: Promise<void> | undefined;

// ---------------------------------------------------------------------------
// Tree helpers
// ---------------------------------------------------------------------------

function children(node: Node): Node[] {
  return node.namedChildren.filter((item): item is Node => item !== null);
}
function field(node: Node, name: string): Node | undefined {
  return node.childForFieldName(name) ?? undefined;
}
function hasToken(node: Node, type: string): boolean {
  for (let index = 0; index < node.childCount; index += 1) if (node.child(index)?.type === type) return true;
  return false;
}
function lineOf(node: Node): number {
  return node.startPosition.row + 1;
}
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
function unique(values: Iterable<string>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}
function clip(text: string): string {
  return text.length > MAX_TARGET_TEXT ? text.slice(0, MAX_TARGET_TEXT) : text;
}
function qualified(parent: string, name: string): string {
  return parent === '' ? name : `${parent}.${name}`;
}

const STRING_LITERAL = /^([A-Za-z]*)("""|'''|"|')([\s\S]*)\2$/u;

/** Literal text of a plain Python string node, `undefined` for f/b/dynamic forms. */
function pythonString(node: Node | null | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === 'concatenated_string') {
    const parts = children(node).map((item) => pythonString(item));
    if (parts.length === 0) return undefined;
    let text = '';
    for (const part of parts) {
      if (part === undefined) return undefined;
      text += part;
    }
    return text;
  }
  if (node.type !== 'string') return undefined;
  if (children(node).some((item) => item.type === 'interpolation')) return undefined;
  const match = STRING_LITERAL.exec(node.text);
  if (!match) return undefined;
  const prefix = (match[1] ?? '').toLowerCase();
  // f-strings are computed; b-strings cannot name a module.
  if (prefix.includes('f') || prefix.includes('b')) return undefined;
  return match[3] ?? '';
}

/** Fully/partially literal `__all__` value. */
function literalAllNames(node: Node, depth = 0): { names: string[]; complete: boolean } {
  if (depth > MAX_ALL_COLLECTION_DEPTH) return { names: [], complete: false };
  const value = pythonString(node);
  if (value !== undefined) return { names: [value], complete: true };
  if (node.type === 'list' || node.type === 'tuple' || node.type === 'set' || node.type === 'expression_list' || node.type === 'pattern_list') {
    const names: string[] = [];
    let complete = true;
    for (const item of children(node)) {
      if (item.type === 'list_splat' || item.type === 'dictionary_splat' || item.type === 'parenthesized_list_splat') {
        complete = false;
        continue;
      }
      const part = literalAllNames(item, depth + 1);
      names.push(...part.names);
      if (!part.complete) complete = false;
    }
    return { names, complete };
  }
  if (node.type === 'binary_operator' && node.text.includes('+')) {
    const left = field(node, 'left');
    const right = field(node, 'right');
    if (left && right) {
      const leftString = pythonString(left);
      const rightString = pythonString(right);
      if (leftString !== undefined && rightString !== undefined) {
        return { names: [leftString + rightString], complete: true };
      }
      const leftPart = literalAllNames(left, depth + 1);
      const rightPart = literalAllNames(right, depth + 1);
      return { names: [...leftPart.names, ...rightPart.names], complete: leftPart.complete && rightPart.complete };
    }
  }
  if (node.type === 'parenthesized_expression') {
    const inner = children(node)[0];
    return inner ? literalAllNames(inner, depth + 1) : { names: [], complete: false };
  }
  return { names: [], complete: false };
}

/** Literal dotted-ish strings inside a registry-shaped value. */
function literalStrings(node: Node, out: string[], depth = 0): void {
  if (depth > MAX_ALL_COLLECTION_DEPTH || out.length >= MAX_LITERAL_STRINGS) return;
  const value = pythonString(node);
  if (value !== undefined) {
    if (value.includes('.') && value.length <= 200 && !out.includes(value)) out.push(value);
    return;
  }
  if (node.type === 'list' || node.type === 'tuple' || node.type === 'set' || node.type === 'dictionary' || node.type === 'expression_list') {
    for (const item of children(node)) literalStrings(item, out, depth + 1);
  }
}

function isTypeCheckingCondition(node: Node | undefined): boolean {
  if (!node) return false;
  if (node.type === 'identifier') return node.text === 'TYPE_CHECKING';
  if (node.type === 'attribute') return field(node, 'attribute')?.text === 'TYPE_CHECKING';
  if (node.type === 'parenthesized_expression') return isTypeCheckingCondition(children(node)[0]);
  // `if not TYPE_CHECKING:` / boolean combinations are runtime conditions and
  // stay heuristic; they are deliberately not treated as type-only.
  return false;
}

function decoratorNames(node: Node): string[] {
  const names: string[] = [];
  for (const item of children(node)) {
    if (item.type !== 'decorator') continue;
    let expression = children(item)[0];
    if (expression?.type === 'call') expression = field(expression, 'function') ?? children(expression)[0];
    if (expression) names.push(expression.text);
  }
  return unique(names);
}

// ---------------------------------------------------------------------------
// Symbol / import walk (bounded)
// ---------------------------------------------------------------------------

interface ImportContextFlags {
  prefix: string;
  /** Nearest enclosing class qualified name; reset inside functions. */
  className: string | undefined;
  inFunction: boolean;
  typeChecking: boolean;
  /** >0 means the statement is not executed unconditionally at module load. */
  conditional: number;
  scopeDepth: number;
}

interface PythonAllStatement {
  line: number;
  op: 'assign' | 'augment';
  names: string[];
  complete: boolean;
}

interface WalkState {
  file: string;
  stub: boolean;
  definitions: Map<string, PythonDefinition>;
  imports: PythonImportRecord[];
  assignments: PythonAssignment[];
  allStatements: PythonAllStatement[];
  gaps: ScopeSemanticGap[];
  nodesLeft: number;
  localDefinitions: number;
  depthGapRecorded: boolean;
  nodeGapRecorded: boolean;
  depthLimitExceeded: boolean;
  scopeLimitExceeded: boolean;
}

function recordGap(state: WalkState, line: number, pattern: ScopeGapPattern, reason: string): void {
  if (state.gaps.length >= MAX_BLIND_SPOTS) return;
  if (state.gaps.some((gap) => gap.line === line && gap.pattern === pattern && gap.reason === reason)) return;
  state.gaps.push({ line, pattern, reason });
}

function budgetReason(reason: string): string {
  return `${reason} [${STRUCTURE_BUDGET_EXCEEDED}]`;
}

function addDefinition(state: WalkState, definition: PythonDefinition): void {
  const existing = state.definitions.get(definition.qualifiedName);
  if (!existing) {
    state.definitions.set(definition.qualifiedName, definition);
    return;
  }
  existing.startLine = Math.min(existing.startLine, definition.startLine);
  if (definition.kind === 'value') existing.kind = 'value';
  if (definition.decorators?.length) {
    existing.decorators = unique([...(existing.decorators ?? []), ...definition.decorators]);
  }
  if (definition.isAsync) existing.isAsync = true;
  if (definition.typeOnly) existing.typeOnly = true;
  if (definition.stub) existing.stub = true;
	// Unconditional wins: a name bound on at least one unconditional path is
	// importable regardless of the other conditional definitions.
	if (!definition.conditional) delete existing.conditional;
}

function definitionOf(
  name: string,
  qualifiedName: string,
  form: PythonSymbolForm,
  line: number,
  options: { kind?: SymbolKind; isAsync?: boolean; decorators?: string[]; ownerClass?: string; stub?: boolean; typeOnly?: boolean; conditional?: boolean } = {},
): PythonDefinition {
  return {
    name,
    qualifiedName,
    kind: options.kind ?? 'value',
    startLine: line,
    form,
    ...(options.isAsync ? { isAsync: true } : {}),
    ...(options.decorators?.length ? { decorators: options.decorators } : {}),
    ...(options.ownerClass !== undefined ? { ownerClass: options.ownerClass } : {}),
    ...(options.stub ? { stub: true } : {}),
    ...(options.typeOnly ? { typeOnly: true } : {}),
    ...(options.conditional ? { conditional: true } : {}),
  };
}

function importContextOf(context: ImportContextFlags): PythonImportContext {
  if (context.typeChecking) return 'type-checking';
  if (context.inFunction) return 'lazy-import';
  if (context.conditional > 0) return 'conditional-import';
  return 'module';
}

interface Provenance {
  provenance: PythonImportProvenance;
  typeOnly: boolean;
  heuristic?: PythonHeuristicLabel;
}

function provenanceOf(context: PythonImportContext, stub: boolean, wildcard: boolean): Provenance {
  if (stub || context === 'type-checking') return { provenance: 'type-only', typeOnly: true };
  if (context === 'lazy-import') return { provenance: 'heuristic', typeOnly: false, heuristic: 'lazy_import' };
  if (context === 'conditional-import') return { provenance: 'heuristic', typeOnly: false, heuristic: 'conditional_import' };
  if (wildcard) return { provenance: 'heuristic', typeOnly: false, heuristic: 'barrel_wildcard' };
  return { provenance: 'value-confirmed', typeOnly: false };
}

function pushImport(
  state: WalkState,
  context: ImportContextFlags,
  entry: {
    form: 'import' | 'from';
    specifier: string;
    module: string;
    level: number;
    importedNames: string[];
    localNames: string[];
    wildcard: boolean;
    bindings: PythonImportBinding[];
    line: number;
  },
): void {
  const importContext = importContextOf(context);
  const { provenance, typeOnly, heuristic } = provenanceOf(importContext, state.stub, entry.wildcard);
  // A non-global binding: class bodies bind class attributes, function bodies
  // bind locals. The load edge remains, but the name is not a module attribute.
  const scope = context.prefix === '' ? undefined : context.className ?? context.prefix;
  state.imports.push({
    form: entry.form,
    specifier: entry.specifier,
    module: entry.module,
    level: entry.level,
    wildcard: entry.wildcard,
    context: importContext,
    provenance,
    ...(heuristic !== undefined ? { heuristic } : {}),
    ...(scope !== undefined ? { scope } : {}),
    stub: state.stub,
    bindings: entry.bindings,
    importedNames: entry.importedNames,
    localNames: entry.localNames,
    typeOnlyNames: typeOnly ? [...entry.importedNames] : [],
    typeOnly,
    sideEffect: entry.importedNames.length === 0 && !entry.wildcard,
    namespace: entry.form === 'import',
    dynamic: false,
    require: false,
    literal: true,
    line: entry.line,
  });
}

function dottedOf(node: Node | undefined): string {
  return node?.text ?? '';
}

function parseImportStatement(state: WalkState, node: Node, context: ImportContextFlags): void {
  const line = lineOf(node);
  for (const item of children(node)) {
    if (item.type !== 'dotted_name' && item.type !== 'aliased_import') continue;
    const target = item.type === 'aliased_import' ? field(item, 'name') ?? children(item)[0] : item;
    const alias = item.type === 'aliased_import' ? field(item, 'alias') : undefined;
    const module = dottedOf(target);
    if (!module) continue;
    const localName = alias?.text ?? module.split('.')[0] ?? module;
    pushImport(state, context, {
      form: 'import',
      specifier: module,
      module,
      level: 0,
      importedNames: [module],
      localNames: [localName],
      wildcard: false,
      bindings: [{ localName, importedName: module, aliased: alias !== undefined }],
      line,
    });
  }
}

function splitRelative(node: Node | undefined): { module: string; level: number } {
  if (!node) return { module: '', level: 0 };
  if (node.type !== 'relative_import') return { module: node.text, level: 0 };
  const prefix = field(node, 'import_prefix') ?? children(node).find((item) => item.type === 'import_prefix');
  const dotted = children(node).find((item) => item.type === 'dotted_name');
  return { module: dotted?.text ?? '', level: prefix?.text.length ?? 0 };
}

function parseFromImport(state: WalkState, node: Node, context: ImportContextFlags): void {
  const line = lineOf(node);
  const future = node.type === 'future_import_statement';
  const moduleNode = future
    ? undefined
    : field(node, 'module_name') ?? children(node).find((item) => item.type === 'dotted_name' || item.type === 'relative_import');
  const { module, level } = future ? { module: '__future__', level: 0 } : splitRelative(moduleNode);
  const specifier = future ? '__future__' : moduleNode?.text ?? '';
  const importedNames: string[] = [];
  const localNames: string[] = [];
  const bindings: PythonImportBinding[] = [];
  let wildcard = false;
  for (const item of children(node)) {
    // Node wrappers are not reference-identical across calls; compare spans.
    if (moduleNode && item.type === moduleNode.type && item.startIndex === moduleNode.startIndex && item.endIndex === moduleNode.endIndex) continue;
    if (item.type === 'wildcard_import') {
      wildcard = true;
      importedNames.push('*');
      localNames.push('*');
      bindings.push({ localName: '*', importedName: '*', aliased: false });
      continue;
    }
    if (item.type === 'aliased_import') {
      const original = field(item, 'name') ?? children(item)[0];
      const alias = field(item, 'alias');
      const importedName = dottedOf(original);
      if (!importedName) continue;
      const localName = alias?.text ?? importedName;
      importedNames.push(importedName);
      localNames.push(localName);
      bindings.push({ localName, importedName, aliased: alias !== undefined });
      continue;
    }
    if (item.type === 'dotted_name' || item.type === 'identifier') {
      importedNames.push(item.text);
      localNames.push(item.text);
      bindings.push({ localName: item.text, importedName: item.text, aliased: false });
    }
  }
  if (!module && level === 0 && !wildcard && importedNames.length === 0) return;
  pushImport(state, context, {
    form: 'from',
    specifier,
    module,
    level,
    importedNames,
    localNames,
    wildcard,
    bindings,
    line,
  });
}

function assignmentTargets(node: Node | undefined, out: string[]): void {
  if (!node) return;
  switch (node.type) {
    case 'identifier':
      out.push(node.text);
      return;
    case 'pattern_list':
    case 'tuple_pattern':
    case 'list_pattern':
    case 'expression_list':
    case 'tuple':
    case 'list':
    case 'list_splat_pattern':
    case 'list_splat':
    case 'parenthesized_expression':
      for (const item of children(node)) assignmentTargets(item, out);
      return;
    // Attribute/subscript targets mutate an object; they do not bind a module name.
    default:
      return;
  }
}

function recordAllStatement(state: WalkState, op: 'assign' | 'augment', right: Node, line: number): void {
  const literal = literalAllNames(right);
  state.allStatements.push({ line, op, names: literal.names, complete: literal.complete });
}

function handleAssignment(state: WalkState, node: Node, context: ImportContextFlags): void {
  const atModuleLevel = context.prefix === '' && context.scopeDepth === 0 && !context.inFunction;
  if (!atModuleLevel) return;
  const right = field(node, 'right');
  // `X: int` is an annotation without a runtime binding.
  if (!right) return;
  const targets: string[] = [];
  const left = field(node, 'left');
  if (left?.text === '__all__') recordAllStatement(state, 'assign', right, lineOf(node));
  assignmentTargets(left, targets);
  let chained = right;
  while (chained.type === 'assignment') {
    const chainedLeft = field(chained, 'left');
    if (chainedLeft?.text === '__all__') {
      const chainedRight = field(chained, 'right');
      if (chainedRight) recordAllStatement(state, 'assign', chainedRight, lineOf(chained));
    }
    assignmentTargets(chainedLeft, targets);
    const next = field(chained, 'right');
    if (!next) break;
    chained = next;
  }
  const line = lineOf(node);
  for (const name of unique(targets)) {
    addDefinition(state, definitionOf(name, name, 'assignment', line, {
      typeOnly: context.typeChecking,
      stub: state.stub,
      conditional: context.conditional > 0,
    }));
    state.assignments.push({ name, target: left?.text ?? name, line, conditional: context.conditional > 0, typeChecking: context.typeChecking });
  }
}

function handleAugmentedAssignment(state: WalkState, node: Node, context: ImportContextFlags): void {
  const atModuleLevel = context.prefix === '' && context.scopeDepth === 0 && !context.inFunction;
  const left = field(node, 'left');
  const right = field(node, 'right');
  if (!atModuleLevel || !left || !right) return;
  if (left.text !== '__all__') return;
  recordAllStatement(state, 'augment', right, lineOf(node));
}

function handleAllCall(state: WalkState, node: Node, context: ImportContextFlags): void {
  if (context.prefix !== '' || context.scopeDepth !== 0 || context.inFunction) return;
  const fn = field(node, 'function');
  if (fn?.type !== 'attribute') return;
  const object = field(fn, 'object');
  const attribute = field(fn, 'attribute')?.text;
  if (object?.text !== '__all__' || attribute === undefined) return;
  const argumentsNode = field(node, 'arguments');
  const first = argumentsNode ? children(argumentsNode)[0] : undefined;
  if (!first) return;
  if (attribute === 'append') {
    const value = pythonString(first);
    state.allStatements.push(value === undefined
      ? { line: lineOf(node), op: 'augment', names: [], complete: false }
      : { line: lineOf(node), op: 'augment', names: [value], complete: true });
    return;
  }
  if (attribute === 'extend') {
    const literal = literalAllNames(first);
    state.allStatements.push({ line: lineOf(node), op: 'augment', names: literal.names, complete: literal.complete });
    return;
  }
  if (attribute === 'remove' || attribute === 'insert' || attribute === 'clear' || attribute === 'pop') {
    state.allStatements.push({ line: lineOf(node), op: 'augment', names: [], complete: false });
  }
}

function walkNodes(state: WalkState, nodes: Node[], context: ImportContextFlags, depth: number): void {
  for (const node of nodes) walkNode(state, node, context, depth);
}

function walkDefinition(
  state: WalkState,
  node: Node,
  context: ImportContextFlags,
  depth: number,
  decorators: string[],
  decorated: boolean,
): void {
  if (node.type === 'class_definition') {
    const name = field(node, 'name')?.text;
    if (!name) return;
    const qualifiedName = qualified(context.prefix, name);
    addDefinition(state, definitionOf(name, qualifiedName, 'class', lineOf(node), {
      ...(decorators.length ? { decorators } : {}),
      ...(context.typeChecking ? { typeOnly: true } : {}),
      ...(state.stub ? { stub: true } : {}),
      ...(context.conditional > 0 ? { conditional: true } : {}),
    }));
    if (context.inFunction) state.localDefinitions += 1;
    const body = field(node, 'body') ?? children(node).find((item) => item.type === 'block');
    if (!body) return;
    const nextScope = context.scopeDepth + 1;
    if (nextScope > PYTHON_SCOPE_DEPTH_LIMIT) {
      state.scopeLimitExceeded = true;
      recordGap(state, lineOf(node), 'depth-limit', budgetReason(`nested scope deeper than ${PYTHON_SCOPE_DEPTH_LIMIT}`));
      return;
    }
    walkNodes(state, children(body), {
      prefix: qualifiedName,
      className: qualifiedName,
      inFunction: context.inFunction,
      typeChecking: context.typeChecking,
      conditional: context.conditional,
      scopeDepth: nextScope,
    }, depth + 1);
    return;
  }
  if (node.type === 'function_definition') {
    const name = field(node, 'name')?.text;
    if (!name) return;
    const qualifiedName = qualified(context.prefix, name);
    const isAsync = hasToken(node, 'async');
    addDefinition(state, definitionOf(name, qualifiedName, 'function', lineOf(node), {
      isAsync,
      ...(decorators.length ? { decorators } : {}),
      ...(context.className !== undefined ? { ownerClass: context.className } : {}),
      ...(context.typeChecking ? { typeOnly: true } : {}),
      ...(state.stub ? { stub: true } : {}),
      ...(context.conditional > 0 ? { conditional: true } : {}),
    }));
    if (context.inFunction) state.localDefinitions += 1;
    const body = field(node, 'body') ?? children(node).find((item) => item.type === 'block');
    if (!body) return;
    const nextScope = context.scopeDepth + 1;
    if (nextScope > PYTHON_SCOPE_DEPTH_LIMIT) {
      state.scopeLimitExceeded = true;
      recordGap(state, lineOf(node), 'depth-limit', budgetReason(`nested scope deeper than ${PYTHON_SCOPE_DEPTH_LIMIT}`));
      return;
    }
    walkNodes(state, children(body), {
      prefix: qualifiedName,
      className: undefined,
      inFunction: true,
      typeChecking: context.typeChecking,
      conditional: context.conditional,
      scopeDepth: nextScope,
    }, depth + 1);
    return;
  }
}

const CONDITIONAL_CONTAINERS: ReadonlySet<string> = new Set(['for_statement', 'while_statement', 'match_statement', 'try_statement']);
const CLAUSE_TYPES: ReadonlySet<string> = new Set(['elif_clause', 'else_clause', 'except_clause', 'except_group_clause', 'finally_clause', 'case_clause']);

function walkNode(state: WalkState, node: Node, context: ImportContextFlags, depth: number): void {
  if (depth > PYTHON_AST_DEPTH_LIMIT) {
    state.depthLimitExceeded = true;
    if (!state.depthGapRecorded) {
      state.depthGapRecorded = true;
      recordGap(state, lineOf(node), 'depth-limit', budgetReason(`AST walk deeper than ${PYTHON_AST_DEPTH_LIMIT}`));
    }
    return;
  }
  if (state.nodesLeft <= 0) {
    if (!state.nodeGapRecorded) {
      state.nodeGapRecorded = true;
      recordGap(state, lineOf(node), 'depth-limit', budgetReason('nested-scope node budget exhausted'));
    }
    return;
  }
  state.nodesLeft -= 1;

  switch (node.type) {
    case 'decorated_definition': {
      const decorators = decoratorNames(node);
      const inner = children(node).find((item) => item.type === 'class_definition' || item.type === 'function_definition');
      if (inner) walkDefinition(state, inner, context, depth + 1, decorators, true);
      return;
    }
    case 'class_definition':
    case 'function_definition':
      walkDefinition(state, node, context, depth + 1, [], false);
      return;
    case 'import_statement':
      parseImportStatement(state, node, context);
      return;
    case 'import_from_statement':
    case 'future_import_statement':
      parseFromImport(state, node, context);
      return;
    case 'expression_statement':
      for (const item of children(node)) {
        if (item.type === 'assignment') handleAssignment(state, item, context);
        else if (item.type === 'augmented_assignment') handleAugmentedAssignment(state, item, context);
        else if (item.type === 'call') handleAllCall(state, item, context);
      }
      return;
    case 'assignment':
      handleAssignment(state, node, context);
      return;
    case 'augmented_assignment':
      handleAugmentedAssignment(state, node, context);
      return;
    case 'type_alias_statement': {
      const nameNode = children(node).find((item) => item.type === 'type');
      if (!nameNode) return;
      const qualifiedName = qualified(context.prefix, nameNode.text);
      addDefinition(state, definitionOf(nameNode.text, qualifiedName, 'type-alias', lineOf(node), {
        kind: 'type',
        ...(context.className !== undefined ? { ownerClass: context.className } : {}),
        ...(context.typeChecking ? { typeOnly: true } : {}),
        ...(state.stub ? { stub: true } : {}),
        ...(context.conditional > 0 ? { conditional: true } : {}),
      }));
      if (context.inFunction) state.localDefinitions += 1;
      return;
    }
    case 'if_statement': {
      const condition = field(node, 'condition');
      const typeChecking = isTypeCheckingCondition(condition);
      let firstBlock = true;
      for (const item of children(node)) {
        if (item.type === 'block') {
          const consequence = firstBlock;
          firstBlock = false;
          walkNodes(state, children(item), {
            ...context,
            typeChecking: context.typeChecking || (consequence && typeChecking),
            conditional: consequence && typeChecking ? context.conditional : context.conditional + 1,
          }, depth + 1);
        } else if (CLAUSE_TYPES.has(item.type)) {
          walkNodes(state, children(item), { ...context, conditional: context.conditional + 1 }, depth + 1);
        }
      }
      return;
    }
    case 'with_statement': {
      // The body executes at module load; it stays at the current context.
      for (const item of children(node)) {
        if (item.type === 'block') walkNodes(state, children(item), context, depth + 1);
        else if (CLAUSE_TYPES.has(item.type)) walkNodes(state, children(item), { ...context, conditional: context.conditional + 1 }, depth + 1);
      }
      return;
    }
    case 'block':
      walkNodes(state, children(node), context, depth + 1);
      return;
    default:
      if (CONDITIONAL_CONTAINERS.has(node.type)) {
        for (const item of children(node)) {
          if (item.type === 'block') walkNodes(state, children(item), { ...context, conditional: context.conditional + 1 }, depth + 1);
          else if (CLAUSE_TYPES.has(item.type)) walkNodes(state, children(item), { ...context, conditional: context.conditional + 1 }, depth + 1);
        }
        return;
      }
      if (CLAUSE_TYPES.has(node.type)) {
        walkNodes(state, children(node), { ...context, conditional: context.conditional + 1 }, depth + 1);
        return;
      }
      // Expressions and other containers are scanned for nested statements
      // (lambdas cannot contain imports, but future grammar nodes may).
      for (const item of children(node)) walkNode(state, item, context, depth + 1);
  }
}

// ---------------------------------------------------------------------------
// Blind-spot walk (ADR-014 §5.3)
// ---------------------------------------------------------------------------

interface RuntimeAliases {
  importlib: Set<string>;
  importModule: Set<string>;
  sysModules: Set<string>;
  sysPathAliases: Set<string>;
}

function runtimeAliases(imports: PythonImportRecord[]): RuntimeAliases {
  const aliases: RuntimeAliases = {
    importlib: new Set(),
    importModule: new Set(),
    sysModules: new Set(),
    sysPathAliases: new Set(),
  };
  for (const record of imports) {
    if (record.form === 'import') {
      if (record.module === 'importlib' || record.module.startsWith('importlib.')) {
        for (const binding of record.bindings) aliases.importlib.add(binding.localName);
      }
      if (record.module === 'sys' || record.module.startsWith('sys.')) {
        for (const binding of record.bindings) aliases.sysModules.add(binding.localName);
      }
      continue;
    }
    if (record.module === 'importlib') {
      for (const binding of record.bindings) if (binding.importedName === 'import_module') aliases.importModule.add(binding.localName);
    }
    if (record.module === 'sys') {
      for (const binding of record.bindings) if (binding.importedName === 'path') aliases.sysPathAliases.add(binding.localName);
    }
  }
  return aliases;
}

function firstCallArgument(node: Node): Node | undefined {
  const argumentsNode = field(node, 'arguments');
  if (!argumentsNode) return undefined;
  const items = children(argumentsNode);
  const positional = items.find((item) => item.type !== 'keyword_argument' && item.type !== 'dictionary_splat');
  if (positional) return positional;
  const named = items.find((item) => item.type === 'keyword_argument' && field(item, 'name')?.text === 'name');
  return named ? field(named, 'value') : undefined;
}

function isImportlibCall(fn: Node | undefined, aliases: RuntimeAliases): boolean {
  if (!fn) return false;
  if (fn.type === 'identifier') return aliases.importModule.has(fn.text);
  if (fn.type !== 'attribute') return false;
  if (field(fn, 'attribute')?.text !== 'import_module') return false;
  const object = field(fn, 'object');
  return object?.type === 'identifier' && (object.text === 'importlib' || aliases.importlib.has(object.text));
}

function sysPathTarget(text: string, aliases: RuntimeAliases): string | undefined {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)\.path(?:\.|\[|$)/u.exec(text);
  if (!match) return undefined;
  const root = match[1]!;
  if (root === 'sys' || aliases.sysModules.has(root)) return text;
  return undefined;
}

interface BlindSpotResult {
  blindSpots: ParsedBlindSpot[];
  sysPathMutations: PythonSysPathMutation[];
  dynamicLoads: number;
  unresolvedDynamicLoads: number;
  errorCount: number;
  firstErrorLine: number | undefined;
}

function collectBlindSpots(state: WalkState, root: Node): BlindSpotResult {
  const blindSpots: ParsedBlindSpot[] = [];
  const sysPathMutations: PythonSysPathMutation[] = [];
  const seen = new Set<string>();
  const seenSysPath = new Set<string>();
  const aliases = runtimeAliases(state.imports);
  let dynamicLoads = 0;
  let unresolvedDynamicLoads = 0;
  let errorCount = 0;
  let firstErrorLine: number | undefined;
  let budget = MAX_BLIND_SPOT_NODES;

  const push = (spot: ParsedBlindSpot): void => {
    if (blindSpots.length >= MAX_BLIND_SPOTS) return;
    const key = `${spot.line}\0${spot.kind}\0${spot.pattern}\0${spot.target ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    blindSpots.push(spot);
  };
  const pushSysPath = (line: number, method: PythonSysPathMutation['method']): void => {
    const key = `${line}\0${method}`;
    if (seenSysPath.has(key)) return;
    seenSysPath.add(key);
    sysPathMutations.push({ line, method, reason: 'sys.path mutation can change import resolution; static Python resolution may be inaccurate' });
  };

  const visit = (node: Node, depth: number): void => {
    if (depth > PYTHON_AST_DEPTH_LIMIT) {
      state.depthLimitExceeded = true;
      if (!state.depthGapRecorded) {
        state.depthGapRecorded = true;
        recordGap(state, lineOf(node), 'depth-limit', budgetReason(`AST walk deeper than ${PYTHON_AST_DEPTH_LIMIT}`));
      }
      return;
    }
    if (budget <= 0) {
      if (!state.nodeGapRecorded) {
        state.nodeGapRecorded = true;
        recordGap(state, lineOf(node), 'depth-limit', budgetReason('AST walk node budget exhausted'));
      }
      return;
    }
    budget -= 1;
    if (node.isError || node.isMissing) {
      errorCount += 1;
      firstErrorLine ??= lineOf(node);
    }
    if (node.type === 'call') {
      const fn = field(node, 'function');
      const line = lineOf(node);
      const argument = firstCallArgument(node);
      const literal = pythonString(argument);
      if (fn?.type === 'identifier' && fn.text === '__import__') {
        dynamicLoads += 1;
        if (literal === undefined) unresolvedDynamicLoads += 1;
        push({
          kind: 'dynamic-load', tier: 'unknown', line, pattern: 'dynamic-import',
          reason: '__import__() performs a runtime import lookup; no static edge is created',
          ...(literal !== undefined ? { target: literal } : argument !== undefined ? { target: clip(argument.text) } : {}),
        });
      } else if (isImportlibCall(fn, aliases)) {
        dynamicLoads += 1;
        if (literal === undefined) unresolvedDynamicLoads += 1;
        push({
          kind: 'dynamic-load', tier: 'unknown', line, pattern: 'dynamic-import',
          reason: 'importlib.import_module() performs a runtime import lookup; no static edge is created',
          ...(literal !== undefined ? { target: literal } : argument !== undefined ? { target: clip(argument.text) } : {}),
        });
      } else if (fn?.type === 'identifier' && (fn.text === 'exec' || fn.text === 'eval')) {
        push({ kind: 'eval', tier: 'unknown', line, pattern: 'eval', reason: `${fn.text}() executes computed code; no static edge is possible` });
      } else if (fn?.type === 'identifier' && fn.text === 'getattr') {
        push({ kind: 'reflection', tier: 'unknown', line, pattern: 'reflection', reason: 'getattr() resolves an attribute name at runtime; no static edge is possible' });
      } else if (fn?.type === 'attribute' && fn.text === 'builtins.getattr') {
        push({ kind: 'reflection', tier: 'unknown', line, pattern: 'reflection', reason: 'builtins.getattr() resolves an attribute name at runtime; no static edge is possible' });
      } else if (fn) {
        const text = fn.text;
        const sysPath = sysPathTarget(text, aliases);
        if (sysPath !== undefined) {
          const method = /\.(insert|append|extend)$/u.exec(text)?.[1];
          if (method === 'insert' || method === 'append' || method === 'extend') pushSysPath(line, method);
        } else if (fn.type === 'identifier' && aliases.sysPathAliases.has(text)) {
          const method = /^(insert|append|extend)$/u.exec(text)?.[1];
          if (method === 'insert' || method === 'append' || method === 'extend') pushSysPath(line, method);
        }
      }
    } else if (node.type === 'assignment' || node.type === 'augmented_assignment') {
      const left = field(node, 'left');
      if (left) {
        if (sysPathTarget(left.text, aliases) !== undefined || (left.type === 'identifier' && aliases.sysPathAliases.has(left.text))) {
          pushSysPath(lineOf(node), 'assign');
        }
        if (left.type === 'identifier' && REGISTRY_NAMES.has(left.text)) {
          const right = field(node, 'right');
          const values: string[] = [];
          if (right) literalStrings(right, values);
          for (const value of unique(values)) {
            push({
              kind: 'registry-scan', tier: 'unknown', line: lineOf(node), pattern: 'registry-scan',
              reason: 'string registry can load modules at runtime; registry entries are not followed statically',
              target: value,
            });
          }
        }
      }
    }
    for (const item of children(node)) visit(item, depth + 1);
  };

  visit(root, 0);
  return {
    blindSpots: blindSpots.sort((left, right) => left.line - right.line
      || compareText(left.kind, right.kind)
      || compareText(left.pattern, right.pattern)
      || compareText(left.target ?? '', right.target ?? '')),
    sysPathMutations: sysPathMutations.sort((left, right) => left.line - right.line || compareText(left.method, right.method)),
    dynamicLoads,
    unresolvedDynamicLoads,
    errorCount,
    firstErrorLine,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function grammarFor(file: string): string | undefined {
  return PYTHON_EXTENSIONS.find((extension) => file.toLowerCase().endsWith(extension));
}

function isStubFile(file: string): boolean {
  return file.toLowerCase().endsWith('.pyi');
}

function moduleInfo(file: string, stub: boolean): PythonModuleInfo {
  const base = basename(file).replace(/\.pyi?$/u, '');
  const isPackage = base === '__init__';
  const name = isPackage ? basename(dirname(file)) : base;
  return { path: file, name, isPackage, isStub: stub };
}

function effectiveDunderAll(statements: PythonAllStatement[]): PythonDunderAll | undefined {
  if (statements.length === 0) return undefined;
  let names: string[] = [];
  let literal = true;
  let initialized = false;
  for (const statement of statements) {
    if (statement.op === 'assign') {
      names = [...statement.names];
      literal = statement.complete;
      initialized = true;
      continue;
    }
    if (!initialized || !literal || !statement.complete) literal = false;
    names.push(...statement.names);
  }
  return { names: unique(names), literal, line: statements[0]!.line };
}

function parseFile(parser: Parser, file: string, source: string): PythonParsedFile {
  const tree = parser.parse(source);
  if (!tree) throw new Error(`No parse tree for ${file}`);
  const stub = isStubFile(file);
  try {
    const state: WalkState = {
      file,
      stub,
      definitions: new Map(),
      imports: [],
      assignments: [],
      allStatements: [],
      gaps: [],
      nodesLeft: MAX_SCOPE_NODES,
      localDefinitions: 0,
      depthGapRecorded: false,
      nodeGapRecorded: false,
      depthLimitExceeded: false,
      scopeLimitExceeded: false,
    };
    walkNodes(state, children(tree.rootNode), {
      prefix: '',
      className: undefined,
      inFunction: false,
      typeChecking: false,
      conditional: 0,
      scopeDepth: 0,
    }, 0);
    const blind = collectBlindSpots(state, tree.rootNode);
    const definitions = [...state.definitions.values()].sort((left, right) => left.startLine - right.startLine
      || compareText(left.qualifiedName, right.qualifiedName));
    const declarationCount = definitions.length;
    const scope: ScopeExtraction = {
      iifeCount: 0,
      localDefinitions: state.localDefinitions,
      localMembers: 0,
      zeroDeclaration: declarationCount === 0,
      zeroStaticDependency: declarationCount > 0 && state.imports.length === 0,
      semanticGaps: [...state.gaps].sort((left, right) => left.line - right.line || compareText(left.pattern, right.pattern)),
    };
    const dunderAll = effectiveDunderAll(state.allStatements);
    return {
      file,
      language: 'python',
      module: moduleInfo(file, stub),
      stub,
      definitions,
      namedExports: [],
      imports: state.imports.sort((left, right) => left.line - right.line
        || compareText(left.specifier ?? '', right.specifier ?? '')
        || compareText(left.bindings.map((binding) => binding.localName).join(','), right.bindings.map((binding) => binding.localName).join(','))),
      assignments: state.assignments.sort((left, right) => left.line - right.line || compareText(left.name, right.name)),
      ...(dunderAll !== undefined ? { dunderAll } : {}),
      dynamicLoads: blind.dynamicLoads,
      unresolvedDynamicLoads: blind.unresolvedDynamicLoads,
      sysPathMutations: blind.sysPathMutations,
      scope,
      blindSpots: blind.blindSpots,
      syntax: {
        hasError: tree.rootNode.hasError,
        errorCount: blind.errorCount,
        ...(blind.firstErrorLine !== undefined ? { firstErrorLine: blind.firstErrorLine } : {}),
      },
      budgets: {
        astDepthLimit: PYTHON_AST_DEPTH_LIMIT,
        scopeDepthLimit: PYTHON_SCOPE_DEPTH_LIMIT,
        depthLimitExceeded: state.depthLimitExceeded,
        scopeLimitExceeded: state.scopeLimitExceeded,
      },
    };
  } finally {
    tree.delete();
  }
}

export async function createPythonExtractor(options: PythonExtractorOptions = {}): Promise<PythonExtractor> {
  initialized ??= Parser.init(options.wasmDirectory
    ? { locateFile: (name: string) => join(options.wasmDirectory!, basename(name)) }
    : undefined);
  await initialized;
  const wasmPath = options.wasmDirectory
    ? join(options.wasmDirectory, PYTHON_GRAMMAR)
    : require.resolve(`tree-sitter-wasms/out/${PYTHON_GRAMMAR}`);
  const language = await Language.load(wasmPath);
  let parser: Parser | undefined = new Parser();
  parser.setLanguage(language);
  return {
    parse(file, source) {
      if (!parser || !grammarFor(file)) throw new Error(`Unsupported extension: ${file}`);
      return parseFile(parser, file, source);
    },
    close() {
      parser?.delete();
      parser = undefined;
    },
  };
}
