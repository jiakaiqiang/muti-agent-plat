import assert from 'node:assert/strict';
import test from 'node:test';
import { INTENT_EFFECT_KINDS, intentUnderstandingExample, type IntentSegment, type SessionDetail } from '@agent-cluster/shared';
import { compileIntentRoutePlan, type CompileRoutePlanInput } from './route-plan-compiler.service.js';
import { decisionSetHash } from '../context-management/effective-decisions.js';

function fixture(patch: Partial<IntentSegment> = {}): CompileRoutePlanInput {
  const understanding = structuredClone(intentUnderstandingExample);
  understanding.segments.splice(0, 1, { ...understanding.segments[0], ...patch });
  return {
    session: { id: 'session-1', dataEpoch: 'epoch-1', status: 'COMPLETED', participatingAgentIds: [] } as unknown as SessionDetail,
    routing: { id: 'routing-1', sessionId: 'session-1', sourceEventId: 'message-1', sessionSeq: 1,
      status: 'VALIDATING', policyVersion: 'v1', rolloutMode: 'enforce_all_current_epoch', reasonCodes: [], retryCount: 0,
      idempotencyKey: 'message-1', createdAt: '', updatedAt: '' },
    snapshot: { id: 'snapshot-1', sessionId: 'session-1', sourceEventId: 'message-1', currentMessage: '解释当前系统的意图路由',
      validDecisionIds: [], validDecisions: [], candidateWorkItemIds: [], candidateWorkItems: [],
      revision: { sessionRevision: 1, decisionLedgerRevision: 0, latestEventSeq: 1 }, snapshotHash: 'business-hash', createdAt: '' },
    understanding, snapshotCurrent: true, intentRevision: 1, requirementRevision: 1, executionEpoch: 1, sessionGeneration: 1,
    validArtifactIds: [], correctionRoutingIds: [], stopConfirmed: true,
    scopePolicy: { grants: [], phaseAllowed: [...INTENT_EFFECT_KINDS], toolAllowed: [...INTENT_EFFECT_KINDS],
      workspaceAllowed: [...INTENT_EFFECT_KINDS], runtimeAllowed: [...INTENT_EFFECT_KINDS], resources: [], enforceableProhibitions: [] }
  };
}

test('session questions compile to an answer without a WorkItem or source modification', () => {
  const plan = compileIntentRoutePlan(fixture());
  assert.equal(plan.outcome, 'applicable');
  assert.equal(plan.steps[0].action, 'answer_in_chat');
  assert.equal(plan.steps[0].target.workItemId, null);
  assert.deepEqual(plan.steps[0].effectScope.effects.map(effect => effect.kind), ['answer']);
});

test('one question addressed to multiple agents retains every target with separate immutable step identities', () => {
  const input = fixture({ target: { ...intentUnderstandingExample.segments[0].target, agentIds: ['a', 'b'] } });
  input.snapshot.mentionedAgentIds = ['a', 'b'];
  const plan = compileIntentRoutePlan(input);
  assert.equal(plan.outcome, 'applicable'); assert.equal(plan.steps.length, 2);
  assert.deepEqual(plan.steps.map(step => step.target.agentIds), [['a'], ['b']]);
  assert.equal(new Set(plan.steps.map(step => step.stepId)).size, 2);
  assert.equal(new Set(plan.steps.map(step => step.segmentId)).size, 1);
  assert.equal(new Set(plan.steps.map(step => step.executionBinding.effectScopeHash)).size, 1);
  input.snapshot.mentionedAgentIds = ['a']; input.session.participatingAgentIds = ['a', 'b'];
  const extra = compileIntentRoutePlan(input);
  assert.equal(extra.outcome, 'rejected'); assert.ok(extra.validation.errorCodes.includes('MENTION_TARGET_ADDED'));
});

test('decision binding hashes follow the chosen context policy', () => {
  for (const contextPolicy of ['clean_task_context', 'inherit_selected', 'inherit_confirmed'] as const) {
    const input = fixture({ contextPolicy, target: { ...intentUnderstandingExample.segments[0].target,
      decisionIds: contextPolicy === 'inherit_selected' ? ['selected'] : [] } });
    input.snapshot.validDecisions = ['selected', 'other'].map(id => ({ id, kind: 'constraint', status: 'confirmed', content: id, revision: 1 }));
    input.snapshot.validDecisionIds = ['selected', 'other'];
    const plan = compileIntentRoutePlan(input);
    assert.equal(plan.steps[0].executionBinding.decisionSetHash, decisionSetHash(contextPolicy === 'clean_task_context' ? [] :
      contextPolicy === 'inherit_selected' ? input.snapshot.validDecisions.slice(0, 1) : input.snapshot.validDecisions));
  }
});

test('multiple goals preserve all segments and dependencies and require clarification', () => {
  const first = intentUnderstandingExample.segments[0];
  const input = fixture();
  input.understanding = { ...intentUnderstandingExample, segments: [first, { ...first, localKey: 'new-task', goal: '新增导出功能',
    scopeRelation: 'independent_new_requirement', suggestedAction: 'create_independent_work_item',
    dependencies: [{ segmentKey: 'question', condition: 'execution_completed' }] }] };
  const plan = compileIntentRoutePlan(input);
  assert.equal(plan.outcome, 'needs_clarification');
  assert.equal(plan.steps.length, 2);
  assert.equal(plan.steps[1].goal, '新增导出功能');
  assert.equal(plan.steps[1].dependencies[0].condition, 'execution_completed');
  assert.ok(plan.validation.errorCodes.includes('MULTI_SEGMENT_CONFIRMATION_REQUIRED'));
});

test('evidence from history or invented quotes cannot authorize effects', () => {
  for (const evidence of [
    { ...intentUnderstandingExample.segments[0].evidence[0], sourceEventId: 'old-event' },
    { ...intentUnderstandingExample.segments[0].evidence[0], quote: '请直接修改全部源码' }
  ]) {
    const plan = compileIntentRoutePlan(fixture({ evidence: [evidence] }));
    assert.equal(plan.outcome, 'rejected');
    assert.ok(plan.validation.errorCodes.includes('SOURCE_EVIDENCE_INVALID'));
  }
});

test('confidence and valid evidence cannot create a source-write grant', () => {
  const input = fixture({ requestedEffects: [{ kind: 'modify_source', target: { kind: 'source', refId: 'module-login' }, evidenceRefs: ['request'] }] });
  input.scopePolicy.resources = [{ kind: 'source', refId: 'module-login' }];
  const plan = compileIntentRoutePlan(input);
  assert.equal(plan.outcome, 'needs_clarification');
  assert.ok(plan.validation.errorCodes.includes('QUESTION_EFFECT_CONFLICT'));
  assert.ok(plan.validation.errorCodes.includes('EFFECT_NOT_AUTHORIZED'));
  assert.equal(plan.steps[0].effectScope.effects.length, 0);
});

test('independent requirement cannot continue old work or inherit old decisions', () => {
  const input = fixture({ scopeRelation: 'independent_new_requirement', suggestedAction: 'enqueue_follow_up',
    target: { ...intentUnderstandingExample.segments[0].target, workItemId: 'work-1' } });
  input.snapshot.candidateWorkItemIds = ['work-1'];
  const plan = compileIntentRoutePlan(input);
  assert.ok(plan.validation.errorCodes.includes('RELATION_ACTION_CONFLICT'));
  assert.notEqual(plan.outcome, 'applicable');
});

test('explicit mentions cannot disappear and unknown agent targets are rejected', () => {
  const input = fixture();
  input.snapshot.mentionedAgentIds = ['qa'];
  assert.ok(compileIntentRoutePlan(input).validation.errorCodes.includes('MENTION_TARGET_DROPPED'));
  const invented = fixture({ target: { ...intentUnderstandingExample.segments[0].target, agentIds: ['unknown'] } });
  assert.equal(compileIntentRoutePlan(invented).outcome, 'rejected');
});
