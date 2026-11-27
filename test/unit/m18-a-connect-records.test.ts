/**
 * T-153 分片 A：connect/records 提取残余分支（结构错误、归档分类、JSONL、决策条目）。
 *
 * 直接以内存 SourceScan 调用 extractRecords，不触碰真实 pm-mcp 项目；错误按
 * ConnectSourceError 的显式消息断言。
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { SourceScan, ScannedFile } from '../../src/connect/adapter.ts';
import { ConnectSourceError } from '../../src/connect/errors.ts';
import {
  categoryForStatus,
  extractRecords,
  recordsFingerprint,
  toConnectedTask,
} from '../../src/connect/records.ts';
import type { ConnectedIdentity, StoredRecord } from '../../src/connect/types.ts';

const IDENTITY = { tool: 'pm-mcp' as const, instance: 'instance-1', project: 'project', projectId: 'pid-1', projectKey: 'key-1' };

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function scannedFile(path: string, content: string | Buffer, binary = false): ScannedFile {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return { path, bytes: bytes.length, hash: sha256(bytes), content: bytes, mediaType: 'application/octet-stream', binary };
}

function scan(files: readonly ScannedFile[]): SourceScan {
  return {
    root: 'R',
    source: 'pm-mcp',
    identity: IDENTITY,
    files: [...files],
    excluded: [],
    sourceDigest: 'digest',
    warnings: [],
    counts: { files: files.length, totalBytes: files.reduce((total, file) => total + file.bytes, 0), textFiles: files.length, binaryFiles: 0, excluded: 0, excludedBytes: 0 },
  };
}

function expectSourceError(run: () => unknown, pattern: RegExp): void {
  assert.throws(run, (error: unknown) => error instanceof ConnectSourceError && pattern.test(error.message));
}

test('T-153 categoryForStatus 覆盖同义状态与未知回退', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['done', 'completed'], ['Completed', 'completed'], ['complete', 'completed'], ['finished', 'completed'],
    ['in_progress', 'in_progress'], ['IN-PROGRESS', 'in_progress'], ['doing', 'in_progress'], ['Active', 'in_progress'],
    ['todo', 'todo'], [' Pending ', 'todo'], ['planned', 'todo'],
    ['cancelled', 'cancelled'], ['canceled', 'cancelled'], ['Cancel', 'cancelled'],
    ['something-else', 'unknown'], ['', 'unknown'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(categoryForStatus(input), expected, input);
  }
});

test('T-153 tasks 条目结构错误、缺失 id 与数字 id 逐项处理', () => {
  expectSourceError(
    () => extractRecords(scan([scannedFile('tasks.json', JSON.stringify({ tasks: [['not-an-object']] }))]), 'conn-1'),
    /must be a JSON object/u,
  );
  expectSourceError(
    () => extractRecords(scan([scannedFile('tasks.json', JSON.stringify({ tasks: [{ title: 'no id' }] }))]), 'conn-1'),
    /missing a usable id/u,
  );
  expectSourceError(
    () => extractRecords(scan([scannedFile('tasks.json', JSON.stringify({ tasks: [{ id: 'dup' }, { id: 'dup' }] }))]), 'conn-1'),
    /Duplicate task source id/u,
  );

  const numeric = extractRecords(scan([scannedFile('tasks.json', JSON.stringify({ tasks: [{ id: 7, title: 'numeric', status: 'done' }] }))]), 'conn-1');
  assert.equal(numeric.records[0]?.sourceId, '7');
  assert.equal(numeric.recordCounts['task'], 1);

  expectSourceError(() => extractRecords(scan([scannedFile('tasks.json', '{bad json')]), 'conn-1'), /Malformed JSON/u);
});

test('T-153 decisions.json 数组/对象形态与未知 JSON 归档', () => {
  const arrayForm = extractRecords(scan([scannedFile('decisions.json', JSON.stringify([{ id: 'd1', title: 'Array decision' }]))]), 'conn-1');
  assert.equal(arrayForm.records[0]?.kind, 'decision');
  assert.equal(arrayForm.records[0]?.title, 'Array decision');

  const objectForm = extractRecords(scan([scannedFile('decisions.json', JSON.stringify({ decisions: [{ id: 'd2', name: 'Object decision' }] }))]), 'conn-1');
  assert.equal(objectForm.records[0]?.kind, 'decision');
  assert.equal(objectForm.records[0]?.title, 'Object decision');

  const generic = extractRecords(scan([scannedFile('weird.json', JSON.stringify({ a: 1 }))]), 'conn-1');
  assert.equal(generic.records[0]?.kind, 'archive');
  assert.deepEqual(generic.records[0]?.raw, { a: 1 });

  const scalar = extractRecords(scan([scannedFile('scalar.json', '42')]), 'conn-1');
  assert.equal(scalar.records[0]?.kind, 'archive');
  assert.deepEqual(scalar.records[0]?.raw, { value: 42 });
});

test('T-153 JSONL 无效行告警与 parsedLines 计数', () => {
  const result = extractRecords(
    scan([scannedFile('logs/runtime.jsonl', '{"a":1}\nnot json\n\n{"b":2}\n')]),
    'conn-1',
  );
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0]!, /skipped 1 unparseable JSONL line\(s\) \(2\)/u);
  const record = result.records[0]!;
  assert.equal(record.kind, 'log');
  assert.equal((record.raw as Record<string, unknown>)['parsedLines'], 2);
});

test('T-153 决策 Markdown 标题回退与归档路径分类', () => {
  const files = [
    scannedFile('decisions/adr.md', '# Decision Title\nbody'),
    scannedFile('decisions/plain.md', 'body without heading'),
    scannedFile('.runtime/index.db', Buffer.from('binary'), true),
    scannedFile('snapshots/snap.bin', Buffer.from('snapshot'), true),
    scannedFile('quality-runs/run.json', '{}'),
    scannedFile('notes.txt', 'plain archive'),
  ];
  const result = extractRecords(scan(files), 'conn-1');
  const byPath = new Map(result.records.map((record) => [record.sourcePath, record]));
  assert.equal(byPath.get('decisions/adr.md')?.title, 'Decision Title');
  assert.equal(byPath.get('decisions/plain.md')?.title, 'plain');
  assert.equal(byPath.get('.runtime/index.db')?.kind, 'runtime');
  assert.equal(byPath.get('snapshots/snap.bin')?.kind, 'snapshot');
  assert.equal(byPath.get('quality-runs/run.json')?.kind, 'quality-run');
  assert.equal(byPath.get('notes.txt')?.kind, 'archive');
});

test('T-153 toConnectedTask 仅复制字符串可选字段；指纹稳定且顺序敏感', () => {
  const first = extractRecords(
    scan([scannedFile('tasks.json', JSON.stringify({
      tasks: [{ id: 't1', title: 'Task', status: 'doing', milestone: 'M1', priority: 'P1', type: 'bug', effort: 3 }],
    }))]),
    'conn-1',
  );
  const record = first.records[0]!;
  const connected = toConnectedTask(record);
  assert.equal(connected.milestone, 'M1');
  assert.equal(connected.priority, 'P1');
  assert.equal(connected.type, 'bug');
  assert.equal('effort' in connected, false);

  const copy: StoredRecord = {
    ...record,
    identity: { ...(record.identity as ConnectedIdentity) },
    raw: { ...record.raw },
  };
  assert.equal(recordsFingerprint([record, copy]), recordsFingerprint([copy, record]));
  assert.notEqual(recordsFingerprint([record]), recordsFingerprint([copy, record]));
});
