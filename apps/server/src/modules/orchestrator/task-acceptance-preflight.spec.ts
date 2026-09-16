import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentTask } from '@agent-cluster/shared';
import { makeInvocationPlan } from '../runtimes/invocation-plan.fixture.js';
import { acceptanceFingerprint, explicitTaskPreflight } from './task-acceptance-preflight.js';

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
