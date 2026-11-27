import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  ClientConfigError,
  applyClientConfig,
  assertSafeConfigPath,
  atomicWriteFile,
  backupClientConfig,
  checkClientConfigAuthorization,
  discoverClientConfig,
  listClientConfigBackups,
  parseTomlDocument,
  planClientConfig,
  readClientConfig,
  readClientConfigBackup,
  resolveClientConfigRoot,
  restoreClientConfig as restoreConfigFile,
  restoreFromBackup,
  sensitiveConfigPathReason,
  verifyClientConfigBackup,
  type ClientConfigAuthorization,
  type ClientConfigApplyOptions,
  type ClientConfigFormat,
  type ClientConfigHooks,
  type ClientConfigIo,
  type ClientConfigResult,
  type ClientConfigTarget,
} from '../../src/clients/config.ts';
import {
  installClientBatch,
  installClientConfig,
  readInstallRecord,
  restoreClientConfig,
  uninstallClientConfig,
  writeInstallRecord,
  type ClientBatchInstallResult,
} from '../../src/clients/install.ts';
import {
  CLIENT_ACCESS_PLAN_SCHEMA,
  CLIENT_ACCESS_ROUTES,
  planAccessReport,
  planClientAccess,
  type ClientAccessPlan,
  type ClientTakeoverCapabilities,
  type ClientCapabilityJudgement,
} from '../../src/clients/capabilities.ts';
import type { ClientId, ClientVerdict } from '../../src/clients/types.ts';

const PLAN_NOW = '2026-11-23T00:00:00.000Z';

function judgement(verdict: ClientVerdict): ClientCapabilityJudgement {
  return {
    verdict,
    evidence: verdict === 'validated' ? 'measured' : 'absent',
    mode: 'test',
    source: 'test',
    at: PLAN_NOW,
    version: null,
    limitations: ['synthetic capability judgement'],
    details: {},
  };
}

function capabilitiesFor(clientId: ClientId, overrides: Partial<ClientTakeoverCapabilities> = {}): ClientTakeoverCapabilities {
  return {
    clientId,
    alias: null,
    status: 'degraded',
    mcp: judgement('unavailable'),
    rules: judgement('unavailable'),
    dag: judgement('unavailable'),
    recovery: judgement('unavailable'),
    outputInterception: judgement('unavailable'),
    hostCapability: 'degraded',
    generatedAt: PLAN_NOW,
    limitations: [],
    ...overrides,
  };
}

function planFor(clientId: ClientId, home: string, root: string): ClientAccessPlan {
  return planClientAccess(capabilitiesFor(clientId), { home, root });
}

const DESIRED: Record<string, unknown> = { command: 'node', args: ['dist/surface/mcp.js'] };

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function rootFor(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'ano-client-config-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function targetFor(root: string, overrides: Partial<ClientConfigTarget> = {}): ClientConfigTarget {
  return {
    clientId: 'claude-code',
    scope: 'project',
    path: join(root, '.mcp.json'),
    format: 'json',
    serverPath: ['mcpServers'],
    serverName: 'ano',
    allowedRoot: root,
    ...overrides,
  };
}

function authorization(root: string, overrides: Partial<ClientConfigAuthorization> = {}): ClientConfigAuthorization {
  return {
    authorizationId: 'a'.repeat(64),
    root,
    clientId: 'claude-code',
    scope: ['config', 'install', 'restore'],
    grantedBy: 'Alice',
    statement: 'Authorize ANO client config install for this project',
    grantedAt: '2026-11-22T00:00:00.000Z',
    ...overrides,
  };
}

function applyOptions(root: string, overrides: Partial<ClientConfigApplyOptions> = {}): ClientConfigApplyOptions {
  return {
    mode: 'apply',
    confirm: true,
    authorization: authorization(root),
    root,
    ...overrides,
  };
}

function configPath(target: ClientConfigTarget): string {
  return target.path;
}

function readConfig(target: ClientConfigTarget): Buffer {
  return readFileSync(configPath(target));
}

function writeConfig(target: ClientConfigTarget, value: unknown): void {
  writeFileSync(configPath(target), `${JSON.stringify(value, null, 2)}\n`);
}

function parsed(target: ClientConfigTarget): Record<string, unknown> {
  return JSON.parse(readConfig(target).toString('utf8')) as Record<string, unknown>;
}

function fakeApplied(target: ClientConfigTarget, overrides: Partial<ClientConfigResult> = {}): ClientConfigResult {
  return {
    mode: 'apply',
    applied: true,
    refused: false,
    target,
    changes: [],
    warnings: [],
    beforeHash: 'b'.repeat(64),
    afterHash: 'a'.repeat(64),
    changed: true,
    backupId: null,
    backupHash: null,
    backupPath: null,
    restoredOnFailure: false,
    error: null,
    ...overrides,
  };
}

test('默认 dry-run：无 confirm 调用返回预览且零写', (t) => {
  const root = rootFor(t);
  const target = targetFor(root);
  const original = {
    mcpServers: { other: { command: 'x', args: ['y'] } },
    unknownTop: { keep: true },
  };
  writeConfig(target, original);
  const before = readConfig(target);

  const plan = planClientConfig(target, DESIRED);
  assert.equal(plan.changed, true);
  assert.equal(plan.changes[0]?.kind, 'add-server');
  assert.notEqual(plan.afterHash, plan.snapshot.beforeHash);

  const applied = applyClientConfig(target, DESIRED);
  assert.equal(applied.mode, 'dry-run');
  assert.equal(applied.applied, false);
  assert.equal(applied.refused, false);
  assert.deepEqual(readConfig(target), before);

  const installed = installClientConfig(target, DESIRED);
  assert.equal(installed.action, 'dry-run');
  assert.equal(installed.applied, false);
  assert.equal(installed.installRecordId, null);
  assert.deepEqual(readConfig(target), before);

  const restored = restoreConfigFile(target, { root });
  assert.equal(restored.mode, 'dry-run');
  assert.equal(restored.applied, false);
  assert.deepEqual(readConfig(target), before);
});

test('apply 缺 confirm / 授权 / root 时零写并报告 refused', (t) => {
  const root = rootFor(t);
  const target = targetFor(root);
  writeConfig(target, { mcpServers: {} });
  const before = readConfig(target);

  const missingConfirm = applyClientConfig(target, DESIRED, { mode: 'apply', authorization: authorization(root), root });
  assert.equal(missingConfirm.applied, false);
  assert.equal(missingConfirm.refused, true);

  const missingAuth = applyClientConfig(target, DESIRED, { mode: 'apply', confirm: true, root });
  assert.equal(missingAuth.applied, false);
  assert.equal(missingAuth.refused, true);

  const missingRoot = applyClientConfig(target, DESIRED, { mode: 'apply', confirm: true, authorization: authorization(root) });
  assert.equal(missingRoot.applied, false);
  assert.equal(missingRoot.refused, true);

  assert.deepEqual(readConfig(target), before);
});

test('无效授权（跨 root / 客户端不符 / 缺 scope / 已撤销 / 时间非法）零写', (t) => {
  const root = rootFor(t);
  const other = rootFor(t);
  const target = targetFor(root);
  writeConfig(target, { mcpServers: {} });
  const before = readConfig(target);
  const auth = authorization(root);

  const cases: ClientConfigAuthorization[] = [
    authorization(other),
    authorization(root, { clientId: 'codex' }),
    authorization(root, { scope: ['detect'] }),
    authorization(root, { scope: ['config', 'bogus'] }),
    authorization(root, { revokedAt: '2026-11-22T01:00:00.000Z' }),
    authorization(root, { grantedAt: 'not-a-date' }),
    authorization(root, { grantedBy: '   ' }),
  ];
  for (const candidate of cases) {
    const result = applyClientConfig(target, DESIRED, { mode: 'apply', confirm: true, authorization: candidate, root });
    assert.equal(result.applied, false, candidate.authorizationId);
    assert.equal(result.refused, true);
  }
  assert.deepEqual(readConfig(target), before);
});

test('授权 apply 写入并保留其他 MCP 服务与未知字段', (t) => {
  const root = rootFor(t);
  const target = targetFor(root);
  const other = { command: 'other-bin', args: ['--serve'], nested: { keep: [1, 2, 3] } };
  writeConfig(target, {
    mcpServers: { other },
    unknownTop: { z: 1, arr: [1, 2, 3] },
    theme: 'dark',
  });

  const result = applyClientConfig(target, DESIRED, applyOptions(root));
  assert.equal(result.applied, true);
  assert.equal(result.mode, 'apply');
  assert.equal(result.changed, true);
  assert.equal(result.backupId !== null, true);

  const document = parsed(target);
  assert.deepEqual(document['mcpServers'], { other, ano: DESIRED });
  assert.deepEqual(document['unknownTop'], { z: 1, arr: [1, 2, 3] });
  assert.equal(document['theme'], 'dark');
  assert.equal(result.afterHash, sha256(readConfig(target)));
});

test('备份产物与原字节 hash 一致且可通过校验', (t) => {
  const root = rootFor(t);
  const target = targetFor(root);
  writeConfig(target, { mcpServers: { other: { command: 'x' } } });
  const before = readConfig(target);

  const result = applyClientConfig(target, DESIRED, applyOptions(root));
  assert.equal(result.backupId !== null, true);
  const backupId = result.backupId as unknown as string;

  const artifact = readClientConfigBackup(root, 'claude-code', backupId);
  assert.equal(sha256(artifact.bytes), sha256(before));
  assert.equal(artifact.manifest['beforeHash'], sha256(before));

  const verification = verifyClientConfigBackup(root, 'claude-code', backupId);
  assert.equal(verification.ok, true);
  assert.deepEqual(verification.errors, []);
  assert.equal(verification.beforeHash, sha256(before));
  assert.equal(verification.bytes, before.length);
});

test('重复安装零变化（幂等）且安装记录可重放', (t) => {
  const root = rootFor(t);
  const target = targetFor(root);
  writeConfig(target, { mcpServers: { other: { command: 'x' } } });

  const first = installClientConfig(target, DESIRED, applyOptions(root));
  assert.equal(first.action, 'installed');
  assert.equal(first.applied, true);
  assert.equal(first.installRecordCreated, true);
  const afterFirst = readConfig(target);
  const recordId = first.installRecordId;
  assert.equal(recordId !== null, true);

  const second = installClientConfig(target, DESIRED, applyOptions(root));
  assert.equal(second.action, 'unchanged');
  assert.equal(second.applied, false);
  assert.equal(second.changed, false);
  assert.deepEqual(readConfig(target), afterFirst);

  const record = readInstallRecord(root, 'claude-code');
  assert.equal(record?.id, recordId);
  assert.equal(record?.afterHash, first.afterHash);

  const replay = writeInstallRecord(root, target, DESIRED, fakeApplied(target), authorization(root), '2026-11-22T00:00:00.000Z');
  const replayAgain = writeInstallRecord(root, target, DESIRED, fakeApplied(target), authorization(root), '2026-11-22T00:00:00.000Z');
  assert.equal(replay.created, true);
  assert.equal(replayAgain.created, false);
  assert.equal(replayAgain.record.id, replay.record.id);
});

test('beforeHash 并发漂移拒绝且零写', (t) => {
  const root = rootFor(t);
  const target = targetFor(root);
  writeConfig(target, { mcpServers: { other: { command: 'x' } } });
  const original = readConfig(target);
  const drifted = Buffer.from(`${JSON.stringify({ mcpServers: { ano: { command: 'someone-else' } } }, null, 2)}\n`);

  const hooks: ClientConfigHooks = {
    afterBackup: () => {
      writeFileSync(configPath(target), drifted);
    },
  };

  assert.throws(
    () => applyClientConfig(target, DESIRED, applyOptions(root, { hooks })),
    (error: unknown) => error instanceof ClientConfigError && error.code === 'CLIENT_CONFIG_DRIFT',
  );
  // The concurrent writer's bytes remain; this process wrote nothing.
  assert.deepEqual(readConfig(target), drifted);
  assert.notDeepEqual(readConfig(target), original);
});

test('install 遇并发漂移返回 failed 且零写', (t) => {
  const root = rootFor(t);
  const target = targetFor(root);
  writeConfig(target, { mcpServers: { other: { command: 'x' } } });
  const drifted = Buffer.from(`${JSON.stringify({ mcpServers: { ano: { command: 'someone-else' } } }, null, 2)}\n`);
  const hooks: ClientConfigHooks = { afterBackup: () => writeFileSync(configPath(target), drifted) };

  const result = installClientConfig(target, DESIRED, applyOptions(root, { hooks }));
  assert.equal(result.action, 'failed');
  assert.equal(result.applied, false);
  assert.equal(result.restoredOnFailure, false);
  assert.equal(result.error !== null, true);
  assert.deepEqual(readConfig(target), drifted);
});

test('注入写失败时恢复到 beforeHash 且不留下损坏配置', (t) => {
  const root = rootFor(t);
  const target = targetFor(root);
  writeConfig(target, { mcpServers: { other: { command: 'x' } } });
  const original = readConfig(target);

  let calls = 0;
  const io: ClientConfigIo = {
    atomicWrite: (file, bytes) => {
      calls += 1;
      if (calls === 1) {
        writeFileSync(file, Buffer.from('partial garbage'));
        throw new Error('injected write failure');
      }
      atomicWriteFile(file, bytes);
    },
  };

  const result = applyClientConfig(target, DESIRED, applyOptions(root, { io }));
  assert.equal(result.applied, false);
  assert.equal(result.restoredOnFailure, true);
  assert.equal(result.error !== null, true);
  assert.deepEqual(readConfig(target), original);

  // A retry with healthy IO succeeds.
  const retried = applyClientConfig(target, DESIRED, applyOptions(root));
  assert.equal(retried.applied, true);
  assert.equal(retried.restoredOnFailure, false);
  assert.deepEqual(parsed(target)['mcpServers'], { other: { command: 'x' }, ano: DESIRED });
});

test('路径逃逸与符号链接拒绝，发现阶段不跟随', (t) => {
  const root = rootFor(t);
  const outside = rootFor(t);
  const outsidePath = join(outside, 'escape.json');
  writeFileSync(outsidePath, '{}');

  const escapeTarget = targetFor(root, { path: outsidePath });
  assert.throws(() => readClientConfig(escapeTarget), /escapes|scope/iu);
  assert.throws(() => applyClientConfig(escapeTarget, DESIRED, applyOptions(root)), /escapes|scope/iu);

  const discovery = discoverClientConfig([escapeTarget, targetFor(root, { path: join(root, 'missing.json') })]);
  assert.equal(discovery.target, null);
  assert.equal(discovery.rejected.length, 1);
  assert.equal(discovery.missing.length, 1);

  const link = join(root, 'link.json');
  const real = join(root, 'real.json');
  writeFileSync(real, '{}');
  fs.symlinkSync(real, link, 'file');
  const linkTarget = targetFor(root, { path: link });
  assert.throws(() => readClientConfig(linkTarget), /symbolic link/iu);
  assert.deepEqual(readFileSync(real), Buffer.from('{}'));
});

test('发现按注入候选顺序返回首个存在且安全的配置', (t) => {
  const root = rootFor(t);
  const first = targetFor(root, { path: join(root, 'missing.json') });
  const second = targetFor(root, { path: join(root, '.mcp.json') });
  writeConfig(second, { mcpServers: {} });

  const discovery = discoverClientConfig([first, second]);
  assert.equal(discovery.found, second.path);
  assert.equal(discovery.target?.path, second.path);
  assert.deepEqual(discovery.missing, [first.path]);
});

test('TOML 只读 degraded：可解析、apply 拒绝零写', (t) => {
  const root = rootFor(t);
  const target = targetFor(root, { path: join(root, 'config.toml'), format: 'toml', serverPath: ['mcp_servers'] });
  const original = '[mcp_servers.other]\ncommand = "x"\nargs = ["y"]\n';
  writeFileSync(target.path, original);

  const snapshot = readClientConfig(target);
  assert.equal(snapshot.degraded, true);
  assert.equal(snapshot.anoEntry, null);
  assert.equal(snapshot.services.length, 1);
  assert.equal(snapshot.services[0]?.name, 'other');

  const plan = planClientConfig(target, DESIRED);
  assert.equal(plan.changed, true);
  assert.equal(plan.mergedBytes, null);
  assert.equal(plan.afterHash, null);

  const result = applyClientConfig(target, DESIRED, applyOptions(root));
  assert.equal(result.applied, false);
  assert.equal(result.refused, true);
  assert.deepEqual(readConfig(target), Buffer.from(original));

  const installed = installClientConfig(target, DESIRED, applyOptions(root));
  assert.equal(installed.applied, false);
  assert.equal(installed.action, 'refused');
  assert.deepEqual(readConfig(target), Buffer.from(original));
});

test('卸载只删除 ANO 条目并保留其他服务与未知字段', (t) => {
  const root = rootFor(t);
  const target = targetFor(root);
  const other = { command: 'other-bin' };
  writeConfig(target, { mcpServers: { other }, unknownTop: 1 });

  const installed = installClientConfig(target, DESIRED, applyOptions(root));
  assert.equal(installed.action, 'installed');
  const installedBuffer = readConfig(target);

  const removed = uninstallClientConfig(target, applyOptions(root));
  assert.equal(removed.action, 'removed');
  assert.equal(removed.applied, true);
  assert.deepEqual(parsed(target)['mcpServers'], { other });
  assert.equal(parsed(target)['unknownTop'], 1);
  assert.notDeepEqual(readConfig(target), installedBuffer);

  const again = uninstallClientConfig(target, applyOptions(root));
  assert.equal(again.action, 'unchanged');
});

test('restore 从已验证备份恢复原字节（默认 dry-run 零写）', (t) => {
  const root = rootFor(t);
  const target = targetFor(root);
  writeConfig(target, { mcpServers: { other: { command: 'x' } } });
  const original = readConfig(target);

  const installed = installClientConfig(target, DESIRED, applyOptions(root));
  assert.equal(installed.action, 'installed');
  assert.notDeepEqual(readConfig(target), original);

  const preview = restoreClientConfig(target, { root });
  assert.equal(preview.mode, 'dry-run');
  assert.equal(preview.applied, false);
  assert.notDeepEqual(readConfig(target), original);

  const restored = restoreClientConfig(target, applyOptions(root));
  assert.equal(restored.applied, true);
  assert.equal(restored.afterHash, sha256(original));
  assert.deepEqual(readConfig(target), original);
});

test('备份校验失败时拒绝恢复且零写', (t) => {
  const root = rootFor(t);
  const target = targetFor(root);
  writeConfig(target, { mcpServers: { other: { command: 'x' } } });

  const installed = installClientConfig(target, DESIRED, applyOptions(root));
  const backupId = installed.backupId as unknown as string;
  const verificationBefore = verifyClientConfigBackup(root, 'claude-code', backupId);
  assert.equal(verificationBefore.ok, true);
  writeFileSync(verificationBefore.path as string, 'corrupted');

  const verification = verifyClientConfigBackup(root, 'claude-code', backupId);
  assert.equal(verification.ok, false);
  assert.equal(verification.errors.length > 0, true);

  const restored = restoreClientConfig(target, applyOptions(root));
  assert.equal(restored.applied, false);
  const document = parsed(target);
  assert.deepEqual(document['mcpServers'], { other: { command: 'x' }, ano: DESIRED });
});

test('提交失败回滚配置到 beforeHash', (t) => {
  const root = rootFor(t);
  const target = targetFor(root);
  writeConfig(target, { mcpServers: { other: { command: 'x' } } });
  const original = readConfig(target);

  // Force the install-record commit to fail by making `installs` a file.
  fs.mkdirSync(join(root, '.ano', 'clients'), { recursive: true });
  writeFileSync(join(root, '.ano', 'clients', 'installs'), 'not a directory');

  const result = installClientConfig(target, DESIRED, applyOptions(root));
  assert.equal(result.action, 'failed');
  assert.equal(result.applied, false);
  assert.equal(result.restoredOnFailure, true);
  assert.equal(result.error !== null, true);
  assert.deepEqual(readConfig(target), original);
  assert.equal(existsSync(join(root, '.ano', 'clients', 'installs', 'claude-code.json')), false);
});

test('未知字段在嵌套结构与新容器创建时均不丢弃', (t) => {
  const root = rootFor(t);
  const target = targetFor(root, { serverPath: ['mcp', 'servers'] });
  writeConfig(target, { mcp: { theme: 'keep' }, extra: { deep: { value: [1, 'two', false] } } });

  const result = applyClientConfig(target, DESIRED, applyOptions(root));
  assert.equal(result.applied, true);
  const document = parsed(target);
  assert.deepEqual(document['mcp'], { theme: 'keep', servers: { ano: DESIRED } });
  assert.deepEqual(document['extra'], { deep: { value: [1, 'two', false] } });
});

test('在空配置中创建嵌套服务容器并写入 ANO 条目', (t) => {
  const root = rootFor(t);
  const target = targetFor(root, { serverPath: ['mcp', 'servers'] });
  writeConfig(target, {});

  const result = applyClientConfig(target, DESIRED, applyOptions(root));
  assert.equal(result.applied, true);
  assert.deepEqual(parsed(target), { mcp: { servers: { ano: DESIRED } } });
});

test('写入内容丢失未知字段时验证失败并回滚', (t) => {
  const root = rootFor(t);
  const target = targetFor(root);
  writeConfig(target, { mcpServers: { other: { command: 'x' } }, keepMe: 1 });
  const original = readConfig(target);
  const bad = Buffer.from(`${JSON.stringify({ mcpServers: { ano: DESIRED } }, null, 2)}\n`);

  let calls = 0;
  const io: ClientConfigIo = {
    atomicWrite: (file, bytes) => {
      calls += 1;
      atomicWriteFile(file, calls === 1 ? bad : bytes);
    },
  };

  const result = applyClientConfig(target, DESIRED, applyOptions(root, { io }));
  assert.equal(result.applied, false);
  assert.equal(result.restoredOnFailure, true);
  assert.deepEqual(readConfig(target), original);
});

test('授权作用域不足时 install 拒绝（缺 install scope）', (t) => {
  const root = rootFor(t);
  const target = targetFor(root);
  writeConfig(target, { mcpServers: {} });
  const before = readConfig(target);

  const result = installClientConfig(target, DESIRED, applyOptions(root, { authorization: authorization(root, { scope: ['config'] }) }));
  assert.equal(result.applied, false);
  assert.equal(result.action, 'refused');
  assert.deepEqual(readConfig(target), before);
});

test('restore 缺 restore scope 时拒绝零写', (t) => {
  const root = rootFor(t);
  const target = targetFor(root);
  writeConfig(target, { mcpServers: {} });
  installClientConfig(target, DESIRED, applyOptions(root));
  const configured = readConfig(target);

  const result = restoreClientConfig(target, applyOptions(root, { authorization: authorization(root, { scope: ['config', 'install'] }) }));
  assert.equal(result.applied, false);
  assert.equal(result.refused, true);
  assert.deepEqual(readConfig(target), configured);
});

// ---------------------------------------------------------------------------
// T-098 / CX-08：统一能力计划与批量授权接入
// ---------------------------------------------------------------------------

test('T-098 统一计划：每个客户端输出路线/目标/备份/动作；无 MCP 接口不生成目标', (t) => {
  const root = rootFor(t);
  const home = rootFor(t);

  const claude = planFor('claude-code', home, root);
  assert.equal(claude.route, 'mcp');
  assert.equal(claude.target?.path, join(root, '.mcp.json'));
  assert.equal(claude.target?.format, 'json');
  assert.equal(claude.needsAuthorization, true);
  assert.equal(claude.confirm, true);
  assert.equal(claude.backup?.path, join(root, '.ano', 'clients', 'backups', 'claude-code'));
  assert.equal(claude.backup?.hashAlgorithm, 'sha256');
  assert.ok(claude.actions.length >= 2);

  const codex = planFor('codex', home, root);
  assert.equal(codex.route, 'mcp');
  assert.equal(codex.target?.format, 'toml');
  assert.ok(codex.reason?.includes('TOML') ?? false);

  for (const id of ['replit-agent', 'tabnine', 'jetbrains-ai', 'codegeex', 'pi', 'zcode'] as const) {
    const plan = planFor(id, home, root);
    assert.equal(plan.route, 'skip', `${id} must skip`);
    assert.equal(plan.target, null, `${id} must not receive a config target`);
    assert.equal(plan.backup, null);
    assert.ok(plan.reason !== null && plan.reason.length > 0, `${id} must explain the skip`);
  }

  const qoder = planFor('qoder', home, root);
  assert.equal(qoder.route, 'cli');
  assert.deepEqual(qoder.details['cli'], ['qoder', 'mcp', 'add']);

  const dsh = planFor('deepseek-harness', home, root);
  assert.equal(dsh.route, 'explicit-workflow');
  assert.equal(dsh.target, null);

  const report = planAccessReport({
    schema: 'ano.client-takeover-capabilities/1',
    generatedAt: PLAN_NOW,
    clients: [capabilitiesFor('claude-code'), capabilitiesFor('replit-agent')],
    limitations: [],
  }, { home, root });
  assert.equal(report.schema, CLIENT_ACCESS_PLAN_SCHEMA);
  assert.equal(report.summary.total, 2);
  assert.equal(report.summary.mcp, 1);
  assert.equal(report.summary.skip, 1);
  assert.equal(report.summary.writable, 1);
  assert.equal(report.summary.requireAuthorization, 1);
  for (const route of report.clients.map((client) => client.route)) {
    assert.ok((CLIENT_ACCESS_ROUTES as readonly string[]).includes(route));
  }
});

test('T-098 批量安装默认 dry-run：零写且跳过无 MCP 接口客户端', (t) => {
  const root = rootFor(t);
  const home = rootFor(t);
  const plans = [
    planFor('claude-code', home, root),
    planFor('opencode', home, root),
    planFor('codex', home, root),
    planFor('deepseek-harness', home, root),
    planFor('qoder', home, root),
    planFor('replit-agent', home, root),
  ];
  // The codex target's parent directory must exist for a dry-run plan.
  mkdirSync(join(home, '.codex'), { recursive: true });

  const result = installClientBatch(plans, { root });
  assert.equal(result.mode, 'dry-run');
  assert.equal(result.summary.dryRun, 3);
  assert.equal(result.summary.skipped, 3);
  assert.equal(result.results.length, 3);
  for (const item of result.results) {
    assert.equal(item.applied, false);
    assert.equal(item.action, 'dry-run');
  }
  for (const id of ['deepseek-harness', 'qoder', 'replit-agent']) {
    const skipped = result.skipped.find((entry) => entry.clientId === id);
    assert.ok(skipped, `${id} must be skipped`);
    assert.ok(skipped.reason.length > 0);
  }
  assert.equal(existsSync(join(root, '.mcp.json')), false);
  assert.equal(existsSync(join(root, 'opencode.json')), false);
  assert.equal(existsSync(join(root, '.ano')), false);
});

test('T-098 批量安装真实写入需授权：缺失授权拒绝且零写', (t) => {
  const root = rootFor(t);
  const home = rootFor(t);
  const plans = [planFor('claude-code', home, root), planFor('opencode', home, root)];
  // config.ts refuses to create a missing file, so the declared target must exist.
  writeFileSync(join(root, '.mcp.json'), '{}\n');

  const result = installClientBatch(plans, {
    root,
    mode: 'apply',
    confirm: true,
    authorizations: {
      'claude-code': authorization(root, { clientId: 'claude-code' }),
    },
  });

  assert.equal(result.mode, 'apply');
  assert.equal(result.summary.installed, 1);
  assert.equal(result.summary.refused, 1);
  const claude = result.results.find((entry) => entry.clientId === 'claude-code')!;
  const opencode = result.results.find((entry) => entry.clientId === 'opencode')!;
  assert.equal(claude.action, 'installed');
  assert.equal(claude.applied, true);
  assert.equal(claude.backupId !== null, true);
  assert.equal(opencode.action, 'refused');
  assert.equal(opencode.applied, false);
  assert.equal(existsSync(join(root, 'opencode.json')), false);
  assert.equal(existsSync(join(root, '.mcp.json')), true);

  // 无 statement 的授权同样零写。
  const root2 = rootFor(t);
  const home2 = rootFor(t);
  const noStatement = installClientBatch([planFor('claude-code', home2, root2)], {
    root: root2,
    mode: 'apply',
    confirm: true,
    authorizations: {
      'claude-code': authorization(root2, { clientId: 'claude-code', statement: '   ' }),
    },
  });
  assert.equal(noStatement.summary.refused, 1);
  assert.equal(existsSync(join(root2, '.mcp.json')), false);
});

test('T-098 批量安装逐客户端隔离失败：一个失败不阻断其他', (t) => {
  const root = rootFor(t);
  const home = rootFor(t);
  const broken: ClientAccessPlan = (() => {
    const plan = planFor('opencode', home, root);
    if (plan.target === null) throw new Error('expected an opencode target');
    return { ...plan, target: { ...plan.target, path: root } };
  })();
  const plans = [planFor('claude-code', home, root), broken];
  writeFileSync(join(root, '.mcp.json'), '{}\n');

  const result = installClientBatch(plans, {
    root,
    mode: 'apply',
    confirm: true,
    authorizations: {
      'claude-code': authorization(root, { clientId: 'claude-code' }),
      opencode: authorization(root, { clientId: 'opencode' }),
    },
  });

  assert.equal(result.results.length, 2);
  assert.equal(result.summary.installed, 1);
  assert.equal(result.summary.failed, 1);
  const failed = result.results.find((entry) => entry.clientId === 'opencode')!;
  assert.equal(failed.action, 'failed');
  assert.equal(failed.applied, false);
  assert.ok(failed.error !== null);
  assert.equal(existsSync(join(root, '.mcp.json')), true, 'the healthy client must still be installed');
});

test('T-098 旧客户端兼容：opencode 走 MCP 批量安装，zcode/pi 跳过', (t) => {
  const root = rootFor(t);
  const home = rootFor(t);
  const plans = [planFor('opencode', home, root), planFor('zcode', home, root), planFor('pi', home, root)];
  writeFileSync(join(root, 'opencode.json'), '{}\n');

  const result = installClientBatch(plans, {
    root,
    mode: 'apply',
    confirm: true,
    authorizations: {
      opencode: authorization(root, { clientId: 'opencode' }),
    },
  });

  assert.equal(result.summary.installed, 1);
  assert.equal(result.summary.skipped, 2);
  const opencode = result.results.find((entry) => entry.clientId === 'opencode')!;
  assert.equal(opencode.action, 'installed');
  assert.equal(existsSync(join(root, 'opencode.json')), true);
  const skippedIds = result.skipped.map((entry) => entry.clientId).sort();
  assert.deepEqual(skippedIds, ['pi', 'zcode']);
  for (const entry of result.skipped) {
    assert.ok(entry.reason.length > 0);
  }
});

test('T-101/D2 库级敏感配置路径在 plan/apply/install/restore 全部拒绝且零写', (t) => {
  const root = rootFor(t);
  const home = rootFor(t);
  const entry = { command: process.execPath, args: ['dist/surface/mcp.js'] };
  const cases: Array<{ name: string; path: string }> = [
    { name: '.env', path: join(home, '.env') },
    { name: 'secrets/id_rsa', path: join(home, 'secrets', 'id_rsa') },
    { name: 'credentials.json', path: join(home, 'secrets', 'credentials.json') },
    { name: 'id_ed25519', path: join(home, 'id_ed25519') },
  ];
  for (const item of cases) {
    const target = targetFor(home, {
      clientId: 'github-copilot',
      scope: 'user',
      path: item.path,
      allowedRoot: home,
    });
    const options = applyOptions(root, { authorization: authorization(root, { clientId: 'github-copilot' }) });
    assert.ok(sensitiveConfigPathReason(item.path) !== null, `${item.name} must be classified sensitive`);
    assert.throws(() => assertSafeConfigPath(item.path), /sensitive location/u, item.name);
    assert.throws(() => planClientConfig(target, entry), /sensitive location/u, `${item.name} plan`);
    assert.throws(() => applyClientConfig(target, entry, options), /sensitive location/u, `${item.name} apply`);
    assert.throws(() => installClientConfig(target, entry, options), /sensitive location/u, `${item.name} install`);
    assert.throws(() => restoreClientConfig(target, options), /sensitive location/u, `${item.name} restore`);
    assert.equal(existsSync(item.path), false, `${item.name} must not be created`);
  }
});

// ---------------------------------------------------------------------------
// T-153：平台路径、非法配置值、备份/恢复残余分支
// ---------------------------------------------------------------------------

function expectConfigError(run: () => unknown, code: string, pattern: RegExp): void {
  assert.throws(
    run,
    (error: unknown) => error instanceof ClientConfigError && error.code === code && pattern.test(error.message),
    `expected ClientConfigError ${code} matching ${pattern}`,
  );
}

test('T-153 平台路径：根符号链接解析、Windows 大小写等价与根类型校验', (t) => {
  const root = rootFor(t);
  const real = join(root, 'real-root');
  mkdirSync(real, { recursive: true });
  const linked = join(root, 'linked-root');
  fs.symlinkSync(real, linked, 'dir');
  assert.equal(resolveClientConfigRoot(linked), fs.realpathSync(real));

  const broken = join(root, 'broken-root');
  fs.symlinkSync(join(root, 'missing-target'), broken, 'dir');
  expectConfigError(() => resolveClientConfigRoot(broken), 'CLIENT_CONFIG_ROOT', /broken link/u);

  const filePath = join(root, 'plain.txt');
  writeFileSync(filePath, 'x');
  expectConfigError(() => resolveClientConfigRoot(filePath), 'CLIENT_CONFIG_ROOT', /not a directory/u);
  expectConfigError(() => resolveClientConfigRoot(''), 'CLIENT_CONFIG_ROOT', /canonical project root/u);
  expectConfigError(() => resolveClientConfigRoot(join(root, 'absent')), 'CLIENT_CONFIG_ROOT', /does not exist/u);

  if (process.platform === 'win32') {
    const checked = checkClientConfigAuthorization(authorization(root.toUpperCase()), root, 'claude-code', ['config']);
    assert.equal(checked.ok, true, 'Windows canonical roots compare case-insensitively');
  }

  assert.equal(checkClientConfigAuthorization('not-an-object' as unknown as ClientConfigAuthorization, root, 'claude-code', ['config']).ok, false);
  assert.equal(checkClientConfigAuthorization(authorization(root, { authorizationId: '   ' }), root, 'claude-code', ['config']).ok, false);
  assert.equal(checkClientConfigAuthorization(authorization(root, { scope: [] }), root, 'claude-code', ['config']).ok, false);

  // 缺失的父目录链：目录链在缺失尾组件处停止，随后由“父目录不存在”拒绝。
  const absentParent = targetFor(root, { path: join(root, 'absent-parent', 'cfg.json') });
  expectConfigError(() => readClientConfig(absentParent), 'CLIENT_CONFIG_PATH', /parent directory does not exist/u);
});

test('T-153 target 字段非法值、非常规 serverPath 与父目录链逐项拒绝', (t) => {
  const root = rootFor(t);
  const file = join(root, 'a-file');
  writeFileSync(file, '{}');
  const directory = join(root, 'a-dir');
  mkdirSync(directory);
  const realParent = join(root, 'real-parent');
  mkdirSync(realParent, { recursive: true });
  const linkedParent = join(root, 'linked-parent');
  fs.symlinkSync(realParent, linkedParent, 'dir');

  const cases: ReadonlyArray<{ name: string; target: ClientConfigTarget }> = [
    { name: 'empty path', target: targetFor(root, { path: '' }) },
    { name: 'empty allowedRoot', target: targetFor(root, { allowedRoot: '' }) },
    { name: 'empty serverPath', target: targetFor(root, { serverPath: [] }) },
    { name: 'empty segment', target: targetFor(root, { serverPath: [''] }) },
    { name: 'NUL segment', target: targetFor(root, { serverPath: ['a\0b'] }) },
    { name: '__proto__ segment', target: targetFor(root, { serverPath: ['__proto__'] }) },
    { name: 'constructor segment', target: targetFor(root, { serverPath: ['constructor'] }) },
    { name: 'prototype segment', target: targetFor(root, { serverPath: ['prototype'] }) },
    { name: 'empty serverName', target: targetFor(root, { serverName: '' }) },
    { name: 'path-like clientId', target: targetFor(root, { clientId: '../escape' }) },
    { name: 'space clientId', target: targetFor(root, { clientId: 'bad id' }) },
    { name: 'directory as file', target: targetFor(root, { path: directory }) },
    { name: 'symlinked parent', target: targetFor(root, { path: join(linkedParent, 'nested', 'cfg.json') }) },
    { name: 'file parent', target: targetFor(root, { path: join(file, 'nested', 'cfg.json') }) },
  ];
  for (const item of cases) {
    expectConfigError(() => readClientConfig(item.target), 'CLIENT_CONFIG_PATH', /./u);
  }

  const lying = { ...targetFor(root), serverPath: 'mcpServers' } as unknown as ClientConfigTarget;
  expectConfigError(() => readClientConfig(lying), 'CLIENT_CONFIG_PATH', /non-empty array/u);
});

test('T-153 TOML 子集：合法复杂文档解析与每类语法错误可读出原因', () => {
  const good = parseTomlDocument(
    '# leading comment\n'
      + 'title = "ANO\\tconfig" # trailing\n'
      + "literal = 'raw text'\n"
      + 'negative = -12\n'
      + 'enabled = false\n'
      + 'empty = []\n'
      + 'ports = [80, 443]\n'
      + '"quoted.key" = 2\n'
      + '[mcp_servers.other]\ncommand = "node"\nargs = ["a", "b"]\n'
      + '[mcp_servers.nested.deep]\nx = 1\n',
  ) as Record<string, unknown>;
  assert.equal(good['title'], 'ANO\tconfig');
  assert.equal(good['literal'], 'raw text');
  assert.equal(good['negative'], -12);
  assert.equal(good['enabled'], false);
  assert.deepEqual(good['empty'], []);
  assert.deepEqual(good['ports'], [80, 443]);
  assert.equal(good['quoted.key'], 2);

  const invalid: ReadonlyArray<readonly [source: string, pattern: RegExp]> = [
    ['a = "unterminated', /unterminated string/u],
    ['a = "bad\\qescape"', /unsupported escape sequence/u],
    ['a = "control\u0001char"', /control character/u],
    ['a =', /missing value/u],
    ['a = bareword', /unsupported value/u],
    ['a = [1, 2', /unterminated array/u],
    ['a = [1, , 2]', /empty array element/u],
    ['a = [1, "two"]', /flat and homogeneous/u],
    ['a = [[1]]', /flat and homogeneous/u],
    ['__proto__ = 1', /reserved key/u],
    ['constructor = 1', /reserved key/u],
    ['a b = 1', /invalid key/u],
    ['a..b = 1', /empty key segment/u],
    ['[a]\n[a]', /duplicate table/u],
    ['[a', /unterminated table header/u],
    ['[[a]]', /array tables are not supported/u],
    ['just-a-key', /expected key = value/u],
    ['a = = 1', /only one "=" is allowed/u],
    ['a = 1\n[a]', /conflicts with a scalar value/u],
    ['a = 1\na.b = 2', /conflicts with a scalar value/u],
    ['a = 1\na = 2', /duplicate key/u],
  ];
  for (const [source, pattern] of invalid) {
    expectConfigError(() => parseTomlDocument(source), 'CLIENT_CONFIG_FORMAT', pattern);
  }
});

test('T-153 非法 JSON、未知格式与合并容器冲突拒绝', (t) => {
  const root = rootFor(t);
  const target = targetFor(root);
  writeFileSync(target.path, '{not json');
  expectConfigError(() => readClientConfig(target), 'CLIENT_CONFIG_FORMAT', /not valid JSON/u);

  writeFileSync(target.path, '[1,2,3]');
  expectConfigError(() => readClientConfig(target), 'CLIENT_CONFIG_FORMAT', /JSON object at the top level/u);

  writeFileSync(target.path, '{}');
  const yaml = targetFor(root, { format: 'yaml' as ClientConfigFormat });
  expectConfigError(() => readClientConfig(yaml), 'CLIENT_CONFIG_FORMAT', /Unsupported config format/u);

  writeConfig(target, { mcpServers: ['not-an-object'] });
  expectConfigError(() => planClientConfig(target, DESIRED), 'CLIENT_CONFIG_FORMAT', /not an object/u);

  const nested = targetFor(root, { serverPath: ['mcp', 'servers'] });
  writeConfig(nested, { mcp: 1 });
  expectConfigError(() => planClientConfig(nested, DESIRED), 'CLIENT_CONFIG_FORMAT', /not an object/u);
});

test('T-153 备份 id/manifest/产物校验失败逐项拒绝且读取受门控', (t) => {
  const root = rootFor(t);
  const target = targetFor(root);
  writeConfig(target, { mcpServers: {} });
  const original = readConfig(target);

  expectConfigError(() => backupClientConfig(root, target, original, 'auth', { backupId: '../evil' }), 'CLIENT_CONFIG_BACKUP', /Unsafe backup id/u);
  expectConfigError(() => backupClientConfig(root, target, original, 'auth', { backupId: '.' }), 'CLIENT_CONFIG_BACKUP', /Unsafe backup id/u);

  const id = 'cfg-fixed-1';
  backupClientConfig(root, target, original, 'auth-x', { backupId: id, now: '2026-11-22T00:00:00.000Z' });
  expectConfigError(() => backupClientConfig(root, target, original, 'auth-x', { backupId: id }), 'CLIENT_CONFIG_BACKUP', /already exists/u);

  const dir = join(root, '.ano', 'clients', 'backups', 'claude-code', id);
  const manifestPath = join(dir, 'manifest.json');
  const artifact = join(dir, 'config.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;

  const variants: readonly Record<string, unknown>[] = [
    { ...manifest, schema: 'wrong-schema' },
    { ...manifest, id: 'other-id' },
    { ...manifest, clientId: 'codex' },
    { ...manifest, root: 'X:\\definitely-not-the-project-root' },
    { ...manifest, authorizationId: '' },
  ];
  for (const variant of variants) {
    writeFileSync(manifestPath, JSON.stringify(variant));
    const verification = verifyClientConfigBackup(root, 'claude-code', id);
    assert.equal(verification.ok, false);
    assert.ok(verification.errors.length > 0, JSON.stringify(variant));
  }

  writeFileSync(manifestPath, JSON.stringify(manifest));
  rmSync(artifact);
  const missingArtifact = verifyClientConfigBackup(root, 'claude-code', id);
  assert.equal(missingArtifact.ok, false);
  assert.match(missingArtifact.errors.join('; '), /backup artifact missing/u);

  writeFileSync(artifact, 'corrupted');
  const corrupted = verifyClientConfigBackup(root, 'claude-code', id);
  assert.equal(corrupted.ok, false);
  assert.match(corrupted.errors.join('; '), /hash mismatch/u);
  expectConfigError(() => readClientConfigBackup(root, 'claude-code', id), 'CLIENT_CONFIG_BACKUP', /Refusing to read backup/u);

  writeFileSync(artifact, original);
  const restoredArtifact = readClientConfigBackup(root, 'claude-code', id);
  assert.equal(restoredArtifact.bytes.equals(original), true);

  const listed = listClientConfigBackups(root, 'claude-code');
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.ok, true);

  const backupsDir = join(root, '.ano', 'clients', 'backups');
  mkdirSync(backupsDir, { recursive: true });
  writeFileSync(join(backupsDir, 'codex'), 'not a directory');
  assert.deepEqual(listClientConfigBackups(root, 'codex'), []);
});

test('T-153 原子写失败传播、回滚失败组合错误与并发不可读漂移', (t) => {
  const root = rootFor(t);
  const target = targetFor(root);
  writeConfig(target, { mcpServers: { other: { command: 'x' } } });

  assert.throws(() => atomicWriteFile(join(root, 'absent-dir', 'x.json'), Buffer.from('x')), /ENOENT/u);

  let phase = 0;
  const rolling: ClientConfigIo = {
    atomicWrite: (file) => {
      phase += 1;
      if (phase === 1) throw new Error('first write boom');
      writeFileSync(file, Buffer.from('garbage'));
    },
  };
  expectConfigError(
    () => applyClientConfig(target, DESIRED, applyOptions(root, { io: rolling })),
    'CLIENT_CONFIG_WRITE',
    /could not be restored/u,
  );

  // 回滚测试把配置留成了无效字节；先恢复再验证“备份后文件被并发删除”的漂移分支。
  writeConfig(target, { mcpServers: { other: { command: 'x' } } });
  const drifting: ClientConfigHooks = { afterBackup: () => rmSync(configPath(target)) };
  expectConfigError(
    () => applyClientConfig(target, DESIRED, applyOptions(root, { hooks: drifting })),
    'CLIENT_CONFIG_DRIFT',
    /can no longer be read/u,
  );
});

test('T-153 幂等 apply 不新建备份；restore 无 root/无备份/写失败与备份恢复哈希不符', (t) => {
  const root = rootFor(t);
  const target = targetFor(root);
  writeConfig(target, { mcpServers: { ano: DESIRED } });
  const unchanged = applyClientConfig(target, DESIRED, applyOptions(root));
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.applied, false);
  assert.equal(unchanged.backupId, null);

  writeConfig(target, { mcpServers: {} });
  const installed = installClientConfig(target, DESIRED, applyOptions(root));
  const backupId = installed.backupId as unknown as string;
  assert.equal(installed.action, 'installed');

  const noRoot = restoreConfigFile(target, { mode: 'apply', confirm: true, authorization: authorization(root) });
  assert.equal(noRoot.applied, false);
  assert.match(noRoot.warnings.join('; '), /project root is required/u);

  const emptyRoot = rootFor(t);
  const emptyTarget = targetFor(emptyRoot);
  writeConfig(emptyTarget, { mcpServers: {} });
  const noBackup = restoreConfigFile(emptyTarget, {
    mode: 'apply',
    confirm: true,
    authorization: authorization(emptyRoot),
    root: emptyRoot,
  });
  assert.equal(noBackup.applied, false);
  assert.match(noBackup.warnings.join('; '), /no verified backup/u);

  const failingIo: ClientConfigIo = { atomicWrite: () => { throw new Error('restore write boom'); } };
  const failed = restoreConfigFile(target, { ...applyOptions(root), io: failingIo });
  assert.equal(failed.mode, 'apply');
  assert.equal(failed.applied, false);
  assert.match(String(failed.error), /restore write boom/u);

  const tamperIo: ClientConfigIo = { atomicWrite: (file) => { atomicWriteFile(file, Buffer.from('tampered')); } };
  expectConfigError(() => restoreFromBackup(root, target, backupId, tamperIo), 'CLIENT_CONFIG_WRITE', /does not match the verified backup/u);

  const throwingIo: ClientConfigIo = { atomicWrite: () => { throw new Error('write refused'); } };
  assert.throws(() => restoreFromBackup(root, target, backupId, throwingIo), /write refused/u);
});

test('T-153 敏感路径分类覆盖环境文件/目录/凭证/密钥材料与白名单', () => {
  const sensitive: readonly string[] = [
    '.env',
    '.env.local',
    join('secrets', 'settings.json'),
    join('credentials', 'notes.md'),
    join('tokens', 'a.b'),
    'password',
    'token',
    'api_key',
    'client_secret',
    'private-key',
    'server.pem',
    'id_rsa',
    'id_ed25519',
  ];
  for (const path of sensitive) {
    assert.notEqual(sensitiveConfigPathReason(path), null, path);
  }
  assert.equal(sensitiveConfigPathReason('settings.json'), null);
  assert.doesNotThrow(() => assertSafeConfigPath('settings.json'));
});
