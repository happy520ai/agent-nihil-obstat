import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import {
  computeProfileHash,
  loadProfileText,
  loadReadinessProfiles,
  parseProfileToml,
  validatedProfiles,
} from '../../src/readiness/index.ts';
import { copyProfiles, profileText, temp, writeValidationRecord } from '../fixtures/readiness/support.ts';

const BASE = [
  'schema = 1',
  'id = "A"',
  'name = "Fixture A"',
  'kind = "library"',
  'status = "defined"',
  '',
  '[requirements."a.build"]',
  'title = "Build"',
  'scope = "A"',
  'evidence = "machine"',
  'freshness_days = 30',
].join('\n');

function codeOf(run: () => unknown): string | undefined {
  try { run(); } catch (error) {
    return typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : undefined;
  }
  return undefined;
}

async function codeOfAsync(run: () => Promise<unknown>): Promise<string | undefined> {
  try { await run(); } catch (error) {
    return typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : undefined;
  }
  return undefined;
}

function expectProfileError(text: string, pattern: RegExp): void {
  let message = '';
  const code = codeOf(() => { parseProfileToml(text); });
  try { parseProfileToml(text); } catch (error) { message = (error as Error).message; }
  assert.equal(code, 'PROFILE_INVALID', `expected PROFILE_INVALID, got ${code} (${message}) for:\n${text}`);
  assert.match(message, pattern);
}

test('parseProfileToml rejects malformed top-level profiles', () => {
  expectProfileError(BASE.replace('schema = 1', 'schema = 2'), /Unsupported profile schema/);
  expectProfileError('schema = 1\nid = "A"\nname = "n"\nkind = "library"\nstatus = "defined"\n', /Missing requirements table/);
  expectProfileError(BASE.replace('name = "Fixture A"', 'name = "Fixture A"\nextra = 1'), /Unknown profile field/);
  expectProfileError(BASE.replace('id = "A"', 'id = "Z"'), /must be one of/);
  expectProfileError(BASE.replace('id = "A"', 'id = 7'), /id must be a quoted string/);
  expectProfileError(BASE.replace('name = "Fixture A"', 'name = ""'), /must not be empty/);
  expectProfileError(BASE.replace('kind = "library"', 'kind = "unknown"'), /must be one of/);
  expectProfileError(BASE.replace('status = "defined"', 'status = "draft"'), /must be one of/);
  expectProfileError(BASE.replace('id = "A"', 'id = "common"'), /common profile must use kind/);
  expectProfileError(BASE.replace('kind = "library"', 'kind = "common"'), /Only the common profile/);
  expectProfileError(BASE.replace('status = "defined"', 'status = "validated"'), /must include a \[validation\]/);
  expectProfileError(`${BASE}\n[validation]\nproject = "p"\nvalidated_at = "2026-01-01"\nverdict_hash = "${'a'.repeat(64)}"\n`, /requires status = "validated"/);
  expectProfileError(`${BASE.replace('status = "defined"', 'status = "validated"')}\n[validation]\nproject = "p"\nvalidated_at = "2026-01-01"\nextra = 1\n`, /Unknown validation field/);
  expectProfileError(`${BASE.replace('status = "defined"', 'status = "validated"')}\n[validation]\nproject = "p"\nvalidated_at = "2026/01/01"\nverdict_hash = "${'a'.repeat(64)}"\n`, /ISO date/);
  expectProfileError(`${BASE.replace('status = "defined"', 'status = "validated"')}\n[validation]\nproject = "p"\nvalidated_at = "2026-01-01"\nverdict_hash = "xyz"\n`, /sha256 hex/);
  expectProfileError(`${BASE.replace('status = "defined"', 'status = "validated"')}\n[validation]\nproject = "p"\nvalidated_at = "2026-01-01"\n`, /verdict_hash must be a quoted string/);
  expectProfileError('schema = 1\nid = "A"\nname = "n"\nkind = "library"\nstatus = "defined"\n\n[requirements]\n', /must declare at least one requirement/);
  expectProfileError(BASE.replace('[requirements."a.build"]', '[requirements]\nab = 1'), /requirements.ab must be a table/);
});

test('parseProfileToml rejects malformed requirements', () => {
  expectProfileError(BASE.replace('[requirements."a.build"]', '[requirements."Bad"]'), /Invalid requirement id/);
  expectProfileError(BASE.replace('title = "Build"', 'title = "Build"\nextra = 1'), /Unknown requirement/);
  expectProfileError(BASE.replace('title = "Build"', 'title = ""'), /title must not be empty/);
  expectProfileError(BASE.replace('scope = "A"', 'scope = "B"'), /does not match profile/);
  expectProfileError(BASE.replace('scope = "A"', 'scope = "bogus"'), /must be one of/);
  expectProfileError(BASE.replace('[requirements."a.build"]', '[requirements."b.build"]'), /must start with a\./);
  expectProfileError(BASE.replace('evidence = "machine"', 'evidence = "declaration"'), /must be one of/);
  expectProfileError(BASE.replace('freshness_days = 30', 'freshness_days = -1'), /between 0 and 3650/);
  expectProfileError(BASE.replace('freshness_days = 30', 'freshness_days = 5000'), /between 0 and 3650/);
  expectProfileError(BASE.replace('freshness_days = 30', 'freshness_days = "30"'), /freshness_days must be an integer/);
  expectProfileError(
    BASE.replace('evidence = "machine"', 'evidence = "attested"').replace('freshness_days = 30', 'freshness_days = 0'),
    /at least 1 when evidence allows attestations/,
  );
  expectProfileError(BASE.replace('freshness_days = 30', 'freshness_days = 30\ncheck = "Bad Check"'), /not a valid check id/);
  expectProfileError(BASE.replace('freshness_days = 30', 'freshness_days = 30\nkinds = "ci_run"'), /must be an array/);
  expectProfileError(BASE.replace('freshness_days = 30', 'freshness_days = 30\nkinds = [1]'), /must be an array of strings/);
  expectProfileError(BASE.replace('freshness_days = 30', 'freshness_days = 30\nkinds = ["unknown"]'), /unknown kind/);
});

test('parseProfileToml accepts valid requirements and sorts them by id', () => {
  const text = [
    'schema = 1',
    'id = "A"',
    'name = "Fixture A"',
    'kind = "library"',
    'status = "defined"',
    '',
    '[requirements."a.zulu"]',
    'title = "Z"',
    'scope = "A"',
    'evidence = "machine"',
    'freshness_days = 10',
    'check = "a.zulu"',
    'kinds = ["ci_run", "ci_run", "secret_scan"]',
    '',
    '[requirements."a.alpha"]',
    'title = "A"',
    'scope = "A"',
    'evidence = "machine_or_attested"',
    'freshness_days = 1',
    'kinds = []',
  ].join('\n');
  const { profile, declaredSchemaHash } = parseProfileToml(text);
  assert.equal(declaredSchemaHash, null);
  assert.deepEqual(profile.requirements.map((requirement) => requirement.id), ['a.alpha', 'a.zulu']);
  assert.deepEqual(profile.requirements[1]!.kinds, ['ci_run', 'secret_scan']);
  assert.equal(profile.requirements[1]!.check, 'a.zulu');
  assert.equal(profile.schemaHash, '');
  assert.equal(profile.notes, null);
  assert.equal(profile.validation, null);
  assert.equal(profile.requirements[0]!.check, null);
  assert.deepEqual(profile.requirements[0]!.kinds, []);
});

test('loadProfileText enforces pinned schema hashes', () => {
  assert.equal(codeOf(() => loadProfileText(BASE)), 'PROFILE_HASH_MISSING');
  assert.equal(codeOf(() => loadProfileText(BASE.replace('schema = 1', `schema = 1\nschema_hash = "${'a'.repeat(64)}"`))), 'PROFILE_HASH_MISMATCH');

  const parsed = parseProfileToml(BASE).profile;
  const hash = computeProfileHash(parsed);
  const loaded = loadProfileText(BASE.replace('schema = 1', `schema = 1\nschema_hash = "${hash}"`));
  assert.equal(loaded.schemaHash, hash);
  assert.equal(loaded.status, 'defined');
});

test('loadReadinessProfiles rejects missing, non-directory and unknown profile assets', async () => {
  const missing = join(await temp('ano profiles missing '), 'absent');
  assert.equal(await codeOfAsync(() => loadReadinessProfiles(missing)), 'PROFILE_DIR_MISSING');

  const fileRoot = await temp('ano profiles file ');
  try {
    await writeFile(join(fileRoot, 'not-a-dir'), 'x');
    assert.equal(await codeOfAsync(() => loadReadinessProfiles(join(fileRoot, 'not-a-dir'))), 'PROFILE_DIR_MISSING');

    const bundle = await copyProfiles(join(fileRoot, 'bundle'));
    assert.equal(await codeOfAsync(() => loadReadinessProfiles(bundle, { validationDirectory: bundle })), 'PROFILE_SELF_CERTIFICATION');
    assert.equal(await codeOfAsync(() => loadReadinessProfiles(bundle, { validationDirectory: join(bundle, 'nested') })), 'PROFILE_SELF_CERTIFICATION');

    await writeFile(join(bundle, 'ZZ.toml'), BASE);
    assert.equal(await codeOfAsync(() => loadReadinessProfiles(bundle)), 'PROFILE_UNKNOWN_FILE');
    await rm(join(bundle, 'ZZ.toml'));

    await rm(join(bundle, 'A.toml'));
    assert.equal(await codeOfAsync(() => loadReadinessProfiles(bundle)), 'PROFILE_MISSING');

    const other = await temp('ano profiles other ');
    try {
      const bundle2 = await copyProfiles(join(other, 'bundle'));
      await writeFile(join(bundle2, 'A.toml'), await profileText('B'), 'utf8');
      assert.equal(await codeOfAsync(() => loadReadinessProfiles(bundle2)), 'PROFILE_INVALID');
    } finally { await rm(other, { recursive: true, force: true }); }
  } finally { await rm(fileRoot, { recursive: true, force: true }); }
});

test('loadReadinessProfiles validates external records and rejects every mismatch shape', async () => {
  const workspace = await temp('ano profiles validation ');
  try {
    const raw = await profileText('A');
    const schemaHash = computeProfileHash(parseProfileToml(raw).profile);
    const withValidation = `${raw.replace('status = "defined"', 'status = "validated"')}\n[validation]\nproject = "external-product"\nvalidated_at = "2026-03-01"\nverdict_hash = "${'b'.repeat(64)}"\n`;
    assert.equal(parseProfileToml(withValidation).profile.status, 'validated');

    const goodRecord = {
      schema: 1,
      profile_id: 'A',
      project: 'external-product',
      validated_at: '2026-03-01',
      verdict_hash: 'b'.repeat(64),
      profile_schema_hash: schemaHash,
    };

    const okBundle = await copyProfiles(join(workspace, 'ok'), { A: withValidation });
    const records = join(workspace, 'records');
    await mkdir(records, { recursive: true });
    await writeValidationRecord(records, goodRecord as never);
    const loaded = await loadReadinessProfiles(okBundle, { validationDirectory: records });
    assert.deepEqual(validatedProfiles(loaded.profiles), ['A']);
    assert.equal(loaded.profiles.length, 9);

    const cases: Array<[string, Record<string, unknown> | string, string]> = [
      ['no-record', 'delete', 'PROFILE_SELF_CERTIFICATION'],
      ['wrong-profile', { ...goodRecord, profile_id: 'B' }, 'PROFILE_VALIDATION_MISMATCH'],
      ['wrong-hash', { ...goodRecord, profile_schema_hash: 'c'.repeat(64) }, 'PROFILE_VALIDATION_MISMATCH'],
      ['self-project', { ...goodRecord, project: 'Agent Nihil Obstat' }, 'PROFILE_SELF_CERTIFICATION'],
      ['date-mismatch', { ...goodRecord, validated_at: '2026-03-02' }, 'PROFILE_VALIDATION_MISMATCH'],
      ['not-json', 'not-json', 'PROFILE_VALIDATION_INVALID'],
      ['malformed', { ...goodRecord, schema: 2 }, 'PROFILE_VALIDATION_INVALID'],
      ['extra-field', { ...goodRecord, extra: true }, 'PROFILE_VALIDATION_INVALID'],
      ['empty-project', { ...goodRecord, project: '' }, 'PROFILE_VALIDATION_INVALID'],
    ];
    for (const [name, record, expected] of cases) {
      const bundle = await copyProfiles(join(workspace, `bundle-${name}`), { A: withValidation });
      const directory = join(workspace, `records-${name}`);
      await mkdir(directory, { recursive: true });
      if (record !== 'delete') {
        await writeFile(join(directory, 'A.validation.json'), typeof record === 'string' ? record : JSON.stringify(record));
      }
      const code = await codeOfAsync(() => loadReadinessProfiles(bundle, { validationDirectory: directory }));
      assert.equal(code, expected, `${name} should fail with ${expected}, got ${code}`);
    }

    const listedBundle = await copyProfiles(join(workspace, 'bundle-listed'), { A: withValidation });
    const listedRecords = join(workspace, 'records-listed');
    await mkdir(listedRecords, { recursive: true });
    await writeFile(join(listedRecords, 'A.validation.json'), JSON.stringify({ ...goodRecord, project: 'internal-tool' }));
    assert.equal(
      await codeOfAsync(() => loadReadinessProfiles(listedBundle, { validationDirectory: listedRecords, selfProjectNames: ['internal-tool'] })),
      'PROFILE_SELF_CERTIFICATION',
    );

    const tooLarge = await copyProfiles(join(workspace, 'bundle-large'), { A: withValidation });
    const largeDir = join(workspace, 'records-large');
    await mkdir(largeDir, { recursive: true });
    await writeFile(join(largeDir, 'A.validation.json'), 'x'.repeat(70 * 1024));
    assert.equal(await codeOfAsync(() => loadReadinessProfiles(tooLarge, { validationDirectory: largeDir })), 'PROFILE_VALIDATION_INVALID');

    const dirRecord = await copyProfiles(join(workspace, 'bundle-dir'), { A: withValidation });
    const dirDir = join(workspace, 'records-dir');
    await mkdir(join(dirDir, 'A.validation.json'), { recursive: true });
    assert.equal(await codeOfAsync(() => loadReadinessProfiles(dirRecord, { validationDirectory: dirDir })), 'PROFILE_VALIDATION_INVALID');
  } finally { await rm(workspace, { recursive: true, force: true }); }
});
