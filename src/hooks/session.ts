/**
 * session-start / stop 引擎（T-165 / ADR-013 §4.2、§4.4、§5 / 实施规格 T-165）。
 *
 * 这是 hooks 中**仅有的两条允许写账本**的路径之一（另一条是 stop 的机械摘要，
 * 由 T-169 提供）。两者都必须带幂等键；pre-tool/prompt 永远只读。
 *
 * 本模块只依赖：
 * - `Ledger`（真实 SQLite 视图 + 追加式 JSONL 段）；
 * - `src/core/git.ts` 的 `gitTouchedFiles`（真实 git 工作树）；
 * - `contract.ts` 的纯类型。
 *
 * 不读取 transcript、不采集提示词或模型回答正文（ADR-013 §2.5）：所有内容
 * 都来自 git 状态、账本事件与 stdin 元数据。
 */

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  type HookDecision,
  type HookInput,
  type HookMode,
  type HookDegraded,
} from './contract.ts';
import { gitTouchedFiles, normalizeTouched } from '../core/git.ts';
import { Ledger } from '../ledger/ledger.ts';
import { replayLedger } from '../ledger/replay.ts';
import { briefCompact } from '../surface/service.ts';
import type { LedgerEvent } from '../ledger/event.ts';
import {
  buildSessionSummary,
  nextSessionSummarySeq,
  persistSessionSummary,
} from './summary.ts';

const execFileAsync = promisify(execFile);

/** 脏文件基线指纹条目（ADR-013 §4.2；实施规格 session.started 事件形状）。 */
export interface DirtyBaselineEntry {
  readonly path: string;
  readonly sha256: string;
}

/** 写入账本的 `session.started` 事件载荷（snake_case，schema-only 词表）。 */
export interface SessionStartedPayload {
  readonly [key: string]: unknown;
  readonly task_id: string;
  readonly host_session_id: string;
  readonly client: string;
  readonly hook_mode: HookMode;
  readonly head_commit: string | null;
  readonly dirty_baseline: readonly DirtyBaselineEntry[];
  readonly dirty_baseline_truncated: boolean;
  readonly previous_session_unclosed: string | null;
}

/** 单项收工检查（ADR-013 §4.4 表）。 */
export interface SessionCheck {
  readonly id: 'C1' | 'C2' | 'C3' | 'C4';
  readonly ok: boolean;
  readonly items: readonly string[];
}

/** 写入账本的 `session.stop_checked` 事件载荷。 */
export interface SessionStopCheckedPayload {
  readonly [key: string]: unknown;
  readonly task_id: string;
  readonly host_session_id: string;
  readonly seq: number;
  readonly checks: readonly SessionCheck[];
  readonly decision: 'continue' | 'stop-ok';
  readonly continuations_used: number;
}

/** session-start 返回的最小 brief 投影（T-170 完成前的临时最小版）。 */
export interface SessionBriefProjection {
  readonly focus: readonly { id: string; status: string; title?: string }[];
  readonly breakpoint: readonly { task: string; next_step: string }[];
  readonly previous_session_unclosed: string | null;
  readonly truncated: readonly string[];
}

/** onSessionStart 的结果：统一决定 + 供上层/测试读取的事件与投影。 */
export interface SessionStartResult {
  readonly decision: HookDecision;
  readonly event: LedgerEvent;
  readonly duplicate: boolean;
  readonly previousSessionUnclosed: string | null;
  readonly brief: SessionBriefProjection;
  readonly degraded?: HookDegraded;
}

/** onStop 的结果。 */
export interface SessionStopResult {
  readonly decision: HookDecision;
  readonly event: LedgerEvent;
  readonly duplicate: boolean;
  readonly seq: number;
  readonly continuationsUsed: number;
  readonly checks: readonly SessionCheck[];
  readonly degraded?: HookDegraded;
}

/** 引擎上下文：mode 必填；Ledger 由调用方打开并在结束后 close。 */
export interface SessionEngineContext {
  readonly ledger: Ledger;
  readonly mode: HookMode;
  /** 最小投影的字符预算（实施规格 session-start ≤ 6000 字符）。 */
  readonly budgetChars?: number;
  readonly now?: () => number;
}

// ---------------------------------------------------------------------------
// git 状态（真实工作树）
// ---------------------------------------------------------------------------

/** 读取 HEAD commit；非 Git 根抛错，由调用方降级为 NOT_GIT_ROOT。 */
async function headCommit(root: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true });
    const sha = stdout.trim();
    return /^[a-f0-9]{40}$/u.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/** 判断 root 是否是 Git 工作树（非 Git 根 → NOT_GIT_ROOT 降级）。 */
export async function isGitWorkTree(root: string): Promise<boolean> {
  const { status } = await execFileAsync('git', ['-C', root, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8', windowsHide: true })
    .then((result) => ({ status: result.stdout.trim() === 'true' }))
    .catch(() => ({ status: false }));
  return status;
}

/** 工作区脏文件指纹基线：上限 500，超限记 truncated（ADR-013 §4.2）。 */
export const DIRTY_BASELINE_LIMIT = 500;

async function dirtyBaseline(root: string, files: readonly string[]): Promise<{ entries: DirtyBaselineEntry[]; truncated: boolean }> {
  const entries: DirtyBaselineEntry[] = [];
  for (const file of files) {
    if (entries.length >= DIRTY_BASELINE_LIMIT) return { entries, truncated: true };
    const absolute = resolve(root, file);
    let digest: string;
    try {
      const bytes = await readFile(absolute);
      digest = createHash('sha256').update(bytes).digest('hex');
    } catch {
      // 删除文件等无法读取的情况：以路径哈希表示，保持确定性。
      digest = createHash('sha256').update(`missing:${file}`).digest('hex');
    }
    entries.push({ path: file, sha256: digest });
  }
  return { entries, truncated: false };
}

// ---------------------------------------------------------------------------
// 账本事件读取（真实 replay + SQLite）
// ---------------------------------------------------------------------------

function sessionEvents(ledger: Ledger): LedgerEvent[] {
  return replayLedger(ledger.ledgerDir).entries.map((entry) => entry.event);
}

function startedEvents(ledger: Ledger): LedgerEvent[] {
  return sessionEvents(ledger).filter((event) => event.kind === 'session.started');
}

function summaryEvents(ledger: Ledger): LedgerEvent[] {
  // T-169 尚未合入：机械摘要以 note.recorded(kind=session_summary, source=hook:auto)
  // 的形式出现；本模块只读取，不写，不依赖 T-169 的具体实现。
  return sessionEvents(ledger).filter((event) => {
    if (event.kind !== 'note.recorded') return false;
    const payload = event.payload as Record<string, unknown>;
    return payload['kind'] === 'session_summary';
  });
}

function stopCheckEvents(ledger: Ledger, hostSessionId: string): LedgerEvent[] {
  return sessionEvents(ledger).filter((event) => {
    if (event.kind !== 'session.stop_checked') return false;
    return (event.payload as Record<string, unknown>)['host_session_id'] === hostSessionId;
  });
}

/**
 * 检测上一个 `session.started` 是否缺摘要（ADR-013 §5：中途强杀补检）。
 * 规则：最近一条 session.started（不含当前 host_session_id）的会话若没有
 * 对应 host_session_id 的 session_summary note，视为未关闭。返回 null 表示
 * 没有未关闭会话。T-169 负责补写 interrupted=true 摘要；本模块只报告。
 */
export function detectPreviousUnclosed(events: readonly LedgerEvent[], currentHostSessionId: string): string | null {
  const summaries = new Set<string>();
  for (const event of events) {
    if (event.kind !== 'note.recorded') continue;
    const payload = event.payload as Record<string, unknown>;
    if (payload['kind'] !== 'session_summary') continue;
    const text = typeof payload['text'] === 'string' ? payload['text'] : '';
    const parsed = safeParseJsonObject(text);
    if (!parsed) continue;
    const id = parsed['host_session_id'];
    if (typeof id === 'string' && id.length > 0) summaries.add(id);
  }
  const starts = events.filter((event) => event.kind === 'session.started');
  for (let index = starts.length - 1; index >= 0; index -= 1) {
    const payload = starts[index]!.payload as Record<string, unknown>;
    const id = payload['host_session_id'];
    if (typeof id !== 'string' || id === currentHostSessionId) continue;
    return summaries.has(id) ? null : id;
  }
  return null;
}

function safeParseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 最小 brief 投影（T-170 完成前的临时版：焦点任务 + 断点下一步）
// ---------------------------------------------------------------------------

/** 断点文本约定：note 的 text 里含「下一步」或 checkpoint 语义时浮出。 */
function breakpointFromNotes(ledger: Ledger, focusIds: readonly string[]): { task: string; next_step: string }[] {
  const out: { task: string; next_step: string }[] = [];
  for (const note of ledger.listNotes()) {
    const text = note.text;
    if (!/下一步|next[_ ]?step|checkpoint/u.test(text)) continue;
    const task = focusIds.find((id) => text.includes(id)) ?? 'global';
    out.push({ task, next_step: text.slice(0, 400) });
    if (out.length >= 3) break;
  }
  return out;
}

function renderBrief(projection: SessionBriefProjection, budgetChars: number): string {
  const lines: string[] = ['# ANO brief (最小投影)'];
  const focus = projection.focus.length
    ? projection.focus.map((task) => `- ${task.id} [${task.status}]${task.title ? ` ${task.title}` : ''}`).join('\n')
    : '- （无焦点任务）';
  lines.push('## 当前焦点', focus);
  const breakpoint = projection.breakpoint.length
    ? projection.breakpoint.map((item) => `- ${item.task}: ${item.next_step}`).join('\n')
    : '- （无断点记录）';
  lines.push('## 断点下一步', breakpoint);
  if (projection.previous_session_unclosed !== null) {
    lines.push('## 上次会话未关闭', `- ${projection.previous_session_unclosed}（将由 T-169 补写 interrupted 摘要）`);
  }
  if (projection.truncated.length > 0) lines.push(`## 截断\n- ${projection.truncated.join(', ')}`);
  const full = lines.join('\n');
  return full.length <= budgetChars ? full : `${full.slice(0, budgetChars - 20)}\n…(truncated)`;
}

// ---------------------------------------------------------------------------
// onSessionStart
// ---------------------------------------------------------------------------

/**
 * 幂等写 `session.started`，返回最小 brief 投影作为 additionalContext。
 * 幂等键 `session-start:<host_session_id>`：同一 host_session_id 重放只写一条事件。
 */
export async function onSessionStart(input: HookInput, ctx: SessionEngineContext): Promise<SessionStartResult> {
  const { ledger, mode } = ctx;
  const root = ledger.root;
  const budget = ctx.budgetChars ?? 6000;
  const now = ctx.now ?? Date.now;
  const events = sessionEvents(ledger);
  const previousSessionUnclosed = detectPreviousUnclosed(events, input.hostSessionId);

  const git = await isGitWorkTree(root);
  const head = git ? await headCommit(root) : null;
  let files: string[] = [];
  if (git) {
    try { files = normalizeTouched(root, await gitTouchedFiles(root)); } catch { files = []; }
  }
  const baseline = await dirtyBaseline(root, files);

  const payload: SessionStartedPayload = {
    task_id: `session-start:${input.hostSessionId}`,
    host_session_id: input.hostSessionId,
    client: input.client,
    hook_mode: mode,
    head_commit: head,
    dirty_baseline: baseline.entries,
    dirty_baseline_truncated: baseline.truncated,
    previous_session_unclosed: previousSessionUnclosed,
  };
  const appended = await ledger.append({ kind: 'session.started', payload }, `session-start:${input.hostSessionId}`);
  const event = appended.event ?? sessionEvents(ledger).find((candidate) => candidate.kind === 'session.started' && (candidate.payload as Record<string, unknown>)['host_session_id'] === input.hostSessionId)!;

  if (previousSessionUnclosed !== null) {
    // Interrupted sessions get a mechanical marker, never model-authored prose.
    const interrupted = buildSessionSummary({
      host_session_id: previousSessionUnclosed,
      client: 'unknown',
      started_at: null,
      head_commit: null,
    }, { unmet_checks: ['interrupted'] }, {
      head_commit: head,
      files_changed: files,
      ended_at: new Date(now()).toISOString(),
    }, { interrupted: true });
    await persistSessionSummary(ledger, interrupted, nextSessionSummarySeq(ledger, previousSessionUnclosed));
  }

  const tasks = ledger.getTasks().filter((task) => task.status === 'in_progress').slice(0, 5);
  const focus = tasks.map((task) => ({ id: task.id, status: task.status, ...(task.title ? { title: task.title } : {}) }));
  const projection: SessionBriefProjection = {
    focus,
    breakpoint: breakpointFromNotes(ledger, tasks.map((task) => task.id)),
    previous_session_unclosed: previousSessionUnclosed,
    truncated: [
      ...(baseline.truncated ? ['dirty_baseline'] : []),
      ...(!git ? ['NOT_GIT_ROOT'] : []),
    ],
  };
  const additionalContext = git
    ? `# ANO brief\n${JSON.stringify(await briefCompact(root, { budgetChars: budget - 12 }))}`
    : renderBrief(projection, budget);
  const decision: HookDecision = {
    kind: 'context',
    additionalContext,
    ...(!git ? { degraded: { code: 'NOT_GIT_ROOT' as const, detail: '工作区不是 Git 根，脏文件基线为空' } } : {}),
  };
  return {
    decision,
    event,
    duplicate: appended.duplicate,
    previousSessionUnclosed,
    brief: projection,
    ...(!git ? { degraded: { code: 'NOT_GIT_ROOT' as const, detail: '工作区不是 Git 根，脏文件基线为空' } } : {}),
  };
}

// ---------------------------------------------------------------------------
// onStop — C1–C4（ADR-013 §4.4）
// ---------------------------------------------------------------------------

/** 会话开始基线（来自 session.started 事件）。 */
interface StartedBaseline {
  readonly event: LedgerEvent;
  readonly hostSessionId: string;
  readonly headCommit: string | null;
  readonly dirty: ReadonlyMap<string, string>;
}

function latestStartedFor(events: readonly LedgerEvent[], hostSessionId: string): StartedBaseline | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.kind !== 'session.started') continue;
    const payload = event.payload as Record<string, unknown>;
    if (payload['host_session_id'] !== hostSessionId) continue;
    const dirty = new Map<string, string>();
    const entries = Array.isArray(payload['dirty_baseline']) ? payload['dirty_baseline'] as Record<string, unknown>[] : [];
    for (const entry of entries) {
      if (typeof entry['path'] === 'string' && typeof entry['sha256'] === 'string') dirty.set(entry['path'], entry['sha256']);
    }
    return {
      event,
      hostSessionId,
      headCommit: typeof payload['head_commit'] === 'string' ? payload['head_commit'] : null,
      dirty,
    };
  }
  return undefined;
}

/** 会话期间开始的任务：在 session.started 之后创建的 task.created。 */
function tasksCreatedAfter(events: readonly LedgerEvent[], startedEvent: LedgerEvent): Set<string> {
  const ids = new Set<string>();
  const startHlc = `${String(startedEvent.hlc.physical).padStart(13, '0')}:${String(startedEvent.hlc.logical).padStart(10, '0')}:${startedEvent.hlc.actor}`;
  for (const event of events) {
    if (event.kind !== 'task.created') continue;
    const hlc = `${String(event.hlc.physical).padStart(13, '0')}:${String(event.hlc.logical).padStart(10, '0')}:${event.hlc.actor}`;
    if (hlc <= startHlc) continue;
    const id = (event.payload as Record<string, unknown>)['task_id'];
    if (typeof id === 'string') ids.add(id);
  }
  return ids;
}

/** 来源允许集合：本会话涉及的 in_progress/新建任务的声明文件 ∪ 已 complete 任务的 touched。 */
function ownedFiles(ledger: Ledger, createdInSession: ReadonlySet<string>): Set<string> {
  const owned = new Set<string>();
  for (const task of ledger.getTasks()) {
    if (task.status === 'in_progress' || createdInSession.has(task.id)) {
      for (const file of task.declaredFiles) owned.add(file);
    }
    if (task.status === 'done' && task.verdict && typeof task.verdict === 'object') {
      const touched = (task.verdict as Record<string, unknown>)['touched'];
      if (Array.isArray(touched)) for (const file of touched) if (typeof file === 'string') owned.add(file);
    }
  }
  for (const evidence of ledger.listEvidence()) {
    if (evidence.evidence && typeof evidence.evidence === 'object') {
      const touched = (evidence.evidence as Record<string, unknown>)['touched'];
      if (Array.isArray(touched)) for (const file of touched) if (typeof file === 'string') owned.add(file);
    }
  }
  return owned;
}

/** 会话期间有 checkpoint 证据的任务：note 或 task.updated 的 hlc 晚于 session.started。 */
function tasksWithCheckpoint(events: readonly LedgerEvent[], startedEvent: LedgerEvent): Set<string> {
  const ids = new Set<string>();
  const startHlc = `${String(startedEvent.hlc.physical).padStart(13, '0')}:${String(startedEvent.hlc.logical).padStart(10, '0')}:${startedEvent.hlc.actor}`;
  const after = (event: LedgerEvent): boolean => {
    const hlc = `${String(event.hlc.physical).padStart(13, '0')}:${String(event.hlc.logical).padStart(10, '0')}:${event.hlc.actor}`;
    return hlc > startHlc;
  };
  for (const event of events) {
    if (!after(event)) continue;
    if (event.kind === 'note.recorded') {
      const text = (event.payload as Record<string, unknown>)['text'];
      if (typeof text !== 'string' || !/checkpoint|下一步|next[_ ]?step/u.test(text)) continue;
      for (const task of events) {
        if (task.kind !== 'task.created') continue;
        const id = (task.payload as Record<string, unknown>)['task_id'];
        if (typeof id === 'string' && text.includes(id)) ids.add(id);
      }
    }
    if (event.kind === 'task.updated') {
      const id = (event.payload as Record<string, unknown>)['task_id'];
      if (typeof id === 'string') ids.add(id);
    }
  }
  return ids;
}

/** 会话期间最后一次 verify 为 ok=false 的任务。 */
function failedVerifyTasks(events: readonly LedgerEvent[], startedEvent: LedgerEvent): Set<string> {
  const startHlc = `${String(startedEvent.hlc.physical).padStart(13, '0')}:${String(startedEvent.hlc.logical).padStart(10, '0')}:${startedEvent.hlc.actor}`;
  const last = new Map<string, boolean>();
  for (const event of events) {
    if (event.kind !== 'verify.finished') continue;
    const hlc = `${String(event.hlc.physical).padStart(13, '0')}:${String(event.hlc.logical).padStart(10, '0')}:${event.hlc.actor}`;
    if (hlc <= startHlc) continue;
    const payload = event.payload as Record<string, unknown>;
    const id = payload['task_id'];
    if (typeof id !== 'string') continue;
    last.set(id, payload['ok'] === false);
  }
  return new Set([...last].filter(([, ok]) => !ok).map(([id]) => id));
}

/** 本会话是否有 decision/pitfall note（C4 软提示）。 */
function hasDecisionNote(events: readonly LedgerEvent[], startedEvent: LedgerEvent): boolean {
  const startHlc = `${String(startedEvent.hlc.physical).padStart(13, '0')}:${String(startedEvent.hlc.logical).padStart(10, '0')}:${startedEvent.hlc.actor}`;
  return events.some((event) => {
    if (event.kind !== 'note.recorded') return false;
    const hlc = `${String(event.hlc.physical).padStart(13, '0')}:${String(event.hlc.logical).padStart(10, '0')}:${event.hlc.actor}`;
    if (hlc <= startHlc) return false;
    const kind = (event.payload as Record<string, unknown>)['kind'];
    return kind === 'decision' || kind === 'pitfall';
  });
}

/**
 * 计算当前工作区相对 session.started 基线的“新增或改动”文件（ADR-013 §4.4：
 * 对比基线，只算本次会话产生的改动）。基线中已有且内容未变的文件不算本次改动；
 * 新增文件或指纹变化的文件才算。
 */
async function changedSinceBaseline(root: string, baseline: ReadonlyMap<string, string>): Promise<string[]> {
  let current: string[];
  try { current = normalizeTouched(root, await gitTouchedFiles(root)); } catch { return []; }
  const changed: string[] = [];
  for (const file of current) {
    const old = baseline.get(file);
    if (old === undefined) { changed.push(file); continue; }
    let digest: string;
    try {
      digest = createHash('sha256').update(await readFile(resolve(root, file))).digest('hex');
    } catch {
      digest = createHash('sha256').update(`missing:${file}`).digest('hex');
    }
    if (digest !== old) changed.push(file);
  }
  return changed.sort();
}

/**
 * 计算 C1–C4、写 `session.stop_checked` 并给出决定。
 *
 * - 最多 2 次 continue（低于 ZCode 的 3 次上限，留 1 次余量），之后一律 stop-ok；
 * - 尊重 `stopContinuation`（宿主已在 stop 钩子继续中 → 不再触发新 continue）；
 * - 非 Git 根 → degraded=NOT_GIT_ROOT，跳过 C1，C2–C4 照常。
 */
export async function onStop(input: HookInput, ctx: SessionEngineContext): Promise<SessionStopResult> {
  const { ledger, mode } = ctx;
  const root = ledger.root;
  const events = sessionEvents(ledger);
  const baseline = latestStartedFor(events, input.hostSessionId);
  const prior = stopCheckEvents(ledger, input.hostSessionId);
  const continuationsUsed = prior.filter((event) => (event.payload as Record<string, unknown>)['decision'] === 'continue').length;
  const seq = prior.length + 1;

  const git = await isGitWorkTree(root);
  const createdInSession = baseline ? tasksCreatedAfter(events, baseline.event) : new Set<string>();
  const owned = ownedFiles(ledger, createdInSession);
  const checkpoints = baseline ? tasksWithCheckpoint(events, baseline.event) : new Set<string>();
  const failedVerifies = baseline ? failedVerifyTasks(events, baseline.event) : new Set<string>();
  const decisionNote = baseline ? hasDecisionNote(events, baseline.event) : false;

  // 本次会话相对基线的新增/改动文件（非 Git 根为空）。
  const changed = baseline && git ? await changedSinceBaseline(root, baseline.dirty) : [];

  const checks: SessionCheck[] = [];
  // C1 改动有归属：非 Git 根跳过（计为 ok=true，避免虚假 continue）。
  if (!git) {
    checks.push({ id: 'C1', ok: true, items: [] });
  } else {
    const unowned = changed.filter((file) => !owned.has(file));
    checks.push({ id: 'C1', ok: unowned.length === 0, items: unowned });
  }
  // C2 进行中任务有断点：本会话改动了声明文件的 in_progress 任务必须有 checkpoint。
  // 新建任务（本会话涉及）也计入；没有文件改动的任务不要求 checkpoint。
  const inProgressChanged = baseline
    ? ledger.getTasks()
      .filter((task) => task.status === 'in_progress' && !checkpoints.has(task.id))
      .filter((task) => createdInSession.has(task.id) || task.declaredFiles.some((file) => changed.includes(file)))
      .map((task) => task.id)
    : [];
  checks.push({ id: 'C2', ok: inProgressChanged.length === 0, items: inProgressChanged });
  // C3 失败 verify 有交代：有后续 checkpoint 或 note。
  const verifyUnresolved = [...failedVerifies].filter((id) => !checkpoints.has(id));
  checks.push({ id: 'C3', ok: verifyUnresolved.length === 0, items: verifyUnresolved });
  // C4 决策留痕（软）：≥2 模块改动且无 decision/pitfall note，只进 checklist。
  const changedModules = new Set<string>();
  for (const file of changed) {
    const parts = file.split('/');
    if (parts.length > 1) changedModules.add(parts[0]!);
  }
  const c4Needed = changedModules.size >= 2 && !decisionNote;
  checks.push({ id: 'C4', ok: !c4Needed, items: c4Needed ? [...changedModules] : [] });

  const hardStop = input.stopContinuation === true || continuationsUsed >= 2;
  const unmet = checks.filter((check) => check.id !== 'C4' && !check.ok);
  const decision: 'continue' | 'stop-ok' = !hardStop && unmet.length > 0 ? 'continue' : 'stop-ok';

  // 幂等：同一 seq 重放返回原事件（session-stop:<host_session_id>:<seq>）。
  const payload: SessionStopCheckedPayload = {
    task_id: `session-stop:${input.hostSessionId}:${seq}`,
    host_session_id: input.hostSessionId,
    seq,
    checks,
    decision,
    continuations_used: decision === 'continue' ? continuationsUsed + 1 : continuationsUsed,
  };
  const appended = await ledger.append({ kind: 'session.stop_checked', payload }, `session-stop:${input.hostSessionId}:${seq}`);
  const event = appended.event ?? stopCheckEvents(ledger, input.hostSessionId).find((candidate) => (candidate.payload as Record<string, unknown>)['seq'] === seq)!;

  const summaryTasks = ledger.getTasks().map((task) => ({
    id: task.id,
    from: 'unknown',
    to: task.status,
    checkpoint: checkpoints.has(task.id),
  }));
  const summaryVerifies = events.filter((candidate) => candidate.kind === 'verify.finished').map((candidate) => {
    const verify = candidate.payload as Record<string, unknown>;
    return {
      task: typeof verify['task_id'] === 'string' ? verify['task_id'] : 'unknown',
      ok: verify['ok'] === true,
      evidence_id: typeof verify['evidence_id'] === 'string' ? verify['evidence_id'] : null,
    };
  });
  const notesRecorded = { decision: 0, pitfall: 0, memory: 0 };
  for (const candidate of events) {
    if (candidate.kind !== 'note.recorded') continue;
    const note = candidate.payload as Record<string, unknown>;
    const kind = note['kind'];
    if (kind === 'decision' || kind === 'pitfall' || kind === 'memory') notesRecorded[kind] += 1;
  }
  const summary = buildSessionSummary({
    host_session_id: input.hostSessionId,
    client: input.client,
    started_at: baseline ? new Date(baseline.event.hlc.physical).toISOString() : null,
    head_commit: baseline?.headCommit ?? null,
  }, {
    tasks: summaryTasks,
    verifies: summaryVerifies,
    notes_recorded: notesRecorded,
    unmet_checks: unmet.map((check) => `${check.id}:${check.items.join(',')}`),
  }, {
    head_commit: await headCommit(root),
    files_changed: changed,
    ended_at: new Date((ctx.now ?? Date.now)()).toISOString(),
  });
  await persistSessionSummary(ledger, summary, seq);

  const checklist: string[] = [];
  for (const check of unmet) {
    if (check.id === 'C1') checklist.push(`C1: 为无归属改动建任务或说明：${check.items.join(', ')}`);
    if (check.id === 'C2') checklist.push(`C2: 为进行中任务写 checkpoint：${check.items.join(', ')}`);
    if (check.id === 'C3') checklist.push(`C3: 记录失败 verify 的原因：${check.items.join(', ')}`);
  }
  if (c4Needed) checklist.push(`C4（提示）: 跨 ${changedModules.size} 个模块改动，建议补一条 decision/pitfall note`);
  if (decision === 'stop-ok' && unmet.length > 0) {
    checklist.push(`未满足项已写入摘要，下次 session-start 置顶：${unmet.map((check) => `C${check.id}`).join(', ')}`);
  }

  const hookDecision: HookDecision = decision === 'continue'
    ? { kind: 'continue', reason: 'ANO 收工检查未满足，请补记后再收工', checklist, ...(!git ? { degraded: { code: 'NOT_GIT_ROOT' as const, detail: '非 Git 根，C1 未检查' } } : {}) }
    : { kind: 'stop-ok', ...(!git ? { degraded: { code: 'NOT_GIT_ROOT' as const, detail: '非 Git 根，C1 未检查' } } : {}) };

  return {
    decision: hookDecision,
    event,
    duplicate: appended.duplicate,
    seq,
    continuationsUsed: payload.continuations_used,
    checks,
    ...(!git ? { degraded: { code: 'NOT_GIT_ROOT' as const, detail: '非 Git 根，C1 未检查' } } : {}),
  };
}

/** 兼容导出：避免上层把本模块误当只读引擎；pre-tool 必须走 T-164。 */
export const SESSION_ENGINE_WRITES_LEDGER = true as const;
