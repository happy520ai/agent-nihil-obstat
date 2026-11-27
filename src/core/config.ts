import { readFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

export type AnoProfile = 'personal' | 'full';
export interface AnoConfig {
  readonly profile: AnoProfile;
  readonly hooks: {
    readonly mode: 'advisory' | 'strict';
    readonly exempt: readonly string[];
    readonly prompt_hint: string | null;
  };
  readonly python: {
    readonly interpreter: string | null;
    readonly roots: readonly string[];
  };
  readonly path: string;
  readonly exists: boolean;
  readonly warnings: readonly string[];
}

const DEFAULT_CONFIG: Omit<AnoConfig, 'path' | 'exists' | 'warnings'> = {
  profile: 'full',
  hooks: { mode: 'advisory', exempt: [], prompt_hint: null },
  python: { interpreter: null, roots: [] },
};

function stringValue(raw: string): string | null {
  const match = /^"((?:[^"\\]|\\["\\])*)"\s*(?:#.*)?$/u.exec(raw.trim());
  if (!match) return null;
  try { return JSON.parse(`"${match[1]}"`) as string; } catch { return null; }
}

function pythonStringValue(raw: string): string | null {
  const literal = /^'([^'\r\n]*)'\s*(?:#.*)?$/u.exec(raw.trim());
  if (literal) return literal[1]!;
  const basic = /^"((?:[^"\\\r\n]|\\(?:["\\btnfr]|u[\da-fA-F]{4}|U[\da-fA-F]{8}))*)"\s*(?:#.*)?$/u.exec(raw.trim());
  if (!basic) return null;
  try {
    const value = basic[1]!.replace(/\\U([\da-fA-F]{8})/gu, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)));
    return JSON.parse(`"${value}"`) as string;
  } catch { return null; }
}

function pythonStringArray(raw: string): string[] | null {
  const values: string[] = [];
  let remaining = raw.trim();
  if (!remaining.startsWith('[')) return null;
  remaining = remaining.slice(1).trimStart();
  while (!remaining.startsWith(']')) {
    const match = /^(?:'[^'\r\n]*'|"(?:[^"\\\r\n]|\\.)*")/u.exec(remaining);
    if (!match) return null;
    const value = pythonStringValue(match[0]);
    if (value === null) return null;
    values.push(value);
    remaining = remaining.slice(match[0].length).trimStart();
    if (remaining.startsWith(']')) break;
    if (!remaining.startsWith(',')) return null;
    remaining = remaining.slice(1).trimStart();
  }
  return /^\]\s*(?:#.*)?$/u.test(remaining) ? values : null;
}

/** Deliberately small TOML reader: only documented profile, hooks and Python keys are interpreted. */
export function readConfig(root: string): AnoConfig {
  const path = join(root, '.ano', 'config.toml');
  let text: string;
  try { text = readFileSync(path, 'utf8'); }
  catch { return { ...DEFAULT_CONFIG, hooks: { ...DEFAULT_CONFIG.hooks }, python: { interpreter: null, roots: [] }, path, exists: false, warnings: [] }; }
  let profile: AnoProfile = 'full';
  let mode: 'advisory' | 'strict' = 'advisory';
  let exempt: string[] = [];
  let promptHint: string | null = null;
  let interpreter: string | null = null;
  let roots: string[] = [];
  let section = '';
  const warnings: string[] = [];
  const knownRoot = new Set(['profile']);
  const knownHooks = new Set(['mode', 'exempt', 'prompt_hint']);
  const knownPython = new Set(['interpreter', 'roots']);
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const sectionMatch = /^\[([^\]]+)\]\s*(?:#.*)?$/u.exec(trimmed);
    if (sectionMatch) {
      section = sectionMatch[1]!.trim();
      if (section !== 'hooks' && section !== 'python') warnings.push(`line ${index + 1}: unknown section [${section}]`);
      continue;
    }
    const assignment = /^([A-Za-z0-9_-]+)\s*=\s*(.*)$/u.exec(trimmed);
    if (!assignment) { warnings.push(`line ${index + 1}: ignored malformed entry`); continue; }
    const [, key = '', raw = ''] = assignment;
    if (section === '' && key === 'profile') {
      const parsed = stringValue(raw);
      if (parsed === 'personal' || parsed === 'full') profile = parsed;
      else warnings.push(`line ${index + 1}: profile must be "personal" or "full"`);
    } else if (section === 'hooks' && key === 'mode') {
      const parsed = stringValue(raw);
      if (parsed === 'advisory' || parsed === 'strict') mode = parsed;
      else warnings.push(`line ${index + 1}: hooks.mode must be "advisory" or "strict"`);
    } else if (section === 'hooks' && key === 'prompt_hint') {
      promptHint = stringValue(raw);
      if (promptHint === null) warnings.push(`line ${index + 1}: hooks.prompt_hint must be a quoted string`);
    } else if (section === 'hooks' && key === 'exempt') {
      const parsed = /^\[(.*)\]\s*(?:#.*)?$/u.exec(raw.trim());
      if (!parsed) warnings.push(`line ${index + 1}: hooks.exempt must be a string array`);
      else {
        const values: string[] = [];
        let valid = true;
        for (const item of parsed[1]!.split(',').map((entry) => entry.trim()).filter(Boolean)) {
          const value = stringValue(item);
          if (value === null) { valid = false; break; }
          values.push(value);
        }
        if (valid) exempt = values;
        else warnings.push(`line ${index + 1}: hooks.exempt contains a non-string value`);
      }
    } else if (section === 'python' && key === 'interpreter') {
      const parsed = pythonStringValue(raw);
      if (parsed && isAbsolute(parsed) && !/[\x00-\x1f\x7f]/u.test(parsed)) interpreter = parsed;
      else {
        interpreter = null;
        warnings.push(`line ${index + 1}: python.interpreter must be an absolute path`);
      }
    } else if (section === 'python' && key === 'roots') {
      const parsed = pythonStringArray(raw);
      if (parsed && parsed.every((entry) => {
        if (!entry || /[\x00-\x1f\x7f]/u.test(entry)) return false;
        const rel = relative(resolve(root), resolve(root, entry));
        return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\');
      })) roots = [...new Set(parsed)];
      else {
        roots = [];
        warnings.push(`line ${index + 1}: python.roots must be a string array of project-local paths`);
      }
    } else if ((section === '' && !knownRoot.has(key)) || (section === 'hooks' && !knownHooks.has(key)) || (section === 'python' && !knownPython.has(key))) {
      warnings.push(`line ${index + 1}: unknown key ${section ? `${section}.` : ''}${key}`);
    }
  }
  return { profile, hooks: { mode, exempt, prompt_hint: promptHint }, python: { interpreter, roots }, path, exists: true, warnings };
}

export function defaultConfigText(): string {
  return '# ANO personal defaults; existing projects without this file remain full.\nprofile = "personal"\n\n[hooks]\nmode = "advisory"\nexempt = []\n# prompt_hint = "先读取 ANO brief，再继续上次任务。"\n';
}

/** Create defaults once. Existing configuration is never overwritten. */
export async function writeDefaultConfig(root: string): Promise<{ path: string; written: boolean }> {
  const path = join(root, '.ano', 'config.toml');
  try { await readFile(path); return { path, written: false }; }
  catch { /* only the create path below may write */ }
  await mkdir(join(root, '.ano'), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, defaultConfigText(), { encoding: 'utf8', flag: 'wx' });
  try { await rename(temporary, path); }
  catch (error) { try { const { unlink } = await import('node:fs/promises'); await unlink(temporary); } catch { /* best effort */ } throw error; }
  return { path, written: true };
}
