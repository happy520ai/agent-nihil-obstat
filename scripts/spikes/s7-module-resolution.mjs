#!/usr/bin/env node
// S7: compare module-resolution routes on a synthetic monorepo fixture.
//
// Route 1: self-written lightweight resolver (relative, tsconfig paths,
//          package exports, workspaces discovery).
// Route 2: project-owned TypeScript dependency, ts.resolveModuleName.
// Route 3: dynamic loading of the HOST project's TypeScript. This is
//          forbidden by the user's G10 decision. It is deliberately NOT
//          implemented or attempted here.
//
// The fixture is authored by this script under scripts/fixtures/generated/s7.
// No fixture code is executed; only package.json/tsconfig/TS source files are
// read and module specifiers are resolved.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE = path.join(ROOT, 'scripts', 'fixtures', 'generated', 's7');
const EVIDENCE = path.join(ROOT, 'docs', 'evidence', 's7-module-resolution.json');
const APP_DIR = path.join(FIXTURE, 'packages', 'app');
const APP_TSCONFIG = path.join(APP_DIR, 'tsconfig.json');
const APP_MAIN = path.join(APP_DIR, 'src', 'main.ts');

const PROBLEM =
  '模块解析三条路线在含相对路径、tsconfig paths、package exports、workspaces 的合成 monorepo 上的成功率与成本；宿主 TypeScript 动态加载按 G10 禁止，不实现。';
const METHOD =
  '脚本自写合成 fixture；路线①用 Node 内置能力自写解析器；路线②用 scripts/node_modules/typescript 的 ts.resolveModuleName 读取同一 tsconfig；路线③仅记录拒绝与 unknown 降级；测量导入/RSS/解析耗时与 TypeScript 安装体积。';
const PASS_CRITERIA = [
  '路线①与②对同一组合成用例给出可核对结果，失败项显式 unknown',
  '路线②使用项目自带 TypeScript，版本、体积、启动、内存、解析成本有实测',
  '路线③明确未实现，写明 G10 拒绝理由与未知降级',
  '合成 fixtures 只由本 Spike 写入允许目录，未执行其中代码',
  '成本数据标注小规模、不外推',
];

const SPECIFIERS = [
  { spec: './local.js', expected: 'resolved', kind: 'relative-with-js-extension' },
  { spec: '@lib/util', expected: 'resolved', kind: 'tsconfig-paths-alias' },
  { spec: '@fixture/lib', expected: 'resolved', kind: 'workspace-root-exports' },
  { spec: '@fixture/lib/feature', expected: 'resolved', kind: 'workspace-exports-subpath' },
  { spec: '../../lib/src/util.js', expected: 'resolved', kind: 'cross-package-relative' },
  { spec: '@fixture/missing', expected: 'unknown', kind: 'missing-workspace-package' },
  { spec: 'external-pkg', expected: 'unknown', kind: 'uninstalled-external-package' },
];

function writeFile(relativePath, content) {
  const fullPath = path.join(FIXTURE, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
  return fullPath;
}

function createFixture() {
  fs.rmSync(FIXTURE, { recursive: true, force: true });

  writeFile(
    'package.json',
    `${JSON.stringify(
      {
        name: 'ano-s7-fixture',
        version: '1.0.0',
        private: true,
        workspaces: ['packages/*'],
      },
      null,
      2,
    )}\n`,
  );

  writeFile(
    'packages/lib/package.json',
    `${JSON.stringify(
      {
        name: '@fixture/lib',
        version: '1.0.0',
        type: 'module',
        exports: {
          '.': {
            types: './src/index.ts',
            import: './src/index.ts',
            default: './src/index.ts',
          },
          './feature': {
            types: './src/feature.ts',
            import: './src/feature.ts',
            default: './src/feature.ts',
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  writeFile('packages/lib/src/index.ts', 'export { feature } from "./feature.js";\nexport const libName = "lib";\n');
  writeFile('packages/lib/src/feature.ts', 'export const feature = "feature";\n');
  writeFile('packages/lib/src/util.ts', 'export const util = "util";\n');

  writeFile(
    'packages/app/package.json',
    `${JSON.stringify(
      {
        name: '@fixture/app',
        version: '1.0.0',
        private: true,
        type: 'module',
        dependencies: { '@fixture/lib': 'workspace:*' },
      },
      null,
      2,
    )}\n`,
  );
  writeFile(
    'packages/app/tsconfig.json',
    `${JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          baseUrl: '.',
          paths: { '@lib/*': ['../lib/src/*'] },
        },
        include: ['src/**/*.ts'],
      },
      null,
      2,
    )}\n`,
  );
  writeFile(
    'packages/app/src/main.ts',
    [
      'import { local } from "./local.js";',
      'import { util } from "@lib/util";',
      'import { libName } from "@fixture/lib";',
      'import { feature } from "@fixture/lib/feature";',
      'import { util as cross } from "../../lib/src/util.js";',
      'import missing from "@fixture/missing";',
      'import external from "external-pkg";',
      'export const all = [local, util, libName, feature, cross, missing, external];',
      '',
    ].join('\n'),
  );
  writeFile('packages/app/src/local.ts', 'export const local = "local";\n');

  // Simulate the workspace install link that npm/pnpm would create. A junction
  // keeps the real path under packages/lib; a copy is used only if junction
  // creation is unavailable.
  const nodeModulesScope = path.join(FIXTURE, 'node_modules', '@fixture');
  fs.mkdirSync(nodeModulesScope, { recursive: true });
  const linkPath = path.join(nodeModulesScope, 'lib');
  let installMethod;
  try {
    fs.symlinkSync(path.join(FIXTURE, 'packages', 'lib'), linkPath, 'junction');
    installMethod = 'junction';
  } catch (error) {
    fs.cpSync(path.join(FIXTURE, 'packages', 'lib'), linkPath, { recursive: true });
    installMethod = `copy (junction unavailable: ${error.code ?? error.message})`;
  }

  return { installMethod };
}

function listFiles(dir, base = dir) {
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...listFiles(full, base));
    else result.push({ path: path.relative(base, full).replace(/\\/g, '/'), bytes: fs.statSync(full).size });
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

function stripJsonComments(text) {
  let output = '';
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (lineComment) {
      if (char === '\n') {
        lineComment = false;
        output += char;
      }
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    output += char;
  }
  return output.replace(/,\s*([}\]])/g, '$1');
}

function readJsonc(filePath) {
  return JSON.parse(stripJsonComments(fs.readFileSync(filePath, 'utf8')));
}

function isFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isDirectory(filePath) {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function candidateFiles(base) {
  const candidates = [];
  if (/\.(m?js|cjs|jsx)$/i.test(base)) {
    const stem = base.replace(/\.(m?js|cjs|jsx)$/i, '');
    candidates.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.d.ts`, `${stem}.mts`, `${stem}.cts`, base);
  } else {
    candidates.push(
      base,
      `${base}.ts`,
      `${base}.tsx`,
      `${base}.mts`,
      `${base}.cts`,
      `${base}.d.ts`,
      `${base}.js`,
      `${base}.mjs`,
      `${base}.cjs`,
      `${base}.json`,
    );
  }
  return candidates;
}

function resolveFileOrDirectory(base) {
  for (const candidate of candidateFiles(base)) {
    if (isFile(candidate)) return candidate;
  }
  if (isDirectory(base)) {
    for (const indexName of ['index.ts', 'index.tsx', 'index.js', 'index.mjs', 'index.cjs', 'index.d.ts']) {
      const candidate = path.join(base, indexName);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

function discoverWorkspaces(rootPackageJson) {
  const map = new Map();
  const patterns = rootPackageJson.workspaces ?? [];
  for (const pattern of patterns) {
    if (pattern.endsWith('/*')) {
      const parent = path.join(FIXTURE, pattern.slice(0, -2));
      if (!isDirectory(parent)) continue;
      for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const packageJsonPath = path.join(parent, entry.name, 'package.json');
        if (!isFile(packageJsonPath)) continue;
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        if (packageJson.name) map.set(packageJson.name, path.dirname(packageJsonPath));
      }
    } else {
      const packageJsonPath = path.join(FIXTURE, pattern, 'package.json');
      if (isFile(packageJsonPath)) {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        if (packageJson.name) map.set(packageJson.name, path.dirname(packageJsonPath));
      }
    }
  }
  return map;
}

function pickCondition(target) {
  if (typeof target === 'string') return target;
  if (Array.isArray(target)) {
    for (const item of target) {
      const picked = pickCondition(item);
      if (picked) return picked;
    }
    return null;
  }
  if (target && typeof target === 'object') {
    for (const condition of ['types', 'import', 'default', 'node', 'require']) {
      if (Object.prototype.hasOwnProperty.call(target, condition)) {
        const picked = pickCondition(target[condition]);
        if (picked) return picked;
      }
    }
    for (const value of Object.values(target)) {
      const picked = pickCondition(value);
      if (picked) return picked;
    }
  }
  return null;
}

function matchExports(exportsField, subpathKey) {
  if (typeof exportsField === 'string' || Array.isArray(exportsField)) {
    return subpathKey === '.' ? exportsField : null;
  }
  if (!exportsField || typeof exportsField !== 'object') return null;
  const keys = Object.keys(exportsField);
  const hasSubpathKeys = keys.some((key) => key.startsWith('.'));
  if (!hasSubpathKeys) return subpathKey === '.' ? exportsField : null;

  if (Object.prototype.hasOwnProperty.call(exportsField, subpathKey)) return exportsField[subpathKey];
  let best = null;
  for (const key of keys) {
    if (!key.includes('*')) continue;
    const [prefix, suffix] = key.split('*');
    if (!subpathKey.startsWith(prefix) || !subpathKey.endsWith(suffix)) continue;
    if (subpathKey.length < prefix.length + suffix.length) continue;
    if (best === null || key.length > best.key.length) {
      best = { key, captured: subpathKey.slice(prefix.length, subpathKey.length - suffix.length) };
    }
  }
  if (!best) return null;
  const picked = pickCondition(exportsField[best.key]);
  return picked ? picked.replace('*', best.captured) : null;
}

function resolvePackage({ spec, fromFile, workspaceMap }) {
  const parts = spec.split('/');
  const packageName = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  const subpath = (spec.startsWith('@') ? parts.slice(2) : parts.slice(1)).join('/');
  const subpathKey = subpath ? `./${subpath}` : '.';

  let packageDir = workspaceMap.get(packageName) ?? null;
  let discovery = 'workspace';
  if (!packageDir) {
    discovery = 'node_modules';
    let current = path.dirname(fromFile);
    while (current.startsWith(FIXTURE)) {
      const candidate = path.join(current, 'node_modules', packageName);
      if (isDirectory(candidate)) {
        packageDir = candidate;
        break;
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  if (!packageDir) return { status: 'unknown', reason: `package not installed or not in workspaces: ${packageName}` };

  const packageJsonPath = path.join(packageDir, 'package.json');
  if (!isFile(packageJsonPath)) return { status: 'unknown', reason: `missing package.json: ${packageJsonPath}` };
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

  if (packageJson.exports !== undefined) {
    const rawTarget = matchExports(packageJson.exports, subpathKey);
    const target = pickCondition(rawTarget);
    if (typeof target !== 'string' || !target.startsWith('./')) {
      return { status: 'unknown', reason: `exports did not resolve ${packageName}/${subpath}` };
    }
    const resolved = resolveFileOrDirectory(path.resolve(packageDir, target));
    if (resolved) return { status: 'resolved', path: resolved, method: `${discovery}-exports` };
    return { status: 'unknown', reason: `exports target missing: ${target}` };
  }

  if (subpath) {
    const resolved = resolveFileOrDirectory(path.join(packageDir, subpath));
    if (resolved) return { status: 'resolved', path: resolved, method: `${discovery}-subpath` };
    return { status: 'unknown', reason: `package subpath missing: ${subpath}` };
  }

  for (const field of ['types', 'typings', 'main']) {
    if (typeof packageJson[field] === 'string') {
      const resolved = resolveFileOrDirectory(path.resolve(packageDir, packageJson[field]));
      if (resolved) return { status: 'resolved', path: resolved, method: `${discovery}-${field}` };
    }
  }
  const index = resolveFileOrDirectory(path.join(packageDir, 'index'));
  if (index) return { status: 'resolved', path: index, method: `${discovery}-index` };
  return { status: 'unknown', reason: 'no exports/types/main/index' };
}

function createRoute1(tsconfigPath) {
  const config = readJsonc(tsconfigPath);
  const compilerOptions = config.compilerOptions ?? {};
  const configDir = path.dirname(tsconfigPath);
  const baseUrl = path.resolve(configDir, compilerOptions.baseUrl ?? '.');
  const paths = compilerOptions.paths ?? {};
  const pathKeys = Object.keys(paths).sort((a, b) => {
    const aWild = a.includes('*') ? 1 : 0;
    const bWild = b.includes('*') ? 1 : 0;
    if (aWild !== bWild) return aWild - bWild;
    return b.length - a.length;
  });
  const rootPackageJson = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'package.json'), 'utf8'));
  const workspaceMap = discoverWorkspaces(rootPackageJson);

  function resolve(spec, fromFile = APP_MAIN) {
    if (spec.startsWith('.') || spec.startsWith('/')) {
      const resolved = resolveFileOrDirectory(path.resolve(path.dirname(fromFile), spec));
      return resolved
        ? { status: 'resolved', path: resolved, method: 'relative' }
        : { status: 'unknown', reason: 'relative target not found' };
    }

    for (const key of pathKeys) {
      const targets = Array.isArray(paths[key]) ? paths[key] : [paths[key]];
      if (key.includes('*')) {
        const [prefix, suffix] = key.split('*');
        if (!spec.startsWith(prefix) || !spec.endsWith(suffix)) continue;
        if (spec.length < prefix.length + suffix.length) continue;
        const captured = spec.slice(prefix.length, spec.length - suffix.length);
        for (const target of targets) {
          const resolved = resolveFileOrDirectory(path.resolve(baseUrl, target.replace('*', captured)));
          if (resolved) return { status: 'resolved', path: resolved, method: 'paths' };
        }
      } else if (spec === key) {
        for (const target of targets) {
          const resolved = resolveFileOrDirectory(path.resolve(baseUrl, target));
          if (resolved) return { status: 'resolved', path: resolved, method: 'paths' };
        }
      }
    }

    return resolvePackage({ spec, fromFile, workspaceMap });
  }

  return { resolve, workspaceMap, paths, baseUrl };
}

function measureRoute1(route1, iterations) {
  const beforeRss = process.memoryUsage().rss;
  const coldStart = performance.now();
  const coldResults = SPECIFIERS.map(({ spec }) => ({ spec, ...route1.resolve(spec) }));
  const coldMs = performance.now() - coldStart;

  const samples = [];
  const warmStart = performance.now();
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    for (const { spec } of SPECIFIERS) {
      const started = performance.now();
      route1.resolve(spec);
      samples.push(performance.now() - started);
    }
  }
  const warmTotalMs = performance.now() - warmStart;
  samples.sort((a, b) => a - b);
  const afterRss = process.memoryUsage().rss;

  return {
    coldMs: Number(coldMs.toFixed(3)),
    warmTotalMs: Number(warmTotalMs.toFixed(3)),
    warmAvgMs: Number((warmTotalMs / samples.length).toFixed(4)),
    warmP95Ms: Number(samples[Math.floor(samples.length * 0.95)].toFixed(4)),
    calls: samples.length,
    rssDeltaBytes: afterRss - beforeRss,
    thirdPartyImports: 0,
    coldResults,
    workspaceCount: route1.workspaceMap.size,
  };
}

function measureRoute2(iterations) {
  const require = createRequire(import.meta.url);
  const typescriptPath = require.resolve('typescript');
  const typescriptPackageDir = path.resolve(path.dirname(typescriptPath), '..');
  const installFiles = listFiles(typescriptPackageDir);
  const installBytes = installFiles.reduce((sum, file) => sum + file.bytes, 0);

  const rssBeforeImport = process.memoryUsage().rss;
  const importStarted = performance.now();
  const ts = require('typescript');
  const importMs = performance.now() - importStarted;
  const rssAfterImport = process.memoryUsage().rss;

  const configStarted = performance.now();
  const configFile = ts.readConfigFile(APP_TSCONFIG, ts.sys.readFile);
  if (configFile.error) throw new Error(`readConfigFile failed: ${JSON.stringify(configFile.error)}`);
  const parsedConfig = ts.parseJsonConfigFileContent(configFile.config, ts.sys, APP_DIR);
  const configParseMs = performance.now() - configStarted;

  function resolve(spec, fromFile = APP_MAIN) {
    const result = ts.resolveModuleName(spec, fromFile, parsedConfig.options, ts.sys);
    const resolved = result.resolvedModule;
    if (!resolved) {
      return {
        status: 'unknown',
        reason: 'ts.resolveModuleName returned no module',
        failedLookupCount: result.failedLookupLocations?.length ?? 0,
      };
    }
    return {
      status: 'resolved',
      path: resolved.resolvedFileName,
      method: resolved.isExternalLibraryImport ? 'node_modules' : 'typescript',
      isExternalLibraryImport: resolved.isExternalLibraryImport,
      extension: resolved.extension,
      failedLookupCount: result.failedLookupLocations?.length ?? 0,
    };
  }

  const coldStart = performance.now();
  const coldResults = SPECIFIERS.map(({ spec }) => ({ spec, ...resolve(spec) }));
  const coldMs = performance.now() - coldStart;

  const samples = [];
  const warmStart = performance.now();
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    for (const { spec } of SPECIFIERS) {
      const started = performance.now();
      resolve(spec);
      samples.push(performance.now() - started);
    }
  }
  const warmTotalMs = performance.now() - warmStart;
  samples.sort((a, b) => a - b);

  return {
    typescriptPath,
    typescriptPackageDir,
    version: ts.version,
    installBytes,
    installMiB: Number((installBytes / 1024 / 1024).toFixed(3)),
    installFiles: installFiles.length,
    importMs: Number(importMs.toFixed(3)),
    rssDeltaAfterImportBytes: rssAfterImport - rssBeforeImport,
    configParseMs: Number(configParseMs.toFixed(3)),
    coldMs: Number(coldMs.toFixed(3)),
    warmTotalMs: Number(warmTotalMs.toFixed(3)),
    warmAvgMs: Number((warmTotalMs / samples.length).toFixed(4)),
    warmP95Ms: Number(samples[Math.floor(samples.length * 0.95)].toFixed(4)),
    calls: samples.length,
    coldResults,
  };
}

function normalizePath(filePath) {
  if (!filePath) return null;
  const normalized = path.resolve(filePath).replace(/\\/g, '/');
  const fixture = FIXTURE.replace(/\\/g, '/');
  return normalized.startsWith(fixture) ? normalized.slice(fixture.length + 1) : normalized;
}

function realPath(filePath) {
  if (!filePath) return null;
  try {
    return normalizePath(fs.realpathSync.native(filePath));
  } catch {
    return normalizePath(filePath);
  }
}

function main() {
  const startedAt = new Date().toISOString();
  const fixtureInfo = createFixture();
  const fixtureFiles = listFiles(FIXTURE);
  const fixtureBytes = fixtureFiles.reduce((sum, file) => sum + file.bytes, 0);

  const route1 = createRoute1(APP_TSCONFIG);
  const route1Metrics = measureRoute1(route1, 100);
  const route2Metrics = measureRoute2(100);

  const route2BySpec = new Map(route2Metrics.coldResults.map((result) => [result.spec, result]));
  const route1BySpec = new Map(route1Metrics.coldResults.map((result) => [result.spec, result]));

  const comparison = SPECIFIERS.map(({ spec, expected, kind }) => {
    const first = route1BySpec.get(spec);
    const second = route2BySpec.get(spec);
    const route1Ok = first.status === expected;
    const route2Ok = second.status === expected;
    return {
      spec,
      kind,
      expected,
      route1: {
        status: first.status,
        path: normalizePath(first.path),
        realPath: realPath(first.path),
        method: first.method ?? null,
        reason: first.reason ?? null,
        matchesExpected: route1Ok,
      },
      route2: {
        status: second.status,
        path: normalizePath(second.path),
        realPath: realPath(second.path),
        method: second.method ?? null,
        extension: second.extension ?? null,
        isExternalLibraryImport: second.isExternalLibraryImport ?? null,
        failedLookupCount: second.failedLookupCount ?? null,
        reason: second.reason ?? null,
        matchesExpected: route2Ok,
      },
      statusesAgree: first.status === second.status,
      resolvedRealPathsAgree:
        first.status === 'resolved' && second.status === 'resolved'
          ? realPath(first.path) === realPath(second.path)
          : first.status === second.status,
    };
  });

  const route1Correct = comparison.every((entry) => entry.route1.matchesExpected);
  const route2Correct = comparison.every((entry) => entry.route2.matchesExpected);

  // Route 3 is intentionally absent. No host-project TypeScript is imported.
  const route3 = {
    implemented: false,
    attempted: false,
    status: 'rejected',
    basis: '用户 G10 明确禁止动态加载宿主项目 TypeScript；该路线会执行项目 node_modules 中的代码，供应链与权限边界不可接受。',
    fallback:
      '若宿主无 TypeScript、版本不在声明支持范围、加载失败或未显式开启，则解析结果为 unknown/heuristic，不猜测、不执行宿主代码。',
    codeImportedFromHost: false,
  };

  const pass =
    route1Correct &&
    route2Correct &&
    comparison.every((entry) => entry.statusesAgree) &&
    route3.implemented === false &&
    route2Metrics.installBytes > 0 &&
    route1Metrics.calls > 0 &&
    route2Metrics.calls > 0;

  const evidence = {
    spike: 'S7',
    title: '模块解析三路线对比',
    generatedAt: new Date().toISOString(),
    startedAt,
    environment: {
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      os: `${os.type()} ${os.release()}`,
      cwd: ROOT,
    },
    problem: PROBLEM,
    method: METHOD,
    passCriteria: PASS_CRITERIA,
    fixture: {
      root: FIXTURE,
      installMethod: fixtureInfo.installMethod,
      fileCount: fixtureFiles.length,
      bytes: fixtureBytes,
      files: fixtureFiles,
      authoredBySpike: true,
      executed: false,
      note: '仅写文件并解析 package.json/tsconfig/TS 源码；没有 import/require 任何 fixture 代码。',
    },
    routes: {
      route1: {
        name: '自写轻量解析（相对路径 + paths + exports + workspaces）',
        thirdPartyImports: 0,
        supported: ['relative', 'tsconfig paths', 'package exports', 'workspaces discovery'],
        metrics: route1Metrics,
      },
      route2: {
        name: '项目自带 TypeScript ts.resolveModuleName',
        metrics: route2Metrics,
      },
      route3,
    },
    comparison,
    summary: {
      route1Correct,
      route2Correct,
      statusesAgree: comparison.every((entry) => entry.statusesAgree),
      resolvedRealPathsAgree: comparison.filter((entry) => entry.resolvedRealPathsAgree).length,
      totalSpecifiers: SPECIFIERS.length,
      route1Resolved: comparison.filter((entry) => entry.route1.status === 'resolved').length,
      route2Resolved: comparison.filter((entry) => entry.route2.status === 'resolved').length,
      route3Implemented: false,
    },
    pass,
    caveats: [
      'Fixture 只有 2 个 workspace 包、7 个 import 用例，测量结果很小，不能外推到大型真实仓库。',
      'workspace 链接用 junction 模拟安装；若系统不支持则退化为目录复制，具体方式已记录。',
      '路线②只调用解析 API，不编译也不执行 fixture 代码。',
      '路线③被 G10 禁止，本 Spike 没有实现，也没有任何动态 import 宿主 TypeScript 的代码路径。',
      '耗时包含 JIT/文件系统缓存影响；warm 数据是重复调用后的结果，不代表冷启动分布。',
    ],
  };

  fs.mkdirSync(path.dirname(EVIDENCE), { recursive: true });
  fs.writeFileSync(EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`);

  console.log(
    JSON.stringify(
      {
        spike: 'S7',
        pass,
        fixture: {
          root: FIXTURE,
          installMethod: fixtureInfo.installMethod,
          files: fixtureFiles.length,
          bytes: fixtureBytes,
        },
        route1: {
          correct: route1Correct,
          coldMs: route1Metrics.coldMs,
          warmAvgMs: route1Metrics.warmAvgMs,
          warmP95Ms: route1Metrics.warmP95Ms,
          rssDeltaBytes: route1Metrics.rssDeltaBytes,
        },
        route2: {
          correct: route2Correct,
          typescriptVersion: route2Metrics.version,
          installMiB: route2Metrics.installMiB,
          installFiles: route2Metrics.installFiles,
          importMs: route2Metrics.importMs,
          rssDeltaAfterImportBytes: route2Metrics.rssDeltaAfterImportBytes,
          configParseMs: route2Metrics.configParseMs,
          coldMs: route2Metrics.coldMs,
          warmAvgMs: route2Metrics.warmAvgMs,
          warmP95Ms: route2Metrics.warmP95Ms,
        },
        route3,
        comparison,
        summary: evidence.summary,
        evidence: EVIDENCE,
      },
      null,
      2,
    ),
  );

  if (!pass) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(error.stack ?? error);
  process.exitCode = 1;
}
