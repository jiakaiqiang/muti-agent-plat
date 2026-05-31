import { Injectable } from '@nestjs/common';
import type {
  AgentRunInput,
  AgentRunResult,
  FinalDeliveryOutput,
  AgentMessageOutput,
  PostReviewReportOutput,
  RuntimeOutput,
  TaskBriefOutput,
  TaskExecutionResultOutput,
  UserMessageHandlingPlanOutput
} from '@agent-cluster/shared';
import { mockRuntimeEnabled } from '../../common/runtime-config.js';
import { nowIso } from '../../common/time.js';

@Injectable()
export class MockRuntimeService {
  async run(input: AgentRunInput): Promise<AgentRunResult> {
    if (!mockRuntimeEnabled()) {
      return this.disabledResult(input);
    }

    await this.optionalDelay();
    if (input.options?.scenario === 'task_failed') {
      return {
        runId: input.runId,
        runtimeType: 'mock',
        status: 'failed',
        output: {
          kind: 'agent_message',
          messageKind: 'risk',
          content: `${input.agent.name} failed ${input.phase}.`
        } satisfies AgentMessageOutput,
        events: [
          {
            runId: input.runId,
            type: 'runtime_started',
            content: `${input.agent.name} started ${input.phase}`,
            createdAt: nowIso()
          },
          {
            runId: input.runId,
            type: 'runtime_failed',
            content: `${input.agent.name} failed ${input.phase}`,
            metadata: { code: 'MODEL_ERROR' },
            createdAt: nowIso()
          }
        ],
        artifacts: [],
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          model: 'mock'
        },
        error: {
          code: 'MODEL_ERROR',
          message: 'Mock runtime failure scenario: task_failed',
          retryable: true,
          details: {
            scenario: 'task_failed',
            phase: input.phase
          }
        }
      };
    }

    const output = this.outputFor(input);
    return {
      runId: input.runId,
      runtimeType: 'mock',
      status: 'completed',
      output,
      events: [
        {
          runId: input.runId,
          type: 'runtime_started',
          content: `${input.agent.name} started ${input.phase}`,
          createdAt: nowIso()
        },
        {
          runId: input.runId,
          type: 'runtime_completed',
          content: `${input.agent.name} completed ${input.phase}`,
          createdAt: nowIso()
        }
      ],
      artifacts: output.kind === 'final_delivery' ? [] : [],
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        model: 'mock'
      }
    };
  }

  private async optionalDelay() {
    const delayMs = Number(process.env.MOCK_RUNTIME_DELAY_MS ?? 0);
    if (!Number.isFinite(delayMs) || delayMs <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  private disabledResult(input: AgentRunInput): AgentRunResult {
    return {
      runId: input.runId,
      runtimeType: 'mock',
      status: 'failed',
      output: {
        kind: 'agent_message',
        messageKind: 'risk',
        content: `${input.agent.name} mock runtime is disabled.`
      } satisfies AgentMessageOutput,
      events: [
        {
          runId: input.runId,
          type: 'runtime_failed',
          content: `${input.agent.name} mock runtime is disabled`,
          metadata: { code: 'RUNTIME_DISABLED' },
          createdAt: nowIso()
        }
      ],
      artifacts: [],
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        model: 'mock'
      },
      error: {
        code: 'CAPABILITY_BLOCKED',
        message: 'Mock runtime is disabled. Set MOCK_RUNTIME_ENABLED=true to enable explicit local mock mode.',
        retryable: false
      }
    };
  }

  private outputFor(input: AgentRunInput): RuntimeOutput {
    switch (input.expectedOutput.kind) {
      case 'task_brief':
        return {
          kind: 'task_brief',
          goal: input.contextPack.sessionGoal,
          scope: ['基于 dry-run 验证多 Agent 协作闭环', '生成任务、执行事件、复盘和交付'],
          outOfScope: ['不真实修改文件', '不发送真实飞书消息'],
          constraints: ['保持执行非破坏性', '高风险操作必须等待用户确认'],
          acceptanceCriteria: ['生成任务契约', '用户确认后执行 dry-run', '复盘与契约一致'],
          risks: ['真实 Coding Runtime 尚未接入'],
          openQuestions: [],
          suggestedTasks: [
            {
              title: '执行 dry-run 实现任务',
              description: '模拟后端 Agent 执行已确认任务契约。',
              suggestedAgentKey: 'backend',
              acceptanceCriteria: ['生成 runtime_started 和 runtime_completed 事件']
            },
            {
              title: '验证 dry-run 结果',
              description: '模拟测试 Agent 验证任务结果。',
              suggestedAgentKey: 'test',
              acceptanceCriteria: ['生成测试结果摘要']
            }
          ]
        } satisfies TaskBriefOutput;
      case 'task_execution_result':
        return {
          kind: 'task_execution_result',
          status: 'completed',
          summary: 'dry-run 执行完成，未进行真实文件修改。',
          completedItems: ['模拟任务执行', '生成执行摘要'],
          changedArtifacts: [],
          nextSuggestedActions: ['进入复盘一致性检查'],
          risks: []
        } satisfies TaskExecutionResultOutput;
      case 'post_review_report':
        return {
          kind: 'post_review_report',
          isConsistentWithBrief: true,
          matchedItems: ['未真实修改文件', '执行过程可追溯', '生成最终交付'],
          mismatchedItems: [],
          missingItems: [],
          outOfScopeChanges: [],
          testResults: ['dry-run 验证通过'],
          recommendation: 'deliver'
        } satisfies PostReviewReportOutput;
      case 'final_delivery':
        return {
          kind: 'final_delivery',
          summary: 'v1 协作闭环 dry-run 已完成。',
          completedItems: ['任务契约确认', 'dry-run 执行', '复盘一致性检查'],
          incompleteItems: ['真实 Codex/Claude Code Runtime 后续 v2 接入'],
          risks: [],
          artifactRefs: []
        } satisfies FinalDeliveryOutput;
      case 'user_message_handling_plan':
        return {
          kind: 'user_message_handling_plan',
          intent: 'constraint',
          route: 'apply_to_agents',
          priority: 'high',
          shouldPause: true,
          needsUserInput: false,
          replyToUser: '已将用户新增约束同步给相关 Agent，将保持 dry-run 非破坏性执行。',
          targetAgentKeys: ['backend', 'test'],
          affectedTaskIds: input.taskId ? [input.taskId] : [],
          affectedAgentIds: [input.agent.id],
          requiresBriefRevision: false,
          requiresUserConfirmation: false,
          coordinatorInstruction: '将用户新增约束写入当前执行上下文，保持 dry-run 非破坏性。'
        } satisfies UserMessageHandlingPlanOutput;
      default:
        return {
          kind: 'agent_message',
          messageKind: 'discussion',
          content: `${input.agent.name} 已处理 ${input.phase}。`
        } satisfies AgentMessageOutput;
    }
  }
}
