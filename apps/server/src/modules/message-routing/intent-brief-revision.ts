import { isDeepStrictEqual } from 'node:util';
import { ConflictException } from '@nestjs/common';
import { briefQuestionKey, type CollaborationEvent, type DecisionRecord, type IntentBriefRevisionBinding, type IntentPlanStepRecord,
  type IntentRouteRevision, type IntentRoutingRecord, type ReviseIntentBriefInput, type SessionDetail, type TaskBrief, type ValidatedRoutePlan, type WorkItem } from '@agent-cluster/shared';
import type { PersistedState } from '../persistence/persistence.service.js';
import { appendDecisionInDraft } from '../context-management/context-management.service.js';
import { decisionSetHash, effectiveDecisions } from '../context-management/effective-decisions.js';
import { correctionRows as rows } from './intent-correction-state.js';
import type { SessionLifecyclesBySession } from '../runtimes/session-lifecycle-store.js';

export const briefRevisionCollections = ['briefsBySession', 'workItemsBySession', 'decisionRecordsBySession', 'intentRouteRevisionsBySession', 'intentPlanStepsBySession', 'logicalOperationsBySession'];

export function bindBriefRevision(draft: PersistedState, session: SessionDetail, briefId: string, request: ReviseIntentBriefInput): IntentBriefRevisionBinding {
  const brief = rows<TaskBrief>(draft, 'briefsBySession', session.id).find(row => row.id === briefId && row.sessionId === session.id);
  const work = rows<WorkItem>(draft, 'workItemsBySession', session.id).find(row => row.id === brief?.workItemId);
  const route = rows<IntentRoutingRecord>(draft, 'intentRoutingRecordsBySession', session.id).find(row => row.id === brief?.intentBinding?.routingId);
  const step = rows<IntentPlanStepRecord>(draft, 'intentPlanStepsBySession', session.id).find(row => row.id === brief?.intentBinding?.stepId);
  const version = rows<IntentRouteRevision>(draft, 'intentRouteRevisionsBySession', session.id).find(row => row.routingId === route?.id && row.intentRevision === brief?.intentBinding?.intentRevision);
  const lifecycle = (draft.sessionLifecyclesBySession as SessionLifecyclesBySession)[session.id];
  const events = rows<CollaborationEvent>(draft, 'eventsBySession', session.id);
  const card = events.find(row => row.type === 'user_confirmation_requested' && row.metadata.payload?.confirmationId === request.confirmationId)?.metadata.payload;
  const prior = rows<IntentRoutingRecord>(draft, 'intentRoutingRecordsBySession', session.id).find(row => row.id === session.pendingBriefRevisionRoutingId);
  if (request.dataEpoch !== session.dataEpoch || !brief?.intentBinding || brief.confirmedByUser || !work || work.dispatchHold ||
    session.currentTaskBriefId !== briefId || session.activeWorkItemId !== work.id || brief.version !== request.expectedBriefVersion ||
    brief.intentBinding.intentRevision !== request.expectedIntentRevision || !route || route.dispatchHold || route.effectiveIntentRevision !== request.expectedIntentRevision ||
    !step || step.status !== 'completed' || step.resultBriefId !== briefId || step.processing?.briefResult?.invocationId !== brief.intentBinding.invocationId ||
    !version || version.authorizationState !== 'validated' || !version.validatedPlan?.steps.some(row => isDeepStrictEqual(row, step.step)) ||
    !lifecycle || !['idle', 'confirmed'].includes(lifecycle.stopStatus) || lifecycle.generation !== step.step.executionBinding.sessionGeneration ||
    (work.requirementRevision ?? 1) !== step.step.executionBinding.requirementRevision || (work.executionEpoch ?? 1) !== step.step.executionBinding.executionEpoch ||
    decisionSetHash(effectiveDecisions(rows<DecisionRecord>(draft, 'decisionRecordsBySession', session.id), work)) !== step.step.executionBinding.decisionSetHash ||
    !card || card.relatedBriefId !== briefId || card.stepId !== step.id || card.intentRevision !== request.expectedIntentRevision || card.reason !== 'confirm_task_brief' ||
    !Array.isArray(card.options) || !card.options.some(option => (option as { key?: string })?.key === 'revise') ||
    events.some(row => row.type === 'user_confirmation_resolved' && row.metadata.payload?.confirmationId === request.confirmationId) ||
    !(['WAIT_USER_CONFIRM', 'REVISING_BRIEF'].includes(session.status) || (session.status === 'PAUSED' && ['WAIT_USER_CONFIRM', 'REVISING_BRIEF'].includes(session.pauseState?.previousStatus ?? ''))) ||
    (prior && !['BLOCKED', 'REJECTED', 'CLARIFICATION_REQUIRED'].includes(prior.status))) throw new ConflictException('INTENT_BRIEF_REVISION_STALE');
  const known = new Set([...brief.openQuestions, ...effectiveDecisions(rows<DecisionRecord>(draft, 'decisionRecordsBySession', session.id), work)
    .flatMap(row => row.question ? [row.question] : [])].map(briefQuestionKey));
  const keys = request.questionAnswers.map(row => briefQuestionKey(row.question));
  if (new Set(keys).size !== keys.length || keys.some(key => !known.has(key))) throw new ConflictException('INTENT_BRIEF_REVISION_QUESTION_INVALID');
  return { briefId, workItemId: work.id, request: structuredClone(request) };
}

export function assertBriefRevisionPlan(draft: PersistedState, session: SessionDetail, route: IntentRoutingRecord, plan: ValidatedRoutePlan) {
  const binding = route.briefRevision;
  if (!binding) return;
  const brief = rows<TaskBrief>(draft, 'briefsBySession', session.id).find(row => row.id === binding.briefId);
  const step = plan.steps[0];
  if (session.pendingBriefRevisionRoutingId !== route.id || session.currentTaskBriefId !== binding.briefId ||
    session.activeWorkItemId !== binding.workItemId || brief?.version !== binding.request.expectedBriefVersion || brief.confirmedByUser ||
    plan.steps.length !== 1 || !step || step.target.workItemId !== binding.workItemId || step.target.agentIds.length || step.effectScope.effects.length ||
    !['record_information', 'record_constraint', 'correct_route'].includes(step.action)) throw new ConflictException('INTENT_BRIEF_REVISION_PLAN_CONFLICT');
}

export function applyBriefRevisionAnswers(draft: PersistedState, session: SessionDetail, binding: IntentBriefRevisionBinding, sourceEventId: string) {
  const work = rows<WorkItem>(draft, 'workItemsBySession', session.id).find(row => row.id === binding.workItemId)!;
  for (const answer of binding.request.questionAnswers) {
    const old = effectiveDecisions(rows<DecisionRecord>(draft, 'decisionRecordsBySession', session.id), work)
      .find(row => row.question && briefQuestionKey(row.question) === briefQuestionKey(answer.question));
    appendDecisionInDraft(draft, { session, workItemId: work.id, sourceEventId, kind: 'requirement',
      content: `问题：${answer.question}\n回答：${answer.answer}`, question: answer.question, answer: answer.answer,
      ...(old ? { supersedesDecisionId: old.id, expectedDecisionRevision: old.revision } : {}) });
  }
}
