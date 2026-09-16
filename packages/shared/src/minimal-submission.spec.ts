import test from 'node:test';
import assert from 'node:assert/strict';
import { minimalTaskSubmissionContract, materializeTaskSubmission } from './runtime-contracts/minimal-submission.js';
import { getVersionedRuntimeOutputContract } from './runtime-contracts/registry.js';

test('minimal submission rejects missing facts, extra fields and unsupported versions', () => {
  const value = structuredClone(minimalTaskSubmissionContract.example);
  assert.equal(minimalTaskSubmissionContract.validate(value).valid, true);
  for (const key of Object.keys(value)) {
    const missing = { ...value } as Record<string, unknown>;
    delete missing[key];
    assert.equal(minimalTaskSubmissionContract.validate(missing).valid, false, key);
  }
  assert.equal(minimalTaskSubmissionContract.validate({ ...value, verifiedTestResults: [{ passed: true }] }).valid, false);
  assert.equal(minimalTaskSubmissionContract.validate({ ...value, summary: '' }).valid, false);
  assert.throws(() => getVersionedRuntimeOutputContract('agent_message', '2.0'), /NOT_FOUND/);
  assert.equal(getVersionedRuntimeOutputContract('task_execution_result', '1.0').version, '1.0');
  assert.match(minimalTaskSubmissionContract.schemaHash, /^fnv1a32:[a-f0-9]{8}$/);
});

test('minimal submission can refer only to captured paths and never manufactures evidence', () => {
  const value = { ...minimalTaskSubmissionContract.example, artifactRefs: ['src/app.ts'] };
  assert.throws(() => materializeTaskSubmission(value, []), /OUTSIDE_CANDIDATE/);
  assert.throws(() => materializeTaskSubmission({ ...value, blockers: ['test failed'] }, value.artifactRefs), /WITH_BLOCKERS/);
  const output = materializeTaskSubmission(value, value.artifactRefs);
  assert.deepEqual(output.changedArtifacts, []);
  assert.deepEqual(output.completedItems, []);
});
