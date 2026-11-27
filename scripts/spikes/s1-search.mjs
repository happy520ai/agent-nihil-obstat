#!/usr/bin/env node
/**
 * ANO S1 检索机制 spike（机制段）—— 独立可复现脚本。
 *
 * 目的：把中文/中英混排检索依赖的底层机制行为钉死，供 docs/spikes/S1.md 引用。
 * 约束：
 *  - 只用合成字符串与 `:memory:` SQLite；不读取、不扫描任何真实会话文件（G3 未授权采样）。
 *  - 零第三方依赖：只 import Node 内置模块。
 *  - 所有 SQL 均为参数化（`?` 绑定），查询文本不参与 SQL 拼接。
 *  - 不产出任何排序结论（本脚本不计算召回/P@5/延迟排名）。
 *
 * 用法（输出必须是显式传入的绝对路径；脚本只在仓库内运行）：
 *   node "<repo>/scripts/spikes/s1-search.mjs" --out "<repo>/docs/evidence/s1-search.json"
 *
 * 退出码：0 成功；2 参数错误。
 */

import process from 'node:process';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const DEFAULT_OUT = path.join(REPO_ROOT, 'docs', 'evidence', 's1-search.json');

/** 运行期警告（node:sqlite 的实验性警告等），在动态 import 之前挂监听。 */
const runtimeWarnings = [];
process.on('warning', (w) => {
  runtimeWarnings.push({ name: String(w.name || ''), message: String(w.message || '') });
});

/* ------------------------------------------------------------------ */
/* 一、确定性标识符拆分（不依赖 ICU，索引端与查询端共用同一函数）      */
/* ------------------------------------------------------------------ */

/** 函数规则版本号；与 process.versions.icu / unicode 一起写入缓存 meta。 */
export const IDENTIFIER_SPLIT_VERSION = 'ano-s1-identifier-split-v1';

/** Unicode 码点长度（不是 UTF-16 码元长度）。 */
export function codepointLen(value) {
  return [...String(value)].length;
}

/** UTF-16 码元长度（`'𠮷'.length === 2` 的那个坑）。 */
export function utf16Len(value) {
  return String(value).length;
}

const RE_ALNUM_RUN = /[A-Za-z0-9]+/g;
const RE_ASCII_IDENTIFIER = /^[A-Za-z0-9_$]+$/;
const isUpper = (c) => c >= 'A' && c <= 'Z';
const isLower = (c) => c >= 'a' && c <= 'z';
const isDigit = (c) => c >= '0' && c <= '9';

function splitAlnumRun(run) {
  const parts = [];
  let cur = '';
  for (let i = 0; i < run.length; i += 1) {
    const c = run[i];
    const prev = i > 0 ? run[i - 1] : '';
    const next = i + 1 < run.length ? run[i + 1] : '';
    let boundary = false;
    if (i > 0) {
      if (isDigit(c) !== isDigit(prev)) {
        boundary = true; // 字母↔数字边界（两个方向都拆）
      } else if (isLower(prev) && isUpper(c)) {
        boundary = true; // 小写→大写（驼峰）
      } else if (isUpper(prev) && isUpper(c) && next !== '' && isLower(next)) {
        boundary = true; // 连续大写缩写结束：XML|Http、HTML|String
      }
    }
    if (boundary && cur !== '') {
      parts.push(cur);
      cur = '';
    }
    cur += c;
  }
  if (cur !== '') parts.push(cur);
  return parts;
}

/**
 * 确定性标识符拆分：输入一个 ASCII 标识符片段（调用方保证 /^[A-Za-z0-9_$]+$/），
 * 返回**小写子词**（保留出现顺序并去重）。
 * 规则（S1 固化）：
 *  1. 分隔符 `_`、`-`、`.`、`$` 及其他非字母数字字符都视为边界（分隔符不产出子词）；
 *  2. 字母↔数字边界两个方向都拆：utf8Decode → utf, 8, decode；base64 → base, 64；
 *  3. 小写→大写拆：refreshToken → refresh, token；
 *  4. 连续大写缩写结束处拆：XMLHttpRequest → xml, http, request；parseHTMLString → parse, html, string。
 * 原词本身由索引端保留（`expandIdentifier` 返回 [原词, ...子词]），因此 OAuth→o,auth 这类
 * 缩写释放产生的单字母子词不会丢失整词召回。
 */
export function splitIdentifier(raw) {
  const runs = String(raw).match(RE_ALNUM_RUN);
  if (!runs) return [];
  const parts = [];
  for (const run of runs) parts.push(...splitAlnumRun(run));
  const seen = new Set();
  const out = [];
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower !== '' && !seen.has(lower)) {
      seen.add(lower);
      out.push(lower);
    }
  }
  return out;
}

/** 索引端用：原词（Tokenizer 会自行折叠大小写）+ 追加小写子词。 */
export function expandIdentifier(word) {
  const folded = String(word).toLowerCase();
  const subwords = splitIdentifier(word).filter((t) => t !== folded);
  return [String(word), ...subwords];
}

/* ------------------------------------------------------------------ */
/* 二、Intl.Segmenter 包装（索引端与查询端共用）                        */
/* ------------------------------------------------------------------ */

export const SEGMENTER_LOCALES = ['zh', 'zh-Hans', 'zh-Hant', 'en'];

export function segmenterAvailable() {
  return typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function';
}

/** 返回原始 segment 数组；不可用时返回 null（不抛错，由报告如实记录）。 */
export function segmentWords(text, locale = 'zh') {
  if (!segmenterAvailable()) return null;
  const segmenter = new Intl.Segmenter(locale, { granularity: 'word' });
  return [...segmenter.segment(String(text))].map((s) => ({
    segment: s.segment,
    isWordLike: s.isWordLike === true,
  }));
}

/** 仅保留 wordLike 段（方案 B 的索引 token 流，原样保留、不拆子词）。 */
export function wordSegments(text, locale = 'zh') {
  const words = segmentWords(text, locale);
  if (words === null) return [];
  return words.filter((s) => s.isWordLike).map((s) => s.segment);
}

/**
 * 方案 B+ 的 token 流：wordLike 的 ASCII 标识符段 → 原词 + 小写子词；
 * 其余 wordLike 段（中文词等）原样保留；非 wordLike 段（空白、标点）丢弃。
 */
export function tokenizeMixed(text, locale = 'zh') {
  const tokens = [];
  const words = segmentWords(text, locale);
  if (words === null) return tokens;
  for (const { segment, isWordLike } of words) {
    if (!isWordLike) continue;
    if (RE_ASCII_IDENTIFIER.test(segment)) {
      tokens.push(...expandIdentifier(segment));
    } else {
      tokens.push(segment);
    }
  }
  return tokens;
}

/** 方案 B+ 的索引文本：token 以空格连接后交给 unicode61。 */
export function indexTextBPlus(text, locale = 'zh') {
  return tokenizeMixed(text, locale).join(' ');
}

/** CJK-only 相邻 2-gram（方案 C 的 n-gram 列；按码点取相邻对，不做词典切分）。 */
export function cjkBigrams(text) {
  const out = [];
  const runs = String(text).match(/\p{Script=Han}+/gu) || [];
  for (const run of runs) {
    const chars = [...run];
    for (let i = 0; i + 1 < chars.length; i += 1) {
      out.push(chars[i] + chars[i + 1]);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 三、合成语料（全部手写；不含任何真实会话内容）                       */
/* ------------------------------------------------------------------ */

export const SYNTHETIC_ROWS = [
  { label: '二字术语', body: '租约到期提醒' },
  { label: '三字术语', body: '数据库连接池' },
  { label: '中英混排', body: '调用refreshToken函数更新令牌' },
  { label: '非BMP', body: '𠮷野家套餐' },
  { label: '元字符', body: 'a_100%完成' },
  { label: '大小写', body: 'RefreshTokenRetry' },
  { label: '通配诱饵', body: '前缀axb后缀' },
  { label: '英文词', body: 'auth token 刷新令牌 o auth to' },
];

const SEGMENTER_SAMPLES = [
  '租约', '账本', '数据库', '数据库连接池', '幂等', '死锁', '回滚', '调用',
  '调用refreshToken函数', '调用 refreshToken 函数', 'refreshToken', 'refresh_token',
  'XMLHttpRequest', 'parseHTMLString', 'utf8Decode', 'base64', 'kebab-case', 'a.b.c',
  '𠮷野家', '修复死锁后回滚事务并更新租约状态', 'rental lease 租约',
];

/** §5 D10 预写的四类边界用例（脚本内先算一遍，测试文件再硬断言一遍）。 */
export const EXPECTED_SUBWORDS = {
  XMLHttpRequest: ['xml', 'http', 'request'],
  parseHTMLString: ['parse', 'html', 'string'],
  utf8Decode: ['utf', '8', 'decode'],
  base64: ['base', '64'],
  refresh_token: ['refresh', 'token'],
  'kebab-case': ['kebab', 'case'],
  'a.b.c': ['a', 'b', 'c'],
};

/* ------------------------------------------------------------------ */
/* 四、SQLite / FTS5 / trigram 探测                                    */
/* ------------------------------------------------------------------ */

/**
 * 在 :memory: 上跑完整 FTS 机制矩阵。传入 node:sqlite 的 DatabaseSync 构造器，
 * 返回可直接 JSON 序列化的原始结构。
 */
export function runFtsProbe(DatabaseSync) {
  const result = {
    loaded: true,
    sqliteVersion: null,
    versionNumber: null,
    compileOptions: [],
    ftsOptions: [],
    create: {},
    tables: {},
    rowCounts: null,
    matrix: [],
    unicode61Raw: [],
    eqp: [],
    escape: [],
    caseSensitivity: [],
    codepointLengths: [],
    matchSyntax: [],
    planSimulation: null,
    adjacency: [],
    snippets: [],
    bm25: null,
    errors: [],
  };

  const db = new DatabaseSync(':memory:');
  const recordError = (label, error) => {
    const message = String((error && error.message) || error);
    result.errors.push({ label, message });
    return message;
  };
  const attempt = (label, fn) => {
    try {
      return { ok: true, value: fn() };
    } catch (error) {
      return { ok: false, error: recordError(label, error) };
    }
  };
  const rows = (sql, params = []) => db.prepare(sql).all(...params).map((row) => ({ ...row }));
  const rowids = (sql, params = []) => {
    const out = db.prepare(sql).all(...params);
    return out.map((row) => row.rowid);
  };
  const query = (label, sql, params = []) => {
    try {
      const got = rows(sql, params);
      return { label, sql, params, rowCount: got.length, rowids: got.map((r) => r.rowid), rows: got, error: null };
    } catch (error) {
      return { label, sql, params, rowCount: null, rowids: null, rows: null, error: recordError(label, error) };
    }
  };

  result.sqliteVersion = db.prepare('select sqlite_version() as v').get().v;
  result.versionNumber = db.prepare('select sqlite_source_id() as v').get().v;
  result.compileOptions = rows('pragma compile_options').map((r) => r.compile_options);
  result.ftsOptions = result.compileOptions.filter((o) => /FTS|TRIGRAM/i.test(o));

  // --- 建表：普通表 + fts5 三形态 -----------------------------------
  db.exec('CREATE TABLE t_plain (body TEXT)');
  const insertPlain = db.prepare('INSERT INTO t_plain(body) VALUES (?)');
  for (const r of SYNTHETIC_ROWS) insertPlain.run(r.body);

  result.create.plainFts5 = attempt('create t_u61', () => {
    db.exec("CREATE VIRTUAL TABLE t_u61 USING fts5(body, tokenize='unicode61')");
  });
  result.create.trigram = attempt('create t_tri', () => {
    db.exec("CREATE VIRTUAL TABLE t_tri USING fts5(body, tokenize='trigram')");
  });
  result.create.trigramCaseSensitive = attempt('create t_tri_cs', () => {
    db.exec("CREATE VIRTUAL TABLE t_tri_cs USING fts5(body, tokenize='trigram case_sensitive 1')");
  });

  const hasTrigram = result.create.trigram.ok === true;
  const hasU61 = result.create.plainFts5.ok === true;

  if (hasTrigram) {
    for (const r of SYNTHETIC_ROWS) db.prepare('INSERT INTO t_tri(body) VALUES (?)').run(r.body);
  }
  if (result.create.trigramCaseSensitive.ok === true) {
    for (const r of SYNTHETIC_ROWS) db.prepare('INSERT INTO t_tri_cs(body) VALUES (?)').run(r.body);
  }
  if (hasU61) {
    for (const r of SYNTHETIC_ROWS) db.prepare('INSERT INTO t_u61(body) VALUES (?)').run(r.body);
  }
  result.rowCounts = {
    t_plain: db.prepare('SELECT count(*) AS n FROM t_plain').get().n,
    t_u61: hasU61 ? db.prepare('SELECT count(*) AS n FROM t_u61').get().n : null,
    t_tri: hasTrigram ? db.prepare('SELECT count(*) AS n FROM t_tri').get().n : null,
    t_tri_cs: result.create.trigramCaseSensitive.ok ? db.prepare('SELECT count(*) AS n FROM t_tri_cs').get().n : null,
  };
  result.tables = {
    t_plain: '普通 B-tree 表（LIKE 真值基线）',
    t_u61: "fts5(tokenize='unicode61')，插入原始未切分文本",
    t_tri: "fts5(tokenize='trigram')，插入原始文本",
    t_tri_cs: "fts5(tokenize='trigram case_sensitive 1')",
  };

  // --- 1/2/3 码点 MATCH/LIKE 矩阵 ------------------------------------
  const MATRIX_QUERIES = [
    { label: '1cp-BMP', q: '租' },
    { label: '1cp-nonBMP', q: '𠮷' },
    { label: '1cp-ascii', q: 't' },
    { label: '2cp-BMP', q: '租约' },
    { label: '2cp-BMP-2', q: '调用' },
    { label: '2cp-BMP-3', q: '函数' },
    { label: '2cp-ascii', q: 'to' },
    { label: '2cp-nonBMP', q: '𠮷野' },
    { label: '3cp-BMP', q: '租约到' },
    { label: '3cp-word', q: '数据库' },
    { label: '3cp-nonBMP', q: '𠮷野家' },
    { label: '3cp-ascii', q: 'tok' },
    { label: '3cp-ascii-2', q: 'oke' },
    { label: 'long-ascii', q: 'refresh' },
    { label: 'long-ident', q: 'refreshToken' },
  ];

  for (const { label, q } of MATRIX_QUERIES) {
    const ground = query(`GT:${label}`, 'SELECT rowid FROM t_plain WHERE body LIKE ?', [`%${q}%`]);
    const entry = {
      label,
      query: q,
      codepointLen: codepointLen(q),
      utf16Length: utf16Len(q),
      groundTruthRowCount: ground.rowCount,
      match: null,
      like: null,
    };
    if (hasTrigram) {
      entry.match = query(`MATCH:${label}`, 'SELECT rowid FROM t_tri WHERE body MATCH ?', [q]);
      entry.like = query(`LIKE:${label}`, 'SELECT rowid FROM t_tri WHERE body LIKE ?', [`%${q}%`]);
    }
    result.matrix.push(entry);
  }

  // --- unicode61 原始未切分文本的 token 形态（B 的"必须先切分"证据）--
  if (hasU61) {
    for (const q of ['租约', '调用', 'token', 'refreshtoken', 'REFRESH', '𠮷野家', '𠮷野家套餐', '调用refreshToken函数更新令牌']) {
      result.unicode61Raw.push({
        query: q,
        match: query(`u61-MATCH:${q}`, 'SELECT rowid FROM t_u61 WHERE body MATCH ?', [q]),
        like: query(`u61-LIKE:${q}`, 'SELECT rowid FROM t_u61 WHERE body LIKE ?', [`%${q}%`]),
      });
    }
  }

  // --- EXPLAIN QUERY PLAN：LIKE/MATCH 策略对比 ----------------------
  const eqp = (label, sql, params = []) => {
    try {
      const detail = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map((r) => r.detail).join(' | ');
      result.eqp.push({ label, sql, params, detail });
    } catch (error) {
      result.eqp.push({ label, sql, params, detail: null, error: recordError(`EQP:${label}`, error) });
    }
  };
  if (hasTrigram) {
    eqp('tri-LIKE-1cp', 'SELECT rowid FROM t_tri WHERE body LIKE ?', ['%租%']);
    eqp('tri-LIKE-2cp', 'SELECT rowid FROM t_tri WHERE body LIKE ?', ['%租约%']);
    eqp('tri-LIKE-3cp', 'SELECT rowid FROM t_tri WHERE body LIKE ?', ['%租约到%']);
    eqp('tri-LIKE-ascii3', 'SELECT rowid FROM t_tri WHERE body LIKE ?', ['%tok%']);
    eqp('tri-LIKE-nonBMP3', 'SELECT rowid FROM t_tri WHERE body LIKE ?', ['%𠮷野家%']);
    eqp('tri-MATCH-3cp', 'SELECT rowid FROM t_tri WHERE body MATCH ?', ['租约到']);
    eqp('tri-MATCH-1cp', 'SELECT rowid FROM t_tri WHERE body MATCH ?', ['租']);
  }
  if (hasU61) {
    eqp('u61-LIKE-2cp', 'SELECT rowid FROM t_u61 WHERE body LIKE ?', ['%租约%']);
    eqp('u61-MATCH-refreshtoken', 'SELECT rowid FROM t_u61 WHERE body MATCH ?', ['refreshtoken']);
  }
  eqp('plain-LIKE-1cp', 'SELECT rowid FROM t_plain WHERE body LIKE ?', ['%租%']);
  eqp('plain-LIKE-3cp', 'SELECT rowid FROM t_plain WHERE body LIKE ?', ['%租约到%']);

  // --- ESCAPE：字面量 vs 通配 ---------------------------------------
  if (hasTrigram) {
    const escapeCases = [
      { label: 'wildcard-underscore-no-escape', pattern: '%a_b%', escaped: false },
      { label: 'literal-underscore-escaped', pattern: '%a\\_b%', escaped: true },
      { label: 'literal-percent-escaped', pattern: '%100\\%%', escaped: true },
      { label: 'literal-underscore-100-escaped', pattern: '%\\_100%', escaped: true },
    ];
    for (const c of escapeCases) {
      const sql = c.escaped
        ? 'SELECT rowid FROM t_tri WHERE body LIKE ? ESCAPE ?'
        : 'SELECT rowid FROM t_tri WHERE body LIKE ?';
      const params = c.escaped ? [c.pattern, '\\'] : [c.pattern];
      const got = query(`ESC:${c.label}`, sql, params);
      const groundSql = c.escaped
        ? 'SELECT rowid FROM t_plain WHERE body LIKE ? ESCAPE ?'
        : 'SELECT rowid FROM t_plain WHERE body LIKE ?';
      const ground = query(`ESC-GT:${c.label}`, groundSql, params);
      let eqpDetail = null;
      try {
        eqpDetail = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map((r) => r.detail).join(' | ');
      } catch (error) {
        eqpDetail = recordError(`ESC-EQP:${c.label}`, error);
      }
      result.escape.push({
        label: c.label,
        pattern: c.pattern,
        escaped: c.escaped,
        escapeChar: c.escaped ? '\\' : null,
        rowCount: got.rowCount,
        groundTruthRowCount: ground.rowCount,
        eqpDetail,
        error: got.error,
      });
    }
    // ESCAPE 后 EQP 是否仍显示 trigram LIKE 策略（与不带 ESCAPE 的同模式对照）
    eqp('tri-LIKE-escape-literal', 'SELECT rowid FROM t_tri WHERE body LIKE ? ESCAPE ?', ['%\\_100%', '\\']);
  }

  // --- 大小写敏感性 ------------------------------------------------
  const caseQueries = [
    { op: 'MATCH', q: 'refresh' },
    { op: 'MATCH', q: 'REFRESH' },
    { op: 'MATCH', q: 'Refresh' },
    { op: 'MATCH', q: 'token' },
    { op: 'MATCH', q: 'Token' },
    { op: 'LIKE', q: 'refresh' },
    { op: 'LIKE', q: 'REFRESH' },
    { op: 'LIKE', q: 'Refresh' },
  ];
  for (const table of ['t_tri', 't_tri_cs']) {
    if (!result.create.trigram.ok || (table === 't_tri_cs' && !result.create.trigramCaseSensitive.ok)) continue;
    for (const { op, q } of caseQueries) {
      const sql = op === 'MATCH'
        ? table === 't_tri'
          ? 'SELECT rowid FROM t_tri WHERE body MATCH ?'
          : 'SELECT rowid FROM t_tri_cs WHERE body MATCH ?'
        : table === 't_tri'
          ? 'SELECT rowid FROM t_tri WHERE body LIKE ?'
          : 'SELECT rowid FROM t_tri_cs WHERE body LIKE ?';
      const params = op === 'MATCH' ? [q] : [`%${q}%`];
      result.caseSensitivity.push({
        table,
        op,
        query: q,
        ...query(`${table}-${op}-${q}`, sql, params),
      });
    }
  }
  // 普通表 LIKE 默认 ASCII 不区分大小写 vs COLLATE BINARY 区分
  for (const { label, sql, params } of [
    { label: 'plain-LIKE-default', sql: "SELECT rowid FROM t_plain WHERE body LIKE ?", params: ['%refresh%'] },
    { label: 'plain-LIKE-default-upper', sql: 'SELECT rowid FROM t_plain WHERE body LIKE ?', params: ['%REFRESH%'] },
    { label: 'plain-LIKE-binary', sql: 'SELECT rowid FROM t_plain WHERE body COLLATE BINARY LIKE ?', params: ['%refresh%'] },
    { label: 'plain-LIKE-binary-upper', sql: 'SELECT rowid FROM t_plain WHERE body COLLATE BINARY LIKE ?', params: ['%REFRESH%'] },
  ]) {
    result.caseSensitivity.push({ table: 't_plain', op: label, query: params[0], ...query(label, sql, params) });
  }
  // case_sensitive trigram 表上的 LIKE：结果与 EQP 都要记录（LIKE 大小写规则是否被表选项改变）
  if (result.create.trigramCaseSensitive.ok) {
    for (const [label, q] of [['tri_cs-LIKE-upper', 'REFRESH'], ['tri_cs-LIKE-lower', 'refresh']]) {
      result.caseSensitivity.push({
        table: 't_tri_cs',
        op: 'LIKE',
        query: q,
        ...query(label, 'SELECT rowid FROM t_tri_cs WHERE body LIKE ?', [`%${q}%`]),
      });
      eqp(label, 'SELECT rowid FROM t_tri_cs WHERE body LIKE ?', [`%${q}%`]);
    }
  }

  // --- 码点 / 码元 / UTF-8 字节 ------------------------------------
  for (const s of ['租', '租约', '𠮷', '𠮷野', '𠮷野家', '👍', '👨‍👩‍👧']) {
    const sqlite = db.prepare('SELECT length(?) AS chars, length(CAST(? AS BLOB)) AS bytes').get(s, s);
    result.codepointLengths.push({
      input: s,
      jsCodepoints: codepointLen(s),
      jsUtf16Units: utf16Len(s),
      sqliteChars: sqlite.chars,
      sqliteUtf8Bytes: sqlite.bytes,
    });
  }

  // --- MATCH 语法中的特殊字符（查询构造器必须处理）------------------
  if (hasTrigram) {
    for (const { label, q } of [
      { label: 'percent-raw', q: '100%' },
      { label: 'percent-quoted', q: '"100%"' },
      { label: 'underscore', q: 'a_b' },
      { label: 'prefix-3cp', q: '租约*' },
      { label: 'prefix-2cp', q: '租*' },
      { label: 'prefix-ascii', q: 'tok*' },
      { label: 'prefix-ascii-long', q: 'refresh*' },
      { label: 'prefix-cjk-3cp', q: '数据*' },
      { label: 'prefix-cjk-3cp-full', q: '数据库*' },
      { label: 'prefix-cjk-run', q: '租约到*' },
      { label: 'prefix-ascii-token', q: 'token*' },
    ]) {
      result.matchSyntax.push({ ...query(`MATCH-SYNTAX:${label}`, 'SELECT rowid FROM t_tri WHERE body MATCH ?', [q]), label, query: q });
    }
  }

  // --- 方案 B / B+ 模拟：Segmenter 预处理 vs 追加子词 ----------------
  const planTexts = ['租约到期提醒', '数据库连接池', '调用refreshToken函数更新令牌', '修复死锁后回滚事务并更新租约状态'];
  if (hasU61) {
    db.exec('CREATE VIRTUAL TABLE t_b USING fts5(body)');
    db.exec('CREATE VIRTUAL TABLE t_bplus USING fts5(body)');
    planTexts.forEach((text, i) => {
      db.prepare('INSERT INTO t_b(rowid, body) VALUES (?, ?)').run(i + 1, wordSegments(text).join(' '));
      db.prepare('INSERT INTO t_bplus(rowid, body) VALUES (?, ?)').run(i + 1, indexTextBPlus(text));
    });
    const planQueries = ['token', 'refresh', 'refreshtoken', '租约', '死锁', '数据库', '调用', '回滚'];
    const planResults = [];
    for (const q of planQueries) {
      const queryTokens = tokenizeMixed(q);
      const b = query(`B:${q}`, 'SELECT rowid FROM t_b WHERE body MATCH ?', [queryTokens.join(' ')]);
      const bplus = query(`B+:${q}`, 'SELECT rowid FROM t_bplus WHERE body MATCH ?', [queryTokens.join(' ')]);
      const phrase = queryTokens.length > 1
        ? query(`B-phrase:${q}`, 'SELECT rowid FROM t_b WHERE body MATCH ?', [`"${queryTokens.join(' ')}"`])
        : null;
      planResults.push({ query: q, queryTokens, b, bplus, bPhrase: phrase });
    }
    result.planSimulation = {
      tableRows: planTexts.map((text, i) => ({
        rowid: i + 1,
        original: text,
        bIndexText: wordSegments(text).join(' '),
        bPlusIndexText: indexTextBPlus(text),
      })),
      queries: planResults,
    };
  }

  // --- 相邻性：AND 语义 vs 短语语义（中文逐字 token 化之后）---------
  if (hasU61) {
    db.exec('CREATE VIRTUAL TABLE t_adj USING fts5(body)');
    const adjRows = [
      '修 复 死 锁 后 回 滚 事 务 并 更 新 租 约 状 态',
      '死 亡 事 故 与 锁 定 无 关',
      '锁 定 之 后 死 亡',
    ];
    adjRows.forEach((body, i) => db.prepare('INSERT INTO t_adj(rowid, body) VALUES (?, ?)').run(i + 1, body));
    for (const { label, q } of [
      { label: 'and-semantics', q: '死 锁' },
      { label: 'phrase-adjacent', q: '"死 锁"' },
    ]) {
      result.adjacency.push({
        ...query(`ADJ:${label}`, 'SELECT rowid FROM t_adj WHERE body MATCH ?', [q]),
        label,
        matchQuery: q,
        rows: adjRows,
      });
    }
  }

  // --- snippet：MATCH 可用性与"FTS 列不可用于展示"的证据 ------------
  if (hasTrigram) {
    result.snippets.push({
      ...query('snippet-tri-match', "SELECT snippet(t_tri, 0, '[', ']', '…', 10) AS s FROM t_tri WHERE t_tri MATCH ?", ['数据库']),
      label: 'tri-MATCH-snippet',
    });
    result.snippets.push({
      ...query('snippet-tri-like', "SELECT snippet(t_tri, 0, '[', ']', '…', 10) AS s FROM t_tri WHERE body LIKE ?", ['%数据库%']),
      label: 'tri-LIKE-snippet',
    });
  }
  if (hasU61) {
    result.snippets.push({
      ...query('snippet-b-match', "SELECT snippet(t_b, 0, '[', ']', '…', 10) AS s FROM t_b WHERE t_b MATCH ?", ['租约']),
      label: 'b-segmented-MATCH-snippet',
    });
  }

  // --- bm25 多列加权 API 可用性（仅机制可用性，不做排序结论）--------
  if (hasU61) {
    db.exec('CREATE VIRTUAL TABLE t_c USING fts5(word, gram)');
    const cTexts = ['租约到期提醒', '账本与租约', '幂等性检查'];
    cTexts.forEach((text, i) => {
      db.prepare('INSERT INTO t_c(rowid, word, gram) VALUES (?, ?, ?)').run(
        i + 1,
        wordSegments(text).join(' '),
        cjkBigrams(text).join(' '),
      );
    });
    const score = (weights) => {
      try {
        const sql = 'SELECT rowid, bm25(t_c, ?, ?) AS score FROM t_c WHERE t_c MATCH ? ORDER BY score';
        const got = db.prepare(sql).all(Number(weights[0]), Number(weights[1]), '租约');
        return { weights, sql, rows: got.map((r) => ({ rowid: r.rowid, score: r.score })) };
      } catch (error) {
        return { weights, rows: null, error: recordError('bm25', error) };
      }
    };
    result.bm25 = {
      tableDef: 'fts5(word, gram)：word=Segmenter 词列，gram=CJK 2-gram 列，uni-gram 权重可调',
      rows: cTexts.map((text, i) => ({ rowid: i + 1, word: wordSegments(text).join(' '), gram: cjkBigrams(text).join(' ') })),
      query: '租约',
      runs: [score([4.0, 1.0]), score([1.0, 4.0])],
      note: '仅验证 bm25 多列加权 API 可用与数值有限；3 行合成数据不构成任何方案排序结论。',
    };
  }

  // 词列/2-gram 列对标识符子串的覆盖（方案 C 的已知短板，机制性验证）
  if (hasU61) {
    const bgramQ = (q) => {
      try {
        const got = db.prepare('SELECT rowid FROM t_c WHERE gram MATCH ?').all(q);
        return got.length;
      } catch (error) {
        return recordError(`bigram-match:${q}`, error);
      }
    };
    result.bigramSubstring = {
      note: 'gram 列为 CJK-only 2-gram；refreshToken 内部子串不在该列，验证架构 §6.1 "CJK-only 2-gram 仍漏 refreshToken 内子串"。',
      rows: { 租约: bgramQ('租约'), 租: bgramQ('租'), token: bgramQ('token') },
    };
  }

  db.close();
  return result;
}

/* ------------------------------------------------------------------ */
/* 五、组装 evidence                                                   */
/* ------------------------------------------------------------------ */

function probeSegmenter() {
  const available = segmenterAvailable();
  const samples = SEGMENTER_SAMPLES.map((input) => ({
    input,
    codepoints: codepointLen(input),
    utf16Length: utf16Len(input),
    segments: segmentWords(input) || null,
  }));
  const crossLocaleInput = '调用refreshToken函数修复死锁回滚事务';
  const crossLocale = available
    ? SEGMENTER_LOCALES.map((locale) => ({
      locale,
      segments: (segmentWords(crossLocaleInput, locale) || []).map((s) => s.segment),
    }))
    : [];
  return {
    available,
    constructor: available ? 'Intl.Segmenter' : null,
    locale: 'zh',
    granularity: 'word',
    samples,
    crossLocale: { input: crossLocaleInput, results: crossLocale },
    graphemeVsCodepoint: [
      { input: '租', codepoints: 1, utf16Units: 1 },
      { input: '𠮷', codepoints: 1, utf16Units: 2 },
      { input: '𠮷野家', codepoints: 3, utf16Units: 4 },
    ],
  };
}

function probeIdentifierSplitting() {
  const cases = Object.entries(EXPECTED_SUBWORDS).map(([input, expected]) => {
    const actual = splitIdentifier(input);
    return {
      input,
      expected,
      actual,
      pass: JSON.stringify(actual) === JSON.stringify(expected),
      expanded: expandIdentifier(input),
    };
  });
  const extra = ['refreshToken', 'HTTPServer', 'OAuth2Token', '$scope', 'a1b2', 'A', '', '调用refreshToken函数'];
  const determinism = extra.map((input) => ({
    input,
    first: splitIdentifier(input),
    second: splitIdentifier(input),
    expanded: expandIdentifier(input),
  }));
  return {
    version: IDENTIFIER_SPLIT_VERSION,
    icuDependent: false,
    ruleSummary:
      '分隔符（_ - . $ 及其余非字母数字）一律断开；字母↔数字两个方向都拆；小写→大写拆；'
      + '连续大写缩写结束处拆（XML|Http、HTML|String）；子词统一小写、去重、保留顺序；原词由调用方保留。',
    cases,
    extra,
    determinism,
    mixedPipeline: {
      input: '调用refreshToken函数',
      segments: segmentWords('调用refreshToken函数'),
      tokensBPlus: tokenizeMixed('调用refreshToken函数'),
      indexTextBPlus: indexTextBPlus('调用refreshToken函数'),
    },
  };
}

function buildSummary(environment, segmenter, fts, identifier) {
  const summary = {
    environment: {
      node: environment.node,
      icu: environment.icu,
      unicode: environment.unicode,
      cldr: environment.cldr,
      sqlite: environment.sqlite,
    },
    fts5Available: fts.create ? fts.create.plainFts5?.ok === true : false,
    trigramAvailable: fts.create ? fts.create.trigram?.ok === true : false,
    trigramCaseSensitiveAvailable: fts.create ? fts.create.trigramCaseSensitive?.ok === true : false,
    segmenterAvailable: segmenter.available,
    silentZeroMatch: [],
    matchEqualsGroundTruth: [],
    lengthRoutingNeeded: null,
    segmenterWordLevelZh: null,
    segmenterKeepsIdentifierWhole: null,
    splitterMandatedCasesPass: identifier.cases.every((c) => c.pass),
    splitterVersion: identifier.version,
  };
  if (Array.isArray(fts.matrix)) {
    for (const entry of fts.matrix) {
      const m = entry.match === null ? null : entry.match.rowCount;
      const gt = entry.groundTruthRowCount;
      summary.matchEqualsGroundTruth.push({ query: entry.query, codepoints: entry.codepointLen, match: m, like: entry.like ? entry.like.rowCount : null, groundTruth: gt, equal: m === gt });
      if (entry.codepointLen < 3 && m !== null && m < gt) {
        summary.silentZeroMatch.push({ query: entry.query, codepoints: entry.codepointLen, match: m, groundTruth: gt });
      }
    }
    summary.lengthRoutingNeeded = summary.silentZeroMatch.length > 0;
  }
  if (segmenter.available) {
    const find = (input) => segmenter.samples.find((s) => s.input === input);
    const wordLikeCount = (input) => {
      const sample = find(input);
      return sample && sample.segments ? sample.segments.filter((s) => s.isWordLike).length : null;
    };
    summary.segmenterWordLevelZh = {
      '租约': wordLikeCount('租约'),
      '账本': wordLikeCount('账本'),
      '数据库': wordLikeCount('数据库'),
      '死锁': wordLikeCount('死锁'),
      '回滚': wordLikeCount('回滚'),
      '幂等': wordLikeCount('幂等'),
      '调用refreshToken函数': wordLikeCount('调用refreshToken函数'),
    };
    summary.segmenterKeepsIdentifierWhole = {
      refreshToken: wordLikeCount('refreshToken'),
      refresh_token: wordLikeCount('refresh_token'),
      XMLHttpRequest: wordLikeCount('XMLHttpRequest'),
    };
  }
  return summary;
}

export async function collectEvidence({ outPath = null } = {}) {
  const environment = {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    v8: process.versions.v8,
    modules: process.versions.modules,
    icu: process.versions.icu ?? null,
    unicode: process.versions.unicode ?? null,
    cldr: process.versions.cldr ?? null,
    tz: process.versions.tz ?? null,
    sqlite: process.versions.sqlite ?? null,
    icuSmall: process.config?.variables?.icu_small ?? null,
    execPath: process.execPath,
    cwd: process.cwd(),
    scriptPath: SCRIPT_PATH,
    argv: process.argv.slice(0, 2),
  };

  let DatabaseSync = null;
  let loadError = null;
  try {
    // 动态 import：确保实验性警告监听器先挂上
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch (error) {
    loadError = String((error && error.message) || error);
  }

  const segmenter = probeSegmenter();
  const identifier = probeIdentifierSplitting();
  const fts = DatabaseSync
    ? runFtsProbe(DatabaseSync)
    : { loaded: false, loadError, create: {}, matrix: [], errors: [{ label: 'import node:sqlite', message: loadError }] };

  // 让已排队的 process warnings 落盘
  await new Promise((resolve) => setTimeout(resolve, 50));

  const evidence = {
    schema: 'ano-s1-search-evidence/v1',
    spike: 'S1',
    segment: 'mechanism',
    generatedAt: new Date().toISOString(),
    command: `node "${SCRIPT_PATH}"${outPath ? ` --out "${outPath}"` : ''}`,
    inputs: 'synthetic-strings-only',
    privacy: {
      realSessionSampling: false,
      realSessionFilesRead: false,
      note: 'G3 未授权真实会话采样；本文件不含任何真实会话内容，也不含排序/召回结论。',
    },
    environment,
    runtimeWarnings,
    segmenter,
    identifierSplitting: identifier,
    sqlite: fts,
    summary: buildSummary(environment, segmenter, fts, identifier),
  };
  return evidence;
}

/* ------------------------------------------------------------------ */
/* 六、CLI                                                             */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  let out = DEFAULT_OUT;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      return { help: true, out };
    }
    if (arg === '--out') {
      const value = argv[i + 1];
      if (!value) throw new Error('--out 需要一个路径参数');
      out = value;
      i += 1;
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  if (!path.isAbsolute(out)) {
    throw new Error(`输出路径必须是绝对路径（收到 "${out}"）。避免在不可信工作目录中写入。`);
  }
  return { help: false, out };
}

export async function main(argv = process.argv.slice(2)) {
  const { help, out } = parseArgs(argv);
  if (help) {
    console.log('用法：node "<abs>/scripts/spikes/s1-search.mjs" --out "<abs>/docs/evidence/s1-search.json"');
    return null;
  }
  const evidence = await collectEvidence({ outPath: out });
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');

  const s = evidence.summary;
  const line = (label, value) => console.log(`${label}: ${value}`);
  console.log(`S1 mechanism evidence -> ${out}`);
  line('Node', `${s.environment.node} (ICU ${s.environment.icu}, Unicode ${s.environment.unicode}, CLDR ${s.environment.cldr})`);
  line('SQLite', s.environment.sqlite);
  line('FTS5', s.fts5Available);
  line('trigram', s.trigramAvailable);
  line('trigram case_sensitive', s.trigramCaseSensitiveAvailable);
  line('Intl.Segmenter', s.segmenterAvailable);
  if (s.silentZeroMatch.length > 0) {
    line('silent MATCH zero rows (<3cp)', JSON.stringify(s.silentZeroMatch));
  } else if (s.lengthRoutingNeeded === false) {
    line('silent MATCH zero rows (<3cp)', 'none observed');
  }
  line('lengthRoutingNeeded', s.lengthRoutingNeeded);
  if (s.segmenterWordLevelZh) line('Segmenter zh wordLike counts', JSON.stringify(s.segmenterWordLevelZh));
  const splitPass = evidence.identifierSplitting.cases.every((c) => c.pass);
  line('splitIdentifier mandated cases', splitPass ? 'all pass' : JSON.stringify(evidence.identifierSplitting.cases.filter((c) => !c.pass)));
  return evidence;
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]).toLowerCase() === path.resolve(SCRIPT_PATH).toLowerCase();

if (invokedDirectly) {
  try {
    await main();
  } catch (error) {
    console.error(`S1 spike 失败：${(error && error.stack) || error}`);
    process.exitCode = 2;
  }
}
