import assert from 'node:assert/strict';
import test from 'node:test';
import { parseToml } from '../../src/readiness/toml.ts';

function invalid(source: string, pattern: RegExp): void {
  assert.throws(
    () => parseToml(source),
    (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, 'TOML_INVALID');
      assert.match((error as Error).message, pattern);
      return true;
    },
  );
}

test('readiness TOML parses quoted comments, escapes, dotted keys and nested tables', () => {
  const parsed = parseToml([
    'root.value = "a=b#c\\n\\t\\r\\\"\\\\"',
    "root.literal = 'x#y=z'",
    'root.enabled = true',
    'root.disabled = false',
    'root.count = -42',
    'root.empty = []',
    'root.names = ["a,b", \'c.d\']',
    '',
    '[owner."release.team"]',
    'name = "Release # Owners"',
    '',
  ].join('\r\n'));
  assert.deepEqual(JSON.parse(JSON.stringify(parsed)), {
    root: {
      value: 'a=b#c\n\t\r"\\',
      literal: 'x#y=z',
      enabled: true,
      disabled: false,
      count: -42,
      empty: [],
      names: ['a,b', 'c.d'],
    },
    owner: { 'release.team': { name: 'Release # Owners' } },
  });
});

test('readiness TOML rejects malformed quoting, values, arrays and unsafe keys', () => {
  const cases: Array<[string, RegExp]> = [
    ['value = "unterminated\n', /unterminated string/u],
    ["value = 'a''b'\n", /unescaped quote/u],
    ['value = "bad\\q"\n', /unsupported escape/u],
    ['value = "bad\\"\n', /unterminated string/u],
    ['value = "control\u0001"\n', /control character/u],
    ['value =\n', /missing value/u],
    ['value = [1\n', /unterminated array/u],
    ['value = [1,,2]\n', /empty array element/u],
    ['value = [1,"two"]\n', /flat and homogeneous/u],
    ['value = [[1]]\n', /flat and homogeneous/u],
    ['value = bare\n', /strings must be quoted/u],
    ['value = 01\n', /strings must be quoted/u],
    ['value = 1 = 2\n', /only one "="/u],
    ['value 1\n', /expected key = value/u],
    ['a..b = 1\n', /empty key segment/u],
    ['bad$key = 1\n', /invalid key/u],
    ['__proto__ = 1\n', /reserved key/u],
    ['[constructor]\n', /reserved key/u],
    ['[[profile]]\n', /array tables/u],
    ['[profile\n', /unterminated table/u],
  ];
  for (const [source, pattern] of cases) invalid(source, pattern);
});

test('readiness TOML rejects duplicate and scalar-conflicting declarations', () => {
  invalid('value = 1\nvalue = 2\n', /duplicate key/u);
  invalid('[owner]\n[owner]\n', /duplicate table/u);
  invalid('value = 1\n[value]\n', /conflicts with a scalar/u);
  invalid('branch = 1\nbranch.leaf = 2\n', /conflicts with a scalar/u);
  const parsed = parseToml('branch.leaf = 1\nbranch.other = 2\n');
  assert.deepEqual(JSON.parse(JSON.stringify(parsed)), { branch: { leaf: 1, other: 2 } });
});
