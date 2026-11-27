/**
 * ZCode hook adapter (T-166 / ADR-013 §4.1 / S8 实测).
 *
 * 字段映射**只**来自 docs/spikes/S8-hooks.md 与 docs/evidence/s8-zcode-hooks.json
 * 的真实 stdin 样本。S8 明确记录：
 * - 所有样本同时含驼峰与 snake_case 两套字段（本适配器两套都读，snake_case 优先）；
 * - 工具事件的路径字段是 `file_path`（Q3），不猜 `filePath` 等别名；
 * - PreToolUse 输出 `hookSpecificOutput.{permissionDecision,permissionDecisionReason}`（Q4）；
 * - SessionStart/UserPromptSubmit 注入走 `hookSpecificOutput.additionalContext`（Q5）；
 * - Stop 继续必须带 `decision:"block"` + `reason` + `systemMessage`（Q6），
 *   仅 `{"continue":true}` 不触发继续；
 * - 宿主异常时忽略输出并继续，fail-closed 必须由 CLI 自己实现（Q7）。
 *
 * 本文件只做归一化与渲染，不读文件、不执行命令、不访问账本。证据等级为
 * `measured`（S8 实测），与 Claude Code 的 `documented` 严格区分。
 */

import {
  type HookDecision,
  type HookEvent,
  type HookInput,
  hookInputSchema,
} from '../contract.ts';

/** 适配器的证据等级：ZCode 为 S8 实测，Claude Code 为公开文档。 */
export type HookAdapterEvidence = 'measured' | 'documented';

/** 适配器渲染结果：stdout 交宿主，exitCode 交宿主进程。 */
export interface HookRenderResult {
  readonly stdout: string;
  readonly exitCode: number;
}

/** 两个客户端适配器共享的最小接口（T-166 允许修改的文件内定义，避免新增文件）。 */
export interface HookAdapter {
  readonly id: string;
  readonly evidence: HookAdapterEvidence;
  /** 把宿主 stdin 原文归一化为统一 HookInput；无法解析时抛错，由 CLI fail-closed。 */
  parse(stdin: string): HookInput;
  /** 把统一决定渲染为宿主 stdout 与退出码。 */
  render(decision: HookDecision, event: HookEvent): HookRenderResult;
}

// ---------------------------------------------------------------------------
// S8 确认的字段词表（不引入未实测的别名）
// ---------------------------------------------------------------------------

/** S8 七事件中执行 ANO 的四个；名称到统一事件的封闭映射。 */
export const ZCODE_HOST_EVENTS: Readonly<Record<string, HookEvent>> = {
  SessionStart: 'session-start',
  UserPromptSubmit: 'prompt',
  PreToolUse: 'pre-tool',
  Stop: 'stop',
};

/** S8 实测的其余事件存在但不进入 ANO 判定，明确拒绝。 */
export const ZCODE_UNHANDLED_HOST_EVENTS = [
  'PermissionRequest',
  'PostToolUse',
  'PostToolUseFailure',
] as const;

/** 由统一事件反查宿主事件名（渲染用）。 */
export function zcodeHostEventName(event: HookEvent): string {
  switch (event) {
    case 'session-start': return 'SessionStart';
    case 'prompt': return 'UserPromptSubmit';
    case 'pre-tool': return 'PreToolUse';
    case 'stop': return 'Stop';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 双字段读取：S8 样本同时含两套字段，snake_case 优先，camelCase 兜底。 */
function dualString(
  record: Record<string, unknown>,
  snake: string,
  camel: string,
): string | undefined {
  const snakeValue = record[snake];
  if (typeof snakeValue === 'string' && snakeValue.length > 0) return snakeValue;
  const camelValue = record[camel];
  if (typeof camelValue === 'string' && camelValue.length > 0) return camelValue;
  return undefined;
}

function dualBoolean(
  record: Record<string, unknown>,
  snake: string,
  camel: string,
): boolean | undefined {
  const snakeValue = record[snake];
  if (typeof snakeValue === 'boolean') return snakeValue;
  const camelValue = record[camel];
  if (typeof camelValue === 'boolean') return camelValue;
  return undefined;
}

/** 从 S8 确认的 `tool_input.file_path` 提取目标路径；其他键不参与判定。 */
function targetPathsOf(toolInput: unknown): string[] | undefined {
  if (!isRecord(toolInput)) return undefined;
  const path = toolInput['file_path'];
  return typeof path === 'string' && path.length > 0 ? [path] : undefined;
}

/**
 * 归一化 ZCode stdin。所有异常都向上抛，由 CLI 统一走 failClosedDecision；
 * 这里不吞错、不返回半成品、不产生 `allow`。
 */
export function parseZcodeStdin(stdin: string): HookInput {
  let raw: unknown;
  try {
    raw = JSON.parse(stdin) as unknown;
  } catch (error) {
    throw new Error(`ZCode hook stdin is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(raw)) throw new Error('ZCode hook stdin must be a JSON object');

  const hostEvent = dualString(raw, 'hook_event_name', 'hookEventName');
  if (hostEvent === undefined) throw new Error('ZCode hook stdin is missing hook_event_name/hookEventName');
  const event = ZCODE_HOST_EVENTS[hostEvent];
  if (event === undefined) {
    throw new Error(`ZCode hook event is not handled by ANO: ${hostEvent}`);
  }

  const hostSessionId = dualString(raw, 'session_id', 'sessionId');
  if (hostSessionId === undefined) throw new Error('ZCode hook stdin is missing session_id/sessionId');

  const cwd = raw['cwd'];
  if (typeof cwd !== 'string' || cwd.length === 0) throw new Error('ZCode hook stdin is missing cwd');

  const hostExtra: Record<string, unknown> = { hostEventName: hostEvent };
  // 只携带 S8 确认的非秘密元数据；prompt/response/tool 内容一概不进入 hostExtra。
  const mode = raw['permission_mode'] ?? raw['mode'];
  if (typeof mode === 'string') hostExtra['permissionMode'] = mode;
  const riskLevel = raw['riskLevel'];
  if (typeof riskLevel === 'string') hostExtra['riskLevel'] = riskLevel;

  const candidate: HookInput = {
    event,
    client: 'zcode',
    hostSessionId,
    cwd,
    hostExtra,
  };

  if (event === 'pre-tool') {
    const toolName = dualString(raw, 'tool_name', 'toolName');
    if (toolName === undefined) throw new Error('ZCode PreToolUse stdin is missing tool_name/toolName');
    candidate.toolName = toolName;
    const paths = targetPathsOf(raw['tool_input'] ?? raw['toolInput']);
    if (paths !== undefined) candidate.targetPaths = paths;
  }

  if (event === 'stop') {
    const active = dualBoolean(raw, 'stop_hook_active', 'stopHookActive');
    if (active !== undefined) candidate.stopContinuation = active;
  }

  // 统一契约是最后一道闸门：严格 schema 拒绝未知顶层字段与缺字段。
  hookInputSchema.parse(candidate);
  return candidate;
}

function json(value: Record<string, unknown>): HookRenderResult {
  return { stdout: `${JSON.stringify(value)}\n`, exitCode: 0 };
}

/**
 * 渲染 ZCode stdout。PreToolUse 使用 S8 的 permissionDecision 契约；
 * SessionStart/UserPromptSubmit 使用 additionalContext；Stop 使用 decision:block
 * + systemMessage（S8 实测仅此形式触发继续）。所有分支只写 S8 确认的键，
 * 以通过宿主 `HookJSONOutput` 严格 schema 校验。
 */
export function renderZcodeDecision(decision: HookDecision, event: HookEvent): HookRenderResult {
  const hostEvent = zcodeHostEventName(event);

  if (event === 'pre-tool') {
    const permissionDecision =
      decision.kind === 'deny' ? 'deny'
        : decision.kind === 'ask' ? 'ask'
          : 'allow';
    const reason =
      decision.kind === 'deny' || decision.kind === 'ask'
        ? decision.reason
        : decision.degraded === undefined
          ? ''
          : `ANO 钩子降级（${decision.degraded.code}）：${decision.degraded.detail}`;
    const output: Record<string, unknown> = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision,
        permissionDecisionReason: reason,
      },
    };
    // S8 Q4：退出码 2 等价 deny；与 permissionDecision 同步，避免信号冲突。
    return { stdout: `${JSON.stringify(output)}\n`, exitCode: permissionDecision === 'deny' ? 2 : 0 };
  }

  if (event === 'stop') {
    if (decision.kind === 'continue') {
      const systemMessage = decision.checklist.length > 0
        ? `${decision.reason}\n${decision.checklist.map((item) => `- ${item}`).join('\n')}`
        : decision.reason;
      // S8 Q6 workingFormat（实测触发继续）：decision:block + reason + systemMessage。
      // 不使用未确认的 hookSpecificOutput.Stop 形式，避免宿主严格 schema 拒绝。
      return json({
        decision: 'block',
        reason: decision.reason,
        systemMessage,
      });
    }
    if (decision.kind === 'context') {
      return json({ systemMessage: decision.additionalContext });
    }
    if (decision.kind === 'ask' || decision.kind === 'deny') {
      // 不静默放行：把降级原因作为 systemMessage 暴露，但不触发继续。
      return json({ systemMessage: decision.reason });
    }
    return json({});
  }

  // session-start / prompt：只有 context 注入 additionalContext，其余不注入。
  if (decision.kind === 'context') {
    return json({
      hookSpecificOutput: { hookEventName: hostEvent, additionalContext: decision.additionalContext },
    });
  }
  if (decision.kind === 'ask' || decision.kind === 'deny') {
    // §4.2 失败列：返回一段可观测的提示，交给人处理，绝不伪装成成功注入。
    return json({
      hookSpecificOutput: { hookEventName: hostEvent, additionalContext: decision.reason },
    });
  }
  return json({});
}

export const zcodeHookAdapter: HookAdapter = {
  id: 'zcode',
  evidence: 'measured',
  parse: parseZcodeStdin,
  render: renderZcodeDecision,
};
