import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  AgentRunResult,
  IntentContextSnapshot,
  IntentRoutingRecord,
  SessionDetail
} from '@agent-cluster/shared';
import { createRuntimeArtifactSystemEvidence } from '@agent-cluster/shared';
import { workspaceMetrics } from '../../common/workspace-metrics.js';
import { SemanticIntentRouterService } from './semantic-intent-router.service.js';

const now = '2026-08-07T00:00:00.000Z';

function session(): SessionDetail {
  return {
    id: 'session-1', dataEpoch: 'epoch-1', revision: 2, decisionLedgerRevision: 0,
    activeWorkItemId: 'work-1', title: 'Task', originalInput: 'Original task', status: 'FAILED',
    ownerId: 'user-1', workspaceId: 'workspace-1', tokenUsed: 0, participatingAgentIds: [],
    createdAt: now, updatedAt: now
  };
}

function snapshot(message: string): IntentContextSnapshot {
  return {
    id: 'snapshot-1', sessionId: 'session-1', sourceEventId: 'event-1', activeWorkItemId: 'work-1',
    activeWorkItem: { id: 'work-1', title: 'Task', goal: 'Original task', status: 'FAILED', revision: 1 },
    currentMessage: message, validDecisionIds: [], validDecisions: [], candidateWorkItemIds: ['work-1'],
    candidateWorkItems: [{ id: 'work-1', title: 'Task', goal: 'Original task', status: 'FAILED', revision: 1 }],
    revision: { sessionRevision: 2, activeWorkItemId: 'work-1', activeWorkItemRevision: 1, decisionLedgerRevision: 0, latestEventSeq: 1 },
    snapshotHash: 'a'.repeat(64), createdAt: now
  };
}

function routing(): IntentRoutingRecord {
  return {
    id: 'routing-1', sessionId: 'session-1', sourceEventId: 'event-1', sessionSeq: 1,
    status: 'RECEIVED', policyVersion: 'intent-v2.1', rolloutMode: 'shadow', reasonCodes: [],
    retryCount: 0, idempotencyKey: 'routing-key', createdAt: now, updatedAt: now
  };
}

function result(output: AgentRunResult['output'], status: AgentRunResult['status'] = 'completed'): AgentRunResult {
  return {
    invocationId: 'invocation-1', runtimeType: 'mock', status, output, events: [], artifacts: [],
    systemEvidence: createRuntimeArtifactSystemEvidence('invocation-1'),
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
  };
}

function setup(runtimeResults: AgentRunResult[] = []) {
  let runtimeCalls = 0;
  const records = new Map([['routing-1', routing()]]);
  const context = {
    async updateRoutingRecord(_sessionId: string, routingId: string, patch: Partial<IntentRoutingRecord>) {
      const updated = { ...records.get(routingId)!, ...patch, updatedAt: now };
      records.set(routingId, updated);
      return updated;
    },
    isSnapshotCurrent() { return true; },
    getWorkItem() { return { inheritedArtifactIds: [] }; }
  };
  const service = new SemanticIntentRouterService(
    {
      async invoke() {
        const item = runtimeResults[runtimeCalls++];
        if (!item) throw new Error('RUNTIME_UNAVAILABLE');
        return item;
      }
    } as never,
    { resolveSystemRole: () => ({ id: 'intent-agent', key: 'system-intent-router' }) } as never,
    { get: () => ({ role: 'intent_router', preferredRuntimeType: 'mock' }) } as never,
    context as never
  );
  return { service, runtimeCalls: () => runtimeCalls, record: () => records.get('routing-1')! };
}

test('exact continue command is state-validated without invoking the model', async () => {
  const fixture = setup();
  const outcome = await fixture.service.classify(session(), routing(), snapshot('继续'));

  assert.equal(fixture.runtimeCalls(), 0);
  assert.equal(outcome.decision.requestedAction, 'resume');
  assert.equal(outcome.autoApplicable, true);
  assert.equal(outcome.routing.status, 'ROUTED');
});

test('model-created WorkItem references fail closed and request clarification', async () => {
  const fixture = setup([result({
    schemaVersion: '1.0', kind: 'intent_routing_decision', dialogueAct: 'question',
    scopeRelation: 'same_requirement', contextPolicy: 'inherit_confirmed',
    requestedAction: 'continue_active_work_item', selectedWorkItemId: '00000000-0000-0000-0000-000000000999',
    selectedDecisionIds: [], selectedArtifactIds: [], goalSegments: ['Continue'], missingFields: [],
    ambiguityReasons: [], reasonCodes: ['MODEL_SELECTION'], riskLevel: 'low', modelConfidence: 0.99
  })]);
  const outcome = await fixture.service.classify(session(), routing(), snapshot('请按之前的方案处理这个问题'));

  assert.equal(outcome.autoApplicable, false);
  assert.equal(outcome.validation.referencesValid, false, JSON.stringify(outcome));
  assert.ok(outcome.validation.errors.includes('REFERENCE_OUTSIDE_SNAPSHOT'));
  assert.equal(outcome.routing.status, 'CLARIFICATION_REQUIRED');
});

test('two Runtime failures clarify instead of defaulting to continuation', async () => {
  workspaceMetrics.resetForTests();
  const fixture = setup();
  const outcome = await fixture.service.classify(session(), routing(), snapshot('请分析我刚补充的内容'));

  assert.equal(fixture.runtimeCalls(), 2);
  assert.equal(outcome.decision.requestedAction, 'clarify');
  assert.equal(outcome.autoApplicable, false);
  assert.equal(outcome.routing.status, 'CLARIFICATION_REQUIRED');
  assert.ok(outcome.routing.reasonCodes.includes('USER_CHOICE_REQUIRED'));
  assert.equal(
    workspaceMetrics.snapshot().series.find((item) =>
      item.name === 'intent_route_runtime_failure_total' && item.labels.code === 'other'
    )?.value,
    2
  );
});
