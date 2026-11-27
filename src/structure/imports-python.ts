import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute, join, posix, relative, resolve, win32 } from 'node:path';
import { readConfig } from '../core/config.ts';
import type { CaveatSemanticGap, EdgeKind, EdgeProvenance, GraphEdge } from './types.ts';
import type { PythonImportRecord, PythonParsedFile } from './extractors/python.ts';

export type PythonResolutionStatus = 'resolved' | 'external' | 'ambiguous' | 'unresolved';
export interface PythonResolution {
  status: PythonResolutionStatus;
  path?: string;
  reason?: string;
  /** All project candidates, only when the module is ambiguous. */
  candidates?: string[];
}

export interface PythonResolutionContext {
  root: string;
  files: Set<string>;
  /** Project-relative POSIX directories; an empty string denotes the project root. */
  roots: string[];
  caveats: string[];
}

const IDENTIFIER = /^[_\p{ID_Start}][_\p{ID_Continue}]*$/u;
const excluded = /(?:^|\/)(?:\.venv|venv|site-packages|__pycache__)(?:\/|$)/u;
const normalize = (path: string): string => posix.normalize(path.replaceAll('\\', '/')).replace(/^\.\//u, '').replace(/^\.$/u, '');

function localRoot(root: string, value: string): string | undefined {
  if (!value || /[\x00-\x1f\x7f]/u.test(value)) return undefined;
  const rel = relative(resolve(root), resolve(root, value));
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) return undefined;
  const normalized = normalize(rel);
  return excluded.test(normalized) ? undefined : normalized;
}

function stringValue(raw: string): string | undefined {
  const literal = /^'([^'\r\n]*)'$/u.exec(raw.trim());
  if (literal) return literal[1];
  if (!/^"(?:[^"\\\r\n]|\\.)*"$/u.test(raw.trim())) return undefined;
  try { return JSON.parse(raw.trim()) as string; } catch { return undefined; }
}

function stripComment(line: string): string {
  let quote = '';
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (quote === '"' && char === '\\') { index += 1; continue; }
    if (char === quote) quote = '';
    else if (!quote && (char === '"' || char === "'")) quote = char;
    else if (!quote && char === '#') return line.slice(0, index);
  }
  return line;
}

function arrayValue(raw: string): string[] | undefined {
  let remaining = raw.trim();
  if (!remaining.startsWith('[')) return undefined;
  remaining = remaining.slice(1).trimStart();
  const values: string[] = [];
  while (!remaining.startsWith(']')) {
    const match = /^(?:'[^'\r\n]*'|"(?:[^"\\\r\n]|\\.)*")/u.exec(remaining);
    if (!match) return undefined;
    const value = stringValue(match[0]);
    if (value === undefined) return undefined;
    values.push(value);
    remaining = remaining.slice(match[0].length).trimStart();
    if (remaining.startsWith(']')) break;
    if (!remaining.startsWith(',')) return undefined;
    remaining = remaining.slice(1).trimStart();
  }
  return remaining === ']' && values.length > 0 ? values : undefined;
}

function pyprojectRoots(text: string): { roots?: string[]; caveats: string[] } {
  const lines = text.split(/\r?\n/u).map(stripComment);
  const caveats: string[] = [];
  let section = '';
  let where: string[] | undefined;
  let packageDir: string | undefined;
  let whereSeen = false;
  let packageSeen = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    const heading = /^\[([^\]]+)\]$/u.exec(line);
    if (heading) { section = heading[1]!; continue; }
    const assignment = /^(where|package-dir|""|'')\s*=\s*(.*)$/u.exec(line);
    if (!assignment) continue;
    const key = assignment[1]!;
    let raw = assignment[2]!;
    if (section === 'tool.setuptools.packages.find' && key === 'where') {
      if (whereSeen) { where = undefined; caveats.push('pyproject.toml: duplicate setuptools where; falling back'); continue; }
      whereSeen = true;
      if (raw.startsWith('[')) {
        while (!raw.trimEnd().endsWith(']') && index + 1 < lines.length && !lines[index + 1]!.trimStart().startsWith('[')) raw += `\n${lines[++index]}`;
      }
      where = arrayValue(raw);
      if (!where) caveats.push('pyproject.toml: unsupported setuptools where; falling back');
    } else if ((section === 'tool.setuptools' && key === 'package-dir') || (section === 'tool.setuptools.package-dir' && (key === '""' || key === "''"))) {
      if (packageSeen) { packageDir = undefined; caveats.push('pyproject.toml: duplicate setuptools package-dir; falling back'); continue; }
      packageSeen = true;
      if (key === 'package-dir') {
        const inline = /^\{\s*(?:""|'')\s*=\s*(.*?)\s*,?\s*\}$/u.exec(raw);
        packageDir = inline ? stringValue(inline[1]!) : undefined;
      } else packageDir = stringValue(raw);
      if (packageDir === undefined) caveats.push('pyproject.toml: unsupported setuptools package-dir; falling back');
    }
  }
  return { ...(where ? { roots: where } : packageDir !== undefined ? { roots: [packageDir] } : {}), caveats };
}

/** Resolve only against the supplied project manifest, never an interpreter or site-packages. */
export async function createPythonResolutionContext(root: string, files: Iterable<string>): Promise<PythonResolutionContext> {
  const fileSet = new Set([...files].map(normalize).filter((file) => !excluded.test(file) && /\.pyi?$/u.test(file) && !/[\x00-\x1f\x7f]/u.test(file) && !file.startsWith('../') && !posix.isAbsolute(file) && !win32.isAbsolute(file)));
  const config = readConfig(root);
  const caveats = config.warnings.filter((warning) => warning.includes('python'));
  let candidates: readonly string[] | undefined = config.python.roots.length ? config.python.roots : undefined;
  if (!candidates) {
    try {
      const projectPath = join(root, 'pyproject.toml');
      const stat = await lstat(projectPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_048_576) throw new Error('Unsupported pyproject file');
      const text = await readFile(projectPath, 'utf8');
      const project = pyprojectRoots(text);
      candidates = project.roots;
      caveats.push(...project.caveats);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') caveats.push('pyproject.toml could not be read; falling back');
    }
  }
  let roots = candidates?.map((value) => localRoot(root, value));
  if (roots?.some((value) => value === undefined)) {
    caveats.push('Python source roots contain a non-project or excluded path; falling back');
    roots = undefined;
  }
  return {
    root, files: fileSet,
    roots: roots ? [...new Set(roots as string[])] : [...fileSet].some((file) => file.startsWith('src/')) ? ['src'] : [''],
    caveats,
  };
}

function findModule(context: PythonResolutionContext, root: string, components: string[]): string | undefined {
  const base = posix.join(root, ...components);
  for (const candidate of [`${base}.py`, `${base}/__init__.py`, `${base}.pyi`, `${base}/__init__.pyi`]) {
    if (context.files.has(candidate)) return candidate;
  }
  return undefined;
}

function importerRoots(context: PythonResolutionContext, importer: string): Array<{ root: string; components: string[] }> {
  const directory = posix.dirname(normalize(importer));
  const candidates: Array<{ root: string; components: string[] }> = [];
  for (const root of context.roots) {
    const rel = posix.relative(root || '.', directory);
    if (rel === '..' || rel.startsWith('../') || posix.isAbsolute(rel)) continue;
    const components = rel ? rel.split('/') : [];
    if (components.every((component) => IDENTIFIER.test(component))) candidates.push({ root, components });
  }
  return candidates;
}

export function resolvePythonSpecifier(context: PythonResolutionContext, importer: string, specifier: string): PythonResolution {
  const dots = /^\.+/u.exec(specifier)?.[0].length ?? 0;
  const module = specifier.slice(dots);
  const parts = module ? module.split('.') : [];
  if ((!dots && !parts.length) || parts.some((part) => !IDENTIFIER.test(part))) return { status: 'unresolved', reason: `Invalid Python module ${specifier}` };
  const targets = new Set<string>();
  if (dots) {
    const containers = importerRoots(context, importer);
    for (const container of containers) {
      if (!container.components.length || dots > container.components.length) continue;
      const components = [...container.components.slice(0, container.components.length - dots + 1), ...parts];
      const found = findModule(context, container.root, components);
      if (found) targets.add(found);
    }
    if (!containers.some((container) => container.components.length >= dots)) return { status: 'unresolved', reason: `Python relative import ${specifier} escapes the top-level package` };
  } else {
    for (const root of context.roots) {
      const found = findModule(context, root, parts);
      if (found) targets.add(found);
    }
  }
  if (targets.size > 1) return { status: 'ambiguous', candidates: [...targets].sort(), reason: `Ambiguous Python module ${specifier}: ${[...targets].sort().join(', ')}` };
  const found = [...targets][0];
  if (found) return { status: 'resolved', path: found };
  return dots
    ? { status: 'unresolved', reason: `No project file for Python relative import ${specifier}` }
    : { status: 'external', reason: `Python module ${specifier} is external or unresolved; site-packages were not read` };
}

/** A stable module name for L1 symbols; does not require __init__.py (PEP 420). */
export function pythonModuleName(context: PythonResolutionContext, file: string): string {
  const normalized = normalize(file);
  const candidates = context.roots.filter((root) => !root || normalized.startsWith(`${root}/`));
  if (candidates.length !== 1) return normalized.replace(/\.pyi?$/u, '').replaceAll('/', '.');
  const root = candidates[0]!;
  const local = root ? normalized.slice(root.length + 1) : normalized;
  return local.replace(/(?:\/__init__)?\.pyi?$/u, '').replaceAll('/', '.');
}

/** Public name used by the Python language pack; the specifier API is also kept explicit. */
export const resolvePythonImport = resolvePythonSpecifier;
export const MAX_PYTHON_REEXPORT_DEPTH = 12;

interface PythonTarget {
  file: string;
  kind: EdgeKind;
  provenance: EdgeProvenance;
  label?: GraphEdge['label'];
}

function targetForRecord(record: PythonImportRecord, file: string, stub: boolean): PythonTarget {
  const typeOnly = record.provenance === 'type-only' || record.typeOnly || stub;
  return {
    file,
    kind: typeOnly ? 'type-only' : record.provenance === 'heuristic' ? 'unknown' : 'value-confirmed',
    provenance: record.provenance === 'heuristic' ? 'heuristic' : 'resolved',
    ...(record.heuristic ? { label: record.heuristic } : {}),
  };
}

function constrainTarget(record: PythonImportRecord, target: PythonTarget): PythonTarget {
  if (record.provenance === 'type-only' || record.typeOnly) return { ...target, kind: 'type-only' };
  if (record.provenance === 'heuristic') return {
    ...target, kind: target.kind === 'type-only' ? 'type-only' : 'unknown', provenance: 'heuristic',
    ...(record.heuristic ? { label: record.heuristic } : {}),
  };
  return target;
}

/** Follow named bindings only. Wildcards, cycles and budget limits never prove coverage. */
function namedTarget(
  context: PythonResolutionContext,
  modules: Map<string, PythonParsedFile>,
  file: string,
  name: string,
  visited: Set<string>,
): PythonTarget {
  const key = `${file}\0${name}`;
  if (visited.has(key) || visited.size >= MAX_PYTHON_REEXPORT_DEPTH) return { file, kind: 'unknown', provenance: 'heuristic', label: 'depth_limit' };
  const parsed = modules.get(file);
  if (!parsed || parsed.syntax.hasError || parsed.budgets.depthLimitExceeded || parsed.budgets.scopeLimitExceeded) return { file, kind: 'unknown', provenance: 'parsed', label: 'unresolved' };
  const declaration = parsed.definitions.find((definition) => definition.name === name && definition.qualifiedName === name);
  const bindings = parsed.imports.flatMap((record) => record.bindings
    .filter((binding) => binding.localName === name && record.scope === undefined && record.context !== 'lazy-import')
    .map((binding) => ({ record, binding })));
  if (declaration && bindings.length || bindings.length > 1) return { file, kind: 'unknown', provenance: 'heuristic', label: 'unresolved' };
  if (declaration) {
    const conditional = declaration.conditional || parsed.assignments.some((assignment) => assignment.name === name && assignment.conditional);
    return {
      file, kind: parsed.stub || declaration.typeOnly ? 'type-only' : conditional ? 'unknown' : 'value-confirmed',
      provenance: conditional ? 'heuristic' : 'resolved', ...(conditional ? { label: 'conditional_import' as const } : {}),
    };
  }
  const bound = bindings[0];
  if (bound) {
    const { record, binding } = bound;
    const base = resolvePythonSpecifier(context, file, record.specifier ?? '');
    if (base.status === 'resolved' && base.path) {
      if (record.form === 'import') {
        // `import a.b` binds `a`, not `a.b`; only an explicit alias binds the leaf.
        if (!binding.aliased && binding.importedName.includes('.')) {
          const boundModule = resolvePythonSpecifier(context, file, binding.localName);
          return boundModule.status === 'resolved' && boundModule.path
            ? targetForRecord(record, boundModule.path, boundModule.path.endsWith('.pyi'))
            : { file: base.path, kind: parsed.stub ? 'type-only' : 'unknown', provenance: 'parsed', label: 'unresolved' };
        }
        return targetForRecord(record, base.path, base.path.endsWith('.pyi'));
      }
      const next = new Set(visited); next.add(key);
      return constrainTarget(record, namedTarget(context, modules, base.path, binding.importedName, next));
    }
    if (record.form === 'from' && base.status !== 'ambiguous') {
      const child = resolvePythonSpecifier(context, file, childSpecifier(record.specifier ?? '', binding.importedName));
      if (child.status === 'resolved' && child.path) return targetForRecord(record, child.path, child.path.endsWith('.pyi'));
    }
    return { file, kind: parsed.stub ? 'type-only' : 'unknown', provenance: 'parsed', label: 'unresolved' };
  }
  // `from namespace import child` can have no __init__.py at all (PEP 420).
  const child = /(?:^|\/)__init__\.pyi?$/u.test(file)
    ? resolvePythonSpecifier(context, file, `.${name}`) : undefined;
  if (child?.status === 'resolved' && child.path) return { file: child.path, kind: parsed.stub || child.path.endsWith('.pyi') ? 'type-only' : 'value-confirmed', provenance: 'resolved' };
  return { file, kind: parsed.stub ? 'type-only' : 'unknown', provenance: 'parsed', label: 'unresolved' };
}

function childSpecifier(base: string, name: string): string {
  return base.endsWith('.') ? `${base}${name}` : `${base}.${name}`;
}

/** L0/L1 dependency facts only; does not infer Python calls or execute imported modules. */
export function buildPythonImportEdges(context: PythonResolutionContext, modules: Map<string, PythonParsedFile>): { edges: GraphEdge[]; caveats: CaveatSemanticGap[] } {
  const accumulated = new Map<string, GraphEdge>();
  const caveats: CaveatSemanticGap[] = context.caveats.map((reason) => ({ file: 'pyproject.toml', line: 0, pattern: 'python-source-roots', reason }));
  const add = (from: string, target: PythonTarget, names: string[]): void => {
    const edge: GraphEdge = { from, to: target.file, kind: target.kind, provenance: target.provenance, importedNames: [...new Set(names)].sort(), ...(target.label ? { label: target.label } : {}) };
    const key = [edge.from, edge.to, edge.kind, edge.provenance, edge.label ?? ''].join('\0');
    const previous = accumulated.get(key);
    if (previous) previous.importedNames = [...new Set([...previous.importedNames, ...edge.importedNames])].sort();
    else accumulated.set(key, edge);
  };
  for (const [file, parsed] of [...modules].sort(([left], [right]) => left.localeCompare(right))) {
    for (const mutation of parsed.sysPathMutations) caveats.push({ file, line: mutation.line, pattern: 'python-sys-path', reason: mutation.reason });
    if (parsed.syntax.hasError) caveats.push({ file, line: parsed.syntax.firstErrorLine ?? 0, pattern: 'python-syntax-error', reason: 'Python syntax is incomplete; its imports do not prove coverage' });
    for (const record of parsed.imports) {
      const specifier = record.specifier ?? '';
      const base = resolvePythonSpecifier(context, file, specifier);
      for (const binding of record.bindings) {
        const name = binding.importedName;
        let resolution = base;
        let target: PythonTarget | undefined;
        if (base.status === 'resolved' && base.path) {
          target = record.form === 'import' || record.wildcard
            ? targetForRecord(record, base.path, base.path.endsWith('.pyi'))
            : constrainTarget(record, namedTarget(context, modules, base.path, name, new Set()));
        } else if (record.form === 'from' && !record.wildcard && base.status !== 'ambiguous') {
          resolution = resolvePythonSpecifier(context, file, childSpecifier(specifier, name));
          if (resolution.status === 'resolved' && resolution.path) target = targetForRecord(record, resolution.path, resolution.path.endsWith('.pyi'));
        }
        if (target) {
          if (parsed.syntax.hasError || parsed.budgets.depthLimitExceeded || parsed.budgets.scopeLimitExceeded) target = { ...target, kind: target.kind === 'type-only' ? 'type-only' : 'unknown', provenance: 'heuristic', label: 'unresolved' };
          add(file, target, [name]);
          if (target.label === 'depth_limit' || target.label === 'unresolved') caveats.push({ file, line: record.line, pattern: 'python-reexport', reason: `Named binding ${name} from ${specifier} could not be confirmed` });
        } else {
          const kind = record.provenance === 'type-only' ? 'type-only' : 'unknown';
          const paths = resolution.candidates ?? [resolution.path ?? specifier];
          for (const path of paths) add(file, constrainTarget(record, { file: path, kind, provenance: 'parsed', label: 'unresolved' }), [name]);
          caveats.push({ file, line: record.line, pattern: `python-import-${resolution.status}`, reason: resolution.reason ?? `Python import ${specifier} could not be confirmed` });
        }
      }
    }
  }
  return { edges: [...accumulated.values()].sort((left, right) => Buffer.from(JSON.stringify(left)).compare(Buffer.from(JSON.stringify(right)))), caveats };
}
