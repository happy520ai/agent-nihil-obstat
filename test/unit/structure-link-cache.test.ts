import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { resolveProjectScan } from '../../src/core/project-scan.ts';
import { GraphStore } from '../../src/structure/store.ts';

async function fixture(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ano graph link cache '));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [path, content] of Object.entries({
    '.git/HEAD': 'ref: refs/heads/main\n',
    '.pm/project.json': JSON.stringify({ name: 'link-cache' }),
    'package.json': JSON.stringify({ name: 'link-cache' }),
    'src/keep.ts': 'export const keep = 1;\n',
    'ignored/target.ts': 'export const linked = 1;\n',
  })) {
    const absolute = join(root, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
  return root;
}

async function link(t: TestContext, target: string, path: string): Promise<boolean> {
  try {
    await symlink(target, path);
    return true;
  } catch (error) {
    t.skip(`symlink unavailable in this environment: ${String(error)}`);
    return false;
  }
}

async function outsideTarget(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ano graph link outside '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, 'outside.ts');
  await writeFile(target, 'export const outside = 1;\n');
  return target;
}

test('followed link cache stays fresh only while the linked content is unchanged', async (t) => {
  const root = await fixture(t);
  const target = join(root, 'ignored', 'target.ts');
  if (!await link(t, target, join(root, 'src', 'linked.ts'))) return;
  const scan = await resolveProjectScan({ startRoot: root, followLinks: true, exclude: ['ignored/**'] });
  const first = await GraphStore.open(root, { scan });
  try {
    await first.build();
    assert.equal(first.freshness().status, 'fresh');
    assert.deepEqual(first.filesList(), ['src/keep.ts', 'src/linked.ts']);
  } finally { first.close(); }

  const reopened = await GraphStore.open(root, { scan });
  try {
    assert.equal(reopened.freshness().status, 'fresh', 'unchanged followed links are verified by content');
    const revision = reopened.revision;
    await writeFile(target, 'export const linked = 2;\n');
    assert.equal((await reopened.checkFreshness()).status, 'stale');
    assert.equal(reopened.revision, revision, 'checking freshness never silently rebuilds the graph');
  } finally { reopened.close(); }
});

test('a newly added escaping link cannot hide behind a manifest cache hit', async (t) => {
  const root = await fixture(t);
  const target = await outsideTarget(t);
  const scan = await resolveProjectScan({ startRoot: root, followLinks: true });
  const store = await GraphStore.open(root, { scan });
  try {
    await store.build();
    if (!await link(t, target, join(root, 'src', 'escape.ts'))) return;
    const freshness = await store.checkFreshness();
    assert.equal(freshness.status, 'degraded');
    assert.ok(freshness.reasons?.some((reason) => reason.includes('LINK_ESCAPE')));
  } finally { store.close(); }
});

test('reopening a cache checks new escaping links instead of reporting fresh', async (t) => {
  const root = await fixture(t);
  const target = await outsideTarget(t);
  const scan = await resolveProjectScan({ startRoot: root, followLinks: true });
  const first = await GraphStore.open(root, { scan });
  try { await first.build(); }
  finally { first.close(); }
  if (!await link(t, target, join(root, 'src', 'escape.ts'))) return;

  const reopened = await GraphStore.open(root, { scan });
  try {
    const freshness = reopened.freshness();
    assert.equal(freshness.status, 'degraded');
    assert.ok(freshness.reasons?.some((reason) => reason.includes('LINK_ESCAPE')));
  } finally { reopened.close(); }
});

test('followLinks cache validation respects an exhausted fingerprint budget', async (t) => {
  const root = await fixture(t);
  const scan = await resolveProjectScan({ startRoot: root, followLinks: true });
  const first = await GraphStore.open(root, { scan });
  try { await first.build(); }
  finally { first.close(); }
  const expired = await resolveProjectScan({ startRoot: root, followLinks: true, timeoutMs: 0 });
  const reopened = await GraphStore.open(root, { scan: expired });
  try {
    const freshness = reopened.freshness();
    assert.equal(freshness.status, 'degraded');
    assert.ok(freshness.reasons?.includes('scan-timeout:budget-exceeded'));
  } finally { reopened.close(); }
});
