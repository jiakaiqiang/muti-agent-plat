import { Injectable } from '@nestjs/common';
import type { SessionStatus, UserMessageHandlingPlan, UserMessageIntent } from '@agent-cluster/shared';

@Injectable()
export class UserMessageRouterService {
  route(message: string, status: SessionStatus): UserMessageHandlingPlan {
    const intent = this.detectIntent(message);
    const isExecuting = ['EXECUTING', 'REWORKING', 'POST_REVIEW'].includes(status);
    const isConstraint = intent === 'constraint' || /不要|不能|保持|禁止|non-destructive|dry-run/i.test(message);

    return {
      intent,
      priority: isConstraint ? 'high' : 'normal',
      shouldPause: isExecuting && (intent === 'constraint' || intent === 'correction'),
      affectedTaskIds: [],
      affectedAgentIds: [],
      requiresBriefRevision: !isExecuting && (intent === 'clarification' || intent === 'constraint'),
      requiresUserConfirmation: false,
      coordinatorInstruction: isConstraint
        ? '将用户新增约束同步给相关 Agent，并检查是否影响已确认任务契约。'
        : '将用户消息路由给 Coordinator 处理。'
    };
  }

  private detectIntent(message: string): UserMessageIntent {
    if (/暂停|继续|重试|cancel|pause|resume/i.test(message)) {
      return 'command';
    }
    if (/不要|不能|保持|禁止|must not|keep|non-destructive|dry-run/i.test(message)) {
      return 'constraint';
    }
    if (/不对|错了|重新|改成|correction/i.test(message)) {
      return 'correction';
    }
    if (/[?？]|为什么|如何|怎么/.test(message)) {
      return 'question';
    }
    if (/记住|以后|偏好/.test(message)) {
      return 'preference_input';
    }
    if (/文档|知识|RAG|资料/i.test(message)) {
      return 'knowledge_input';
    }
    return 'clarification';
  }
}
