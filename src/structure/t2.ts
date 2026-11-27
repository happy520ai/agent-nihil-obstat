import type { CallEdge, GraphSnapshot } from './types.ts';

/** Node key for a graph node in T2 traversal: either a file or a symbol. */
export type T2Node = `file:${string}` | `symbol:${string}`;

export function fileNode(file: string): T2Node { return `file:${file}`; }
export function symbolNode(symbolId: string): T2Node { return `symbol:${symbolId}`; }

function resolvedCallEdges(snapshot: GraphSnapshot): CallEdge[] {
  return (snapshot.calls ?? []).filter((edge) => edge.provenance === 'resolved');
}

/**
 * Only value symbols can be called. Type symbols are deliberately excluded so a
 * touched file containing only interfaces never fakes a T2 result.
 */
export function affectedSymbols(snapshot: GraphSnapshot, touchedFiles: Iterable<string>): string[] {
  const touched = new Set(touchedFiles);
  return snapshot.symbols
    .filter((symbol) => symbol.symbolKind === 'value' && touched.has(symbol.file))
    .map((symbol) => symbol.id)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Computes the T2 reachable set from executed tests over **resolved L2 call
 * edges only**. It never consults `snapshot.edges` (T1 import semantics): a test
 * that merely imports a file cannot make its symbols reachable.
 */
export function reachableSymbolsViaCalls(snapshot: GraphSnapshot, executedTests: Iterable<string>): Set<string> {
  const testFiles = new Set(executedTests);
  const edges = resolvedCallEdges(snapshot);

  // Adjacency keyed by caller node. Unqualified top-level calls are attached to
  // their file, but only executed-test files can act as file roots.
  const byCallerSymbol = new Map<string, CallEdge[]>();
  const byCallerFile = new Map<string, CallEdge[]>();
  for (const edge of edges) {
    if (edge.callerSymbolId) {
      const list = byCallerSymbol.get(edge.callerSymbolId) ?? [];
      list.push(edge);
      byCallerSymbol.set(edge.callerSymbolId, list);
    }
    const byFile = byCallerFile.get(edge.from) ?? [];
    byFile.push(edge);
    byCallerFile.set(edge.from, byFile);
  }

  const reachable = new Set<string>();
  const queue: T2Node[] = [];
  const seen = new Set<T2Node>();

  const pushNode = (node: T2Node): void => {
    if (seen.has(node)) return;
    seen.add(node);
    queue.push(node);
  };

  for (const testFile of testFiles) {
    pushNode(fileNode(testFile));
    for (const symbol of snapshot.symbols) {
      if (symbol.file === testFile) pushNode(symbolNode(symbol.id));
    }
  }

  for (let index = 0; index < queue.length; index += 1) {
    const node = queue[index]!;
    if (node.startsWith('file:')) {
      const path = node.slice(5);
      // A non-test file is only a file root when it was explicitly executed.
      if (!testFiles.has(path)) continue;
      for (const edge of byCallerFile.get(path) ?? []) {
        if (edge.calleeSymbolId) {
          reachable.add(edge.calleeSymbolId);
          pushNode(symbolNode(edge.calleeSymbolId));
        }
      }
      continue;
    }
    const symbolId = node.slice(7);
    reachable.add(symbolId);
    for (const edge of byCallerSymbol.get(symbolId) ?? []) {
      if (edge.calleeSymbolId && !reachable.has(edge.calleeSymbolId)) {
        reachable.add(edge.calleeSymbolId);
        pushNode(symbolNode(edge.calleeSymbolId));
      }
    }
  }

  return reachable;
}

export interface T2CoverageReport {
  /** False when touched files define no callable value symbols. */
  applicable: boolean;
  satisfied: boolean;
  affectedSymbols: string[];
  coveredSymbols: string[];
  uncoveredSymbols: string[];
  reachableSymbols: string[];
  /** Files containing at least one covered affected symbol. */
  coveredFiles: string[];
  /** Diagnostic only: T2 intentionally uses neither import edges nor heuristic calls. */
  edgesUsed: 'resolved-call-edges';
  resolvedCallEdges: number;
}

/**
 * Pure T2 evaluator for the Gate. Every affected value symbol must be reachable
 * through resolved call edges starting from an executed test file/symbol. If no
 * affected value symbols exist the level is `applicable: false`; the caller must
 * not report T2 as satisfied.
 */
export function t2Coverage(snapshot: GraphSnapshot, executedTests: Iterable<string>, touchedFiles: Iterable<string>): T2CoverageReport {
  const testFiles = new Set(executedTests);
  const touched = new Set(touchedFiles);
  const affected = affectedSymbols(snapshot, touched);
  const reachable = reachableSymbolsViaCalls(snapshot, testFiles);
  const covered = affected.filter((symbolId) => reachable.has(symbolId));
  const uncovered = affected.filter((symbolId) => !reachable.has(symbolId));
  const coveredFiles = [...new Set(covered.map((id) => snapshot.symbols.find((symbol) => symbol.id === id)?.file).filter((file): file is string => file !== undefined))]
    .sort((a, b) => a.localeCompare(b));
  return {
    applicable: affected.length > 0,
    satisfied: affected.length > 0 && uncovered.length === 0,
    affectedSymbols: affected,
    coveredSymbols: covered,
    uncoveredSymbols: uncovered,
    reachableSymbols: [...reachable].sort((a, b) => a.localeCompare(b)),
    coveredFiles,
    edgesUsed: 'resolved-call-edges',
    resolvedCallEdges: resolvedCallEdges(snapshot).length,
  };
}
