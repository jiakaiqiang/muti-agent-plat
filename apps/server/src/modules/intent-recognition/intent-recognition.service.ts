import { Injectable } from '@nestjs/common';
import type {
  SessionStatus,
  TaskDomain,
  TaskIntent,
  UserMessageHandlingPlan,
  UserMessageIntent,
  WorkspaceSnapshot
} from '@agent-cluster/shared';
import { matchExactUserCommand } from './deterministic-command-guard.service.js';

export type TaskIntentClassification = {
  domain: TaskDomain;
  intent: TaskIntent;
  requiresCodeChanges: boolean;
};

@Injectable()
export class IntentRecognitionService {
  recognizeTask(input: string, workspaceSnapshot?: WorkspaceSnapshot): TaskIntentClassification {
    const intent = this.detectTaskIntent(input);
    return {
      domain: this.detectTaskDomain(input, workspaceSnapshot),
      intent,
      requiresCodeChanges: this.requiresCodeChanges(input, intent)
    };
  }

  recognizeUserMessage(message: string, status: SessionStatus): UserMessageHandlingPlan {
    const intent = this.detectUserMessageIntent(message);
    const isExecuting = ['EXECUTING', 'REWORKING', 'POST_REVIEW'].includes(status);
    const isConstraint = intent === 'constraint' || this.constraintPattern().test(message);
    const requirementRelation = this.detectRequirementRelation(message);
    const failedExecutionAction = status === 'FAILED' && requirementRelation === 'continuation'
      ? this.shouldReplanFailedExecution(message) ? 'replan' : 'resume'
      : 'none';

    return {
      intent,
      requirementRelation,
      failedExecutionAction,
      priority: isConstraint ? 'high' : 'normal',
      shouldPause: isExecuting && (isConstraint || intent === 'correction'),
      affectedTaskIds: [],
      affectedAgentIds: [],
      requiresBriefRevision: !isExecuting && (intent === 'clarification' || isConstraint),
      requiresUserConfirmation: false,
      coordinatorInstruction: isConstraint
        ? '将用户新增约束同步给相关 Agent，并检查是否影响已确认任务契约。'
        : '将用户消息路由给 Coordinator 处理。'
    };
  }

  private detectTaskDomain(input: string, workspaceSnapshot?: WorkspaceSnapshot): TaskDomain {
    const hasWorkspaceCode = Boolean(
      workspaceSnapshot?.files.some((file) => /\.(ts|tsx|js|jsx|vue|py|java|go|rs|css|scss|sql)$/i.test(file.path))
    );
    const hasCodeSignals =
      hasWorkspaceCode ||
      /(代码|编码|实现|修复|测试|build|bug|接口|前端|后端|组件|workflow|graph|session|agent|runtime|adapter|model|llm|mcp|codex|claude|repo|项目|工程|开发)/i.test(
        input
      );
    const hasNonCodingSignals =
      /(需求|方案|分析|调研|汇报|计划|prd|文档|总结|review|验证|竞品|研究|流程|制度|规范)/i.test(input);
    if (hasCodeSignals && hasNonCodingSignals) return 'mixed';
    if (hasCodeSignals) return 'coding';
    return 'non_coding';
  }

  private detectTaskIntent(input: string): TaskIntent {
    if (/(交付|发布说明|最终说明|delivery|deliver)/i.test(input)) return 'delivery';
    if (/(验证|验收|测试|check|smoke|build|typecheck)/i.test(input)) return 'validation';
    if (/(review|复盘|审查|评审)/i.test(input)) return 'review';
    if (/(排查|诊断|定位|故障|报错|失败|troubleshoot|debug)/i.test(input)) return 'troubleshooting';
    if (/(计划|规划|拆解|roadmap|milestone)/i.test(input)) return 'planning';
    if (/(分析|调研|理解|查看|介绍|熟悉|研究|总结|架构|梳理)/i.test(input)) return 'analysis';
    if (/(只问|询问|问题|为什么|如何|怎么|\?|？|咨询|说明|问答)/i.test(input)) return 'inquiry';
    if (/(qa)/i.test(input)) return 'qa';
    return 'implementation';
  }

  private requiresCodeChanges(input: string, intent: TaskIntent) {
    if (intent === 'implementation') return true;
    return /(修复|改动|修改|重构|实现|编码|写代码|fix|implement|refactor|code change)/i.test(input);
  }

  private detectUserMessageIntent(message: string): UserMessageIntent {
    if (matchExactUserCommand(message)) {
      return 'command';
    }
    if (this.constraintPattern().test(message)) {
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

  private detectRequirementRelation(message: string): UserMessageHandlingPlan['requirementRelation'] {
    if (/(新需求|新任务|另外(?:一个|一项)?|无关(?:需求|任务)?|separate task|new requirement|new task|unrelated)/i.test(message)) {
      return 'new_requirement';
    }
    return 'continuation';
  }

  private shouldReplanFailedExecution(message: string) {
    return /(重新讨论|重新规划|换个方案|调整方案|replan|new approach|different approach)/i.test(message);
  }

  private constraintPattern() {
    return /不要|不能|保持|禁止|必须|补充|需求|约束|must not|keep|non-destructive|dry-run|supplemental|requirement|constraint/i;
  }
}
