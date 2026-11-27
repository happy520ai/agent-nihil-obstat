#!/usr/bin/env node
/**
 * S1 检索机制 spike 的测试（node --test）。
 *
 * 作用：把 docs/spikes/S1.md 里钉死的行为变成回归测试，防止实现期悄悄改变假设。
 * 依赖：scripts/spikes/s1-search.mjs 导出的纯函数与 FTS 探测结果。
 * 运行：node --test "<repo>/scripts/spikes/s1-search.test.mjs"
 *
 * 不含真实会话数据；所有输入为合成字符串。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  IDENTIFIER_SPLIT_VERSION,
  EXPECTED_SUBWORDS,
  cjkBigrams,
  codepointLen,
  expandIdentifier,
  indexTextBPlus,
  runFtsProbe,
  segmentWords,
  segmenterAvailable,
  splitIdentifier,
  tokenizeMixed,
  utf16Len,
} from './s1-search.mjs';

test('标识符拆分：四类边界（预写用例全过）', () => {
  for (const [input, expected] of Object.entries(EXPECTED_SUBWORDS)) {
    assert.deepEqual(splitIdentifier(input), expected, `splitIdentifier(${input})`);
  }
});

test('标识符拆分：连续大写缩写不逐字母拆', () => {
  assert.deepEqual(splitIdentifier('XMLHttpRequest'), ['xml', 'http', 'request']);
  assert.deepEqual(splitIdentifier('HTTPServer'), ['http', 'server']);
  // 不是 x m l h t t p ...
  assert.ok(!splitIdentifier('XMLHttpRequest').includes('x'));
  assert.ok(!splitIdentifier('XMLHttpRequest').includes('h'));
});

test('标识符拆分：驼峰接缩写', () => {
  assert.deepEqual(splitIdentifier('parseHTMLString'), ['parse', 'html', 'string']);
});

test('标识符拆分：字母数字边界两个方向都拆', () => {
  assert.deepEqual(splitIdentifier('utf8Decode'), ['utf', '8', 'decode']);
  assert.deepEqual(splitIdentifier('base64'), ['base', '64']);
});

test('标识符拆分：分隔符统一（下划线/连字符/点）', () => {
  assert.deepEqual(splitIdentifier('refresh_token'), ['refresh', 'token']);
  assert.deepEqual(splitIdentifier('kebab-case'), ['kebab', 'case']);
  assert.deepEqual(splitIdentifier('a.b.c'), ['a', 'b', 'c']);
});

test('标识符拆分：输出全小写、去重、幂等（索引端与查询端同一函数）', () => {
  assert.deepEqual(splitIdentifier('RefreshToken'), ['refresh', 'token']);
  // 大小写折叠后同一结果：索引端 'Refresh_Token' 与查询端 'refresh_token' 必须等价
  assert.deepEqual(splitIdentifier('REFRESH_TOKEN'), splitIdentifier('refresh_token'));
  const once = splitIdentifier('XMLHttpRequest');
  const twice = splitIdentifier('XMLHttpRequest');
  assert.deepEqual(once, twice);
  for (const token of once) assert.equal(token, token.toLowerCase());
  assert.equal(IDENTIFIER_SPLIT_VERSION, 'ano-s1-identifier-split-v1');
});

test('标识符拆分：expandIdentifier 保留原词 + 追加子词', () => {
  assert.deepEqual(expandIdentifier('refreshToken'), ['refreshToken', 'refresh', 'token']);
  assert.deepEqual(expandIdentifier('base64'), ['base64', 'base', '64']);
});

test('码点长度：按 Unicode 码点，不是 UTF-16 码元', () => {
  assert.equal(codepointLen('租'), 1);
  assert.equal(codepointLen('租约'), 2);
  assert.equal(codepointLen('𠮷'), 1);
  assert.equal(utf16Len('𠮷'), 2); // 经典坑
  assert.equal(codepointLen('𠮷野家'), 3);
  assert.equal(utf16Len('𠮷野家'), 4);
  assert.equal(codepointLen('👨‍👩‍👧'), 5); // 码点不是字素簇
});

test('Segmenter：存在且中文为词级（词段可含多码点）', { skip: !segmenterAvailable() }, () => {
  const words = segmentWords('租约');
  assert.ok(Array.isArray(words));
  assert.deepEqual(words.map((w) => w.segment), ['租约']);
  assert.ok(words.every((w) => w.isWordLike === true));

  const sentence = segmentWords('修复死锁后回滚事务并更新租约状态').filter((w) => w.isWordLike);
  assert.ok(sentence.some((w) => [...w.segment].length >= 2), '至少存在多码点词段');
});

test('Segmenter：refreshToken / refresh_token 整词不拆（UAX #29 实测钉死）', { skip: !segmenterAvailable() }, () => {
  assert.deepEqual(segmentWords('refreshToken').map((w) => w.segment), ['refreshToken']);
  assert.deepEqual(segmentWords('refresh_token').map((w) => w.segment), ['refresh_token']);
});

test('Segmenter：中英紧邻边界 调用refreshToken函数 的实测切分', { skip: !segmenterAvailable() }, () => {
  assert.deepEqual(segmentWords('调用refreshToken函数').map((w) => w.segment), ['调', '用', 'refreshToken', '函数']);
});

test('B+ 管道：调用refreshToken函数 同时产出原词与子词', { skip: !segmenterAvailable() }, () => {
  assert.deepEqual(tokenizeMixed('调用refreshToken函数'), ['调', '用', 'refreshToken', 'refresh', 'token', '函数']);
  assert.equal(indexTextBPlus('调用refreshToken函数'), '调 用 refreshToken refresh token 函数');
});

test('CJK 2-gram：覆盖相邻汉字对，CJK-only', () => {
  assert.deepEqual(cjkBigrams('调用refreshToken函数'), ['调用', '函数']);
  assert.deepEqual(cjkBigrams('租约到期'), ['租约', '约到', '到期']);
  assert.deepEqual(cjkBigrams('幂'), []);
});

/* ------------------------------------------------------------------ */
/* FTS5 / trigram：把实测行为钉死                                      */
/* ------------------------------------------------------------------ */

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  DatabaseSync = null;
}

let probe = null;
if (DatabaseSync !== null) {
  probe = runFtsProbe(DatabaseSync);
}

const ftsAvailable = probe !== null && probe.create?.plainFts5?.ok === true;
const trigramAvailable = probe !== null && probe.create?.trigram?.ok === true;

test('FTS5 与 trigram 可用性（本环境如实记录，不作为跨环境断言）', { skip: !ftsAvailable }, () => {
  assert.equal(probe.create.plainFts5.ok, true);
  assert.ok(probe.ftsOptions.includes('ENABLE_FTS5'));
  assert.equal(typeof probe.sqliteVersion, 'string');
  assert.equal(trigramAvailable, probe.create.trigram.ok);
});

test('trigram：1/2 码点 MATCH 静默 0 行，3 码点起与 LIKE 真值一致', { skip: !trigramAvailable }, () => {
  const byQuery = Object.fromEntries(probe.matrix.map((m) => [m.query, m]));
  for (const q of ['租', '𠮷', '租约', '𠮷野', 'to']) {
    const entry = byQuery[q];
    assert.equal(entry.match.rowCount, 0, `MATCH ${q} 应为 0 行（静默）`);
    assert.equal(entry.match.error, null, `MATCH ${q} 不应报错`);
    assert.equal(entry.like.rowCount, entry.groundTruthRowCount, `LIKE ${q} 应等于真值`);
    assert.ok(entry.groundTruthRowCount > 0, `合成语料应包含 ${q}`);
  }
  for (const q of ['租约到', '数据库', '𠮷野家', 'tok', 'refresh', 'refreshToken']) {
    const entry = byQuery[q];
    assert.ok(entry.match.rowCount > 0, `MATCH ${q} 应命中`);
    assert.equal(entry.match.rowCount, entry.groundTruthRowCount, `MATCH ${q} 应等于真值`);
  }
});

test('trigram：LIKE 的 EQP 显示 fts 虚拟索引策略，普通表为 SCAN', { skip: !trigramAvailable }, () => {
  const tri = probe.eqp.find((e) => e.label === 'tri-LIKE-3cp');
  const plain = probe.eqp.find((e) => e.label === 'plain-LIKE-3cp');
  assert.match(tri.detail, /VIRTUAL TABLE INDEX 0:L0/);
  assert.equal(plain.detail, 'SCAN t_plain');
});

test('ESCAPE：字面量下划线不误命中通配诱饵；ESCAPE 后 EQP 丢失 L0', { skip: !trigramAvailable }, () => {
  const noEscape = probe.escape.find((e) => e.label === 'wildcard-underscore-no-escape');
  const escaped = probe.escape.find((e) => e.label === 'literal-underscore-escaped');
  assert.equal(noEscape.rowCount, 1); // 通配语义命中 aXb 类诱饵
  assert.equal(escaped.rowCount, 0); // 字面量 a_b 不存在
  const literalPercent = probe.escape.find((e) => e.label === 'literal-percent-escaped');
  assert.equal(literalPercent.rowCount, literalPercent.groundTruthRowCount);
  assert.match(literalPercent.eqpDetail, /VIRTUAL TABLE INDEX 0:$/); // 无 L0
});

test('大小写：默认 trigram 折叠；case_sensitive 1 的 MATCH 区分大小写而 LIKE 不区分', { skip: !trigramAvailable }, () => {
  const find = (table, op, q) => probe.caseSensitivity.find((c) => c.table === table && c.op === op && c.query === q);
  assert.equal(find('t_tri', 'MATCH', 'REFRESH').rowCount, 2);
  assert.equal(find('t_tri', 'MATCH', 'refresh').rowCount, 2);
  assert.equal(find('t_tri_cs', 'MATCH', 'REFRESH').rowCount, 0);
  assert.equal(find('t_tri_cs', 'MATCH', 'refresh').rowCount, 1);
  assert.equal(find('t_tri_cs', 'MATCH', 'Refresh').rowCount, 1);
  assert.equal(find('t_tri_cs', 'LIKE', 'REFRESH').rowCount, 2);
  assert.equal(find('t_tri_cs', 'LIKE', 'refresh').rowCount, 2);
});

test('MATCH 语法：裸 % 报错，双引号包裹可用；CJK 前缀查询 0 行', { skip: !trigramAvailable }, () => {
  const raw = probe.matchSyntax.find((m) => m.label === 'percent-raw');
  const quoted = probe.matchSyntax.find((m) => m.label === 'percent-quoted');
  assert.match(raw.error, /syntax error near "%"/);
  assert.equal(quoted.rowCount, 1);
  assert.equal(probe.matchSyntax.find((m) => m.label === 'prefix-3cp').rowCount, 0);
  assert.equal(probe.matchSyntax.find((m) => m.label === 'prefix-ascii').rowCount, 3);
});

test('方案 B：Segmenter 整词导致 token/refresh 漏检；B+ 追加子词后命中', { skip: !ftsAvailable }, () => {
  const sim = probe.planSimulation;
  assert.ok(sim);
  const token = sim.queries.find((q) => q.query === 'token');
  assert.equal(token.b.rowCount, 0);
  assert.equal(token.bplus.rowCount, 1);
  const refresh = sim.queries.find((q) => q.query === 'refresh');
  assert.equal(refresh.b.rowCount, 0);
  assert.equal(refresh.bplus.rowCount, 1);
  const whole = sim.queries.find((q) => q.query === 'refreshtoken');
  assert.equal(whole.b.rowCount, 1);
  assert.equal(whole.bplus.rowCount, 1);
});

test('unicode61 原始未切分文本：连续 CJK+拉丁串是单一 token', { skip: !ftsAvailable }, () => {
  const find = (q) => probe.unicode61Raw.find((u) => u.query === q);
  assert.equal(find('租约').match.rowCount, 0);
  assert.equal(find('refreshtoken').match.rowCount, 0);
  assert.equal(find('调用refreshToken函数更新令牌').match.rowCount, 1); // 只有整串能命中
});

test('相邻性：逐字 token 后 AND 语义丢相邻，短语语义保留', { skip: !ftsAvailable }, () => {
  const and = probe.adjacency.find((a) => a.label === 'and-semantics');
  const phrase = probe.adjacency.find((a) => a.label === 'phrase-adjacent');
  assert.equal(and.rowCount, 3);
  assert.deepEqual(phrase.rowids, [1]);
});
