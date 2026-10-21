import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  AgentRunResult,
  ContextEnvelopeV2,
  IntentContextSnapshot,
  IntentRoutingRecord,
  IntentUnderstandingOutput,
  SessionDetail
} from '@agent-cluster/shared';
import { createRuntimeArtifactSystemEvidence } from '@agent-cluster/shared';
import { workspaceMetrics } from '../../common/workspace-metrics.js';
import { currentIntentRoutingGoldenDataset } from './intent-routing-golden.dataset.js';
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

function snapshot(message: string, hasActiveWorkItem = true, mentionedAgentIds?: string[]): IntentContextSnapshot {
  return {
    id: 'snapshot-1', sessionId: 'session-1', sourceEventId: 'event-1',
    ...(mentionedAgentIds?.length ? { mentionedAgentIds } : {}),
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

function proposedDecision(patch: Record<string, unknown> = {}) {
  return {
    schemaVersion: '1.0', kind: 'intent_routing_decision', dialogueAct: 'command',
    scopeRelation: 'same_requirement', contextPolicy: 'inherit_confirmed',
    requestedAction: 'continue_active_work_item', selectedWorkItemId: 'work-1',
    selectedDecisionIds: [], selectedArtifactIds: [], requestedAgentIds: [],
    goalSegments: [], missingFields: [], ambiguityReasons: [], reasonCodes: ['MODEL_SELECTION'],
    riskLevel: 'low', modelConfidence: 0.99, ...patch
  } as AgentRunResult['output'];
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

function setup(runtimeResults: Array<AgentRunResult | Error> = [], snapshotCurrent = true) {
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
    async reserveIntentClassificationAttempt(_sessionId: string, routingId: string) {
      const record = records.get(routingId)!;
      const attempt = (record.classificationAttempts ?? 0) + 1;
      if (attempt > 2) return undefined;
      records.set(routingId, { ...record, classificationAttempts: attempt });
      return attempt;
    },
    getWorkItem() { return { inheritedArtifactIds: [] }; }
  };
  const service = new SemanticIntentRouterService(
    {
      async invoke(input: CapturedRuntimeInput) {
        inputs.push(input);
        const item = runtimeResults[runtimeCalls++];
        if (item instanceof Error) throw item;
        if (!item) throw new Error('RUNTIME_TIMEOUT');
        return item;
      }
    } as never,
    { resolveSystemRole: () => ({ id: 'intent-agent', key: 'system-intent-router' }) } as never,
    { get: () => ({ role: 'intent_router', preferredRuntimeType: 'mock' }) } as never,
    context as never
  );
  return {
    service,
    inputs,
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

test('completed exact continue uses the same clarification guard as the message entry', async () => {
  const fixture = setup();
  const current = snapshot('继续执行');
  current.activeWorkItem!.status = 'COMPLETED';
  const outcome = await fixture.service.classify(session('COMPLETED'), routing(), current);
  assert.equal(fixture.runtimeCalls(), 0);
  assert.equal(outcome.autoApplicable, false);
  assert.equal(outcome.decision.requestedAction, 'clarify');
});

test('model low-risk cancellation cannot turn a progress question into a cancel', async () => {
  const fixture = setup([result(proposedDecision({ requestedAction: 'cancel' }))]);
  const outcome = await fixture.service.classify(session('EXECUTING'), routing(), snapshot('当前任务进度怎么样？'));
  assert.equal(outcome.autoApplicable, false);
  assert.ok(outcome.validation.errors.includes('CONTROL_ACTION_NOT_AUTHORIZED'));
});

test('an independent requirement cannot continue the existing work item', async () => {
  const fixture = setup([result(proposedDecision({
    scopeRelation: 'independent_new_requirement', contextPolicy: 'clean_task_context'
  }))]);
  const outcome = await fixture.service.classify(session(), routing(), snapshot('创建一个独立的天气查询任务'));
  assert.equal(outcome.autoApplicable, false);
  assert.ok(outcome.validation.errors.includes('RELATION_ACTION_CONFLICT'));
});

test('schema repair carries concrete validation feedback without changing the user message', async () => {
  const fixture = setup([result({} as AgentRunResult['output']), result(proposedDecision())]);
  await fixture.service.classify(session(), routing(), snapshot('请分析刚补充的信息'));
  assert.equal(fixture.runtimeCalls(), 2);
  const envelope = fixture.lastEnvelope()!;
  assert.equal(envelope.L1.currentUserMessage, '请分析刚补充的信息');
  assert.match(JSON.stringify(envelope.L5), /validationErrors/);
  assert.match(JSON.stringify(envelope.L5), /schemaVersion/);
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

test('two transient Runtime failures block without offering semantic clarification', async () => {
  workspaceMetrics.resetForTests();
  const fixture = setup();
  const outcome = await fixture.service.classify(session(), routing(), snapshot('请分析我刚补充的内容'));

  assert.equal(fixture.runtimeCalls(), 2);
  assert.equal(outcome.decision.requestedAction, 'clarify');
  assert.equal(outcome.autoApplicable, false);
  assert.equal(outcome.routing.status, 'BLOCKED');
  assert.equal(outcome.routing.failureClass, 'transient');
  assert.ok(!outcome.routing.reasonCodes.includes('USER_CHOICE_REQUIRED'));
  assert.equal(
    workspaceMetrics.snapshot().series.find((item) =>
      item.name === 'intent_route_runtime_failure_total' && item.labels.code === 'runtime_timeout'
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

test('a guessed switch to one of two similar historical requirements is not auto-applied', async () => {
  const decision = {
    schemaVersion: '1.0' as const, kind: 'intent_routing_decision' as const, dialogueAct: 'command' as const,
    scopeRelation: 'same_requirement' as const, contextPolicy: 'inherit_confirmed' as const,
    requestedAction: 'continue_active_work_item' as const, selectedWorkItemId: 'work-export-2',
    selectedDecisionIds: [], selectedArtifactIds: [], requestedAgentIds: [],
    goalSegments: ['继续导出'], missingFields: [], ambiguityReasons: [],
    reasonCodes: ['MODEL_SELECTION'], riskLevel: 'low' as const, modelConfidence: 0.95
  };
  const fixture = setup([result(decision)]);
  const outcome = await fixture.service.classify(session('COMPLETED'), routing(), {
    ...snapshot('把导出报表那个继续做完'),
    candidateWorkItemIds: ['work-1', 'work-export-1', 'work-export-2'],
    candidateWorkItems: [
      { id: 'work-1', title: 'Task', goal: 'Original task', status: 'FAILED', revision: 1 },
      { id: 'work-export-1', title: '导出报表', goal: 'Excel', status: 'COMPLETED', revision: 1 },
      { id: 'work-export-2', title: '导出报表 v2', goal: 'CSV', status: 'OPEN', revision: 1 }
    ],
    recall: {
      availability: 'ok', needsClarification: true, clarificationReason: 'multiple_similar_candidates',
      candidates: [
        { workItemId: 'work-export-1', matchedBy: 'lexical', matchedTerms: ['导出'] },
        { workItemId: 'work-export-2', matchedBy: 'lexical', matchedTerms: ['导出'] }
      ]
    }
  });

  assert.equal(outcome.autoApplicable, false);
  assert.ok(outcome.validation.errors.includes('HISTORICAL_RECALL_AMBIGUOUS'), JSON.stringify(outcome.validation));
  assert.equal(outcome.routing.status, 'CLARIFICATION_REQUIRED');

  const envelope = fixture.lastEnvelope();
  assert.ok(envelope?.L5.bullets.some((bullet) => bullet.includes('multiple_similar_candidates')), 'the classifier is told recall is ambiguous');
});

test('golden dataset is evaluated through the SemanticIntentRouter validation path', async () => {
  for (const item of currentIntentRoutingGoldenDataset()) {
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
      requestedAgentIds: item.expectedAgentIds ?? [],
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
      snapshot(item.message, item.hasActiveWorkItem, item.mentionedAgentIds)
    );
    const why = `${item.id} ${JSON.stringify(outcome.validation)}`;
    assert.equal(outcome.decision.scopeRelation, item.expected.relation, why);
    assert.equal(outcome.decision.contextPolicy, item.expected.contextPolicy, why);
    assert.equal(outcome.decision.requestedAction, item.expected.action, why);
    assert.equal(outcome.autoApplicable, item.expected.autoApply, why);
  }
});

for (const [code, failureClass] of [['AUTHENTICATION_FAILED', 'auth'], ['OPERATION_STOP_UNCONFIRMED', 'unknown_effect']] as const) {
  test(`${code} blocks on the first call without semantic confirmation`, async () => {
    const failed = result({} as AgentRunResult['output'], 'failed');
    failed.error = { code: 'MODEL_ERROR', message: code, retryable: false };
    const fixture = setup([failed]);
    const outcome = await fixture.service.classify(session(), routing(), snapshot('请分析现有设计'));
    assert.equal(fixture.runtimeCalls(), 1);
    assert.equal(outcome.routing.status, 'BLOCKED');
    assert.equal(outcome.routing.failureClass, failureClass);
    assert.equal(outcome.autoApplicable, false);
  });
}

test('invalid schema has only one repair and exhausted routing cannot multiply calls on rebuild', async () => {
  const fixture = setup([result({} as AgentRunResult['output']), result({} as AgentRunResult['output'])]);
  const outcome = await fixture.service.classify(session(), routing(), snapshot('检查设计中的问题'));
  assert.equal(fixture.runtimeCalls(), 2);
  assert.equal(outcome.routing.status, 'BLOCKED');
  assert.equal(outcome.routing.failureClass, 'schema');
  await fixture.service.classify(session(), fixture.record(), snapshot('检查设计中的问题'));
  assert.equal(fixture.runtimeCalls(), 2);
});

function correctionUnderstanding(): IntentUnderstandingOutput {
  return { schemaVersion: '1.0', kind: 'intent_understanding', semanticContractVersion: 'intent-understanding-v1',
    segments: [{ localKey: 'change', dialogueAct: 'correction', goal: '超时改为 30 分钟', scopeRelation: 'same_requirement',
      suggestedAction: 'correct_route', contextPolicy: 'inherit_confirmed',
      target: { workItemId: 'work-1', decisionIds: [], artifactIds: [], agentIds: [], confirmationId: null, correctionOfRoutingId: 'routing-1' },
      correction: { supersedesDecisionId: 'decision-1', expectedDecisionRevision: 1, replacementText: '超时改为 30 分钟' },
      requestedEffects: [], prohibitions: [], dependencies: [],
      evidence: [{ refId: 'current', sourceEventId: 'event-1', start: 0, end: 10, quote: '超时改为 30 分钟' }] }],
    missingFields: [], ambiguityReasons: [], modelConfidence: 0.9 };
}

test('semantic understanding uses the restricted runtime builder with exact source, contract and durable operation identity', async () => {
  const output = correctionUnderstanding();
  const fixture = setup([result(output)]);
  const current = snapshot('超时改为 30 分钟');
  current.effectAuthority = { grants: [], resources: [{ kind: 'test_runner', refId: 'server-runner-candidate' }], testRunnerBindings: [] };
  const outcome = await fixture.service.understand({ session: session('PAUSED'), snapshot: current,
    operationId: 'routing-1:2:classification', invocationId: 'correction-invocation',
    correction: { contractVersion: 'intent-correction-v1', routingId: 'routing-1', idempotencyKey: 'key',
      expectedRoutingRevision: 3, instruction: '超时改为 30 分钟', targetWorkItemId: 'work-1',
      supersedesDecisionId: 'decision-1', expectedDecisionRevision: 1 } });
  assert.equal(outcome.status, 'valid');
  assert.equal(fixture.runtimeCalls(), 1);
  const input = fixture.inputs[0] as CapturedRuntimeInput & Record<string, any>;
  assert.equal(input.operationId, 'routing-1:2:classification');
  assert.equal(input.inputBudgetScope.kind, 'intent_understanding');
  assert.equal(input.inputBudgetScope.actorId, 'user-1');
  assert.equal(input.invocationId, 'correction-invocation');
  assert.equal(input.admissionClass, 'routing');
  assert.equal(input.writeModeOverride, 'none');
  assert.equal(input.taskRequiresCodeChanges, false);
  assert.deepEqual(input.workspace.capabilities, { read: false, write: false, command: false, test: false });
  assert.deepEqual(input.expectedOutput, { kind: 'intent_understanding', schemaVersion: '1.0' });
  const envelope = fixture.lastEnvelope()!;
  assert.equal(envelope.L1.currentUserMessage, '超时改为 30 分钟');
  assert.match(envelope.L0.systemRules[0], /intent_understanding@1.0/);
  assert.match(JSON.stringify(envelope.L5), /event-1/);
  assert.match(JSON.stringify(envelope.L5), /decision-1/);
  assert.match(JSON.stringify(envelope.L5), /server-runner-candidate/);
  assert.match(JSON.stringify(envelope.L5), /candidate is not an authorization/);
  assert.deepEqual(envelope.L3.files, []);
});

test('semantic classifier receives Session state independently of a stale or different WorkItem state', async () => {
  for (const status of ['EXECUTING', 'PAUSED', 'FAILED', 'WAIT_USER_CONFIRM'] as const) {
    const fixture = setup([result(correctionUnderstanding())]);
    const current = snapshot('不要停止当前任务，按原计划继续。');
    // This WorkItem says FAILED for every case; it cannot stand in for Session state.
    assert.equal(current.activeWorkItem?.status, 'FAILED');
    await fixture.service.understand({ session: session(status), snapshot: current,
      operationId: `state-${status}`, invocationId: `invocation-${status}` });
    const envelope = fixture.lastEnvelope()!;
    assert.ok(envelope.L5.bullets.includes(`Current Session state (authoritative, distinct from WorkItem state): ${status}`));
    assert.equal(envelope.L1.currentUserMessage, current.currentMessage);
    assert.equal(fixture.runtimeCalls(), 1);
    assert.deepEqual(envelope.L4.calls, []);
  }
});

test('understanding rejects unknown output fields and leaves the single repair budget to its durable caller', async () => {
  const fixture = setup([result({ ...correctionUnderstanding(), safeToApply: true } as never)]);
  const outcome = await fixture.service.understand({ session: session(), snapshot: snapshot('超时改为 30 分钟'),
    operationId: 'routing-1:2:classification', invocationId: 'repair',
    repairFeedback: { previousOutput: '{broken', validationErrors: ['segments missing'] } });
  assert.equal(outcome.status, 'invalid');
  assert.equal(fixture.runtimeCalls(), 1);
  if (outcome.status === 'invalid') assert.ok(outcome.validationErrors.some(error => error.includes('safeToApply')));
  assert.match(JSON.stringify(fixture.lastEnvelope()!.L5), /segments missing/);
  assert.equal(fixture.lastEnvelope()!.L1.currentUserMessage, '超时改为 30 分钟');
});

test('understanding supplies distinct resume and executing-continuation rules without granting runtime effects', async () => {
  for (const status of ['PAUSED', 'EXECUTING'] as const) {
    const fixture = setup([result(correctionUnderstanding())]);
    await fixture.service.understand({ session: session(status), snapshot: snapshot('处理当前工作及新增要求'),
      operationId: `segmentation-${status}`, invocationId: `segmentation-${status}` });
    const envelope = fixture.lastEnvelope()!;
    const rules = envelope.L0.systemRules.join('\n');
    assert.match(rules, /resume requires PAUSED/);
    assert.match(rules, /Pure resumption of the approved plan has requestedEffects=\[\]/);
    assert.match(rules, /Empty effects grant no authority/);
    assert.match(rules, /New requirements accompanying resume form separate segments/);
    assert.match(rules, /Use enqueue_follow_up for existing-requirement additions or continuation/);
    assert.match(rules, /Missing approval is a server execution gate, not a different intent; enqueue_follow_up grants no approval/);
    assert.match(rules, /In EXECUTING, continuation uses enqueue_follow_up, not resume\/acknowledge: merge it with additions; alone emit one segment with requestedEffects=\[\]/);
    assert.match(rules, /Split distinct goals, not modifiers/);
    assert.match(rules, /Maintaining the current state is a qualifier of the accompanying request, not a new transition or segment/);
    assert.doesNotMatch(rules, /H01|H03|H11|登录模块照常推进|暂停原因已经消除/);
    const input = fixture.inputs[0] as CapturedRuntimeInput & Record<string, any>;
    assert.equal(input.writeModeOverride, 'none');
    assert.equal(input.taskRequiresCodeChanges, false);
    assert.deepEqual(input.workspace.capabilities, { read: false, write: false, command: false, test: false });
    assert.deepEqual(envelope.L4.calls, []);
  }
});

test('understanding classifies an authentication failure without a retry or semantic fallback', async () => {
  const failed = result({} as never, 'failed');
  failed.error = { code: 'MODEL_ERROR', message: 'HTTP 401 unauthorized', retryable: true };
  const fixture = setup([failed]);
  const outcome = await fixture.service.understand({ session: session(), snapshot: snapshot('超时改为 30 分钟'),
    operationId: 'routing-1:2:classification', invocationId: 'auth' });
  assert.equal(outcome.status, 'failed');
  if (outcome.status === 'failed') assert.equal(outcome.failureClass, 'auth');
  assert.equal(fixture.runtimeCalls(), 1);
});

test('understanding preserves an open provider circuit without retrying or reporting semantic success', async () => {
  const failed = result({} as never, 'failed');
  failed.error = { code: 'MODEL_ERROR', message: 'Provider circuit open', retryable: false,
    details: { circuitOpen: true, retryAfterMs: 120000 } };
  const fixture = setup([failed]);
  const outcome = await fixture.service.understand({ session: session(), snapshot: snapshot('检查设计'),
    operationId: 'explicit-recognition-retry', invocationId: 'circuit' });
  assert.equal(outcome.status, 'failed');
  if (outcome.status === 'failed') {
    assert.equal(outcome.code, 'INTENT_PROVIDER_CIRCUIT_OPEN');
    assert.equal(outcome.retryable, false);
    assert.equal(outcome.retryAfterMs, 120000);
  }
  assert.equal(fixture.runtimeCalls(), 1);
});

test('understanding preserves structured runtime resolution errors as nonretryable configuration failures', async () => {
  const fixture = setup([Object.assign(new Error('没有满足条件的运行时'), { code: 'NO_ELIGIBLE_RUNTIME' })]);
  const outcome = await fixture.service.understand({ session: session(), snapshot: snapshot('检查设计'),
    operationId: 'clarification-operation', invocationId: 'resolution-failure' });
  assert.equal(outcome.status, 'failed');
  if (outcome.status === 'failed') {
    assert.equal(outcome.code, 'NO_ELIGIBLE_RUNTIME');
    assert.equal(outcome.failureClass, 'config');
    assert.equal(outcome.retryable, false);
  }
  assert.equal(fixture.runtimeCalls(), 1);
});

test('clarification keeps the original message and binds the displayed relation and inheritance in the restricted prompt', async () => {
  const fixture = setup([result(correctionUnderstanding())]);
  await fixture.service.understand({ session: session(), snapshot: snapshot('检查设计'), operationId: 'clarification-operation', invocationId: 'choice',
    clarification: { choice: 'related_new', activeWorkItemId: 'work-1', inheritedDecisionIds: ['shown-decision'], inheritedArtifactIds: [] } });
  const envelope = fixture.lastEnvelope()!;
  assert.equal(envelope.L1.currentUserMessage, '检查设计');
  assert.match(JSON.stringify(envelope.L5), /Server-bound clarification:/);
  assert.match(JSON.stringify(envelope.L5), /shown-decision/);
  assert.match(JSON.stringify(envelope.L5), /related_new/);
  const input = fixture.inputs[0] as CapturedRuntimeInput & Record<string, any>;
  assert.equal(input.admissionClass, 'routing');
  assert.deepEqual(input.workspace.capabilities, { read: false, write: false, command: false, test: false });
});

test('adapter-owned diagnostics are returned to the durable understanding caller as repair feedback', async () => {
  const failed = result({} as never, 'failed');
  failed.error = { code: 'RUNTIME_OUTPUT_CONTRACT_VIOLATION', message: 'invalid output', retryable: false,
    details: { schemaRepairOwner: 'intent_classifier', previousOutput: '{bad}', validationErrors: ['segments missing'] } };
  const fixture = setup([failed]);
  const outcome = await fixture.service.understand({ session: session(), snapshot: snapshot('检查设计'), operationId: 'route', invocationId: 'schema' });
  assert.deepEqual(outcome, { status: 'invalid', previousOutput: '{bad}', validationErrors: ['segments missing'] });
  assert.equal(fixture.runtimeCalls(), 1);
});

test('legacy intent classification also owns its sole repair after a provider contract failure', async () => {
  const failed = result({} as never, 'failed');
  failed.error = { code: 'RUNTIME_OUTPUT_CONTRACT_VIOLATION', message: 'invalid output', retryable: false,
    details: { schemaRepairOwner: 'intent_classifier', previousOutput: '{bad}', validationErrors: ['scopeRelation missing'] } };
  const fixture = setup([failed, result(proposedDecision())]);
  await fixture.service.classify(session(), routing(), snapshot('检查设计中的问题'));
  assert.equal(fixture.runtimeCalls(), 2);
  assert.match(JSON.stringify(fixture.lastEnvelope()!.L5), /scopeRelation missing/);
});
