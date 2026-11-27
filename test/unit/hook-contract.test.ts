import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HOOK_DEGRADED_CODES,
  HOOK_EVENTS,
  HOOK_MODES,
  failClosedDecision,
  hookDecisionSchema,
  hookDegradedCodeSchema,
  hookDegradedSchema,
  hookEventSchema,
  hookInputSchema,
  hookModeSchema,
  type HookDegradedCode,
  type HookInput,
  type HookMode,
} from '../../src/hooks/contract.ts';

// ---------------------------------------------------------------------------
// 封闭词表
// ---------------------------------------------------------------------------

test('HOOK_EVENTS / HOOK_MODES / HOOK_DEGRADED_CODES 与规格一致且不可多取值', () => {
  assert.deepEqual([...HOOK_EVENTS], ['session-start', 'prompt', 'pre-tool', 'stop']);
  assert.deepEqual([...HOOK_MODES], ['advisory', 'strict']);
  assert.deepEqual([...HOOK_DEGRADED_CODES], [
    'HOOK_INPUT_INVALID',
    'HOOK_ROOT_AMBIGUOUS',
    'HOOK_TIMEOUT',
    'HOOK_INTERNAL',
    'GRAPH_STALE',
    'GRAPH_DEGRADED',
    'UNSUPPORTED_LANGUAGE',
    'NOT_GIT_ROOT',
  ]);
});

// ---------------------------------------------------------------------------
// 枚举 schema：合法值通过，未知值/缺字段拒绝
// ---------------------------------------------------------------------------

test('hookEventSchema 只接受四个事件', () => {
  for (const event of HOOK_EVENTS) assert.equal(hookEventSchema.parse(event), event);
  for (const bad of ['PreToolUse', 'session_start', '', undefined, null, 1]) {
    assert.equal(hookEventSchema.safeParse(bad).success, false, `unexpected event accepted: ${String(bad)}`);
  }
});

test('hookModeSchema 只接受 advisory/strict', () => {
  for (const mode of HOOK_MODES) assert.equal(hookModeSchema.parse(mode), mode);
  for (const bad of ['STRICT', 'fail-closed', '', undefined, null, true]) {
    assert.equal(hookModeSchema.safeParse(bad).success, false, `unexpected mode accepted: ${String(bad)}`);
  }
});

test('hookDegradedCodeSchema 只接受八个降级码', () => {
  for (const code of HOOK_DEGRADED_CODES) assert.equal(hookDegradedCodeSchema.parse(code), code);
  for (const bad of ['UNKNOWN', 'HOOK_INPUT_IN', '', undefined, null, 0]) {
    assert.equal(hookDegradedCodeSchema.safeParse(bad).success, false, `unexpected code accepted: ${String(bad)}`);
  }
});

// ---------------------------------------------------------------------------
// hookDegradedSchema：strict，未知字段拒绝，缺字段拒绝
// ---------------------------------------------------------------------------

test('hookDegradedSchema 接受合法降级信息', () => {
  const value = { code: 'HOOK_TIMEOUT', detail: 'hook exceeded budget' } as const;
  assert.deepEqual(hookDegradedSchema.parse(value), value);
});

test('hookDegradedSchema 拒绝未知字段与缺字段', () => {
  assert.equal(hookDegradedSchema.safeParse({ code: 'HOOK_TIMEOUT', detail: 'd', extra: true }).success, false);
  assert.equal(hookDegradedSchema.safeParse({ code: 'HOOK_TIMEOUT' }).success, false);
  assert.equal(hookDegradedSchema.safeParse({ detail: 'd' }).success, false);
  assert.equal(hookDegradedSchema.safeParse({}).success, false);
  assert.equal(hookDegradedSchema.safeParse({ code: 'NOPE', detail: 'd' }).success, false);
});

// ---------------------------------------------------------------------------
// hookInputSchema：必填字段、可选字段、未知字段、hostExtra 语义
// ---------------------------------------------------------------------------

function minimalInput(): HookInput {
  return { event: 'pre-tool', client: 'zcode', hostSessionId: 'sess-1', cwd: 'F:/project' };
}

test('hookInputSchema 接受最小合法输入并保留可选字段', () => {
  assert.deepEqual(hookInputSchema.parse(minimalInput()), minimalInput());
  const full: HookInput = {
    event: 'pre-tool',
    client: 'zcode',
    hostSessionId: 'sess-1',
    cwd: 'F:/project',
    toolName: 'Edit',
    targetPaths: ['src/a.ts', 'src/b.ts'],
    stopContinuation: false,
    hostExtra: { session_id: 'sess-1', nested: { any: 1 }, list: [1, 2] },
  };
  assert.deepEqual(hookInputSchema.parse(full), full);
  for (const event of HOOK_EVENTS) {
    assert.equal(hookInputSchema.safeParse({ ...minimalInput(), event }).success, true);
  }
});

test('hookInputSchema 拒绝未知顶层字段', () => {
  assert.equal(hookInputSchema.safeParse({ ...minimalInput(), surprise: 1 }).success, false);
  assert.equal(hookInputSchema.safeParse({ ...minimalInput(), session_id: 'raw-host-field' }).success, false);
});

test('hookInputSchema 拒绝缺失必填字段', () => {
  const base = minimalInput() as unknown as Record<string, unknown>;
  for (const key of ['event', 'client', 'hostSessionId', 'cwd'] as const) {
    const candidate = { ...base };
    delete candidate[key];
    assert.equal(hookInputSchema.safeParse(candidate).success, false, `missing ${key} was accepted`);
  }
  assert.equal(hookInputSchema.safeParse({}).success, false);
});

test('hookInputSchema 拒绝非法字段类型与空字符串', () => {
  const base = minimalInput() as unknown as Record<string, unknown>;
  assert.equal(hookInputSchema.safeParse({ ...base, hostSessionId: '' }).success, false);
  assert.equal(hookInputSchema.safeParse({ ...base, client: '' }).success, false);
  assert.equal(hookInputSchema.safeParse({ ...base, cwd: '' }).success, false);
  assert.equal(hookInputSchema.safeParse({ ...base, targetPaths: 'src/a.ts' }).success, false);
  assert.equal(hookInputSchema.safeParse({ ...base, targetPaths: [1] }).success, false);
  assert.equal(hookInputSchema.safeParse({ ...base, stopContinuation: 'false' }).success, false);
  assert.equal(hookInputSchema.safeParse({ ...base, hostExtra: [] }).success, false);
});

test('hostExtra 只承载宿主元数据，不参与判定', () => {
  const base = minimalInput();
  const withExtra: HookInput = {
    ...base,
    hostExtra: {
      session_id: 'another-session',
      permission_mode: 'bypassPermissions',
      cwd: 'C:/elsewhere',
      tool_name: 'Bash',
      arbitrary: { deeply: { nested: true } },
    },
  };
  // 解析成功，且判定相关字段逐字节一致：hostExtra 内的伪造字段不改变任何判定输入。
  const parsedBase = hookInputSchema.parse(base);
  const parsedExtra = hookInputSchema.parse(withExtra);
  assert.deepEqual(
    {
      event: parsedExtra.event,
      client: parsedExtra.client,
      hostSessionId: parsedExtra.hostSessionId,
      cwd: parsedExtra.cwd,
      toolName: parsedExtra.toolName,
      targetPaths: parsedExtra.targetPaths,
      stopContinuation: parsedExtra.stopContinuation,
    },
    {
      event: parsedBase.event,
      client: parsedBase.client,
      hostSessionId: parsedBase.hostSessionId,
      cwd: parsedBase.cwd,
      toolName: parsedBase.toolName,
      targetPaths: parsedBase.targetPaths,
      stopContinuation: parsedBase.stopContinuation,
    },
  );
  // 降级决定不读取 hostExtra：同一 mode/code/detail 的输出必须与有无 hostExtra 无关。
  const a = failClosedDecision('strict', 'HOOK_INPUT_INVALID', 'bad stdin');
  const b = failClosedDecision('strict', 'HOOK_INPUT_INVALID', 'bad stdin');
  assert.deepEqual(a, b);
});

// ---------------------------------------------------------------------------
// hookDecisionSchema：六个分支，strict，未知字段/缺字段拒绝
// ---------------------------------------------------------------------------

test('hookDecisionSchema 接受六类决定（含 degraded），并拒绝未知 kind', () => {
  const decisions = [
    { kind: 'context', additionalContext: 'brief text' },
    { kind: 'allow' },
    { kind: 'ask', reason: 'confirm first' },
    { kind: 'deny', reason: 'not explored', remedy: 'run explore' },
    { kind: 'continue', reason: 'checkpoint missing', checklist: ['C2'] },
    { kind: 'stop-ok' },
  ] as const;
  for (const decision of decisions) {
    assert.equal(hookDecisionSchema.safeParse(decision).success, true, `rejected ${decision.kind}`);
    const withDegraded = { ...decision, degraded: { code: 'HOOK_TIMEOUT', detail: 'slow' } };
    assert.equal(hookDecisionSchema.safeParse(withDegraded).success, true, `rejected degraded ${decision.kind}`);
  }
  assert.equal(hookDecisionSchema.safeParse({ kind: 'approve' }).success, false);
  assert.equal(hookDecisionSchema.safeParse({}).success, false);
});

test('hookDecisionSchema 每类决定拒绝未知顶层字段', () => {
  const decisions: Array<Record<string, unknown>> = [
    { kind: 'context', additionalContext: 'x' },
    { kind: 'allow' },
    { kind: 'ask', reason: 'x' },
    { kind: 'deny', reason: 'x', remedy: 'y' },
    { kind: 'continue', reason: 'x', checklist: [] },
    { kind: 'stop-ok' },
  ];
  for (const decision of decisions) {
    assert.equal(
      hookDecisionSchema.safeParse({ ...decision, unexpected: true }).success,
      false,
      `unknown field accepted on ${String(decision.kind)}`,
    );
  }
});

test('hookDecisionSchema 每类决定拒绝缺必填字段', () => {
  const invalid: Array<Record<string, unknown>> = [
    { kind: 'context' },
    { kind: 'ask' },
    { kind: 'deny', reason: 'x' },
    { kind: 'deny', remedy: 'y' },
    { kind: 'continue', reason: 'x' },
    { kind: 'continue', checklist: [] },
    { kind: 'context', additionalContext: 'x', degraded: { code: 'HOOK_TIMEOUT' } },
  ];
  for (const decision of invalid) {
    assert.equal(hookDecisionSchema.safeParse(decision).success, false, JSON.stringify(decision));
  }
});

// ---------------------------------------------------------------------------
// failClosedDecision：mode × code 全组合，错误路径绝不 allow
// ---------------------------------------------------------------------------

test('failClosedDecision 全组合：advisory→ask、strict→deny，绝不 allow', () => {
  const modes: HookMode[] = [...HOOK_MODES];
  const codes: HookDegradedCode[] = [...HOOK_DEGRADED_CODES];
  for (const mode of modes) {
    for (const code of codes) {
      const detail = `detail-for-${code}`;
      const decision = failClosedDecision(mode, code, detail);
      assert.equal(decision.kind, mode === 'strict' ? 'deny' : 'ask', `${mode}/${code}`);
      assert.notEqual(decision.kind, 'allow');
      assert.deepEqual(decision.degraded, { code, detail }, `${mode}/${code}`);
      assert.ok(hookDecisionSchema.safeParse(decision).success, `schema rejected ${mode}/${code}`);
      if (decision.kind === 'deny') {
        assert.ok(decision.reason.includes(code));
        assert.ok(decision.reason.includes(detail));
        assert.ok(decision.remedy.length > 0);
        assert.equal(decision.remedy, '请先手动运行 ANO 检查并确认，再继续操作');
      } else if (decision.kind === 'ask') {
        assert.ok(decision.reason.includes(code));
        assert.ok(decision.reason.includes(detail));
      } else {
        assert.fail(`unexpected decision kind for ${mode}/${code}`);
      }
    }
  }
});

test('failClosedDecision 对空 detail 与所有事件上下文仍不产生 allow', () => {
  for (const event of HOOK_EVENTS) {
    for (const mode of HOOK_MODES) {
      const decision = failClosedDecision(mode, 'HOOK_INTERNAL', `failed at ${event}`);
      assert.notEqual(decision.kind, 'allow');
      assert.equal(hookDecisionSchema.safeParse(decision).success, true);
    }
  }
  const empty = failClosedDecision('advisory', 'HOOK_INTERNAL', '');
  assert.equal(empty.kind, 'ask');
  assert.deepEqual(empty.degraded, { code: 'HOOK_INTERNAL', detail: '' });
});
