import assert from 'node:assert/strict';
import test from 'node:test';
import { assertPhase6ProductionPolicyAdmission } from './phase-6-release-admission.js';

const incomplete = '- passed：56；partial：4；pending：0；not-executed：0；deferred：1；failed/missing：0';
const complete = '- passed：61；partial：0；pending：0；not-executed：0；deferred：0；failed/missing：0';
const rollback = {
  schemaVersion: 'phase-6-postgres-migration-evidence-v1',
  result: 'passed',
  executedAt: '2026-09-20T00:00:00.000Z',
  fixtureHashes: { source1: 'a'.repeat(64), source2: 'b'.repeat(64), rollback: 'c'.repeat(64) }
};
const matrix = (summary: string, lastStatus: string) => `${summary}\n## 矩阵\n${Array.from({ length: 61 }, (_, i) =>
  `| 6 | P6-AC${i + 1} | P6-T1 | ${i === 60 ? lastStatus : summary === incomplete && i >= 56 ? 'partial' : 'passed'} | evidence |`).join('\n')}`;

test('startup blocks enabled phase 6 policy before server initialization even when NODE_ENV is missing', () => {
  for (const policy of [
    { MAIN_AGENT_DISCUSSION_ENABLED: 'true' },
    { REQUIREMENT_DOCUMENT_ENABLED: 'true' },
    { INTENT_ROUTING_MODE: 'enforce_new_sessions' }
  ]) {
    assert.throws(
      () => assertPhase6ProductionPolicyAdmission({ ...policy },
        { traceability: matrix(incomplete, 'deferred'), postgresEvidence: rollback }),
      /PHASE_6_POLICY_ADMISSION_BLOCKED: phase_6_acceptance_complete/
    );
  }
});

test('production startup fails closed when release evidence is absent or malformed', () => {
  assert.throws(
    () => assertPhase6ProductionPolicyAdmission({ NODE_ENV: 'production', MAIN_AGENT_DISCUSSION_ENABLED: 'true', PHASE_6_TRACEABILITY_PATH: 'missing-phase6-matrix.md' }),
    /PHASE_6_POLICY_ADMISSION_BLOCKED: required release evidence is unavailable or invalid/
  );
  assert.throws(
    () => assertPhase6ProductionPolicyAdmission({ NODE_ENV: 'production', REQUIREMENT_DOCUMENT_ENABLED: 'true' }, { traceability: 'invalid' }),
    /PHASE_6_POLICY_ADMISSION_BLOCKED: required release evidence is unavailable or invalid/
  );
});

test('production startup accepts enabled policy only with complete evidence and approval metadata', () => {
  assert.doesNotThrow(() => assertPhase6ProductionPolicyAdmission({
    NODE_ENV: 'production',
    MAIN_AGENT_DISCUSSION_ENABLED: 'true',
    AGENT_CLUSTER_COMMIT: 'abc123',
    AGENT_CLUSTER_BUILD_TIME: '2026-09-20T00:00:00Z',
    PHASE_6_RELEASE_APPROVAL_ID: 'approved-release'
  }, { traceability: matrix(complete, 'passed'), postgresEvidence: rollback }));
});

test('production startup rejects a forged green summary with a partial AC row', () => {
  assert.throws(
    () => assertPhase6ProductionPolicyAdmission({ NODE_ENV: 'production', MAIN_AGENT_DISCUSSION_ENABLED: 'true' },
      { traceability: matrix(complete, 'partial'), postgresEvidence: rollback }),
    /PHASE_6_POLICY_ADMISSION_BLOCKED: required release evidence is unavailable or invalid/
  );
});

test('disabled startup and explicit isolated test policy do not require release evidence', () => {
  assert.doesNotThrow(() => assertPhase6ProductionPolicyAdmission({ NODE_ENV: 'production' }));
  assert.doesNotThrow(() => assertPhase6ProductionPolicyAdmission({
    NODE_ENV: 'test',
    PHASE_6_POLICY_ADMISSION_BYPASS: 'isolated_test_only',
    MAIN_AGENT_DISCUSSION_ENABLED: 'true'
  }));
  assert.throws(
    () => assertPhase6ProductionPolicyAdmission({ NODE_ENV: 'development', PHASE_6_POLICY_ADMISSION_BYPASS: 'isolated_test_only', MAIN_AGENT_DISCUSSION_ENABLED: 'true' }),
    /PHASE_6_POLICY_ADMISSION_BLOCKED/
  );
  assert.throws(
    () => assertPhase6ProductionPolicyAdmission({ NODE_ENV: 'test', PHASE_6_POLICY_ADMISSION_BYPASS: 'true', MAIN_AGENT_DISCUSSION_ENABLED: 'true' }),
    /PHASE_6_POLICY_ADMISSION_BLOCKED/
  );
});
