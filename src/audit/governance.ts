import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { AuditFinding, AuditGraphEdge, AuditGraphView, AuditModulePolicy, GovernancePolicy } from './types.ts';
import { assertSafeRelativePath, makeFinding, sha256, sortFindings } from './util.ts';

const moduleSchema = z.object({
  id: z.string().min(1).max(128),
  roots: z.array(z.string().min(1).max(512)).min(1),
  kind: z.string().max(64).optional(),
  dependsOn: z.array(z.string().min(1).max(128)).optional(),
  allowedDependencies: z.array(z.string().min(1).max(128)).optional(),
  deniedDependencies: z.array(z.string().min(1).max(128)).optional(),
}).strict();

const policySchema = z.object({
  schemaVersion: z.number().int().positive().optional(),
  modules: z.array(moduleSchema),
  policies: z.object({
    enforceDeclaredDependencies: z.boolean().optional(),
    failOnCycles: z.boolean().optional(),
  }).strict().optional(),
}).strict();

export interface LoadedPolicy {
  policy?: GovernancePolicy;
  source?: string;
  degraded: string[];
}

export async function loadGovernancePolicy(root: string): Promise<LoadedPolicy> {
  const degraded: string[] = [];
  for (const relative of ['.ano/governance.json', '.pm/governance.json']) {
    try {
      const raw = JSON.parse(await readFile(join(root, ...relative.split('/')), 'utf8')) as unknown;
      const parsed = policySchema.safeParse(raw);
      if (!parsed.success) { degraded.push(`policy-invalid:${relative}`); continue; }
      return { policy: parsed.data as unknown as GovernancePolicy, source: relative, degraded };
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'UNKNOWN';
      if (code !== 'ENOENT') degraded.push(`policy-unreadable:${relative}:${code}`);
    }
  }
  return { degraded };
}

function moduleForPath(policy: GovernancePolicy, path: string): AuditModulePolicy | undefined {
  let best: AuditModulePolicy | undefined;
  let bestLength = -1;
  for (const module of policy.modules) {
    for (const root of module.roots) {
      const prefix = root.endsWith('/') ? root : `${root}/`;
      if (path === root || path.startsWith(prefix)) {
        const length = root.length;
        if (length > bestLength) { best = module; bestLength = length; }
      }
    }
  }
  return best;
}

function allowedFor(module: AuditModulePolicy): string[] | undefined {
  return module.allowedDependencies ?? module.dependsOn;
}

/** Tarjan SCC; returns components with more than one module (or a self-loop). */
function stronglyConnected(nodes: readonly string[], edges: ReadonlyMap<string, ReadonlySet<string>>): string[][] {
  let next = 0;
  const indices = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];
  const visit = (node: string): void => {
    indices.set(node, next);
    lowlink.set(node, next);
    next += 1;
    stack.push(node);
    onStack.add(node);
    for (const target of edges.get(node) ?? []) {
      if (!indices.has(target)) {
        visit(target);
        lowlink.set(node, Math.min(lowlink.get(node)!, lowlink.get(target)!));
      } else if (onStack.has(target)) {
        lowlink.set(node, Math.min(lowlink.get(node)!, indices.get(target)!));
      }
    }
    if (lowlink.get(node) === indices.get(node)) {
      const component: string[] = [];
      let current: string | undefined;
      do {
        current = stack.pop();
        if (current === undefined) break;
        onStack.delete(current);
        component.push(current);
      } while (current !== node);
      if (component.length > 1) components.push(component.sort());
    }
  };
  for (const node of nodes) if (!indices.has(node)) visit(node);
  return components.sort((a, b) => a.join(',').localeCompare(b.join(',')));
}

export interface GovernanceScanResult {
  findings: AuditFinding[];
  modules: number;
  edges: number;
  policySource?: string;
  degraded: string[];
}

/**
 * Graph-driven governance. The graph and policy are injectable structural
 * values (see AuditContext), so this scan never maintains a second semantic graph.
 */
export function scanGovernance(
  graph: AuditGraphView | undefined,
  loaded: LoadedPolicy,
  options: { policy?: GovernancePolicy } = {},
): GovernanceScanResult {
  const degraded = [...loaded.degraded];
  const policy = options.policy ?? loaded.policy;
  if (!graph) {
    return {
      findings: [makeFinding({
        scope: 'governance',
        rule: 'governance/graph-missing',
        severity: 'info',
        message: 'No structure graph was injected; governance could not evaluate module boundaries',
        fingerprint: sha256('governance:graph-missing'),
      })],
      modules: policy?.modules.length ?? 0,
      edges: 0,
      ...(loaded.source ? { policySource: loaded.source } : {}),
      degraded: [...new Set([...degraded, 'graph-unavailable'])].sort(),
    };
  }
  const snapshot = graph.snapshot();
  if (!policy) {
    return {
      findings: [makeFinding({
        scope: 'governance',
        rule: 'governance/policy-missing',
        severity: 'info',
        message: 'No .ano/governance.json or .pm/governance.json policy is present; module rules were not evaluated',
        fingerprint: sha256('governance:policy-missing'),
      })],
      modules: 0,
      edges: snapshot.edges.length,
      degraded: [...new Set([...degraded, 'policy-missing'])].sort(),
    };
  }

  for (const module of policy.modules) {
    for (const root of module.roots) {
      try { assertSafeRelativePath(root); }
      catch { degraded.push(`policy-root-invalid:${module.id}:${root}`); }
    }
  }
  const enforceDeclared = policy.policies?.enforceDeclaredDependencies !== false;
  const failOnCycles = policy.policies?.failOnCycles !== false;
  const findings: AuditFinding[] = [];
  const reported = new Set<string>();
  const moduleEdges = new Map<string, Set<string>>();
  for (const module of policy.modules) moduleEdges.set(module.id, new Set());

  const evaluate = (edge: AuditGraphEdge): void => {
    const from = moduleForPath(policy, edge.from);
    const to = moduleForPath(policy, edge.to);
    if (!from || !to || from.id === to.id) return;
    moduleEdges.get(from.id)?.add(to.id);
    const pair = `${from.id}->${to.id}`;
    if (from.deniedDependencies?.includes(to.id)) {
      const key = `denied:${pair}`;
      if (!reported.has(key)) {
        reported.add(key);
        findings.push(makeFinding({
          scope: 'governance',
          rule: 'governance/denied-dependency',
          severity: 'high',
          message: `${from.id} must not depend on ${to.id}`,
          fingerprint: sha256(`denied:${pair}`),
          path: edge.from,
        }));
      }
    }
    const allowed = allowedFor(from);
    if (enforceDeclared && allowed && !allowed.includes(to.id)) {
      const key = `undeclared:${pair}`;
      if (!reported.has(key)) {
        reported.add(key);
        findings.push(makeFinding({
          scope: 'governance',
          rule: 'governance/undeclared-dependency',
          severity: 'medium',
          message: `${from.id} depends on ${to.id} without declaring it (allowed: ${allowed.join(', ') || 'none'})`,
          fingerprint: sha256(`undeclared:${pair}`),
          path: edge.from,
        }));
      }
    }
  };
  for (const edge of snapshot.edges) evaluate(edge);

  if (failOnCycles) {
    for (const component of stronglyConnected([...moduleEdges.keys()], moduleEdges)) {
      const key = `cycle:${component.join(',')}`;
      findings.push(makeFinding({
        scope: 'governance',
        rule: 'governance/module-cycle',
        severity: 'high',
        message: `Cyclic module dependency: ${component.join(' -> ')}`,
        fingerprint: sha256(key),
      }));
    }
  }

  const caveats = snapshot.caveats;
  if ((caveats?.unknownRatio ?? 0) > 0.5) {
    findings.push(makeFinding({
      scope: 'governance',
      rule: 'governance/low-confidence',
      severity: 'low',
      message: `More than half of graph edges are unknown (ratio ${(caveats?.unknownRatio ?? 0).toFixed(2)}); boundary findings may be incomplete`,
      fingerprint: sha256(`governance:unknown-ratio:${caveats?.unknownRatio ?? 0}`),
    }));
  }
  for (const reason of caveats?.degradedReasons ?? []) degraded.push(`graph-degraded:${reason}`);

  return {
    findings: sortFindings(findings),
    modules: policy.modules.length,
    edges: snapshot.edges.length,
    ...(loaded.source ? { policySource: loaded.source } : {}),
    degraded: [...new Set(degraded)].sort(),
  };
}
