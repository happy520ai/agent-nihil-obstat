import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  CAPABILITY_LAYERS,
  MCP_TOOL_NAMES,
  type CapabilityLayer,
  type ClientAdapter,
  type ClientId,
  type ClientReport,
  type ClientVerdict,
  type DetectResult,
  type LayerReport,
  type McpClientLike,
} from '../../src/clients/types.ts';
import { getDescriptor, resolveClientId } from '../../src/clients/registry.ts';
import { doctorClient, doctorClients } from '../../src/clients/doctor.ts';
import {
  QODER_CONFIG_CANDIDATES,
  QODER_CONFIG_FACT_PREFIX,
  QODER_MEASURED_FACT_PREFIX,
  QODER_PUBLIC_ASSUMPTION_PREFIX,
  createQoderAdapter,
  type QoderFs,
} from '../../src/clients/qoder.ts';
import {
  ExternalAdapterRejectedError,
  UNKNOWN_CLIENT_IDS,
  buildUnknownClientReport,
  createUnknownAdapter,
  enforceUnknownReport,
  registerExternalAdapter,
  validateExternalAdapter,
  type ExternalAdapterDeclaration,
  type ExternalAdapterValidation,
} from '../../src/clients/unknown.ts';

const AT = '2026-11-22T00:00:00.000Z';
const HOME = join(tmpdir(), 'ano-qoder-fake-home');
const ROOT = join(tmpdir(), 'ano-qoder-fake-root');

function expand(path: string): string {
  let value = path;
  if (value === '~') value = HOME;
  else if (value.startsWith('~/')) value = `${HOME}/${value.slice(2)}`;
  else if (value.startsWith('~\\')) value = `${HOME}\\${value.slice(2)}`;
  value = value.split('<root>').join(ROOT);
  return resolve(value);
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

class FakeQoderFs implements QoderFs {
  readonly files = new Map<string, string>();
  readonly writes: string[] = [];

  isFile(path: string): boolean {
    return this.files.has(path);
  }

  readJson(path: string): { ok: true; value: unknown } | { ok: false; error: string } {
    const content = this.files.get(path);
    if (content === undefined) return { ok: false, error: 'ENOENT' };
    try {
      return { ok: true, value: JSON.parse(content) as unknown };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}

function qoderAdapter(fs: FakeQoderFs): ClientAdapter {
  return createQoderAdapter({ now: () => AT, home: HOME, root: ROOT, fs });
}

function allLayersUnavailable(report: ClientReport): boolean {
  return CAPABILITY_LAYERS.every((layer) => report.layers[layer].verdict === 'unavailable');
}

// ---------------------------------------------------------------------------
// Qoder: declared public sources only
// ---------------------------------------------------------------------------

test('qoder detect probes declared sources only and never guesses an install path', async () => {
  const fs = new FakeQoderFs();
  fs.files.set(expand('~/.qoder/settings.json'), JSON.stringify({ mcpServers: {} }));
  // Undeclared local launcher path: present on disk but not a declared source.
  fs.files.set(expand('~/.qoder/entry/qoder.cmd'), 'launcher');

  const result = await qoderAdapter(fs).detect({});

  assert.equal(result.detected, true);
  assert.equal(result.executablePath, null);
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0]?.kind, 'config-path');
  assert.ok(!result.sources.some((source) => source.source.includes('entry/qoder.cmd')));
  assert.ok(!result.sources.some((source) => source.source.includes('qoder.cmd')));
});

test('qoder detect finds an executable only from injected probe paths', async () => {
  const fs = new FakeQoderFs();
  const bin = join(tmpdir(), 'ano-qoder-fake-bin');
  fs.files.set(join(bin, 'qoder.exe'), 'binary');

  const result = await qoderAdapter(fs).detect({ probePaths: [bin] });

  assert.equal(result.detected, true);
  assert.equal(result.executablePath, join(bin, 'qoder.exe'));
  assert.equal(result.sources[0]?.kind, 'executable');
  assert.equal(result.sources[0]?.source, 'executable:qoder');
});

test('qoder detect reports not-detected without throwing or guessing', async () => {
  const result = await qoderAdapter(new FakeQoderFs()).detect({});

  assert.equal(result.detected, false);
  assert.deepEqual(result.sources, []);
  assert.equal(result.errors[0]?.code, 'E1_NO_DECLARED_SOURCE');
});

test('qoder inspect keeps measured facts and configuration facts separate', async () => {
  const fs = new FakeQoderFs();
  fs.files.set(
    expand('~/.qoder/settings.json'),
    JSON.stringify({
      mcpServers: {
        ano: { type: 'stdio', command: 'node', args: ['dist/surface/mcp.js'], env: { ANO_TOKEN: 'do-not-leak' } },
      },
    }),
  );

  const report = await qoderAdapter(fs).inspect({});

  assert.equal(report.status, 'degraded');
  // Core chain takes the weakest of detected/configured/mcp/tools/brief;
  // mcp/tools/brief are unmeasured here, so the core verdict is unavailable.
  assert.equal(report.coreVerdict, 'unavailable');

  const detected = report.layers.detected;
  assert.equal(detected.verdict, 'degraded');
  assert.equal(detected.evidence, 'measured');
  assert.ok(detected.limitations.some((line) => line.startsWith(QODER_MEASURED_FACT_PREFIX)));

  const configured = report.layers.configured;
  assert.equal(configured.verdict, 'degraded');
  assert.equal(configured.evidence, 'configured');
  assert.equal(configured.details.exists, true);
  assert.equal(configured.details.key, 'mcpServers.ano');
  assert.equal(configured.source, expand('~/.qoder/settings.json'));
  assert.ok(configured.limitations.some((line) => line.startsWith(QODER_CONFIG_FACT_PREFIX)));

  const serialized = JSON.stringify(configured.details.resolvedEntry);
  assert.ok(!serialized.includes('do-not-leak'), 'environment values must never be echoed');
  assert.ok(serialized.includes('ANO_TOKEN'), 'environment key names are allowed');

  for (const layer of ['mcp', 'tools', 'brief', 'instructions', 'orchestration', 'history', 'output-interception'] as const) {
    assert.equal(report.layers[layer].verdict, 'unavailable', `${layer} must stay unavailable`);
  }
  assert.ok(report.limitations.some((line) => line.startsWith(QODER_MEASURED_FACT_PREFIX)));
  assert.ok(report.limitations.some((line) => line.startsWith(QODER_CONFIG_FACT_PREFIX)));
  assert.ok(report.limitations.some((line) => line.startsWith(QODER_PUBLIC_ASSUMPTION_PREFIX)));
});

test('qoder inspect reports an absent configuration fact when no ano entry exists', async () => {
  const fs = new FakeQoderFs();
  fs.files.set(expand('~/.qoder/settings.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }));

  const report = await qoderAdapter(fs).inspect({});

  assert.equal(report.layers.detected.evidence, 'measured');
  const configured = report.layers.configured;
  assert.equal(configured.verdict, 'degraded');
  assert.equal(configured.evidence, 'absent');
  assert.equal(configured.details.exists, false);
  assert.ok(configured.limitations.some((line) => line.startsWith(QODER_CONFIG_FACT_PREFIX)));
});

test('qoder inspect degrades to unavailable when no declared source exists', async () => {
  const report = await qoderAdapter(new FakeQoderFs()).inspect({});

  assert.equal(report.status, 'unavailable');
  assert.equal(report.coreVerdict, 'unavailable');
  assert.ok(allLayersUnavailable(report));
});

test('qoder config only proposes a documented target and refuses apply', async () => {
  const fs = new FakeQoderFs();
  const adapter = qoderAdapter(fs);

  const dryRun = await adapter.config({ mode: 'dry-run', target: { scope: 'user' } });
  assert.ok(dryRun.mode === 'dry-run');
  assert.equal(dryRun.changes.length, 1);
  assert.equal(dryRun.changes[0]?.key, 'mcpServers.ano');
  assert.equal(dryRun.changes[0]?.operation, 'add');
  assert.equal(dryRun.changes[0]?.path, expand(QODER_CONFIG_CANDIDATES[0]?.path ?? '~/.qoder/settings.json'));
  assert.deepEqual(fs.writes, []);

  const refused = await adapter.config({ mode: 'apply', target: { scope: 'user' } });
  assert.ok(refused.mode === 'dry-run');
  assert.deepEqual(refused.changes, []);
  assert.ok(refused.warnings.some((line) => line.includes('refused')));
  assert.deepEqual(fs.writes, []);
});

test('qoder config refuses a path outside the declared candidates', async () => {
  const refused = await qoderAdapter(new FakeQoderFs()).config({
    mode: 'dry-run',
    target: { scope: 'user', path: join(tmpdir(), 'not-declared', 'settings.json') },
  });
  assert.ok(refused.mode === 'dry-run');
  assert.deepEqual(refused.changes, []);
  assert.ok(refused.warnings.some((line) => line.includes('refusing to guess')));
});

test('qoder verify refuses to fabricate a handshake without command or injection', async () => {
  const result = await qoderAdapter(new FakeQoderFs()).verify({ transport: 'stdio' });
  assert.equal(result.handshake, null);
  assert.ok(allVerdictsUnavailable(result.verdicts));
  assert.equal(result.errors[0]?.code, 'E3_NO_COMMAND');
});

test('qoder verify delegates to an injected client and keeps the measured verdicts', async () => {
  const inject: McpClientLike = {
    initialize: async () => ({ protocolVersion: '2025-06-18', serverInfo: { name: 'fake-ano', version: '1.0.0' } }),
    listTools: async () => ({ tools: MCP_TOOL_NAMES.map((name) => ({ name })) }),
    callTool: async (request) =>
      request.name === 'brief'
        ? { content: [{ type: 'text', text: JSON.stringify({ phase: 'P7', project_scope: 'local' }) }] }
        : { isError: true, content: [] },
    close: async () => {},
  };

  const result = await qoderAdapter(new FakeQoderFs()).verify({ transport: 'stdio', inject });
  assert.equal(result.verdicts.mcp, 'validated');
  assert.equal(result.verdicts.tools, 'validated');
  assert.equal(result.verdicts.brief, 'validated');
});

function allVerdictsUnavailable(verdicts: Record<CapabilityLayer, ClientVerdict>): boolean {
  return CAPABILITY_LAYERS.every((layer) => verdicts[layer] === 'unavailable');
}

// ---------------------------------------------------------------------------
// DSH / Pi: unknown degradation, no fabrication
// ---------------------------------------------------------------------------

test('registry resolves dsh to deepseek-harness declared and keeps pi unknown', () => {
  // ADR-008 §8: `dsh` is an alias of the canonical `deepseek-harness`; it is no
  // longer a permanent unknown id.
  assert.equal(resolveClientId('dsh'), 'deepseek-harness');
  assert.equal(getDescriptor('dsh').id, 'deepseek-harness');
  assert.equal(getDescriptor('dsh').alias, 'dsh');
  assert.equal(getDescriptor('dsh').identityStatus, 'declared');
  assert.equal(getDescriptor('pi').identityStatus, 'unknown');
  const unknownIds = UNKNOWN_CLIENT_IDS as readonly string[];
  assert.equal(unknownIds.includes('pi'), true);
  assert.equal(unknownIds.includes('deepseek-harness'), false);
});

test('unknown adapters never crash, never guess paths and never validate', async () => {
  for (const id of UNKNOWN_CLIENT_IDS) {
    const adapter = createUnknownAdapter(id, { now: () => AT });
    assert.deepEqual(adapter.identitySources, []);

    const detect = await adapter.detect({ probePaths: [join(tmpdir(), 'whatever')], env: {} });
    assert.equal(detect.detected, false);
    assert.deepEqual(detect.sources, []);

    const report = await adapter.inspect({});
    assert.equal(report.status, 'unknown');
    assert.equal(report.coreVerdict, 'unavailable');
    assert.ok(allLayersUnavailable(report));
    for (const layer of CAPABILITY_LAYERS) {
      assert.equal(report.layers[layer].evidence, 'absent', `${id}.${layer} evidence must stay absent`);
      assert.ok(!report.layers[layer].verdict.includes('validated'));
    }
    assert.ok(report.limitations.some((line) => line.includes('missing to upgrade')));

    const config = await adapter.config({ mode: 'apply', target: { scope: 'user' } });
    assert.ok(config.mode === 'dry-run');
    assert.deepEqual(config.changes, []);
    assert.ok(config.warnings.some((line) => line.includes('refused')));

    const verify = await adapter.verify({ transport: 'stdio' });
    assert.equal(verify.handshake, null);
    assert.ok(allVerdictsUnavailable(verify.verdicts));
  }
});

test('enforceUnknownReport caps a lying report to unknown degradation', () => {
  const lying = buildUnknownClientReport('pi', AT);
  const fake = {
    ...lying,
    status: 'ready' as const,
    coreVerdict: 'validated' as const,
    layers: {
      ...lying.layers,
      detected: { ...lying.layers.detected, verdict: 'validated' as const, evidence: 'measured' as const },
    },
  };

  const enforced = enforceUnknownReport(fake);
  assert.equal(enforced.status, 'unknown');
  assert.equal(enforced.coreVerdict, 'unavailable');
  assert.ok(allLayersUnavailable(enforced));
});

test('doctor keeps pi unknown against a lying adapter and resolves dsh to the declared deepseek-harness identity', async () => {
  const lyingReport = (id: ClientId): ClientReport => {
    const base = buildUnknownClientReport('pi', AT);
    return {
      ...base,
      clientId: id,
      status: 'ready',
      coreVerdict: 'validated',
      layers: {
        ...base.layers,
        detected: { ...base.layers.detected, verdict: 'validated', evidence: 'measured' },
        mcp: { ...base.layers.mcp, verdict: 'validated', evidence: 'measured' },
      },
    };
  };
  const lying = (id: ClientId): ClientAdapter => ({
    id,
    identitySources: [{ kind: 'executable', value: id, detail: null }],
    detect: async (): Promise<DetectResult> => ({
      clientId: id,
      detected: true,
      executablePath: `/fake/${id}`,
      version: '9.9.9',
      sources: [],
      errors: [],
    }),
    inspect: async () => lyingReport(id),
    config: async () => ({ mode: 'dry-run', changes: [], backupPlan: null, warnings: [] }),
    verify: async () => ({ handshake: null, tools: null, brief: null, verdicts: emptyVerdicts(), errors: [] }),
  });

  // Pi: identity unknown, so even a lying injected adapter is forced back to
  // the unknown degradation.
  for (const id of ['pi'] as const) {
    const report = await doctorClient(getDescriptor(id), { adapters: { [id]: lying(id) }, now: () => AT });
    assert.equal(report.status, 'unknown');
    assert.equal(report.coreVerdict, 'unavailable');
    assert.ok(allLayersUnavailable(report));
  }

  // dsh: alias of deepseek-harness (ADR-008 §8), identityStatus declared. The
  // unknown gate no longer applies, but with no local measurement the report is
  // still not upgraded to ready/validated.
  const dshDescriptor = getDescriptor('dsh');
  assert.equal(dshDescriptor.id, 'deepseek-harness');
  assert.equal(dshDescriptor.identityStatus, 'declared');
  const dshReport = await doctorClient(dshDescriptor, { probePaths: [], env: { PATH: '' }, now: () => AT });
  assert.equal(dshReport.clientId, 'deepseek-harness');
  assert.notEqual(dshReport.status, 'unknown');
  assert.notEqual(dshReport.status, 'ready');
  assert.ok(allLayersUnavailable(dshReport));

  const run = await doctorClients({
    clientIds: ['deepseek-harness', 'pi'],
    adapters: { pi: lying('pi') },
    probePaths: [],
    env: { PATH: '' },
    now: () => AT,
  });
  assert.equal(run.clients.length, 2);
  for (const report of run.clients) {
    if (report.clientId === 'pi') {
      assert.equal(report.status, 'unknown');
    } else {
      assert.equal(report.clientId, 'deepseek-harness');
      assert.notEqual(report.status, 'unknown');
      assert.notEqual(report.status, 'ready');
    }
    assert.ok(allLayersUnavailable(report));
  }
});

// ---------------------------------------------------------------------------
// External adapter extension: strict declaration, no default trust
// ---------------------------------------------------------------------------

function baseReport(clientId: ClientId): ClientReport {
  const base = buildUnknownClientReport('pi', AT);
  return { ...base, clientId, status: 'degraded', coreVerdict: 'unavailable', limitations: [] };
}

function lyingValidatedReport(clientId: ClientId): ClientReport {
  const base = baseReport(clientId);
  return {
    ...base,
    status: 'ready',
    coreVerdict: 'validated',
    layers: {
      ...base.layers,
      detected: { ...base.layers.detected, verdict: 'validated', evidence: 'measured' },
      mcp: { ...base.layers.mcp, verdict: 'validated', evidence: 'measured' },
    },
  };
}

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
    inspect: async () => baseReport('claude-code'),
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

test('external adapter declaration must provide all four implementations', () => {
  for (const field of ['detect', 'inspect', 'config', 'verify'] as const) {
    const broken = declaration();
    delete (broken as unknown as Record<string, unknown>)[field];
    const result = validateExternalAdapter(broken, validValidation);
    assert.equal(result.ok, false, `${field} must be required`);
    assert.ok(result.issues.some((issue) => issue.code === `${field.toUpperCase()}_MISSING`));
  }
  assert.equal(validateExternalAdapter(declaration(), validValidation).ok, true);
});

test('external adapter requires a capability declaration', () => {
  const broken = declaration();
  delete (broken as unknown as Record<string, unknown>).capabilities;
  const result = validateExternalAdapter(broken, validValidation);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === 'CAPABILITIES_MISSING'));
});

test('external adapter requires a verification evidence source', () => {
  const broken = declaration({ evidence: { source: '', measured: false } });
  const result = validateExternalAdapter(broken, validValidation);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === 'EVIDENCE_SOURCE_MISSING'));
});

test('external adapter rejects unknown, legacy-alias and identity-unknown ids', () => {
  const unknownId = validateExternalAdapter(declaration({ id: 'not-a-client' }), validValidation);
  assert.equal(unknownId.ok, false);
  assert.ok(unknownId.issues.some((issue) => issue.code === 'ID_UNKNOWN'));

  // `dsh` is a legacy alias of deepseek-harness, not a canonical ClientId, so an
  // external adapter cannot claim it.
  const legacyAlias = validateExternalAdapter(declaration({ id: 'dsh' }), validValidation);
  assert.equal(legacyAlias.ok, false);
  assert.ok(legacyAlias.issues.some((issue) => issue.code === 'ID_UNKNOWN'));

  // `pi` has no verified identity and stays ID_IDENTITY_UNKNOWN.
  const identityUnknown = validateExternalAdapter(declaration({ id: 'pi' }), validValidation);
  assert.equal(identityUnknown.ok, false);
  assert.ok(identityUnknown.issues.some((issue) => issue.code === 'ID_IDENTITY_UNKNOWN'));
});

test('external adapter requires declared identity sources', () => {
  const broken = declaration({ identitySources: [] });
  const result = validateExternalAdapter(broken, validValidation);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === 'IDENTITY_SOURCES_MISSING'));
});

test('external adapter requires measured evidence to be complete', () => {
  const broken = declaration({ evidence: { source: 'https://example.test/e', measured: true } });
  const result = validateExternalAdapter(broken, validValidation);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === 'EVIDENCE_MEASURED_AT_MISSING'));
  assert.ok(result.issues.some((issue) => issue.code === 'EVIDENCE_VERSION_MISSING'));
});

test('external adapter requires a trusted validation source', () => {
  const result = validateExternalAdapter(declaration(), { evidenceSource: '', measured: false });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === 'VALIDATION_SOURCE_MISSING'));
});

test('external adapter validation.check can reject a declaration', () => {
  const result = validateExternalAdapter(declaration(), { ...validValidation, check: () => false });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === 'VALIDATION_CHECK_FAILED'));
});

test('registerExternalAdapter throws a typed rejection for invalid declarations', () => {
  assert.throws(
    () => registerExternalAdapter(declaration({ id: 'nope' }), validValidation),
    (error: unknown) => {
      assert.ok(error instanceof ExternalAdapterRejectedError);
      assert.ok(error.issues.some((issue) => issue.code === 'ID_UNKNOWN'));
      return true;
    },
  );
});

test('registered external adapter caps self-reported validated verdicts without measured evidence', async () => {
  const adapter = registerExternalAdapter(
    declaration({ inspect: async () => lyingValidatedReport('claude-code') }),
    validValidation,
  );
  assert.equal(adapter.id, 'claude-code');

  const report = await adapter.inspect({});
  assert.notEqual(report.status, 'ready');
  assert.notEqual(report.coreVerdict, 'validated');
  assert.equal(report.layers.detected.verdict, 'degraded');
  assert.equal(report.layers.detected.evidence, 'assumed');
  assert.ok(report.limitations.some((line) => line.includes('capped')));
});

test('registered external adapter keeps validated verdicts with trusted measured evidence', async () => {
  const adapter = registerExternalAdapter(
    declaration({
      inspect: async () => lyingValidatedReport('claude-code'),
      evidence: { source: 'https://example.test/evidence', measured: true, measuredAt: AT, version: '1.0.0' },
    }),
    { evidenceSource: 'https://example.test/validation', measured: true },
  );

  const report = await adapter.inspect({});
  assert.equal(report.layers.detected.verdict, 'validated');
  assert.equal(report.layers.detected.evidence, 'measured');
});

test('registered external adapter caps self-reported verify verdicts and refuses apply', async () => {
  const untrusted = registerExternalAdapter(
    declaration({
      verify: async () => ({
        handshake: null,
        tools: null,
        brief: null,
        verdicts: { ...emptyVerdicts(), mcp: 'validated' },
        errors: [],
      }),
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

  const verify = await untrusted.verify({ transport: 'stdio' });
  assert.equal(verify.verdicts.mcp, 'degraded');
  assert.ok(verify.errors.some((error) => error.code === 'E_EXTERNAL_VERDICT_CAPPED'));

  const config = await untrusted.config({ mode: 'apply', target: { scope: 'user' } });
  assert.ok(config.mode === 'dry-run');
  assert.deepEqual(config.changes, []);
  assert.ok(config.warnings.some((line) => line.includes('config-refused')));
});

test('registered external adapter preserves id and identity sources', () => {
  const sources = [{ kind: 'executable' as const, value: 'claude', detail: null }];
  const adapter = registerExternalAdapter(declaration({ id: 'codex', identitySources: sources }), validValidation);
  assert.equal(adapter.id, 'codex');
  assert.deepEqual(adapter.identitySources, sources);
});

// ---------------------------------------------------------------------------
// Report shape guard shared by every adapter in this task
// ---------------------------------------------------------------------------

test('every produced report has the nine-layer ADR shape', async () => {
  const reports: ClientReport[] = [
    await qoderAdapter(new FakeQoderFs()).inspect({}),
    buildUnknownClientReport('pi', AT),
    await registerExternalAdapter(declaration(), validValidation).inspect({}),
  ];
  for (const report of reports) {
    assert.deepEqual(Object.keys(report.layers).sort(), [...CAPABILITY_LAYERS].sort());
    for (const layer of CAPABILITY_LAYERS) {
      const entry: LayerReport = report.layers[layer];
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
});
