import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fingerprintTree } from '../src/core/fingerprint.ts';

interface Check { id: string; command: string[]; optional?: boolean }
const root = fileURLToPath(new URL('../', import.meta.url));
const checks: Check[] = [
  { id: 'typecheck', command: ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json', '--noEmit'] },
  { id: 'test', command: ['scripts/run-tests.ts'] },
  { id: 'build', command: ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'] },
  { id: 'docs', command: ['scripts/check-docs.ts'] },
  { id: 'schema', command: ['scripts/check-schema.ts'] },
  { id: 'p2-concurrency', command: ['scripts/bench-concurrency.ts'] },
  { id: 'p3-graph-bench', command: ['scripts/bench-graph.ts'] },
  { id: 'p1-experiment', command: ['scripts/p1-experiment.ts'] },
  { id: 'package-smoke', command: ['scripts/smoke-packed.ts'] },
];

function execute(command: string[]): Promise<{ code: number; stdout: string; stderr: string; durationMs: number }> {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, command, { cwd: root, shell: false, env: { ...process.env, NODE_TEST_CONTEXT: undefined } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code: code ?? 1, stdout, stderr, durationMs: performance.now() - started }));
  });
}

const before = await fingerprintTree(root);
const results = [];
for (const check of checks) {
  const result = await execute(check.command);
  const passed = result.code === 0;
  results.push({ id: check.id, passed, exitCode: result.code, durationMs: result.durationMs, stderr: passed ? '' : result.stderr.slice(-3000), stdout: passed ? result.stdout.slice(-3000) : result.stdout.slice(-1000) });
  console.log(`${passed ? 'PASS' : 'FAIL'} ${check.id} (${Math.round(result.durationMs)}ms)`);
  if (!passed && !check.optional) break;
}
const after = await fingerprintTree(root);
const evidence = {
  generatedAt: new Date().toISOString(),
  sourceBefore: before.hash,
  sourceAfter: after.hash,
  sourceStable: before.hash === after.hash,
  results,
  verdict: before.hash === after.hash && results.every((result) => result.passed) ? 'passed' : 'failed',
};
await mkdir(join(root, 'docs', 'evidence'), { recursive: true });
await writeFile(join(root, 'docs', 'evidence', 'full-acceptance.json'), JSON.stringify(evidence, null, 2) + '\n');
console.log(`Full acceptance: ${evidence.verdict}; sourceStable=${evidence.sourceStable}`);
if (evidence.verdict !== 'passed') process.exitCode = 1;
