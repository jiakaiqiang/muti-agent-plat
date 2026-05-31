import { Injectable } from '@nestjs/common';
import type { SessionStatus, UserMessageHandlingPlan, UserMessageIntent, UserMessageRoute } from '@agent-cluster/shared';

@Injectable()
export class UserMessageRouterService {
  /**
   * 基于正则的快速分类。它现在是 Coordinator triage（LLM 语义分诊）的*兜底*：仅当 triage 运行时
   * 调用失败时 sessions 才采用本计划。它也用于 triage 之前的命令快判（见 isQuickCommand），
   * 避免暂停/继续/取消这类纯控制指令也消耗一次 LLM 调用。
   */
  route(message: string, status: SessionStatus): UserMessageHandlingPlan {
    const intent = this.detectIntent(message);
    const isExecuting = ['EXECUTING', 'REWORKING', 'POST_REVIEW'].includes(status);
    const hasUnconfirmedBrief = ['AGENT_DISCUSSING', 'WAIT_USER_CONFIRM', 'REVISING_BRIEF'].includes(status);
    const isConstraint = intent === 'constraint' || /不要|不能|保持|禁止|non-destructive|dry-run/i.test(message);
    const route = this.routeForIntent(intent, isExecuting, hasUnconfirmedBrief);

    return {
      intent,
      route,
      priority: isConstraint || intent === 'correction' ? 'high' : 'normal',
      shouldPause: isExecuting && (intent === 'constraint' || intent === 'correction'),
      needsUserInput: false,
      targetAgentKeys: undefined,
      affectedTaskIds: [],
      affectedAgentIds: [],
      requiresBriefRevision: route === 'revise_brief',
      requiresUserConfirmation: false,
      coordinatorInstruction: isConstraint
        ? '将用户新增约束同步给相关 Agent，并检查是否影响已确认任务契约。'
        : '将用户消息交由 Coordinator 处理。'
    };
  }

  /** 纯控制指令（暂停/继续/取消等），由前端直接调用 control API，无需 LLM 分诊。 */
  isQuickCommand(message: string): boolean {
    return /暂停|继续|重试|取消|cancel|pause|resume|stop/i.test(message);
  }

  private routeForIntent(intent: UserMessageIntent, isExecuting: boolean, hasUnconfirmedBrief: boolean): UserMessageRoute {
    switch (intent) {
      case 'command':
        return 'command';
      case 'question':
        return 'answer';
      case 'correction':
        return isExecuting ? 'apply_to_agents' : 'new_task';
      case 'constraint':
        return 'apply_to_agents';
      case 'clarification':
        return hasUnconfirmedBrief ? 'revise_brief' : 'apply_to_agents';
      default:
        // knowledge_input / preference_input 由 sessions 单独存储，这里的 route 仅作占位。
        return 'apply_to_agents';
    }
  }

  private detectIntent(message: string): UserMessageIntent {
    if (/暂停|继续|重试|取消|cancel|pause|resume|stop/i.test(message)) {
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
