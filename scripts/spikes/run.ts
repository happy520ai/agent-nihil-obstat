import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scripts = {
  S1: 's1-search.mjs',
  S2: 's2-tree-sitter.mjs',
  S3: 's3-hlc.mjs',
  S4: 's4-codegraph.mjs',
  S5: 's5-atomic-append.mjs',
  S6: 's6-segment-merge.mjs',
  S7: 's7-module-resolution.mjs',
} as const;
type Spike = keyof typeof scripts;
const selected = process.argv.slice(2).filter((value) => value !== '--expose-gc') as Spike[];
const unknown = selected.filter((value) => !(value in scripts));
if (unknown.length > 0) throw new Error(`Unknown spikes: ${unknown.join(', ')}`);
const requested = selected.length > 0 ? selected : Object.keys(scripts) as Spike[];
const optionalNetwork = new Set<Spike>(['S4']);
let failed = false;
for (const spike of requested) {
  if (optionalNetwork.has(spike) && process.env.ANO_NETWORK_SPIKES !== '1') {
    console.log(`SKIP ${spike}: network/package installation requires ANO_NETWORK_SPIKES=1`);
    continue;
  }
  const path = fileURLToPath(new URL(scripts[spike], import.meta.url));
  console.log(`RUN ${spike}: ${path}`);
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, ['--expose-gc', path], { stdio: 'inherit', shell: false });
    child.once('error', reject);
    child.once('exit', (exitCode, signal) => resolve(exitCode ?? (signal ? 1 : 0)));
  });
  if (code !== 0) {
    console.error(`FAIL ${spike}: exit ${code}`);
    failed = true;
  }
}
if (failed) process.exitCode = 1;
