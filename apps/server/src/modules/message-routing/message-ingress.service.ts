import { BadRequestException, Injectable } from '@nestjs/common';
import type {
  IntentRoutingRolloutMode,
  SessionDetail,
  SessionFollowUpMessage,
  UserMessageHandlingPlan
} from '@agent-cluster/shared';
import { createMetadata } from '@agent-cluster/shared';
import { messages } from '../../common/messages.js';
import { nowIso } from '../../common/time.js';
import { workspaceMetrics } from '../../common/workspace-metrics.js';
import { ContextManagementService } from '../context-management/context-management.service.js';
import { EventsService } from '../events/events.service.js';
import { AgentsService } from '../agents/agents.service.js';

@Injectable()
export class MessageIngressService {
  constructor(
    private readonly context: ContextManagementService,
    private readonly events: EventsService,
    private readonly agents: AgentsService
  ) {}

  async commit(input: {
    session: SessionDetail;
    content: string;
    mentionedAgentIds: string[];
    handlingPlan: UserMessageHandlingPlan;
    routingMode: IntentRoutingRolloutMode;
    messageIdempotencyKey?: string;
    replyToEventId?: string;
    /** Create the durable long-term-memory confirmation card with the message. */
    preferenceConfirmation?: { confidence?: number };
    /** Confirmation that requires the next user message to become a fresh WorkItem. */
    budgetExhaustionConfirmationId?: string;
  }) {
    const mentionedAgentIds = [...new Set(input.mentionedAgentIds)].map((id) => {
      const agent = this.agents.getForSurface(id, 'mention');
      if (!input.session.participatingAgentIds.includes(agent.id)) {
        throw new BadRequestException({
          code: 'AGENT_NOT_SESSION_PARTICIPANT',
          message: `Agent is not a participant in this Session: ${agent.key}`
        });
      }
      return agent.id;
    });
    // A reply target is a user-stated routing fact, so it is resolved here rather
    // than left for the classifier to guess, and it may never cross Sessions.
    if (input.replyToEventId && !this.context.hasSessionEvent(input.session.id, input.replyToEventId)) {
      throw new BadRequestException({
        code: 'REPLY_TARGET_NOT_IN_SESSION',
        message: `Reply target does not belong to this Session: ${input.replyToEventId}`
      });
    }
    const event = this.events.createDraft({
      sessionId: input.session.id,
      type: 'user_message',
      userMessageIntent: input.handlingPlan.intent,
      priority: input.handlingPlan.priority,
      content: input.content,
      toAgentIds: mentionedAgentIds,
      sessionUserId: input.session.ownerId,
      metadata: {
        ...createMetadata('chat_message', {
          text: input.content,
          mentionedAgentIds,
          intentRoutingPending: true,
          ...(input.replyToEventId ? { replyToEventId: input.replyToEventId } : {})
        }),
        ...(input.messageIdempotencyKey ? { idempotencyKey: input.messageIdempotencyKey } : {})
      }
    });
    const followUp: SessionFollowUpMessage = {
      id: crypto.randomUUID(),
      sourceEventId: event.id,
      content: input.content,
      mentionedAgentIds,
      ...(input.replyToEventId ? { replyToEventId: input.replyToEventId } : {}),
      handlingPlan: input.handlingPlan,
      status: 'queued',
      queuedAt: nowIso()
    };
    const budgetRecoveryResolution = input.budgetExhaustionConfirmationId
      ? this.events.createDraft({
          sessionId: input.session.id,
          workItemId: input.session.activeWorkItemId,
          type: 'user_confirmation_resolved',
          content: '已收到拆分后的需求，将在新的任务上下文中处理。',
          metadata: createMetadata('system_notice', {
            confirmationId: input.budgetExhaustionConfirmationId,
            status: 'approved',
            selectedOptionKey: 'submit_narrowed_requirement',
            reason: 'work_item_budget_exhausted'
          })
        })
      : undefined;
    const preferenceConfirmation = input.preferenceConfirmation
      ? this.events.createDraft({
          sessionId: input.session.id,
          workItemId: input.session.activeWorkItemId,
          type: 'user_confirmation_requested',
          content: messages.confirmMemoryWrite,
          metadata: createMetadata('confirmation_card', {
            confirmationId: crypto.randomUUID(),
            reason: 'confirm_memory_write',
            title: messages.confirmMemoryWriteTitle,
            description: messages.confirmMemoryWriteDescription,
            candidate: {
              content: input.content,
              sourceEventId: event.id,
              scope: 'long_term_candidate',
              confidence: input.preferenceConfirmation.confidence ?? 0.72
            },
            options: [
              { key: 'approve', label: messages.saveMemory, style: 'primary' },
              { key: 'reject', label: messages.skipMemory, style: 'default' }
            ]
          })
        })
      : undefined;
    const additionalEvents = [
      ...(budgetRecoveryResolution ? [budgetRecoveryResolution] : []),
      ...(preferenceConfirmation ? [preferenceConfirmation] : [])
    ];
    const committed = await this.context.commitMessageIngress({
      session: input.session,
      event,
      followUp,
      rolloutMode: input.routingMode,
      routingIdempotencyKey: `${input.session.id}:${event.id}:intent-v2.1`,
      initialGoal: input.session.originalInput,
      forceNewRelatedWorkItem: Boolean(input.budgetExhaustionConfirmationId),
      ...(additionalEvents.length ? { additionalEvents } : {})
    });
    this.events.acceptCommitted(committed.event);
    if (!committed.idempotentReplay) {
      for (const additionalEvent of committed.additionalEvents ?? []) {
        this.events.acceptCommitted(additionalEvent);
      }
    }
    if (committed.idempotentReplay) workspaceMetrics.increment('routing_idempotency_replay_total');
    return committed;
  }
}
