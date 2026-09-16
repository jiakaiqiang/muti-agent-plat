import assert from 'node:assert/strict';
import test from 'node:test';
import {
  COLLABORATION_CONTRACT_VERSION,
  COLLABORATION_ACTION_OWNERS,
  assertCollaborationExecutionIdentity,
  collaborationExecutionKey,
  isCollaborationActionOwner,
  matchesRequirementConfirmation,
  evaluateCollaborationAdmission,
  createCollaborationPolicySnapshot,
  evaluateCollaborationPolicyAdoption,
  type CollaborationExecutionIdentity,
  type CollaborationLifecycleSnapshot,
  type CollaborationPolicySnapshot,
  type RequirementConfirmationBinding
} from './collaboration-contracts.js';
import { SYSTEM_AGENT_REGISTRATIONS } from './system-agents.js';

function identity(): CollaborationExecutionIdentity {
  return {
    sessionId: 'session-a', workItemId: 'requirement-a', agentId: 'shared-agent',
    operationId: 'operation-a', invocationId: 'invocation-a',
    generation: 1, profileRevision: 2, contextSnapshotId: 'context-a',
    scope: { kind: 'discussion', discussionId: 'discussion-a', delegationId: 'delegation-a' }
  };
}

function lifecycle(): CollaborationLifecycleSnapshot {
  return {
    contractVersion: COLLABORATION_CONTRACT_VERSION,
    sessionId: 'session-a', dataEpoch: 'epoch-a', generation: 1, revision: 1,
    state: 'active', admission: 'open', stopStatus: 'confirmed'
  };
}

const reader = {
  sessionId: 'session-a', dataEpoch: 'epoch-a', generation: 1,
  supportedContractVersions: [COLLABORATION_CONTRACT_VERSION]
};

function binding(): RequirementConfirmationBinding {
  return {
    sessionId: 'session-a', workItemId: 'requirement-a', workItemRevision: 2,
    confirmationId: 'confirmation-a', documentId: 'document-a', documentRevision: 3,
    contentHash: 'sha256:content-a', businessFingerprint: 'business-a'
  };
}

function policy(): CollaborationPolicySnapshot {
  return {
    contractVersion: COLLABORATION_CONTRACT_VERSION,
    policyId: 'policy-a', revision: 1, dataEpoch: 'epoch-a',
    activation: 'disabled', enabledFeatures: [],
    parameters: {}, capturedAt: '2026-09-16T00:00:00.000Z'
  };
}

const adopter = {
  dataEpoch: 'epoch-a', supportedContractVersions: [COLLABORATION_CONTRACT_VERSION],
  supportedFeatures: [], sessionKind: 'existing' as const, executionActive: false,
  stopConfirmed: true, explicitUpgrade: true
};

test('P0-AC1: shared Agent definitions do not make execution identity shared', () => {
  const first = identity();
  assertCollaborationExecutionIdentity(first);
  const second = { ...first, sessionId: 'session-b', workItemId: 'requirement-b' };
  assert.notEqual(collaborationExecutionKey(first), collaborationExecutionKey(second));
  for (const key of ['operationId', 'invocationId', 'workItemId', 'contextSnapshotId'] as const) {
    assert.notEqual(collaborationExecutionKey(first), collaborationExecutionKey({ ...first, [key]: 'other' }));
  }
  assert.notEqual(collaborationExecutionKey(first), collaborationExecutionKey({ ...first, generation: 2 }));
  assert.equal(collaborationExecutionKey(first), collaborationExecutionKey(structuredClone(first)));
});

test('P0-AC1: execution keys cannot collide through separator characters', () => {
  const a = { ...identity(), sessionId: 'a:b', workItemId: 'c' };
  const b = { ...identity(), sessionId: 'a', workItemId: 'b:c' };
  assert.notEqual(collaborationExecutionKey(a), collaborationExecutionKey(b));
});

test('P0-AC1: malformed or incomplete scoped identities fail closed', () => {
  for (const bad of [null, {}, { agentId: 'shared-agent' },
    { ...identity(), sessionId: '' }, { ...identity(), generation: 0 },
    { ...identity(), profileRevision: Infinity },
    { ...identity(), scope: { kind: 'workflow', workflowRunId: 'run' } },
    { ...identity(), scope: { kind: 'discussion', discussionId: 'd', delegationId: '' } },
    { ...identity(), scope: { kind: 'unknown' } }
  ]) assert.throws(() => assertCollaborationExecutionIdentity(bad), /COLLABORATION_IDENTITY_INVALID/);
});

test('P0-AC1: different workflow nodes and delegation attempts remain distinguishable', () => {
  const first = identity();
  assert.notEqual(collaborationExecutionKey(first), collaborationExecutionKey({
    ...first, scope: { kind: 'discussion', discussionId: 'discussion-a', delegationId: 'delegation-b' }
  }));
  const workflow = { ...first, scope: { kind: 'workflow' as const, workflowRunId: 'run', taskId: 'task-a' } };
  assertCollaborationExecutionIdentity(workflow);
  assert.notEqual(collaborationExecutionKey(workflow), collaborationExecutionKey({
    ...workflow, scope: { ...workflow.scope, taskId: 'task-b' }
  }));
  assertCollaborationExecutionIdentity({ ...first, scope: { kind: 'intent', routingId: 'route' } });
  assertCollaborationExecutionIdentity({ ...first, scope: { kind: 'summary', checkpointKey: 'range-a' } });
});

test('P0-AC2: coordinator is the existing main Agent, not a newly privileged role', () => {
  assert.equal(SYSTEM_AGENT_REGISTRATIONS.filter(item => item.role === 'coordinator').length, 1);
  for (const action of ['publish_requirement_document', 'request_requirement_confirmation', 'publish_synthesis', 'request_member_selection']) {
    assert.equal(isCollaborationActionOwner('coordinator', action), true);
    assert.equal(isCollaborationActionOwner('expert', action), false);
    assert.equal(isCollaborationActionOwner('intent_router', action), false);
  }
  assert.equal(isCollaborationActionOwner('main-agent', 'publish_synthesis'), false);
});

test('P0-AC2/3: user decisions, expert reports and workflow transitions have distinct owners', () => {
  assert.equal(isCollaborationActionOwner('user', 'confirm_requirement'), true);
  assert.equal(isCollaborationActionOwner('user', 'select_workflow'), true);
  assert.equal(isCollaborationActionOwner('user', 'approve_member_change'), true);
  assert.equal(isCollaborationActionOwner('expert', 'submit_expert_report'), true);
  assert.equal(isCollaborationActionOwner('intent_router', 'propose_intent_route'), true);
  assert.equal(isCollaborationActionOwner('workflow_engine', 'advance_workflow_node'), true);
  assert.equal(isCollaborationActionOwner('coordinator', 'advance_workflow_node'), false);
  assert.equal(isCollaborationActionOwner('coordinator', 'select_workflow'), false);
  assert.equal(isCollaborationActionOwner('user', 'unknown_action'), false);
  assert.equal(isCollaborationActionOwner('constructor', 'constructor'), false);
  assert.ok(Object.isFrozen(COLLABORATION_ACTION_OWNERS));
});

test('P0-AC3: only the exact requirement/document confirmation binding matches', () => {
  const current = binding();
  assert.equal(matchesRequirementConfirmation(current, structuredClone(current)), true);
  for (const key of ['sessionId', 'workItemId', 'confirmationId', 'documentId', 'contentHash', 'businessFingerprint'] as const) {
    assert.equal(matchesRequirementConfirmation({ ...current, [key]: 'other' }, current), false, key);
  }
  for (const key of ['workItemRevision', 'documentRevision'] as const) {
    assert.equal(matchesRequirementConfirmation({ ...current, [key]: 99 }, current), false, key);
  }
  assert.equal(matchesRequirementConfirmation({}, {}), false);
  assert.equal(matchesRequirementConfirmation(null, current), false);
  assert.equal(matchesRequirementConfirmation({ ...current, contentHash: '' }, current), false);
});

test('P0-AC4/6: old and unknown lifecycle snapshots never grant new-policy admission', () => {
  assert.equal(evaluateCollaborationAdmission(undefined, reader).reason, 'legacy_snapshot');
  for (const value of [{ ...lifecycle(), contractVersion: '99.0' }, { ...lifecycle(), state: 'future_state' },
    { ...lifecycle(), admission: 'future_admission' }, { ...lifecycle(), stopStatus: 'future_stop' },
    { ...lifecycle(), generation: -1 }, { ...lifecycle(), revision: NaN }, null]) {
    assert.equal(evaluateCollaborationAdmission(value, reader).eligible, false);
  }
  assert.equal(evaluateCollaborationAdmission(lifecycle(), { ...reader, supportedContractVersions: [] }).eligible, false);
  assert.equal(evaluateCollaborationAdmission(lifecycle(), reader).eligible, true);
  assert.equal(evaluateCollaborationAdmission({ ...lifecycle(), futureDisplayField: 'safe to ignore' }, reader).eligible, true);
});

test('P0-AC4/6: stopping, tombstones and stale generations keep admission closed', () => {
  for (const patch of [{ state: 'deleting', admission: 'closed' }, { state: 'deleted', admission: 'closed' },
    { admission: 'closed' }, { stopStatus: 'unknown' }, { stopStatus: 'waiting' }, { stopStatus: 'requested' },
    { sessionId: 'session-b' }, { dataEpoch: 'other-epoch' }, { generation: 2 }]) {
    assert.equal(evaluateCollaborationAdmission({ ...lifecycle(), ...patch }, reader).eligible, false);
  }
  assert.equal(evaluateCollaborationAdmission({ ...lifecycle(), state: 'deleted', admission: 'open' }, reader).reason, 'invalid_snapshot');
});

test('P0-AC6: explicitly disabled policy snapshots are detached and deeply immutable', () => {
  const input = policy();
  const snapshot = createCollaborationPolicySnapshot(input);
  assert.notEqual(snapshot, input);
  assert.equal(snapshot.activation, 'disabled');
  assert.deepEqual(snapshot.enabledFeatures, []);
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.enabledFeatures));
  assert.ok(Object.isFrozen(snapshot.parameters));
  input.revision = 2;
  assert.equal(snapshot.revision, 1);
});

test('P0-AC6: unknown capabilities, invalid limits and unsupported dependency combinations are rejected', () => {
  for (const input of [
    { ...policy(), contractVersion: '99' }, { ...policy(), activation: 'all_sessions' },
    { ...policy(), enabledFeatures: ['main_agent_discussion'] },
    { ...policy(), activation: 'new_sessions_only', enabledFeatures: ['unknown'] },
    { ...policy(), activation: 'new_sessions_only', enabledFeatures: ['long_term_memory'] },
    { ...policy(), parameters: { cache: { maxEntries: 0, maxBytes: 100, ttlMs: 100 } } },
    { ...policy(), capturedAt: 'invalid' },
    { ...policy(), parameters: { hiddenUnlimitedBudget: true } },
    { ...policy(), apiKey: 'must-not-enter-snapshot' },
    { ...policy(), activation: ['disabled'] }
  ]) assert.throws(() => createCollaborationPolicySnapshot(input), /COLLABORATION_POLICY_INVALID/);
});

test('P0-AC6: optional cache can be disabled without disabling main-Agent correctness', () => {
  const snapshot = createCollaborationPolicySnapshot({
    ...policy(), activation: 'new_sessions_only',
    enabledFeatures: ['session_lifecycle', 'bounded_context', 'long_term_memory', 'main_agent_discussion'],
    parameters: {
      context: { maxInputTokens: 1000, maxOutputTokens: 100, maxWorkItemTokens: 5000, safetyMarginRatio: 0.1 },
      memory: { summaryTriggerRatio: 0.7, maxRecallCandidates: 5 },
      discussion: { maxConcurrency: 2, maxRounds: 3 }
    }
  });
  assert.ok(!snapshot.enabledFeatures.includes('layered_cache'));
  assert.ok(Object.isFrozen(snapshot.parameters.context));
  assert.equal(evaluateCollaborationPolicyAdoption(snapshot, {
    ...adopter, supportedFeatures: snapshot.enabledFeatures, sessionKind: 'new'
  }).eligible, true);
});

test('P0-AC6: running or unconfirmed Sessions never auto-adopt a new policy', () => {
  const snapshot = createCollaborationPolicySnapshot(policy());
  assert.equal(evaluateCollaborationPolicyAdoption(snapshot, adopter).eligible, true);
  for (const patch of [{ executionActive: true }, { stopConfirmed: false }, { explicitUpgrade: false },
    { dataEpoch: 'retired-epoch' }, { supportedContractVersions: [] }]) {
    assert.equal(evaluateCollaborationPolicyAdoption(snapshot, { ...adopter, ...patch }).eligible, false);
  }
  assert.equal(evaluateCollaborationPolicyAdoption({ ...snapshot, contractVersion: '99' }, adopter).eligible, false);
  const enabled = { ...policy(), activation: 'new_sessions_only', enabledFeatures: ['session_lifecycle'] };
  assert.equal(evaluateCollaborationPolicyAdoption(enabled, adopter).reason, 'unsupported_feature');
});

test('P0-AC6: policies must be serializable data with complete finite parameter groups', () => {
  const enabled = { ...policy(), activation: 'new_sessions_only', enabledFeatures: ['session_lifecycle', 'bounded_context'] };
  for (const input of [
    enabled,
    { ...enabled, enabledFeatures: ['session_lifecycle', 'session_lifecycle'] },
    { ...enabled, enabledFeatures: new Array(1) },
    Object.create(policy()),
    { ...enabled, parameters: { context: { maxInputTokens: 100, maxOutputTokens: 20, maxWorkItemTokens: 110, safetyMarginRatio: 0.1 } } },
    { ...enabled, parameters: { context: { maxInputTokens: 100, maxOutputTokens: 20, maxWorkItemTokens: 500, safetyMarginRatio: 1 } } }
  ]) assert.throws(() => createCollaborationPolicySnapshot(input), /COLLABORATION_POLICY_INVALID/);
});

test('P0-AC6: policy JSON round-trips preserve meaning and nested snapshots do not follow input mutations', () => {
  const input: CollaborationPolicySnapshot = {
    ...policy(), activation: 'new_sessions_only', enabledFeatures: ['session_lifecycle', 'bounded_context'],
    parameters: { context: { maxInputTokens: 100, maxOutputTokens: 20, maxWorkItemTokens: 500, safetyMarginRatio: 0.1 } }
  };
  const snapshot = createCollaborationPolicySnapshot(input);
  assert.deepEqual(createCollaborationPolicySnapshot(JSON.parse(JSON.stringify(snapshot))), snapshot);
  input.parameters.context!.maxInputTokens = 300;
  input.enabledFeatures.length = 0;
  assert.equal(snapshot.parameters.context!.maxInputTokens, 100);
  assert.deepEqual(snapshot.enabledFeatures, ['session_lifecycle', 'bounded_context']);
  assert.throws(() => { (snapshot.parameters.context as { maxInputTokens: number }).maxInputTokens = 999; }, TypeError);
});
