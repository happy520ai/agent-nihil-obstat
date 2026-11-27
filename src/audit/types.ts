/**
 * Audit data contract.
 *
 * Findings are deliberately metadata-only: a rule id, severity, project
 * location and a SHA-256 fingerprint of the matched value. Plaintext secrets
 * never enter this type, the persisted finding store, or an audit event.
 */

export type AuditScope = 'drift' | 'security' | 'license' | 'governance' | 'deps';
export type AuditSeverity = 'high' | 'medium' | 'low' | 'info';
export type FindingStatus = 'open' | 'resolved';

export const AUDIT_SCOPES: readonly AuditScope[] = ['drift', 'security', 'license', 'governance', 'deps'];
export const AUDIT_SCHEMA = 'ano.audit.v1' as const;

export interface AuditFinding {
  /** Location-scoped identity (stable across runs, changes when the location changes). */
  id: string;
  scope: AuditScope;
  rule: string;
  severity: AuditSeverity;
  /** Human description that must never contain the matched secret or code text. */
  message: string;
  fingerprint: string;
  path?: string;
  line?: number;
  column?: number;
  status: FindingStatus;
  /** True when a previously resolved finding with the same id was seen again. */
  reopened?: boolean;
  firstSeen?: string;
  lastSeen?: string;
}

export interface AuditSummary {
  high: number;
  medium: number;
  low: number;
  info: number;
  total: number;
}

export interface AuditNetworkState {
  requested: boolean;
  performed: boolean;
  refused?: 'confirm-required' | 'not-configured';
  reason?: string;
}

export interface AuditCounts {
  files: number;
  packages?: number;
  tasks?: number;
  entries?: number;
  anchors?: number;
  edges?: number;
  modules?: number;
}

export interface AuditResult {
  schema: typeof AUDIT_SCHEMA;
  scope: AuditScope;
  root: string;
  ok: boolean;
  findings: AuditFinding[];
  summary: AuditSummary;
  counts: AuditCounts;
  degraded: string[];
  caveats: string[];
  network: AuditNetworkState;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

/** Structural view of the ledger, so audit does not import concrete storage. */
export interface AuditLedgerView {
  getTasks(): Array<{ id: string; status: string; declaredFiles: string[]; title?: string }>;
}

export interface AuditGraphEdge {
  from: string;
  to: string;
  kind?: string | undefined;
  provenance?: string | undefined;
  label?: string | undefined;
  importedNames?: string[] | undefined;
}

export interface AuditGraphView {
  snapshot(): {
    revision: string;
    files: Record<string, { path: string; hash: string }>;
    edges: AuditGraphEdge[];
    caveats?: {
      degradedReasons?: string[];
      unknownRatio?: number;
      dynamicLoadCount?: number;
      heuristicEdges?: number;
    };
  };
}

export interface AuditAnchor {
  file: string;
  symbol?: string;
  qualifiedName?: string;
  contentFragmentHash?: string;
  label?: string;
}

export interface AuditEntry {
  path: string;
  label: string;
}

export interface AuditModulePolicy {
  id: string;
  roots: string[];
  kind?: string;
  dependsOn?: string[];
  allowedDependencies?: string[];
  deniedDependencies?: string[];
}

export interface GovernancePolicy {
  schemaVersion?: number;
  modules: AuditModulePolicy[];
  policies?: {
    enforceDeclaredDependencies?: boolean;
    failOnCycles?: boolean;
  };
}

export interface OnlineScannerRequest {
  scope: AuditScope;
  confirm: true;
  root: string;
  packages: Array<{ name: string; version: string; license?: string }>;
}

/** Injected online adapter. The default build never performs network I/O. */
export type OnlineScanner = (request: OnlineScannerRequest) => Promise<AuditFinding[]>;

export interface AuditContext {
  ledger?: AuditLedgerView;
  graph?: AuditGraphView;
  anchors?: AuditAnchor[];
  entries?: AuditEntry[];
  policy?: GovernancePolicy;
  onlineScanner?: OnlineScanner;
}

export interface AuditRunOptions {
  scope: AuditScope;
  confirm?: boolean;
  online?: boolean;
  /** Persist findings to .ano/audit/findings.json (default true). */
  persist?: boolean;
  context?: AuditContext;
  sink?: AuditEventSink;
  now?: () => number;
}

export interface AuditEvent {
  schema: 'ano.audit.event.v1';
  type: 'finding' | 'summary';
  scope: AuditScope;
  root: string;
  at: string;
  finding?: AuditFinding;
  summary?: AuditSummary;
  ok?: boolean;
}

export interface AuditEventSink {
  record(event: AuditEvent): void | Promise<void>;
}

export class AuditNetworkRefusedError extends Error {
  readonly code = 'AUDIT_NETWORK_CONFIRM_REQUIRED';
  constructor(message = 'Network-backed audit requires confirm=true; the default is deny') {
    super(message);
    this.name = 'AuditNetworkRefusedError';
  }
}

export class AuditInputError extends Error {
  readonly code = 'AUDIT_INVALID_INPUT';
  constructor(message: string) {
    super(message);
    this.name = 'AuditInputError';
  }
}
