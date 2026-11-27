import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

/**
 * T-154 / QF-05 mutation harness: pure logic shared by the isolated mutation
 * runner (`scripts/mutation-check.ts`) and its lightweight unit test.
 *
 * Everything here is deterministic and side-effect free apart from reading
 * files. The runner owns subprocesses, temporary copies and reporting; this
 * module owns the mutation catalogue, exact-replacement verification, TAP
 * classification and seeded fuzz primitives so the ordinary suite can cover
 * the harness without spawning anything.
 */

export const MUTATION_CATEGORIES = [
  'comparison-operator',
  'epoch-check',
  'deduplication',
  'error-code',
  'cleanup-eviction',
  'authorization',
] as const;
export type MutationCategory = (typeof MUTATION_CATEGORIES)[number];

export interface MutationSpec {
  /** Stable id used in reports. */
  readonly id: string;
  readonly category: MutationCategory;
  /** Repo-relative source file that receives the mutation. */
  readonly file: string;
  /** Repo-relative existing test file expected to detect the mutation. */
  readonly detector: string;
  readonly description: string;
  /** Exact source text that must occur exactly once before it is replaced. */
  readonly from: string;
  readonly to: string;
}

/**
 * Representative mutations across the six acceptance categories. Each anchor
 * was verified to occur exactly once in the current source tree; the unit test
 * re-verifies that on every run so source drift cannot silently invalidate a
 * target.
 */
export const MUTATIONS: readonly MutationSpec[] = [
  {
    id: 'M1-comparison-term-order',
    category: 'comparison-operator',
    file: 'src/memory/leader-state.ts',
    detector: 'test/unit/leader-state-complete.test.ts',
    description: 'Declaration ordering drops the term tie-break so only epoch and leader id order remain.',
    from: [
      '  return left.epoch - right.epoch || left.term - right.term || (left.leader_id < right.leader_id ? -1 : left.leader_id > right.leader_id ? 1 : 0);',
    ].join('\n'),
    to: [
      '  return left.epoch - right.epoch || (left.leader_id < right.leader_id ? -1 : left.leader_id > right.leader_id ? 1 : 0);',
    ].join('\n'),
  },
  {
    id: 'M2-epoch-rollback-boundary',
    category: 'epoch-check',
    file: 'src/memory/leader-lease.ts',
    detector: 'test/unit/leader-lease.test.ts',
    description: 'Inbound vote epoch fencing changes `<` to `<=`, so an equal epoch is misreported as a rollback.',
    from: [
      '    if (request.epoch < this.#epoch) {',
    ].join('\n'),
    to: [
      '    if (request.epoch <= this.#epoch) {',
    ].join('\n'),
  },
  {
    id: 'M3-dedupe-status-key',
    category: 'deduplication',
    file: 'src/memory/probe-merge.ts',
    detector: 'test/unit/probe-merge-complete.test.ts',
    description: 'Candidate dedupe key drops status, collapsing distinct fact variants instead of reporting them.',
    from: [
      '    observation.candidate.record_ref,',
      '    observation.candidate.content_hash,',
      '    observation.candidate.status,',
      '  ].join(DEDUPE_SEPARATOR);',
    ].join('\n'),
    to: [
      '    observation.candidate.record_ref,',
      '    observation.candidate.content_hash,',
      '  ].join(DEDUPE_SEPARATOR);',
    ].join('\n'),
  },
  {
    id: 'M4-frame-too-large-code',
    category: 'error-code',
    file: 'src/memory/tcp-frame-codec.ts',
    detector: 'test/unit/tcp-frame-codec.test.ts',
    description: 'Oversized-frame rejection reports TCP_FRAME_INVALID instead of TCP_FRAME_TOO_LARGE.',
    from: [
      "      'TCP_FRAME_TOO_LARGE',",
      '      `frame body is ${String(body.length)} bytes, above the ${String(maxFrameBytes)} byte limit`,',
    ].join('\n'),
    to: [
      "      'TCP_FRAME_INVALID',",
      '      `frame body is ${String(body.length)} bytes, above the ${String(maxFrameBytes)} byte limit`,',
    ].join('\n'),
  },
  {
    id: 'M5-challenge-table-eviction',
    category: 'cleanup-eviction',
    file: 'src/memory/tcp-transport.ts',
    detector: 'test/integration/tcp-transport.test.ts',
    description: 'Bounded challenge table never evicts its oldest entry, so a stale challenge stays usable.',
    from: [
      '  map.set(key, value);',
      '  while (map.size > limit) {',
      '    const oldest = map.keys().next().value;',
      '    if (oldest === undefined) break;',
      '    map.delete(oldest);',
      '  }',
    ].join('\n'),
    to: [
      '  map.set(key, value);',
    ].join('\n'),
  },
  {
    id: 'M6-authorization-scope-check',
    category: 'authorization',
    file: 'src/memory/cluster-policy.ts',
    detector: 'test/unit/cluster-policy.test.ts',
    description: 'Local scope authorization inverts, denying the allowed scope and admitting a cross-scope request.',
    from: [
      '  if (projectScope !== undefined && !replica.allowedScopes.includes(projectScope)) {',
    ].join('\n'),
    to: [
      '  if (projectScope !== undefined && replica.allowedScopes.includes(projectScope)) {',
    ].join('\n'),
  },
];

// ---------------------------------------------------------------------------
// Exact replacement
// ---------------------------------------------------------------------------

export function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

export interface ReplacementOutcome {
  readonly output: string;
  /** Number of matches found. Only 1 is a valid mutation. */
  readonly occurrences: number;
}

/**
 * Replace exactly one occurrence. Zero or multiple matches leave the source
 * unchanged and report the count so callers treat it as a harness error rather
 * than a killed mutant.
 */
export function applyExactReplacement(source: string, from: string, to: string): ReplacementOutcome {
  const occurrences = countOccurrences(source, from);
  if (occurrences !== 1) return { output: source, occurrences };
  return { output: source.replace(from, to), occurrences };
}

export interface SpecValidation {
  readonly ok: boolean;
  readonly checked: number;
  readonly problems: readonly string[];
}

/** Verify every catalogued anchor still occurs exactly once in the real tree. */
export function validateMutationSpecs(root: string, specs: readonly MutationSpec[] = MUTATIONS): SpecValidation {
  const problems: string[] = [];
  for (const spec of specs) {
    const file = resolve(root, spec.file);
    let source: string;
    try {
      source = readFileSync(file, 'utf8');
    } catch (error) {
      problems.push(`${spec.id}: cannot read ${spec.file}: ${String(error)}`);
      continue;
    }
    const occurrences = countOccurrences(source, spec.from);
    if (occurrences !== 1) {
      problems.push(`${spec.id}: anchor occurs ${String(occurrences)} times in ${spec.file}, expected exactly 1`);
    }
  }
  return { ok: problems.length === 0, checked: specs.length, problems };
}

// ---------------------------------------------------------------------------
// Deterministic source hashing
// ---------------------------------------------------------------------------

export interface SourceTreeHash {
  readonly hash: string;
  readonly files: number;
}

function collectTypeScriptFiles(directory: string): string[] {
  const files: string[] = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        visit(full);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.ts')) files.push(full);
    }
  };
  visit(directory);
  return files.sort();
}

/**
 * Deterministic sha256 over relative posix paths plus contents. Used to prove
 * the mutation run left the working tree untouched.
 */
export function hashSourceTree(root: string, include: readonly string[] = ['src']): SourceTreeHash {
  const hash = createHash('sha256');
  let files = 0;
  for (const entry of include) {
    const directory = resolve(root, entry);
    try {
      statSync(directory);
    } catch {
      continue;
    }
    for (const absolute of collectTypeScriptFiles(directory)) {
      const rel = relative(root, absolute).split(sep).join('/');
      hash.update(rel);
      hash.update('\u0000');
      hash.update(readFileSync(absolute));
      hash.update('\u0000');
      files += 1;
    }
  }
  return { hash: hash.digest('hex'), files };
}

// ---------------------------------------------------------------------------
// TAP parsing / run classification
// ---------------------------------------------------------------------------

export interface TapSummary {
  readonly tests: number;
  readonly pass: number;
  readonly fail: number;
  readonly skipped: number;
  readonly notOkNames: readonly string[];
}

export function parseTapSummary(output: string): TapSummary {
  const counter = (label: string): number => {
    const match = new RegExp(`^# ${label} (\\d+)$`, 'mu').exec(output);
    return match === null ? 0 : Number(match[1]);
  };
  const notOkNames = [...output.matchAll(/^not ok \d+ - (.+)$/gmu)].map((match) => match[1]!.trim());
  return {
    tests: counter('tests'),
    pass: counter('pass'),
    fail: counter('fail'),
    skipped: counter('skipped'),
    notOkNames,
  };
}

export type RunKind = 'survived' | 'killed' | 'harness_error';

export interface RunClassification {
  readonly kind: RunKind;
  readonly reason: string;
  readonly failingTests: readonly string[];
  readonly tap: TapSummary;
}

/**
 * A mutation counts as killed only when the detector produced real failing
 * test results. Timeouts, syntax errors and unresolved imports are harness
 * errors and are reported separately; they are never recorded as detection.
 */
export function classifyRun(input: {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly output: string;
}): RunClassification {
  const tap = parseTapSummary(input.output);
  if (input.timedOut) {
    return { kind: 'harness_error', reason: 'subprocess-timeout', failingTests: [], tap };
  }
  if (input.exitCode === 0) {
    return { kind: 'survived', reason: 'exit-zero', failingTests: [], tap };
  }
  if (tap.notOkNames.length > 0) {
    return {
      kind: 'killed',
      reason: 'assertion-failure',
      failingTests: tap.notOkNames.slice(0, 8),
      tap,
    };
  }
  const text = input.output;
  let reason = 'nonzero-exit';
  if (/SyntaxError/u.test(text)) reason = 'syntax-error';
  else if (/Cannot find module|ERR_MODULE_NOT_FOUND/u.test(text)) reason = 'import-resolution-error';
  else if (/ReferenceError/u.test(text)) reason = 'runtime-reference-error';
  return { kind: 'harness_error', reason, failingTests: [], tap };
}

// ---------------------------------------------------------------------------
// Seeded bounded fuzz primitives
// ---------------------------------------------------------------------------

/** mulberry32: small, deterministic, seedable PRNG (no crypto, no randomness). */
export function seededRng(seed: number): () => number {
  let state = seed >>> 0;
  return (): number => {
    state = (state + 0x6d2b79f5) | 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function boundedInt(rng: () => number, min: number, maxInclusive: number): number {
  return min + Math.floor(rng() * (maxInclusive - min + 1));
}

/** Deterministic frame payloads around size boundaries; never executes remote code. */
export function deterministicFrameSizes(seed: number, count: number, limits: readonly number[] = [0, 1, 64, 256]): number[] {
  const rng = seededRng(seed);
  const sizes: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const base = limits[boundedInt(rng, 0, limits.length - 1)]!;
    sizes.push(Math.max(0, base + boundedInt(rng, -8, 8)));
  }
  return sizes;
}
