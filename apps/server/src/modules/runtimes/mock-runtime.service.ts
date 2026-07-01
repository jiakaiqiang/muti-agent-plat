import { Injectable } from '@nestjs/common';
import type {
  AgentRunInput,
  AgentRunResult,
  AgentRuntimeAdapter,
  FinalDeliveryOutput,
  AgentMessageOutput,
  PostReviewReportOutput,
  RuntimeUsage,
  RuntimeOutput,
  RuntimeContextRequest,
  TaskAcceptanceDecisionOutput,
  TaskClaimDecisionOutput,
  TaskBriefOutput,
  TaskExecutionResultOutput,
  UserMessageHandlingPlanOutput,
  RuntimeArtifactOutput,
  RuntimeFileChange,
  TaskEvidenceRef,
  ValidationEvidenceReport,
  ValidationEvidenceVerdict
} from '@agent-cluster/shared';
import { mockRuntimeEnabled } from '../../common/runtime-config.js';
import { nowIso } from '../../common/time.js';
import { estimateTokens } from '../../common/token.js';

@Injectable()
export class MockRuntimeService implements AgentRuntimeAdapter {
  readonly type = 'mock' as const;
  /** Session-level CONTEXT_INSUFFICIENT failure counter for MOCK_CONTEXT_INSUFFICIENT_TIMES. */
  private readonly contextInsufficientCounts = new Map<string, number>();

  async run(input: AgentRunInput, signal?: AbortSignal): Promise<AgentRunResult> {
    if (!mockRuntimeEnabled() && input.options?.allowMockFallback !== true) {
      return this.disabledResult(input);
    }

    if (signal?.aborted) {
      return this.cancelledResult(input);
    }

    const delayed = await this.optionalDelay(signal);
    if (!delayed) {
      return this.cancelledResult(input);
    }

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
          ...this.usageFor(input),
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

    const isTaskExecution = input.expectedOutput.kind === 'task_execution_result';
    const wantsContextInsufficient =
      input.options?.scenario === 'context_insufficient' ||
      (isTaskExecution &&
        (process.env.MOCK_CONTEXT_INSUFFICIENT === 'true' ||
          this.shouldRequestContextOnce(input) ||
          this.shouldRequestContextTimes(input)));
    if (wantsContextInsufficient) {
      return this.contextInsufficientResult(input);
    }

    const output = this.applyReviewRecommendationOverride(this.outputFor(input));
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
        ...this.usageFor(input, output),
        model: 'mock'
      }
    };
  }

  /** Test hook: MOCK_REVIEW_RECOMMENDATION=rework|ask_user forces the mock post-review verdict. */
  private applyReviewRecommendationOverride(output: RuntimeOutput): RuntimeOutput {
    const override = process.env.MOCK_REVIEW_RECOMMENDATION?.trim();
    if (!override || output.kind !== 'post_review_report') {
      return output;
    }
    if (override !== 'rework' && override !== 'ask_user') {
      return output;
    }
    return {
      ...output,
      isConsistentWithBrief: false,
      mismatchedItems: output.mismatchedItems.length ? output.mismatchedItems : ['模拟复盘发现执行结果与契约不一致。'],
      recommendation: override
    };
  }

  private async optionalDelay(signal?: AbortSignal) {    const delayMs = Number(process.env.MOCK_RUNTIME_DELAY_MS ?? 0);
    if (!Number.isFinite(delayMs) || delayMs <= 0) return true;
    return new Promise<boolean>((resolve) => {
      if (signal?.aborted) {
        resolve(false);
        return;
      }
      const timer = setTimeout(() => resolve(true), delayMs);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve(false);
        },
        { once: true }
      );
    });
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

  private cancelledResult(input: AgentRunInput): AgentRunResult {
    return {
      runId: input.runId,
      runtimeType: 'mock',
      status: 'failed',
      output: {
        kind: 'agent_message',
        messageKind: 'risk',
        content: `${input.agent.name} mock runtime was cancelled.`
      } satisfies AgentMessageOutput,
      events: [
        {
          runId: input.runId,
          type: 'runtime_failed',
          content: `${input.agent.name} mock runtime was cancelled`,
          metadata: { code: 'RUNTIME_CANCELLED' },
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
        code: 'RUNTIME_CANCELLED',
        message: 'Runtime request cancelled by user.',
        retryable: false
      }
    };
  }

  private contextInsufficientResult(input: AgentRunInput): AgentRunResult {
    // Pick a distinct ref for each retry so dedupe (T06) still allows it through.
    const attemptIndex = this.contextInsufficientAttemptIndex(input);
    const relevantFiles = input.contextPack.workspaceFocus?.relevantFiles ?? [];
    const evidenceFiles = input.contextPack.taskContext.evidenceRefs
      .map((evidence) => evidence.ref)
      .filter((ref): ref is string => Boolean(ref));
    const candidateRefs = [...relevantFiles, ...evidenceFiles];
    const primaryRef = candidateRefs[attemptIndex] ?? candidateRefs[0];
    const pathSlice = relevantFiles.length
      ? relevantFiles.slice(attemptIndex, attemptIndex + 3)
      : [];
    const requestedContext: RuntimeContextRequest = {
      reason: `Selected evidence does not include enough concrete workspace material to complete the current phase safely (attempt ${attemptIndex + 1}).`,
      requestedRefs: [
        {
          type: 'workspace_file',
          label: 'Relevant source file content',
          ref: primaryRef
        }
      ],
      requestedPaths: pathSlice,
      requestedCommands: input.contextPack.workspaceFocus?.validationCommands.slice(0, 2) ?? [],
      followUpInstruction: 'Rebuild the Context Pack with the requested files or validation evidence before retrying this runtime phase.'
    };
    return {
      runId: input.runId,
      runtimeType: 'mock',
      status: 'blocked',
      output: {
        kind: 'task_execution_result',
        status: 'blocked',
        summary: requestedContext.reason,
        completedItems: [],
        changedArtifacts: [],
        requestedContext,
        nextSuggestedActions: [requestedContext.followUpInstruction ?? 'Add the requested context and retry.'],
        risks: ['Continuing without the requested context could produce fabricated file-level conclusions.']
      } satisfies TaskExecutionResultOutput,
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
          content: `${input.agent.name} requested more context during ${input.phase}`,
          metadata: { code: 'CONTEXT_INSUFFICIENT', requestedContext },
          createdAt: nowIso()
        }
      ],
      artifacts: [],
      usage: {
        ...this.usageFor(input),
        model: 'mock'
      },
      error: {
        code: 'CONTEXT_INSUFFICIENT',
        message: requestedContext.reason,
        retryable: true,
        requestedContext
      }
    };
  }

  /**
   * Fails with CONTEXT_INSUFFICIENT exactly once per session when
   * MOCK_CONTEXT_INSUFFICIENT_ONCE=true. Uses the same session-scoped counter
   * as MOCK_CONTEXT_INSUFFICIENT_TIMES, so the "once" semantics survive
   * follow-up tasks that would otherwise scroll the supplement event out of
   * the ContextPack's relevantEvents window.
   */
  private shouldRequestContextOnce(input: AgentRunInput): boolean {
    if (process.env.MOCK_CONTEXT_INSUFFICIENT_ONCE !== 'true') return false;
    const current = this.contextInsufficientCounts.get(input.sessionId) ?? 0;
    if (current >= 1) return false;
    this.contextInsufficientCounts.set(input.sessionId, current + 1);
    return true;
  }

  /**
   * Fails with CONTEXT_INSUFFICIENT for the first N task_execution attempts in
   * a session when MOCK_CONTEXT_INSUFFICIENT_TIMES=N. Each retry asks for a
   * different workspace file so the orchestrator's dedupe still allows the
   * retry through. The counter is session-scoped so a single retry budget
   * spans all tasks in the session.
   */
  private shouldRequestContextTimes(input: AgentRunInput): boolean {
    const raw = process.env.MOCK_CONTEXT_INSUFFICIENT_TIMES;
    if (!raw) return false;
    const max = Number(raw);
    if (!Number.isFinite(max) || max <= 0) return false;
    const current = this.contextInsufficientCounts.get(input.sessionId) ?? 0;
    if (current >= Math.floor(max)) return false;
    this.contextInsufficientCounts.set(input.sessionId, current + 1);
    return true;
  }

  /** Index of the current retry within MOCK_CONTEXT_INSUFFICIENT_TIMES (0-based). */
  private contextInsufficientAttemptIndex(input: AgentRunInput): number {
    const current = this.contextInsufficientCounts.get(input.sessionId);
    if (current === undefined || current === 0) return 0;
    // The counter has already been incremented by shouldRequestContextTimes.
    return current - 1;
  }

  private outputFor(input: AgentRunInput): RuntimeOutput {
    return this.requirementAwareOutputFor(input);
  }

  private requirementAwareOutputFor(input: AgentRunInput): RuntimeOutput {
    const goal = this.goal(input);
    const isArchitectureAnalysis = this.isArchitectureAnalysisRequest(goal);
    const taskDomain = input.contextPack.taskContext?.domain ?? 'coding';
    const taskIntent = input.contextPack.taskContext?.intent ?? 'implementation';
    const taskTitle = input.contextPack.currentTask?.title ?? goal;
    const taskDescription = input.contextPack.currentTask?.description ?? `Handle the user requirement: ${goal}`;
    const acceptanceCriteria = input.contextPack.currentTask?.acceptanceCriteria?.length
      ? input.contextPack.currentTask.acceptanceCriteria
      : input.contextPack.taskBrief?.acceptanceCriteria?.length
        ? input.contextPack.taskBrief.acceptanceCriteria
        : ['The output directly addresses the user requirement.', 'The result can be reviewed by the user.'];

    switch (input.expectedOutput.kind) {
      case 'task_acceptance_decision':
        return this.taskAcceptanceDecision(input, goal, taskTitle);
      case 'task_claim_decision':
        return this.taskClaimDecision(input, goal, taskTitle);
      case 'task_brief':
        if (isArchitectureAnalysis) {
          return this.architectureAnalysisBrief(input, goal);
        }
        if (process.env.MOCK_PARALLEL_TASKS === 'true') {
          return this.parallelImplementationBrief(goal);
        }
        if (taskDomain === 'non_coding') {
          return this.nonCodingBrief(goal, taskIntent);
        }
        if (taskDomain === 'mixed') {
          return this.mixedTaskBrief(goal, taskIntent);
        }
        return {
          kind: 'task_brief',
          goal,
          scope: [
            `Clarify and decompose the user requirement: ${goal}`,
            'Coordinate the selected agents to produce stage artifacts.',
            'Generate concrete file changes for the selected local directory when applicable.'
          ],
          outOfScope: ['Do not publish, deploy, or call external systems without explicit user confirmation.'],
          constraints: [
            'Keep file changes inside the selected working directory.',
            'Make every stage output traceable to the original user requirement.'
          ],
          acceptanceCriteria: [
            `All workflow stage outputs reference the user requirement: ${goal}`,
            'Artifact events include concrete fileChanges when a local working directory is selected.',
            'The frontend shows file paths, operation types, and content previews.'
          ],
          risks: ['Mock runtime output is deterministic and should be replaced by a real coding runtime for production edits.'],
          openQuestions: [],
          suggestedTasks: [
            {
              title: `Implement requirement: ${this.shortText(goal, 60)}`,
              description: `Produce concrete artifacts and file changes for: ${goal}`,
              suggestedAgentKey: 'backend',
              acceptanceCriteria: ['Execution output is specific to the user requirement.', 'File changes are safe relative paths.']
            },
            {
              title: `Review requirement output: ${this.shortText(goal, 55)}`,
              description: `Check whether generated artifacts and file changes satisfy: ${goal}`,
              suggestedAgentKey: 'test',
              dependsOnTaskTitles: [`Implement requirement: ${this.shortText(goal, 60)}`],
              acceptanceCriteria: ['Review result compares actual output with the user requirement.']
            }
          ]
        } satisfies TaskBriefOutput;
      case 'task_execution_result':
        if (isArchitectureAnalysis) {
          return this.architectureAnalysisExecutionResult(input, goal);
        }
        if (taskDomain === 'non_coding') {
          return this.nonCodingExecutionResult(input, goal, taskTitle);
        }
        if (this.isValidationRun(input, taskTitle)) {
          return this.validationExecutionResult(input, goal, taskTitle);
        }
        return {
          kind: 'task_execution_result',
          status: 'completed',
          summary: `${input.agent.name} generated an execution artifact for the user requirement: ${goal}`,
          completedItems: [
            `Mapped task "${taskTitle}" back to the original requirement.`,
            `Prepared concrete file content for: ${goal}`,
            'Preserved reviewable completion notes, risks, and next actions.'
          ],
          changedArtifacts: [this.requirementAwareExecutionFileArtifact(input)],
          agentMessages: this.runtimeAgentMessages(input, goal, taskTitle),
          nextSuggestedActions: ['Inspect the generated file under agent-output.', 'Run the review stage against the same requirement.'],
          risks: []
        } satisfies TaskExecutionResultOutput;
      case 'post_review_report':
        if (isArchitectureAnalysis) {
          return {
            kind: 'post_review_report',
            isConsistentWithBrief: true,
            matchedItems: ['已围绕用户指定目录生成项目架构分析', '分析产物包含技术栈、目录职责、入口文件、重点文件和后续熟悉路径'],
            mismatchedItems: [],
            missingItems: [],
            outOfScopeChanges: [],
            testResults: ['项目架构分析产物检查通过'],
            recommendation: 'deliver'
          } satisfies PostReviewReportOutput;
        }
        if (taskDomain === 'non_coding') {
          return {
            kind: 'post_review_report',
            isConsistentWithBrief: true,
            matchedItems: [
              `Analysis output references the non-coding goal: ${goal}`,
              'Validation evidence covers fact consistency, scope consistency, traceability, and delivery completeness.',
              'No source-code implementation evidence was required for this non-coding task.'
            ],
            mismatchedItems: [],
            missingItems: [],
            outOfScopeChanges: [],
            testResults: ['Non-coding validation evidence reviewed successfully.'],
            recommendation: 'deliver'
          } satisfies PostReviewReportOutput;
        }
        return {
          kind: 'post_review_report',
          isConsistentWithBrief: true,
          matchedItems: [
            `The generated artifacts reference the original requirement: ${goal}`,
            'File changes use relative paths suitable for the selected local directory.',
            'Execution output can be inspected in the frontend artifact card.'
          ],
          mismatchedItems: [],
          missingItems: [],
          outOfScopeChanges: [],
          testResults: [`Mock review passed for requirement: ${goal}`],
          recommendation: 'deliver'
        } satisfies PostReviewReportOutput;
      case 'final_delivery':
        if (isArchitectureAnalysis) {
          return {
            kind: 'final_delivery',
            summary: `已完成项目架构分析：${goal}`,
            completedItems: ['生成工作区架构分析', '生成项目架构分析报告', '完成分析结果复核'],
            incompleteItems: [],
            risks: [],
            artifactRefs: []
          } satisfies FinalDeliveryOutput;
        }
        if (taskDomain === 'non_coding') {
          return {
            kind: 'final_delivery',
            summary: `Completed the non-coding multi-agent workflow for: ${goal}`,
            completedItems: [
              `Created a structured analysis or plan for: ${goal}`,
              'Completed independent validation for fact consistency, scope consistency, traceability, and delivery completeness.',
              'Completed Review Agent risk and boundary check before delivery.'
            ],
            incompleteItems: [],
            risks: [],
            artifactRefs: []
          } satisfies FinalDeliveryOutput;
        }
        return {
          kind: 'final_delivery',
          summary: `Completed the multi-agent workflow for: ${goal}`,
          completedItems: [
            `Created a requirement brief for: ${goal}`,
            `Generated execution artifacts for task: ${taskTitle}`,
            'Completed review and final delivery artifacts.'
          ],
          incompleteItems: ['Use a real coding runtime for exact repository file edits beyond mock artifact generation.'],
          risks: [],
          artifactRefs: []
        } satisfies FinalDeliveryOutput;
      case 'user_message_handling_plan':
        return {
          kind: 'user_message_handling_plan',
          intent: 'constraint',
          priority: 'high',
          shouldPause: true,
          affectedTaskIds: input.taskId ? [input.taskId] : [],
          affectedAgentIds: [input.agent.id],
          requiresBriefRevision: false,
          requiresUserConfirmation: false,
          coordinatorInstruction: `Apply the user's latest message to the current requirement context: ${goal}`
        } satisfies UserMessageHandlingPlanOutput;
      default:
        return {
          kind: 'agent_message',
          messageKind: 'discussion',
          content: [
            `${input.agent.name} reviewed the requirement from the ${input.phase} stage.`,
            `User requirement: ${goal}`,
            `Agent focus: ${input.agent.role}.`,
            input.contextPack.currentTask ? `Related task: ${taskTitle}. ${taskDescription}` : 'No concrete execution task is bound yet.',
            `Recommendation: keep the next output tied to "${this.shortText(goal, 80)}" and include concrete artifact/file evidence.`,
            `Acceptance focus: ${acceptanceCriteria.join('; ')}`
          ].join('\n')
        } satisfies AgentMessageOutput;
    }
  }

  private architectureAnalysisBrief(input: AgentRunInput, goal: string): TaskBriefOutput {
    const workspace = input.contextPack.workspaceSnapshot;
    return {
      kind: 'task_brief',
      goal: `分析并熟悉项目架构：${workspace?.rootName ?? goal}`,
      scope: [
        '读取用户指定目录的工作区快照。',
        '分析项目技术栈、目录职责、入口文件、关键配置和核心模块。',
        '输出中文项目架构分析报告，帮助用户快速熟悉项目。'
      ],
      outOfScope: ['不修改项目源码。', '不发布、部署或调用外部系统。'],
      constraints: ['所有阶段产物必须围绕项目架构分析。', '所有用户可见产物必须使用中文。'],
      acceptanceCriteria: [
        '产物包含项目结构、技术栈、入口文件、核心目录、重点文件和建议阅读路径。',
        '产物引用用户指定的目录或工作区名称。',
        '产物以 fileChanges 形式生成到 agent-output/，方便写入用户选择的目录。'
      ],
      risks: workspace ? [] : ['没有读取到工作区快照，分析可能不完整。'],
      openQuestions: [],
      suggestedTasks: [
        {
          title: '生成项目架构分析报告',
          description: `基于工作区快照分析项目架构：${goal}`,
          suggestedAgentKey: 'architect',
          acceptanceCriteria: ['报告包含技术栈、目录职责、入口文件、重点文件和熟悉路径。']
        },
        {
          title: '复核项目架构分析完整性',
          description: '检查架构分析报告是否覆盖用户指定目录和核心项目结构。',
          suggestedAgentKey: 'review',
          dependsOnTaskTitles: ['生成项目架构分析报告'],
          acceptanceCriteria: ['复核结论指出报告是否足够帮助用户熟悉项目。']
        }
      ]
    };
  }

  private taskClaimDecision(input: AgentRunInput, goal: string, taskTitle: string): TaskClaimDecisionOutput {
    const decision = this.taskAcceptanceDecision(input, goal, taskTitle);
    return {
      kind: 'task_claim_decision',
      accepted: decision.status === 'accepted',
      reason: decision.reason,
      confidence: decision.confidence,
      missingContext: decision.missingContext,
      handoffSuggestion: decision.handoffSuggestion,
      alternativeAgentKeys: decision.alternativeAgentKeys,
      alternativeAgentIds: decision.alternativeAgentIds,
      agentMessages: decision.agentMessages
    };
  }

  private taskAcceptanceDecision(input: AgentRunInput, goal: string, taskTitle: string): TaskAcceptanceDecisionOutput {
    const domain = input.contextPack.taskContext?.domain ?? 'coding';
    const rejectedAgentKeys = (process.env.MOCK_REJECT_ACCEPTANCE_AGENT_KEYS ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    if (rejectedAgentKeys.includes('all') || rejectedAgentKeys.includes(input.agent.key)) {
      return {
        kind: 'task_acceptance_decision',
        status: 'rejected',
        reason: `${input.agent.name} rejects "${taskTitle}" because MOCK_REJECT_ACCEPTANCE_AGENT_KEYS requested it.`,
        confidence: 0.9,
        handoffSuggestion: {
          targetAgentKey: 'coordinator',
          reason: 'Mock runtime is forcing acceptance rejection for routing smoke coverage.',
          riskLevel: 'medium'
        }
      };
    }
    if (domain === 'non_coding' && ['backend', 'frontend'].includes(input.agent.key)) {
      return {
        kind: 'task_acceptance_decision',
        status: 'rejected',
        reason: `${input.agent.name} recommends assigning "${taskTitle}" to a planning/analysis role for this non-coding task.`,
        confidence: 0.88,
        alternativeAgentKeys: ['requirements', 'product-manager', 'test', 'review'],
        handoffSuggestion: {
          targetAgentKey: 'requirements',
          reason: 'The task is planning/analysis oriented.',
          riskLevel: 'low'
        }
      };
    }
    const shouldDecline =
      process.env.MOCK_DECLINE_FRONTEND_TASK === 'true' &&
      input.agent.key === 'frontend' &&
      /frontend/i.test(taskTitle);
    if (shouldDecline) {
      return {
        kind: 'task_acceptance_decision',
        status: 'rejected',
        reason: `${input.agent.name} cannot take "${taskTitle}" and recommends Backend for this run.`,
        confidence: 0.86,
        alternativeAgentKeys: ['backend'],
        handoffSuggestion: {
          targetAgentKey: 'backend',
          reason: 'The mock scenario asks Backend to take over this frontend-titled task.',
          riskLevel: 'low'
        },
        agentMessages: [
          {
            kind: 'agent_message',
            messageKind: 'handoff',
            content: `${input.agent.name} declines "${taskTitle}" and asks Backend to take it over.`,
            targetAgentKeys: ['backend']
          }
        ]
      };
    }
    return {
      kind: 'task_acceptance_decision',
      status: 'accepted',
      reason: `${input.agent.name} accepts "${taskTitle}" for requirement: ${goal}`,
      confidence: 0.92,
      agentMessages: [
        {
          kind: 'agent_message',
          messageKind: 'decision',
          content: `${input.agent.name} accepts "${taskTitle}" and will produce reviewable artifacts.`,
          targetAgentKeys: ['coordinator']
        }
      ]
    };
  }

  private parallelImplementationBrief(goal: string): TaskBriefOutput {
    const frontendTitle = `Frontend implementation: ${this.shortText(goal, 48)}`;
    const backendTitle = `Backend implementation: ${this.shortText(goal, 48)}`;
    return {
      kind: 'task_brief',
      goal,
      scope: [
        `Implement independent frontend and backend work for: ${goal}`,
        'Let multiple coding agents claim ready tasks in the same execution wave.',
        'Review both outputs before final delivery.'
      ],
      outOfScope: ['Do not deploy or call external services.'],
      constraints: ['Keep generated changes reviewable through artifact fileChanges.'],
      acceptanceCriteria: [
        'Frontend and backend tasks can start without depending on each other.',
        'A review task waits for both implementation tasks.'
      ],
      risks: ['Mock runtime proves orchestration behavior, not production code quality.'],
      openQuestions: [],
      suggestedTasks: [
        {
          title: frontendTitle,
          description: `Prepare frontend-facing changes for: ${goal}`,
          suggestedAgentKey: 'frontend',
          acceptanceCriteria: ['Frontend task produces a task_execution_result artifact.']
        },
        {
          title: backendTitle,
          description: `Prepare backend-facing changes for: ${goal}`,
          suggestedAgentKey: 'backend',
          acceptanceCriteria: ['Backend task produces a task_execution_result artifact.']
        },
        {
          title: `Review parallel implementation: ${this.shortText(goal, 42)}`,
          description: 'Review the combined frontend and backend outputs.',
          suggestedAgentKey: 'test',
          dependsOnTaskTitles: [frontendTitle, backendTitle],
          acceptanceCriteria: ['Review starts only after both implementation tasks complete.']
        }
      ]
    };
  }

  private nonCodingBrief(goal: string, taskIntent: string): TaskBriefOutput {
    const leadAgent = taskIntent === 'planning' ? 'product-manager' : 'requirements';
    const analysisTitle = `Analyze request: ${this.shortText(goal, 52)}`;
    const validationTitle = `Validate analysis: ${this.shortText(goal, 48)}`;
    return {
      kind: 'task_brief',
      goal,
      scope: [
        `Analyze and structure the non-coding task: ${goal}`,
        'Produce a clear recommendation, plan, or explanation.',
        'Validate the result for factual consistency, scope consistency, traceability, and delivery completeness.',
        'Review the result for completeness, assumptions, and risks.'
      ],
      outOfScope: ['Do not create unnecessary source-code edits for a non-coding task.'],
      constraints: ['Keep outputs traceable to the original goal and explicit assumptions.'],
      acceptanceCriteria: [
        'The output directly addresses the user goal with a structured explanation or plan.',
        'Open questions, risks, and next steps are visible.',
        'Validation maps conclusions back to evidence and states any missing evidence.',
        'Review output confirms completeness and scope control.'
      ],
      risks: ['A non-coding task may still reference implementation details that need later coding follow-up.'],
      openQuestions: [],
      suggestedTasks: [
        {
          title: analysisTitle,
          description: `Structure the request, assumptions, and recommendation for: ${goal}`,
          suggestedAgentKey: leadAgent,
          acceptanceCriteria: ['The result includes scope, assumptions, and a concrete recommendation.']
        },
        {
          title: validationTitle,
          description: 'Validate facts, scope, traceability, and completeness against the Task Context Pack.',
          suggestedAgentKey: 'test',
          dependsOnTaskTitles: [analysisTitle],
          acceptanceCriteria: ['The validation output identifies evidence used, gaps, and remaining risks.']
        },
        {
          title: `Review analysis: ${this.shortText(goal, 48)}`,
          description: 'Check completeness, risks, and consistency of the analysis output.',
          suggestedAgentKey: 'review',
          dependsOnTaskTitles: [validationTitle],
          acceptanceCriteria: ['The review identifies covered items, risks, and any remaining open questions.']
        }
      ]
    };
  }

  private nonCodingExecutionResult(input: AgentRunInput, goal: string, taskTitle: string): TaskExecutionResultOutput {
    const isValidation = this.isValidationRun(input, taskTitle);
    const isReview = input.agent.key === 'review' || /^(review|复核|评审)\b/i.test(taskTitle.trim());
    const artifactTitle = isValidation
      ? 'Non-coding validation evidence'
      : isReview
        ? 'Non-coding review report'
        : 'Non-coding analysis output';
    const changedArtifact = isValidation
      ? this.validationEvidenceArtifact(input, goal, taskTitle, artifactTitle)
      : {
          type: 'markdown' as const,
          title: artifactTitle,
          summary: `${artifactTitle} for ${this.shortText(goal, 80)}`,
          content: [
            `# ${artifactTitle}`,
            '',
            `Goal: ${goal}`,
            `Task: ${taskTitle}`,
            '',
            '## Evidence',
            ...input.contextPack.taskContext.evidenceRefs.slice(0, 8).map((item) => `- ${item.type}: ${item.label}`),
            '',
            '## Validation Rules',
            ...input.contextPack.taskContext.validationRules.map((rule) => `- ${rule.label}: ${rule.evidenceRequired}`)
          ].join('\n')
        } satisfies RuntimeArtifactOutput;
    return {
      kind: 'task_execution_result',
      status: 'completed',
      summary: `${input.agent.name} completed ${taskTitle} for non-coding goal: ${goal}`,
      completedItems: isValidation
        ? [
            'Checked fact consistency against taskContext.evidenceRefs.',
            'Checked scope consistency against the brief and Domain Map.',
            'Checked traceability and delivery completeness.'
          ]
        : [
            `Structured the non-coding request: ${goal}`,
            'Recorded assumptions, evidence references, risks, and next actions.',
            'Kept the output independent from source-code changes.'
          ],
      changedArtifacts: [changedArtifact],
      agentMessages: this.runtimeAgentMessages(input, goal, taskTitle),
      nextSuggestedActions: isValidation
        ? ['Send validation evidence to the Review Agent.', 'Resolve any missing evidence before final delivery.']
        : ['Run independent validation against the analysis output.', 'Keep final delivery tied to the Domain Map.'],
      risks: []
    };
  }

  private validationExecutionResult(input: AgentRunInput, goal: string, taskTitle: string): TaskExecutionResultOutput {
    const artifact = this.validationEvidenceArtifact(input, goal, taskTitle);
    const report = artifact.metadata?.validationEvidence;
    const warnings = report?.verdicts.filter((verdict) => verdict.status !== 'passed') ?? [];
    return {
      kind: 'task_execution_result',
      status: report?.overallStatus === 'failed' ? 'needs_review' : 'completed',
      summary: `${input.agent.name} validated "${taskTitle}" with rule-to-evidence traceability for: ${goal}`,
      completedItems: report?.verdicts.map((verdict) => `Validation rule "${verdict.ruleLabel}" => ${verdict.status}.`) ?? [
        'Generated validation evidence report.'
      ],
      changedArtifacts: [artifact],
      agentMessages: this.runtimeAgentMessages(input, goal, taskTitle),
      nextSuggestedActions:
        report?.overallStatus === 'failed'
          ? ['Route failed validation rules to the Review Agent.', 'Add missing evidence before final delivery.']
          : ['Send validation evidence to the Review Agent.', 'Keep final delivery linked to the validation report.'],
      risks: warnings.map((verdict) => `Validation rule "${verdict.ruleLabel}" needs attention: ${verdict.missingEvidence?.join('; ') ?? 'see notes'}.`)
    };
  }

  private validationEvidenceArtifact(
    input: AgentRunInput,
    goal: string,
    taskTitle: string,
    title = 'Validation evidence report'
  ): RuntimeArtifactOutput {
    const report = this.validationEvidenceReport(input, taskTitle);
    return {
      type: 'test_report',
      title,
      summary: `Validation evidence report for ${this.shortText(goal, 80)} (${report.overallStatus}).`,
      content: [
        `# ${title}`,
        '',
        `Goal: ${goal}`,
        `Task: ${taskTitle}`,
        `Domain: ${report.domain}`,
        `Overall: ${report.overallStatus}`,
        '',
        '## Verdicts',
        ...report.verdicts.map((verdict) => {
          const evidenceLabels = verdict.evidenceRefs.map((ref) => `${ref.type}:${ref.label}`).join(', ') || 'none';
          return `- ${verdict.ruleLabel}: ${verdict.status}; evidence=${evidenceLabels}`;
        }),
        '',
        '## Evidence Refs',
        ...report.evidenceRefs.map((ref) => `- ${ref.type}: ${ref.label}${ref.ref ? ` (${ref.ref})` : ''}`)
      ].join('\n'),
      metadata: {
        validationEvidence: report
      }
    };
  }

  private validationEvidenceReport(input: AgentRunInput, taskTitle: string): ValidationEvidenceReport {
    const context = input.contextPack.taskContext;
    const evidenceRefs = context.evidenceRefs.slice(0, 16);
    const validationResponsibility = context.agentResponsibilities.find((responsibility) => responsibility.role === 'validation');
    const verdicts: ValidationEvidenceVerdict[] = context.validationRules.map((rule) => {
      const directEvidence = this.evidenceForValidationRule(rule.label, evidenceRefs);
      const evidenceForRule = (directEvidence.length ? directEvidence : evidenceRefs.slice(0, 3)).slice(0, 6);
      const status: ValidationEvidenceVerdict['status'] = directEvidence.length ? 'passed' : evidenceForRule.length ? 'warning' : 'failed';
      return {
        ruleLabel: rule.label,
        status,
        evidenceRefs: evidenceForRule,
        notes: [
          `Requires: ${rule.evidenceRequired}`,
          directEvidence.length
            ? `Matched ${directEvidence.length} direct evidence reference(s).`
            : 'No direct evidence type matched; linked fallback evidence for Review Agent inspection.'
        ],
        missingEvidence: status === 'passed' ? undefined : [rule.evidenceRequired]
      };
    });
    const overallStatus = verdicts.some((verdict) => verdict.status === 'failed')
      ? 'failed'
      : verdicts.some((verdict) => verdict.status === 'warning')
        ? 'warning'
        : 'passed';
    return {
      kind: 'validation_evidence_report',
      domain: context.domain,
      intent: context.intent,
      stage: context.currentStage,
      taskTitle,
      validatorAgentKey: input.agent.key,
      validatorAgentId: input.agent.id,
      independentFromAgentKeys: validationResponsibility?.independentFrom ?? [],
      rules: context.validationRules,
      evidenceRefs,
      verdicts,
      overallStatus
    };
  }

  private evidenceForValidationRule(ruleLabel: string, evidenceRefs: TaskEvidenceRef[]): TaskEvidenceRef[] {
    const label = ruleLabel.toLowerCase();
    const byType = (types: Array<TaskEvidenceRef['type']>) => {
      const allowed = new Set(types);
      return this.uniqueEvidenceRefs(evidenceRefs.filter((ref) => allowed.has(ref.type))).slice(0, 6);
    };
    if (label.includes('fact')) {
      return byType(['user_input', 'document_fragment', 'external_reference', 'memory', 'meeting_note', 'data_table', 'historical_decision']);
    }
    if (label.includes('scope')) {
      return byType(['user_input', 'historical_decision', 'event_log', 'artifact', 'memory']);
    }
    if (label.includes('trace')) {
      return this.uniqueEvidenceRefs(evidenceRefs).slice(0, 6);
    }
    if (label.includes('delivery')) {
      return byType(['artifact', 'test', 'event_log', 'user_input', 'memory']);
    }
    if (label.includes('typecheck') || label.includes('unit') || label.includes('test') || label.includes('build') || label.includes('e2e') || label.includes('smoke')) {
      return byType(['test', 'log', 'diff', 'artifact', 'workspace_snapshot', 'workspace_file', 'event_log']);
    }
    if (label.includes('reasoning')) {
      return byType(['artifact', 'event_log', 'user_input', 'memory', 'workspace_snapshot']);
    }
    return this.uniqueEvidenceRefs(evidenceRefs).slice(0, 6);
  }

  private uniqueEvidenceRefs(evidenceRefs: TaskEvidenceRef[]) {
    const seen = new Set<string>();
    const unique: TaskEvidenceRef[] = [];
    for (const ref of evidenceRefs) {
      const key = `${ref.type}:${ref.label}:${ref.ref ?? ''}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      unique.push(ref);
    }
    return unique;
  }

  private isValidationRun(input: AgentRunInput, taskTitle: string) {
    return (
      input.agent.key === 'test' ||
      /^(validate|validating|verify|verification|e2e|smoke)\b/i.test(taskTitle.trim()) ||
      taskTitle.trim().startsWith('验证')
    );
  }

  private mixedTaskBrief(goal: string, taskIntent: string): TaskBriefOutput {
    const planningTitle = `Plan mixed task: ${this.shortText(goal, 50)}`;
    const implementationTitle = `Implement mixed task: ${this.shortText(goal, 48)}`;
    return {
      kind: 'task_brief',
      goal,
      scope: [
        `Handle a mixed task combining analysis/planning and implementation: ${goal}`,
        'Create a structured plan before implementation.',
        'Validate both the reasoning and the implementation result.'
      ],
      outOfScope: ['Do not skip the planning phase for a mixed task.'],
      constraints: ['Keep planning output and implementation output traceable to the same goal.'],
      acceptanceCriteria: [
        'A planning artifact exists before implementation starts.',
        'Implementation output follows the agreed plan.',
        'Validation checks both reasoning and execution evidence.'
      ],
      risks: ['Mixed tasks can drift if the planning and implementation phases are not linked clearly.'],
      openQuestions: [],
      suggestedTasks: [
        {
          title: planningTitle,
          description: `Clarify the plan, scope, and implementation path for: ${goal}`,
          suggestedAgentKey: taskIntent === 'planning' ? 'product-manager' : 'requirements',
          acceptanceCriteria: ['The planning output includes scope, constraints, and implementation approach.']
        },
        {
          title: implementationTitle,
          description: `Produce reviewable implementation artifacts for: ${goal}`,
          suggestedAgentKey: 'backend',
          dependsOnTaskTitles: [planningTitle],
          acceptanceCriteria: ['Implementation output includes concrete artifacts and file changes when needed.']
        },
        {
          title: `Validate mixed task: ${this.shortText(goal, 44)}`,
          description: 'Validate both the planning rationale and the implementation output.',
          suggestedAgentKey: 'test',
          dependsOnTaskTitles: [implementationTitle],
          acceptanceCriteria: ['Validation covers plan consistency and execution evidence.']
        }
      ]
    };
  }

  private architectureAnalysisExecutionResult(input: AgentRunInput, goal: string): TaskExecutionResultOutput {
    const artifact = this.architectureAnalysisArtifact(input, goal);
    return {
      kind: 'task_execution_result',
      status: 'completed',
      summary: `已生成项目架构分析报告：${input.contextPack.workspaceSnapshot?.rootName ?? goal}`,
      completedItems: ['分析工作区目录结构', '识别项目技术栈和入口文件', '生成中文项目架构分析报告'],
      changedArtifacts: [artifact],
      nextSuggestedActions: ['阅读 agent-output/project-architecture-analysis.md', '按报告中的建议阅读路径逐步熟悉项目'],
      risks: input.contextPack.workspaceSnapshot ? [] : ['缺少工作区快照，报告仅能基于用户文字描述。']
    };
  }

  private architectureAnalysisArtifact(input: AgentRunInput, goal: string) {
    const report = this.buildArchitectureAnalysisReport(input, goal);
    return {
      type: 'markdown',
      title: '项目架构分析报告',
      content: report.content,
      summary: report.summary,
      metadata: {
        phase: 'project_architecture_analysis',
        reportKind: 'project_architecture_analysis',
        primaryReportPath: 'agent-output/project-architecture-analysis.md',
        fileChanges: [
          {
            path: 'agent-output/project-architecture-analysis.md',
            operation: 'create',
            content: report.content,
            encoding: 'utf-8'
          }
        ]
      }
    } satisfies import('@agent-cluster/shared').RuntimeArtifactOutput;
  }

  private buildArchitectureAnalysisReport(input: AgentRunInput, goal: string) {
    const snapshot = input.contextPack.workspaceSnapshot;
    const focus = input.contextPack.workspaceFocus;
    const topDirectories = this.topDirectoriesFromSnapshot(input);
    const importantFiles = [...new Set([...(focus?.relevantFiles ?? []), ...(snapshot?.entrypoints ?? [])])].slice(0, 12);
    const packageFile = snapshot?.files.find((file) => file.path.endsWith('package.json'));
    const packageInfo = this.packageJsonInsights(packageFile?.content);
    const configFiles = this.filesByName(input, [
      'AGENTS.md',
      'CLAUDE.md',
      'README.md',
      'tsconfig.json',
      'vite.config.ts',
      'vite.config.js',
      'nest-cli.json'
    ]);
    const sourceFiles = snapshot?.files
      .filter((file) => /^(src|apps|packages)\//.test(file.path))
      .map((file) => file.path)
      .slice(0, 16) ?? [];
    const content = [
      '# 项目架构分析报告',
      '',
      `用户需求：${goal}`,
      `项目目录：${snapshot?.rootName ?? '未识别'}`,
      '',
      '## 总体结论',
      snapshot
        ? `该项目共扫描 ${snapshot.fileCount} 个条目，读取 ${snapshot.files.length} 个文本文件，识别技术栈：${snapshot.detectedStack?.join('、') || '未识别'}。`
        : '当前没有读取到工作区快照，无法给出完整项目结构判断。',
      packageInfo.description ? `项目定位：${packageInfo.description}` : '项目定位：未在 README 或 package.json 中识别到明确描述，需要继续阅读业务入口确认。',
      '',
      '## 技术栈',
      ...(snapshot?.detectedStack?.length ? snapshot.detectedStack.map((item) => `- ${item}`) : ['- 未识别']),
      ...packageInfo.dependencies.map((item) => `- package.json 依赖：${item}`),
      '',
      '## 运行脚本',
      ...(packageInfo.scripts.length ? packageInfo.scripts.map((item) => `- ${item}`) : ['- 未在 package.json 中识别到 scripts。']),
      '',
      '## 入口文件',
      ...(snapshot?.entrypoints?.length ? snapshot.entrypoints.map((item) => `- ${item}`) : ['- 未识别']),
      '',
      '## 核心目录',
      ...(topDirectories.length ? topDirectories.map((item) => `- ${item}`) : ['- 暂无目录统计']),
      '',
      '## 源码结构线索',
      ...(sourceFiles.length ? sourceFiles.map((item) => `- ${item}`) : ['- 暂未读取到 src/apps/packages 下的源码文件。']),
      '',
      '## 重点文件',
      ...(importantFiles.length ? importantFiles.map((item) => `- ${item}`) : ['- 暂无重点文件']),
      '',
      '## 配置与说明文件',
      ...(configFiles.length ? configFiles.map((item) => `- ${item}`) : ['- 暂未识别到 README、AGENTS、CLAUDE 或构建配置文件。']),
      '',
      '## 建议熟悉路径',
      '- 先阅读 README、AGENTS/CLAUDE 等项目说明文件。',
      '- 再阅读 package.json、tsconfig、vite/nest 等配置文件，确认技术栈和启动方式。',
      '- 接着从入口文件进入应用主链路。',
      '- 最后按业务模块目录逐步阅读组件、服务、状态管理和测试用例。',
      '',
      '## 本次分析产物',
      '- agent-output/workspace-analysis.md：工作区扫描与影响面分析。',
      '- agent-output/project-architecture-analysis.md：面向用户熟悉项目的中文架构分析报告。',
      '',
      '## 复核提示',
      '- 如果需要更深入分析，可以继续指定某个目录或模块，我会基于该目录继续拆解。'
    ].join('\n');
    return {
      content,
      summary: `已生成 ${snapshot?.rootName ?? '项目'} 的架构分析报告`
    };
  }

  private packageJsonInsights(content?: string) {
    if (!content) {
      return { description: '', scripts: [] as string[], dependencies: [] as string[] };
    }
    try {
      const parsed = JSON.parse(content) as {
        name?: string;
        description?: string;
        scripts?: Record<string, string>;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const dependencies = { ...(parsed.dependencies ?? {}), ...(parsed.devDependencies ?? {}) };
      return {
        description: [parsed.name ? `包名 ${parsed.name}` : '', parsed.description ?? ''].filter(Boolean).join('，'),
        scripts: Object.entries(parsed.scripts ?? {})
          .slice(0, 8)
          .map(([name, command]) => `${name}：${command}`),
        dependencies: Object.entries(dependencies)
          .filter(([name]) => ['vue', 'vite', '@nestjs/core', 'react', 'pinia', 'typescript', 'express'].includes(name))
          .map(([name, version]) => `${name}@${version}`)
      };
    } catch {
      return { description: 'package.json 存在但解析失败，需要人工检查 JSON 格式。', scripts: [] as string[], dependencies: [] as string[] };
    }
  }

  private filesByName(input: AgentRunInput, names: string[]) {
    const lowerNames = new Set(names.map((name) => name.toLowerCase()));
    return (
      input.contextPack.workspaceSnapshot?.files
        .map((file) => file.path)
        .filter((path) => lowerNames.has(path.split('/').at(-1)?.toLowerCase() ?? path.toLowerCase()))
        .slice(0, 12) ?? []
    );
  }

  private topDirectoriesFromSnapshot(input: AgentRunInput) {
    const counts = new Map<string, number>();
    for (const node of input.contextPack.workspaceSnapshot?.tree ?? []) {
      const top = node.path.split('/')[0];
      if (!top || top === node.path) continue;
      counts.set(top, (counts.get(top) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 8)
      .map(([directory, count]) => `${directory}/（${count} 个条目）`);
  }

  private isArchitectureAnalysisRequest(goal: string) {
    return /架构|结构|目录|熟悉|分析项目|项目分析|了解项目/i.test(goal);
  }

  private legacyOutputFor(input: AgentRunInput): RuntimeOutput {
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
              dependsOnTaskTitles: ['执行 dry-run 实现任务'],
              acceptanceCriteria: ['生成测试结果摘要']
            }
          ]
        } satisfies TaskBriefOutput;
      case 'task_execution_result':
        return {
          kind: 'task_execution_result',
          status: 'completed',
          summary: `${input.agent.name} 已根据任务契约生成可落地的执行产物，并准备写入本地工作目录。`,
          completedItems: [
            `梳理任务目标：${input.contextPack.currentTask?.title ?? input.contextPack.sessionGoal}`,
            '生成结构化执行记录文件',
            '保留可复盘的完成项、风险和下一步建议'
          ],
          changedArtifacts: [this.executionFileArtifact(input)],
          nextSuggestedActions: ['查看写入的 agent-output 文件', '进入复盘一致性检查'],
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
          priority: 'high',
          shouldPause: true,
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
          content: [
            `${input.agent.name} 已完成 ${input.phase} 阶段处理。`,
            `当前目标：${input.contextPack.sessionGoal}`,
            input.contextPack.currentTask ? `关联任务：${input.contextPack.currentTask.title}` : '当前没有绑定具体执行任务。',
            '我会把结论同步给 Coordinator，并保留后续执行需要的约束、风险和验收依据。'
          ].join('\n')
        } satisfies AgentMessageOutput;
    }
  }

  private requirementAwareExecutionFileArtifact(input: AgentRunInput) {
    const goal = this.goal(input);
    const taskTitle = input.contextPack.currentTask?.title ?? goal;
    const targetPaths = this.workspaceTargetPaths(input);
    const fileName = this.safeFileName(taskTitle);
    const acceptanceCriteria = input.contextPack.currentTask?.acceptanceCriteria?.length
      ? input.contextPack.currentTask.acceptanceCriteria
      : input.contextPack.taskBrief?.acceptanceCriteria ?? [];
    const fallbackPath = `agent-output/${fileName}.md`;
    const fileChanges: RuntimeFileChange[] = targetPaths.length
      ? targetPaths.map((path) => {
          return {
            path,
            operation: 'update',
            content: this.updatedWorkspaceFileContent({
              originalContent: this.selectedWorkspaceEvidenceContent(input, path),
              path,
              agentName: input.agent.name,
              phase: input.phase,
              goal,
              taskTitle,
              taskDescription: input.contextPack.currentTask?.description ?? `为用户需求生成可审查的具体修改：${goal}`,
              acceptanceCriteria
            }),
            encoding: 'utf-8'
          };
        })
      : [
          {
            path: fallbackPath,
            operation: 'create',
            content: this.markdownExecutionArtifact({
              agentName: input.agent.name,
              phase: input.phase,
              goal,
              taskTitle,
              taskDescription: input.contextPack.currentTask?.description ?? `为用户需求生成可审查的具体修改：${goal}`,
              acceptanceCriteria
            }),
            encoding: 'utf-8'
          }
        ];
    const content = this.multiFileExecutionSummary({
      agentName: input.agent.name,
      phase: input.phase,
      goal,
      taskTitle,
      taskDescription: input.contextPack.currentTask?.description ?? `为用户需求生成可审查的具体修改：${goal}`,
      acceptanceCriteria,
      fileChanges
    });

    return {
      type: 'markdown',
      title: `${taskTitle} 多文件执行产物`,
      content,
      summary: `已为需求生成 ${fileChanges.length} 个文件变更：${goal}`,
      metadata: {
        fileChanges
      }
    } satisfies import('@agent-cluster/shared').RuntimeArtifactOutput;
  }

  private runtimeAgentMessages(input: AgentRunInput, goal: string, taskTitle: string): AgentMessageOutput[] | undefined {
    if (process.env.MOCK_RUNTIME_AGENT_COMMUNICATION !== 'true') {
      return undefined;
    }
    return [
      {
        kind: 'agent_message',
        messageKind: 'progress',
        content: `${input.agent.name} requests peer review for "${taskTitle}" before final delivery. Requirement: ${goal}`,
        targetAgentKeys: ['test', 'review'],
        relatedTaskIds: input.taskId ? [input.taskId] : []
      }
    ];
  }

  private workspaceTargetPaths(input: AgentRunInput) {
    const snapshotPaths = new Set(input.contextPack.workspaceSnapshot?.files.map((file) => file.path) ?? []);
    const focus = input.contextPack.workspaceFocus;
    const candidates = focus?.impactedFiles?.length
      ? focus.impactedFiles
      : focus?.relevantFiles?.length
        ? focus.relevantFiles
        : input.contextPack.workspaceSnapshot?.files.map((file) => file.path) ?? [];
    return [...new Set(candidates)]
      .filter((path) => snapshotPaths.has(path))
      .filter((path) => !path.startsWith('agent-output/'))
      .slice(0, 6);
  }

  private selectedWorkspaceEvidenceContent(input: AgentRunInput, path: string) {
    return (
      input.contextPack.selectedEvidenceContents?.find(
        (item) => item.source === 'workspace_file' && (item.ref === path || item.label === path)
      )?.content ?? ''
    );
  }

  private multiFileExecutionSummary(input: {
    agentName: string;
    phase: string;
    goal: string;
    taskTitle: string;
    taskDescription: string;
    acceptanceCriteria: string[];
    fileChanges: RuntimeFileChange[];
  }) {
    return [
      `# ${input.taskTitle}多文件执行产物`,
      '',
      `执行 Agent：${input.agentName}`,
      `阶段：${input.phase}`,
      '',
      '## 用户需求',
      input.goal,
      '',
      '## 任务说明',
      input.taskDescription,
      '',
      '## 影响文件',
      ...input.fileChanges.map((change) => `- ${change.operation === 'update' ? '修改' : '新增'}：${change.path}`),
      '',
      '## 验收标准',
      ...(input.acceptanceCriteria.length
        ? input.acceptanceCriteria.map((item: string) => `- ${item}`)
        : ['- 所有影响文件都有明确变更', '- 前端可以展示每个文件的修改内容', '- 浏览器可将变更写入用户选择的工作区']),
      '',
      '## 说明',
      '- 这是 mock runtime 生成的多文件变更示例。',
      '- 真实 Codex/Claude Runtime 接入后，应由真实代码执行结果替换这些占位修改。',
      '- 每个文件变更都通过 artifact_created.metadata.payload.fileChanges 下发给前端。'
    ].join('\n');
  }

  private markdownExecutionArtifact(input: {
    agentName: string;
    phase: string;
    goal: string;
    taskTitle: string;
    taskDescription: string;
    acceptanceCriteria: string[];
    targetPath?: string;
  }) {
    return [
      `# ${input.taskTitle}`,
      '',
      `执行 Agent：${input.agentName}`,
      `阶段：${input.phase}`,
      '',
      '## 用户需求',
      input.goal,
      '',
      '## 任务说明',
      input.taskDescription,
      '',
      '## 验收标准',
      ...(input.acceptanceCriteria.length
        ? input.acceptanceCriteria.map((item: string) => `- ${item}`)
        : ['- 产物与用户需求直接相关。', '- 前端可以展示执行结果。']),
      '',
      '## 结果',
      input.targetPath
        ? `- 已为工作区文件 ${input.targetPath} 生成 mock 执行说明：${input.goal}`
        : `- 已为该需求生成本地阶段产物：${input.goal}`,
      '- 前端通过 artifact_created.metadata.payload.fileChanges 接收本文件。',
      '- 用户确认后，浏览器会把文件写入所选本地工作区。',
      '',
      '## 复盘提示',
      `- 检查该产物是否仍符合原始需求：${input.goal}`,
      input.targetPath
        ? '- 接入真实代码 Runtime 后，应使用精确代码修改替换当前 mock 说明。'
        : '- 如需精确仓库代码修改，请启用真实代码 Runtime 并提供目标路径。'
    ].join('\n');
  }

  private updatedWorkspaceFileContent(input: {
    originalContent: string;
    path: string;
    agentName: string;
    phase: string;
    goal: string;
    taskTitle: string;
    taskDescription: string;
    acceptanceCriteria: string[];
  }) {
    const note = [
      `执行 Agent：${input.agentName}`,
      `阶段：${input.phase}`,
      `用户需求：${input.goal}`,
      `任务：${input.taskTitle}`,
      `说明：${input.taskDescription}`,
      `验收：${input.acceptanceCriteria.join('；') || '产物可审查且与需求相关。'}`,
      'Mock runtime note: replace this with exact code edits when a real coding runtime is enabled.'
    ];
    const extension = input.path.toLowerCase().split('.').at(-1) ?? '';
    const comment =
      extension === 'css' || extension === 'scss' || extension === 'ts' || extension === 'tsx' || extension === 'js' || extension === 'jsx'
        ? ['/*', ...note.map((line) => ` * ${line}`), ' */'].join('\n')
        : extension === 'vue'
          ? ['<!--', ...note.map((line) => `  ${line}`), '-->'].join('\n')
          : this.markdownExecutionArtifact({
              agentName: input.agentName,
              phase: input.phase,
              goal: input.goal,
              taskTitle: input.taskTitle,
              taskDescription: input.taskDescription,
              acceptanceCriteria: input.acceptanceCriteria,
              targetPath: input.path
            });
    return [input.originalContent.trimEnd(), '', comment, ''].filter(Boolean).join('\n');
  }

  private executionFileArtifact(input: AgentRunInput) {
    const taskTitle = input.contextPack.currentTask?.title ?? input.contextPack.sessionGoal;
    const fileName = this.safeFileName(taskTitle);
    const path = `agent-output/${fileName}.md`;
    const content = [
      `# ${taskTitle}`,
      '',
      `执行 Agent：${input.agent.name}`,
      `阶段：${input.phase}`,
      '',
      '## 需求目标',
      input.contextPack.sessionGoal,
      '',
      '## 执行说明',
      input.contextPack.currentTask?.description ?? '根据已确认任务契约生成执行产物。',
      '',
      '## 验收标准',
      ...(input.contextPack.currentTask?.acceptanceCriteria?.length
        ? input.contextPack.currentTask.acceptanceCriteria.map((item: string) => `- ${item}`)
        : ['- 产物可被用户查看', '- 执行结果可被复盘 Agent 校验']),
      '',
      '## 结果',
      '- 已生成本文件作为具体交付产物。',
      '- 文件通过 artifact_created 事件下发给前端，并由浏览器写入用户选择的本地工作目录。',
      '',
      '## 后续建议',
      '- 检查本文件内容是否符合预期。',
      '- 如需代码级修改，请在需求中明确目标文件、技术栈和验收方式。'
    ].join('\n');

    return {
      type: 'markdown',
      title: `${taskTitle} 执行产物`,
      content,
      summary: `已生成 ${path}`,
      metadata: {
        fileChanges: [
          {
            path,
            operation: 'create',
            content,
            encoding: 'utf-8'
          }
        ]
      }
    } satisfies import('@agent-cluster/shared').RuntimeArtifactOutput;
  }

  private goal(input: AgentRunInput) {
    return input.contextPack.taskBrief?.goal || input.contextPack.sessionGoal || 'Untitled requirement';
  }

  private shortText(value: string, maxLength: number) {
    const normalized = value.trim().replace(/\s+/g, ' ');
    return normalized.length > maxLength ? `${normalized.slice(0, Math.max(0, maxLength - 3))}...` : normalized;
  }

  private safeFileName(value: string) {
    return (
      value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64) || `task-${Date.now()}`
    );
  }

  private usageFor(input: AgentRunInput, output?: RuntimeOutput): RuntimeUsage {
    const inputTokens = Math.max(1, estimateTokens({ contextPack: input.contextPack, expectedOutput: input.expectedOutput }));
    const outputTokens = output ? Math.max(1, estimateTokens(output)) : 1;
    return {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      model: 'mock'
    };
  }
}
