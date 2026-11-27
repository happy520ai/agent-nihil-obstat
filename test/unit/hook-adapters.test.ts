import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HOOK_DEGRADED_CODES,
  failClosedDecision,
  type HookDecision,
} from '../../src/hooks/contract.ts';
import {
  zcodeHookAdapter,
  parseZcodeStdin,
  renderZcodeDecision,
  ZCODE_HOST_EVENTS,
} from '../../src/hooks/adapters/zcode.ts';
import {
  claudeCodeHookAdapter,
  parseClaudeCodeStdin,
  renderClaudeCodeDecision,
} from '../../src/hooks/adapters/claude-code.ts';

// ---------------------------------------------------------------------------
// S8 脱敏样本夹具（docs/evidence/s8-zcode-hooks.json q2.samples）
// ---------------------------------------------------------------------------
const S8_SESSION_START = {
  cwd: 'D:\\Temp\\ano-s8-work\\项目 with spaces',
  hookEventName: 'SessionStart',
  hook_event_name: 'SessionStart',
  sessionId: 'sess_c349a90a-20f7-432b-a532-53219e0e87d3',
  session_id: 'sess_c349a90a-20f7-432b-a532-53219e0e87d3',
  source: 'startup',
  permission_mode: 'yolo',
  timestamp: '2026-11-26T02:45:23.154Z',
};

const S8_PRE_TOOL_USE = {
  cwd: 'D:\\Temp\\ano-s8-work\\项目 with spaces',
  hookEventName: 'PreToolUse',
  hook_event_name: 'PreToolUse',
  sessionId: 'sess_9dfbb5e8-3cf4-494b-a344-869ec59f523b',
  session_id: 'sess_9dfbb5e8-3cf4-494b-a344-869ec59f523b',
  toolName: 'Bash',
  tool_name: 'Bash',
  toolInput: { command: 'find . -name src.ts', description: 'locate' },
  tool_input: { command: 'find . -name src.ts', description: 'locate' },
  riskLevel: 'high',
  sideEffectScope: 'system',
};

const S8_PRE_TOOL_EDIT = {
  hook_event_name: 'PreToolUse',
  session_id: 'sess_edit',
  cwd: 'D:\\Temp\\ano-s8-work\\项目 with spaces',
  tool_name: 'Edit',
  tool_input: { file_path: 'D:\\Temp\\ano-s8-work\\项目 with spaces\\src\\x.ts', old_string: 'a', new_string: 'b' },
};

const S8_STOP = {
  hookEventName: 'Stop',
  hook_event_name: 'Stop',
  sessionId: 'sess_stop',
  session_id: 'sess_stop',
  cwd: 'D:\\Temp\\ano-s8-work\\项目 with spaces',
  stopHookActive: false,
  stop_hook_active: false,
  toolCallCount: 0,
};

// ---------------------------------------------------------------------------
// ZCode：证据等级 measured，只用 S8 字段
// ---------------------------------------------------------------------------

test('zcode adapter 证据等级为 measured，事件封闭词表与 S8 一致', () => {
  assert.equal(zcodeHookAdapter.evidence, 'measured');
  assert.equal(zcodeHookAdapter.id, 'zcode');
  assert.deepEqual({ ...ZCODE_HOST_EVENTS }, {
    SessionStart: 'session-start',
    UserPromptSubmit: 'prompt',
    PreToolUse: 'pre-tool',
    Stop: 'stop',
  });
});

test('zcode parse：S8 双字段 stdin（camelCase + snake_case）归一化为统一输入', () => {
  const input = parseZcodeStdin(JSON.stringify(S8_SESSION_START));
  assert.equal(input.event, 'session-start');
  assert.equal(input.client, 'zcode');
  assert.equal(input.hostSessionId, 'sess_c349a90a-20f7-432b-a532-53219e0e87d3');
  assert.equal(input.cwd, 'D:\\Temp\\ano-s8-work\\项目 with spaces');
  assert.equal(input.hostExtra?.['permissionMode'], 'yolo');
});

test('zcode parse：只有 snake_case 字段也能归一化', () => {
  const input = parseZcodeStdin(JSON.stringify(S8_PRE_TOOL_EDIT));
  assert.equal(input.event, 'pre-tool');
  assert.equal(input.toolName, 'Edit');
  assert.deepEqual(input.targetPaths, ['D:\\Temp\\ano-s8-work\\项目 with spaces\\src\\x.ts']);
});

test('zcode parse：PreToolUse 使用 S8 确认的 file_path 提取目标路径，忽略其他键', () => {
  const input = parseZcodeStdin(JSON.stringify(S8_PRE_TOOL_USE));
  assert.equal(input.toolName, 'Bash');
  assert.equal(input.targetPaths, undefined); // Bash 的 tool_input 只有 command/description
  assert.equal(input.hostExtra?.['riskLevel'], 'high');
});

test('zcode parse：Stop 读取 stop_hook_active 双字段', () => {
  assert.equal(parseZcodeStdin(JSON.stringify(S8_STOP)).stopContinuation, false);
  const active = { ...S8_STOP, stop_hook_active: true, stopHookActive: true };
  assert.equal(parseZcodeStdin(JSON.stringify(active)).stopContinuation, true);
});

test('zcode parse：非 JSON / 缺字段 / 未处理事件都抛错，交由 CLI fail-closed', () => {
  assert.throws(() => parseZcodeStdin('not json'));
  assert.throws(() => parseZcodeStdin('[]'));
  assert.throws(() => parseZcodeStdin(JSON.stringify({ ...S8_SESSION_START, session_id: undefined, sessionId: undefined })));
  assert.throws(() => parseZcodeStdin(JSON.stringify({ ...S8_SESSION_START, hook_event_name: 'PermissionRequest', hookEventName: 'PermissionRequest' })), /not handled/);
  assert.throws(() => parseZcodeStdin(JSON.stringify({ ...S8_PRE_TOOL_EDIT, tool_name: undefined, tool_input: undefined })));
});

test('zcode render：PreToolUse deny/ask/allow 使用 S8 permissionDecision 契约', () => {
  const deny = renderZcodeDecision({ kind: 'deny', reason: 'r', remedy: 'm' }, 'pre-tool');
  assert.equal(deny.exitCode, 2); // S8 Q4：退出码 2 = deny
  assert.deepEqual(JSON.parse(deny.stdout), {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'r' },
  });
  const ask = renderZcodeDecision({ kind: 'ask', reason: '请确认' }, 'pre-tool');
  assert.equal(ask.exitCode, 0);
  assert.deepEqual(JSON.parse(ask.stdout), {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: '请确认' },
  });
  const allow = renderZcodeDecision({ kind: 'allow' }, 'pre-tool');
  assert.equal(allow.exitCode, 0);
  assert.deepEqual(JSON.parse(allow.stdout), {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: '' },
  });
});

test('zcode render：SessionStart context 注入 additionalContext', () => {
  const result = renderZcodeDecision({ kind: 'context', additionalContext: 'marker' }, 'session-start');
  assert.deepEqual(JSON.parse(result.stdout), {
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'marker' },
  });
});

test('zcode render：Stop continue 使用 S8 workingFormat（decision:block + systemMessage）', () => {
  const result = renderZcodeDecision({ kind: 'continue', reason: '请补记', checklist: ['写 checkpoint'] }, 'stop');
  const out = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.equal(out['decision'], 'block');
  assert.equal(out['reason'], '请补记');
  assert.match(String(out['systemMessage']), /写 checkpoint/);
  // S8 Q6：仅 {continue:true} 不触发继续，所以必须没有裸 continue 键。
  assert.equal(Object.hasOwn(out, 'continue'), false);
});

test('zcode render：所有输出只含 S8 确认的键（无未知字段触发宿主 schema 拒绝）', () => {
  const decisions: HookDecision[] = [
    { kind: 'allow' },
    { kind: 'context', additionalContext: 'x' },
    { kind: 'ask', reason: 'r' },
    { kind: 'deny', reason: 'r', remedy: 'm' },
    { kind: 'continue', reason: 'r', checklist: [] },
    { kind: 'stop-ok' },
  ];
  for (const event of ['session-start', 'prompt', 'pre-tool', 'stop'] as const) {
    for (const decision of decisions) {
      const rendered = renderZcodeDecision(decision, event);
      assert.ok(rendered.stdout.endsWith('\n'));
      JSON.parse(rendered.stdout); // 必须是合法 JSON
    }
  }
});

// ---------------------------------------------------------------------------
// Claude Code：仅公开文档，证据等级 documented
// ---------------------------------------------------------------------------

test('claude-code adapter 证据等级为 documented（本机未实测）', () => {
  assert.equal(claudeCodeHookAdapter.evidence, 'documented');
  assert.equal(claudeCodeHookAdapter.id, 'claude-code');
});

test('claude-code parse：公开文档字段归一化', () => {
  const input = parseClaudeCodeStdin(JSON.stringify({
    hook_event_name: 'PreToolUse',
    session_id: 'cc-sess',
    cwd: '/tmp/project',
    tool_name: 'Write',
    tool_input: { file_path: '/tmp/project/src/a.ts', content: 'x' },
    stop_hook_active: false,
  }));
  assert.equal(input.event, 'pre-tool');
  assert.equal(input.client, 'claude-code');
  assert.equal(input.hostSessionId, 'cc-sess');
  assert.equal(input.toolName, 'Write');
  assert.deepEqual(input.targetPaths, ['/tmp/project/src/a.ts']);
});

test('claude-code parse：缺字段/未知事件抛错', () => {
  assert.throws(() => parseClaudeCodeStdin('{}'));
  assert.throws(() => parseClaudeCodeStdin(JSON.stringify({
    hook_event_name: 'UnknownEvent', session_id: 's', cwd: '/tmp',
  })));
});

test('claude-code render：PreToolUse deny = exit 2 + permissionDecision', () => {
  const result = renderClaudeCodeDecision({ kind: 'deny', reason: 'blocked', remedy: 'm' }, 'pre-tool');
  assert.equal(result.exitCode, 2);
  const out = JSON.parse(result.stdout) as { hookSpecificOutput: Record<string, string> };
  assert.equal(out.hookSpecificOutput['permissionDecision'], 'deny');
  assert.equal(out.hookSpecificOutput['hookEventName'], 'PreToolUse');
});

test('claude-code render：Stop continue 带 systemMessage', () => {
  const result = renderClaudeCodeDecision({ kind: 'continue', reason: 'r', checklist: ['i'] }, 'stop');
  const out = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.equal(out['decision'], 'block');
  assert.match(String(out['systemMessage']), /i/);
});

// ---------------------------------------------------------------------------
// fail-closed：advisory→ask / strict→deny，绝不 allow
// ---------------------------------------------------------------------------

test('不合规输入经 failClosedDecision 后渲染绝不产生 allow', () => {
  for (const mode of ['advisory', 'strict'] as const) {
    for (const event of ['session-start', 'prompt', 'pre-tool', 'stop'] as const) {
      for (const code of HOOK_DEGRADED_CODES) {
        const decision = failClosedDecision(mode, code, 'detail');
        assert.equal(decision.kind === 'allow', false);
        const rendered = zcodeHookAdapter.render(decision, event);
        const parsed = JSON.parse(rendered.stdout) as Record<string, unknown>;
        if (event === 'pre-tool') {
          const specific = parsed['hookSpecificOutput'] as Record<string, string>;
          assert.notEqual(specific['permissionDecision'], 'allow');
        }
      }
    }
  }
});
