/**
 * Client compatibility matrix.
 *
 * No real client session format has been sampled or implemented in P4. Every
 * entry is explicitly `synthetic-only`; nothing here may be read as support for
 * a real ZCode/Qoder/Codex/Claude Code/WorkBuddy installation.
 */
export interface MemoryCompatibilityEntry {
  readonly client: string;
  readonly formatVersion: string;
  readonly sampleSource: 'hand-authored-synthetic-fixtures';
  readonly discover: 'tested-synthetic';
  readonly parse: 'tested-synthetic';
  readonly recall: 'tested-synthetic';
  readonly status: 'synthetic-only' | 'planned';
  readonly limitations: readonly string[];
}

export const memoryCompatibility: readonly MemoryCompatibilityEntry[] = [
  {
    client: 'synthetic-jsonl',
    formatVersion: 'synthetic-v1',
    sampleSource: 'hand-authored-synthetic-fixtures',
    discover: 'tested-synthetic',
    parse: 'tested-synthetic',
    recall: 'tested-synthetic',
    status: 'synthetic-only',
    limitations: [
      'No real client session file was read or sampled.',
      'Fixture shape is synthetic and is not a claim about any vendor format.',
      'No ranking/recall-quality conclusion exists without authorized samples.',
    ],
  },
];

export const memoryPlannedClients: readonly string[] = [
  'ZCode',
  'Qoder',
  'Codex',
  'Claude Code',
  'WorkBuddy',
];
