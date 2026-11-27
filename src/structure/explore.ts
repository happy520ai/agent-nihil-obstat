import { readFile as readFileFromDisk } from 'node:fs/promises';
import { join } from 'node:path';
import type { CallEdge, Freshness, GraphCaveats, GraphEdge, GraphSnapshot, SymbolNode } from './types.ts';

/**
 * Library-level explore primitives. Surface/Gate callers get graph revision,
 * freshness, caveats and an output-char budget with every result. The budget is
 * an output-size cap, never a match count: `totalMatches` is computed before the
 * result is trimmed and can therefore be larger than both `returned` and the
 * budget itself.
 */

export const DEFAULT_EXPLORE_BUDGET = 8000;

export interface ExploreOptions {
  /** Freshness from the store; explore itself never pretends a graph is fresh. */
  freshness: Freshness;
  maxOutputChars?: number;
  root?: string;
  /** Project-relative source reader seam; root is used when omitted. */
  readSource?: (projectPath: string) => Promise<string>;
  includeHeuristicCalls?: boolean;
}

export interface ExploreBudget {
  limitChars: number;
  usedChars: number;
  unit: 'characters';
  semantics: 'output-size';
  truncated: boolean;
}

export interface ExploreMeta {
  graphRevision: string;
  freshness: Freshness;
  caveats: GraphCaveats;
  budget: ExploreBudget;
  totalMatches: number;
  returned: number;
  notes: string[];
}

export interface ExploreResult<T> {
  meta: ExploreMeta;
  data: T;
}

export interface SourceSnippet {
  file: string;
  startLine: number;
  endLine: number;
  text: string;
}

export interface SymbolHit extends SymbolNode {
  snippet?: SourceSnippet;
}

function budgetLimit(options: ExploreOptions): number {
  const raw = options.maxOutputChars ?? DEFAULT_EXPLORE_BUDGET;
  return Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : DEFAULT_EXPLORE_BUDGET;
}

function jsonLength(value: unknown): number {
  return JSON.stringify(value)?.length ?? 0;
}

/** Keeps the largest prefix of `items` whose wrapped JSON fits the char budget. */
function fitList<T>(items: T[], maxChars: number, wrap: (items: T[]) => unknown): { items: T[]; usedChars: number; truncated: boolean } {
  const full = jsonLength(wrap(items));
  if (items.length === 0 || full <= maxChars) return { items, usedChars: full, truncated: false };
  let low = 0;
  let high = items.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (jsonLength(wrap(items.slice(0, mid))) <= maxChars) low = mid;
    else high = mid - 1;
  }
  const kept = items.slice(0, low);
  return { items: kept, usedChars: jsonLength(wrap(kept)), truncated: true };
}

function baseMeta(snapshot: GraphSnapshot, options: ExploreOptions, usedChars: number, truncated: boolean, totalMatches: number, returned: number, notes: string[] = []): ExploreMeta {
  const limit = budgetLimit(options);
  return {
    graphRevision: snapshot.revision,
    freshness: options.freshness,
    caveats: snapshot.caveats,
    budget: {
      limitChars: limit,
      usedChars,
      unit: 'characters',
      semantics: 'output-size',
      truncated: truncated || usedChars > limit,
    },
    totalMatches,
    returned,
    notes,
  };
}

interface SourceReader {
  read(file: string, line: number, radius?: number): Promise<SourceSnippet | undefined>;
  available: boolean;
}

async function createReader(options: ExploreOptions): Promise<SourceReader> {
  const cache = new Map<string, string | undefined>();
  const available = options.readSource !== undefined || options.root !== undefined;
  const load = async (file: string): Promise<string | undefined> => {
    if (cache.has(file)) return cache.get(file);
    let text: string | undefined;
    try {
      text = options.readSource !== undefined
        ? await options.readSource(file)
        : options.root !== undefined ? await readFileFromDisk(join(options.root, file), 'utf8') : undefined;
    } catch {
      text = undefined;
    }
    cache.set(file, text);
    return text;
  };
  return {
    available,
    async read(file, line, radius = 3) {
      const text = await load(file);
      if (text === undefined) return undefined;
      const lines = text.split(/\r?\n/);
      if (line < 1 || line > lines.length) return undefined;
      const startLine = Math.max(1, line - radius);
      const endLine = Math.min(lines.length, line + radius);
      return {
        file,
        startLine,
        endLine,
        text: lines.slice(startLine - 1, endLine).map((content, index) => `${startLine + index}| ${content}`).join('\n'),
      };
    },
  };
}

function sortSymbols(symbols: SymbolNode[]): SymbolNode[] {
  return [...symbols].sort((a, b) => a.file.localeCompare(b.file)
    || a.startLine - b.startLine
    || a.qualifiedName.localeCompare(b.qualifiedName)
    || a.id.localeCompare(b.id));
}

function matchText(symbol: SymbolNode, text: string): number {
  if (symbol.id === text) return 0;
  if (symbol.qualifiedName === text) return 1;
  if (symbol.name === text) return 2;
  const lower = text.toLowerCase();
  if (symbol.qualifiedName.toLowerCase().startsWith(lower)) return 3;
  if (symbol.qualifiedName.toLowerCase().includes(lower)) return 4;
  if (symbol.file.toLowerCase().includes(lower)) return 5;
  return -1;
}

export function searchSymbols(snapshot: GraphSnapshot, text: string): SymbolNode[] {
  return sortSymbols(snapshot.symbols.filter((symbol) => matchText(symbol, text) >= 0));
}

function callEdges(snapshot: GraphSnapshot, includeHeuristic: boolean): CallEdge[] {
  return (snapshot.calls ?? []).filter((edge) => includeHeuristic || edge.provenance === 'resolved');
}

export interface SymbolQuery {
  text?: string;
  id?: string;
  file?: string;
  includeEdges?: boolean;
  includeSnippet?: boolean;
}

export interface SymbolRelation {
  incomingCalls: CallEdge[];
  outgoingCalls: CallEdge[];
  importEdges: GraphEdge[];
}

export interface SymbolHitResult extends SymbolHit {
  relations?: SymbolRelation;
}

export interface SymbolData {
  query: SymbolQuery;
  symbols: SymbolHitResult[];
}

export async function exploreSymbol(snapshot: GraphSnapshot, query: SymbolQuery, options: ExploreOptions): Promise<ExploreResult<SymbolData>> {
  const reader = await createReader(options);
  const matches = query.id !== undefined
    ? snapshot.symbols.filter((symbol) => symbol.id === query.id)
    : query.file !== undefined
      ? snapshot.symbols.filter((symbol) => symbol.file === query.file && (query.text === undefined || matchText(symbol, query.text) >= 0))
      : query.text !== undefined ? searchSymbols(snapshot, query.text) : [];
  const totalMatches = matches.length;
  const includeSnippet = query.includeSnippet !== false && reader.available;
  const includeEdges = query.includeEdges === true;
  const hits: SymbolHitResult[] = [];
  for (const symbol of matches) {
    const hit: SymbolHitResult = { ...symbol };
    if (includeSnippet) {
      const snippet = await reader.read(symbol.file, symbol.startLine, 2);
      if (snippet) hit.snippet = snippet;
    }
    if (includeEdges) {
      hit.relations = {
        incomingCalls: (snapshot.calls ?? []).filter((edge) => edge.calleeSymbolId === symbol.id),
        outgoingCalls: (snapshot.calls ?? []).filter((edge) => edge.callerSymbolId === symbol.id),
        importEdges: snapshot.edges.filter((edge) => edge.from === symbol.file || edge.to === symbol.file),
      };
    }
    hits.push(hit);
  }
  const fit = fitList(hits, budgetLimit(options), (items) => ({ query, symbols: items }));
  const notes: string[] = [];
  if (!reader.available) notes.push('no-source-provider:snippets-omitted');
  return {
    meta: baseMeta(snapshot, options, fit.usedChars, fit.truncated, totalMatches, fit.items.length, notes),
    data: { query, symbols: fit.items },
  };
}

export interface SearchQuery {
  query: string;
  /** Optional hard output cap. `totalMatches` still reports the full hit count. */
  limit?: number;
}

export type SearchEntry =
  | { kind: 'symbol'; symbol: SymbolHit }
  | { kind: 'file'; file: string };

export interface SearchData {
  query: string;
  entries: SearchEntry[];
  totalSymbols: number;
  totalFiles: number;
}

export async function exploreSearch(snapshot: GraphSnapshot, query: SearchQuery, options: ExploreOptions): Promise<ExploreResult<SearchData>> {
  const symbols = searchSymbols(snapshot, query.query);
  const files = Object.keys(snapshot.files).filter((file) => file.toLowerCase().includes(query.query.toLowerCase())).sort();
  const allEntries: SearchEntry[] = [
    ...symbols.map((symbol) => ({ kind: 'symbol' as const, symbol })),
    ...files.map((file) => ({ kind: 'file' as const, file })),
  ];
  const capped = query.limit !== undefined ? allEntries.slice(0, Math.max(0, query.limit)) : allEntries;
  const fit = fitList(capped, budgetLimit(options), (items) => ({ query: query.query, entries: items }));
  const totalMatches = allEntries.length;
  return {
    meta: baseMeta(snapshot, options, fit.usedChars, fit.truncated || capped.length < allEntries.length, totalMatches, fit.items.length),
    data: {
      query: query.query,
      entries: fit.items,
      totalSymbols: symbols.length,
      totalFiles: files.length,
    },
  };
}

export interface OutlineQuery { file: string }

export interface OutlineData {
  file: string;
  symbols: SymbolHit[];
}

export async function exploreOutline(snapshot: GraphSnapshot, query: OutlineQuery, options: ExploreOptions): Promise<ExploreResult<OutlineData>> {
  const reader = await createReader(options);
  const symbols = sortSymbols(snapshot.symbols.filter((symbol) => symbol.file === query.file));
  const hits: SymbolHit[] = [];
  if (reader.available) {
    for (const symbol of symbols) {
      const snippet = await reader.read(symbol.file, symbol.startLine, 0);
      hits.push(snippet ? { ...symbol, snippet } : { ...symbol });
    }
  } else hits.push(...symbols);
  const fit = fitList(hits, budgetLimit(options), (items) => ({ file: query.file, symbols: items }));
  const notes = reader.available ? [] : ['no-source-provider:snippets-omitted'];
  return {
    meta: baseMeta(snapshot, options, fit.usedChars, fit.truncated, symbols.length, fit.items.length, notes),
    data: { file: query.file, symbols: fit.items },
  };
}

export interface FlowQuery {
  from?: string;
  to?: string;
  maxDepth?: number;
  maxPaths?: number;
}

export interface FlowStep {
  fromFile: string;
  toFile: string;
  callee: string;
  line: number;
  provenance: CallEdge['provenance'];
  label: CallEdge['label'];
  callerSymbolId?: string;
  calleeSymbolId?: string;
  calleeQualifiedName?: string;
  callSnippet?: SourceSnippet;
  definitionSnippet?: SourceSnippet;
}

export interface FlowPath {
  start: string;
  target: string;
  steps: FlowStep[];
}

export interface FlowData {
  from: string;
  to: string;
  paths: FlowPath[];
  enumerationLimitReached: boolean;
}

interface Anchor { files: Set<string>; symbols: Set<string>; exactSymbol: boolean }

function resolveAnchor(snapshot: GraphSnapshot, text: string | undefined): Anchor {
  const files = new Set<string>();
  const symbols = new Set<string>();
  let exactSymbol = false;
  if (text === undefined || text.length === 0) return { files, symbols, exactSymbol };
  if (snapshot.files[text] !== undefined) files.add(text);
  const exact = snapshot.symbols.find((symbol) => symbol.id === text || symbol.qualifiedName === text || symbol.name === text);
  if (exact) {
    symbols.add(exact.id);
    files.add(exact.file);
    exactSymbol = true;
  } else {
    for (const file of Object.keys(snapshot.files)) if (file.includes(text)) files.add(file);
    for (const symbol of snapshot.symbols) {
      if (symbol.qualifiedName.includes(text) || symbol.name.includes(text)) symbols.add(symbol.id);
    }
  }
  return { files, symbols, exactSymbol };
}

function callerNode(edge: CallEdge): string {
  return edge.callerSymbolId ? `symbol:${edge.callerSymbolId}` : `file:${edge.from}`;
}

function calleeNode(edge: CallEdge): string {
  return edge.calleeSymbolId ? `symbol:${edge.calleeSymbolId}` : `file:${edge.to}`;
}

function edgeMatchesTarget(edge: CallEdge, target: Anchor, symbolFiles: Map<string, string>): boolean {
  if (edge.calleeSymbolId !== undefined) {
    if (target.symbols.has(edge.calleeSymbolId)) return true;
    const file = symbolFiles.get(edge.calleeSymbolId);
    if (!target.exactSymbol && file !== undefined && target.files.has(file)) return true;
  }
  if (!target.exactSymbol && target.files.has(edge.to)) return true;
  return false;
}

function pathKey(path: CallEdge[]): string {
  return path.map((edge) => `${edge.from}>${edge.to}@${edge.line}:${edge.callee}`).join('|');
}

export async function exploreFlow(snapshot: GraphSnapshot, query: FlowQuery, options: ExploreOptions): Promise<ExploreResult<FlowData>> {
  const source = resolveAnchor(snapshot, query.from);
  const target = resolveAnchor(snapshot, query.to);
  const maxDepth = Math.min(12, Math.max(1, query.maxDepth ?? 6));
  const maxPaths = Math.min(500, Math.max(1, query.maxPaths ?? 200));
  const includeHeuristic = options.includeHeuristicCalls === true;
  const edges = callEdges(snapshot, includeHeuristic);
  const symbolFiles = new Map(snapshot.symbols.map((symbol) => [symbol.id, symbol.file]));
  const bySymbol = new Map<string, CallEdge[]>();
  const byFile = new Map<string, CallEdge[]>();
  for (const edge of edges) {
    if (edge.callerSymbolId !== undefined) {
      const list = bySymbol.get(edge.callerSymbolId) ?? [];
      list.push(edge);
      bySymbol.set(edge.callerSymbolId, list);
    }
    if (edge.callerSymbolId === undefined) {
      const list = byFile.get(edge.from) ?? [];
      list.push(edge);
      byFile.set(edge.from, list);
    }
  }
  const outgoing = (node: string): CallEdge[] => node.startsWith('symbol:')
    ? bySymbol.get(node.slice(7)) ?? []
    : byFile.get(node.slice(5)) ?? [];

  const startNodes = new Set<string>();
  for (const symbol of source.symbols) startNodes.add(`symbol:${symbol}`);
  for (const symbol of snapshot.symbols) if (source.files.has(symbol.file)) startNodes.add(`symbol:${symbol.id}`);
  for (const file of source.files) startNodes.add(`file:${file}`);

  const found: CallEdge[][] = [];
  let enumerationLimitReached = false;
  const walk = (node: string, path: CallEdge[], visited: Set<string>): void => {
    if (found.length >= maxPaths) { enumerationLimitReached = true; return; }
    if (path.length >= maxDepth) return;
    for (const edge of outgoing(node)) {
      const next = calleeNode(edge);
      if (visited.has(next)) continue;
      const extended = [...path, edge];
      if (edgeMatchesTarget(edge, target, symbolFiles)) {
        found.push(extended);
        if (found.length >= maxPaths) { enumerationLimitReached = true; return; }
        continue;
      }
      const nextVisited = new Set(visited);
      nextVisited.add(next);
      walk(next, extended, nextVisited);
      if (found.length >= maxPaths) { enumerationLimitReached = true; return; }
    }
  };
  for (const start of startNodes) {
    walk(start, [], new Set([start]));
    if (found.length >= maxPaths) break;
  }

  const unique = new Map<string, CallEdge[]>();
  for (const path of found) unique.set(pathKey(path), path);
  const paths = [...unique.values()];
  const reader = await createReader(options);
  const details: FlowPath[] = [];
  for (const path of paths) {
    const steps: FlowStep[] = [];
    for (const edge of path) {
      const step: FlowStep = {
        fromFile: edge.from,
        toFile: edge.to,
        callee: edge.callee,
        line: edge.line,
        provenance: edge.provenance,
        label: edge.label,
        ...(edge.callerSymbolId !== undefined ? { callerSymbolId: edge.callerSymbolId } : {}),
        ...(edge.calleeSymbolId !== undefined ? { calleeSymbolId: edge.calleeSymbolId } : {}),
        ...(edge.calleeQualifiedName !== undefined ? { calleeQualifiedName: edge.calleeQualifiedName } : {}),
      };
      const callSnippet = await reader.read(edge.from, edge.line, 2);
      if (callSnippet) step.callSnippet = callSnippet;
      if (edge.calleeSymbolId !== undefined) {
        const definition = snapshot.symbols.find((symbol) => symbol.id === edge.calleeSymbolId);
        if (definition) {
          const definitionSnippet = await reader.read(definition.file, definition.startLine, 2);
          if (definitionSnippet) step.definitionSnippet = definitionSnippet;
        }
      }
      steps.push(step);
    }
    details.push({ start: path[0] ? callerNode(path[0]) : '', target: path[path.length - 1] ? calleeNode(path[path.length - 1]!) : '', steps });
  }
  const fit = fitList(details, budgetLimit(options), (items) => ({ paths: items }));
  const notes: string[] = [];
  if (!reader.available) notes.push('no-source-provider:snippets-omitted');
  if (enumerationLimitReached) notes.push(`path-enumeration-limit:${maxPaths}`);
  if (!includeHeuristic) notes.push('resolved-call-edges-only');
  return {
    meta: baseMeta(snapshot, options, fit.usedChars, fit.truncated, paths.length, fit.items.length, notes),
    data: { from: query.from ?? '', to: query.to ?? '', paths: fit.items, enumerationLimitReached },
  };
}

export interface ImpactQuery {
  touched: string[];
}

export interface ImpactData {
  touched: string[];
  impactedFiles: string[];
  callerFiles: string[];
  callerSymbols: string[];
}

function reverseClosure(map: Map<string, string[]>, roots: Iterable<string>): Set<string> {
  const found = new Set(roots);
  const queue = [...found];
  for (let index = 0; index < queue.length; index += 1) {
    for (const caller of map.get(queue[index]!) ?? []) {
      if (!found.has(caller)) {
        found.add(caller);
        queue.push(caller);
      }
    }
  }
  return found;
}

export async function exploreImpact(snapshot: GraphSnapshot, query: ImpactQuery, options: ExploreOptions): Promise<ExploreResult<ImpactData>> {
  const touched = [...query.touched].sort();
  const importReverse = new Map<string, string[]>();
  for (const edge of snapshot.edges) {
    const callers = importReverse.get(edge.to) ?? [];
    callers.push(edge.from);
    importReverse.set(edge.to, callers);
  }
  const impactedFiles = [...reverseClosure(importReverse, touched)].sort();

  const callEdgesAll = callEdges(snapshot, options.includeHeuristicCalls !== false);
  const reverseCallFile = new Map<string, string[]>();
  const reverseCallSymbol = new Map<string, string[]>();
  for (const edge of callEdgesAll) {
    const fileCallers = reverseCallFile.get(edge.to) ?? [];
    fileCallers.push(edge.from);
    reverseCallFile.set(edge.to, fileCallers);
    if (edge.calleeSymbolId !== undefined && edge.callerSymbolId !== undefined) {
      const symbolCallers = reverseCallSymbol.get(edge.calleeSymbolId) ?? [];
      symbolCallers.push(edge.callerSymbolId);
      reverseCallSymbol.set(edge.calleeSymbolId, symbolCallers);
    }
  }
  const initialSymbols = snapshot.symbols.filter((symbol) => touched.includes(symbol.file)).map((symbol) => symbol.id);
  const callerFiles = [...reverseClosure(reverseCallFile, touched)].sort();
  const callerSymbols = [...reverseClosure(reverseCallSymbol, initialSymbols)].sort();

  const entries: SearchEntry[] = [
    ...impactedFiles.map((file) => ({ kind: 'file' as const, file })),
    ...callerFiles.map((file) => ({ kind: 'file' as const, file })),
    ...callerSymbols.map((id) => ({ kind: 'symbol' as const, symbol: { ...(snapshot.symbols.find((symbol) => symbol.id === id) ?? { id, file: '', name: id, qualifiedName: id, symbolKind: 'value' as const, startLine: 0 }) } })),
  ];
  const fit = fitList(entries, budgetLimit(options), (items) => ({ touched, entries: items }));
  return {
    meta: baseMeta(snapshot, options, fit.usedChars, fit.truncated, entries.length, fit.items.length),
    data: {
      touched,
      impactedFiles,
      callerFiles,
      callerSymbols,
    },
  };
}

export interface ExploreQuery {
  task: string;
  symbols?: string[];
  files?: string[];
  touchedFiles?: string[];
  flow?: { from?: string; to?: string };
}

export interface ExploreData {
  task: string;
  symbols?: SymbolData & { totalMatches: number; returned: number };
  search?: SearchData & { totalMatches: number; returned: number };
  outline?: OutlineData & { totalMatches: number; returned: number };
  impact?: ImpactData & { totalMatches: number; returned: number };
  flow?: FlowData & { totalMatches: number; returned: number };
  totals: { symbols: number; search: number; outline: number; impact: number; flow: number };
}

const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'does', 'what', 'where', 'why', 'how', 'which', 'code', 'file', 'test', 'please']);

function candidatesFromTask(task: string): string[] {
  const matches = task.match(/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/g) ?? [];
  return [...new Set(matches.filter((name) => name.length > 2 && !STOP_WORDS.has(name.toLowerCase())))].slice(0, 12);
}

function filesFromTask(task: string): string[] {
  return [...new Set(task.match(/[\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs)/g) ?? [])];
}

/**
 * Orchestrates symbol/search/outline/impact/flow for a task description. Each
 * section gets a char share; the final combined payload is trimmed if needed.
 * Section `totalMatches` values stay at their pre-trim values.
 */
export async function explore(snapshot: GraphSnapshot, query: ExploreQuery, options: ExploreOptions): Promise<ExploreResult<ExploreData>> {
  const limit = budgetLimit(options);
  const candidates = query.symbols ?? candidatesFromTask(query.task);
  const files = query.files ?? filesFromTask(query.task);
  const sectionCount = 3 + (files.length > 0 ? 1 : 0) + (query.flow !== undefined || candidates.length >= 2 ? 1 : 0);
  const share = Math.max(0, Math.floor((limit - 100 * sectionCount) / Math.max(1, sectionCount)));
  const sectionOptions: ExploreOptions = { ...options, maxOutputChars: share };

  let searchResult: ExploreResult<SearchData> | undefined;
  for (const candidate of candidates.slice(0, 4)) {
    const attempt = await exploreSearch(snapshot, { query: candidate }, sectionOptions);
    if (attempt.meta.totalMatches > 0) { searchResult = attempt; break; }
  }
  searchResult ??= await exploreSearch(snapshot, { query: candidates[0] ?? query.task }, sectionOptions);

  const symbolResult = await exploreSymbol(snapshot, { text: candidates[0] ?? query.task, includeEdges: true }, sectionOptions);

  const outlineResult = files[0] !== undefined
    ? await exploreOutline(snapshot, { file: files[0] }, sectionOptions)
    : undefined;

  const touched = query.touchedFiles ?? files;
  const impactResult = touched.length > 0
    ? await exploreImpact(snapshot, { touched }, sectionOptions)
    : undefined;

  const flowInput: FlowQuery | undefined = query.flow ?? (candidates.length >= 2 ? { from: candidates[0]!, to: candidates[1]! } : undefined);
  const flowResult = flowInput !== undefined
    ? await exploreFlow(snapshot, flowInput, sectionOptions)
    : undefined;

  const data: ExploreData = {
    task: query.task,
    symbols: { ...symbolResult.data, totalMatches: symbolResult.meta.totalMatches, returned: symbolResult.meta.returned },
    search: { ...searchResult.data, totalMatches: searchResult.meta.totalMatches, returned: searchResult.meta.returned },
    ...(outlineResult !== undefined ? { outline: { ...outlineResult.data, totalMatches: outlineResult.meta.totalMatches, returned: outlineResult.meta.returned } } : {}),
    ...(impactResult !== undefined ? { impact: { ...impactResult.data, totalMatches: impactResult.meta.totalMatches, returned: impactResult.meta.returned } } : {}),
    ...(flowResult !== undefined ? { flow: { ...flowResult.data, totalMatches: flowResult.meta.totalMatches, returned: flowResult.meta.returned } } : {}),
    totals: {
      symbols: symbolResult.meta.totalMatches,
      search: searchResult.meta.totalMatches,
      outline: outlineResult?.meta.totalMatches ?? 0,
      impact: impactResult?.meta.totalMatches ?? 0,
      flow: flowResult?.meta.totalMatches ?? 0,
    },
  };

  const trim = (): boolean => {
    if (data.flow !== undefined && data.flow.paths.length > 0) { data.flow.paths.pop(); data.flow.returned = data.flow.paths.length; return true; }
    if (data.outline !== undefined && data.outline.symbols.length > 0) { data.outline.symbols.pop(); data.outline.returned = data.outline.symbols.length; return true; }
    if (data.impact !== undefined && data.impact.callerSymbols.length > 0) { data.impact.callerSymbols.pop(); data.impact.returned = Math.max(0, data.impact.returned - 1); return true; }
    if (data.search !== undefined && data.search.entries.length > 0) { data.search.entries.pop(); data.search.returned = data.search.entries.length; return true; }
    if (data.symbols !== undefined && data.symbols.symbols.length > 0) { data.symbols.symbols.pop(); data.symbols.returned = data.symbols.symbols.length; return true; }
    if (data.impact !== undefined && data.impact.impactedFiles.length > 0) { data.impact.impactedFiles.pop(); data.impact.returned = Math.max(0, data.impact.returned - 1); return true; }
    if (data.impact !== undefined && data.impact.callerFiles.length > 0) { data.impact.callerFiles.pop(); data.impact.returned = Math.max(0, data.impact.returned - 1); return true; }
    return false;
  };
  let used = jsonLength(data);
  while (used > limit && trim()) used = jsonLength(data);
  const totalMatches = Object.values(data.totals).reduce((sum, value) => sum + value, 0);
  const returned = (data.symbols?.returned ?? 0) + (data.search?.returned ?? 0) + (data.outline?.returned ?? 0)
    + (data.impact?.returned ?? 0) + (data.flow?.returned ?? 0);
  return {
    meta: baseMeta(snapshot, options, used, used > limit || returned < totalMatches, totalMatches, returned, []),
    data,
  };
}
