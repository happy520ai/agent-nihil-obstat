import { stat } from 'node:fs/promises';
import { scanDependencies } from './deps.ts';
import { scanDrift } from './drift.ts';
import { mergeFindings, openFindings } from './findings.ts';
import { emitAuditEvents } from './events.ts';
import { loadGovernancePolicy, scanGovernance } from './governance.ts';
import { scanLicenses } from './license.ts';
import { scanSecurity } from './security.ts';
import {
  AUDIT_SCHEMA,
  AUDIT_SCOPES,
  AuditInputError,
  AuditNetworkRefusedError,
  type AuditContext,
  type AuditCounts,
  type AuditFinding,
  type AuditNetworkState,
  type AuditResult,
  type AuditRunOptions,
  type AuditScope,
  type OnlineScannerRequest,
} from './types.ts';
import { assertSafeRelativePath, makeFinding, sha256, sortFindings, summarize, uniqStrings } from './util.ts';

interface ScopeScan {
  findings: AuditFinding[];
  counts: AuditCounts;
  degraded: string[];
  caveats: string[];
  packages?: OnlineScannerRequest['packages'];
}

async function assertRoot(root: string): Promise<void> {
  let info;
  try { info = await stat(root); }
  catch { throw new AuditInputError(`Audit root does not exist: ${root}`); }
  if (!info.isDirectory()) throw new AuditInputError(`Audit root is not a directory: ${root}`);
}

async function scanScope(root: string, scope: AuditScope, context: AuditContext): Promise<ScopeScan> {
  switch (scope) {
    case 'security': {
      const result = await scanSecurity(root);
      return { findings: result.findings, counts: { files: result.files }, degraded: result.degraded, caveats: [] };
    }
    case 'license': {
      const result = await scanLicenses(root);
      return {
        findings: result.findings,
        counts: { files: 0, packages: result.packages },
        degraded: result.degraded,
        caveats: ['spdx-classification-is-heuristic'],
      };
    }
    case 'deps': {
      const result = await scanDependencies(root);
      return {
        findings: result.findings,
        counts: { files: 0, packages: result.packages.length },
        degraded: result.degraded,
        caveats: ['offline-only-no-osv-query'],
        packages: result.packages,
      };
    }
    case 'drift': {
      const result = await scanDrift(root, {
        ...(context.ledger ? { ledger: context.ledger } : {}),
        ...(context.anchors ? { anchors: context.anchors } : {}),
        ...(context.entries ? { entries: context.entries } : {}),
      });
      return {
        findings: result.findings,
        counts: { files: 0, tasks: result.tasks, anchors: result.anchors, entries: result.entries },
        degraded: result.degraded,
        caveats: result.caveats,
      };
    }
    case 'governance': {
      const loaded = context.policy ? { policy: context.policy, degraded: [] } : await loadGovernancePolicy(root);
      const result = scanGovernance(context.graph, loaded, context.policy ? { policy: context.policy } : {});
      return {
        findings: result.findings,
        counts: { files: 0, edges: result.edges, modules: result.modules },
        degraded: result.degraded,
        caveats: result.policySource ? [`policy:${result.policySource}`] : [],
      };
    }
  }
}

function onlinePackages(scan: ScopeScan): OnlineScannerRequest['packages'] {
  return scan.packages ?? [];
}

const SEVERITIES = new Set(['high', 'medium', 'low', 'info']);

/**
 * Online scanners are injected code, but their output still crosses the same
 * boundary: only a rule id, severity, fingerprint and safe location survive.
 * Scanner-provided free text is never persisted, so a provider cannot smuggle
 * a plaintext secret into a finding.
 */
function sanitizeOnlineFinding(scope: AuditScope, finding: AuditFinding): AuditFinding {
  const rule = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/.test(finding.rule) ? finding.rule : 'online/scanner-finding';
  const severity = SEVERITIES.has(finding.severity) ? finding.severity : 'medium';
  const fingerprint = /^[a-f0-9]{64}$/.test(finding.fingerprint) ? finding.fingerprint : sha256(`${scope}:${rule}:${finding.id}`);
  let path: string | undefined;
  if (typeof finding.path === 'string') {
    try { path = assertSafeRelativePath(finding.path); } catch { path = undefined; }
  }
  const line = typeof finding.line === 'number' && Number.isInteger(finding.line) && finding.line > 0 ? finding.line : undefined;
  const column = typeof finding.column === 'number' && Number.isInteger(finding.column) && finding.column > 0 ? finding.column : undefined;
  return makeFinding({
    scope,
    rule,
    severity,
    message: `Online scanner reported ${rule}`,
    fingerprint,
    ...(path !== undefined ? { path } : {}),
    ...(line !== undefined ? { line } : {}),
    ...(column !== undefined ? { column } : {}),
  });
}

/**
 * Runs exactly one audit scope. Findings are persisted hash-only under
 * .ano/audit unless persist=false. Network I/O only happens through an
 * injected scanner and only with confirm=true.
 */
export async function runAudit(root: string, options: AuditRunOptions): Promise<AuditResult> {
  await assertRoot(root);
  const clock = options.now ?? Date.now;
  const started = clock();
  const startedAt = new Date(started).toISOString();
  if (!AUDIT_SCOPES.includes(options.scope)) throw new AuditInputError(`Unknown audit scope: ${String(options.scope)}`);
  if (options.online && options.confirm !== true) throw new AuditNetworkRefusedError();

  const context = options.context ?? {};
  let scan = await scanScope(root, options.scope, context);
  const network: AuditNetworkState = { requested: options.online === true, performed: false };
  if (options.online) {
    if (!context.onlineScanner) {
      network.refused = 'not-configured';
      network.reason = 'No online scanner is configured; no request was made';
      scan.degraded.push('online-scanner-not-configured');
    } else {
      const request: OnlineScannerRequest = {
        scope: options.scope,
        confirm: true,
        root,
        packages: onlinePackages(scan),
      };
      const online = await context.onlineScanner(request);
      scan = { ...scan, findings: sortFindings([...scan.findings, ...online.map((finding) => sanitizeOnlineFinding(options.scope, finding))]) };
      network.performed = true;
    }
  }

  const merged = mergeFindings(root, scan.findings, {
    scope: options.scope,
    now: new Date(clock()).toISOString(),
    autoResolve: scan.degraded.length === 0,
    persist: options.persist !== false,
  });
  // A degraded scan is incomplete, so findings that are still open in the
  // persisted store for this scope must stay in the verdict even when the
  // incoming scan is empty. Never report ok just because nothing new appeared.
  const persistedOpen = openFindings(root, options.scope);
  const byId = new Map<string, AuditFinding>();
  for (const finding of [...merged.findings, ...persistedOpen]) {
    if (!byId.has(finding.id)) byId.set(finding.id, finding);
  }
  const findings = sortFindings([...byId.values()]);
  const degraded = uniqStrings([...scan.degraded, ...merged.degraded]);
  const summary = summarize(findings);
  const finished = clock();
  const result: AuditResult = {
    schema: AUDIT_SCHEMA,
    scope: options.scope,
    root,
    ok: summary.high === 0 && summary.medium === 0 && degraded.length === 0,
    findings,
    summary,
    counts: scan.counts,
    degraded,
    caveats: uniqStrings([...scan.caveats, 'findings-hash-only', 'ledger-audit-events-not-wired']),
    network,
    startedAt,
    finishedAt: new Date(finished).toISOString(),
    durationMs: finished - started,
  };
  await emitAuditEvents(options.sink, result);
  return result;
}

export function findingIdentity(scope: AuditScope, rule: string, fingerprint: string): string {
  return sha256(`${scope}\0${rule}\0${fingerprint}`);
}
