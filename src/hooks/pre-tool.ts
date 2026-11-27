import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import {
  failClosedDecision,
  type HookDecision,
  type HookInput,
  type HookMode,
} from './contract.ts';
import { defaultViewsPath, readExploredProjection } from '../memory/explored-state.ts';
import { SUPPORTED_STRUCTURE_EXTENSIONS } from '../structure/extractor.ts';
import type { Freshness } from '../structure/types.ts';

/**
 * T-164 / ADR-013 §4.3: deterministic, strictly read-only `pre-tool` decision
 * engine. No Ledger write handle, no graph rebuild, no `.ano/ledger` segment;
 * the only IO is `existsSync` (rule 3) and a read-only views.db projection
 * (rule 6, via `readExploredProjection`).
 *
 * Rules are applied in ADR-013 §4.3 order to every target path:
 *   1. outside project root / unresolvable        -> ask (never guess)
 *   2. exempt (defaults + hooks.exempt globs)      -> allow
 *   3. new file (does not exist)                   -> allow
 *   4. source language not TS/JS                   -> allow + UNSUPPORTED_LANGUAGE
 *   5. graph stale/degraded                        -> ask
 *   6. file in current-revision exploredFiles      -> allow
 *   7. otherwise                                   -> advisory ask / strict deny
 *
 * With multiple targets the first blocking (ask/deny) decision in input order
 * wins; an all-allow result keeps the first degraded marker, if any. This is a
 * pure function of (input, ctx): repeated calls with the same values yield the
 * same decision, and no decision mutates the workspace.
 */

/**
 * TS/JS extensions, derived by identity from the structure layer's single
 * source (`SUPPORTED_STRUCTURE_EXTENSIONS`) so the hook can never drift from
 * the builder. Python only enters this set after the structure flag is opened
 * (ADR-014 §7); until then `.py` stays an unsupported-language allow.
 */
export const SUPPORTED_PRE_TOOL_EXTENSIONS = SUPPORTED_STRUCTURE_EXTENSIONS;

/** Extensions treated as non-source assets by the default exemption (rule 2). */
const NON_SOURCE_EXTENSIONS = new Set([
  '.md', '.markdown', '.txt', '.rst', '.json', '.jsonc', '.yaml', '.yml', '.toml',
  '.ini', '.cfg', '.conf', '.env', '.csv', '.tsv', '.log', '.lock', '.gitignore',
  '.gitattributes', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp',
  '.pdf', '.html', '.htm', '.css', '.scss', '.less', '.sass', '.sql',
]);

/** Extensions recognised as source code in languages ANO does not yet support (rule 4). */
const OTHER_SOURCE_EXTENSIONS = new Set([
  '.py', '.go', '.rs', '.java', '.kt', '.kts', '.scala', '.c', '.h', '.cc', '.cpp',
  '.hpp', '.cs', '.rb', '.php', '.swift', '.m', '.mm', '.vue', '.svelte', '.dart',
  '.lua', '.sh', '.bash', '.ps1', '.bat', '.r', '.pl', '.ex', '.exs', '.erl', '.hs',
]);

const DEFAULT_EXEMPT_GLOBS = ['*.md', 'docs/**'];

export interface PreToolContext {
  /** Hook mode from `config.toml` / adapter; anything other than advisory is strict. */
  readonly mode: HookMode;
  /** Absolute project root; targets are resolved and containment-checked against it. */
  readonly root: string;
  /** Current graph freshness (read from GraphStore, never rebuilt here). */
  readonly freshness: Freshness;
  /** Current graph revision (read from GraphStore, never rebuilt here). */
  readonly revision: string;
  /** `hooks.exempt` glob patterns, merged with the ADR-013 defaults. */
  readonly exempt?: readonly string[];
  /**
   * Current-revision explored file set. Supply a precomputed array, or a lazy
   * reader. When omitted, the engine reads the views cache read-only via
   * `readExploredProjection`. The provider is invoked at most once per call.
   */
  readonly exploredFiles?: readonly string[] | (() => readonly string[]);
  /** Injectable existence check for tests; defaults to `existsSync`. */
  readonly exists?: (absolutePath: string) => boolean;
}

function normalizeRelative(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//u, '');
}

function isUnder(rootAbsolute: string, targetAbsolute: string): boolean {
  if (targetAbsolute === rootAbsolute) return false; // root itself is not a file target
  const rel = relative(rootAbsolute, targetAbsolute);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * T-167 (ADR-013 §4.3 rule 1): lexical containment is not enough on Windows,
 * where a symlink or junction *inside* the root can resolve to a path outside
 * it. Resolve existing targets (and the nearest existing ancestor for new
 * files) with realpath and re-check containment. Any failure to resolve is
 * treated as ambiguous -> ask, never allow.
 */
function resolvesUnderRoot(rootAbsolute: string, targetAbsolute: string): boolean {
  // Synthetic/non-existent roots (used by pure unit fixtures) cannot be
  // realpath-resolved; lexical containment is the only available check there.
  let realRoot: string;
  try {
    realRoot = realpathSync(rootAbsolute);
  } catch {
    return true;
  }
  // Prefer the real path of the target itself; for a not-yet-existing file
  // (rule 3) walk up to the nearest existing ancestor directory.
  let probePath = targetAbsolute;
  let ancestor: string | undefined;
  for (;;) {
    try {
      ancestor = realpathSync(probePath);
      break;
    } catch {
      const parent = dirname(probePath);
      if (parent === probePath) break; // reached filesystem root
      probePath = parent;
    }
  }
  if (ancestor === undefined) return false;
  // The target itself exists: it must be strictly under root.
  if (ancestor === realRoot) {
    return probePath !== targetAbsolute; // ancestor was a parent dir of a not-yet-existing target
  }
  return isUnder(realRoot, ancestor);
}

function globToRegExp(glob: string): RegExp {
  const normalized = normalizeRelative(glob);
  let source = '';
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index]!;
    if (char === '*') {
      if (normalized[index + 1] === '*') {
        index += 1;
        if (normalized[index + 1] === '/') {
          index += 1;
          source += '(?:.*/)?';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[.*+?^${}()|[\]\\]/u, '\\$&');
    }
  }
  return new RegExp(`^${source}$`, 'u');
}

const DEFAULT_EXEMPT_PATTERNS = DEFAULT_EXEMPT_GLOBS.map(globToRegExp);

function isExempt(relativePosix: string, configured: readonly string[]): boolean {
  const basename = relativePosix.split('/').at(-1) ?? relativePosix;
  for (const pattern of DEFAULT_EXEMPT_PATTERNS) {
    if (pattern.test(relativePosix) || pattern.test(basename)) return true;
  }
  for (const glob of configured) {
    const pattern = globToRegExp(glob);
    if (pattern.test(relativePosix) || (glob.includes('/') === false && pattern.test(basename))) return true;
  }
  // Non-source assets are exempt by default, except inside `.ano/**` where
  // internal state must stay guarded (ADR-013 §4.3 rule 2 wording).
  if (relativePosix.startsWith('.ano/')) return false;
  const lower = basename.toLowerCase();
  const dot = lower.lastIndexOf('.');
  const extension = dot === -1 ? '' : lower.slice(dot);
  if (extension === '' || NON_SOURCE_EXTENSIONS.has(extension)) return true;
  return false;
}

function isUnsupportedSource(relativePosix: string): boolean {
  const lower = relativePosix.toLowerCase();
  return SUPPORTED_PRE_TOOL_EXTENSIONS.some((extension) => lower.endsWith(extension)) === false
    && OTHER_SOURCE_EXTENSIONS.has(lower.slice(lower.lastIndexOf('.')));
}

function exploredSet(ctx: PreToolContext, revision: string): ReadonlySet<string> {
  const provider = ctx.exploredFiles;
  const files = provider === undefined
    ? readExploredProjection(defaultViewsPath(ctx.root), revision).exploredFiles
    : typeof provider === 'function' ? provider() : provider;
  return new Set(files.map(normalizeRelative));
}

function askForBlockedPath(reason: string, code?: 'HOOK_ROOT_AMBIGUOUS' | 'GRAPH_STALE' | 'GRAPH_DEGRADED', detail?: string): HookDecision {
  return code === undefined
    ? { kind: 'ask', reason }
    : { kind: 'ask', reason, degraded: { code, detail: detail ?? reason } };
}

function decideOne(
  target: string,
  ctx: PreToolContext,
  mode: 'advisory' | 'strict',
  rootAbsolute: string,
  readExplored: () => ReadonlySet<string>,
): HookDecision {
  // Rule 1: containment / resolvability. Always `ask` in both modes (不猜).
  const targetAbsolute = isAbsolute(target) ? resolve(target) : resolve(rootAbsolute, target);
  if (target.trim() === '' || !isUnder(rootAbsolute, targetAbsolute) || !resolvesUnderRoot(rootAbsolute, targetAbsolute)) {
    return askForBlockedPath(
      `ANO pre-tool：目标路径无法解析、经符号链接/junction 指向项目根之外，或在项目根之外（${target || '<空>'}），不猜测，请确认路径`,
      'HOOK_ROOT_AMBIGUOUS',
      `target=${target || '<空>'} root=${rootAbsolute}`,
    );
  }
  const relativePosix = normalizeRelative(relative(rootAbsolute, targetAbsolute));

  // Rule 2: explicit and default exemptions.
  if (isExempt(relativePosix, ctx.exempt ?? [])) return { kind: 'allow' };

  // Rule 3: new files are allowed; Gate judges coverage at closeout.
  const exists = ctx.exists ?? existsSync;
  if (!exists(targetAbsolute)) return { kind: 'allow' };

  // Rule 4: source language that ANO cannot analyse yet -> honest degradation.
  if (isUnsupportedSource(relativePosix)) {
    return {
      kind: 'allow',
      degraded: { code: 'UNSUPPORTED_LANGUAGE', detail: `${relativePosix} 不是受支持语言（当前仅 TS/JS），本钩子不声称覆盖` },
    };
  }

  // Rule 5: stale/degraded graph -> ask before editing; never auto-rebuild here.
  if (ctx.freshness.status !== 'fresh') {
    const code = ctx.freshness.status === 'degraded' ? 'GRAPH_DEGRADED' : 'GRAPH_STALE';
    const detail = ctx.freshness.status === 'degraded'
      ? `结构图 degraded：${ctx.freshness.reasons.join('；')}`
      : `结构图 stale：${ctx.freshness.stale} 个文件已变化`;
    return askForBlockedPath('结构图不新鲜，先 rebuild graph 或确认继续', code, detail);
  }

  // Rule 6: revision-bound explored projection (other sessions at the same
  // revision count too — ADR-013 §4.3 deliberate tradeoff).
  if (readExplored().has(relativePosix)) return { kind: 'allow' };

  // Rule 7: advisory asks with the remedy inline; strict denies with remedy.
  const remedy = `请先 explore 该文件（outline/impact）并把结构证据绑定到当前 revision ${ctx.revision || '<空>'}`;
  if (mode === 'strict') {
    return { kind: 'deny', reason: `${relativePosix} 在当前 revision 没有结构探查证据`, remedy };
  }
  return { kind: 'ask', reason: `${relativePosix} 在当前 revision 没有结构探查证据。${remedy}` };
}

/**
 * Evaluate the seven rules in order and return one deterministic HookDecision.
 * See the file header for multi-target and purity semantics.
 */
export function decidePreTool(input: HookInput, ctx: PreToolContext): HookDecision {
  const mode: 'advisory' | 'strict' = ctx.mode === 'advisory' ? 'advisory' : 'strict';
  const rootAbsolute = resolve(ctx.root);
  const targets = input.targetPaths ?? [];
  if (targets.length === 0) {
    return failClosedDecision(mode, 'HOOK_INPUT_INVALID', 'pre-tool 没有提供可判定的目标路径');
  }

  let cachedExplored: ReadonlySet<string> | undefined;
  const getExplored = (): ReadonlySet<string> => {
    cachedExplored ??= exploredSet(ctx, ctx.revision);
    return cachedExplored;
  };

  let firstDegraded: HookDecision['degraded'];
  for (const target of targets) {
    const decision = decideOne(target, ctx, mode, rootAbsolute, getExplored);
    if (decision.kind === 'ask' || decision.kind === 'deny') return decision;
    if (decision.degraded !== undefined && firstDegraded === undefined) firstDegraded = decision.degraded;
  }
  return firstDegraded === undefined ? { kind: 'allow' } : { kind: 'allow', degraded: firstDegraded };
}
