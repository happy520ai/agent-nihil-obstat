/**
 * Claude Code hook adapter (T-166 / ADR-013 §4.1 / 公开文档).
 *
 * 字段映射**只**来自 Claude Code 公开文档，不来自本机实测（本机未安装
 * Claude Code，见 docs/evidence/host-capability-investigation.md）。因此
 * 证据等级固定为 `documented`：能力层最多标 `hooks-documented`，永不宣称
 * `hooks-validated`。
 *
 * 公开文档要点（https://docs.anthropic.com/en/docs/claude-code/hooks）：
 * - stdin 顶层字段：`hook_event_name`、`session_id`、`cwd`、`tool_name`、
 *   `tool_input`、`tool_use_id`、`stop_hook_active`；
 * - PreToolUse 输出 `{"decision":"block","reason":"..."}` 或
 *   `{"hookSpecificOutput":{"hookEventName":"PreToolUse",
 *   "permissionDecision":"deny|ask|allow","permissionDecisionReason":"..."}}`；
 * - SessionStart/UserPromptSubmit 注入 `hookSpecificOutput.additionalContext`；
 * - Stop 继续需要 `{"decision":"block","reason":"..."}` 并附带
 *   `systemMessage`/`additionalContext`；
 * - 退出码 2 表示 block（PreToolUse）。
 *
 * 与 ZCode 适配器一样，本文件只做归一化与渲染，不读文件、不执行命令、
 * 不访问账本。任何异常向上抛，由 CLI 统一 fail-closed。
 */

import {
  type HookDecision,
  type HookEvent,
  type HookInput,
  hookInputSchema,
} from '../contract.ts';
import type { HookAdapter, HookRenderResult } from './zcode.ts';

/** 公开文档确认的事件名到统一事件的封闭映射。 */
export const CLAUDE_CODE_HOST_EVENTS: Readonly<Record<string, HookEvent>> = {
  SessionStart: 'session-start',
  UserPromptSubmit: 'prompt',
  PreToolUse: 'pre-tool',
  Stop: 'stop',
};

export function claudeCodeHostEventName(event: HookEvent): string {
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

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** 公开文档的 `tool_input.file_path` 是编辑/写入类工具的目标路径。 */
function targetPathsOf(toolInput: unknown): string[] | undefined {
  if (!isRecord(toolInput)) return undefined;
  const path = nonEmptyString(toolInput['file_path']);
  return path === undefined ? undefined : [path];
}

export function parseClaudeCodeStdin(stdin: string): HookInput {
  let raw: unknown;
  try {
    raw = JSON.parse(stdin) as unknown;
  } catch (error) {
    throw new Error(`Claude Code hook stdin is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(raw)) throw new Error('Claude Code hook stdin must be a JSON object');

  const hostEvent = nonEmptyString(raw['hook_event_name']);
  if (hostEvent === undefined) throw new Error('Claude Code hook stdin is missing hook_event_name');
  const event = CLAUDE_CODE_HOST_EVENTS[hostEvent];
  if (event === undefined) throw new Error(`Claude Code hook event is not handled by ANO: ${hostEvent}`);

  const hostSessionId = nonEmptyString(raw['session_id']);
  if (hostSessionId === undefined) throw new Error('Claude Code hook stdin is missing session_id');
  const cwd = nonEmptyString(raw['cwd']);
  if (cwd === undefined) throw new Error('Claude Code hook stdin is missing cwd');

  const candidate: HookInput = {
    event,
    client: 'claude-code',
    hostSessionId,
    cwd,
  };

  if (event === 'pre-tool') {
    const toolName = nonEmptyString(raw['tool_name']);
    if (toolName === undefined) throw new Error('Claude Code PreToolUse stdin is missing tool_name');
    candidate.toolName = toolName;
    const paths = targetPathsOf(raw['tool_input']);
    if (paths !== undefined) candidate.targetPaths = paths;
  }
  if (event === 'stop' && typeof raw['stop_hook_active'] === 'boolean') {
    candidate.stopContinuation = raw['stop_hook_active'];
  }

  hookInputSchema.parse(candidate);
  return candidate;
}

function json(value: Record<string, unknown>): HookRenderResult {
  return { stdout: `${JSON.stringify(value)}\n`, exitCode: 0 };
}

export function renderClaudeCodeDecision(decision: HookDecision, event: HookEvent): HookRenderResult {
  const hostEvent = claudeCodeHostEventName(event);

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
    return {
      stdout: `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision,
          permissionDecisionReason: reason,
        },
      })}\n`,
      exitCode: permissionDecision === 'deny' ? 2 : 0,
    };
  }

  if (event === 'stop') {
    if (decision.kind === 'continue') {
      const systemMessage = decision.checklist.length > 0
        ? `${decision.reason}\n${decision.checklist.map((item) => `- ${item}`).join('\n')}`
        : decision.reason;
      return json({ decision: 'block', reason: decision.reason, systemMessage });
    }
    if (decision.kind === 'context') return json({ systemMessage: decision.additionalContext });
    if (decision.kind === 'ask' || decision.kind === 'deny') return json({ systemMessage: decision.reason });
    return json({});
  }

  if (decision.kind === 'context') {
    return json({
      hookSpecificOutput: { hookEventName: hostEvent, additionalContext: decision.additionalContext },
    });
  }
  if (decision.kind === 'ask' || decision.kind === 'deny') {
    return json({
      hookSpecificOutput: { hookEventName: hostEvent, additionalContext: decision.reason },
    });
  }
  return json({});
}

export const claudeCodeHookAdapter: HookAdapter = {
  id: 'claude-code',
  evidence: 'documented',
  parse: parseClaudeCodeStdin,
  render: renderClaudeCodeDecision,
};
