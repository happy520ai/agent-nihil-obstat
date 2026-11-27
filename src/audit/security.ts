import type { AuditFinding, AuditSeverity } from './types.ts';
import { listProjectFiles, makeFinding, readTextFile, sha256, sortFindings } from './util.ts';

interface ScanRule {
  id: string;
  severity: AuditSeverity;
  description: string;
  pattern: RegExp;
  /** Capture group that carries the value whose hash becomes the fingerprint. */
  valueGroup?: number;
  rejectValue?: (value: string) => boolean;
}

function placeholder(value: string): boolean {
  const lower = value.trim().toLowerCase();
  if (!lower) return true;
  if (/^(?:\$|<|\{|process\.env|import\.meta)/.test(lower)) return true;
  if (lower.includes('process.env') || lower.includes('${') || lower.includes('{{') || lower.includes('<')) return true;
  return /^(?:x{3,}|\*{3,}|\.{3,}|changeme|change-me|placeholder|example|sample|dummy|redacted|todo|fixme|none|null|undefined)$/.test(lower);
}

const SECRET_RULES: ScanRule[] = [
  {
    id: 'secret/private-key',
    severity: 'high',
    description: 'Private key material is present',
    pattern: /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY(?: BLOCK)?-----/g,
  },
  {
    id: 'secret/aws-access-key-id',
    severity: 'high',
    description: 'AWS access key id pattern is present',
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
  },
  {
    id: 'secret/aws-secret-access-key',
    severity: 'high',
    description: 'AWS secret access key assignment is present',
    pattern: /(?:aws_?)?secret_?access_?key\s*[:=]\s*["']?([A-Za-z0-9/+=]{32,})/gi,
    valueGroup: 1,
    rejectValue: placeholder,
  },
  {
    id: 'secret/github-token',
    severity: 'high',
    description: 'GitHub token pattern is present',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  },
  {
    id: 'secret/slack-token',
    severity: 'high',
    description: 'Slack token pattern is present',
    pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  },
  {
    id: 'secret/stripe-key',
    severity: 'high',
    description: 'Stripe key pattern is present',
    pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  },
  {
    id: 'secret/jwt',
    severity: 'medium',
    description: 'JWT-shaped credential is present',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  },
  {
    id: 'secret/generic-credential',
    severity: 'high',
    description: 'Credential-like assignment has a literal value',
    pattern: /\b(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|secret)\b\s*[:=]\s*["']([^"'\r\n]{8,})["']/gi,
    valueGroup: 1,
    rejectValue: placeholder,
  },
  {
    id: 'secret/env-literal',
    severity: 'high',
    description: 'Environment file contains a literal secret',
    pattern: /^(?:export\s+)?[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE_KEY)[A-Z0-9_]*\s*=\s*([^\s#"']{8,})\s*$/g,
    valueGroup: 1,
    rejectValue: (value) => placeholder(value) || value.startsWith('/') || value.startsWith('$'),
  },
];

const DANGEROUS_RULES: ScanRule[] = [
  { id: 'danger/eval', severity: 'medium', description: 'Dynamic code evaluation is used', pattern: /\beval\s*\(/g },
  { id: 'danger/new-function', severity: 'medium', description: 'Runtime code construction is used', pattern: /\bnew\s+Function\s*\(/g },
  { id: 'danger/shell-exec', severity: 'low', description: 'Shell/process execution helper is used', pattern: /\b(?:exec|execSync|execFile|execFileSync|spawnSync)\s*\(/g },
  { id: 'danger/tls-verification-disabled', severity: 'high', description: 'TLS certificate verification is disabled', pattern: /rejectUnauthorized\s*:\s*false/g },
  { id: 'danger/tls-env-disabled', severity: 'high', description: 'TLS verification is disabled through the environment', pattern: /NODE_TLS_REJECT_UNAUTHORIZED\s*[:=]\s*['"]?0/g },
  { id: 'danger/rm-rf-root', severity: 'high', description: 'Recursive deletion targets a root or home path', pattern: /\brm\s+-rf\s+(?:\/|~|\$HOME)(?:\s|$)/g },
  { id: 'danger/remote-pipe-shell', severity: 'high', description: 'Remote content is piped to a shell', pattern: /\b(?:curl|wget)\b[^|\r\n]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/g },
];

export interface SecurityScanResult {
  findings: AuditFinding[];
  files: number;
  degraded: string[];
}

const MAX_FINDINGS = 1000;

function matches(rule: ScanRule, line: string): Array<{ index: number; value: string }> {
  const pattern = new RegExp(rule.pattern.source, rule.pattern.flags.includes('g') ? rule.pattern.flags : `${rule.pattern.flags}g`);
  const result: Array<{ index: number; value: string }> = [];
  for (const match of line.matchAll(pattern)) {
    const raw = rule.valueGroup === undefined ? match[0] : match[rule.valueGroup];
    if (raw === undefined) continue;
    if (rule.rejectValue?.(raw)) continue;
    result.push({ index: match.index ?? 0, value: raw });
  }
  return result;
}

/**
 * Offline secret and dangerous-pattern scan. The matched value is hashed and
 * immediately discarded; the finding carries only the hash + location.
 */
export async function scanSecurity(root: string): Promise<SecurityScanResult> {
  const degraded: string[] = [];
  const files = await listProjectFiles(root, { onError: (path, error) => {
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'UNKNOWN';
    degraded.push(`walk-error:${path}:${code}`);
  } });
  const findings: AuditFinding[] = [];
  let scanned = 0;
  for (const file of files) {
    const read = await readTextFile(file);
    if (read.degraded) { degraded.push(read.degraded); continue; }
    if (read.text === undefined) continue;
    scanned += 1;
    const lines = read.text.split(/\r?\n/);
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex]!;
      if (!line) continue;
      for (const rule of [...SECRET_RULES, ...DANGEROUS_RULES]) {
        for (const match of matches(rule, line)) {
          findings.push(makeFinding({
            scope: 'security',
            rule: rule.id,
            severity: rule.severity,
            message: rule.description,
            fingerprint: sha256(match.value),
            path: file.path,
            line: lineIndex + 1,
            column: match.index + 1,
          }));
          if (findings.length >= MAX_FINDINGS) {
            degraded.push('finding-cap-reached');
            return { findings: sortFindings(findings), files: scanned, degraded: [...new Set(degraded)].sort() };
          }
        }
      }
    }
  }
  return { findings: sortFindings(findings), files: scanned, degraded: [...new Set(degraded)].sort() };
}

/** Exposed for unit tests; all rules are local regular expressions, never a network call. */
export const securityRules = { secrets: SECRET_RULES.map((rule) => rule.id), dangerous: DANGEROUS_RULES.map((rule) => rule.id) };
