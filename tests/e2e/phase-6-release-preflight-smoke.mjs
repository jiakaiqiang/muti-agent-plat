import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPhase6ReleasePreflight } from '../../scripts/phase-6-release-preflight.mjs';

const incompleteTraceability = '- passed：54；partial：6；pending：0；not-executed：0；deferred：1；failed/missing：0';
const completeTraceability = '- passed：61；partial：0；pending：0；not-executed：0；deferred：0；failed/missing：0';
const rollbackEvidence = {
  schemaVersion: 'phase-6-postgres-migration-evidence-v1',
  result: 'passed',
  executedAt: '2026-09-20T00:00:00.000Z',
  fixtureHashes: {
    source1: 'a'.repeat(64),
    source2: 'b'.repeat(64),
    rollback: 'c'.repeat(64)
  }
};

test('phase 6 release preflight fails closed without external evidence or authorization', () => {
  const report = buildPhase6ReleasePreflight({
    env: { DATABASE_URL: 'postgresql://secret:secret@example.invalid/business' },
    traceability: incompleteTraceability
  });
  assert.equal(report.result, 'blocked');
  assert.deepEqual(report.blockers, [
    'phase_6_acceptance_complete',
    'isolated_postgres_rollback_verified',
    'build_identity_complete',
    'release_authorization_recorded'
  ]);
  assert.equal(report.effectiveConfig.mainAgentDiscussionEnabled, false);
  assert.equal(JSON.stringify(report).includes('secret'), false);
  assert.equal(JSON.stringify(report).includes('DATABASE_URL'), false);
});

test('phase 6 release preflight reports ready only with complete evidence and approval metadata', () => {
  const report = buildPhase6ReleasePreflight({
    env: {
      INTENT_ROUTING_MODE: 'enforce_new_sessions',
      MAIN_AGENT_DISCUSSION_ENABLED: 'true',
      REQUIREMENT_DOCUMENT_ENABLED: 'true',
      RELATIONAL_TEST_DATABASE_URL: 'postgresql://not-emitted',
      AGENT_CLUSTER_RUNTIME_PRICING_JSON: '{"priceVersion":"pricing-v1","currency":"USD","entries":[{"connectionId":"remote:model","inputPerMillion":1,"outputPerMillion":2}]}',
      AGENT_CLUSTER_COMMIT: 'abc123',
      AGENT_CLUSTER_BUILD_TIME: '2026-09-20T00:00:00Z',
      PHASE_6_RELEASE_APPROVAL_ID: 'approval-1'
    },
    traceability: completeTraceability,
    postgresEvidence: rollbackEvidence
  });
  assert.equal(report.result, 'ready');
  assert.deepEqual(report.blockers, []);
  assert.equal(report.gates.every((item) => item.status === 'passed'), true);
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes('postgresql://not-emitted'), false);
  assert.equal(serialized.includes('remote:model'), false);
  assert.equal(serialized.includes('approval-1'), false);
});

test('phase 6 release preflight rejects an invalid configured pricing catalog without echoing it', () => {
  const report = buildPhase6ReleasePreflight({
    env: {
      AGENT_CLUSTER_RUNTIME_PRICING_JSON: '{"apiKey":"must-not-leak"}',
      AGENT_CLUSTER_COMMIT: 'abc123',
      AGENT_CLUSTER_BUILD_TIME: '2026-09-20T00:00:00Z',
      PHASE_6_RELEASE_APPROVAL_ID: 'approval-1'
    },
    traceability: completeTraceability,
    postgresEvidence: rollbackEvidence
  });
  assert.equal(report.result, 'blocked');
  assert.ok(report.blockers.includes('runtime_pricing_valid'));
  assert.equal(JSON.stringify(report).includes('must-not-leak'), false);
});

test('phase 6 release preflight rejects an incomplete rollback evidence file', () => {
  const report = buildPhase6ReleasePreflight({
    env: {
      AGENT_CLUSTER_COMMIT: 'abc123',
      AGENT_CLUSTER_BUILD_TIME: '2026-09-20T00:00:00Z',
      PHASE_6_RELEASE_APPROVAL_ID: 'approval-1'
    },
    traceability: completeTraceability,
    postgresEvidence: { schemaVersion: 'phase-6-postgres-migration-evidence-v1', result: 'passed' }
  });
  assert.equal(report.result, 'blocked');
  assert.ok(report.blockers.includes('isolated_postgres_rollback_verified'));
});

test('phase 6 release preflight does not report a missing URL when rollback evidence already exists', () => {
  const report = buildPhase6ReleasePreflight({
    env: {},
    traceability: incompleteTraceability,
    postgresEvidence: rollbackEvidence
  });

  assert.equal(report.effectiveConfig.isolatedTestDatabaseConfigured, false);
  assert.equal(report.gates.find((item) => item.id === 'isolated_postgres_rollback_verified')?.status, 'passed');
  assert.equal(report.warnings.some((warning) => warning.includes('rollback drill evidence')), false);
});

test('phase 6 policy admission blocks enablement when acceptance is incomplete', () => {
  const report = buildPhase6ReleasePreflight({
    env: {
      MAIN_AGENT_DISCUSSION_ENABLED: 'true',
      AGENT_CLUSTER_COMMIT: 'abc123',
      AGENT_CLUSTER_BUILD_TIME: '2026-09-20T00:00:00Z',
      PHASE_6_RELEASE_APPROVAL_ID: 'approval-1'
    },
    traceability: incompleteTraceability,
    postgresEvidence: rollbackEvidence
  });
  assert.equal(report.result, 'blocked');
  assert.ok(report.blockers.includes('policy_admission_safe'));
});

test('phase 6 policy admission treats enforced intent routing as enablement', () => {
  const report = buildPhase6ReleasePreflight({
    env: {
      INTENT_ROUTING_MODE: 'enforce_new_sessions',
      AGENT_CLUSTER_COMMIT: 'abc123',
      AGENT_CLUSTER_BUILD_TIME: '2026-09-20T00:00:00Z',
      PHASE_6_RELEASE_APPROVAL_ID: 'approval-1'
    },
    traceability: incompleteTraceability,
    postgresEvidence: rollbackEvidence
  });
  assert.equal(report.effectiveConfig.policyEnablementRequested, true);
  assert.ok(report.blockers.includes('policy_admission_safe'));
});

test('phase 6 policy admission treats requirement documents as enablement', () => {
  const report = buildPhase6ReleasePreflight({
    env: {
      REQUIREMENT_DOCUMENT_ENABLED: 'true',
      AGENT_CLUSTER_COMMIT: 'abc123',
      AGENT_CLUSTER_BUILD_TIME: '2026-09-20T00:00:00Z',
      PHASE_6_RELEASE_APPROVAL_ID: 'approval-1'
    },
    traceability: incompleteTraceability,
    postgresEvidence: rollbackEvidence
  });
  assert.equal(report.effectiveConfig.policyEnablementRequested, true);
  assert.ok(report.blockers.includes('policy_admission_safe'));
});

test('phase 6 policy admission requires build identity before enabling any policy', () => {
  const report = buildPhase6ReleasePreflight({
    env: {
      MAIN_AGENT_DISCUSSION_ENABLED: 'true',
      PHASE_6_RELEASE_APPROVAL_ID: 'approval-1'
    },
    traceability: completeTraceability,
    postgresEvidence: rollbackEvidence
  });
  assert.ok(report.blockers.includes('build_identity_complete'));
  assert.ok(report.blockers.includes('policy_admission_safe'));
});
