import { z } from 'zod';

const root = z.string().min(1).optional();
const idempotencyKey = z.string().min(1).max(128);

/**
 * AP-13 strict branch extensions. Every tool keeps one object schema (the MCP
 * SDK only advertises object schemas in `tools/list`), so the new branches are
 * optional fields plus `superRefine` cross-field rules. Legacy calls without
 * the new fields keep their exact validation and result shapes; a call that
 * mixes legacy and branch-only fields is rejected instead of silently ignoring
 * half of its input.
 */

const noteAnchor = z.object({
  file: z.string().min(1),
  symbol_id: z.string().min(1).optional(),
  qualified_name: z.string().min(1).optional(),
  content_fragment_hash: z.string().min(1).optional(),
}).strict();

const noteSchema = z.object({
  root, idem_key: idempotencyKey,
  kind: z.enum(['decision', 'pitfall', 'memory', 'session_summary']).optional(),
  text: z.string().min(1).optional(),
  anchor: noteAnchor.optional(),
  operation: z.enum(['revise', 'relate']).optional(),
  fact_key: z.string().min(1).max(128).optional(),
  supersedes: z.array(z.string().min(1).max(64)).max(1).optional(),
  reason: z.string().min(1).max(2000).optional(),
  effective_from: z.string().datetime().nullable().optional(),
  effective_to: z.string().datetime().nullable().optional(),
  edge: z.enum(['depends_on', 'explains', 'related_to']).optional(),
  from_ref: z.string().min(1).max(64).optional(),
  to_ref: z.string().min(1).max(64).optional(),
}).strict().superRefine((value, context) => {
  if (value.operation === 'revise') {
    if (value.kind === undefined) context.addIssue({ code: 'custom', path: ['kind'], message: 'revise requires a fact kind (decision|pitfall|memory)' });
    if (value.kind === 'session_summary') context.addIssue({ code: 'custom', path: ['kind'], message: 'session_summary cannot be governed as a fact' });
    if (value.text === undefined) context.addIssue({ code: 'custom', path: ['text'], message: 'revise requires text' });
    if (!value.fact_key) context.addIssue({ code: 'custom', path: ['fact_key'], message: 'revise requires fact_key' });
    if (value.supersedes === undefined) context.addIssue({ code: 'custom', path: ['supersedes'], message: 'revise requires an explicit supersedes array ([] declares a genesis version)' });
    if (value.reason === undefined) context.addIssue({ code: 'custom', path: ['reason'], message: 'revise requires reason' });
    if (value.effective_from === undefined || value.effective_to === undefined) context.addIssue({ code: 'custom', path: ['effective_from'], message: 'revise requires explicit effective_from and effective_to' });
    if (value.edge !== undefined || value.from_ref !== undefined || value.to_ref !== undefined) context.addIssue({ code: 'custom', path: ['edge'], message: 'relate fields are not allowed for revise' });
    return;
  }
  if (value.operation === 'relate') {
    if (!value.edge) context.addIssue({ code: 'custom', path: ['edge'], message: 'relate requires edge' });
    if (!value.from_ref) context.addIssue({ code: 'custom', path: ['from_ref'], message: 'relate requires from_ref' });
    if (!value.to_ref) context.addIssue({ code: 'custom', path: ['to_ref'], message: 'relate requires to_ref' });
    for (const key of ['kind', 'text', 'anchor', 'fact_key', 'supersedes', 'effective_from', 'effective_to'] as const) {
      if (value[key] !== undefined) context.addIssue({ code: 'custom', path: [key], message: `${key} is not allowed for relate` });
    }
    return;
  }
  // Legacy record branch: unchanged behaviour, and branch-only fields are
  // rejected so a caller cannot half-opt into revise/relate.
  for (const key of ['fact_key', 'supersedes', 'reason', 'effective_from', 'effective_to', 'edge', 'from_ref', 'to_ref'] as const) {
    if (value[key] !== undefined) context.addIssue({ code: 'custom', path: [key], message: `${key} requires operation revise or relate` });
  }
  if (value.kind === undefined) context.addIssue({ code: 'custom', path: ['kind'], message: 'kind is required' });
  if (value.text === undefined) context.addIssue({ code: 'custom', path: ['text'], message: 'text is required' });
  if (value.kind !== 'session_summary' && !value.anchor) context.addIssue({ code: 'custom', path: ['anchor'], message: 'Decision, pitfall and memory require an anchor' });
  if (value.kind === 'session_summary' && value.anchor) context.addIssue({ code: 'custom', path: ['anchor'], message: 'Session summary must not carry an anchor' });
});

const probeBudget = z.object({
  max_candidates: z.number().int().positive().max(10_000).optional(),
  max_nodes: z.number().int().positive().max(10_000).optional(),
  max_depth: z.number().int().positive().max(100).optional(),
}).strict();

const recallSchema = z.object({
  root,
  session: z.string().min(1).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  file: z.string().min(1).optional(),
  symbol: z.string().min(1).optional(),
  keyword: z.string().min(1).optional(),
  provider: z.string().min(1).optional(),
  query: z.string().min(1).optional(),
  limit: z.number().int().positive().max(100).optional(),
  source: z.enum(['connected']).optional(),
  mode: z.enum(['probe']).optional(),
  project_scope: z.string().min(1).max(128).optional(),
  requirements: z.array(z.string().min(1).max(128)).max(256).optional(),
  temporal_mode: z.enum(['CURRENT', 'AS_OF', 'HISTORICAL']).optional(),
  as_of: z.string().datetime().optional(),
  budget: probeBudget.optional(),
}).strict().superRefine((value, context) => {
  const probeOnly = ['project_scope', 'requirements', 'temporal_mode', 'as_of', 'budget'] as const;
  if (value.mode === 'probe') {
    if (!value.project_scope) context.addIssue({ code: 'custom', path: ['project_scope'], message: 'probe requires project_scope' });
    if (!value.query && !(value.requirements?.length)) context.addIssue({ code: 'custom', path: ['query'], message: 'probe requires query or requirements' });
    for (const key of ['session', 'from', 'to', 'file', 'symbol', 'keyword', 'provider', 'source', 'limit'] as const) {
      if (value[key] !== undefined) context.addIssue({ code: 'custom', path: [key], message: `${key} is a legacy recall field and cannot be mixed with mode=probe` });
    }
    return;
  }
  for (const key of probeOnly) {
    if (value[key] !== undefined) context.addIssue({ code: 'custom', path: [key], message: `${key} requires mode=probe` });
  }
});

const briefSchema = z.object({
  root,
  include_memory_context: z.literal(true).optional(),
  context_budget: z.number().int().positive().max(10_000).optional(),
}).strict().superRefine((value, context) => {
  if (value.context_budget !== undefined && value.include_memory_context !== true) {
    context.addIssue({ code: 'custom', path: ['context_budget'], message: 'context_budget requires include_memory_context=true' });
  }
});

const verifySchema = z.object({
  root, idem_key: idempotencyKey,
  scope: z.enum(['task', 'release', 'context']),
  task_id: z.string().min(1).optional(), argv: z.array(z.string()).min(1).optional(), test_files: z.array(z.string().min(1)).min(1).optional(),
  // Opt-in task-only coverage tier. Absent keeps the T1 strict default; T0 is
  // explicitly requested per maintenance task and is never available to
  // release/context verification.
  tier: z.enum(['T0', 'T1']).optional(),
  target: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u).optional(), profiles: z.array(z.enum(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'])).min(1).optional(),
  /** A real artifact to hash locally; caller-provided hashes are not evidence. */
  artifact_path: z.string().min(1).optional(),
  // AP-13 context branch: the manifest is read server-side by context_id, so
  // the caller never supplies the manifest bytes or a Gate evidence id.
  context_id: z.string().min(1).max(128).optional(),
  project_scope: z.string().min(1).max(128).optional(),
  draft: z.record(z.string(), z.unknown()).optional(),
}).strict().superRefine((value, context) => {
  if (value.scope === 'task') {
    if (!value.task_id || !value.argv?.length || !value.test_files?.length) context.addIssue({ code: 'custom', message: 'Task verification requires task_id, argv and actual test_files' });
    if (value.target !== undefined || value.profiles !== undefined) context.addIssue({ code: 'custom', message: 'Release fields are not allowed for task verification' });
    for (const key of ['context_id', 'project_scope', 'draft'] as const) {
      if (value[key] !== undefined) context.addIssue({ code: 'custom', path: [key], message: 'Context fields are not allowed for task verification' });
    }
    return;
  }
  if (value.scope === 'release') {
    if (!value.target || !value.profiles?.length || !value.artifact_path) context.addIssue({ code: 'custom', message: 'Release verification requires target, profiles and a real artifact_path' });
    if (value.task_id !== undefined || value.argv !== undefined || value.test_files !== undefined) context.addIssue({ code: 'custom', message: 'Task fields are not allowed for release verification' });
    if (value.tier !== undefined) context.addIssue({ code: 'custom', path: ['tier'], message: 'tier is only allowed for task verification' });
    for (const key of ['context_id', 'project_scope', 'draft'] as const) {
      if (value[key] !== undefined) context.addIssue({ code: 'custom', path: [key], message: 'Context fields are not allowed for release verification' });
    }
    return;
  }
  if (!value.context_id) context.addIssue({ code: 'custom', path: ['context_id'], message: 'Context verification requires context_id' });
  if (!value.project_scope) context.addIssue({ code: 'custom', path: ['project_scope'], message: 'Context verification requires project_scope' });
  if (value.draft === undefined) context.addIssue({ code: 'custom', path: ['draft'], message: 'Context verification requires a structured draft' });
  if (value.tier !== undefined) context.addIssue({ code: 'custom', path: ['tier'], message: 'tier is only allowed for task verification' });
  for (const key of ['task_id', 'argv', 'test_files', 'target', 'profiles', 'artifact_path'] as const) {
    if (value[key] !== undefined) context.addIssue({ code: 'custom', path: [key], message: 'Task/release fields are not allowed for context verification' });
  }
});

const taskOperations = ['create', 'update', 'complete', 'cancel', 'reopen'] as const;
const connectionOperations = ['plan', 'connect', 'status', 'export', 'handoff', 'migrate_plan', 'migrate_apply', 'reconcile'] as const;
// T-072: the takeover lifecycle is a strict branch of `track`, mirroring the
// connection branch. It is not an eighth tool.
const takeoverOperations = ['grant', 'apply', 'status', 'recover', 'disable', 'revoke'] as const;
const takeoverScopeValues = ['tasks', 'memory', 'acceptance', 'dag'] as const;
const takeoverPayloadKeys = ['scope', 'granted_by', 'role', 'statement', 'authorization_id', 'confirm'] as const;
const taskPayloadKeys = ['id', 'title', 'files', 'status', 'evidence_id'] as const;
const connectionPayloadKeys = ['expected_digest', 'expected_source_digest', 'on_conflict'] as const;
const sha256 = /^[0-9a-f]{64}$/iu;
const trackSchema = z.object({
  root, idem_key: idempotencyKey,
  kind: z.enum(['task', 'milestone', 'checkpoint', 'feature', 'connection', 'takeover']),
  operation: z.enum([...taskOperations, ...connectionOperations, ...takeoverOperations]),
  payload: z.record(z.string(), z.unknown()),
}).strict().superRefine((value, context) => {
  if (value.kind === 'connection') {
    if (!(connectionOperations as readonly string[]).includes(value.operation)) {
      context.addIssue({ code: 'custom', path: ['operation'], message: `connection kind requires operation ${connectionOperations.join('|')}` });
    }
    for (const key of Object.keys(value.payload)) {
      if (!(connectionPayloadKeys as readonly string[]).includes(key)) {
        context.addIssue({ code: 'custom', path: ['payload', key], message: `connection payload does not accept field ${JSON.stringify(key)}` });
      }
    }
    const digest = value.payload.expected_digest;
    if (digest !== undefined && (typeof digest !== 'string' || digest.length === 0)) {
      context.addIssue({ code: 'custom', path: ['payload', 'expected_digest'], message: 'connection payload.expected_digest must be a non-empty string' });
    }
    const sourceDigest = value.payload.expected_source_digest;
    if (sourceDigest !== undefined && (typeof sourceDigest !== 'string' || !sha256.test(sourceDigest))) {
      context.addIssue({ code: 'custom', path: ['payload', 'expected_source_digest'], message: 'expected_source_digest must be a 64-character sha256 hex digest' });
    }
    if (value.operation === 'migrate_apply' && (typeof sourceDigest !== 'string' || !sha256.test(sourceDigest))) {
      context.addIssue({ code: 'custom', path: ['payload', 'expected_source_digest'], message: 'migrate_apply requires the expected_source_digest from a prior migrate_plan' });
    }
    if (value.payload.on_conflict !== undefined && value.payload.on_conflict !== 'skip') {
      context.addIssue({ code: 'custom', path: ['payload', 'on_conflict'], message: 'on_conflict only accepts "skip"' });
    }
    return;
  }
  if (value.kind === 'takeover') {
    if (!(takeoverOperations as readonly string[]).includes(value.operation)) {
      context.addIssue({ code: 'custom', path: ['operation'], message: `takeover kind requires operation ${takeoverOperations.join('|')}` });
    }
    for (const key of Object.keys(value.payload)) {
      if (!(takeoverPayloadKeys as readonly string[]).includes(key)) {
        context.addIssue({ code: 'custom', path: ['payload', key], message: `takeover payload does not accept field ${JSON.stringify(key)}` });
      }
    }
    const confirm = value.payload.confirm;
    if (confirm !== undefined && confirm !== true) {
      context.addIssue({ code: 'custom', path: ['payload', 'confirm'], message: 'takeover confirm must be the literal true' });
    }
    if (['apply', 'recover', 'disable', 'revoke'].includes(value.operation) && confirm !== true) {
      context.addIssue({ code: 'custom', path: ['payload', 'confirm'], message: `${value.operation} requires payload.confirm=true` });
    }
    if (value.operation === 'grant') {
      const scope = value.payload.scope;
      const validScope = Array.isArray(scope)
        && scope.length > 0
        && scope.length <= takeoverScopeValues.length
        && scope.every((entry) => typeof entry === 'string' && (takeoverScopeValues as readonly string[]).includes(entry))
        && new Set(scope).size === scope.length;
      if (!validScope) {
        context.addIssue({ code: 'custom', path: ['payload', 'scope'], message: 'grant requires an explicit unique scope subset of tasks|memory|acceptance|dag' });
      }
      for (const key of ['granted_by', 'role', 'statement'] as const) {
        const entry = value.payload[key];
        if (typeof entry !== 'string' || entry.length === 0) {
          context.addIssue({ code: 'custom', path: ['payload', key], message: `grant requires payload.${key}` });
        }
      }
    } else {
      for (const key of ['scope', 'granted_by', 'role', 'statement'] as const) {
        if (value.payload[key] !== undefined) context.addIssue({ code: 'custom', path: ['payload', key], message: `${key} is only allowed for grant` });
      }
    }
    if (value.operation !== 'apply' && value.payload.authorization_id !== undefined) {
      context.addIssue({ code: 'custom', path: ['payload', 'authorization_id'], message: 'authorization_id is only allowed for apply' });
    }
    if (value.operation === 'apply') {
      const authorizationId = value.payload.authorization_id;
      if (typeof authorizationId !== 'string' || !sha256.test(authorizationId)) {
        context.addIssue({ code: 'custom', path: ['payload', 'authorization_id'], message: 'apply requires the 64-character authorization_id' });
      }
    }
    return;
  }
  if (value.kind !== 'task') {
    context.addIssue({ code: 'custom', path: ['kind'], message: `${value.kind} kind is not implemented; no mutation was performed.` });
    return;
  }
  if (!(taskOperations as readonly string[]).includes(value.operation)) {
    context.addIssue({ code: 'custom', path: ['operation'], message: `task kind requires operation ${taskOperations.join('|')}` });
  }
  for (const key of Object.keys(value.payload)) {
    if (!(taskPayloadKeys as readonly string[]).includes(key)) {
      context.addIssue({ code: 'custom', path: ['payload', key], message: `task payload does not accept field ${JSON.stringify(key)}` });
    }
  }
  const id = value.payload.id;
  if (value.operation !== 'create' && (typeof id !== 'string' || id.length === 0)) {
    context.addIssue({ code: 'custom', path: ['payload', 'id'], message: 'task payload.id must be a non-empty string' });
  }
  if (value.operation === 'create') return;
  const status = value.payload.status;
  if (status !== undefined) {
    if (!['todo', 'in_progress', 'done', 'cancelled'].includes(String(status))) {
      context.addIssue({ code: 'custom', path: ['payload', 'status'], message: 'invalid task status' });
    } else if (status === 'done' && value.operation !== 'complete') {
      context.addIssue({ code: 'custom', path: ['payload', 'status'], message: 'done requires operation complete with a recorded Gate evidence_id' });
    }
  }
  if (value.operation === 'complete') {
    const evidence = value.payload.evidence_id;
    if (typeof evidence !== 'string' || evidence.length === 0) {
      context.addIssue({ code: 'custom', path: ['payload', 'evidence_id'], message: 'complete requires the evidence_id of a recorded Gate verdict' });
    }
  }
  if (value.operation === 'update' && status === undefined) {
    context.addIssue({ code: 'custom', path: ['payload', 'status'], message: 'task update requires a non-done status' });
  }
});

export const toolCatalog = [
  { name: 'brief', access: 'read', summary: '恢复项目焦点、断点、锚定知识和缓存新鲜度；附带 Connect 接入状态；接管项目附主写/权限/下一步（ADR-006 §5）。', input: briefSchema },
  { name: 'explore', access: 'read', summary: '返回符号、调用路径、影响范围及结构降级说明；文件级 outline/impact 查询与九类覆盖分类经结构分析投影提供（ADR-010）。', input: z.object({ root, query: z.string().min(1), budget: z.number().int().positive().optional() }).strict() },
  { name: 'recall', access: 'read', summary: '按固定结构化条件检索合成会话历史；source=connected 时检索已接入的 pm-mcp 记录，不执行脚本、不自动记录为 note；结果附接管状态（只读）。', input: recallSchema },
  { name: 'track', access: 'write', summary: '管理原生任务（create/update/complete/cancel/reopen；complete 必须携带已记录的 Gate evidence_id）与 Connect 接入（plan/connect/status/export/handoff）及 PM→ANO 迁移（migrate_plan/migrate_apply/reconcile，写操作幂等）；接管生命周期 grant/apply/status/recover/disable/revoke（apply/recover/disable/revoke 必须显式 confirm=true）；接管项目按策略路由（enforced=ANO 主写，recovery 拒绝写）。', input: trackSchema },
  { name: 'note', access: 'write', summary: '记录带 Anchor 的 Decision、Pitfall、Memory 或会话摘要到账本；接管项目按策略路由（enforced=ANO 主写，recovery 拒绝写）。', input: noteSchema },
  { name: 'verify', access: 'write', summary: '采集外部执行证据并计算任务或发布裁决，不代替人工放行。', input: verifySchema },
  { name: 'audit', access: 'read+findings', summary: '执行本地漂移、安全、许可证、治理或依赖审计；Finding 只存指纹与位置，联网需 confirm=true。', input: z.object({ root, idem_key: idempotencyKey, scope: z.enum(['drift', 'security', 'license', 'governance', 'deps']), confirm: z.literal(true).optional(), online: z.boolean().optional() }).strict() },
] as const;

/** Personal-mode descriptions answer "when to call"; input schemas stay identical. */
export const personalToolSummaries: Readonly<Record<(typeof toolCatalog)[number]['name'], string>> = {
  brief: '开工时先调用：恢复焦点任务、断点、未解决检查、最近会话和记忆新鲜度。',
  explore: '改代码前调用：查询符号、调用路径和影响范围，避免未检查就编辑。',
  recall: '需要旧决策、踩坑或历史会话时调用：按文件、符号、关键词或已接入来源只读检索。',
  track: '任务有进展、需要断点或完成时调用：complete 必须携带已记录的 Gate evidence_id。',
  note: '形成决策、发现踩坑或需要跨会话记住事实时调用：写入带 Anchor 的持久记忆。',
  verify: '声称任务完成前调用：执行真实测试命令并取得 Gate 裁决与 evidence_id。',
  audit: '需要检查漂移、安全、许可证、治理或依赖风险时调用：默认本地只读。',
};

export function toolCatalogForProfile(profile: 'personal' | 'full'): typeof toolCatalog {
  if (profile === 'full') return toolCatalog;
  return toolCatalog.map((tool) => ({ ...tool, summary: personalToolSummaries[tool.name] })) as unknown as typeof toolCatalog;
}

export const cliCommands = ['init', 'doctor', 'doctor clients', 'doctor client', 'clients plan', 'clients install', 'clients restore', 'rebuild', 'migrate', 'takeover', 'baseline', 'attest', 'release approve', 'sync', 'ui', 'export', 'connect'] as const;
export const humanOnlyCommands = ['baseline approve', 'attest', 'release approve', 'sync'] as const;
