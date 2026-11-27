import { z } from 'zod';

/**
 * 钩子统一契约层（T-163 / ADR-013 §4.1–§4.2 / 实施规格 T-163）。
 *
 * 本文件只有三类内容：类型、zod `.strict()` schema 和纯函数。
 * 明确禁止 import `node:fs` / `node:child_process`：钩子契约层不读文件、
 * 不访问宿主进程，也不触碰账本；任何 IO 与事件专属的失败渲染属于
 * 适配器与引擎（T-164/T-165/T-166）的职责。
 *
 * `failClosedDecision` 是共享的「绝不静默 allow」核心：它只按 mode 映射
 * advisory→ask、strict→deny，并把降级码与细节写进 `degraded`。它不接收
 * event 参数，因此 session-start/prompt/stop 的 §4.2 失败列（注入提示、
 * 不注入、继续写摘要等）由各自引擎在此原语之上渲染；本原语本身保证
 * 任何错误路径都不会产生 `allow`。
 */

/** 宿主事件的封闭词表（ADR-013 §4.1）。 */
export const HOOK_EVENTS = ['session-start', 'prompt', 'pre-tool', 'stop'] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

/** 钩子模式的封闭词表（个人模式默认 advisory）。 */
export const HOOK_MODES = ['advisory', 'strict'] as const;
export type HookMode = (typeof HOOK_MODES)[number];

/** 降级原因码（实施规格 T-163，ADR-013 §2.7 / §4.3 / §4.4）。 */
export const HOOK_DEGRADED_CODES = [
  'HOOK_INPUT_INVALID',
  'HOOK_ROOT_AMBIGUOUS',
  'HOOK_TIMEOUT',
  'HOOK_INTERNAL',
  'GRAPH_STALE',
  'GRAPH_DEGRADED',
  'UNSUPPORTED_LANGUAGE',
  'NOT_GIT_ROOT',
] as const;
export type HookDegradedCode = (typeof HOOK_DEGRADED_CODES)[number];

/** 由客户端 adapter 归一化后的输入。`hostExtra` 只承载元数据，不参与判定。 */
export interface HookInput {
  event: HookEvent;
  client: string;
  hostSessionId: string;
  cwd: string;
  toolName?: string;
  targetPaths?: string[];
  stopContinuation?: boolean;
  hostExtra?: Record<string, unknown>;
}

/** 全部分支均可附着的降级信息。 */
export interface HookDegraded {
  code: HookDegradedCode;
  detail: string;
}

type WithDegraded = { degraded?: HookDegraded };

/** 统一的钩子决定类型（ADR-013 §4.1）。 */
export type HookDecision =
  | ({ kind: 'context'; additionalContext: string } & WithDegraded)
  | ({ kind: 'allow' } & WithDegraded)
  | ({ kind: 'ask'; reason: string } & WithDegraded)
  | ({ kind: 'deny'; reason: string; remedy: string } & WithDegraded)
  | ({ kind: 'continue'; reason: string; checklist: string[] } & WithDegraded)
  | ({ kind: 'stop-ok' } & WithDegraded);

// ---------------------------------------------------------------------------
// 严格 schema：未知顶层字段被拒绝；必填字段缺失被拒绝；枚举值受封闭词表约束。
// ---------------------------------------------------------------------------

export const hookEventSchema = z.enum(HOOK_EVENTS);
export const hookModeSchema = z.enum(HOOK_MODES);
export const hookDegradedCodeSchema = z.enum(HOOK_DEGRADED_CODES);

export const hookDegradedSchema = z.object({
  code: hookDegradedCodeSchema,
  detail: z.string(),
}).strict();

export const hookInputSchema = z.object({
  event: hookEventSchema,
  client: z.string().min(1),
  hostSessionId: z.string().min(1),
  cwd: z.string().min(1),
  toolName: z.string().optional(),
  targetPaths: z.array(z.string()).optional(),
  stopContinuation: z.boolean().optional(),
  hostExtra: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const hookDecisionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('context'), additionalContext: z.string(), degraded: hookDegradedSchema.optional() }).strict(),
  z.object({ kind: z.literal('allow'), degraded: hookDegradedSchema.optional() }).strict(),
  z.object({ kind: z.literal('ask'), reason: z.string(), degraded: hookDegradedSchema.optional() }).strict(),
  z.object({ kind: z.literal('deny'), reason: z.string(), remedy: z.string(), degraded: hookDegradedSchema.optional() }).strict(),
  z.object({ kind: z.literal('continue'), reason: z.string(), checklist: z.array(z.string()), degraded: hookDegradedSchema.optional() }).strict(),
  z.object({ kind: z.literal('stop-ok'), degraded: hookDegradedSchema.optional() }).strict(),
]);

/**
 * 失败路径的统一映射（ADR-013 §2.7）：advisory → ask（交给人），
 * strict → deny（阻断工具）。两者都记录 `degraded`，且绝不返回 `allow`。
 */
export function failClosedDecision(mode: HookMode, code: HookDegradedCode, detail: string): HookDecision {
  const degraded: HookDegraded = { code, detail };
  if (mode === 'strict') {
    return {
      kind: 'deny',
      reason: `ANO 钩子降级（${code}）：${detail}`,
      remedy: '请先手动运行 ANO 检查并确认，再继续操作',
      degraded,
    };
  }
  return {
    kind: 'ask',
    reason: `ANO 钩子降级（${code}）：${detail}`,
    degraded,
  };
}
