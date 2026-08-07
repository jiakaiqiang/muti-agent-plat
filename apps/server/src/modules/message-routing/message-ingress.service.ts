import { Injectable } from '@nestjs/common';
import type {
  IntentRoutingRolloutMode,
  SessionDetail,
  SessionFollowUpMessage,
  UserMessageHandlingPlan
} from '@agent-cluster/shared';
import { createMetadata } from '@agent-cluster/shared';
import { nowIso } from '../../common/time.js';
import { workspaceMetrics } from '../../common/workspace-metrics.js';
import { ContextManagementService } from '../context-management/context-management.service.js';
import { EventsService } from '../events/events.service.js';

@Injectable()
export class MessageIngressService {
  constructor(
    private readonly context: ContextManagementService,
    private readonly events: EventsService
  ) {}

  async commit(input: {
    session: SessionDetail;
    content: string;
    mentionedAgentIds: string[];
    handlingPlan: UserMessageHandlingPlan;
    routingMode: IntentRoutingRolloutMode;
    messageIdempotencyKey?: string;
  }) {
    const mentionedAgentIds = [...new Set(input.mentionedAgentIds)];
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
          intentRoutingPending: true
        }),
        ...(input.messageIdempotencyKey ? { idempotencyKey: input.messageIdempotencyKey } : {})
      }
    });
    const followUp: SessionFollowUpMessage = {
      id: crypto.randomUUID(),
      sourceEventId: event.id,
      content: input.content,
      mentionedAgentIds,
      handlingPlan: input.handlingPlan,
      status: 'queued',
      queuedAt: nowIso()
    };
    const committed = await this.context.commitMessageIngress({
      session: input.session,
      event,
      followUp,
      rolloutMode: input.routingMode,
      routingIdempotencyKey: `${input.session.id}:${event.id}:intent-v2.1`,
      initialGoal: input.session.originalInput
    });
    this.events.acceptCommitted(committed.event);
    if (committed.idempotentReplay) workspaceMetrics.increment('routing_idempotency_replay_total');
    return committed;
  }
}
