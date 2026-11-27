import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AuditFinding } from './types.ts';
import { makeFinding, sha256, sortFindings } from './util.ts';

export interface DependencyPackage { name: string; version: string; license?: string }

export interface DependencyScanResult {
  findings: AuditFinding[];
  declared: number;
  packages: DependencyPackage[];
  degraded: string[];
}

const RANGE = /^(?:\^|~|>=|<=|>|<|=|\|\|)/;
const EXACT = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const NON_REGISTRY = /^(?:git\+|git:|github:|gitlab:|bitbucket:|https?:|file:|link:|portal:)/;

function dependencyGroups(manifest: Record<string, unknown>): Array<{ group: string; dependencies: Record<string, string> }> {
  const groups: Array<{ group: string; dependencies: Record<string, string> }> = [];
  for (const group of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const raw = manifest[group];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const dependencies: Record<string, string> = {};
    for (const [name, spec] of Object.entries(raw as Record<string, unknown>)) if (typeof spec === 'string') dependencies[name] = spec;
    groups.push({ group, dependencies });
  }
  return groups;
}

function lockPackages(lock: Record<string, unknown>): Array<DependencyPackage & { hasInstallScript?: boolean }> {
  const packages: Array<DependencyPackage & { hasInstallScript?: boolean }> = [];
  const entries = lock.packages;
  if (entries && typeof entries === 'object' && !Array.isArray(entries)) {
    for (const [path, raw] of Object.entries(entries as Record<string, unknown>)) {
      if (path === '' || !raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const entry = raw as Record<string, unknown>;
      const name = typeof entry.name === 'string' ? entry.name : path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
      if (!name) continue;
      const license = typeof entry.license === 'string' ? entry.license : undefined;
      packages.push({
        name,
        version: typeof entry.version === 'string' ? entry.version : 'unknown',
        ...(license ? { license } : {}),
        ...(entry.hasInstallScript === true ? { hasInstallScript: true } : {}),
      });
    }
    return packages;
  }
  const walk = (dependencies: Record<string, unknown>): void => {
    for (const [name, raw] of Object.entries(dependencies)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const entry = raw as Record<string, unknown>;
      const license = typeof entry.license === 'string' ? entry.license : undefined;
      packages.push({ name, version: typeof entry.version === 'string' ? entry.version : 'unknown', ...(license ? { license } : {}) });
      if (entry.dependencies && typeof entry.dependencies === 'object' && !Array.isArray(entry.dependencies)) walk(entry.dependencies as Record<string, unknown>);
    }
  };
  if (lock.dependencies && typeof lock.dependencies === 'object' && !Array.isArray(lock.dependencies)) walk(lock.dependencies as Record<string, unknown>);
  return packages;
}

/** Offline dependency manifest/lock audit; no registry or OSV request is made. */
export async function scanDependencies(root: string): Promise<DependencyScanResult> {
  const degraded: string[] = [];
  const findings: AuditFinding[] = [];
  let manifest: Record<string, unknown> = {};
  try { manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as Record<string, unknown>; }
  catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'UNKNOWN';
    return { findings: [], declared: 0, packages: [], degraded: [`package-json-unreadable:${code}`] };
  }

  const groups = dependencyGroups(manifest);
  const declared = groups.reduce((count, group) => count + Object.keys(group.dependencies).length, 0);
  const locked = new Map<string, Set<string>>();
  let hasLock = false;
  try {
    const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8')) as Record<string, unknown>;
    hasLock = true;
    for (const pkg of lockPackages(lock)) {
      const versions = locked.get(pkg.name) ?? new Set<string>();
      versions.add(pkg.version);
      locked.set(pkg.name, versions);
      if (pkg.hasInstallScript) {
        findings.push(makeFinding({
          scope: 'deps',
          rule: 'deps/install-script',
          severity: 'low',
          message: `Dependency ${pkg.name}@${pkg.version} runs an install script`,
          fingerprint: sha256(`install-script:${pkg.name}:${pkg.version}`),
          path: 'package-lock.json',
        }));
      }
    }
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'UNKNOWN';
    degraded.push(code === 'ENOENT' ? 'lockfile-missing' : `lockfile-unreadable:${code}`);
  }
  if (!hasLock) {
    findings.push(makeFinding({
      scope: 'deps',
      rule: 'deps/lockfile-missing',
      severity: 'medium',
      message: 'No package-lock.json; dependency resolution and integrity cannot be reproduced',
      fingerprint: sha256('deps:lockfile-missing'),
      path: 'package.json',
    }));
  }

  for (const { group, dependencies } of groups) {
    for (const [name, spec] of Object.entries(dependencies)) {
      if (spec === '*' || spec === 'latest' || spec === 'next') {
        findings.push(makeFinding({
          scope: 'deps',
          rule: 'deps/moving-tag',
          severity: 'medium',
          message: `${group}.${name} uses a moving tag (${spec})`,
          fingerprint: sha256(`moving:${name}:${spec}`),
          path: 'package.json',
        }));
      } else if (NON_REGISTRY.test(spec)) {
        findings.push(makeFinding({
          scope: 'deps',
          rule: 'deps/non-registry-source',
          severity: 'medium',
          message: `${group}.${name} resolves outside the npm registry (${spec.slice(0, 80)})`,
          fingerprint: sha256(`source:${name}:${spec}`),
          path: 'package.json',
        }));
      } else if (RANGE.test(spec) || !EXACT.test(spec)) {
        if (!spec.startsWith('workspace:')) {
          findings.push(makeFinding({
            scope: 'deps',
            rule: 'deps/unpinned-range',
            severity: 'low',
            message: `${group}.${name} is not pinned to an exact version (${spec.slice(0, 80)})`,
            fingerprint: sha256(`range:${name}:${spec}`),
            path: 'package.json',
          }));
        }
      }
      if (hasLock && !locked.has(name) && group !== 'optionalDependencies') {
        findings.push(makeFinding({
          scope: 'deps',
          rule: 'deps/lock-entry-missing',
          severity: 'medium',
          message: `${group}.${name} is declared but absent from package-lock.json`,
          fingerprint: sha256(`lock-missing:${group}:${name}`),
          path: 'package-lock.json',
        }));
      }
    }
  }

  for (const [name, versions] of locked) {
    if (versions.size < 2) continue;
    findings.push(makeFinding({
      scope: 'deps',
      rule: 'deps/duplicate-version',
      severity: 'info',
      message: `${name} is locked at ${versions.size} versions: ${[...versions].sort().join(', ')}`,
      fingerprint: sha256(`duplicate:${name}:${[...versions].sort().join(',')}`),
      path: 'package-lock.json',
    }));
  }

  return {
    findings: sortFindings(findings),
    declared,
    packages: [...locked.entries()].flatMap(([name, versions]) => [...versions].map((version) => ({ name, version }))),
    degraded: [...new Set(degraded)].sort(),
  };
}
