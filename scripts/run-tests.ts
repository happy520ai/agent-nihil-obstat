import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));

async function run(argv: string[], label: string): Promise<void> {
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, argv, { shell: false, stdio: 'inherit', cwd: root });
    child.once('error', reject);
    child.once('exit', (exitCode, signal) => resolve(exitCode ?? (signal ? 1 : 0)));
  });
  if (code !== 0) throw new Error(`${label} exited ${code}: ${argv.join(' ')}`);
}

// Core suite: cap cross-file concurrency so protocol/process timing tests do not
// starve one another on loaded Windows hosts. Every test still runs; callers can
// raise this explicitly with ANO_TEST_CONCURRENCY when the host has capacity.
const testConcurrency = process.env.ANO_TEST_CONCURRENCY ?? '4';
await run(['--test', `--test-concurrency=${testConcurrency}`, '--experimental-test-coverage', 'test/**/*.test.ts'], 'core tests');

// Spike mechanism tests need the isolated scripts/node_modules toolchain.
// Install the isolated scripts toolchain locally and in CI. Tests are skipped
// explicitly (not silently passed) when that toolchain is absent; the skip is visible.
const spikeDir = join(root, 'scripts', 'spikes');
const spikeToolchain = join(root, 'scripts', 'node_modules', 'web-tree-sitter');
const spikeTests = (await readdir(spikeDir)).filter((file) => file.endsWith('.test.mjs')).map((file) => `scripts/spikes/${file}`);
if (spikeTests.length > 0) {
  if (existsSync(spikeToolchain)) {
    await run(['--test', ...spikeTests], 'spike tests');
  } else {
    console.log(`SKIP spike tests: scripts/node_modules is not installed (${spikeTests.length} files). Run "npm --prefix scripts ci" to enable.`);
  }
}

await run(['scripts/check-docs.ts'], 'docs check');
