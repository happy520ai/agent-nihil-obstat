import { ReadinessError } from './errors.ts';

export type TomlScalar = string | number | boolean;
export type TomlValue = TomlScalar | TomlScalar[];
export type TomlTable = { [key: string]: TomlValue | TomlTable };

const bareKeyPattern = /^[A-Za-z0-9_-]+$/;
const integerPattern = /^-?(?:0|[1-9][0-9]*)$/;

function parseError(line: number, message: string): ReadinessError {
  return new ReadinessError('TOML_INVALID', `TOML line ${line}: ${message}`);
}

function stripComment(line: string, lineNumber: number): string {
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!;
    if (quote === '"') {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === '\\') {
        escaped = true;
        continue;
      }
      if (character === '"') quote = null;
      continue;
    }
    if (quote === "'") {
      if (character === "'") quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '#') return line.slice(0, index);
  }
  if (quote !== null) throw parseError(lineNumber, 'unterminated string');
  return line;
}

function splitOutsideQuotes(text: string, separator: string, lineNumber: number): string[] {
  const parts: string[] = [];
  let start = 0;
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (quote === '"') {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === '\\') {
        escaped = true;
        continue;
      }
      if (character === '"') quote = null;
      continue;
    }
    if (quote === "'") {
      if (character === "'") quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === separator) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  if (quote !== null) throw parseError(lineNumber, 'unterminated string');
  parts.push(text.slice(start));
  return parts;
}

function findEquals(text: string, lineNumber: number): number {
  const parts = splitOutsideQuotes(text, '=', lineNumber);
  if (parts.length === 1) return -1;
  if (parts.length > 2) throw parseError(lineNumber, 'only one "=" is allowed per assignment');
  return parts[0]!.length;
}

function parseString(text: string, lineNumber: number): string {
  const quote = text[0];
  if (text.length < 2 || text.at(-1) !== quote) throw parseError(lineNumber, 'unterminated string');
  const body = text.slice(1, -1);
  if (quote === "'") {
    if (body.includes("'")) throw parseError(lineNumber, 'unescaped quote in literal string');
    return body;
  }
  let result = '';
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index]!;
    if (character !== '\\') {
      if (character.charCodeAt(0) < 0x20) throw parseError(lineNumber, 'control character in string');
      result += character;
      continue;
    }
    const next = body[index + 1];
    index += 1;
    switch (next) {
      case '"': result += '"'; break;
      case '\\': result += '\\'; break;
      case 'n': result += '\n'; break;
      case 'r': result += '\r'; break;
      case 't': result += '\t'; break;
      default: throw parseError(lineNumber, `unsupported escape sequence \\${next ?? ''}`);
    }
  }
  return result;
}

function parseValue(text: string, lineNumber: number): TomlValue {
  const trimmed = text.trim();
  if (trimmed.length === 0) throw parseError(lineNumber, 'missing value');
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) return parseString(trimmed, lineNumber);
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (integerPattern.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith('[')) {
    if (!trimmed.endsWith(']')) throw parseError(lineNumber, 'unterminated array');
    const body = trimmed.slice(1, -1).trim();
    if (body.length === 0) return [];
    const values = splitOutsideQuotes(body, ',', lineNumber).map((part, index) => {
      if (part.trim().length === 0) throw parseError(lineNumber, `empty array element ${index + 1}`);
      return parseValue(part, lineNumber);
    });
    const kind = typeof values[0];
    if (values.some((value) => Array.isArray(value) || typeof value !== kind)) {
      throw parseError(lineNumber, 'arrays must be flat and homogeneous');
    }
    return values as TomlScalar[];
  }
  throw parseError(lineNumber, `unsupported value ${JSON.stringify(trimmed)}; strings must be quoted`);
}

const dangerousKeys = new Set(['__proto__', 'constructor', 'prototype']);

function keySegments(text: string, lineNumber: number): string[] {
  const parts = splitOutsideQuotes(text, '.', lineNumber);
  const segments = parts.map((part) => {
    const trimmed = part.trim();
    if (trimmed.length === 0) throw parseError(lineNumber, 'empty key segment');
    if (trimmed.startsWith('"') || trimmed.startsWith("'")) return parseString(trimmed, lineNumber);
    if (!bareKeyPattern.test(trimmed)) throw parseError(lineNumber, `invalid key ${JSON.stringify(trimmed)}`);
    return trimmed;
  });
  for (const segment of segments) {
    if (dangerousKeys.has(segment)) throw parseError(lineNumber, `reserved key ${segment}`);
  }
  return segments;
}

function tableFor(root: TomlTable, segments: string[], path: string, lineNumber: number, declared: Set<string>): TomlTable {
  const declaration = JSON.stringify(segments);
  if (declared.has(declaration)) throw parseError(lineNumber, `duplicate table [${path}]`);
  declared.add(declaration);
  let current = root;
  for (const segment of segments) {
    const existing = current[segment];
    if (existing === undefined) {
      const created: TomlTable = Object.create(null) as TomlTable;
      current[segment] = created;
      current = created;
      continue;
    }
    if (Array.isArray(existing) || typeof existing !== 'object') {
      throw parseError(lineNumber, `table [${path}] conflicts with a scalar value`);
    }
    current = existing;
  }
  return current;
}

/** Parses a deliberately small TOML subset: tables, quoted strings, integers, booleans, flat arrays. */
export function parseToml(text: string): TomlTable {
  const root: TomlTable = Object.create(null) as TomlTable;
  const declared = new Set<string>();
  let current = root;
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = stripComment(lines[index]!, lineNumber).trim();
    if (line.length === 0) continue;
    if (line.startsWith('[[')) throw parseError(lineNumber, 'array tables are not supported');
    if (line.startsWith('[')) {
      if (!line.endsWith(']')) throw parseError(lineNumber, 'unterminated table header');
      const path = line.slice(1, -1).trim();
      current = tableFor(root, keySegments(path, lineNumber), path, lineNumber, declared);
      continue;
    }
    const equals = findEquals(line, lineNumber);
    if (equals < 0) throw parseError(lineNumber, 'expected key = value');
    const segments = keySegments(line.slice(0, equals).trim(), lineNumber);
    let target = current;
    for (const segment of segments.slice(0, -1)) {
      const existing = target[segment];
      if (existing === undefined) {
        const created: TomlTable = Object.create(null) as TomlTable;
        target[segment] = created;
        target = created;
        continue;
      }
      if (Array.isArray(existing) || typeof existing !== 'object') {
        throw parseError(lineNumber, `key ${segments.join('.')} conflicts with a scalar value`);
      }
      target = existing;
    }
    const key = segments.at(-1)!;
    if (Object.hasOwn(target, key)) throw parseError(lineNumber, `duplicate key ${segments.join('.')}`);
    target[key] = parseValue(line.slice(equals + 1), lineNumber);
  }
  return root;
}
