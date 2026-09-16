import { Injectable } from '@nestjs/common';
import type { PendingConfirmationContext, SessionStatus } from '@agent-cluster/shared';
import type { ExactCommandMatch } from '../intent-recognition/deterministic-command-guard.service.js';

export type ExactCommandResolution = {
  action: 'resume_session' | 'retry_current' | 'pause_session' | 'cancel_session' | 'acknowledge' | 'clarify';
  message: string;
  confirmationId?: string;
};

const ACTIVE_STATUSES = new Set<SessionStatus>([
  'AGENT_DISCUSSING',
  'REVISING_BRIEF',
  'EXECUTING',
  'POST_REVIEW',
  'REWORKING'
]);

const PAUSABLE_STATUSES = new Set<SessionStatus>(ACTIVE_STATUSES);
const CANCELLABLE_STATUSES = new Set<SessionStatus>([
  ...ACTIVE_STATUSES,
  'WAIT_USER_CONFIRM',
  'WAIT_WORKFLOW_SELECT',
  'WAIT_WORKFLOW_STEP_CONFIRM',
  'WAIT_USER_DECISION',
  'PAUSED'
]);

const CHAT_RESUMABLE_CONFIRMATIONS = new Set([
  'coordinator_routing_needs_user_decision',
  'resolve_contract_conflict',
  'reconnect_local_runtime',
  'recover_interrupted_execution',
  'retry_failed_execution'
]);

export function resolveExactCommand(input: {
  command: ExactCommandMatch;
  sessionStatus: SessionStatus;
  pendingConfirmation?: PendingConfirmationContext;
  hasFailedWorkflowRun?: boolean;
}): ExactCommandResolution {
  const { command, sessionStatus, pendingConfirmation, hasFailedWorkflowRun } = input;
  if (command.command === 'resume' || command.command === 'retry') {
    const canResolvePending =
      sessionStatus === 'WAIT_USER_DECISION' &&
      pendingConfirmation &&
      !pendingConfirmation.requiresStructuredAction &&
      CHAT_RESUMABLE_CONFIRMATIONS.has(pendingConfirmation.reason) &&
      pendingConfirmation.options.some((option) => option.key === 'resume');
    if (canResolvePending) {
      return {
        action: 'resume_session',
        message: '已收到继续指令，正在恢复当前任务。',
        confirmationId: pendingConfirmation.confirmationId
      };
    }
    if (sessionStatus === 'PAUSED') {
      return { action: 'resume_session', message: '已收到继续指令，正在恢复当前任务。' };
    }
    if (sessionStatus === 'FAILED' || sessionStatus === 'INTERRUPTED') {
      return {
        action: 'retry_current',
        message: '已收到继续指令，正在重试当前任务。',
        confirmationId: pendingConfirmation?.confirmationId
      };
    }
    if (sessionStatus === 'WAIT_USER_DECISION' && hasFailedWorkflowRun) {
      return {
        action: 'retry_current',
        message: '已收到继续指令，正在重试失败的工作流阶段。',
        confirmationId: pendingConfirmation?.confirmationId
      };
    }
    if (ACTIVE_STATUSES.has(sessionStatus)) {
      return { action: 'acknowledge', message: '当前任务已在执行，无需重复恢复。' };
    }
    if (sessionStatus === 'COMPLETED') {
      return { action: 'clarify', message: '当前任务已完成，请说明需要继续处理的具体内容。' };
    }
    return { action: 'clarify', message: '当前没有可直接继续的操作，请处理待确认事项或说明具体需求。' };
  }

  if (command.command === 'pause') {
    if (sessionStatus === 'PAUSED') {
      return { action: 'acknowledge', message: '当前会话已经暂停。' };
    }
    return PAUSABLE_STATUSES.has(sessionStatus)
      ? { action: 'pause_session', message: '已收到暂停指令，正在停止当前执行。' }
      : { action: 'clarify', message: '当前状态没有可暂停的执行。' };
  }

  if (command.command === 'cancel') {
    if (sessionStatus === 'CANCELLED') {
      return { action: 'acknowledge', message: '当前会话已经取消。' };
    }
    return CANCELLABLE_STATUSES.has(sessionStatus)
      ? { action: 'cancel_session', message: '已收到取消指令，正在取消当前会话。' }
      : { action: 'clarify', message: '当前状态不能执行取消操作。' };
  }

  return {
    action: 'clarify',
    message: '请在对应确认卡中选择具体操作；高风险确认不能通过通用聊天命令批准。'
  };
}

@Injectable()
export class CommandStateResolverService {
  resolve(input: Parameters<typeof resolveExactCommand>[0]) {
    return resolveExactCommand(input);
  }
}
