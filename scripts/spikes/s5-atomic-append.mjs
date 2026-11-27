#!/usr/bin/env node
// S5: crash injection at every byte boundary between batch.begin and batch.end.
//
// Each injection starts an independent writer process, waits until it has
// written exactly N bytes and fsynced, then force-kills it. The runner then:
//   1. checks the file is exactly initial bytes + N prefix bytes;
//   2. lets the segment's own writer truncate the incomplete tail;
//   3. verifies no half-batch survives and the committed prefix replays;
//   4. copies the same tail as a foreign segment, replays read-only, and
//      verifies the bytes/hash are untouched.
//
// It also measures file fsync, Windows cooperative file-lock contention, and
// documents unsupported capabilities instead of counting them as passed.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  GENESIS,
  buildBatch,
  parseSegment,
  replaySegment,
  sha256,
} from './s5-writer.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WRITER = fileURLToPath(new URL('./s5-writer.mjs', import.meta.url));
const EVIDENCE = path.join(ROOT, 'docs', 'evidence', 's5-atomic-append.json');

const PROBLEM =
  'batch.begin 与 batch.end 之间每个字节边界崩溃后，恢复是否完全无半批；自己的写者能截断，别人的残尾只忽略且字节哈希不变；fsync/Windows 文件锁的实际能力。';
const METHOD =
  '独立 Node writer 写入目标批次前 N 字节并 fsync 后挂起，主 runner SIGKILL/taskkill 强杀；N 遍历 0..L，覆盖空文件与已有 seed 批次；随后另起同 segment 的独立 writer 进程截断残尾，再重放，并对他人残尾副本只读重放+哈希对比；另测文件/目录 fsync 与 wx 文件锁争用。';
const PASS_CRITERIA = [
  '所有注入点恢复后无半批，重放事件数符合预期',
  '已提交 seed 批次在所有前缀注入下原样保留',
  '他人 segment 残尾被只读重放忽略，SHA-256 前后不变',
  '独立 writer 由 runner 强杀而非自行正常退出',
  '文件 fsync 与协作文件锁有真实通过输出；不支持的目录 fsync 明确标注未验证',
];

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function waitForNeedle(child, needle, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timeout waiting for ${needle}; stdout=${stdout}; stderr=${stderr}`));
    }, timeoutMs);

    const onStdout = (data) => {
      stdout += data;
      if (stdout.includes(needle)) {
        cleanup();
        resolve({ stdout, stderr });
      }
    };
    const onStderr = (data) => {
      stderr += data;
    };
    const onExit = (code, signal) => {
      if (!stdout.includes(needle)) {
        cleanup();
        reject(new Error(`exited before ${needle}: code=${code} signal=${signal} stderr=${stderr}`));
      }
    };
    function cleanup() {
      clearTimeout(timer);
      child.stdout.off('data', onStdout);
      child.stderr.off('data', onStderr);
      child.off('exit', onExit);
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.on('exit', onExit);
  });
}

async function forceKill(child) {
  const started = Date.now();
  const wasAlive = child.exitCode === null && child.signalCode === null;
  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });

  const signalAccepted = child.kill('SIGKILL');
  let result = await Promise.race([exited, delay(3_000).then(() => null)]);
  let method = 'SIGKILL';
  let taskkill = null;

  if (result === null) {
    taskkill = spawnSync('taskkill', ['/PID', String(child.pid), '/F', '/T'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    method = 'taskkill';
    result = await Promise.race([exited, delay(3_000).then(() => null)]);
  }

  return {
    method,
    signalAccepted,
    wasAliveBeforeKill: wasAlive,
    exit: result,
    taskkill: taskkill
      ? { status: taskkill.status, stdout: taskkill.stdout.trim(), stderr: taskkill.stderr.trim() }
      : null,
    latencyMs: Date.now() - started,
  };
}

function makeSeedBatch() {
  return buildBatch({
    batchId: 'seed-batch-0001',
    actor: 's5-seed-writer',
    events: [
      {
        id: 's5-seed-0001',
        hlc: '2026-11-18T00:00:00.000Z-0001',
        kind: 'note.record',
        payload: { seq: 1, text: 'seed-alpha' },
      },
      {
        id: 's5-seed-0002',
        hlc: '2026-11-18T00:00:00.001Z-0002',
        kind: 'note.record',
        payload: { seq: 2, text: 'seed-beta' },
      },
    ],
  });
}

function makeTargetBatch(batchId, prevHash) {
  return buildBatch({
    batchId,
    actor: 's5-target-writer',
    prevHash,
    events: [
      {
        id: `${batchId}-event-0001`,
        hlc: '2026-11-18T00:00:01.000Z-0001',
        kind: 'note.record',
        payload: { seq: 1, text: 'target-alpha' },
      },
      {
        id: `${batchId}-event-0002`,
        hlc: '2026-11-18T00:00:01.001Z-0002',
        kind: 'note.record',
        payload: { seq: 2, text: 'target-beta' },
      },
    ],
  });
}

async function runInjection({ tmpRoot, scenario, initialBytes, initialEvents, fullBatch, targetEvents, offset }) {
  const dir = path.join(tmpRoot, `${scenario.name}-${String(offset).padStart(4, '0')}`);
  fs.mkdirSync(dir, { recursive: true });
  const segmentPath = path.join(dir, 'segment.jsonl');
  const sourcePath = path.join(dir, 'target.bin');
  const foreignPath = path.join(dir, 'foreign-segment.jsonl');

  let child = null;
  let ready = null;
  try {
    fs.writeFileSync(segmentPath, initialBytes);
    fs.writeFileSync(sourcePath, fullBatch.bytes);

    child = spawn(
      process.execPath,
      [WRITER, '--file', segmentPath, '--source', sourcePath, '--offset', String(offset)],
      { cwd: dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: process.env },
    );
    ready = await waitForNeedle(child, 'READY');
    const kill = await forceKill(child);
    child = null;

    const expectedRaw = Buffer.concat([initialBytes, fullBatch.bytes.subarray(0, offset)]);
    const raw = fs.readFileSync(segmentPath);
    const rawParse = parseSegment(raw);
    const rawPrefixExact = raw.equals(expectedRaw);
    const rawHasIncomplete = rawParse.incompleteStart !== null;
    const expectedRawIncomplete = offset > 0 && offset < fullBatch.bytes.length;

    // Foreign segment: identical residual bytes, but read-only. No truncate.
    fs.writeFileSync(foreignPath, raw);
    const foreignBefore = sha256(fs.readFileSync(foreignPath));
    const foreignBeforeSize = fs.statSync(foreignPath).size;
    const foreignReplay = replaySegment(fs.readFileSync(foreignPath), GENESIS);
    const foreignAfter = sha256(fs.readFileSync(foreignPath));
    const foreignAfterSize = fs.statSync(foreignPath).size;
    const foreignStable = foreignBefore === foreignAfter && foreignBeforeSize === foreignAfterSize;
    const foreignExpectedEvents = initialEvents + (offset === fullBatch.bytes.length ? targetEvents : 0);
    const foreignTailIgnored =
      foreignReplay.incompleteStart === null
        ? foreignReplay.eventCount === foreignExpectedEvents
        : foreignReplay.eventCount === initialEvents && foreignReplay.incompleteStart !== null;

    // Own writer recovery: a separate process truncates its own incomplete tail.
    const recovery = spawnSync(
      process.execPath,
      [WRITER, '--recover', segmentPath],
      { cwd: dir, encoding: 'utf8', windowsHide: true, env: process.env },
    );
    if (recovery.status !== 0) {
      throw new Error(
        `owner recovery failed status=${recovery.status}: ${recovery.stderr.trim() || recovery.stdout.trim()}`,
      );
    }
    const ownTruncated = /truncated=true/.test(recovery.stdout);
    const recoveredRead = fs.readFileSync(segmentPath);
    const recoveredParse = parseSegment(recoveredRead);
    const recoveredReplay = replaySegment(recoveredRead, GENESIS);
    const expectedRecovered =
      offset === fullBatch.bytes.length ? Buffer.concat([initialBytes, fullBatch.bytes]) : initialBytes;
    const expectedEvents = initialEvents + (offset === fullBatch.bytes.length ? targetEvents : 0);

    const recoveredNoHalfBatch = recoveredParse.incompleteStart === null;
    const ownTruncationCorrect = ownTruncated === rawHasIncomplete;
    const killForced =
      kill.wasAliveBeforeKill &&
      (kill.method === 'SIGKILL' || kill.method === 'taskkill') &&
      kill.exit !== null &&
      ready.stdout.includes('READY');

    const pass =
      rawPrefixExact &&
      (rawHasIncomplete === expectedRawIncomplete) &&
      ownTruncationCorrect &&
      recoveredNoHalfBatch &&
      recoveredRead.equals(expectedRecovered) &&
      recoveredReplay.eventCount === expectedEvents &&
      recoveredReplay.chainOk &&
      foreignStable &&
      foreignReplay.chainOk &&
      foreignTailIgnored &&
      killForced;

    return {
      scenario: scenario.name,
      offset,
      targetBytes: fullBatch.bytes.length,
      rawBytes: raw.length,
      expectedRawBytes: expectedRaw.length,
      rawPrefixExact,
      rawHasIncomplete,
      expectedRawIncomplete,
      ownTruncated,
      recoveredBytes: recoveredRead.length,
      recoveredNoHalfBatch,
      recoveredEqualsExpected: recoveredRead.equals(expectedRecovered),
      replayEvents: recoveredReplay.eventCount,
      expectedEvents,
      replayChainOk: recoveredReplay.chainOk,
      recovery: {
        process: 'independent s5-writer.mjs --recover',
        exitCode: recovery.status,
        stdout: recovery.stdout.trim(),
        stderr: recovery.stderr.trim(),
      },
      foreignHashBefore: foreignBefore,
      foreignHashAfter: foreignAfter,
      foreignStable,
      foreignReplayEvents: foreignReplay.eventCount,
      foreignTailIgnored,
      kill: {
        method: kill.method,
        wasAliveBeforeKill: kill.wasAliveBeforeKill,
        latencyMs: kill.latencyMs,
        exit: kill.exit,
        exitCode: kill.exit?.code ?? null,
        exitSignal: kill.exit?.signal ?? null,
      },
      pass,
    };
  } catch (error) {
    return {
      scenario: scenario.name,
      offset,
      targetBytes: fullBatch.bytes.length,
      error: error instanceof Error ? error.message : String(error),
      pass: false,
    };
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await delay(50);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testFileFsync(tmpRoot) {
  const target = path.join(tmpRoot, 'fsync-file.bin');
  const started = process.hrtime.bigint();
  try {
    const fd = fs.openSync(target, 'w');
    try {
      fs.writeSync(fd, Buffer.from('fsync-file-test'));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    return { ok: true, elapsedMs: Number(elapsedMs.toFixed(3)), size: fs.statSync(target).size };
  } catch (error) {
    return { ok: false, code: error.code, message: error.message };
  }
}

function testDirectoryFsync(tmpRoot) {
  const target = path.join(tmpRoot, 'fsync-dir');
  fs.mkdirSync(target, { recursive: true });
  try {
    const fd = fs.openSync(target, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return { ok: true, note: 'directory fsync accepted' };
  } catch (error) {
    return {
      ok: false,
      code: error.code,
      message: error.message,
      note: 'Windows directory fsync unsupported/failed; do not claim power-loss durability',
    };
  }
}

async function testWindowsLock(tmpRoot) {
  const dir = path.join(tmpRoot, 'lock-test');
  fs.mkdirSync(dir, { recursive: true });
  const lockPath = path.join(dir, 'ledger.lock');
  let holder = null;
  try {
    holder = spawn(process.execPath, [WRITER, '--lock', lockPath], {
      cwd: dir,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    const held = await waitForNeedle(holder, 'HELD');
    const holderPid = Number(/pid=(\d+)/.exec(held.stdout)?.[1]);

    let contention;
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.closeSync(fd);
      contention = { ok: false, note: 'second exclusive create unexpectedly succeeded' };
    } catch (error) {
      contention = { ok: error.code === 'EEXIST', code: error.code, message: error.message };
    }

    const kill = await forceKill(holder);
    holder = null;

    let stale;
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.closeSync(fd);
      stale = { ok: false, note: 'stale lock unexpectedly absent' };
    } catch (error) {
      stale = { ok: error.code === 'EEXIST', code: error.code, message: error.message };
    }

    fs.unlinkSync(lockPath);
    let afterCleanup;
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.closeSync(fd);
      afterCleanup = { ok: true };
    } catch (error) {
      afterCleanup = { ok: false, code: error.code, message: error.message };
    }
    fs.unlinkSync(lockPath);

    return {
      ok: contention.ok && stale.ok && afterCleanup.ok,
      holderPid,
      holderForcedKill: kill.wasAliveBeforeKill && kill.exit !== null,
      contention,
      staleAfterKill: stale,
      afterCleanup,
      note: 'wx/O_EXCL is a cooperative lock file; Node does not expose Windows mandatory byte-range locks',
    };
  } catch (error) {
    if (holder && holder.exitCode === null) holder.kill('SIGKILL');
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (holder && holder.exitCode === null) holder.kill('SIGKILL');
  }
}

async function main() {
  const quick = process.argv.includes('--quick');
  const startedAt = new Date().toISOString();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ano-s5-'));
  const seed = makeSeedBatch();
  const emptyTarget = makeTargetBatch('target-empty-0001', GENESIS);
  const seededTarget = makeTargetBatch('target-seeded-0001', seed.lastHash);

  const scenarios = [
    {
      name: 'empty-file',
      description: '空 segment；注入 0..L 字节后强杀',
      initialBytes: Buffer.alloc(0),
      initialEvents: 0,
      batch: emptyTarget,
      targetEvents: emptyTarget.events.length,
    },
    {
      name: 'after-seed',
      description: '已提交 seed 批次；再注入目标批次 0..L 字节后强杀',
      initialBytes: seed.bytes,
      initialEvents: seed.events.length,
      batch: seededTarget,
      targetEvents: seededTarget.events.length,
    },
  ];

  console.log(
    JSON.stringify(
      {
        spike: 'S5',
        node: process.version,
        platform: `${process.platform} ${process.arch}`,
        targetBytes: emptyTarget.bytes.length,
        seedBytes: seed.bytes.length,
        scenarios: scenarios.map((scenario) => ({
          name: scenario.name,
          initialBytes: scenario.initialBytes.length,
          initialEvents: scenario.initialEvents,
          targetBytes: scenario.batch.bytes.length,
          targetEvents: scenario.targetEvents,
          injections: scenario.batch.bytes.length + 1,
        })),
      },
      null,
      2,
    ),
  );

  const results = [];
  for (const scenario of scenarios) {
    const length = scenario.batch.bytes.length;
    const offsets = quick
      ? [...new Set([0, 1, 2, Math.max(0, length - 1), length])]
      : Array.from({ length: length + 1 }, (_, index) => index);
    for (const offset of offsets) {
      const result = await runInjection({
        tmpRoot,
        scenario,
        initialBytes: scenario.initialBytes,
        initialEvents: scenario.initialEvents,
        fullBatch: scenario.batch,
        targetEvents: scenario.targetEvents,
        offset,
      });
      results.push(result);
      if (!result.pass) {
        console.error(`[FAIL] ${scenario.name} offset=${offset}: ${result.error ?? 'assertion failed'}`);
      }
    }
    const scenarioResults = results.filter((result) => result.scenario === scenario.name);
    console.log(
      JSON.stringify({
        scenario: scenario.name,
        injections: scenarioResults.length,
        passed: scenarioResults.filter((result) => result.pass).length,
        truncated: scenarioResults.filter((result) => result.ownTruncated).length,
        committedAfterRecovery: scenarioResults.filter((result) => result.replayEvents === scenario.initialEvents + scenario.targetEvents).length,
      }),
    );
  }

  const fsyncFile = testFileFsync(tmpRoot);
  const fsyncDirectory = testDirectoryFsync(tmpRoot);
  const lock = await testWindowsLock(tmpRoot);

  const failures = results.filter((result) => !result.pass);
  const zeroByte = results.filter((result) => result.offset === 0);
  const afterCommit = results.filter((result) => result.offset === result.targetBytes);
  const emptyScenario = results.filter((result) => result.scenario === 'empty-file');
  const seededScenario = results.filter((result) => result.scenario === 'after-seed');
  const summary = {
    totalInjections: results.length,
    passedInjections: results.length - failures.length,
    failedInjections: failures.length,
    zeroByteInjections: zeroByte.length,
    zeroBytePassed: zeroByte.filter((result) => result.pass).length,
    afterCommitInjections: afterCommit.length,
    afterCommitPassed: afterCommit.filter((result) => result.pass).length,
    emptyFileAllPassed: emptyScenario.every((result) => result.pass),
    afterSeedAllPassed: seededScenario.every((result) => result.pass),
    ownTruncations: results.filter((result) => result.ownTruncated).length,
    foreignHashesStable: results.filter((result) => result.foreignStable).length,
    forcedKills: results.filter((result) => result.kill?.method).length,
  };

  // Directory fsync that is unsupported is a documented limitation, not a
  // passing capability. Overall S5 pass only covers the applicable checks.
  const pass =
    failures.length === 0 &&
    fsyncFile.ok &&
    lock.ok &&
    summary.zeroBytePassed === summary.zeroByteInjections &&
    summary.afterCommitPassed === summary.afterCommitInjections;

  const evidence = {
    spike: 'S5',
    title: '批次原子追加：每个字节边界强杀与恢复',
    generatedAt: new Date().toISOString(),
    startedAt,
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      os: `${os.type()} ${os.release()}`,
      cwd: ROOT,
    },
    problem: PROBLEM,
    method: METHOD,
    passCriteria: PASS_CRITERIA,
    format: {
      begin: '{"record":"batch.begin","batch_id",...,"event_count","prev_hash"}',
      event: '{"id","hlc","actor","kind","payload","prev_hash"}',
      end: '{"record":"batch.end","batch_id","event_count","checksum"}',
      checksum: 'SHA-256 of concatenated raw event lines including newline',
      idNote: 'Spike IDs are deterministic labels; production uses ULID per architecture.',
    },
    fsync: { file: fsyncFile, directory: fsyncDirectory },
    fileLock: lock,
    scenarios: scenarios.map((scenario) => ({
      name: scenario.name,
      description: scenario.description,
      initialBytes: scenario.initialBytes.length,
      initialEvents: scenario.initialEvents,
      targetBytes: scenario.batch.bytes.length,
      targetEvents: scenario.targetEvents,
      injections: results.filter((result) => result.scenario === scenario.name),
    })),
    summary,
    failures: failures.map((result) => ({
      scenario: result.scenario,
      offset: result.offset,
      error: result.error ?? 'assertion failed',
    })),
    pass,
    caveats: [
      'Directory fsync is not supported on this Windows/Node combination; power-loss durability is not proven by this spike.',
      'File lock uses cooperative wx/O_EXCL lock-file creation; Node exposes no mandatory Windows byte-range lock API.',
      'Each injected prefix was fsynced before SIGKILL so the byte boundary state is observable; this is the stronger persisted-prefix case.',
      'Only a synthetic batch format and synthetic segment were tested; no production ledger code exists yet.',
    ],
  };

  fs.mkdirSync(path.dirname(EVIDENCE), { recursive: true });
  fs.writeFileSync(EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`);

  console.log(
    JSON.stringify(
      {
        spike: 'S5',
        pass,
        summary,
        fsync: { file: fsyncFile.ok, directory: fsyncDirectory.ok, directoryCode: fsyncDirectory.code ?? null },
        lock: { ok: lock.ok, contention: lock.contention?.code, stale: lock.staleAfterKill?.code },
        evidence: EVIDENCE,
        failures: evidence.failures.slice(0, 10),
      },
      null,
      2,
    ),
  );

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  process.exitCode = pass ? 0 : 1;
}

main().catch((error) => {
  console.error(error.stack ?? error);
  process.exitCode = 1;
});
