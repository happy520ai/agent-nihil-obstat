import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  CAPABILITY_LAYERS,
  CLIENT_REPORT_SCHEMA,
  MCP_TOOL_NAMES,
  type CapabilityLayer,
  type ClientAdapter,
  type ClientReport,
  type ClientVerdict,
  type McpClientLike,
} from '../../src/clients/types.ts';
import { defaultRegistry, resolveClientId } from '../../src/clients/registry.ts';
import { doctorClient } from '../../src/clients/doctor.ts';
import {
  DEEPSEEK_HARNESS_ALIAS,
  DEEPSEEK_HARNESS_CONFIG_CANDIDATES,
  DEEPSEEK_HARNESS_ID,
  DEEPSEEK_HARNESS_IDENTITY_SOURCES,
  DEEPSEEK_HARNESS_MCP_CLIENT_PACKAGE,
  DEEPSEEK_HARNESS_NPM_PACKAGE,
  DEEPSEEK_HARNESS_OFFICIAL_SOURCES,
  DSH_CONFIG_REFUSED_PREFIX,
  DSH_MEASURED_FACT_PREFIX,
  DSH_PUBLIC_ASSUMPTION_PREFIX,
  createDeepSeekHarnessAdapter,
} from '../../src/clients/deepseek-harness.ts';
import {
  UNKNOWN_CLIENT_IDS,
  buildUnknownClientReport,
  createUnknownAdapter,
  dshAdapter,
  enforceUnknownReport,
  isUnknownClientId,
  piAdapter,
  registerExternalAdapter,
  validateExternalAdapter,
  type ExternalAdapterDeclaration,
  type ExternalAdapterValidation,
} from '../../src/clients/unknown.ts';

const AT = '2026-11-23T00:00:00.000Z';

async function temp(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

function emptyVerdicts(): Record<CapabilityLayer, ClientVerdict> {
  return {
    detected: 'unavailable',
    configured: 'unavailable',
    mcp: 'unavailable',
    tools: 'unavailable',
    brief: 'unavailable',
    instructions: 'unavailable',
    orchestration: 'unavailable',
    history: 'unavailable',
    'output-interception': 'unavailable',
  };
}

function injectedClient(): McpClientLike {
  return {
    initialize: async () => ({ protocolVersion: '2025-06-18', serverInfo: { name: 'fake-ano', version: '1.0.0' } }),
    listTools: async () => ({ tools: MCP_TOOL_NAMES.map((name) => ({ name })) }),
    callTool: async (request) =>
      request.name === 'brief'
        ? { content: [{ type: 'text', text: JSON.stringify({ phase: 'P7', project_scope: 'local' }) }] }
        : { isError: true, content: [] },
    close: async () => {},
  };
}

function dshAdapterOptions(home: string, root: string, bin?: string) {
  return {
    home,
    root,
    probePaths: bin === undefined ? [] : [bin],
    env: { PATH: '' },
    now: () => AT,
  };
}

// ---------------------------------------------------------------------------
// Identity, public sources and alias semantics
// ---------------------------------------------------------------------------

test('deepseek-harness identity and public interface sources are declared', () => {
  const descriptor = defaultRegistry.get('deepseek-harness');
  assert.equal(descriptor.id, DEEPSEEK_HARNESS_ID);
  assert.equal(descriptor.alias, DEEPSEEK_HARNESS_ALIAS);
  assert.equal(descriptor.identityStatus, 'declared');
  assert.equal(descriptor.initialVerdict, 'unverified');
  assert.ok(descriptor.officialSources.some((source) => source.includes('deepseek.com/harness')));
  assert.ok(descriptor.officialSources.some((source) => source.includes('github.com/deepseek-ai/deepseek-harness')));
  assert.ok(descriptor.officialSources.some((source) => source.includes('deepseek-harness.github.io')));
  assert.deepEqual(DEEPSEEK_HARNESS_OFFICIAL_SOURCES, descriptor.officialSources);

  const adapter = createDeepSeekHarnessAdapter({ now: () => AT });
  assert.equal(adapter.id, DEEPSEEK_HARNESS_ID);
  assert.ok(adapter.identitySources.some((source) => source.kind === 'executable' && source.value === 'dsh'));
  assert.ok(adapter.identitySources.some((source) => source.kind === 'env' && source.value === 'DSH_HOME'));
  assert.ok(adapter.identitySources.some((source) => source.kind === 'config-path' && source.value === 'cordis.yml'));
  assert.ok(DEEPSEEK_HARNESS_IDENTITY_SOURCES.length >= 4);

  assert.equal(DEEPSEEK_HARNESS_MCP_CLIENT_PACKAGE, '@deepseek-ai/dsh-mcp-client');
  assert.equal(DEEPSEEK_HARNESS_NPM_PACKAGE, '@deepseek-ai/dsh');
  for (const candidate of DEEPSEEK_HARNESS_CONFIG_CANDIDATES) {
    assert.equal(candidate.format, 'yaml');
    assert.equal(candidate.key, null, 'the Cordis patch schema is unverified and must not be guessed');
  }
});

test('dsh alias resolves to deepseek-harness and is not an unknown client', () => {
  assert.equal(resolveClientId('dsh'), 'deepseek-harness');
  assert.equal(defaultRegistry.get('dsh').id, 'deepseek-harness');
  assert.equal(defaultRegistry.get('dsh').identityStatus, 'declared');
  assert.equal(isUnknownClientId('dsh'), false);
  assert.equal(isUnknownClientId('pi'), true);
  assert.deepEqual([...UNKNOWN_CLIENT_IDS], ['pi']);
  assert.equal(dshAdapter.id, DEEPSEEK_HARNESS_ID, 'the compatibility export is the real adapter, not an unknown one');
  assert.equal(piAdapter.id, 'pi');
});

// ---------------------------------------------------------------------------
// detect: declared sources only
// ---------------------------------------------------------------------------

test('detect probes declared sources only and never guesses private paths', async () => {
  const home = await temp('ano-dsh-detect-');
  const root = await temp('ano-dsh-detect-root-');
  try {
    const bin = join(home, 'bin');
    await mkdir(bin);
    await writeFile(join(bin, 'dsh'), '#!/usr/bin/env node\nprocess.exit(0);\n');

    const result = await createDeepSeekHarnessAdapter(dshAdapterOptions(home, root, bin)).detect({
      probePaths: [bin],
      env: { PATH: '', DSH_HOME: '' },
    });
    assert.equal(result.detected, true);
    assert.equal(result.executablePath, join(bin, 'dsh'));
    assert.ok(result.sources.some((source) => source.source === 'executable:dsh'));
    assert.ok(!result.sources.some((source) => source.source.includes('.dsh')));
    assert.ok(!result.sources.some((source) => source.source.includes('.deepseek')));

    const empty = await createDeepSeekHarnessAdapter(dshAdapterOptions(home, root)).detect({
      probePaths: [],
      env: { PATH: '', DSH_HOME: '' },
    });
    assert.equal(empty.detected, false);
    assert.deepEqual(empty.sources, []);
    assert.equal(empty.errors[0]?.code, 'E1_NO_DECLARED_SOURCE');
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('detect expands $DSH_HOME from the injected env and probes the declared patch path', async () => {
  const home = await temp('ano-dsh-env-');
  const root = await temp('ano-dsh-env-root-');
  try {
    const dshHome = join(home, 'dsh-home');
    await mkdir(dshHome, { recursive: true });
    const patch = join(dshHome, 'cordis.patch.yml');
    await writeFile(patch, 'plugins: {}\n');

    const result = await createDeepSeekHarnessAdapter(dshAdapterOptions(home, root)).detect({
      probePaths: [],
      env: { PATH: '', DSH_HOME: dshHome },
    });
    assert.equal(result.detected, true);
    assert.ok(result.sources.some((source) => source.kind === 'env' && source.source === 'env:DSH_HOME'));
    assert.ok(result.sources.some((source) => source.kind === 'config-path' && source.source === `path:${patch}`));
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// inspect: evidence-driven, no permanent ban
// ---------------------------------------------------------------------------

test('inspect keeps unmeasured capability layers degraded but never permanently unavailable', async () => {
  const home = await temp('ano-dsh-inspect-');
  const root = await temp('ano-dsh-inspect-root-');
  try {
    const bin = join(home, 'bin');
    await mkdir(bin);
    await writeFile(join(bin, 'dsh'), '#!/usr/bin/env node\nprocess.exit(0);\n');

    const report = await createDeepSeekHarnessAdapter(dshAdapterOptions(home, root, bin)).inspect({
      root,
      env: { PATH: '', DSH_HOME: '' },
    });
    assert.equal(report.schema, CLIENT_REPORT_SCHEMA);
    assert.equal(report.clientId, DEEPSEEK_HARNESS_ID);
    assert.equal(report.alias, DEEPSEEK_HARNESS_ALIAS);
    assert.equal(report.status, 'degraded');
    assert.equal(report.coreVerdict, 'degraded');
    for (const layer of CAPABILITY_LAYERS) {
      assert.notEqual(report.layers[layer].verdict, 'validated', `${layer} must not be validated while unmeasured`);
    }
    for (const layer of ['mcp', 'tools', 'brief'] as const) {
      assert.equal(report.layers[layer].verdict, 'degraded', `${layer} is degraded, not the old permanent unavailable`);
      assert.equal(report.layers[layer].evidence, 'assumed');
    }
    assert.ok(report.limitations.some((line) => line.includes(DSH_MEASURED_FACT_PREFIX)));
    assert.ok(report.limitations.some((line) => line.includes(DSH_PUBLIC_ASSUMPTION_PREFIX)));
    assert.ok(report.limitations.some((line) => line.includes(DEEPSEEK_HARNESS_MCP_CLIENT_PACKAGE)));
    assert.ok(report.limitations.some((line) => line.includes('ACP/SDK')));
    assert.ok(report.limitations.some((line) => line.includes('未实测')));
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('inspect degrades to unavailable when no declared source exists on this machine', async () => {
  const home = await temp('ano-dsh-absent-');
  const root = await temp('ano-dsh-absent-root-');
  try {
    const report = await createDeepSeekHarnessAdapter(dshAdapterOptions(home, root)).inspect({
      root,
      env: { PATH: '', DSH_HOME: '' },
    });
    assert.equal(report.status, 'unavailable');
    assert.equal(report.coreVerdict, 'unavailable');
    assert.equal(report.layers.detected.verdict, 'unavailable');
    assert.equal(report.layers.mcp.verdict, 'unavailable');
    assert.ok(report.limitations.some((line) => line.includes('本机未发现')));
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('enforceUnknownReport no longer forces deepseek-harness unavailable', () => {
  const piReport = buildUnknownClientReport('pi', AT);
  const dshReport: ClientReport = {
    ...piReport,
    clientId: DEEPSEEK_HARNESS_ID,
    alias: DEEPSEEK_HARNESS_ALIAS,
    status: 'degraded',
    coreVerdict: 'degraded',
  };
  const enforcedDsh = enforceUnknownReport(dshReport);
  assert.equal(enforcedDsh.status, 'degraded');
  assert.equal(enforcedDsh.coreVerdict, 'degraded');

  const lyingPi: ClientReport = { ...piReport, status: 'ready', coreVerdict: 'validated' };
  const enforcedPi = enforceUnknownReport(lyingPi);
  assert.equal(enforcedPi.status, 'unknown');
  assert.equal(enforcedPi.coreVerdict, 'unavailable');
  for (const layer of CAPABILITY_LAYERS) {
    assert.equal(enforcedPi.layers[layer].verdict, 'unavailable');
  }
});

// ---------------------------------------------------------------------------
// config: zero write, no fabricated writable target
// ---------------------------------------------------------------------------

test('config is zero-write and refuses apply because Cordis YAML is not T-081-writable', async () => {
  const home = await temp('ano-dsh-config-');
  const root = await temp('ano-dsh-config-root-');
  try {
    const adapter = createDeepSeekHarnessAdapter(dshAdapterOptions(home, root));

    const dry = await adapter.config({ mode: 'dry-run', target: { scope: 'user' } });
    assert.equal(dry.mode, 'dry-run');
    assert.deepEqual(dry.changes, []);
    assert.equal(dry.backupPlan, null);
    assert.ok(dry.warnings.some((line) => line.includes('YAML')));
    assert.deepEqual(await readdir(root), []);

    const authorization = {
      authorizationId: 'auth-1',
      root,
      clientId: DEEPSEEK_HARNESS_ID,
      scope: ['config'],
      grantedBy: 'tester',
      grantedAt: AT,
      revokedAt: null,
    };
    const apply = await adapter.config({
      mode: 'apply',
      target: { scope: 'user' },
      authorization,
      backup: true,
      root,
    });
    assert.equal(apply.mode, 'dry-run');
    assert.deepEqual(apply.changes, []);
    assert.ok(apply.warnings.some((line) => line.includes('refused')));
    assert.deepEqual(await readdir(root), [], 'no backup or config file may be created');

    const outside = await adapter.config({
      mode: 'dry-run',
      target: { scope: 'user', path: join(home, 'not-declared', 'cordis.patch.yml') },
    });
    assert.deepEqual(outside.changes, []);
    assert.equal(outside.mode, 'dry-run');
    assert.ok(outside.warnings.some((line) => line.includes(DSH_CONFIG_REFUSED_PREFIX)));
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// verify: real ANO MCP handshake, ACP/SDK refused
// ---------------------------------------------------------------------------

test('verify performs the ANO MCP seven-tool handshake and refuses ACP/SDK profiles', async () => {
  const adapter = createDeepSeekHarnessAdapter({ now: () => AT });

  const ok = await adapter.verify({ transport: 'stdio', inject: injectedClient() });
  assert.equal(ok.verdicts.mcp, 'validated');
  assert.equal(ok.verdicts.tools, 'validated');
  assert.equal(ok.verdicts.brief, 'validated');
  assert.deepEqual(ok.tools?.names, [...MCP_TOOL_NAMES]);

  const acp = await adapter.verify({ transport: 'stdio', command: 'dsh', args: ['--profile', 'acp'] });
  assert.equal(acp.handshake, null);
  assert.equal(acp.verdicts.mcp, 'unavailable');
  assert.equal(acp.errors[0]?.code, 'E3_DSH_PROFILE_NOT_MCP');
  assert.ok(acp.errors[0]?.message.includes('ACP/SDK'));

  const sdk = await adapter.verify({ transport: 'stdio', command: 'dsh', args: ['--profile=sdk'] });
  assert.equal(sdk.errors[0]?.code, 'E3_DSH_PROFILE_NOT_MCP');

  const none = await adapter.verify({ transport: 'stdio' });
  assert.equal(none.handshake, null);
  assert.equal(none.errors[0]?.code, 'E3_NO_COMMAND');
});

// ---------------------------------------------------------------------------
// doctor integration
// ---------------------------------------------------------------------------

test('doctor reports deepseek-harness as declared/degraded, not unknown', async () => {
  const home = await temp('ano-dsh-doctor-');
  const root = await temp('ano-dsh-doctor-root-');
  try {
    const bin = join(home, 'bin');
    await mkdir(bin);
    await writeFile(join(bin, 'dsh'), '#!/usr/bin/env node\nprocess.exit(0);\n');
    const adapter = createDeepSeekHarnessAdapter(dshAdapterOptions(home, root, bin));
    const report = await doctorClient(defaultRegistry.get('dsh'), {
      adapters: { [DEEPSEEK_HARNESS_ID]: adapter },
      home,
      root,
      probePaths: [bin],
      env: { PATH: '', DSH_HOME: '' },
      now: () => AT,
    });
    assert.equal(report.clientId, DEEPSEEK_HARNESS_ID);
    assert.equal(report.alias, DEEPSEEK_HARNESS_ALIAS);
    assert.notEqual(report.status, 'unknown');
    assert.equal(report.status, 'degraded');
    assert.notEqual(report.coreVerdict, 'validated');
    assert.ok(report.limitations.some((line) => line.includes('ACP/SDK')));
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('pi keeps the M11 unknown degradation', async () => {
  const adapter = createUnknownAdapter('pi', { now: () => AT });
  const report = await adapter.inspect({});
  assert.equal(report.status, 'unknown');
  assert.equal(report.coreVerdict, 'unavailable');
  for (const layer of CAPABILITY_LAYERS) {
    assert.equal(report.layers[layer].verdict, 'unavailable');
  }
  assert.equal(buildUnknownClientReport('pi', AT).status, 'unknown');
});

// ---------------------------------------------------------------------------
// Third-party external adapter extension stays strict
// ---------------------------------------------------------------------------

function declaration(overrides: Partial<ExternalAdapterDeclaration> = {}): ExternalAdapterDeclaration {
  return {
    id: 'claude-code',
    identitySources: [{ kind: 'executable', value: 'claude', detail: null }],
    detect: async () => ({
      clientId: 'claude-code',
      detected: true,
      executablePath: '/fake/claude',
      version: '1.0.0',
      sources: [],
      errors: [],
    }),
    inspect: async () => buildUnknownClientReport('pi', AT),
    config: async () => ({ mode: 'dry-run', changes: [], backupPlan: null, warnings: [] }),
    verify: async () => ({ handshake: null, tools: null, brief: null, verdicts: emptyVerdicts(), errors: [] }),
    capabilities: { layers: ['detected', 'mcp'] },
    evidence: { source: 'https://example.test/evidence', measured: false },
    ...overrides,
  };
}

const validValidation: ExternalAdapterValidation = {
  evidenceSource: 'https://example.test/validation',
  measured: false,
};

test('external adapter validation keeps the four-interface, capability and evidence requirements', () => {
  for (const field of ['detect', 'inspect', 'config', 'verify'] as const) {
    const broken = declaration();
    delete (broken as unknown as Record<string, unknown>)[field];
    const result = validateExternalAdapter(broken, validValidation);
    assert.equal(result.ok, false, `${field} must be required`);
    assert.ok(result.issues.some((issue) => issue.code === `${field.toUpperCase()}_MISSING`));
  }
  const noCapabilities = declaration();
  delete (noCapabilities as unknown as Record<string, unknown>).capabilities;
  assert.ok(validateExternalAdapter(noCapabilities, validValidation).issues.some((issue) => issue.code === 'CAPABILITIES_MISSING'));

  const noEvidence = declaration({ evidence: { source: '', measured: false } });
  assert.ok(validateExternalAdapter(noEvidence, validValidation).issues.some((issue) => issue.code === 'EVIDENCE_SOURCE_MISSING'));

  const incomplete = declaration({ evidence: { source: 'https://example.test/e', measured: true } });
  const incompleteResult = validateExternalAdapter(incomplete, validValidation);
  assert.ok(incompleteResult.issues.some((issue) => issue.code === 'EVIDENCE_MEASURED_AT_MISSING'));
  assert.ok(incompleteResult.issues.some((issue) => issue.code === 'EVIDENCE_VERSION_MISSING'));
});

test('external adapters cannot claim the still-unknown pi identity', () => {
  const result = validateExternalAdapter(declaration({ id: 'pi' }), validValidation);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === 'ID_IDENTITY_UNKNOWN'));
});

test('registered external adapter still caps self-reported validated verdicts and refuses apply', async () => {
  const lyingReport: ClientReport = {
    ...buildUnknownClientReport('pi', AT),
    clientId: 'claude-code',
    alias: null,
    status: 'ready',
    coreVerdict: 'validated',
  };
  const adapter: ClientAdapter = registerExternalAdapter(
    declaration({
      inspect: async () => lyingReport,
      config: async () => ({
        mode: 'apply',
        backupId: 'b',
        backupHash: 'h',
        beforeHash: 'a',
        afterHash: 'b',
        changes: [],
        restoredOnFailure: false,
      }),
    }),
    validValidation,
  );
  const report = await adapter.inspect({});
  assert.notEqual(report.status, 'ready');
  assert.notEqual(report.coreVerdict, 'validated');
  assert.ok(report.limitations.some((line) => line.includes('capped')));

  const config = await adapter.config({ mode: 'apply', target: { scope: 'user' } });
  assert.equal(config.mode, 'dry-run');
  assert.deepEqual(config.changes, []);
  assert.ok(config.warnings.some((line) => line.includes('config-refused')));
});

// ---------------------------------------------------------------------------
// Report shape guard
// ---------------------------------------------------------------------------

test('every produced report has the nine-layer ADR shape', async () => {
  const home = await temp('ano-dsh-shape-');
  const root = await temp('ano-dsh-shape-root-');
  try {
    const reports: ClientReport[] = [
      await createDeepSeekHarnessAdapter(dshAdapterOptions(home, root)).inspect({ root, env: { PATH: '', DSH_HOME: '' } }),
      buildUnknownClientReport('pi', AT),
    ];
    for (const report of reports) {
      assert.deepEqual(Object.keys(report.layers).sort(), [...CAPABILITY_LAYERS].sort());
      for (const layer of CAPABILITY_LAYERS) {
        const entry = report.layers[layer];
        assert.equal(entry.layer, layer);
        assert.ok(entry.verdict === 'validated' || entry.verdict === 'degraded' || entry.verdict === 'unavailable');
        assert.ok(
          entry.evidence === 'measured' ||
            entry.evidence === 'configured' ||
            entry.evidence === 'assumed' ||
            entry.evidence === 'absent',
        );
      }
    }
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('deepseek-harness adapter never reports a validated layer without a real handshake', async () => {
  const home = await temp('ano-dsh-novalidate-');
  const root = await temp('ano-dsh-novalidate-root-');
  try {
    const bin = join(home, 'bin');
    await mkdir(bin);
    await writeFile(join(bin, 'dsh'), '#!/usr/bin/env node\nprocess.exit(0);\n');
    const adapter = createDeepSeekHarnessAdapter(dshAdapterOptions(home, root, bin));
    const report = await adapter.inspect({ root, env: { PATH: '', DSH_HOME: '' } });
    for (const layer of CAPABILITY_LAYERS) {
      assert.notEqual(report.layers[layer].verdict, 'validated', `${layer} must stay unvalidated in inspect`);
    }
    const verify = await adapter.verify({ transport: 'stdio', inject: injectedClient() });
    assert.equal(verify.verdicts.mcp, 'validated');
    assert.equal(verify.verdicts.tools, 'validated');
    assert.equal(verify.verdicts.brief, 'validated');
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
