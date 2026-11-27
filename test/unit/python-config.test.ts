import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig } from '../../src/core/config.ts';

async function fixture(t: test.TestContext, text = ''): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ano-python-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  if (text) {
    await mkdir(join(root, '.ano'));
    await writeFile(join(root, '.ano', 'config.toml'), text);
  }
  return root;
}

test('Python config defaults do not select an interpreter or roots', async (t) => {
  const root = await fixture(t);
  assert.deepEqual(readConfig(root).python, { interpreter: null, roots: [] });
  assert.equal(readConfig(root).profile, 'full');
  assert.deepEqual(readConfig(root).warnings, []);
});

test('Python config accepts an absolute interpreter and quoted project-local roots without PATH lookup', async (t) => {
  const interpreter = join(tmpdir(), '中文 Python', 'python.exe');
  const root = await fixture(t, `[python]\ninterpreter = ${JSON.stringify(interpreter)}\nroots = ['src', "中文 path", 'a,b', 'src',] # comment\n`);
  const config = readConfig(root);
  assert.equal(config.python.interpreter, interpreter);
  assert.deepEqual(config.python.roots, ['src', '中文 path', 'a,b']);
  assert.deepEqual(config.warnings, []);
});

test('Python config accepts a literal absolute Windows path and TOML unicode escape', async (t) => {
  const interpreter = process.execPath;
  const root = await fixture(t, `[python]\ninterpreter = '${interpreter}'\nroots = ["\\u4e2d\\U00006587", '.']\n`);
  assert.equal(readConfig(root).python.interpreter, interpreter);
  assert.deepEqual(readConfig(root).python.roots, ['中文', '.']);
  assert.deepEqual(readConfig(root).warnings, []);
});

test('Python config rejects bare, relative, malformed and control-character interpreter paths', async (t) => {
  const root = await fixture(t, '[python]\n');
  for (const raw of ['"python"', '"python3"', '"py"', '"pytest"', '".venv/bin/python"', '[]', '""', '"\\u0000"', '"\\U00110000"']) {
    await writeFile(join(root, '.ano', 'config.toml'), `[python]\ninterpreter = ${raw}\n`);
    const config = readConfig(root);
    assert.equal(config.python.interpreter, null, raw);
    assert.match(config.warnings.join('\n'), /python\.interpreter must be an absolute path/u);
  }
});

test('Python roots reject traversal, malformed arrays and unknown Python keys with warnings', async (t) => {
  const root = await fixture(t, '[python]\n');
  for (const raw of ['["../outside"]', '["src", "../../outside"]', '["src", 1]', '["src" "other"]', '[,]', '"src"', '["\\u0000"]', '[""]']) {
    await writeFile(join(root, '.ano', 'config.toml'), `[python]\nroots = ${raw}\n`);
    assert.deepEqual(readConfig(root).python.roots, [], raw);
    assert.match(readConfig(root).warnings.join('\n'), /python\.roots must be a string array of project-local paths/u, raw);
  }
  await writeFile(join(root, '.ano', 'config.toml'), '[python]\nroots = []\nplugins = true\n');
  assert.deepEqual(readConfig(root).python.roots, []);
  assert.equal(readConfig(root).warnings.length, 1);
  assert.match(readConfig(root).warnings[0] ?? '', /unknown key python\.plugins/u);
});

test('Invalid duplicate Python keys clear previously valid values instead of silently trusting them', async (t) => {
  const root = await fixture(t, `[python]\ninterpreter = ${JSON.stringify(process.execPath)}\ninterpreter = 'python'\nroots = ['src']\nroots = ['../outside']\n`);
  assert.deepEqual(readConfig(root).python, { interpreter: null, roots: [] });
  assert.equal(readConfig(root).warnings.length, 2);
});
