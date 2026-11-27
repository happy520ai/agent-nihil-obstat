import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import test from 'node:test';
import { createResolutionContext, resolveWorkspaceSpecifier } from '../../src/structure/imports.ts';
import { writeM18EFixture } from '../helpers/m18-e-fixtures.ts';

test('workspace package exports resolve declared and undeclared subpaths', async () => {
  const root = await writeM18EFixture({
    'package.json': JSON.stringify({ name: 'workspace-host', private: true, workspaces: ['packages/*'] }),
    'packages/lib/package.json': JSON.stringify({
      name: '@scope/lib',
      exports: {
        '.': { types: './index.d.ts', import: './index.js' },
        './feature': { types: './feature.d.ts', import: './feature.js' },
      },
    }),
    'packages/lib/index.ts': 'export const i = 1;\n',
    'packages/lib/feature.ts': 'export const f = 1;\n',
    'packages/lib/other.ts': 'export const o = 1;\n',
  });
  try {
    const files = ['packages/lib/index.ts', 'packages/lib/feature.ts', 'packages/lib/other.ts'];
    const context = await createResolutionContext(root, files);

    assert.equal(context.workspaces.length, 1);
    const workspace = context.workspaces[0];
    assert.ok(workspace);
    assert.equal(workspace.name, '@scope/lib');
    assert.equal(workspace.entries.fallback, false, 'the package exports map supplies the entry');
    assert.deepEqual([...workspace.subpaths.keys()], ['feature']);

    assert.deepEqual(
      resolveWorkspaceSpecifier(context, '@scope/lib'),
      { status: 'resolved', path: 'packages/lib/index.ts' },
      'the exports root resolves through its import condition',
    );
    assert.deepEqual(
      resolveWorkspaceSpecifier(context, '@scope/lib/feature'),
      { status: 'resolved', path: 'packages/lib/feature.ts' },
      'a declared subpath resolves through the exports conditions',
    );
    assert.deepEqual(
      resolveWorkspaceSpecifier(context, '@scope/lib/other'),
      { status: 'resolved', path: 'packages/lib/other.ts' },
      'an undeclared subpath falls back to a literal path candidate',
    );
    assert.equal(resolveWorkspaceSpecifier(context, '@scope/lib/missing')?.status, 'unresolved');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
