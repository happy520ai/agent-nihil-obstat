import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const CUTOVER_SCHEMA = 'ano.cutover-confirmation/1' as const;

export interface CutoverConfirmation {
  schema: typeof CUTOVER_SCHEMA;
  root: string;
  sourceDigest: string;
  backupId: string;
  backupHash: string;
  name: string;
  role: string;
  statement: string;
  confirmedAt: string;
}

export function cutoverPath(root: string): string {
  return join(resolve(root), '.ano', 'connect', 'cutover.json');
}

export async function readCutover(root: string): Promise<CutoverConfirmation | undefined> {
  const path = cutoverPath(root);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(await readFile(path, 'utf8')) as CutoverConfirmation;
  } catch {
    return undefined;
  }
}

/**
 * Record a named human cutover confirmation. This is an explicit, local,
 * auditable action; it never disables pm-mcp or modifies client configuration.
 */
export async function writeCutover(
  root: string,
  input: { sourceDigest: string; backupId: string; backupHash: string; name: string; role: string; statement: string },
): Promise<CutoverConfirmation> {
  if (!/^[0-9a-f]{64}$/iu.test(input.sourceDigest)) throw new Error('sourceDigest must be a sha256 hex digest');
  if (!input.name.trim() || !input.role.trim() || !input.statement.trim()) throw new Error('name, role and statement are required');
  const confirmation: CutoverConfirmation = {
    schema: CUTOVER_SCHEMA,
    root: resolve(root),
    sourceDigest: input.sourceDigest.toLowerCase(),
    backupId: input.backupId,
    backupHash: input.backupHash,
    name: input.name.trim(),
    role: input.role.trim(),
    statement: input.statement.trim(),
    confirmedAt: new Date().toISOString(),
  };
  const path = cutoverPath(root);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, `${JSON.stringify(confirmation, null, 2)}\n`);
  return confirmation;
}
