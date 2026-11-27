import assert from 'node:assert/strict';
import test from 'node:test';
import { Ledger } from '../../src/ledger/ledger.ts';
import { exportProject } from '../../src/surface/export.ts';
import { cleanup, gitProject } from '../helpers/m18-d-fixtures.ts';

test('M18-D export maps committed evidence records to id/taskId/ok without executing them', async () => {
  const root = await gitProject();
  let ledger: Ledger | undefined;
  try {
    ledger = await Ledger.open(root);
    await ledger.createTask('T-EVID', ['src/alpha.ts'], 'evidence task', 'exp:task:1');
    await ledger.append({
      kind: 'evidence.recorded',
      payload: {
        task_id: 'T-EVID',
        evidence: { id: 'EV-OK-1', ok: true, verdict: 'pass' },
        test_files: ['test/a.test.ts'],
      },
    }, 'exp:evidence:1');
    await ledger.append({
      kind: 'evidence.recorded',
      payload: {
        task_id: 'T-EVID',
        evidence: { id: 'EV-BAD-1', ok: false, verdict: 'fail' },
      },
    }, 'exp:evidence:2');
    ledger.close();
    ledger = undefined;

    const snapshot = await exportProject(root);
    assert.equal(snapshot.schema, 'ano.export.v1');
    assert.deepEqual(snapshot.evidence, [
      { id: 'EV-BAD-1', taskId: 'T-EVID', ok: false },
      { id: 'EV-OK-1', taskId: 'T-EVID', ok: true },
    ]);
    assert.equal(snapshot.tasks.length, 1);
    assert.equal(snapshot.project.phase, 'P7');
    assert.ok(snapshot.limitations.some((item) => item.includes('plaintext secrets')));
  } finally {
    ledger?.close();
    await cleanup(root);
  }
});

test('M18-D export keeps a named manifest and an empty evidence list stable', async () => {
  const root = await gitProject({ name: 'export-fixture', version: '2.3.4' });
  try {
    const snapshot = await exportProject(root);
    assert.equal(snapshot.project.name, 'export-fixture');
    assert.equal(snapshot.project.version, '2.3.4');
    assert.deepEqual(snapshot.evidence, []);
    assert.equal(Array.isArray(snapshot.findings), true);
    assert.equal(Array.isArray(snapshot.baselines), true);
  } finally {
    await cleanup(root);
  }
});
