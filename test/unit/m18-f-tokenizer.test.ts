/**
 * T-153 shard F: `src/memory/tokenizer.ts` completion tests.
 *
 * Priority target from the native baseline: `containsCjk`. Also covers the
 * documented no-`Intl.Segmenter` degradation (environment simulation via a
 * saved/restored global descriptor, never an error mock), the
 * `tokenizer-empty` query degradation and quote escaping in `ftsExpression`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  IDENTIFIER_SPLIT_VERSION,
  TOKENIZER_VERSION,
  codePointLength,
  containsCjk,
  expandIdentifier,
  ftsExpression,
  indexText,
  planTextQuery,
  queryTokens,
  splitIdentifier,
  tokenizeText,
  tokenizerEnvironment,
} from '../../src/memory/tokenizer.ts';

const REAL_SEGMENTER = Object.getOwnPropertyDescriptor(Intl, 'Segmenter');

function replaceSegmenter(value: unknown): void {
  Object.defineProperty(Intl, 'Segmenter', { value, writable: true, configurable: true });
}

function restoreSegmenter(): void {
  if (REAL_SEGMENTER === undefined) {
    delete (Intl as unknown as Record<string, unknown>).Segmenter;
    return;
  }
  Object.defineProperty(Intl, 'Segmenter', REAL_SEGMENTER);
}

test('documented degradation: missing or throwing Intl.Segmenter falls back safely', () => {
  try {
    replaceSegmenter(undefined);
    assert.deepEqual(tokenizeText('中文 abc'), ['中', '文', 'abc']);
    assert.equal(tokenizerEnvironment().segmenter, 'unavailable');

    replaceSegmenter(class BrokenSegmenter {
      constructor() {
        throw new Error('segmenter unavailable');
      }
    });
    assert.deepEqual(tokenizeText('中文'), ['中', '文']);
    assert.deepEqual(planTextQuery('中文').mode, 'like');
  } finally {
    restoreSegmenter();
  }
});

test('containsCjk recognises Han/Hiragana/Katakana/Hangul and rejects ASCII', () => {
  assert.equal(containsCjk('中文'), true);
  assert.equal(containsCjk('ひらがな'), true);
  assert.equal(containsCjk('カタカナ'), true);
  assert.equal(containsCjk('한글'), true);
  assert.equal(containsCjk('plain ascii 123'), false);
  assert.equal(containsCjk(''), false);
});

test('planTextQuery degrades empty tokenizers instead of claiming FTS readiness', () => {
  const empty = planTextQuery('!!!');
  assert.equal(empty.tokens.length, 0);
  assert.equal(empty.mode, 'like');
  assert.equal(empty.degraded, 'tokenizer-empty');

  const unigram = planTextQuery('a');
  assert.equal(unigram.codepoints, 1);
  assert.equal(unigram.degraded, 'unigram-scan');

  const cjkShort = planTextQuery('中文');
  assert.equal(cjkShort.cjk, true);
  assert.equal(cjkShort.codepoints, 2);
  assert.equal(cjkShort.degraded, 'unigram-scan');

  const ready = planTextQuery('abcdef');
  assert.equal(ready.mode, 'fts');
  assert.equal(ready.degraded, null);
});

test('ftsExpression escapes quotes and joins tokens deterministically', () => {
  assert.equal(ftsExpression(['alpha', 'beta']), '"alpha" AND "beta"');
  assert.equal(ftsExpression(['a"b']), '"a""b"');
  assert.equal(ftsExpression([]), '');
});

test('splitIdentifier/expandIdentifier keep S1 rules and drop duplicates', () => {
  assert.deepEqual(splitIdentifier('XMLHttpRequest'), ['xml', 'http', 'request']);
  assert.deepEqual(splitIdentifier('refreshToken'), ['refresh', 'token']);
  assert.deepEqual(splitIdentifier('utf8Decode'), ['utf', '8', 'decode']);
  assert.deepEqual(splitIdentifier('base64'), ['base', '64']);
  assert.deepEqual(splitIdentifier('snake_case-id.$var'), ['snake', 'case', 'id', 'var']);
  assert.deepEqual(splitIdentifier(''), []);

  assert.deepEqual(expandIdentifier('refreshToken'), ['refreshToken', 'refresh', 'token']);
  assert.deepEqual(expandIdentifier('xml-http'), ['xml-http', 'xml', 'http']);
  assert.deepEqual(indexText('abc def'), queryTokens('abc def').join(' '));
});

test('codePointLength counts Unicode code points rather than UTF-16 units', () => {
  assert.equal(codePointLength('a'), 1);
  assert.equal(codePointLength('😀'), 1);
  assert.equal(codePointLength('中文'), 2);
  assert.equal(codePointLength(''), 0);
  assert.equal(TOKENIZER_VERSION, 'ano-memory-tokenizer-b-plus-v1');
  assert.equal(IDENTIFIER_SPLIT_VERSION, 'ano-s1-identifier-split-v1');
});

test('tokenizeText keeps CJK segments and ASCII subtokens together', () => {
  const tokens = tokenizeText('刷新 refreshToken 中文');
  assert.ok(tokens.includes('刷新'), tokens.join(','));
  assert.ok(tokens.includes('中文'), tokens.join(','));
  assert.ok(tokens.includes('refreshToken'), tokens.join(','));
  assert.ok(tokens.includes('refresh') && tokens.includes('token'), tokens.join(','));
  assert.equal(new Set(tokens).size, tokens.length, 'tokens are de-duplicated');
});
