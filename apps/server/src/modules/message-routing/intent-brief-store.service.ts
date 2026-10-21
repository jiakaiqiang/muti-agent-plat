import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Injectable } from '@nestjs/common';
import { briefQuestionKey, validateRuntimeOutput, type CollaborationEvent, type DecisionRecord, type IntentPlanStepRecord, type IntentRoutingRecord,
  type IntentRouteRevision, type SessionDetail, type SuggestedAgentTask, type TaskBrief, type ValidatedRoutePlan, type WorkItem } from '@agent-cluster/shared';
import { PersistenceService, type PersistedState } from '../persistence/persistence.service.js';
import type { SessionLifecyclesBySession } from '../runtimes/session-lifecycle-store.js';
import { effectiveConstraintContents, effectiveDecisions } from '../context-management/effective-decisions.js';
import { assertIntentExecutionCurrent, INTENT_EXECUTION_COLLECTIONS } from './intent-execution-guard.js';
import { correctionRows as rows, appendCorrectionEvent as appendEvent } from './intent-correction-state.js';

/** Called within plan commit, after its newly created WorkItem has been bound. */
export function deriveIntentBriefStep(plan: ValidatedRoutePlan) {
  const parent = plan.steps[0];
  if (plan.outcome !== 'applicable' || plan.steps.length !== 1 || !parent ||
    !['create_initial_work_item', 'create_related_work_item', 'create_independent_work_item'].includes(parent.action) ||
    !parent.target.workItemId || parent.target.agentIds.length || parent.effectScope.effects.length || parent.correction) {
    throw new Error('INTENT_BRIEF_DERIVATION_INVALID');
  }
  const stepId = randomUUID();
  return { ...structuredClone(parent), stepId, action: 'prepare_brief' as const, derivedFromStepId: parent.stepId,
    segmentKey: `${parent.segmentKey}:brief`, dependencies: [], idempotencyKey: `${parent.idempotencyKey}:brief:${stepId}` };
}

export type IntentBriefReference = { sessionId: string; stepId: string; ownerId: string; invocationId: string };
export function deriveCorrectedBriefStep(plan: ValidatedRoutePlan, brief: TaskBrief, work: WorkItem) {
  const parent = plan.steps[0];
  if (plan.outcome !== 'applicable' || plan.steps.length !== 1 || !parent ||
    !['correct_route', 'record_constraint', 'record_information'].includes(parent.action) || parent.effectScope.effects.length ||
    parent.target.agentIds.length || parent.target.workItemId !== work.id || brief.workItemId !== work.id || !brief.intentBinding) {
    throw new Error('INTENT_BRIEF_REVISION_DERIVATION_INVALID');
  }
  const stepId = randomUUID();
  return { ...structuredClone(parent), stepId, action: 'prepare_brief' as const, derivedFromStepId: parent.stepId,
    replacesBrief: { briefId: brief.id, version: brief.version }, goal: work.goal, correction: null,
    segmentKey: `${parent.segmentKey}:brief`, dependencies: [], idempotencyKey: `${parent.idempotencyKey}:brief:${stepId}` };
}
const collections = ['sessions', 'sessionLifecyclesBySession', 'briefsBySession', 'suggestedTasksByBriefId',
  'eventsBySession', 'eventOutbox', ...INTENT_EXECUTION_COLLECTIONS];

/** Durable draft publication only: no tasks, files, artifacts, model calls or business dispatch. */
@Injectable()
export class IntentBriefStoreService {
  constructor(private readonly persistence: PersistenceService) {}

  async saveResult(reference: IntentBriefReference, agentId: string, output: unknown) {
    const parsed = validateRuntimeOutput('task_brief', output);
    if (!parsed.valid || !agentId || Buffer.byteLength(JSON.stringify(output), 'utf8') > 100_000 ||
      parsed.value.suggestedTasks.length > 50) throw new Error('INTENT_BRIEF_OUTPUT_INVALID');
    return this.persistence.mutateCollections(collections, draft => {
      const { step } = current(draft, reference);
      const result = { output: structuredClone(parsed.value), agentId, invocationId: reference.invocationId };
      if (step.processing!.briefResult && !isDeepStrictEqual(step.processing!.briefResult, result)) throw new Error('INTENT_BRIEF_RESULT_CONFLICT');
      step.processing!.briefResult = result;
    }, { sessionIds: [reference.sessionId] });
  }

  async publish(reference: IntentBriefReference): Promise<{ brief: TaskBrief; events: CollaborationEvent[]; idempotentReplay: boolean }> {
    return this.persistence.mutateCollections(collections, draft => {
      const existing = rows<IntentPlanStepRecord>(draft, 'intentPlanStepsBySession', reference.sessionId).find(row => row.id === reference.stepId);
      if (existing?.status === 'completed' && existing.resultBriefId && existing.processing?.ownerId === reference.ownerId &&
        existing.processing.briefResult?.invocationId === reference.invocationId) {
        const brief = rows<TaskBrief>(draft, 'briefsBySession', reference.sessionId).find(row => row.id === existing.resultBriefId);
        if (!brief || brief.intentBinding?.stepId !== reference.stepId) throw new Error('INTENT_BRIEF_RECEIPT_MISSING');
        return { brief: structuredClone(brief), events: [], idempotentReplay: true };
      }
      const { session, step, route, work } = current(draft, reference), saved = step.processing!.briefResult;
      if (!saved || saved.invocationId !== reference.invocationId) throw new Error('INTENT_BRIEF_RESULT_MISSING');
      if (session.currentTaskBriefId && !step.step.replacesBrief) throw new Error('INTENT_BRIEF_ALREADY_CURRENT');
      const now = new Date().toISOString(), output = saved.output;
      const confirmed = effectiveConstraintContents(rows<DecisionRecord>(draft, 'decisionRecordsBySession', session.id), work);
      const answered = new Set(effectiveDecisions(rows<DecisionRecord>(draft, 'decisionRecordsBySession', session.id), work)
        .filter(row => row.question && row.answer).map(row => briefQuestionKey(row.question!)));
      // Generated constraints cannot overwrite or revive the confirmed decision ledger.
      const unresolved = output.constraints.filter(content => !confirmed.includes(content)).map(content => `待确认约束：${content}`);
      const briefs = rows<TaskBrief>(draft, 'briefsBySession', session.id);
      const brief: TaskBrief = { id: `intent-brief:${step.id}`, sessionId: session.id, workItemId: work.id,
        version: Math.max(0, ...briefs.map(row => row.version)) + 1, goal: output.goal, scope: [...output.scope], outOfScope: [...output.outOfScope],
        constraints: [...new Set(confirmed)], acceptanceCriteria: [...output.acceptanceCriteria], risks: [...output.risks],
        openQuestions: [...new Set([...output.openQuestions.filter(question => !answered.has(briefQuestionKey(question))), ...unresolved])], confirmedByUser: false, createdAt: now,
        ...(step.step.replacesBrief ? { supersedesBriefId: step.step.replacesBrief.briefId } : {}),
        intentBinding: { routingId: route.id, intentRevision: step.intentRevision, stepId: step.id, invocationId: reference.invocationId } };
      if (briefs.some(row => row.id === brief.id)) throw new Error('INTENT_BRIEF_ID_CONFLICT');
      briefs.push(brief);
      const suggestions = (draft.suggestedTasksByBriefId ??= {}) as Record<string, SuggestedAgentTask[]>;
      if (Object.hasOwn(suggestions, brief.id)) throw new Error('INTENT_BRIEF_ID_CONFLICT');
      suggestions[brief.id] = output.suggestedTasks.map(task => ({ ...structuredClone(task), requiresUserConfirmation: true }));
      const payload = { briefId: brief.id, workItemId: work.id, routingId: route.id, intentRevision: step.intentRevision,
        stepId: step.id, invocationId: reference.invocationId, replyToEventId: route.semanticPlan!.sourceEventId };
      const events: CollaborationEvent[] = [
        { id: `intent-brief-created:${step.id}`, sessionId: session.id, workItemId: work.id, type: 'brief_created',
          fromAgentId: saved.agentId, toAgentIds: [], content: '已生成待确认的任务草稿，尚未执行建议任务。', createdAt: now,
          metadata: { schemaVersion: '0.1', renderAs: 'brief_card', payload: { ...payload, ...brief } } },
        { id: `intent-brief-confirmation:${step.id}`, sessionId: session.id, workItemId: work.id, type: 'user_confirmation_requested',
          fromAgentId: saved.agentId, toAgentIds: [], content: '请核对任务草稿；确认草稿不代表授予其他执行权限。', createdAt: now,
          metadata: { schemaVersion: '0.1', renderAs: 'confirmation_card', payload: { ...payload, confirmationId: `intent-brief-confirm:${step.id}`,
            reason: 'confirm_task_brief', relatedBriefId: brief.id, title: '确认任务草稿', options: [{ key: 'approve', label: '确认草稿' }, { key: 'revise', label: '需要修订' }] } } }
      ];
      if (step.step.replacesBrief) {
        const previousCard = rows<CollaborationEvent>(draft, 'eventsBySession', session.id).find(item => item.type === 'user_confirmation_requested' &&
          item.metadata.payload?.relatedBriefId === step.step.replacesBrief!.briefId);
        const confirmationId = previousCard?.metadata.payload?.confirmationId;
        if (confirmationId && !rows<CollaborationEvent>(draft, 'eventsBySession', session.id).some(item =>
          item.type === 'user_confirmation_resolved' && item.metadata.payload?.confirmationId === confirmationId)) {
          events.unshift({ id: `intent-brief-superseded:${step.step.replacesBrief.briefId}`, sessionId: session.id, workItemId: work.id,
            type: 'user_confirmation_resolved', toAgentIds: [], createdAt: now, content: '修订后的任务草稿已生成，请核对新版本。',
            metadata: { schemaVersion: '0.1', renderAs: 'system_notice', payload: { confirmationId,
              relatedBriefId: step.step.replacesBrief.briefId, status: 'rejected', selectedOptionKey: 'revise' } } });
        }
      }
      for (const event of events) appendEvent(draft, event);
      if (step.step.replacesBrief && session.pendingBriefRevisionRoutingId) {
        const pending = rows<IntentRoutingRecord>(draft, 'intentRoutingRecordsBySession', session.id).find(item => item.id === session.pendingBriefRevisionRoutingId);
        if (pending?.briefRevision?.briefId === step.step.replacesBrief.briefId) delete session.pendingBriefRevisionRoutingId;
      }
      session.currentTaskBriefId = brief.id; session.latestContractGoal = brief.goal; session.status = 'WAIT_USER_CONFIRM';
      session.revision = (session.revision ?? 1) + 1; session.updatedAt = now;
      work.status = 'WAITING_USER'; work.revision += 1; work.updatedAt = now;
      step.status = 'completed'; step.resultBriefId = brief.id; step.updatedAt = now;
      route.actionStatus = 'applied'; route.routingRevision = (route.routingRevision ?? 1) + 1; route.updatedAt = now;
      return { brief: structuredClone(brief), events, idempotentReplay: false };
    }, { sessionIds: [reference.sessionId] });
  }
}

export function assertCurrentIntentBrief(draft: PersistedState, reference: IntentBriefReference, review = false) {
  const session = (draft.sessions as SessionDetail[] | undefined)?.find(row => row.id === reference.sessionId);
  const step = rows<IntentPlanStepRecord>(draft, 'intentPlanStepsBySession', reference.sessionId).find(row => row.id === reference.stepId);
  const route = rows<IntentRoutingRecord>(draft, 'intentRoutingRecordsBySession', reference.sessionId).find(row => row.id === step?.routingId);
  const work = rows<WorkItem>(draft, 'workItemsBySession', reference.sessionId).find(row => row.id === step?.step.target.workItemId);
  const lifecycle = (draft.sessionLifecyclesBySession as SessionLifecyclesBySession | undefined)?.[reference.sessionId];
  const predecessor = rows<IntentPlanStepRecord>(draft, 'intentPlanStepsBySession', reference.sessionId).find(row => row.id === step?.step.derivedFromStepId);
  if (!session || session.intentContractVersion !== 'intent-understanding-v1' || !['DRAFT_INPUT', 'AGENT_DISCUSSING', 'REVISING_BRIEF'].includes(session.status) ||
    session.archivedAt || !work || session.activeWorkItemId !== work.id || !route || route.status !== 'ROUTED' || route.dispatchHold ||
    !step || step.dataEpoch !== session.dataEpoch || step.step.action !== (review ? 'review_brief' : 'prepare_brief') || step.status !== 'running' ||
    step.step.effectScope.effects.length || step.step.target.agentIds.length !== (review ? 1 : 0) || !step.processing ||
    step.processing.ownerId !== reference.ownerId || step.processing.invocationId !== reference.invocationId ||
    Date.parse(step.processing.leaseExpiresAt) <= Date.now() || Date.parse(step.processing.deadlineAt) <= Date.now() ||
    !lifecycle || lifecycle.admission !== 'open' || !['idle', 'confirmed'].includes(lifecycle.stopStatus) ||
    !predecessor || predecessor.status !== 'completed' || predecessor.routingId !== route.id || predecessor.intentRevision !== step.intentRevision ||
    predecessor.step.target.workItemId !== work.id || !(step.step.replacesBrief
      ? ['correct_route', 'record_constraint', 'record_information'] : ['create_initial_work_item', 'create_related_work_item', 'create_independent_work_item']).includes(predecessor.step.action)) {
    throw new Error('INTENT_BRIEF_STEP_STALE');
  }
  if (step.step.replacesBrief) {
    const previous = rows<TaskBrief>(draft, 'briefsBySession', session.id).find(row => row.id === step.step.replacesBrief!.briefId);
    if (!previous?.intentBinding || previous.version !== step.step.replacesBrief.version || previous.workItemId !== work.id ||
      session.currentTaskBriefId !== previous.id) throw new Error('INTENT_BRIEF_REVISION_TARGET_STALE');
  }
  const version = rows<IntentRouteRevision>(draft, 'intentRouteRevisionsBySession', session.id)
    .find(row => row.routingId === route.id && row.intentRevision === step.intentRevision);
  if (!version?.validatedPlan?.steps.some(item => isDeepStrictEqual(item, step.step)) ||
    !version.validatedPlan.steps.some(item => isDeepStrictEqual(item, predecessor.step))) throw new Error('INTENT_BRIEF_PLAN_MISMATCH');
  assertIntentExecutionCurrent(draft, { sessionId: session.id, dataEpoch: session.dataEpoch, workItemId: work.id,
    admissionClass: 'business', intentStepId: step.id, executionBinding: step.step.executionBinding, effectScope: step.step.effectScope });
  return { session, step, route, work };
}

const current = assertCurrentIntentBrief;
