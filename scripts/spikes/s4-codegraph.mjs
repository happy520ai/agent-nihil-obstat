// S4 probe: exercise only the API documented in codegraph README "Library Usage".
// Usage: node scripts/spikes/s4-codegraph.mjs <installRoot> <projectPath> [outFile]
// The install root is an isolated temp dir; this script never imports project source.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [pkgRoot, project, outFile] = process.argv.slice(2);
if (!pkgRoot || !project) { console.error('usage: s4-codegraph.mjs <installRoot> <projectPath> [outFile]'); process.exit(2); }
const entry = path.join(pkgRoot, 'node_modules', '@colbymchenry', 'codegraph', 'npm-sdk.js');
const mod = await import(pathToFileURL(entry).href);
const ns = mod.default;
const CodeGraph = [mod.CodeGraph, ns?.CodeGraph, ns, ns?.default].find((x) => typeof x === 'function');
const result = { node: process.version, entry, cwd: process.cwd(), project, moduleExports: Object.keys(mod), moduleShape: { defaultType: typeof ns, defaultKeys: ns && typeof ns === 'object' ? Object.keys(ns) : null }, steps: [], progress: [] };
const cut = (v) => { const seen = new WeakSet(); return JSON.parse(JSON.stringify(v, (k, x) => { if (typeof x === 'function') return `[function ${x.name || 'anonymous'}]`; if (typeof x === 'bigint') return `${x}n`; if (typeof x === 'object' && x) { if (seen.has(x)) return '[circular]'; seen.add(x); } if (typeof x === 'string' && x.length > 300) return `${x.slice(0, 300)}…`; if (Array.isArray(x) && x.length > 8) return x.slice(0, 8); return x; })); };
async function run(name, fn) {
  const t = process.hrtime.bigint();
  try {
    const value = await fn();
    result.steps.push({ name, ok: true, ms: +(Number(process.hrtime.bigint() - t) / 1e6).toFixed(1), value: cut(value) });
    return value;
  } catch (e) {
    result.steps.push({ name, ok: false, ms: +(Number(process.hrtime.bigint() - t) / 1e6).toFixed(1), error: `${e.name}: ${e.message}`, stack: String(e.stack || '').split('\n').slice(0, 4) });
    return undefined;
  }
}
if (typeof CodeGraph !== 'function') { result.fatal = `default export is ${typeof CodeGraph}, not a constructor`; }
else {
  const cg = await run('CodeGraph.init', () => CodeGraph.init(project)) ?? await run('CodeGraph.open', () => CodeGraph.open(project));
  if (cg) {
    await run('indexAll', () => cg.indexAll({ onProgress: (p) => result.progress.push(cut(p)) }));
    const hits = await run('searchNodes', () => cg.searchNodes('UserService'));
    const id = hits?.[0] ? (hits[0].node?.id ?? hits[0].id) : null;
    if (id) {
      await run('getCallers', () => cg.getCallers(id));
      await run('getImpactRadius', () => cg.getImpactRadius(id, 2));
    } else result.steps.push({ name: 'getCallers', ok: false, error: 'searchNodes returned no hit' });
    await run('buildContext', () => cg.buildContext('fix login bug', { maxNodes: 20, includeCode: true, format: 'markdown' }));
    await run('watch', () => { cg.watch(); return 'watching'; });
    await run('unwatch', () => { cg.unwatch(); return 'unwatched'; });
    await run('close', () => { cg.close(); return 'closed'; });
  }
}
const json = JSON.stringify(result, null, 2);
if (outFile) fs.writeFileSync(outFile, json, 'utf8');
console.log(json);
