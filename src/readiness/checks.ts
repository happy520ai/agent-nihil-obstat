import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { fingerprintTree } from '../core/fingerprint.ts';
import { sha256Text } from './hash.ts';
import type { EvidenceKind, EvidenceRecord, Requirement } from './types.ts';

const execFileAsync = promisify(execFile);

const excludedParts = new Set(['.git', '.ano', '.pm', 'node_modules', 'coverage']);
const metadataFiles = /^(?:package\.json|README(?:\.[A-Za-z0-9]+)?|LICENSE(?:\.[A-Za-z0-9]+)?|CHANGELOG(?:\.[A-Za-z0-9]+)?|SECURITY(?:\.[A-Za-z0-9]+)?)$/;
const semverPattern = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

const artifactExclude = (path: string): boolean => path.split('/').some((part) => excludedParts.has(part));

interface CheckContext {
  root: string;
  artifactRoot: string;
  now: Date;
  requirement: Requirement;
}

interface CheckOutcome {
  pass: boolean;
  summary: string;
  raw: string;
}

class SkipCheck extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkipCheck';
  }
}

export interface ReadinessCheckRun {
  requirementId: string;
  check: string;
  kind: EvidenceKind;
  pass: boolean;
  summary: string;
  raw: string;
  freshnessDays: number;
}

export interface ReadinessCheckSkip {
  requirementId: string;
  check: string;
  reason: string;
}

export interface ReadinessCheckResult {
  artifactHash: string;
  sourceFingerprint: string;
  runs: ReadinessCheckRun[];
  skipped: ReadinessCheckSkip[];
}

async function listFiles(root: string, directory = root): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => Buffer.from(a.name).compare(Buffer.from(b.name)));
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = join(directory, entry.name);
    const path = relative(root, absolute).split(sep).join('/');
    if (path.split('/').some((part) => excludedParts.has(part))) continue;
    if (entry.isSymbolicLink()) throw new Error(`Symlink is not allowed in readiness checks: ${path}`);
    if (entry.isDirectory()) {
      files.push(...await listFiles(root, absolute));
      continue;
    }
    if (!entry.isFile()) throw new Error(`Non-regular file in readiness checks: ${path}`);
    files.push(path);
  }
  return files;
}

async function lstatOrNull(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function readText(path: string, maxBytes = 2 * 1024 * 1024): Promise<string> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Expected a regular file: ${path}`);
  if (info.size > maxBytes) throw new Error(`File is too large to scan (${info.size} bytes): ${path}`);
  const bytes = await readFile(path);
  if (bytes.subarray(0, Math.min(bytes.length, 1024)).includes(0)) return '';
  return bytes.toString('utf8');
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readText(path, 1024 * 1024)) as unknown;
}

async function optionalJson(root: string, path: string): Promise<unknown | null> {
  const absolute = join(root, ...path.split('/'));
  const info = await lstatOrNull(absolute);
  if (info === null) return null;
  return readJson(absolute);
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be a JSON object.`);
  return value as Record<string, unknown>;
}

const secretRules: { name: string; pattern: RegExp }[] = [
  { name: 'aws-access-key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'private-key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  { name: 'github-token', pattern: /\bghp_[A-Za-z0-9]{36}\b/ },
  { name: 'stripe-live-key', pattern: /\bsk_live_[A-Za-z0-9]{16,}\b/ },
  { name: 'slack-token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
];

function scanTextForSecrets(text: string, path: string): string[] {
  if (text.length === 0) return [];
  const findings: string[] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    for (const rule of secretRules) {
      if (rule.pattern.test(line)) findings.push(`${rule.name} ${path}:${index + 1}`);
    }
    if (findings.length >= 20) return findings;
  }
  return findings;
}

async function scanGitHistory(root: string): Promise<string[]> {
  const gitDirectory = join(root, '.git');
  if (await lstatOrNull(gitDirectory) === null) {
    throw new Error('Not a git repository; git history could not be scanned.');
  }
  let output: string;
  try {
    const result = await execFileAsync('git', ['-C', root, 'log', '-p', '--all', '--no-color', '--no-ext-diff'], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    output = result.stdout;
  } catch (error) {
    throw new Error(`git history scan failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const findings: string[] = [];
  let currentPath = '<history>';
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('+++ b/')) {
      currentPath = line.slice(6);
      continue;
    }
    if (line.startsWith('+++ ') || line.startsWith('--- ') || line.startsWith('diff --git')) continue;
    for (const rule of secretRules) {
      if (rule.pattern.test(line)) findings.push(`${rule.name} ${currentPath}`);
    }
    if (findings.length >= 20) return findings;
  }
  return findings;
}

async function commonNoSecrets(context: CheckContext): Promise<CheckOutcome> {
  const files = await listFiles(context.artifactRoot);
  const findings: string[] = [];
  let scanned = 0;
  for (const path of files) {
    const text = await readText(join(context.artifactRoot, ...path.split('/')));
    if (text.length === 0) continue;
    scanned += 1;
    findings.push(...scanTextForSecrets(text, path));
    if (findings.length >= 20) break;
  }
  const historyFindings = await scanGitHistory(context.root);
  findings.push(...historyFindings.map((finding) => `history ${finding}`));
  const pass = findings.length === 0;
  const raw = `secret_scan artifacts=${scanned} files=${files.length} history=scanned findings=${findings.length}\n${findings.join('\n')}`;
  return {
    pass,
    summary: pass ? `No secret patterns in ${scanned} artifact file(s) or git history.` : `Secret patterns found: ${findings.length}.`,
    raw,
  };
}

async function commonLimitationsPublic(context: CheckContext): Promise<CheckOutcome> {
  const limitationsPath = join(context.root, 'docs', 'limitations.md');
  const info = await lstatOrNull(limitationsPath);
  const exists = info !== null && info.isFile() && info.size > 0;
  let referenced = false;
  for (const candidate of [join(context.root, 'README.md'), join(context.artifactRoot, 'README.md')]) {
    const readme = await lstatOrNull(candidate);
    if (readme === null || !readme.isFile()) continue;
    const text = (await readText(candidate)).toLowerCase();
    if (text.includes('limitations')) referenced = true;
  }
  const pass = exists && referenced;
  return {
    pass,
    summary: pass ? 'docs/limitations.md exists and is referenced.' : 'limitations document is missing, empty, or unreferenced.',
    raw: `limitations exists=${exists} referenced=${referenced}`,
  };
}

async function commonVersionChangelogDocs(context: CheckContext): Promise<CheckOutcome> {
  const pkg = await optionalJson(context.artifactRoot, 'package.json');
  if (pkg === null) throw new SkipCheck('package.json is absent from the artifact.');
  const packageJson = objectValue(pkg, 'package.json');
  const version = packageJson.version;
  if (typeof version !== 'string' || !semverPattern.test(version)) {
    return { pass: false, summary: 'package.json has no valid semantic version.', raw: 'version=missing' };
  }
  let changelog = '';
  for (const candidate of [join(context.root, 'CHANGELOG.md'), join(context.artifactRoot, 'CHANGELOG.md')]) {
    const info = await lstatOrNull(candidate);
    if (info !== null && info.isFile()) {
      changelog = await readText(candidate);
      break;
    }
  }
  const changelogMatches = changelog.length > 0 && changelog.includes(version);
  const pass = changelogMatches;
  return {
    pass,
    summary: pass ? `Version ${version} appears in CHANGELOG.md.` : `Version ${version} does not appear in CHANGELOG.md.`,
    raw: `version=${version} changelog=${changelogMatches}`,
  };
}

function fileAllowed(path: string, allowlist: string[]): boolean {
  return allowlist.some((entry) => {
    const normalized = entry.replace(/^\.\//, '').replace(/\/+$/, '');
    return path === normalized || path.startsWith(`${normalized}/`);
  });
}

async function tarballAllowlist(context: CheckContext): Promise<CheckOutcome> {
  const pkg = await optionalJson(context.artifactRoot, 'package.json');
  if (pkg === null) throw new SkipCheck('package.json is absent from the artifact.');
  const packageJson = objectValue(pkg, 'package.json');
  const files = packageJson.files;
  if (!Array.isArray(files) || files.length === 0 || files.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
    return { pass: false, summary: 'package.json does not declare a non-empty files allowlist.', raw: 'files=missing' };
  }
  const allowlist = files as string[];
  const artifactFiles = await listFiles(context.artifactRoot);
  const violations: string[] = [];
  for (const path of artifactFiles) {
    if (path.split('/').length === 1 && metadataFiles.test(path)) continue;
    if (/(^|\/)\.env(?:\.|$)/.test(path)) {
      violations.push(`prohibited .env file: ${path}`);
      continue;
    }
    if (/\.map$/.test(path)) {
      violations.push(`prohibited source map: ${path}`);
      continue;
    }
    if (path.startsWith('test/') || path.startsWith('node_modules/')) {
      violations.push(`prohibited directory content: ${path}`);
      continue;
    }
    if (!fileAllowed(path, allowlist)) violations.push(`not in files allowlist: ${path}`);
  }
  if (artifactFiles.length === 0) violations.push('artifact is empty');
  const pass = violations.length === 0;
  return {
    pass,
    summary: pass ? `Artifact contents match the ${allowlist.length}-entry allowlist.` : `Tarball allowlist violations: ${violations.length}.`,
    raw: `allowlist=${allowlist.join(',')} files=${artifactFiles.join(',')} violations=${violations.join(';')}`,
  };
}

async function typesExports(context: CheckContext): Promise<CheckOutcome> {
  const pkg = await optionalJson(context.artifactRoot, 'package.json');
  if (pkg === null) throw new SkipCheck('package.json is absent from the artifact.');
  const packageJson = objectValue(pkg, 'package.json');
  const targets: string[] = [];
  if (typeof packageJson.types === 'string') targets.push(packageJson.types);
  if (typeof packageJson.typings === 'string') targets.push(packageJson.typings);
  const exportsValue = packageJson.exports;
  if (typeof exportsValue === 'object' && exportsValue !== null && !Array.isArray(exportsValue)) {
    const rootExport = (exportsValue as Record<string, unknown>)['.'];
    if (typeof rootExport === 'object' && rootExport !== null && !Array.isArray(rootExport)) {
      const record = rootExport as Record<string, unknown>;
      if (typeof record.types === 'string') targets.push(record.types);
      if (typeof record.import === 'object' && record.import !== null && !Array.isArray(record.import)) {
        const importTypes = (record.import as Record<string, unknown>).types;
        if (typeof importTypes === 'string') targets.push(importTypes);
      }
    }
  }
  const uniqueTargets = [...new Set(targets.map((target) => target.replace(/^\.\//, '')))];
  if (uniqueTargets.length === 0) {
    return { pass: false, summary: 'package.json declares no type declarations.', raw: 'types=missing' };
  }
  const missing: string[] = [];
  for (const target of uniqueTargets) {
    const info = await lstatOrNull(join(context.artifactRoot, ...target.split('/')));
    if (info === null || !info.isFile()) missing.push(target);
  }
  const pass = missing.length === 0;
  return {
    pass,
    summary: pass ? `Type declarations exist for ${uniqueTargets.length} target(s).` : `Missing type declarations: ${missing.join(', ')}.`,
    raw: `types=${uniqueTargets.join(',')} missing=${missing.join(',')}`,
  };
}

async function apiDiff(context: CheckContext): Promise<CheckOutcome> {
  const current = await optionalJson(context.root, 'api/current.json');
  const baseline = await optionalJson(context.root, 'api/baseline.json');
  if (current === null || baseline === null) throw new SkipCheck('api/current.json or api/baseline.json is absent.');
  const currentRecord = objectValue(current, 'api/current.json');
  const baselineRecord = objectValue(baseline, 'api/baseline.json');
  if (!Array.isArray(currentRecord.exports) || !Array.isArray(baselineRecord.exports)) {
    return { pass: false, summary: 'API snapshots must declare an exports array.', raw: 'api_snapshot=invalid' };
  }
  const toMap = (entries: unknown[]): Map<string, string> => {
    const map = new Map<string, string>();
    for (const entry of entries) {
      const item = objectValue(entry, 'api export');
      if (typeof item.name !== 'string' || typeof item.kind !== 'string') throw new Error('API export entries need name and kind.');
      map.set(item.name, item.kind);
    }
    return map;
  };
  const currentMap = toMap(currentRecord.exports);
  const baselineMap = toMap(baselineRecord.exports);
  const removed = [...baselineMap.keys()].filter((name) => !currentMap.has(name));
  const changed = [...baselineMap.entries()].filter(([name, kind]) => currentMap.has(name) && currentMap.get(name) !== kind).map(([name]) => name);
  const added = [...currentMap.keys()].filter((name) => !baselineMap.has(name));
  const breaking = [...removed, ...changed];
  let pass = true;
  let versionNote = 'version=unknown';
  if (breaking.length > 0) {
    const baselineVersion = typeof baselineRecord.version === 'string' ? baselineRecord.version : null;
    const pkg = await optionalJson(context.artifactRoot, 'package.json');
    const currentVersion = pkg === null ? null : (objectValue(pkg, 'package.json').version as unknown);
    if (typeof currentVersion !== 'string' || baselineVersion === null) {
      pass = false;
      versionNote = 'version=missing';
    } else {
      const currentMajor = Number(currentVersion.split('.')[0]);
      const baselineMajor = Number(baselineVersion.split('.')[0]);
      pass = Number.isSafeInteger(currentMajor) && Number.isSafeInteger(baselineMajor) && currentMajor > baselineMajor;
      versionNote = `version=${baselineVersion}->${currentVersion}`;
    }
  }
  return {
    pass,
    summary: pass ? `API diff is compatible (${breaking.length} breaking, ${added.length} added).` : `Breaking API changes without a major version bump (${breaking.length}).`,
    raw: `removed=${removed.join(',')} changed=${changed.join(',')} added=${added.join(',')} ${versionNote}`,
  };
}

async function serviceConfig(context: CheckContext): Promise<Record<string, unknown>> {
  const config = await optionalJson(context.root, 'deploy/service.json');
  if (config === null) throw new SkipCheck('deploy/service.json is absent.');
  return objectValue(config, 'deploy/service.json');
}

async function healthEndpoints(context: CheckContext): Promise<CheckOutcome> {
  const config = await serviceConfig(context);
  const health = config.health;
  const ready = config.ready;
  const valid = (value: unknown): boolean => typeof value === 'string' && value.length > 0 && (value.startsWith('/') || /^https?:\/\//.test(value));
  const pass = valid(health) && valid(ready);
  return {
    pass,
    summary: pass ? 'Health and readiness endpoints are declared.' : 'Health or readiness endpoint is missing.',
    raw: `health=${String(health)} ready=${String(ready)}`,
  };
}

async function resilienceConfig(context: CheckContext): Promise<CheckOutcome> {
  const config = await serviceConfig(context);
  const positive = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value) && value > 0;
  const timeouts = config.timeouts;
  const rateLimit = config.rateLimit;
  const circuitBreaker = config.circuitBreaker;
  const timeoutOk = typeof timeouts === 'object' && timeouts !== null && !Array.isArray(timeouts) && positive((timeouts as Record<string, unknown>).requestMs);
  const rateOk = typeof rateLimit === 'object' && rateLimit !== null && !Array.isArray(rateLimit) && positive((rateLimit as Record<string, unknown>).rps);
  const breakerOk = typeof circuitBreaker === 'object' && circuitBreaker !== null && !Array.isArray(circuitBreaker) && positive((circuitBreaker as Record<string, unknown>).failures);
  const pass = timeoutOk && rateOk && breakerOk;
  return {
    pass,
    summary: pass ? 'Timeouts, rate limiting and circuit breaking are configured.' : 'Resilience configuration is incomplete.',
    raw: `timeout=${timeoutOk} rateLimit=${rateOk} circuitBreaker=${breakerOk}`,
  };
}

async function secretsManaged(context: CheckContext): Promise<CheckOutcome> {
  const config = await serviceConfig(context);
  const env = config.env;
  if (typeof env !== 'object' || env === null || Array.isArray(env)) {
    return { pass: false, summary: 'Service config has no env map.', raw: 'env=missing' };
  }
  const violations: string[] = [];
  for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
    if (typeof value !== 'string') {
      violations.push(`${key}: non-string`);
      continue;
    }
    const managed = /^(?:secretRef:|vault:|\$\{|arn:aws:secretsmanager:)/.test(value);
    if (!managed) violations.push(`${key}: literal value`);
  }
  const pass = violations.length === 0;
  return {
    pass,
    summary: pass ? 'All service secrets reference a managed source.' : `Unmanaged secret values: ${violations.length}.`,
    raw: `env_keys=${Object.keys(env as Record<string, unknown>).join(',')} violations=${violations.join(';')}`,
  };
}

const checks: Record<string, (context: CheckContext) => Promise<CheckOutcome>> = {
  'common.no-secrets': commonNoSecrets,
  'common.limitations-public': commonLimitationsPublic,
  'common.version-changelog-docs': commonVersionChangelogDocs,
  'a.tarball-allowlist': tarballAllowlist,
  'a.types-exports': typesExports,
  'a.public-api-semver': apiDiff,
  'c.health-endpoints': healthEndpoints,
  'c.resilience-config': resilienceConfig,
  'c.secrets-managed': secretsManaged,
};

export interface RunReadinessChecksOptions {
  root: string;
  artifactRoot?: string;
  requirements: Requirement[];
  now?: Date;
}

/** Runs only checks that are implemented locally. Everything else stays missing. */
export async function runReadinessChecks(options: RunReadinessChecksOptions): Promise<ReadinessCheckResult> {
  const root = options.root;
  const artifactRoot = options.artifactRoot ?? root;
  const now = options.now ?? new Date();
  const [artifact, source] = await Promise.all([
    fingerprintTree(artifactRoot, { exclude: artifactExclude }),
    fingerprintTree(root),
  ]);
  const runs: ReadinessCheckRun[] = [];
  const skipped: ReadinessCheckSkip[] = [];
  for (const requirement of [...options.requirements].sort((a, b) => a.id.localeCompare(b.id))) {
    const check = requirement.check;
    if (check === null) continue;
    const run = checks[check];
    if (run === undefined) {
      skipped.push({ requirementId: requirement.id, check, reason: 'No local implementation; external evidence is required.' });
      continue;
    }
    try {
      const outcome = await run({ root, artifactRoot, now, requirement });
      runs.push({
        requirementId: requirement.id,
        check,
        kind: requirement.kinds[0] ?? 'artifact_scan',
        pass: outcome.pass,
        summary: outcome.summary,
        raw: outcome.raw,
        freshnessDays: requirement.freshnessDays,
      });
    } catch (error) {
      if (error instanceof SkipCheck) {
        skipped.push({ requirementId: requirement.id, check, reason: error.message });
        continue;
      }
      runs.push({
        requirementId: requirement.id,
        check,
        kind: requirement.kinds[0] ?? 'artifact_scan',
        pass: false,
        summary: 'Check failed to execute; failing closed.',
        raw: `check_error ${error instanceof Error ? error.message : String(error)}`,
        freshnessDays: requirement.freshnessDays,
      });
    }
  }
  return { artifactHash: artifact.hash, sourceFingerprint: source.hash, runs, skipped };
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100);
}

export interface WrittenCheckEvidence {
  records: EvidenceRecord[];
  files: string[];
}

/**
 * Materializes local checks as file evidence.
 *
 * These records are declarations, not machine evidence: they describe files that
 * happen to be present in the project (for example `deploy/service.json` or
 * `api/current.json`) and the tool's own static analysis of them. The loader
 * classifies the `local_check` origin and the `ano://readiness/checks/` source
 * namespace as `declaration`, so a release verdict can never count them as
 * machine evidence. Raw output is written for hashing, never copied into records.
 */
export async function writeCheckEvidence(
  directory: string,
  result: ReadinessCheckResult,
  now = new Date(),
): Promise<WrittenCheckEvidence> {
  await mkdir(join(directory, 'raw'), { recursive: true });
  const records: EvidenceRecord[] = [];
  const files: string[] = [];
  for (const run of result.runs) {
    const id = `check-${slug(run.requirementId)}`;
    const rawName = `raw/${id}.txt`;
    const rawPath = join(directory, ...rawName.split('/'));
    await writeFile(rawPath, run.raw, 'utf8');
    const record: EvidenceRecord = {
      schema: 1,
      id,
      requirement_id: run.requirementId,
      kind: run.kind,
      source_id: `ano://readiness/checks/${run.check}`,
      origin: 'local_check',
      timestamp: now.toISOString(),
      artifact_hash: result.artifactHash,
      source_fingerprint: result.sourceFingerprint,
      raw_artifact: rawName,
      raw_artifact_hash: sha256Text(run.raw),
      result: run.pass ? 'pass' : 'fail',
      ...(run.freshnessDays > 0 ? { freshness_days: run.freshnessDays } : {}),
    };
    await writeFile(join(directory, `${id}.json`), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    records.push(record);
    files.push(`${id}.json`);
  }
  return { records, files };
}
