import { Injectable } from '@nestjs/common';
import type {
  IntentContextSnapshot,
  SessionDetail,
  SessionFollowUpMessage,
  UserMessageHandlingPlan
} from '@agent-cluster/shared';
import { createMetadata } from '@agent-cluster/shared';
import { workspaceMetrics } from '../../common/workspace-metrics.js';
import { ContextManagementService } from '../context-management/context-management.service.js';
import { EventsService } from '../events/events.service.js';
import type { SemanticIntentRoutingOutcome } from '../intent-recognition/semantic-intent-router.service.js';

export type RouteApplicationResult = Awaited<ReturnType<ContextManagementService['applyIntentRoute']>> & {
  handlingPlan: UserMessageHandlingPlan;
};

@Injectable()
export class RouteApplicationService {
  constructor(
    private readonly context: ContextManagementService,
    private readonly events: EventsService
  ) {}

  async apply(input: {
    session: SessionDetail;
    snapshot: IntentContextSnapshot;
    followUp: SessionFollowUpMessage;
    outcome: SemanticIntentRoutingOutcome;
    additionalEvents?: import('@agent-cluster/shared').CollaborationEvent[];
  }): Promise<RouteApplicationResult> {
    const handlingPlan = toHandlingPlan(input.outcome);
    const applied = await this.context.applyIntentRoute({
      session: input.session,
      routingId: input.outcome.routing.id,
      snapshotId: input.snapshot.id,
      followUpId: input.followUp.id,
      decision: input.outcome.decision,
      validation: input.outcome.validation,
      handlingPlan,
      additionalEvents: input.additionalEvents,
      routeEventFactory: (route) => this.events.createDraft({
        sessionId: input.session.id,
        type: route.createdWorkItem ? 'work_item_created' : 'work_item_activated',
        content: route.createdWorkItem
          ? `已创建任务上下文：${route.workItem.title}`
          : `继续任务上下文：${route.workItem.title}`,
        metadata: createMetadata('system_notice', {
          routingId: route.routing.id,
          workItemId: route.workItem.id,
          previousWorkItemId: route.previousWorkItemId,
          deferredActivation: route.deferredActivation,
          inheritedDecisionIds: route.workItem.inheritedDecisionIds,
          inheritedArtifactIds: route.workItem.inheritedArtifactIds
        })
      })
    });
    for (const event of applied.committedEvents ?? []) this.events.acceptCommitted(event);
    if (applied.createdWorkItem) workspaceMetrics.increment('work_item_created_total', 1, {
      relation: input.outcome.decision.scopeRelation
    });
    if (applied.workItem.inheritedDecisionIds.length) {
      workspaceMetrics.increment('decision_inheritance_total', applied.workItem.inheritedDecisionIds.length, {
        relation: input.outcome.decision.scopeRelation
      });
    }
    return { ...applied, handlingPlan };
  }
}

function toHandlingPlan(outcome: SemanticIntentRoutingOutcome): UserMessageHandlingPlan {
  const decision = outcome.decision;
  return {
    intent: decision.dialogueAct,
    requirementRelation: decision.scopeRelation === 'same_requirement' ? 'continuation' : 'new_requirement',
    failedExecutionAction: decision.requestedAction === 'resume'
      ? 'resume'
      : decision.requestedAction === 'replan' ? 'replan' : 'none',
    priority: ['pause', 'cancel', 'resume'].includes(decision.requestedAction) ? 'high' : 'normal',
    shouldPause: decision.requestedAction === 'pause',
    affectedTaskIds: [],
    affectedAgentIds: [],
    requiresBriefRevision: decision.requestedAction === 'replan',
    requiresUserConfirmation: !outcome.autoApplicable,
    coordinatorInstruction: decision.goalSegments.join('\n') || decision.reasonCodes.join(', ')
  };
}
