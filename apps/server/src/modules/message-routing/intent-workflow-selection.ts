import { isDeepStrictEqual } from 'node:util';
import { ConflictException, BadRequestException } from '@nestjs/common';
import { isIntentWorkflowSelectionInput, type SessionDetail, type TaskBrief, type WorkItem, type DecisionRecord,
  type IntentRoutingRecord, type IntentRouteRevision, type IntentPlanStepRecord, type CollaborationEvent,
  type WorkflowDefinition, type WorkflowVersion } from '@agent-cluster/shared';
import type { PersistedState } from '../persistence/persistence.service.js';
import type { SessionLifecyclesBySession } from '../runtimes/session-lifecycle-store.js';
import { decisionSetHash, effectiveDecisions } from '../context-management/effective-decisions.js';

function rows<T>(draft: PersistedState, key: string, sessionId: string): T[] {
  return (draft[key] as Record<string, T[]> | undefined)?.[sessionId] ?? [];
}

export const intentWorkflowSelectionCollections = ['sessions', 'sessionLifecyclesBySession', 'briefsBySession', 'workItemsBySession',
  'decisionRecordsBySession', 'intentRoutingRecordsBySession', 'intentRouteRevisionsBySession', 'intentPlanStepsBySession', 'eventsBySession', 'workflowCatalog'];

/** Pure transaction precondition. The result does not authorize starting a workflow. */
export function bindIntentWorkflowSelection(draft: PersistedState, sessionId: string, actorId: string, value: unknown) {
  if (!isIntentWorkflowSelectionInput(value)) throw new BadRequestException('INTENT_WORKFLOW_SELECTION_INPUT_INVALID');
  const request = value;
  const session = (draft.sessions as SessionDetail[] | undefined)?.find(row => row.id === sessionId);
  const lifecycle = (draft.sessionLifecyclesBySession as SessionLifecyclesBySession | undefined)?.[sessionId];
  if (!session || session.ownerId !== actorId || session.archivedAt || session.intentContractVersion !== 'intent-understanding-v1' ||
    session.dataEpoch !== request.dataEpoch || session.status !== 'WAIT_WORKFLOW_SELECT' || session.pendingBriefRevisionRoutingId ||
    !lifecycle || lifecycle.state !== 'active' || lifecycle.admission !== 'open' || !['idle', 'confirmed'].includes(lifecycle.stopStatus) ||
    lifecycle.dataEpoch !== session.dataEpoch || lifecycle.generation !== request.expectedSessionGeneration) throw new ConflictException('INTENT_WORKFLOW_SESSION_STALE');
  const brief = rows<TaskBrief>(draft, 'briefsBySession', sessionId).find(row => row.id === request.briefId);
  const receipt = brief?.intentConfirmationReceipt, binding = brief?.intentBinding;
  const work = rows<WorkItem>(draft, 'workItemsBySession', sessionId).find(row => row.id === brief?.workItemId);
  const route = rows<IntentRoutingRecord>(draft, 'intentRoutingRecordsBySession', sessionId).find(row => row.id === binding?.routingId);
  const revision = rows<IntentRouteRevision>(draft, 'intentRouteRevisionsBySession', sessionId).find(row => row.routingId === route?.id && row.intentRevision === binding?.intentRevision);
  const step = rows<IntentPlanStepRecord>(draft, 'intentPlanStepsBySession', sessionId).find(row => row.id === binding?.stepId);
  if (!brief?.confirmedByUser || !receipt || !binding || !work || !route || !revision || !step ||
    session.currentTaskBriefId !== brief.id || session.activeWorkItemId !== work.id || brief.version !== request.expectedBriefVersion ||
    binding.intentRevision !== request.expectedIntentRevision || route.effectiveIntentRevision !== binding.intentRevision ||
    route.dispatchHold || work.dispatchHold || route.status !== 'ROUTED' || receipt.actorId !== actorId ||
    receipt.request.dataEpoch !== request.dataEpoch || receipt.request.expectedBriefVersion !== brief.version ||
    receipt.request.expectedIntentRevision !== binding.intentRevision || step.routingId !== route.id || step.intentRevision !== binding.intentRevision ||
    step.dataEpoch !== request.dataEpoch || step.step.target.workItemId !== work.id ||
    receipt.requirementRevision !== request.expectedRequirementRevision || (work.requirementRevision ?? 1) !== request.expectedRequirementRevision ||
    (work.executionEpoch ?? 1) !== request.expectedExecutionEpoch || step.status !== 'completed' || step.resultBriefId !== brief.id ||
    revision.authorizationState !== 'validated' || revision.dataEpoch !== request.dataEpoch ||
    !revision.validatedPlan?.steps.some(row => isDeepStrictEqual(row, step.step))) throw new ConflictException('INTENT_WORKFLOW_BRIEF_STALE');
  const events = rows<CollaborationEvent>(draft, 'eventsBySession', sessionId);
  if (!events.some(row => row.id === receipt.sourceEventId && row.type === 'user_confirmation_resolved' &&
    row.actor?.id === actorId && row.metadata.payload?.relatedBriefId === brief.id && row.metadata.payload?.status === 'approved')) throw new ConflictException('INTENT_WORKFLOW_CONFIRMATION_MISSING');
  const card = events.find(row => row.type === 'user_confirmation_requested' && row.metadata.payload?.confirmationId === request.confirmationId)?.metadata.payload;
  if (!card || card.reason !== 'select_workflow' || card.relatedBriefId !== brief.id || card.briefVersion !== brief.version ||
    card.intentRevision !== binding.intentRevision || card.requirementRevision !== request.expectedRequirementRevision ||
    card.dataEpoch !== request.dataEpoch || card.executionEpoch !== request.expectedExecutionEpoch || card.sessionGeneration !== request.expectedSessionGeneration ||
    events.some(row => row.type === 'user_confirmation_resolved' && row.metadata.payload?.confirmationId === request.confirmationId)) throw new ConflictException('INTENT_WORKFLOW_CARD_STALE');
  const catalog = draft.workflowCatalog as { workflows: WorkflowDefinition[]; versionsByWorkflowId: Record<string, WorkflowVersion[]> } | undefined;
  const definition = catalog?.workflows.find(row => row.id === request.workflowId);
  const workflow = catalog?.versionsByWorkflowId[request.workflowId]?.find(row => row.version === request.workflowVersion);
  if (!definition || definition.status !== 'published' || definition.archivedAt || !workflow || workflow.definitionHash !== request.definitionHash || !workflow.nodes.length) throw new ConflictException('INTENT_WORKFLOW_DEFINITION_STALE');
  return { request: structuredClone(request), workItemId: work.id, routingId: route.id, confirmedByReceiptId: receipt.id,
    workflow: structuredClone(workflow), decisionSetHash: decisionSetHash(effectiveDecisions(rows<DecisionRecord>(draft, 'decisionRecordsBySession', sessionId), work)),
    // Selection alone grants nothing. Node compilation must resolve effects separately.
    executionAuthorized: false as const };
}
