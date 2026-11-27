/**
 * T-153 / QF-04 shard C shared fixtures.
 *
 * Pure builders only: every filesystem helper is tmpdir-bound and registers its
 * own cleanup with node:test. Nothing here writes to `src/`, `.pm/` or docs.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TestContext } from 'node:test';
import type { ClientAuthorizationRef, ConfigInput, ConfigResult } from '../../src/clients/types.ts';

/** Create a per-test temp directory that is removed after the test finishes. */
export function m18cTmp(t: TestContext, prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

export function m18cWriteText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

export function m18cWriteJson(path: string, value: unknown): void {
  m18cWriteText(path, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Home-bearing environment. Adapters read HOME first, then USERPROFILE; both are
 * injected so the probe never depends on the host user profile.
 */
export function m18cHomeEnv(home: string, extra: Record<string, string> = {}): Record<string, string> {
  return { HOME: home, USERPROFILE: home, ...extra };
}

export interface M18cAuthzOptions {
  readonly statement?: string;
  readonly revokedAt?: string | null;
}

/** Build an authorization reference; omit `statement` to exercise refusals. */
export function m18cAuthz(root: string, clientId: string, options: M18cAuthzOptions = {}): ClientAuthorizationRef {
  return {
    authorizationId: 'a'.repeat(64),
    root,
    clientId,
    scope: ['config', 'install'],
    grantedBy: 'Alice',
    grantedAt: '2026-11-25T00:00:00.000Z',
    revokedAt: options.revokedAt === undefined ? null : options.revokedAt,
    ...(options.statement === undefined ? {} : { statement: options.statement }),
  } as ClientAuthorizationRef;
}

/**
 * Build a ConfigInput. The adapter contract has no `env` field, but adapters
 * deliberately read `(input as {env?:unknown}).env`; passing it here exercises
 * that undocumented-by-types injection seam without editing the source.
 */
/** Read dry-run warnings without relying on union narrowing at each call site. */
export function m18cWarnings(result: ConfigResult): readonly string[] {
  return result.mode === 'dry-run' ? result.warnings : [];
}

export function m18cConfig(
  overrides: Partial<ConfigInput> & { env?: unknown } = {},
): ConfigInput {
  const { env, ...rest } = overrides as Partial<ConfigInput> & { env?: unknown };
  return {
    target: { scope: 'project' },
    mode: 'dry-run',
    ...rest,
    ...(env === undefined ? {} : { env }),
  } as ConfigInput;
}
