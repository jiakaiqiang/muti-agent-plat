import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  AgentRunResult,
  ContextEnvelopeV2,
  IntentContextSnapshot,
  IntentRoutingRecord,
  SessionDetail
} from '@agent-cluster/shared';
import { createRuntimeArtifactSystemEvidence } from '@agent-cluster/shared';
import { workspaceMetrics } from '../../common/workspace-metrics.js';
import { INTENT_ROUTING_GOLDEN_DATASET_V1 } from './intent-routing-golden.dataset.js';
import { SemanticIntentRouterService } from './semantic-intent-router.service.js';

const now = '2026-08-07T00:00:00.000Z';

function session(
  status: SessionDetail['status'] = 'FAILED',
  hasActiveWorkItem = true
): SessionDetail {
  return {
    id: 'session-1', dataEpoch: 'epoch-1', revision: 2, decisionLedgerRevision: 0,
    ...(hasActiveWorkItem ? { activeWorkItemId: 'work-1' } : {}),
    title: 'Task', originalInput: 'Original task', status,
    ownerId: 'user-1', workspaceId: 'workspace-1', tokenUsed: 0, participatingAgentIds: [],
    createdAt: now, updatedAt: now
  };
}

function snapshot(message: string, hasActiveWorkItem = true): IntentContextSnapshot {
  return {
    id: 'snapshot-1', sessionId: 'session-1', sourceEventId: 'event-1',
    ...(hasActiveWorkItem ? {
      activeWorkItemId: 'work-1',
      activeWorkItem: { id: 'work-1', title: 'Task', goal: 'Original task', status: 'FAILED' as const, revision: 1 }
    } : {}),
    currentMessage: message, validDecisionIds: [], validDecisions: [],
    candidateWorkItemIds: hasActiveWorkItem ? ['work-1'] : [],
    candidateWorkItems: hasActiveWorkItem
      ? [{ id: 'work-1', title: 'Task', goal: 'Original task', status: 'FAILED', revision: 1 }]
      : [],
    revision: {
      sessionRevision: 2,
      ...(hasActiveWorkItem ? { activeWorkItemId: 'work-1', activeWorkItemRevision: 1 } : {}),
      decisionLedgerRevision: 0,
      latestEventSeq: 1
    },
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

type CapturedRuntimeInput = {
  contextEnvelopeFactory: (input: {
    identity: { agentId: string; profileHash: string; profileRevision: number };
    toolCatalog: { catalogHash: string };
  }) => ContextEnvelopeV2;
};

function setup(runtimeResults: AgentRunResult[] = [], snapshotCurrent = true) {
  let runtimeCalls = 0;
  const inputs: CapturedRuntimeInput[] = [];
  const records = new Map([['routing-1', routing()]]);
  const context = {
    async updateRoutingRecord(_sessionId: string, routingId: string, patch: Partial<IntentRoutingRecord>) {
      const updated = { ...records.get(routingId)!, ...patch, updatedAt: now };
      records.set(routingId, updated);
      return updated;
    },
    isSnapshotCurrent() { return snapshotCurrent; },
    getWorkItem() { return { inheritedArtifactIds: [] }; }
  };
  const service = new SemanticIntentRouterService(
    {
      async invoke(input: CapturedRuntimeInput) {
        inputs.push(input);
        const item = runtimeResults[runtimeCalls++];
        if (!item) throw new Error('RUNTIME_UNAVAILABLE');
        return item;
      }
    } as never,
    { resolveSystemRole: () => ({ id: 'intent-agent', key: 'system-intent-router' }) } as never,
    { get: () => ({ role: 'intent_router', preferredRuntimeType: 'mock' }) } as never,
    context as never
  );
  return {
    service,
    runtimeCalls: () => runtimeCalls,
    record: () => records.get('routing-1')!,
    lastEnvelope: () => inputs.at(-1)?.contextEnvelopeFactory({
      identity: { agentId: 'intent-agent', profileHash: 'hash', profileRevision: 1 },
      toolCatalog: { catalogHash: 'catalog' }
    })
  };
}

test('exact continue command is state-validated without invoking the model', async () => {
  const fixture = setup();
  const outcome = await fixture.service.classify(session(), routing(), snapshot('继续'));

  assert.equal(fixture.runtimeCalls(), 0);
  assert.equal(outcome.decision.requestedAction, 'resume');
  assert.equal(outcome.autoApplicable, true);
  assert.equal(outcome.routing.status, 'ROUTED');
});

test('a paused message never invokes the model or falls back to clarification', async () => {
  const fixture = setup();
  const controller = new AbortController();
  controller.abort(new Error('paused'));
  await assert.rejects(fixture.service.classify({ id: 'session-1' } as never, routing(), {} as never, controller.signal), /paused/);
  assert.equal(fixture.runtimeCalls(), 0);
});

test('model-created WorkItem references fail closed and request clarification', async () => {
  const fixture = setup([result({
    schemaVersion: '1.0', kind: 'intent_routing_decision', dialogueAct: 'question',
    scopeRelation: 'same_requirement', contextPolicy: 'inherit_confirmed',
    requestedAction: 'continue_active_work_item', selectedWorkItemId: '00000000-0000-0000-0000-000000000999',
    selectedDecisionIds: [], selectedArtifactIds: [], requestedAgentIds: [], goalSegments: ['Continue'], missingFields: [],
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

test('the classifier input carries the explicit @ constraint', async () => {
  const fixture = setup();
  await fixture.service.classify(session(), routing(), {
    ...snapshot('@质量 这个也一起看下'),
    mentionedAgentIds: ['agent-quality']
  });

  const envelope = fixture.lastEnvelope();
  assert.ok(envelope, 'the runtime input must be built at least once');
  assert.ok(
    envelope.L5?.bullets.some((bullet) => bullet.includes('agent-quality')),
    `the @ target must reach the classifier: ${JSON.stringify(envelope.L5?.bullets)}`
  );
});

test('a decision that silently drops the @ target is not auto-applied', async () => {
  const decision = {
    schemaVersion: '1.0' as const, kind: 'intent_routing_decision' as const, dialogueAct: 'question' as const,
    scopeRelation: 'same_requirement' as const, contextPolicy: 'inherit_confirmed' as const,
    requestedAction: 'continue_active_work_item' as const, selectedWorkItemId: 'work-1',
    selectedDecisionIds: [], selectedArtifactIds: [], requestedAgentIds: [],
    goalSegments: ['Continue'], missingFields: [], ambiguityReasons: [],
    reasonCodes: ['MODEL_SELECTION'], riskLevel: 'low' as const, modelConfidence: 0.99
  };
  const dropped = setup([result(decision)]);
  const outcome = await dropped.service.classify(session('COMPLETED'), routing(), {
    ...snapshot('@质量 这个也一起看下'),
    mentionedAgentIds: ['agent-quality']
  });

  assert.equal(outcome.autoApplicable, false, JSON.stringify(outcome.validation));
  assert.ok(outcome.validation.errors.includes('MENTION_TARGET_DROPPED'));
  assert.equal(outcome.routing.status, 'CLARIFICATION_REQUIRED');

  const kept = setup([result({ ...decision, requestedAgentIds: ['agent-quality'] })]);
  const keptOutcome = await kept.service.classify(session('COMPLETED'), routing(), {
    ...snapshot('@质量 这个也一起看下'),
    mentionedAgentIds: ['agent-quality']
  });
  assert.equal(keptOutcome.validation.errors.includes('MENTION_TARGET_DROPPED'), false);
  assert.deepEqual(keptOutcome.decision.requestedAgentIds, ['agent-quality']);

  const invented = setup([result({ ...decision, requestedAgentIds: ['agent-quality', 'agent-not-mentioned'] })]);
  const inventedOutcome = await invented.service.classify(session('COMPLETED'), routing(), {
    ...snapshot('@质量 这个也一起看下'),
    mentionedAgentIds: ['agent-quality']
  });
  assert.ok(
    inventedOutcome.validation.errors.includes('AGENT_TARGET_OUTSIDE_SNAPSHOT'),
    `the classifier must not invent targets: ${JSON.stringify(inventedOutcome.validation.errors)}`
  );
});

test('golden dataset is evaluated through the SemanticIntentRouter validation path', async () => {
  for (const item of INTENT_ROUTING_GOLDEN_DATASET_V1) {
    const runtimeFailure = item.tags.includes('runtime_failure');
    const staleSnapshot = item.tags.includes('stale_snapshot');
    const action = item.expected.action;
    const output = {
      schemaVersion: '1.0' as const,
      kind: 'intent_routing_decision' as const,
      dialogueAct: ['pause', 'cancel', 'resume', 'continue_active_work_item', 'replan', 'confirm', 'reject', 'clarify', 'create_related_work_item', 'create_independent_work_item'].includes(action)
        ? 'command' as const
        : 'question' as const,
      scopeRelation: item.expected.relation,
      contextPolicy: item.expected.contextPolicy,
      requestedAction: action,
      selectedWorkItemId: item.hasActiveWorkItem ? 'work-1' : null,
      selectedDecisionIds: [],
      selectedArtifactIds: [],
      requestedAgentIds: [],
      goalSegments: action.includes('work_item') ? ['Golden task segment'] : [],
      missingFields: [],
      ambiguityReasons: item.expected.relation === 'ambiguous' ? ['GOLDEN_AMBIGUITY'] : [],
      reasonCodes: [`GOLDEN_${item.id}`],
      riskLevel: action === 'cancel' ? 'high' as const : 'low' as const,
      modelConfidence: 0.99
    };
    const fixture = setup(runtimeFailure ? [] : [result(output)], !staleSnapshot);
    const outcome = await fixture.service.classify(
      session(item.sessionStatus, item.hasActiveWorkItem),
      routing(),
      snapshot(item.message, item.hasActiveWorkItem)
    );
    assert.equal(outcome.decision.scopeRelation, item.expected.relation, item.id);
    assert.equal(outcome.decision.contextPolicy, item.expected.contextPolicy, item.id);
    assert.equal(outcome.decision.requestedAction, item.expected.action, item.id);
    assert.equal(outcome.autoApplicable, item.expected.autoApply, item.id);
  }
});
