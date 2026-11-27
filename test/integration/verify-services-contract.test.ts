import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyTask, type VerifyRequest } from '../../src/gate/verify.ts';

test('T1 refuses to assume that every project test was executed', async () => {
  const request: VerifyRequest = { argv: ['node', '--test'] };
  await assert.rejects(verifyTask(process.cwd(), 'T1', request, {
    ledger: { getTask: () => ({ id: 'T1', status: 'in_progress', declaredFiles: ['src/a.ts'] }) } as never,
    graph: {} as never,
  }), /actual test file list/);
});
