import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentTask } from '@agent-cluster/shared';
import { makeInvocationPlan } from '../runtimes/invocation-plan.fixture.js';
import { acceptanceFingerprint, evaluateExplicitTaskPreflight, explicitTaskPreflight } from './task-acceptance-preflight.js';

test('explicit workflow assignment can start without a model acceptance but cannot bypass permissions or dependencies', () => {
  const plan = makeInvocationPlan();
  const task = { id: 'task', sessionId: plan.sessionId, workflowNodeRunId: 'node-run', title: 'Implement',
    description: 'Implement the confirmed scope', acceptanceCriteria: ['Existing tests pass'], dependsOnTaskIds: [],
    assignee: { type: 'agent', id: plan.agent.agentId }, status: 'assigned', createdAt: 'now', updatedAt: 'now' } satisfies AgentTask;
  assert.equal(explicitTaskPreflight(task, plan, true)?.status, 'accepted');
  assert.equal(explicitTaskPreflight(task, plan, false), undefined);
  assert.equal(explicitTaskPreflight({ ...task, assignee: { type: 'agent', id: 'other' } }, plan, true), undefined);
  const blocked = { ...plan, pendingApprovals: [{ toolId: 'write', toolKey: 'file_writer', approvalId: 'approval', reasons: ['HUMAN_APPROVAL_REQUIRED'] }] };
  assert.equal(explicitTaskPreflight(task, blocked, true), undefined);
});

test('explicit preflight exposes stable reasons without changing the legacy decision helper', () => {
  const plan = makeInvocationPlan({
    pendingApprovals: [{ toolId: 'write', toolKey: 'file_writer', approvalId: 'approval', reasons: ['HUMAN_APPROVAL_REQUIRED'] }]
  });
  const task = { id: 'task', sessionId: plan.sessionId, workflowNodeRunId: 'node-run', title: 'Implement',
    description: '', acceptanceCriteria: [], dependsOnTaskIds: [],
    assignee: { type: 'agent', id: 'other' }, status: 'assigned', createdAt: 'now', updatedAt: 'now' } satisfies AgentTask;
  const result = evaluateExplicitTaskPreflight(task, plan, false);
  assert.deepEqual(result.reasonCodes, [
    'ASSIGNEE_MISMATCH', 'TASK_DESCRIPTION_MISSING', 'ACCEPTANCE_CRITERIA_MISSING',
    'DEPENDENCIES_NOT_READY', 'PENDING_APPROVAL'
  ]);
  assert.equal(result.decision, undefined);
  assert.equal(explicitTaskPreflight(task, plan, false), undefined);
});

test('acceptance fingerprint ignores task activity but invalidates on permission, agent, evidence and task changes', () => {
  const plan = makeInvocationPlan();
  const task = { id: 'task', sessionId: plan.sessionId, title: 'Implement', description: 'Scope',
    acceptanceCriteria: ['Check'], dependsOnTaskIds: [] } as unknown as AgentTask;
  const fingerprint = acceptanceFingerprint(task, plan, []);
  assert.equal(acceptanceFingerprint({ ...task, updatedAt: 'later', status: 'running' }, plan, []), fingerprint);
  assert.notEqual(acceptanceFingerprint({ ...task, description: 'Changed scope' }, plan, []), fingerprint);
  assert.notEqual(acceptanceFingerprint(task, { ...plan, agent: { ...plan.agent, profileRevision: 2 } }, []), fingerprint);
  assert.notEqual(acceptanceFingerprint(task, { ...plan, toolCatalog: { ...plan.toolCatalog, catalogHash: 'revoked' } }, []), fingerprint);
  assert.notEqual(acceptanceFingerprint(task, plan, ['changed artifact']), fingerprint);
});

test('a revised requirement invalidates a completed acceptance so old work cannot be reused as new output', () => {
  const plan = makeInvocationPlan();
  const task = { id: 'task', sessionId: plan.sessionId, title: 'Implement', description: 'Scope',
    acceptanceCriteria: ['Check'], dependsOnTaskIds: [] } as unknown as AgentTask;
  const atRevision3 = acceptanceFingerprint(task, plan, [], { workItemRevision: 3, documentRevision: 2, contentHash: 'hash-doc-2' });

  // Same task, same agent, same workspace — but the user revised the requirement.
  // Without the version in the fingerprint the stored checkpoint would still
  // match and the run would credit the new requirement with the old acceptance.
  assert.notEqual(
    acceptanceFingerprint(task, plan, [], { workItemRevision: 4, documentRevision: 2, contentHash: 'hash-doc-2' }),
    atRevision3,
    'a new requirement revision must invalidate the acceptance checkpoint'
  );
  assert.notEqual(
    acceptanceFingerprint(task, plan, [], { workItemRevision: 3, documentRevision: 3, contentHash: 'hash-doc-3' }),
    atRevision3,
    'a republished document must invalidate the acceptance checkpoint'
  );
  // Same revision with different content is still a different document.
  assert.notEqual(
    acceptanceFingerprint(task, plan, [], { workItemRevision: 3, documentRevision: 2, contentHash: 'hash-other' }),
    atRevision3
  );
  // Unchanged versions keep reuse working: this guard must not disable the cache.
  assert.equal(
    acceptanceFingerprint(task, plan, [], { workItemRevision: 3, documentRevision: 2, contentHash: 'hash-doc-2' }),
    atRevision3
  );
});

test('a session with no published document still produces a stable fingerprint', () => {
  const plan = makeInvocationPlan();
  const task = { id: 'task', sessionId: plan.sessionId, title: 'Implement', description: 'Scope',
    acceptanceCriteria: ['Check'], dependsOnTaskIds: [] } as unknown as AgentTask;

  // Callers that have no requirement version yet must not crash or collapse into
  // the same fingerprint as a versioned one.
  const withoutVersion = acceptanceFingerprint(task, plan, []);
  assert.equal(acceptanceFingerprint(task, plan, []), withoutVersion);
  assert.notEqual(
    acceptanceFingerprint(task, plan, [], { workItemRevision: 1, documentRevision: 1, contentHash: 'hash' }),
    withoutVersion
  );
});
