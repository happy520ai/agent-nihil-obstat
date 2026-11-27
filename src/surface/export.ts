import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gitTouchedFiles } from '../core/git.ts';
import { Ledger, type LedgerTask } from '../ledger/ledger.ts';
import { GraphStore } from '../structure/store.ts';
import type { Freshness, GraphCaveats } from '../structure/types.ts';
import { listFindings, type StoredFinding } from '../audit/findings.ts';
import { listBaselines, type BaselineListing } from '../readiness/baseline.ts';
import { existingProjectRoot } from './service.ts';

export interface ExportEvidenceSummary { id: string; taskId: string; ok: boolean }
export interface ExportSnapshot {
  schema: 'ano.export.v1';
  generatedAt: string;
  root: string;
  project: { name?: string; version?: string; phase: string };
  tasks: LedgerTask[];
  evidence: ExportEvidenceSummary[];
  touched: string[];
  graph: {
    revision: string;
    sourceFingerprint: string;
    freshness: Freshness;
    files: number;
    symbols: number;
    edges: number;
    caveats: GraphCaveats;
  };
  findings: StoredFinding[];
  baselines: BaselineListing[];
  limitations: string[];
}

/** Read-only export used by the CLI and the loopback UI. */
export async function exportProject(root: string): Promise<ExportSnapshot> {
  const projectRoot = await existingProjectRoot(root);
  const manifest = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')) as { name?: string; version?: string };
  const ledger = await Ledger.open(projectRoot);
  const graph = await GraphStore.open(projectRoot);
  try {
    const snapshot = graph.snapshot();
    return {
      schema: 'ano.export.v1',
      generatedAt: new Date().toISOString(),
      root: projectRoot,
      project: {
        ...(typeof manifest.name === 'string' ? { name: manifest.name } : {}),
        ...(typeof manifest.version === 'string' ? { version: manifest.version } : {}),
        phase: 'P7',
      },
      tasks: ledger.getTasks(),
      evidence: ledger.listEvidence().map((record) => ({
        id: record.id,
        taskId: record.taskId,
        ok: record.evidence.ok === true,
      })),
      touched: await gitTouchedFiles(projectRoot),
      graph: {
        revision: snapshot.revision,
        sourceFingerprint: snapshot.sourceFingerprint,
        freshness: await graph.checkFreshness(),
        files: Object.keys(snapshot.files).length,
        symbols: snapshot.symbols.length,
        edges: snapshot.edges.length,
        caveats: snapshot.caveats,
      },
      findings: listFindings(projectRoot),
      baselines: listBaselines(projectRoot),
      limitations: [
        'audit findings store only fingerprints and locations, never plaintext secrets',
        'audit ledger events are not wired in this build',
        'release approval, attestation, sync and push are not implemented',
      ],
    };
  } finally { ledger.close(); graph.close(); }
}
