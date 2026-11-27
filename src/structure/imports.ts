import { isBuiltin } from 'node:module';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';

export const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'] as const;

export type ResolutionStatus = 'resolved' | 'heuristic' | 'unresolved' | 'external';

export interface Resolution {
  status: ResolutionStatus;
  /** Project-relative POSIX path when status is resolved or heuristic. */
  path?: string;
  reason?: string;
}

export interface PathAliasRule {
  pattern: string;
  targets: string[];
  baseUrl: string;
}

export interface WorkspaceEntry {
  /** Candidate project-relative files in priority order. */
  files: string[];
  /** True when a fallback such as `src/index.ts` was manufactured. */
  fallback: boolean;
}

export interface WorkspacePackage {
  name: string;
  dir: string;
  entries: WorkspaceEntry;
  subpaths: Map<string, WorkspaceEntry>;
}

export interface ResolutionContext {
  root: string;
  files: Set<string>;
  aliases: PathAliasRule[];
  workspaces: WorkspacePackage[];
  workspaceNames: Set<string>;
  imports: Record<string, string>;
}

interface JsonObject {
  [key: string]: unknown;
}

function stripJsonComments(input: string): string {
  let output = '';
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;
    const next = input[index + 1];
    if (inLineComment) {
      if (char === '\n') {
        inLineComment = false;
        output += char;
      }
      continue;
    }
    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }
    if (inString) {
      output += char;
      if (char === '\\') {
        output += next ?? '';
        index += 1;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    if (char === '/' && next === '/') {
      inLineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      inBlockComment = true;
      index += 1;
      continue;
    }
    output += char;
  }
  return output.replace(/,\s*([}\]])/g, '$1');
}

async function readJsonObject(path: string): Promise<JsonObject | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
  try {
    const value = JSON.parse(stripJsonComments(text));
    return typeof value === 'object' && value !== null ? value as JsonObject : undefined;
  } catch {
    return undefined;
  }
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function normalizePath(path: string): string {
  return posix.normalize(path).replace(/^\.\//, '');
}

function extensionCandidates(specifier: string): string[] {
  const dot = specifier.lastIndexOf('.');
  const slash = specifier.lastIndexOf('/');
  if (dot <= slash) return SOURCE_EXTENSIONS.map((extension) => `${specifier}${extension}`);
  const current = specifier.slice(dot).toLowerCase();
  if (current === '.js') return [`${specifier.slice(0, dot)}.ts`, `${specifier.slice(0, dot)}.tsx`, `${specifier.slice(0, dot)}.js`, `${specifier.slice(0, dot)}.jsx`];
  if (current === '.jsx') return [`${specifier.slice(0, dot)}.tsx`, `${specifier.slice(0, dot)}.jsx`];
  if (current === '.mjs' || current === '.cjs') return [`${specifier.slice(0, dot)}.ts`, `${specifier.slice(0, dot)}.tsx`, specifier];
  return [specifier];
}

function findFile(files: Set<string>, base: string): string | undefined {
  const normalized = normalizePath(base);
  for (const candidate of extensionCandidates(normalized)) {
    if (files.has(candidate)) return candidate;
  }
  if (!SOURCE_EXTENSIONS.some((extension) => normalized.endsWith(extension))) {
    for (const extension of SOURCE_EXTENSIONS) {
      if (files.has(`${normalized}/index${extension}`)) return `${normalized}/index${extension}`;
    }
  }
  return undefined;
}

export function resolveRelativeSpecifier(context: ResolutionContext, importer: string, specifier: string): Resolution {
  const target = normalizePath(posix.join(dirname(importer), specifier));
  const found = findFile(context.files, target);
  if (found) return { status: 'resolved', path: found };
  return { status: 'unresolved', reason: `No source file for relative specifier ${specifier}` };
}

function matchAlias(pattern: string, specifier: string): string | undefined {
  const star = pattern.indexOf('*');
  if (star < 0) return pattern === specifier ? '' : undefined;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return undefined;
  if (specifier.length < prefix.length + suffix.length) return undefined;
  return specifier.slice(prefix.length, specifier.length - suffix.length);
}

export function resolveAliasSpecifier(context: ResolutionContext, specifier: string): Resolution | undefined {
  for (const rule of context.aliases) {
    const captured = matchAlias(rule.pattern, specifier);
    if (captured === undefined) continue;
    for (const target of rule.targets) {
      const replaced = normalizePath(posix.join(rule.baseUrl, target.replace('*', captured)));
      const found = findFile(context.files, replaced);
      if (found) return { status: 'resolved', path: found };
    }
    return { status: 'unresolved', reason: `tsconfig path ${rule.pattern} did not match a source file` };
  }
  return undefined;
}

function workspaceEntry(dir: string, candidates: string[], fallback: boolean): WorkspaceEntry {
  const files: string[] = [];
  for (const candidate of candidates) {
    const normalized = normalizePath(posix.join(dir, candidate));
    files.push(normalized);
  }
  return { files, fallback };
}

function entryCandidatesFromManifest(dir: string, manifest: JsonObject): WorkspaceEntry {
  const candidates: string[] = [];
  for (const field of ['source', 'types', 'typings', 'module', 'main']) {
    const value = manifest[field];
    if (typeof value === 'string') candidates.push(value);
  }
  const exportsValue = manifest['exports'];
  if (typeof exportsValue === 'string') candidates.push(exportsValue);
  else if (typeof exportsValue === 'object' && exportsValue !== null) {
    const root: unknown = (exportsValue as JsonObject)['.'];
    if (typeof root === 'string') candidates.push(root);
    else if (typeof root === 'object' && root !== null) {
      for (const condition of ['types', 'import', 'default', 'require']) {
        const value = (root as JsonObject)[condition];
        if (typeof value === 'string') candidates.push(value);
      }
    }
  }
  const fallback = candidates.length === 0;
  if (fallback) candidates.push('src/index.ts', 'index.ts', 'src/index.tsx', 'index.tsx');
  return workspaceEntry(dir, candidates, fallback);
}

function subpathCandidates(dir: string, manifest: JsonObject, subpath: string): WorkspaceEntry {
  const exportsValue = manifest['exports'];
  const key = `./${subpath}`;
  const candidates: string[] = [];
  if (typeof exportsValue === 'object' && exportsValue !== null) {
    const entry: unknown = (exportsValue as JsonObject)[key];
    if (typeof entry === 'string') candidates.push(entry);
    else if (typeof entry === 'object' && entry !== null) {
      for (const condition of ['types', 'import', 'default', 'require']) {
        const value = (entry as JsonObject)[condition];
        if (typeof value === 'string') candidates.push(value);
      }
    }
  }
  candidates.push(subpath);
  return workspaceEntry(dir, candidates, candidates.length === 0);
}

async function expandWorkspacePattern(root: string, pattern: string): Promise<string[]> {
  const normalized = pattern.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!normalized.includes('*')) return [normalized];
  const star = normalized.indexOf('*');
  const parent = normalized.slice(0, star).replace(/\/+$/, '');
  let entries;
  try {
    entries = await readdir(join(root, parent), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((entry) => entry.isDirectory()).map((entry) => posix.join(parent, entry.name));
}

async function loadWorkspaces(root: string, manifest: JsonObject | undefined): Promise<WorkspacePackage[]> {
  if (!manifest) return [];
  const workspacesValue = manifest['workspaces'];
  const patterns = Array.isArray(workspacesValue)
    ? asStringArray(workspacesValue)
    : typeof workspacesValue === 'object' && workspacesValue !== null
      ? asStringArray((workspacesValue as JsonObject)['packages'])
      : [];
  const packages: WorkspacePackage[] = [];
  for (const pattern of patterns) {
    for (const dir of await expandWorkspacePattern(root, pattern)) {
      const packageManifest = await readJsonObject(join(root, dir, 'package.json'));
      if (!packageManifest || typeof packageManifest['name'] !== 'string') continue;
      const name = packageManifest['name'];
      const subpaths = new Map<string, WorkspaceEntry>();
      const exportsValue = packageManifest['exports'];
      if (typeof exportsValue === 'object' && exportsValue !== null) {
        for (const key of Object.keys(exportsValue)) {
          if (!key.startsWith('./') || key === './') continue;
          subpaths.set(key.slice(2), subpathCandidates(dir, packageManifest, key.slice(2)));
        }
      }
      packages.push({ name, dir: normalizePath(dir), entries: entryCandidatesFromManifest(dir, packageManifest), subpaths });
    }
  }
  return packages;
}

export function resolveWorkspaceSpecifier(context: ResolutionContext, specifier: string): Resolution | undefined {
  for (const workspace of context.workspaces) {
    if (specifier === workspace.name) {
      for (const candidate of workspace.entries.files) {
        const found = findFile(context.files, candidate);
        if (found) return { status: workspace.entries.fallback ? 'heuristic' : 'resolved', path: found };
      }
      return { status: 'unresolved', reason: `Workspace ${workspace.name} has no resolvable source entry` };
    }
    if (!specifier.startsWith(`${workspace.name}/`)) continue;
    const subpath = specifier.slice(workspace.name.length + 1);
    const entry = workspace.subpaths.get(subpath) ?? subpathCandidates(workspace.dir, {}, subpath);
    for (const candidate of entry.files) {
      const found = findFile(context.files, candidate);
      if (found) return { status: entry.fallback ? 'heuristic' : 'resolved', path: found };
    }
    return { status: 'unresolved', reason: `Workspace subpath ${specifier} has no resolvable source file` };
  }
  return undefined;
}

export function resolveSpecifier(context: ResolutionContext, importer: string, specifier: string): Resolution {
  if (specifier.startsWith('node:')) return { status: 'external', reason: 'Node.js builtin' };
  if (isBuiltin(specifier)) return { status: 'external', reason: 'Node.js builtin' };
  if (specifier.startsWith('./') || specifier.startsWith('../') || specifier === '.' || specifier === '..') {
    return resolveRelativeSpecifier(context, importer, specifier);
  }
  if (specifier.startsWith('/')) return { status: 'unresolved', reason: 'Absolute filesystem imports are outside the project graph' };
  const alias = resolveAliasSpecifier(context, specifier);
  if (alias) return alias;
  if (specifier.startsWith('#')) {
    const mapped = resolvePackageImport(context.imports, specifier);
    if (mapped === undefined) return { status: 'unresolved', reason: `package.json#imports has no ${specifier}` };
    const found = findFile(context.files, normalizePath(mapped));
    return found ? { status: 'resolved', path: found } : { status: 'unresolved', reason: `#imports target has no source file: ${mapped}` };
  }
  const workspace = resolveWorkspaceSpecifier(context, specifier);
  if (workspace) return workspace;
  return { status: 'external', reason: 'Bare package outside the project sources' };
}

/** Picks a project-relative target out of a string or condition-object import mapping. */
function importsTarget(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null) {
    for (const condition of ['types', 'import', 'default', 'require']) {
      const target = importsTarget((value as JsonObject)[condition]);
      if (target !== undefined) return target;
    }
  }
  return undefined;
}

/** Reads `package.json#imports`, keeping only targets that point inside the project. */
function packageImports(manifest: JsonObject | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!manifest || typeof manifest['imports'] !== 'object' || manifest['imports'] === null) return result;
  for (const [key, value] of Object.entries(manifest['imports'] as JsonObject)) {
    if (!key.startsWith('#')) continue;
    const target = importsTarget(value);
    if (target === undefined || !(target.startsWith('./') || target.startsWith('../'))) continue;
    result[key] = target;
  }
  return result;
}

/** Exact `#alias` match first, then `#alias/*` patterns (Node's subpath-imports shape). */
function resolvePackageImport(imports: Record<string, string>, specifier: string): string | undefined {
  const exact = imports[specifier];
  if (exact !== undefined) return exact;
  for (const [pattern, target] of Object.entries(imports)) {
    const captured = matchAlias(pattern, specifier);
    if (captured === undefined) continue;
    return target.replace('*', captured);
  }
  return undefined;
}

export async function createResolutionContext(root: string, files: Iterable<string>): Promise<ResolutionContext> {
  const fileSet = new Set(files);
  const tsconfig = await readJsonObject(join(root, 'tsconfig.json')) ?? await readJsonObject(join(root, 'jsconfig.json'));
  const aliases: PathAliasRule[] = [];
  if (tsconfig) {
    const compilerOptions = tsconfig['compilerOptions'];
    if (typeof compilerOptions === 'object' && compilerOptions !== null) {
      const options = compilerOptions as JsonObject;
      const baseUrlValue = typeof options['baseUrl'] === 'string' ? options['baseUrl'] : '.';
      const baseUrl = normalizePath(baseUrlValue);
      const paths = options['paths'];
      if (typeof paths === 'object' && paths !== null) {
        for (const [pattern, targets] of Object.entries(paths as JsonObject)) {
          const list = asStringArray(targets);
          if (list.length > 0) aliases.push({ pattern, targets: list, baseUrl });
        }
      }
    }
  }
  const manifest = await readJsonObject(join(root, 'package.json'));
  const workspaces = await loadWorkspaces(root, manifest);
  return {
    root,
    files: fileSet,
    aliases,
    workspaces,
    workspaceNames: new Set(workspaces.map((workspace) => workspace.name)),
    imports: packageImports(manifest),
  };
}
