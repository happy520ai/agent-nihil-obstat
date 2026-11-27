import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const results: { step: string; ok: boolean; detail: string }[] = [];

function step(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, argv, { cwd: root, shell: false });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function record(name: string, argv: string[]): Promise<void> {
  const result = await step(argv);
  results.push({ step: name, ok: result.code === 0, detail: (result.code === 0 ? '' : (result.stderr || result.stdout).slice(-1200)) });
  console.log(`${result.code === 0 ? 'PASS' : 'FAIL'} ${name}`);
}

await record('typecheck', ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json', '--noEmit']);
await record('test', ['scripts/run-tests.ts']);
await record('coverage', ['--test', '--experimental-test-coverage', '--test-coverage-lines=90', '--test-coverage-branches=80', '--test-coverage-include=src/**/*.ts', 'test/**/*.test.ts']);
await record('build', ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json']);
await record('assets', ['scripts/copy-assets.ts']);
await record('schema', ['scripts/check-schema.ts']);
await record('docs', ['scripts/check-docs.ts']);
await record('zcode-mcp', ['scripts/verify-zcode-mcp.ts']);
await record('p1-experiment', ['scripts/p1-experiment.ts']);
await record('package-smoke', ['scripts/smoke-packed.ts']);

for (const [file, key] of [['docs/evidence/p1-experiment.json', 'verdict'], ['docs/evidence/package-smoke.json', 'verdict']] as const) {
  try {
    const data = JSON.parse(await readFile(new URL(`../${file}`, import.meta.url), 'utf8')) as Record<string, unknown>;
    const value = String(data[key]);
    const ok = value === 'passed' || value === 'synthetic-pass-real-project-measured';
    results.push({ step: `evidence:${file}`, ok, detail: value });
    console.log(`${ok ? 'PASS' : 'FAIL'} evidence:${file} -> ${value}`);
  } catch (error) {
    results.push({ step: `evidence:${file}`, ok: false, detail: String(error) });
    console.log(`FAIL evidence:${file} (${String(error)})`);
  }
}

const failed = results.filter((item) => !item.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.error(JSON.stringify(failed, null, 2));
  process.exitCode = 1;
}
