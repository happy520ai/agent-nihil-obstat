import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { planNodeTargets } from '../../scripts/node-matrix.ts';
import { runSelfHost } from '../../scripts/selfhost.ts';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

test('node matrix plans a missing Node 22 leg instead of passing it', () => {
  const planned = planNodeTargets({}, 'C:/node24/node.exe', 'v24.14.0');
  const node22 = planned.find((target) => target.id === 'node-22');
  const node24 = planned.find((target) => target.id === 'node-24');
  assert.equal(node22?.path, null);
  assert.match(node22?.reason ?? '', /ANO_NODE22 is not set/u);
  assert.equal(node24?.path, 'C:/node24/node.exe');

  const supplied = planNodeTargets({ ANO_NODE22: 'C:/node22/node.exe' }, 'C:/node24/node.exe', 'v24.14.0');
  assert.equal(supplied.find((target) => target.id === 'node-22')?.path, 'C:/node22/node.exe');
});

const selfHostSkip = process.env.CI === 'true' && process.env.ANO_SELFHOST !== '1'
  ? 'tarball self-host requires a temporary registry install; run with ANO_SELFHOST=1 for release smoke'
  : false;

test('real tarball self-host launches workspace MCP config and exercises track/brief/explore/note/recall', { timeout: 300_000, skip: selfHostSkip }, async () => {
  const report = await runSelfHost();
  assert.equal(report.schema, 'ano.selfhost.v1');
  assert.equal(report.source.root, resolve(repoRoot));
  assert.equal(report.checks.build.status, 'passed');
  assert.equal(report.checks.pack.status, 'passed');
  assert.equal(report.checks.install.status, 'passed');
  assert.equal(report.checks.cliVersion.status, 'passed');
  assert.equal(report.checks.graphRebuild.status, 'passed');
  assert.equal(report.checks.workspaceConfig.status, 'passed', JSON.stringify(report.checks.workspaceConfig));
  assert.equal(report.checks.workspaceConfig.registrationScope, 'user', 'the deduped workspace must inherit the user-scope ano registration');
  assert.equal(report.checks.workspaceConfig.workspaceAnoDeclared, false, 'the workspace must not duplicate the user-scope ano registration');
  assert.equal(report.checks.tarballWorkspaceConfig.status, 'passed', JSON.stringify(report.checks.tarballWorkspaceConfig));
  assert.deepEqual(report.checks.tarballWorkspaceConfig.tools, ['brief', 'explore', 'recall', 'track', 'note', 'verify', 'audit']);
  assert.equal(report.checks.track.status, 'passed');
  assert.equal(report.checks.track.taskId, 'SELFHOST-T1');
  assert.equal(report.checks.brief.status, 'passed');
  assert.equal(report.checks.brief.phase, 'P7');
  assert.equal(report.checks.brief.hasSelfHostTask, true);
  assert.equal(report.checks.explore.status, 'passed');
  assert.equal(report.tarball?.sha256.length, 64);

  for (const name of ['note', 'recall', 'cliNote', 'cliRecall'] as const) {
    const check = report.checks[name];
    assert.ok(check.status === 'passed' || check.status === 'unimplemented' || check.status === 'not-configured', `${name}: ${String(check.status)} ${String(check.evidence)}`);
    if (check.status === 'unimplemented') assert.match(String(check.evidence), /not implemented|未接通/iu);
  }
  assert.equal(report.checks.recall.status, 'passed');
  assert.equal(report.checks.cliRecall.status, 'passed');

  const unwired = (['note', 'recall', 'cliNote', 'cliRecall'] as const).some((name) => report.checks[name].status === 'unimplemented' || report.checks[name].status === 'not-configured');
  assert.equal(report.verdict, unwired ? 'passed-with-limitations' : 'passed');
  assert.ok(resolve(report.workspaceRoot).startsWith(resolve(tmpdir())), 'self-host workspace must live under os.tmpdir()');
  assert.ok(!resolve(report.workspaceRoot).startsWith(resolve(repoRoot)), 'self-host workspace must not be inside the repository');
  assert.equal(report.tempRemoved, true);
});
