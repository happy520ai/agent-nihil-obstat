#!/usr/bin/env node
// S6: three local git branches, each adds its own independent ledger segment,
// then merges back. After the merge:
//   - replayed event count must equal the sum of per-segment event counts;
//   - every segment's own prev_hash chain (GENESIS -> head) must verify;
//   - every head-event `observed` reference must resolve to an existing
//     segment's head hash;
//   - cross-segment prev_hash linkage is deliberately NOT enforced.
//
// Everything happens in a throwaway git repo under the OS temp directory.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EVIDENCE = path.join(ROOT, 'docs', 'evidence', 's6-segment-merge.json');

const GENESIS = '0'.repeat(64);

const PROBLEM =
  '三个本地 git 分支各自新建独立 ledger segment 后合并：是否无冲突、重放事件数=各段之和、每个 segment 单链哈希可独立校验、observed 引用可解析，且不强加跨 segment 全链。';
const METHOD =
  '在临时 git 仓库先用主分支提交两个 seed segment 作共同基线；三支分别新增一个 segment（头事件 observed 记录基线段头哈希）；依次 git merge --no-ff 回主分支；对合并后的每个文件独立重放并解析 observed。';
const PASS_CRITERIA = [
  '三个分支均成功合并，无冲突，工作树干净',
  '合并后 segment 文件数 = 基线数 + 3',
  '重放事件总数 = 所有 segment 事件数之和',
  '每个 segment 的段内单链从 GENESIS 到末事件全部通过',
  '所有 observed 引用可解析到现存 segment 的头哈希',
  '不要求跨 segment prev_hash 连续',
];

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function eventHash(event) {
  return sha256(Buffer.from(canonicalJson(event), 'utf8'));
}

function verifySegment(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
  const errors = [];
  let prev = GENESIS;
  for (const event of lines) {
    if (event.prev_hash !== prev) {
      errors.push({ id: event.id, expected: prev, actual: event.prev_hash });
    }
    prev = eventHash(event);
  }
  return {
    raw,
    events: lines,
    eventCount: lines.length,
    head: lines[0] ?? null,
    headHash: lines.length > 0 ? eventHash(lines[0]) : null,
    lastHash: prev,
    chainOk: errors.length === 0,
    chainErrors: errors,
  };
}

function ledgerPath(fileName) {
  return `.ano/ledger/${fileName}`;
}

function buildSegmentFile({ ledgerDir, fileName, actor, events, observed }) {
  let prev = GENESIS;
  const lines = events.map((event, index) => {
    const record = {
      id: event.id,
      hlc: event.hlc,
      actor,
      kind: event.kind,
      payload: event.payload,
      ...(index === 0 ? { observed } : {}),
      prev_hash: prev,
    };
    prev = eventHash(record);
    return record;
  });
  fs.writeFileSync(
    path.join(ledgerDir, fileName),
    `${lines.map((line) => `${JSON.stringify(line)}\n`).join('')}`,
  );
  return { fileName, actor, events: lines, eventCount: lines.length, lastHash: prev };
}

function git(recorded, repo, args, options = {}) {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true });
  recorded.push({
    args: `git ${args.join(' ')}`,
    status: result.status,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
  });
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr ?? result.stdout}`);
  }
  return result;
}

function branchEvents(prefix, hlcBase) {
  return [
    { id: `${prefix}-0001`, hlc: `${hlcBase}-0001`, kind: 'session.start', payload: { note: `${prefix} session start` } },
    { id: `${prefix}-0002`, hlc: `${hlcBase}-0002`, kind: 'note.record', payload: { note: `${prefix} note`, branch: prefix } },
  ];
}

function main() {
  const startedAt = new Date().toISOString();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ano-s6-'));
  const recorded = [];

  git(recorded, repo, ['init', '-b', 'main']);
  git(recorded, repo, ['config', 'user.name', 'ano-s6-spike']);
  git(recorded, repo, ['config', 'user.email', 'ano-s6-spike@example.invalid']);
  git(recorded, repo, ['config', 'core.autocrlf', 'false']);
  git(recorded, repo, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# S6 temporary repo\n');

  const ledgerDir = path.join(repo, '.ano', 'ledger');
  fs.mkdirSync(ledgerDir, { recursive: true });

  // Baseline: two seed segments committed on main before the branches fork.
  const seedA = buildSegmentFile({
    ledgerDir,
    fileName: '2026-11-18T00-00-00Z-seed-a.jsonl',
    actor: 's6-seed-a',
    events: [
      { id: 'seed-a-0001', hlc: '2026-11-18T00:00:00.000Z-0001', kind: 'session.start', payload: { note: 'seed a' } },
      { id: 'seed-a-0002', hlc: '2026-11-18T00:00:00.001Z-0002', kind: 'note.record', payload: { note: 'seed a note 1' } },
      { id: 'seed-a-0003', hlc: '2026-11-18T00:00:00.002Z-0003', kind: 'note.record', payload: { note: 'seed a note 2' } },
    ],
    observed: {},
  });
  const seedAHashes = verifySegment(path.join(ledgerDir, seedA.fileName));
  const seedB = buildSegmentFile({
    ledgerDir,
    fileName: '2026-11-18T00-00-05Z-seed-b.jsonl',
    actor: 's6-seed-b',
    events: [
      { id: 'seed-b-0001', hlc: '2026-11-18T00:00:05.000Z-0001', kind: 'session.start', payload: { note: 'seed b' } },
      { id: 'seed-b-0002', hlc: '2026-11-18T00:00:05.001Z-0002', kind: 'note.record', payload: { note: 'seed b note' } },
    ],
    // seed-b started after seed-a already existed, so it observed seed-a.
    observed: { [ledgerPath(seedA.fileName)]: seedAHashes.headHash },
  });

  git(recorded, repo, ['add', '.']);
  git(recorded, repo, ['commit', '-m', 'base: seed segments']);
  const baseHead = git(recorded, repo, ['rev-parse', 'HEAD']).stdout.trim();

  // Three branches, each from the same baseline, each adding its own segment.
  const branchNames = ['branch-a', 'branch-b', 'branch-c'];
  const branchSegments = [];
  for (const branch of branchNames) {
    git(recorded, repo, ['checkout', '-b', branch, 'main']);
    const observed = {
      [ledgerPath(seedA.fileName)]: seedAHashes.headHash,
      [ledgerPath(seedB.fileName)]: verifySegment(path.join(ledgerDir, seedB.fileName)).headHash,
    };
    const segment = buildSegmentFile({
      ledgerDir,
      fileName: `2026-11-18T00-01-${branch.slice(-1)}0Z-${branch}.jsonl`,
      actor: `s6-${branch}`,
      events: branchEvents(branch, '2026-11-18T00:01:00.000Z'),
      observed,
    });
    branchSegments.push({ branch, ...segment, observed });
    git(recorded, repo, ['add', '.']);
    git(recorded, repo, [`commit`, '-m', `${branch}: add own segment`]);
    git(recorded, repo, ['checkout', 'main']);
  }

  // Merge all three, sequentially, with --no-ff so each becomes a merge commit.
  const mergeResults = [];
  for (const branch of branchNames) {
    const result = git(recorded, repo, ['merge', '--no-ff', branch, '-m', `merge ${branch} into main`]);
    mergeResults.push({ branch, status: result.status, output: result.stdout.trim() || result.stderr.trim() });
  }

  const statusAfterMerge = git(recorded, repo, ['status', '--porcelain']).stdout.trim();
  const logAll = git(recorded, repo, ['log', '--graph', '--oneline', '--all']).stdout;
  const trackedLedgerFiles = git(recorded, repo, ['ls-files', '.ano/ledger']).stdout
    .split('\n')
    .filter((line) => line.length > 0)
    .sort();

  // Independent replay of every merged segment.
  const segmentReports = trackedLedgerFiles.map((fileName) => {
    const filePath = path.join(repo, fileName);
    const verification = verifySegment(filePath);
    const observed = verification.head?.observed ?? null;
    const observedResolved = [];
    let observedOk = observed !== null;
    if (observed && typeof observed === 'object') {
      for (const [ref, expectedHash] of Object.entries(observed)) {
        const refPath = path.join(repo, ref);
        let resolved = false;
        let actual = null;
        if (fs.existsSync(refPath)) {
          actual = verifySegment(refPath).headHash;
          resolved = actual === expectedHash;
        }
        observedResolved.push({ ref, expectedHash, actualHash: actual, resolved });
        if (!resolved) observedOk = false;
      }
    }
    return {
      fileName,
      actor: verification.head?.actor ?? null,
      eventCount: verification.eventCount,
      headHash: verification.headHash,
      lastHash: verification.lastHash,
      chainOk: verification.chainOk,
      chainErrors: verification.chainErrors,
      events: verification.events,
      observed,
      observedResolved,
      observedOk,
    };
  });

  const totalEvents = segmentReports.reduce((sum, segment) => sum + segment.eventCount, 0);
  const expectedTotal =
    seedA.eventCount +
    seedB.eventCount +
    branchSegments.reduce((sum, segment) => sum + segment.eventCount, 0);
  const expectedSegmentCount = 2 + branchNames.length;
  const allChainsOk = segmentReports.every((segment) => segment.chainOk);
  const allObservedOk = segmentReports.every((segment) => segment.observedOk);
  const segmentsStartingAtGenesis = segmentReports.filter(
    (segment) => segment.events[0].prev_hash === GENESIS,
  ).length;
  const concatenatedChainValid = (() => {
    // Deliberately NOT a criterion: joining all segments and requiring one
    // global prev_hash chain must fail, because every segment restarts at GENESIS.
    let prev = GENESIS;
    for (const segment of segmentReports) {
      for (const event of segment.events) {
        if (event.prev_hash !== prev) return false;
        prev = eventHash(event);
      }
    }
    return true;
  })();

  const pass =
    mergeResults.every((merge) => merge.status === 0) &&
    statusAfterMerge.length === 0 &&
    trackedLedgerFiles.length === expectedSegmentCount &&
    totalEvents === expectedTotal &&
    allChainsOk &&
    allObservedOk;

  const evidence = {
    spike: 'S6',
    title: '三分支独立 segment 合并',
    generatedAt: new Date().toISOString(),
    startedAt,
    environment: {
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      os: `${os.type()} ${os.release()}`,
      git: (() => {
        const version = spawnSync('git', ['--version'], { encoding: 'utf8' });
        return version.stdout.trim();
      })(),
      tempRepo: repo,
    },
    problem: PROBLEM,
    method: METHOD,
    passCriteria: PASS_CRITERIA,
    design: {
      baseline: 'main 先提交两个 seed segment（seed-a 观察集为空，seed-b 观察到 seed-a）',
      branches: branchNames.map((branch) => ({
        branch,
        segment: branchSegments.find((segment) => segment.branch === branch).fileName,
        observed: '两个 seed segment 的头哈希',
      })),
      mergeStrategy: '顺序 git merge --no-ff',
      hash: 'canonicalJson(event) 的 SHA-256；每个 segment 从 GENESIS 起',
    },
    gitCommands: recorded,
    baseCommit: baseHead,
    mergeResults,
    logAll,
    segments: segmentReports,
    totals: {
      segmentCount: trackedLedgerFiles.length,
      expectedSegmentCount,
      eventCount: totalEvents,
      expectedEventCount: expectedTotal,
      sumMatches: totalEvents === expectedTotal,
    },
    crossSegment: {
      enforced: false,
      segmentsStartingAtGenesis,
      concatenatedGlobalChainValid: concatenatedChainValid,
      note: '跨 segment 全链按架构 §4.1 不是约束；拼接后全局链不成立是预期结果，不计失败。',
    },
    workingTreeCleanAfterMerge: statusAfterMerge.length === 0,
    pass,
    caveats: [
      '只在本地临时 git 仓库执行；未经过远端推送或真实多客户端并发。',
      'observed 记录的是分支创建时可见的基线段；分支之间互不观察，这与“启动时观察到谁就记录谁”的口径一致。',
      'Spike 事件 ID/HLC 为确定性标签，未复用生产 ULID/HLC 实现。',
    ],
  };

  fs.mkdirSync(path.dirname(EVIDENCE), { recursive: true });
  fs.writeFileSync(EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`);

  console.log(
    JSON.stringify(
      {
        spike: 'S6',
        pass,
        tempRepo: repo,
        baseCommit: baseHead,
        merges: mergeResults.map((merge) => ({ branch: merge.branch, status: merge.status, output: merge.output })),
        workingTreeClean: evidence.workingTreeCleanAfterMerge,
        segments: segmentReports.map((segment) => ({
          fileName: segment.fileName,
          events: segment.eventCount,
          headHash: segment.headHash,
          chainOk: segment.chainOk,
          observedOk: segment.observedOk,
        })),
        totals: evidence.totals,
        crossSegment: evidence.crossSegment,
        logAll,
        evidence: EVIDENCE,
      },
      null,
      2,
    ),
  );

  if (!pass) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(error.stack ?? error);
  process.exitCode = 1;
}
