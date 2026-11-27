import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AuditFinding, AuditSeverity } from './types.ts';
import { makeFinding, sha256, sortFindings } from './util.ts';

export type LicenseClass = 'permissive' | 'weak-copyleft' | 'strong-copyleft' | 'unknown' | 'proprietary';
export interface ClassifiedLicense { expression: string; licenseClass: LicenseClass }

const PERMISSIVE = new Set([
  'mit', 'mit-0', 'isc', 'bsd-2-clause', 'bsd-3-clause', 'bsd-2-clause-views', '0bsd', 'apache-2.0', 'cc0-1.0',
  'unlicense', 'zlib', 'python-2.0', 'blueoak-1.0.0', 'bsl-1.0', 'wtfpl', 'cc-by-4.0', 'cc-by-3.0', 'public-domain',
]);
const WEAK = new Set(['mpl-2.0', 'epl-1.0', 'epl-2.0', 'cddl-1.0', 'cddl-1.1', 'artistic-2.0', 'cpl-1.0', 'ipa', 'ms-pl']);
const STRONG = new Set([
  'gpl-2.0', 'gpl-2.0-only', 'gpl-2.0-or-later', 'gpl-3.0', 'gpl-3.0-only', 'gpl-3.0-or-later',
  'agpl-3.0', 'agpl-3.0-only', 'agpl-3.0-or-later', 'sspl-1.0', 'osl-3.0', 'eupl-1.1', 'eupl-1.2',
  'cc-by-sa-4.0', 'cc-by-sa-3.0', 'odbl-1.0',
]);
const PROPRIETARY = new Set(['unlicensed', 'licenseref-proprietary', 'proprietary', 'commercial', 'none']);

const RANK: Record<LicenseClass, number> = { permissive: 0, 'weak-copyleft': 1, 'strong-copyleft': 2, unknown: 3, proprietary: 3 };
const BY_RANK: LicenseClass[] = ['permissive', 'weak-copyleft', 'strong-copyleft', 'unknown'];

function classifyAtom(raw: string): LicenseClass {
  const id = raw.trim().toLowerCase().replace(/\+$/, '').replace(/\s+/g, '-');
  if (!id) return 'unknown';
  if (PERMISSIVE.has(id)) return 'permissive';
  if (WEAK.has(id) || id.startsWith('lgpl-') || id.startsWith('mpl-') || id.startsWith('epl-') || id.startsWith('cddl-')) return 'weak-copyleft';
  if (STRONG.has(id) || id.startsWith('gpl-') || id.startsWith('agpl-') || id.startsWith('cc-by-sa-') || id.startsWith('sspl-')) return 'strong-copyleft';
  if (PROPRIETARY.has(id) || id.startsWith('licenseref-proprietary') || id.startsWith('see-license-in')) return 'proprietary';
  return 'unknown';
}

interface Tokens { values: string[]; index: number }

function parseAtom(tokens: Tokens): LicenseClass {
  const token = tokens.values[tokens.index++];
  if (token === undefined) return 'unknown';
  if (token === '(') {
    const value = parseOr(tokens);
    if (tokens.values[tokens.index] === ')') tokens.index += 1;
    return value;
  }
  if (token === 'WITH') {
    // A malformed exception without a base license is not a license.
    return 'unknown';
  }
  const base = classifyAtom(token);
  if (tokens.values[tokens.index] === 'WITH') {
    tokens.index += 1;
    tokens.index += 1; // exception id; the exception never relaxes the base obligation here
  }
  return base;
}

function parseAnd(tokens: Tokens): LicenseClass {
  let value = parseAtom(tokens);
  while (tokens.values[tokens.index] === 'AND') {
    tokens.index += 1;
    const next = parseAtom(tokens);
    value = BY_RANK[Math.max(RANK[value], RANK[next])]!;
  }
  return value;
}

function parseOr(tokens: Tokens): LicenseClass {
  let value = parseAnd(tokens);
  while (tokens.values[tokens.index] === 'OR') {
    tokens.index += 1;
    const next = parseAnd(tokens);
    value = BY_RANK[Math.min(RANK[value], RANK[next])]!;
  }
  return value;
}

/** Classifies an SPDX expression (OR chooses the easiest option, AND requires the strongest). */
export function classifySpdx(expression: string): LicenseClass {
  const tokens = expression
    .replace(/([()])/g, ' $1 ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return 'unknown';
  const state: Tokens = { values: tokens, index: 0 };
  const result = parseOr(state);
  return state.index >= tokens.length ? result : 'unknown';
}

function licenseText(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const type = (value as { type?: unknown }).type;
    if (typeof type === 'string' && type.trim()) return type.trim();
  }
  return undefined;
}

interface PackageLicense { name: string; version: string; license?: string; hasInstallScript?: boolean }

function collectV1(dependencies: Record<string, unknown>, into: PackageLicense[]): void {
  for (const [name, raw] of Object.entries(dependencies)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    const license = licenseText(entry.license);
    into.push({ name, version: typeof entry.version === 'string' ? entry.version : 'unknown', ...(license ? { license } : {}) });
    const nested = entry.dependencies;
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) collectV1(nested as Record<string, unknown>, into);
  }
}

interface LockScan { packages: PackageLicense[]; rootLicense?: string; degraded: string[] }

async function scanLock(root: string, lock: Record<string, unknown>): Promise<LockScan> {
  const packages: PackageLicense[] = [];
  const degraded: string[] = [];
  const lockPackages = lock.packages;
  if (lockPackages && typeof lockPackages === 'object' && !Array.isArray(lockPackages)) {
    for (const [path, raw] of Object.entries(lockPackages as Record<string, unknown>)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const entry = raw as Record<string, unknown>;
      if (path === '') continue;
      const name = typeof entry.name === 'string'
        ? entry.name
        : path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
      if (!name) continue;
      const license = licenseText(entry.license);
      packages.push({
        name,
        version: typeof entry.version === 'string' ? entry.version : 'unknown',
        ...(license ? { license } : {}),
        ...(entry.hasInstallScript === true ? { hasInstallScript: true } : {}),
      });
    }
  } else if (lock.dependencies && typeof lock.dependencies === 'object' && !Array.isArray(lock.dependencies)) {
    collectV1(lock.dependencies as Record<string, unknown>, packages);
  } else {
    degraded.push('lockfile-has-no-packages');
  }

  // Fall back to installed metadata only for packages the lockfile did not annotate.
  for (const pkg of packages) {
    if (pkg.license) continue;
    try {
      const manifest = JSON.parse(await readFile(join(root, 'node_modules', ...pkg.name.split('/'), 'package.json'), 'utf8')) as { license?: unknown };
      const license = licenseText(manifest.license);
      if (license) pkg.license = license;
    } catch { /* absence is expected in a clean checkout */ }
  }

  const rootManifest = lockPackages && typeof lockPackages === 'object' && !Array.isArray(lockPackages)
    ? (lockPackages as Record<string, unknown>)['']
    : undefined;
  const rootLicense = rootManifest && typeof rootManifest === 'object' && !Array.isArray(rootManifest)
    ? licenseText((rootManifest as Record<string, unknown>).license)
    : undefined;
  return { packages, ...(rootLicense ? { rootLicense } : {}), degraded };
}

export interface LicenseScanResult {
  findings: AuditFinding[];
  packages: number;
  projectLicense?: string;
  degraded: string[];
}

function severityFor(licenseClass: LicenseClass, projectClass: LicenseClass | undefined): AuditSeverity | undefined {
  switch (licenseClass) {
    case 'strong-copyleft': return projectClass === 'strong-copyleft' ? 'low' : 'high';
    case 'weak-copyleft': return 'medium';
    case 'proprietary': return 'medium';
    case 'unknown': return 'medium';
    default: return undefined;
  }
}

/** Local SPDX classification over package-lock / installed package metadata. */
export async function scanLicenses(root: string): Promise<LicenseScanResult> {
  const degraded: string[] = [];
  let manifest: Record<string, unknown> = {};
  try { manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as Record<string, unknown>; }
  catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'UNKNOWN';
    degraded.push(`package-json-unreadable:${code}`);
  }
  let projectLicense = licenseText(manifest.license);
  let packages: PackageLicense[] = [];
  try {
    const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8')) as Record<string, unknown>;
    const scanned = await scanLock(root, lock);
    packages = scanned.packages;
    degraded.push(...scanned.degraded);
    if (!projectLicense && scanned.rootLicense) projectLicense = scanned.rootLicense;
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'UNKNOWN';
    degraded.push(code === 'ENOENT' ? 'lockfile-missing' : `lockfile-unreadable:${code}`);
  }
  const projectClass = projectLicense ? classifySpdx(projectLicense) : undefined;

  const findings: AuditFinding[] = [];
  if (!projectLicense) {
    findings.push(makeFinding({
      scope: 'license',
      rule: 'license/project-missing',
      severity: 'medium',
      message: 'Project package.json does not declare a license',
      fingerprint: sha256('project-license:missing'),
      path: 'package.json',
    }));
  } else {
    if (projectClass === 'unknown' || projectClass === 'proprietary') {
      findings.push(makeFinding({
        scope: 'license',
        rule: 'license/project-unclassified',
        severity: 'low',
        message: `Project license could not be classified: ${projectLicense.slice(0, 80)}`,
        fingerprint: sha256(`project-license:${projectLicense}`),
        path: 'package.json',
      }));
    }
  }

  const seen = new Set<string>();
  for (const pkg of packages) {
    const key = `${pkg.name}@${pkg.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!pkg.license) {
      findings.push(makeFinding({
        scope: 'license',
        rule: 'license/dependency-missing',
        severity: 'medium',
        message: `Dependency ${key} has no license metadata`,
        fingerprint: sha256(`missing:${key}`),
        path: 'package-lock.json',
      }));
      continue;
    }
    const licenseClass = classifySpdx(pkg.license);
    const severity = severityFor(licenseClass, projectClass);
    if (!severity) continue;
    findings.push(makeFinding({
      scope: 'license',
      rule: `license/${licenseClass}`,
      severity,
      message: `Dependency ${key} is ${licenseClass} (${pkg.license.slice(0, 120)})`,
      fingerprint: sha256(`${licenseClass}:${key}:${pkg.license}`),
      path: 'package-lock.json',
    }));
  }
  return {
    findings: sortFindings(findings),
    packages: packages.length,
    ...(projectLicense ? { projectLicense } : {}),
    degraded: [...new Set(degraded)].sort(),
  };
}

export const licenseClasses: readonly LicenseClass[] = ['permissive', 'weak-copyleft', 'strong-copyleft', 'unknown', 'proprietary'];
