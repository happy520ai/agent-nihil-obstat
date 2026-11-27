/**
 * Shared client config scope boundary (M12/T-101, D1 fix).
 *
 * A declared client configuration target is only ever allowed inside its
 * declared scope: `user` is bounded by the home directory, every other scope
 * (`project`/`workspace`) by the canonical project root. Callers must not
 * derive the boundary from the target path itself — the pre-T-101 adapters
 * returned `dirname(path)` for an out-of-home user path, which made
 * `assertSafeTargetPath` treat the escape file as "inside its own parent" and
 * let an authorized apply write outside the declared scope.
 */

import { resolve } from 'node:path';
import type { ConfigScope } from './types.ts';

export interface ClientScopeRoots {
  /** Resolved home directory (user scope boundary). */
  readonly home: string;
  /** Resolved canonical project root (project/workspace boundary). */
  readonly root: string;
}

/**
 * The declared scope boundary for a client config target. An explicit path
 * that is not inside this boundary is refused by `assertSafeTargetPath`.
 */
export function allowedRootForPath(scope: ConfigScope, roots: ClientScopeRoots): string {
  return resolve(scope === 'user' ? roots.home : roots.root);
}
