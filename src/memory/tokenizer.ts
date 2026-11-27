/**
 * P4 tokenizer: the S1 "B+" mechanism, implemented once and used by both the
 * index writer and the query builder.
 *
 * Index text is built with `tokenizeText`; query tokens come from the same
 * function. The identifier splitter is deterministic and does not depend on
 * ICU, but the word segmentation does, so the environment fingerprint is part
 * of the rebuild key in history.db.
 */

export const IDENTIFIER_SPLIT_VERSION = 'ano-s1-identifier-split-v1';
export const TOKENIZER_VERSION = 'ano-memory-tokenizer-b-plus-v1';
export const FTS_CONFIGURATION = 'fts5-unicode61-b-plus-v1';

const ASCII_WORDISH = /^[A-Za-z0-9_$.\-]+$/;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * Split one ASCII identifier into lowercase subtokens.
 *
 * Rules (fixed by docs/spikes/S1.md R1-R5 and covered by tests):
 * - `_`, `-`, `.`, `$` and every other non-alphanumeric character are boundaries.
 * - lower -> upper is a boundary (`refreshToken`).
 * - letter <-> digit is a boundary in both directions (`utf8Decode`, `base64`).
 * - an uppercase run followed by lowercase splits before its last uppercase
 *   (`XMLHttpRequest` -> xml/http/request, not x/m/l).
 * - output is lowercased, de-duplicated and order preserving.
 */
export function splitIdentifier(input: string): string[] {
  const parts = input.split(/[^A-Za-z0-9]+/u).filter((part) => part.length > 0);
  const output: string[] = [];
  const seen = new Set<string>();
  const push = (token: string): void => {
    const lower = token.toLowerCase();
    if (!lower || seen.has(lower)) return;
    seen.add(lower);
    output.push(lower);
  };

  for (const part of parts) {
    let start = 0;
    for (let index = 1; index < part.length; index += 1) {
      const previous = part[index - 1]!;
      const current = part[index]!;
      const next = part[index + 1];
      const boundary =
        (isLower(previous) && isUpper(current))
        || (isDigit(previous) && isLetter(current))
        || (isLetter(previous) && isDigit(current))
        || (isUpper(previous) && isUpper(current) && next !== undefined && isLower(next));
      if (boundary) {
        push(part.slice(start, index));
        start = index;
      }
    }
    push(part.slice(start));
  }
  return output;
}

/** Original token first, then lowercase subtokens (S1 `expandIdentifier`). */
export function expandIdentifier(input: string): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  const push = (token: string): void => {
    if (!token || seen.has(token)) return;
    seen.add(token);
    output.push(token);
  };
  push(input);
  for (const sub of splitIdentifier(input)) push(sub);
  return output;
}

let cachedSegmenter: Intl.Segmenter | undefined;

function segmenter(): Intl.Segmenter | undefined {
  if (cachedSegmenter) return cachedSegmenter;
  if (typeof Intl.Segmenter !== 'function') return undefined;
  try {
    cachedSegmenter = new Intl.Segmenter('zh', { granularity: 'word' });
    return cachedSegmenter;
  } catch {
    return undefined;
  }
}

/**
 * Tokenize text for indexing or querying. Identical function on both sides.
 * Non-word-like segments are dropped; ASCII word-like segments keep the
 * original spelling plus lowercase subtokens (B+); CJK segments are kept as
 * returned by Intl.Segmenter.
 */
export function tokenizeText(text: string): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  const push = (token: string): void => {
    if (!token || seen.has(token)) return;
    seen.add(token);
    output.push(token);
  };

  const wordSegmenter = segmenter();
  if (!wordSegmenter) {
    // Deliberate, documented degradation: no Intl.Segmenter means we cannot
    // get word boundaries. Split CJK by code point and ASCII by separators.
    for (const chunk of text.split(/\s+/u)) {
      if (!chunk) continue;
      if (ASCII_WORDISH.test(chunk)) {
        for (const token of expandIdentifier(chunk)) push(token);
      } else {
        for (const codepoint of chunk) {
          if (CJK.test(codepoint)) push(codepoint);
        }
      }
    }
    return output;
  }

  for (const segment of wordSegmenter.segment(text)) {
    if (!segment.isWordLike) continue;
    const value = segment.segment;
    if (ASCII_WORDISH.test(value)) {
      for (const token of expandIdentifier(value)) push(token);
    } else {
      push(value);
    }
  }
  return output;
}

export function indexText(text: string): string {
  return tokenizeText(text).join(' ');
}

export type QueryMode = 'fts' | 'like';

export interface TextQueryPlan {
  readonly codepoints: number;
  readonly cjk: boolean;
  readonly tokens: readonly string[];
  readonly mode: QueryMode;
  /** Non-null only when the query is deliberately degraded. */
  readonly degraded: string | null;
}

/**
 * Decide between FTS and the original-column LIKE scan. Length is measured in
 * Unicode code points, not UTF-16 code units (`[...text].length`).
 *
 * S1 measured that trigram MATCH silently returns zero rows below three code
 * points, and that 1/2-character CJK queries must fall back to the original
 * column. The same rule is applied here to the B+ token index: CJK queries
 * below three code points (and every single-code-point query) use LIKE and are
 * marked `unigram-scan`.
 */
export function planTextQuery(raw: string): TextQueryPlan {
  const codepoints = codePointLength(raw);
  const cjk = CJK.test(raw);
  const tokens = tokenizeText(raw);
  if (codepoints === 1) return { codepoints, cjk, tokens, mode: 'like', degraded: 'unigram-scan' };
  if (cjk && codepoints < 3) return { codepoints, cjk, tokens, mode: 'like', degraded: 'unigram-scan' };
  if (tokens.length === 0) return { codepoints, cjk, tokens, mode: 'like', degraded: 'tokenizer-empty' };
  return { codepoints, cjk, tokens, mode: 'fts', degraded: null };
}

/** Build a safe FTS5 expression from already-tokenized input. */
export function ftsExpression(tokens: readonly string[]): string {
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(' AND ');
}

/** Query-side token accessor kept separate only for call-site clarity. */
export function queryTokens(raw: string): string[] {
  return tokenizeText(raw);
}

export function codePointLength(text: string): number {
  return [...text].length;
}

export function containsCjk(text: string): boolean {
  return CJK.test(text);
}

export interface TokenizerEnvironment {
  readonly tokenizerVersion: string;
  readonly identifierSplitVersion: string;
  readonly ftsConfiguration: string;
  readonly icu: string;
  readonly unicode: string;
  readonly segmenter: 'intl-segmenter' | 'unavailable';
}

export function tokenizerEnvironment(): TokenizerEnvironment {
  return {
    tokenizerVersion: TOKENIZER_VERSION,
    identifierSplitVersion: IDENTIFIER_SPLIT_VERSION,
    ftsConfiguration: FTS_CONFIGURATION,
    icu: process.versions.icu ?? 'unknown',
    unicode: process.versions.unicode ?? 'unknown',
    segmenter: typeof Intl.Segmenter === 'function' ? 'intl-segmenter' : 'unavailable',
  };
}

function isUpper(value: string): boolean { return value >= 'A' && value <= 'Z'; }
function isLower(value: string): boolean { return value >= 'a' && value <= 'z'; }
function isDigit(value: string): boolean { return value >= '0' && value <= '9'; }
function isLetter(value: string): boolean { return isUpper(value) || isLower(value); }
