/**
 * ZCode MCP registration resolution shared by verification, self-host checks and
 * the integration contract tests.
 *
 * ZCode merges user-scope (`~/.zcode/cli/config.json`) and workspace-scope
 * (`<root>/.zcode/config.json`) MCP servers. When both scopes declare the same
 * `ano` entry, the native client selects the user-scope declaration and the
 * project-scope trust entry cannot be resolved (see PM debug entry D-0019).
 * This repository therefore registers `ano` once, at user scope, and keeps the
 * workspace `mcp.servers` container empty. These helpers make that intent
 * explicit and fail closed on duplicates.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, posix, win32 } from 'node:path';

export interface StdioServerConfig {
  readonly type: 'stdio';
  readonly command: string;
  readonly args?: string[];
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly enabled?: boolean;
  readonly timeoutMs?: number;
}

export interface ZcodeConfigFile {
  readonly mcp?: { readonly servers?: Record<string, StdioServerConfig> };
}

export type RegistrationScope = 'workspace' | 'user';

export interface AnoRegistration {
  readonly scope: RegistrationScope;
  readonly configPath: string;
  readonly server: StdioServerConfig;
  /** Stable fingerprint of the effective server entry (sorted-key JSON). */
  readonly serverSha256: string;
}

export interface AnoRegistrationState {
  readonly workspaceConfigPath: string;
  readonly userConfigPath: string;
  readonly workspaceConfigSha256: string;
  readonly workspaceAnoDeclared: boolean;
  readonly workspace: AnoRegistration | null;
  readonly user: AnoRegistration | null;
  readonly effective: AnoRegistration | null;
  readonly duplicate: boolean;
  readonly registrations: readonly AnoRegistration[];
}

interface LoadedConfig {
  readonly path: string;
  readonly sha256: string;
  readonly config: ZcodeConfigFile;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function primitiveJson(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('cannot canonicalize a non-JSON value');
  return encoded;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return primitiveJson(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

/** Stable fingerprint of a configured MCP server entry. */
export function serverFingerprint(server: StdioServerConfig): string {
  return sha256(canonicalJson(server));
}

export function isAbsoluteOnAnyPlatform(path: string): boolean {
  return win32.isAbsolute(path) || posix.isAbsolute(path);
}

/** Effective ZCode user configuration on this host; `ANO_ZCODE_USER_CONFIG` overrides it. */
export function defaultUserConfigPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const override = env.ANO_ZCODE_USER_CONFIG?.trim();
  return override && override.length > 0 ? override : join(home, '.zcode', 'cli', 'config.json');
}

async function loadConfig(configPath: string): Promise<LoadedConfig | null> {
  let text: string;
  try {
    text = await readFile(configPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const parsed = JSON.parse(text) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${configPath} must contain a JSON object`);
  }
  return { path: configPath, sha256: sha256(text), config: parsed as ZcodeConfigFile };
}

function registrationOf(loaded: LoadedConfig, scope: RegistrationScope): AnoRegistration | null {
  const container = loaded.config.mcp?.servers;
  if (container === undefined) return null;
  if (container === null || typeof container !== 'object' || Array.isArray(container)) {
    throw new Error(`${loaded.path} mcp.servers must be a JSON object`);
  }
  const server = (container as Record<string, unknown>).ano;
  if (server === undefined) return null;
  if (server === null || typeof server !== 'object' || Array.isArray(server)) {
    throw new Error(`${loaded.path} mcp.servers.ano must be a JSON object`);
  }
  const entry = server as StdioServerConfig;
  return { scope, configPath: loaded.path, server: entry, serverSha256: serverFingerprint(entry) };
}

/**
 * Reads the workspace and user configs and reports every `ano` registration.
 * `effective` prefers the workspace declaration only when it exists; duplicate
 * declarations are reported so callers can fail closed instead of guessing.
 */
export async function resolveAnoRegistrations(
  workspaceConfigPath: string,
  userConfigPath: string = defaultUserConfigPath(),
): Promise<AnoRegistrationState> {
  const workspace = await loadConfig(workspaceConfigPath);
  if (workspace === null) throw new Error(`workspace ZCode config not found: ${workspaceConfigPath}`);
  const user = await loadConfig(userConfigPath);
  const workspaceRegistration = registrationOf(workspace, 'workspace');
  const userRegistration = user === null ? null : registrationOf(user, 'user');
  const registrations = [workspaceRegistration, userRegistration].filter((item): item is AnoRegistration => item !== null);
  return {
    workspaceConfigPath,
    userConfigPath,
    workspaceConfigSha256: workspace.sha256,
    workspaceAnoDeclared: workspaceRegistration !== null,
    workspace: workspaceRegistration,
    user: userRegistration,
    effective: workspaceRegistration ?? userRegistration,
    duplicate: workspaceRegistration !== null && userRegistration !== null,
    registrations,
  };
}

/** Real launch-shape checks shared by verification and self-host. Returns human-readable problems. */
export function validateAnoStdioServer(server: StdioServerConfig, label: string): string[] {
  const problems: string[] = [];
  if (server.type !== 'stdio') problems.push(`${label}.type must be "stdio", got: ${String(server.type)}`);
  if (server.enabled === false) problems.push(`${label}.enabled must not be false`);
  if (typeof server.command !== 'string' || !isAbsoluteOnAnyPlatform(server.command)) {
    problems.push(`${label}.command must be an absolute path, got: ${String(server.command)}`);
  } else if (!existsSync(server.command)) {
    problems.push(`${label}.command does not exist: ${server.command}`);
  }
  if (!Array.isArray(server.args) || server.args.length !== 1) {
    problems.push(`${label}.args must contain exactly one absolute entry path`);
  } else {
    const entry = server.args[0];
    if (typeof entry !== 'string' || !isAbsoluteOnAnyPlatform(entry)) {
      problems.push(`${label}.args[0] must be an absolute path, got: ${String(entry)}`);
    } else if (!existsSync(entry)) {
      problems.push(`${label}.args[0] does not exist: ${entry}`);
    }
  }
  if (server.cwd !== undefined) {
    if (typeof server.cwd !== 'string' || !isAbsoluteOnAnyPlatform(server.cwd)) {
      problems.push(`${label}.cwd must be an absolute path, got: ${String(server.cwd)}`);
    } else if (!existsSync(server.cwd)) {
      problems.push(`${label}.cwd does not exist: ${server.cwd}`);
    }
  }
  if (server.env?.ANO_ROOT !== undefined) {
    const root = server.env.ANO_ROOT;
    if (typeof root !== 'string' || !isAbsoluteOnAnyPlatform(root)) {
      problems.push(`${label}.env.ANO_ROOT must be an absolute path, got: ${String(root)}`);
    } else if (!existsSync(root)) {
      problems.push(`${label}.env.ANO_ROOT does not exist: ${root}`);
    }
  }
  if (server.timeoutMs !== undefined && (!Number.isInteger(server.timeoutMs) || server.timeoutMs < 1_000)) {
    problems.push(`${label}.timeoutMs must be an integer >= 1000, got: ${String(server.timeoutMs)}`);
  }
  return problems;
}
