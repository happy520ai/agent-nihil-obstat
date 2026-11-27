import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { classifySpdx, scanLicenses } from '../../src/audit/license.ts';

async function temp(prefix: string): Promise<string> { return mkdtemp(join(tmpdir(), prefix)); }

async function write(root: string, path: string, source: string): Promise<void> {
  const target = join(root, ...path.split('/'));
  await mkdir(join(target, '..'), { recursive: true });
  await writeFile(target, source);
}

async function writeJson(root: string, path: string, value: unknown): Promise<void> {
  await write(root, path, JSON.stringify(value, null, 2));
}

test('classifySpdx handles operators, exceptions, malformed input and proprietary markers', () => {
  const cases: Array<[string, string]> = [
    ['', 'unknown'],
    ['   ', 'unknown'],
    ['MIT', 'permissive'],
    ['MIT AND', 'unknown'],
    ['WITH MIT', 'unknown'],
    ['MIT X', 'unknown'],
    ['(MIT OR GPL-2.0)', 'permissive'],
    ['MIT WITH Classpath-exception-2.0', 'permissive'],
    ['GPL-2.0+', 'strong-copyleft'],
    ['LGPL-2.1-only', 'weak-copyleft'],
    ['MPL-2.0', 'weak-copyleft'],
    ['SSPL-1.0', 'strong-copyleft'],
    ['LicenseRef-Proprietary', 'proprietary'],
    ['SEE-LICENSE-IN-LICENSE.md', 'proprietary'],
    ['gpl-2.0-only OR mit', 'permissive'],
    ['(MIT', 'permissive'],
    ['MIT AND (GPL-2.0', 'strong-copyleft'],
    ['bogus-license', 'unknown'],
    ['0BSD', 'permissive'],
  ];
  for (const [expression, expected] of cases) {
    assert.equal(classifySpdx(expression), expected, `${JSON.stringify(expression)} -> ${expected}`);
  }
});

test('scanLicenses reads lock v2/v3 packages, derives names from paths and consults node_modules metadata', async () => {
  const root = await temp('ano license v3 ');
  try {
    await writeJson(root, 'package.json', { name: 'fixture', version: '1.0.0', license: 'MIT' });
    await writeJson(root, 'package-lock.json', {
      lockfileVersion: 3,
      packages: {
        '': { name: 'fixture', version: '1.0.0', license: 'GPL-3.0-only' },
        'node_modules': { version: '1.0.0', license: 'MIT' },
        'node_modules/not-an-object': 5,
        'node_modules/alpha': { version: '1.0.0', license: 'MIT' },
        'node_modules/@scope/beta': { version: '2.0.0', license: { type: 'Apache-2.0' } },
        'node_modules/copyleft': { name: 'copyleft', version: '1.0.0', license: 'GPL-3.0-only' },
        'node_modules/weak': { name: 'weak', version: '1.0.0', license: 'MPL-2.0' },
        'node_modules/unknown': { name: 'unknown', version: '1.0.0', license: 'WTFPL-9000' },
        'node_modules/proprietary': { name: 'proprietary', version: '1.0.0', license: 'UNLICENSED', hasInstallScript: true },
        'node_modules/missing': { name: 'missing', version: '1.0.0' },
        'node_modules/meta': { name: 'meta', version: '3.0.0' },
        'node_modules/twin': { name: 'twin', version: '1.0.0', license: 'MIT' },
        'node_modules/twin/node_modules/nested': { name: 'twin', version: '1.0.0', license: 'MIT' },
      },
    });
    await writeJson(root, 'node_modules/meta/package.json', { name: 'meta', version: '3.0.0', license: 'ISC' });

    const result = await scanLicenses(root);
    const byRule = new Map(result.findings.map((finding) => [finding.rule, finding]));
    assert.equal(result.projectLicense, 'MIT');
    assert.equal(result.packages, 10);
    assert.equal(result.degraded.includes('lockfile-has-no-packages'), false);

    assert.equal(byRule.get('license/strong-copyleft')?.severity, 'high');
    assert.equal(byRule.get('license/weak-copyleft')?.severity, 'medium');
    assert.equal(byRule.get('license/unknown')?.severity, 'medium');
    assert.equal(byRule.get('license/proprietary')?.severity, 'medium');
    assert.equal(byRule.get('license/dependency-missing')?.severity, 'medium');
    assert.ok(!byRule.has('license/project-unclassified'), 'MIT project license is classified');
    assert.ok(!result.findings.some((finding) => finding.message.includes('alpha')), 'MIT dependency is not reported');
    assert.ok(!result.findings.some((finding) => finding.message.includes('meta@')), 'node_modules metadata supplied the ISC license');
    const twins = result.findings.filter((finding) => finding.message.includes('twin@'));
    assert.equal(twins.length, 0, 'the nested duplicate is deduplicated');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('scanLicenses falls back to lock v1 dependencies and flags an unclassified project license', async () => {
  const root = await temp('ano license v1 ');
  try {
    await writeJson(root, 'package.json', { name: 'legacy', version: '0.1.0', license: 'LicenseRef-Internal' });
    await writeJson(root, 'package-lock.json', {
      lockfileVersion: 1,
      dependencies: {
        alpha: { version: '1.0.0', license: 'MIT', dependencies: { nested: { version: '1.0.0', license: 'GPL-2.0' } } },
        broken: 'not-an-object',
        unversioned: { license: 'ISC' },
        bare: { version: '1.0.0' },
      },
    });
    const result = await scanLicenses(root);
    const rules = result.findings.map((finding) => finding.rule);
    assert.ok(rules.includes('license/project-unclassified'));
    assert.ok(rules.includes('license/strong-copyleft'));
    assert.ok(rules.includes('license/dependency-missing'));
    assert.equal(result.projectLicense, 'LicenseRef-Internal');
    assert.ok(result.findings.every((finding) => finding.fingerprint.length === 64));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('scanLicenses reports missing or unreadable manifests without throwing', async () => {
  const missing = await temp('ano license missing ');
  try {
    const noFiles = await scanLicenses(missing);
    assert.deepEqual(noFiles.findings.map((finding) => finding.rule), ['license/project-missing']);
    assert.ok(noFiles.degraded.some((entry) => entry.startsWith('package-json-unreadable:')));
    assert.ok(noFiles.degraded.includes('lockfile-missing'));

    await write(missing, 'package.json', JSON.stringify({ name: 'x' }));
    await write(missing, 'package-lock.json', '{ not json');
    const unreadable = await scanLicenses(missing);
    assert.ok(unreadable.degraded.some((entry) => entry.startsWith('lockfile-unreadable:')), unreadable.degraded.join(','));
    assert.equal(unreadable.projectLicense, undefined);

    await writeJson(missing, 'package-lock.json', { name: 'x', version: '1.0.0' });
    const noPackages = await scanLicenses(missing);
    assert.ok(noPackages.degraded.includes('lockfile-has-no-packages'));
    assert.equal(noPackages.packages, 0);
  } finally { await rm(missing, { recursive: true, force: true }); }
});

test('scanLicenses reuses a strong-copyleft project license as a low-severity dependency match', async () => {
  const root = await temp('ano license strong ');
  try {
    await writeJson(root, 'package.json', { name: 'copyleft-project', license: 'GPL-3.0-only' });
    await writeJson(root, 'package-lock.json', {
      packages: { 'node_modules/peer': { name: 'peer', version: '1.0.0', license: 'AGPL-3.0-only' } },
    });
    const result = await scanLicenses(root);
    const finding = result.findings.find((item) => item.rule === 'license/strong-copyleft');
    assert.ok(finding);
    assert.equal(finding.severity, 'low');
    assert.equal(result.projectLicense, 'GPL-3.0-only');
  } finally { await rm(root, { recursive: true, force: true }); }
});
