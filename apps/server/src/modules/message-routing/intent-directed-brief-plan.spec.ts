import assert from 'node:assert/strict';
import test from 'node:test';
import { intentUnderstandingExample, validateRuntimeOutput, type TaskBrief, type ValidatedRoutePlan, type WorkItem } from '@agent-cluster/shared';
import { deriveDirectedBriefSteps } from './intent-directed-brief-plan.js';
import { assertIntentExecutionCurrent } from './intent-execution-guard.js';
import { completedBriefReviews } from './intent-brief-reviews.js';

function fixture() {
  const segment = structuredClone(intentUnderstandingExample.segments[0]);
  const binding = { routingId: 'route', intentRevision: 2, requirementRevision: 3, executionEpoch: 4, sessionGeneration: 1,
    decisionSetHash: 'decisions', effectScopeHash: 'empty' };
  const scope = { effects: [], prohibitions: [], grantIds: [], scopeHash: 'empty' };
  const plan: ValidatedRoutePlan = { planId: 'plan', routingId: 'route', routingRevision: 5, intentRevision: 2,
    sourceEventId: 'source', snapshotId: 'snapshot', businessFingerprint: 'fingerprint', policyVersion: 'intent-policy-v1', outcome: 'applicable',
    validation: { schemaValid: true, referencesValid: true, relationActionValid: true, stateValid: true, authorizationValid: true,
      snapshotCurrent: true, errorCodes: [], validationScore: 1 },
    steps: [{ ...segment, stepId: 'parent', segmentId: 'segment', segmentKey: 'revision', action: 'record_information',
      target: { ...segment.target, workItemId: 'work', agentIds: [] }, correction: null, effectScope: scope, executionBinding: binding,
      goal: '修改说明', expectedSessionStatus: 'REVISING_BRIEF', idempotencyKey: 'source:revision' }] };
  const work = { id: 'work', sessionId: 'session', goal: '完整任务目标', requirementRevision: 3, executionEpoch: 4 } as WorkItem;
  const brief = { id: 'brief', sessionId: 'session', workItemId: 'work', version: 1,
    intentBinding: { routingId: 'old-route', intentRevision: 1, stepId: 'old-step', invocationId: 'old-call' } } as TaskBrief;
  return { plan, work, brief };
}

test('directed revision preserves every requested reviewer and requires all reviews before final generation', () => {
  const f = fixture(), original = structuredClone(f.plan), ids = ['architect', 'reviewer'];
  const steps = deriveDirectedBriefSteps(f.plan, f.brief, f.work, ids), reviews = steps.slice(0, -1), final = steps.at(-1)!;
  assert.deepEqual(reviews.map(row => row.target.agentIds), ids.map(id => [id]));
  assert.deepEqual(final.requiredBriefReviewStepIds, reviews.map(row => row.stepId));
  assert.equal(new Set(steps.map(row => row.stepId)).size, 3);
  assert.equal(new Set(steps.map(row => row.idempotencyKey)).size, 3);
  assert.deepEqual(final.target.agentIds, []); assert.equal(final.action, 'prepare_brief');
  for (const step of steps) {
    assert.equal(step.derivedFromStepId, 'parent'); assert.deepEqual(step.replacesBrief, { briefId: 'brief', version: 1 });
    assert.equal(step.goal, f.work.goal); assert.deepEqual(step.executionBinding, f.plan.steps[0].executionBinding);
    assert.deepEqual(step.effectScope.effects, []); assert.deepEqual(step.effectScope.grantIds, []);
  }
  assert.deepEqual(f.plan, original);
  reviews[0].target.agentIds.push('mutated'); assert.deepEqual(reviews[1].target.agentIds, ['reviewer']);
});

test('missing, repeated and oversized assignment cannot silently fall back to Coordinator', () => {
  for (const ids of [[], ['reviewer', 'reviewer'], [''], Array.from({ length: 9 }, (_, i) => `agent-${i}`)]) {
    const f = fixture(); assert.throws(() => deriveDirectedBriefSteps(f.plan, f.brief, f.work, ids), /TARGETS_INVALID/);
  }
  const f = fixture(); f.plan.steps[0].target = { ...f.plan.steps[0].target, agentIds: ['model-chosen-agent'] };
  assert.throws(() => deriveDirectedBriefSteps(f.plan, f.brief, f.work, ['reviewer']), /DERIVATION_INVALID/);
});

test('model cannot emit internal review action and runtime cannot launch an unclaimed review plan', () => {
  const understanding = structuredClone(intentUnderstandingExample);
  (understanding.segments[0] as any).suggestedAction = 'review_brief';
  assert.equal(validateRuntimeOutput('intent_understanding', understanding).valid, false);
  const f = fixture(), steps = deriveDirectedBriefSteps(f.plan, f.brief, f.work, ['reviewer']);
  f.plan.steps.push(...steps);
  const state: any = { sessions: [{ id: 'session', dataEpoch: 'epoch', intentContractVersion: 'intent-understanding-v1' }],
    workItemsBySession: { session: [f.work] }, intentRoutingRecordsBySession: { session: [{ id: 'route', effectiveIntentRevision: 2 }] },
    intentRouteRevisionsBySession: { session: [{ routingId: 'route', intentRevision: 2, dataEpoch: 'epoch', authorizationState: 'validated', validatedPlan: f.plan }] } };
  for (const step of steps) assert.throws(() => assertIntentExecutionCurrent(state, { sessionId: 'session', dataEpoch: 'epoch',
    workItemId: 'work', admissionClass: 'business', intentStepId: step.stepId, executionBinding: step.executionBinding,
    effectScope: step.effectScope }), /INTENT_BRIEF_STEP_STALE/);
});

test('final generation requires every exact opinion, preserving assignment order and immutable provenance', () => {
  const f = fixture(), steps = deriveDirectedBriefSteps(f.plan, f.brief, f.work, ['architect', 'reviewer']);
  f.plan.steps.push(...steps);
  const records: any[] = steps.map(step => ({ id: step.stepId, sessionId: 'session', dataEpoch: 'epoch', routingId: 'route', intentRevision: 2,
    step, status: 'completed', responseEventId: `event:${step.stepId}`, processing: { invocationId: `call:${step.stepId}`,
      result: { agentId: step.target.agentIds[0], invocationId: `call:${step.stepId}`, content: `opinion:${step.target.agentIds[0]}` } } }));
  const final = records.at(-1), version: any = { routingId: 'route', intentRevision: 2, dataEpoch: 'epoch', validatedPlan: f.plan };
  assert.deepEqual(completedBriefReviews(final, [...records].reverse(), version).map(row => row.agentId), ['architect', 'reviewer']);
  for (const mode of ['missing', 'failed', 'foreign-agent', 'foreign-version', 'changed-plan', 'no-receipt', 'empty-output']) {
    const changed = structuredClone(records);
    if (mode === 'missing') changed.shift();
    if (mode === 'failed') changed[0].status = 'failed';
    if (mode === 'foreign-agent') changed[0].processing.result.agentId = 'other';
    if (mode === 'foreign-version') changed[0].intentRevision++;
    if (mode === 'changed-plan') changed[0].step.goal = 'other';
    if (mode === 'no-receipt') delete changed[0].responseEventId;
    if (mode === 'empty-output') changed[0].processing.result.content = ' ';
    assert.throws(() => completedBriefReviews(final, changed, version), /INTENT_BRIEF_REVIEW/);
  }
  const omitted = structuredClone(final); omitted.step.requiredBriefReviewStepIds.pop();
  assert.throws(() => completedBriefReviews(omitted, records, version), /DEPENDENCIES_INVALID/);
});
