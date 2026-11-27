import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toolCatalog } from './tool-catalog.ts';

const PACKAGE_NAME = 'agent-nihil-obstat';
const packageManifestPath = fileURLToPath(new URL('../../package.json', import.meta.url));
const detectedPackageRoot = dirname(packageManifestPath);

export type InstallMode = 'local' | 'npx' | 'source' | 'unknown';

export interface InstallationInfo {
  packageRoot: string;
  packageManifest: string;
  invokedPath?: string;
  mode: InstallMode;
  localDistEntry: string;
  localDistExists: boolean;
  npxCacheEntry?: string;
  npxCacheExists: boolean;
  underNpxCache: boolean;
  execPath: string;
}

export interface InstallationInput {
  invokedPath?: string | undefined;
  execPath?: string | undefined;
  env?: Record<string, string | undefined> | undefined;
  packageRoot?: string | undefined;
}

function normalize(path: string): string {
  return resolve(path).replaceAll('\\', '/').toLowerCase();
}

function findNpxCacheRoot(path: string): string | undefined {
  let current = dirname(resolve(path));
  for (let depth = 0; depth < 12; depth += 1) {
    if (current.split(/[\\/]/).at(-1) === '_npx') return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

function npxPackageEntry(invokedPath: string): string | undefined {
  const npxRoot = findNpxCacheRoot(invokedPath);
  if (!npxRoot) return undefined;
  const expectedSuffix = join('node_modules', PACKAGE_NAME);
  if (invokedPath.replaceAll('\\', '/').includes(expectedSuffix.replaceAll('\\', '/'))) return invokedPath;
  try {
    for (const entry of readdirSync(npxRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = join(npxRoot, entry.name, 'node_modules', PACKAGE_NAME, 'dist', 'surface', 'cli.js');
      if (existsSync(candidate)) return candidate;
    }
  } catch { /* an unreadable npx cache is reported as absent */ }
  return undefined;
}

/**
 * Recognizes both supported installation shapes:
 * - the published npx layout (`.../_npx/<hash>/node_modules/<pkg>/dist/...`);
 * - the local checkout layout (`<packageRoot>/dist/surface/cli.js`).
 * Source execution (`src/surface/cli.ts`) is reported separately, never as a release.
 */
export function detectInstallation(input: InstallationInput = {}): InstallationInfo {
  const env = input.env ?? process.env;
  const packageRoot = resolve(input.packageRoot ?? detectedPackageRoot);
  const invokedPath = input.invokedPath;
  const localDistEntry = join(packageRoot, 'dist', 'surface', 'cli.js');
  const localDistExists = existsSync(localDistEntry);
  const npxCacheEntry = invokedPath ? npxPackageEntry(invokedPath) : undefined;
  const npxRoot = invokedPath ? findNpxCacheRoot(invokedPath) : undefined;
  const npxCacheExists = npxCacheEntry ? existsSync(npxCacheEntry) : false;
  const underNpxCache = Boolean(npxRoot) || /(^|[\\/])_npx([\\/]|$)/.test(invokedPath ?? '') || env.npm_command === 'exec';
  let mode: InstallMode = 'unknown';
  if (invokedPath) {
    const invoked = normalize(invokedPath);
    if (underNpxCache) mode = 'npx';
    else if (localDistExists && invoked === normalize(localDistEntry)) mode = 'local';
    else if (invoked === normalize(join(packageRoot, 'src', 'surface', 'cli.ts'))) mode = 'source';
    else if (invoked.startsWith(normalize(join(packageRoot, 'dist')) + '/')) mode = 'local';
  }
  return {
    packageRoot,
    packageManifest: join(packageRoot, 'package.json'),
    ...(invokedPath ? { invokedPath } : {}),
    mode,
    localDistEntry,
    localDistExists,
    ...(npxCacheEntry ? { npxCacheEntry } : {}),
    npxCacheExists,
    underNpxCache,
    execPath: input.execPath ?? process.execPath,
  };
}

function supportsEngine(actual: string, range: string | undefined): boolean | undefined {
  if (!range) return undefined;
  const match = /^>=\s*(\d+)\.(\d+)(?:\.(\d+))?$/.exec(range.trim());
  if (!match) return undefined;
  const actualParts = actual.replace(/^v/, '').split('.').map(Number);
  const wanted = [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
  for (let index = 0; index < 3; index += 1) {
    if ((actualParts[index] ?? 0) > wanted[index]!) return true;
    if ((actualParts[index] ?? 0) < wanted[index]!) return false;
  }
  return true;
}

export interface DoctorCheck { id: string; status: 'ok' | 'warn' | 'fail'; detail: string }
export interface DoctorReport {
  schema: 'ano.doctor.v1';
  package: { name: string; version: string; engines?: string };
  node: { version: string; supported?: boolean | undefined };
  installation: InstallationInfo;
  checks: DoctorCheck[];
  project: { root: string; packageJson: boolean; gitWorkTree: boolean; anoDirectory: boolean; ledgerSegments: number; graphCache: boolean; auditStore: boolean };
  tools: { count: number; names: string[]; humanOnlyExcluded: true };
  human: { baselineApprove: 'cli-tty-human-only'; releaseApprove: 'not-implemented'; attestation: 'not-implemented'; mcpApproval: false };
  network: { default: 'deny'; confirmRequired: true; onlineScanner: 'injectable' };
  schemaCheck: { checkCommand: string; pinning: '7-tools-and-ledger-events' };
  caveats: string[];
}

export async function doctor(root: string, input: InstallationInput = {}): Promise<DoctorReport> {
  const installation = detectInstallation(input);
  let manifest: { name?: string; version?: string; engines?: { node?: string } } = {};
  try { manifest = JSON.parse(await readFile(join(installation.packageRoot, 'package.json'), 'utf8')); }
  catch { /* the installation check below reports it */ }
  const checks: DoctorCheck[] = [];
  const packageJson = existsSync(join(root, 'package.json'));
  let gitWorkTree = false;
  try {
    gitWorkTree = execFileSync('git', ['-C', root, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim() === 'true';
  } catch { gitWorkTree = false; }
  const anoDirectory = existsSync(join(root, '.ano'));
  let ledgerSegments = 0;
  try { ledgerSegments = readdirSync(join(root, '.ano', 'ledger')).filter((name) => name.endsWith('.jsonl')).length; } catch { ledgerSegments = 0; }
  const graphCache = existsSync(join(root, '.ano', 'cache', 'graph.db'));
  const auditStore = existsSync(join(root, '.ano', 'audit', 'findings.json'));

  checks.push({ id: 'installation.local-dist', status: installation.localDistExists ? 'ok' : 'warn', detail: installation.localDistEntry });
  checks.push({ id: 'installation.npx', status: installation.npxCacheExists ? 'ok' : 'warn', detail: installation.npxCacheEntry ?? 'no npx cache entry detected from the invoked path' });
  checks.push({ id: 'installation.mode', status: installation.mode === 'unknown' ? 'warn' : 'ok', detail: installation.mode });
  checks.push({ id: 'root.exists', status: existsSync(root) ? 'ok' : 'fail', detail: resolve(root) });
  checks.push({
    id: 'root.package-json',
    status: packageJson ? 'ok' : gitWorkTree ? 'warn' : 'fail',
    detail: packageJson ? 'present' : gitWorkTree ? 'not required for a Git project' : 'missing',
  });
  checks.push({ id: 'root.git-work-tree', status: gitWorkTree ? 'ok' : 'fail', detail: gitWorkTree ? 'yes' : 'no' });
  if (manifest.engines?.node) {
    const supported = supportsEngine(process.versions.node, manifest.engines.node);
    checks.push({ id: 'node.engine', status: supported === false ? 'fail' : supported === true ? 'ok' : 'warn', detail: `node ${process.versions.node} vs ${manifest.engines.node}` });
  }
  checks.push({ id: 'surface.tool-count', status: toolCatalog.length === 7 ? 'ok' : 'fail', detail: `${toolCatalog.length} tools` });
  checks.push({ id: 'human.no-mcp-approval', status: 'ok', detail: 'no approve/attest/sync/push tool is exposed' });

  return {
    schema: 'ano.doctor.v1',
    package: {
      name: manifest.name ?? PACKAGE_NAME,
      version: manifest.version ?? 'unknown',
      ...(manifest.engines?.node ? { engines: manifest.engines.node } : {}),
    },
    node: { version: process.versions.node, ...(manifest.engines?.node ? { supported: supportsEngine(process.versions.node, manifest.engines.node) } : {}) },
    installation,
    checks,
    project: { root: resolve(root), packageJson, gitWorkTree, anoDirectory, ledgerSegments, graphCache, auditStore },
    tools: { count: toolCatalog.length, names: toolCatalog.map((tool) => tool.name), humanOnlyExcluded: true },
    human: { baselineApprove: 'cli-tty-human-only', releaseApprove: 'not-implemented', attestation: 'not-implemented', mcpApproval: false },
    network: { default: 'deny', confirmRequired: true, onlineScanner: 'injectable' },
    schemaCheck: { checkCommand: 'node scripts/check-schema.ts', pinning: '7-tools-and-ledger-events' },
    caveats: [
      'doctor only inspects local files; it does not contact the npm registry',
      'npx detection is derived from the invoked path and npm environment, never a network lookup',
      'release approval and attestation remain human CLI work and are not implemented in P7',
    ],
  };
}

export { PACKAGE_NAME };
