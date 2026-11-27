import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { buildHooksDocument, installClientHooks, resolveHooksTarget, type HookInstallClient } from '../clients/install.ts';
import { readConfig, writeDefaultConfig } from './config.ts';
import { doctor, type InstallationInput } from '../surface/doctor.ts';
import { takeoverApply, takeoverGrant, takeoverStatusSurface } from '../surface/service.ts';

export interface SetupOptions {
  readonly root: string;
  readonly client: HookInstallClient;
  readonly home?: string;
  readonly interactive: boolean;
  readonly grantedBy?: string;
  readonly confirm?: (step: string, preview: unknown) => Promise<boolean>;
  readonly installation?: InstallationInput;
}

export interface SetupResult {
  readonly mode: 'plan' | 'applied' | 'stopped';
  readonly root: string;
  readonly client: string;
  readonly preflight: Record<string, unknown>;
  readonly steps: readonly { id: string; status: 'planned' | 'applied' | 'skipped' | 'failed'; detail?: unknown }[];
  readonly rollback: readonly string[];
  readonly doctor?: unknown;
  readonly firstPrompt: string;
}

function authorization(root: string, client: string, grantedBy: string) {
  return {
    authorizationId: createHash('sha256').update(`ano-setup:${root}:${client}:${grantedBy}`).digest('hex'),
    root, clientId: client, scope: ['config', 'install', 'restore'] as ('config' | 'install' | 'restore')[],
    grantedBy, statement: 'Authorize ANO personal setup hooks for this project', grantedAt: new Date().toISOString(),
  };
}

function preflight(root: string, client: string): Record<string, unknown> {
  let git = false;
  try { git = execFileSync('git', ['-C', root, 'rev-parse', '--is-inside-work-tree'], { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim() === 'true'; } catch { /* reported below */ }
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  return {
    rootExists: existsSync(root), gitWorkTree: git,
    node: process.version, nodeSupported: major > 22 || (major === 22 && minor >= 18),
    pmExists: existsSync(resolve(root, '.pm')), client,
    hooksSupported: client === 'zcode' || client === 'claude-code',
  };
}

/** Every write is behind an independent affirmative TTY confirmation. */
export async function runSetup(options: SetupOptions): Promise<SetupResult> {
  const root = resolve(options.root);
  const check = preflight(root, options.client);
  const firstPrompt = '先读取 ANO brief，告诉我当前焦点、上次断点和未解决检查，再继续任务。';
  const base = { root, client: options.client, preflight: check, firstPrompt };
  if (!check.rootExists || !check.gitWorkTree || !check.nodeSupported || !check.hooksSupported) {
    return { ...base, mode: 'stopped', steps: [{ id: 'preflight', status: 'failed', detail: check }], rollback: [] };
  }
  const report = await doctor(root, options.installation ?? {});
  if (report.checks.some((item) => item.status === 'fail')) {
    return { ...base, mode: 'stopped', steps: [{ id: 'doctor', status: 'failed', detail: report.checks }], rollback: [], doctor: report };
  }
  const human = options.grantedBy?.trim() || '[TTY 输入具名授权人]';
  const grantPreview = {
    scope: ['tasks', 'memory', 'acceptance', 'dag'], grantedBy: human,
    role: 'project-owner', statement: `Authorize ANO takeover for ${root}`,
  };
  const currentStatus = check.pmExists === true ? takeoverStatusSurface(root) : undefined;
  const takeoverState = currentStatus?.['state'];
  if (check.pmExists === true && takeoverState !== 'disabled' && takeoverState !== 'enforced') {
    return {
      ...base, mode: 'stopped',
      steps: [{ id: 'takeover-status', status: 'failed', detail: currentStatus }], rollback: [],
    };
  }
  const takeoverSteps = check.pmExists !== true ? [] : takeoverState === 'enforced'
    ? [{ id: 'takeover-grant', status: 'skipped' as const, detail: 'takeover already enforced; existing authorization is preserved' }]
    : [{ id: 'takeover-grant', status: 'planned' as const, detail: grantPreview }, { id: 'takeover-apply', status: 'planned' as const }];
  const target = resolveHooksTarget(options.client, { root, home: options.home ?? homedir() });
  const planned = [
    ...takeoverSteps,
    { id: 'hooks-install', status: 'planned' as const, detail: target.path },
    { id: 'personal-config', status: 'planned' as const },
    { id: 'doctor', status: 'planned' as const },
  ];
  if (!options.interactive) return { ...base, mode: 'plan', steps: planned, rollback: [] };
  if (!options.grantedBy?.trim() || !options.confirm) {
    return { ...base, mode: 'stopped', steps: [{ id: 'authorization', status: 'failed', detail: 'interactive setup requires a named human and confirmation callback' }], rollback: [] };
  }
  const confirm = options.confirm;
  const steps: { id: string; status: 'planned' | 'applied' | 'skipped' | 'failed'; detail?: unknown }[] = [];
  const rollback: string[] = [];
  let activeStep = 'takeover-grant';
  try {
    if (check.pmExists === true && takeoverState === 'disabled') {
      if (!await confirm(activeStep, grantPreview)) return { ...base, mode: 'stopped', steps: [{ id: activeStep, status: 'skipped' }], rollback };
      const granted = await takeoverGrant(root, grantPreview);
      steps.push({ id: activeStep, status: 'applied', detail: granted });
      rollback.unshift(`ano takeover revoke --root ${JSON.stringify(root)} --confirm`);
      const authorizationId = (granted['authorization'] as { authorizationId: string }).authorizationId;
      activeStep = 'takeover-apply';
      const applyPreview = { authorizationId, confirm: true };
      if (!await confirm(activeStep, applyPreview)) return { ...base, mode: 'stopped', steps: [...steps, { id: activeStep, status: 'skipped' }], rollback };
      const applied = await takeoverApply(root, { authorizationId });
      if (applied['state'] !== 'enforced') {
        if (applied['state'] === 'recovery') rollback.unshift(`ano takeover recover --root ${JSON.stringify(root)} --confirm`);
        return { ...base, mode: 'stopped', steps: [...steps, { id: activeStep, status: 'failed', detail: applied }], rollback };
      }
      steps.push({ id: activeStep, status: 'applied', detail: applied });
      rollback.unshift(
        `ano takeover disable --root ${JSON.stringify(root)} --confirm`,
        `ano takeover recover --root ${JSON.stringify(root)} --confirm`,
      );
    } else if (check.pmExists === true) {
      steps.push({ id: activeStep, status: 'skipped', detail: 'takeover already enforced; existing authorization is preserved' });
    }
    activeStep = 'hooks-install';
    const document = buildHooksDocument(options.client, root);
    const auth = authorization(root, options.client, options.grantedBy);
    const preview = installClientHooks(target, document, { mode: 'dry-run', root, authorization: auth });
    if (preview.error) return { ...base, mode: 'stopped', steps: [...steps, { id: activeStep, status: 'failed', detail: preview.error }], rollback };
    if (!await confirm(activeStep, preview)) return { ...base, mode: 'stopped', steps: [...steps, { id: activeStep, status: 'skipped' }], rollback };
    await mkdir(dirname(target.path), { recursive: true });
    const hooks = installClientHooks(target, document, { mode: 'apply', confirm: true, root, authorization: auth });
    if (hooks.error || (!hooks.applied && hooks.changed)) {
      return { ...base, mode: 'stopped', steps: [...steps, { id: activeStep, status: 'failed', detail: hooks }], rollback };
    }
    steps.push({ id: activeStep, status: hooks.changed ? 'applied' : 'skipped', detail: hooks });
    if (hooks.backupId) {
      rollback.unshift(`ano clients restore ${options.client} --backup-id ${hooks.backupId} --granted-by ${JSON.stringify(options.grantedBy)} --statement "Restore hooks installed by setup" --scope config,restore --config-path ${JSON.stringify(target.path)}${options.home ? ` --home ${JSON.stringify(options.home)}` : ''} --confirm --root ${JSON.stringify(root)}`);
    }
    activeStep = 'personal-config';
    if (!await confirm(activeStep, { path: resolve(root, '.ano', 'config.toml'), profile: 'personal', mode: 'advisory', preservesExisting: true })) {
      return { ...base, mode: 'stopped', steps: [...steps, { id: activeStep, status: 'skipped' }], rollback };
    }
    const config = await writeDefaultConfig(root);
    steps.push({ id: activeStep, status: config.written ? 'applied' : 'skipped', detail: { ...config, config: readConfig(root) } });
    activeStep = 'doctor';
    const finalReport = await doctor(root, options.installation ?? {});
    const failed = finalReport.checks.some((item) => item.status === 'fail');
    steps.push({ id: activeStep, status: failed ? 'failed' : 'applied', detail: finalReport.checks });
    return { ...base, mode: failed ? 'stopped' : 'applied', steps, rollback, doctor: finalReport };
  } catch (error) {
    if (activeStep === 'takeover-apply') {
      const state = takeoverStatusSurface(root)['state'];
      if (state === 'enforced') {
        rollback.unshift(
          `ano takeover disable --root ${JSON.stringify(root)} --confirm`,
          `ano takeover recover --root ${JSON.stringify(root)} --confirm`,
        );
      } else if (state === 'recovery') {
        rollback.unshift(`ano takeover recover --root ${JSON.stringify(root)} --confirm`);
      } else if (state !== 'disabled') {
        rollback.splice(0, rollback.length, `ano takeover status --root ${JSON.stringify(root)}`);
      }
    }
    const detail = error instanceof Error ? error.message : String(error);
    return { ...base, mode: 'stopped', steps: [...steps, { id: activeStep, status: 'failed', detail }], rollback };
  }
}
