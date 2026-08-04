import { Injectable } from '@nestjs/common';
import type {
  AgentMessageOutput,
  AgentRunResult,
  AgentRuntimeAdapter,
  AgentRuntimeRunHandle,
  FinalDeliveryOutput,
  FileRevisionCandidateOutput,
  InvocationPlan,
  PostReviewReportOutput,
  RuntimeArtifactOutput,
  RuntimeContextRequest,
  RuntimeOutput,
  RuntimeUsage,
  TaskAcceptanceDecisionOutput,
  TaskBriefOutput,
  TaskExecutionResultOutput,
  UserMessageHandlingPlanOutput
} from '@agent-cluster/shared';
import {
  createAgentMessageOutput,
  createRuntimeArtifactSystemEvidence,
  createRuntimeArtifactOutput,
  emptyRuntimeArtifactProposalMetadata
} from '@agent-cluster/shared';
import { nowIso } from '../../common/time.js';
import { promiseHandle } from './promise-run-handle.js';
import { withStructuredTermination } from './structured-termination-run-handle.js';

@Injectable()
export class MockRuntimeService implements AgentRuntimeAdapter {
  readonly type = 'mock' as const;
  readonly metadata = {
    name: 'mock',
    version: '2.0.0',
    category: 'internal' as const,
    provider: 'agent-cluster',
    capabilityIds: [] as const,
    supportedWorkspaceCapabilities: ['read', 'write', 'command', 'test'] as const,
    supportedToolNames: ['read_file', 'search_code', 'write_file', 'run_test'] as const
  };
  private readonly contextFailures = new Map<string, number>();

  async checkAvailability() {
    return { available: process.env.MOCK_RUNTIME_ENABLED === 'true', reason: 'Explicit mock mode is disabled.' };
  }

  start(input: InvocationPlan, signal?: AbortSignal): AgentRuntimeRunHandle {
    return withStructuredTermination(promiseHandle(this.execute(input, signal)), input, signal);
  }

  private async execute(input: InvocationPlan, signal?: AbortSignal): Promise<AgentRunResult> {
    const startedAt = nowIso();
    await this.optionalDelay(signal);
    if (process.env.MOCK_RUNTIME_ENABLED !== 'true') {
      return this.failed(input, 'CAPABILITY_BLOCKED', 'Mock Runtime is disabled.', false, startedAt);
    }
    if (signal?.aborted) {
      return this.failed(input, 'RUNTIME_CANCELLED', 'Runtime request cancelled.', false, startedAt, 'cancelled');
    }
    if (this.shouldRequestContext(input)) {
      return this.contextInsufficient(input, startedAt);
    }
    if (this.isForcedSmokeFailure(input)) {
      return this.failed(input, 'MODEL_ERROR', 'Forced Mock Runtime smoke failure.', false, startedAt);
    }

    const output = this.outputFor(input);
    const artifacts = output.kind === 'task_execution_result' ? output.changedArtifacts : [];
    const usage = this.usageFor(input, output);
    return {
      invocationId: input.invocationId,
      runtimeType: this.type,
      status: 'completed',
      output,
      events: [
        {
          invocationId: input.invocationId,
          type: 'runtime_started',
          visibility: 'user',
          content: `${input.agent.name} started ${input.phase}`,
          createdAt: startedAt
        },
        ...artifacts.map((artifact) => ({
          invocationId: input.invocationId,
          type: 'artifact_created' as const,
          visibility: 'user' as const,
          content: artifact.title,
          metadata: { artifact },
          createdAt: nowIso()
        })),
        {
          invocationId: input.invocationId,
          type: 'runtime_completed',
          visibility: 'user',
          content: `${input.agent.name} completed ${input.phase}`,
          createdAt: nowIso()
        }
      ],
      artifacts,
      systemEvidence: createRuntimeArtifactSystemEvidence(input.invocationId),
      usage
    };
  }

  private outputFor(input: InvocationPlan): RuntimeOutput {
    const goal = input.contextEnvelope.L1.sessionGoal || 'Untitled requirement';
    const task = input.contextEnvelope.L1.task;
    const taskTitle = task?.title ?? goal;
    switch (input.expectedOutput.kind) {
      case 'task_brief':
        return this.taskBrief(goal);
      case 'task_acceptance_decision':
        return this.acceptance(input, taskTitle);
      case 'task_execution_result':
        return this.execution(input, goal, taskTitle);
      case 'file_revision_candidate':
        return this.fileRevisionCandidate(input);
      case 'post_review_report':
        return this.postReview();
      case 'final_delivery':
        return {
          schemaVersion: '1.0',
          kind: 'final_delivery',
          summary: `Completed: ${goal}`,
          completedItems: ['Task contract confirmed', 'Execution completed', 'Post Review completed'],
          incompleteItems: [],
          risks: [],
          artifactRefs: []
        } satisfies FinalDeliveryOutput;
      case 'user_message_handling_plan':
        return {
          schemaVersion: '1.0',
          kind: 'user_message_handling_plan',
          intent: 'constraint',
          requirementRelation: 'continuation',
          failedExecutionAction: 'none',
          priority: 'normal',
          shouldPause: false,
          affectedTaskIds: input.taskId ? [input.taskId] : [],
          affectedAgentIds: [input.agent.agentId],
          requiresBriefRevision: false,
          requiresUserConfirmation: false,
          coordinatorInstruction: 'Apply the new constraint to the current invocation.'
        } satisfies UserMessageHandlingPlanOutput;
      default:
        return createAgentMessageOutput({
          messageKind: 'discussion',
          content: `${input.agent.name} completed ${input.phase}. Goal: ${goal}`
        }) satisfies AgentMessageOutput;
    }
  }

  private taskBrief(goal: string): TaskBriefOutput {
    return {
      schemaVersion: '1.0',
      kind: 'task_brief',
      goal,
      scope: ['Implement the confirmed requirement'],
      outOfScope: ['Unapproved external side effects'],
      constraints: ['Use the resolved Tool Catalog', 'Keep evidence traceable'],
      acceptanceCriteria: ['Return a structured result', 'Complete Post Review'],
      risks: [],
      openQuestions: [],
      suggestedTasks: [
        {
          title: 'Execute the confirmed task',
          description: goal,
          suggestedAgentKey: 'backend',
          routingMode: 'coordinator_controlled',
          assignmentReason: null,
          contextRequirements: [],
          verificationPlan: [],
          riskNotes: [],
          requiresUserConfirmation: false,
          dependsOnTaskTitles: [],
          acceptanceCriteria: ['Produce a reviewable execution artifact']
        }
      ]
    };
  }

  private fileRevisionCandidate(input: InvocationPlan): FileRevisionCandidateOutput {
    const evidence = input.contextEnvelope.L3.fileRevisions?.[0];
    if (!evidence || !evidence.complete || evidence.truncated) {
      throw new Error('REVISION_CONTEXT_INCOMPLETE: Mock Runtime requires complete revision evidence.');
    }
    return {
      schemaVersion: '1.0',
      kind: 'file_revision_candidate',
      revisionId: evidence.revisionId,
      chainId: evidence.chainId,
      iteration: evidence.iteration,
      sourceDraftHash: evidence.userDraft.hash,
      evidenceHash: evidence.evidenceHash,
      content: evidence.userDraft.content,
      summary: 'Receiver preserved the complete authoritative user draft.',
      incorporatedAgentResultIds: (evidence.agentResults ?? [])
        .filter((result) => result.status === 'completed')
        .map((result) => result.id),
      unresolvedConflicts: []
    };
  }

  private acceptance(input: InvocationPlan, taskTitle: string): TaskAcceptanceDecisionOutput {
    const rejected = new Set(
      (process.env.MOCK_REJECT_ACCEPTANCE_AGENT_KEYS ?? '').split(',').map((item) => item.trim()).filter(Boolean)
    );
    if (rejected.has(input.agent.key)) {
      return {
        schemaVersion: '1.0',
        kind: 'task_acceptance_decision',
        status: 'rejected',
        reason: `${input.agent.name} cannot accept ${taskTitle}.`,
        missingContext: [],
        requestedContext: null,
        handoffSuggestion: null,
        confidence: null,
        alternativeAgentKeys: ['coordinator'],
        alternativeAgentIds: [],
        agentMessages: []
      };
    }
    return {
      schemaVersion: '1.0',
      kind: 'task_acceptance_decision',
      status: 'accepted',
      reason: `${input.agent.name} accepts ${taskTitle}.`,
      missingContext: [],
      requestedContext: null,
      handoffSuggestion: null,
      confidence: 0.9,
      alternativeAgentKeys: [],
      alternativeAgentIds: [],
      agentMessages: []
    };
  }

  private execution(input: InvocationPlan, goal: string, taskTitle: string): TaskExecutionResultOutput {
    const artifact = this.executionArtifact(input, goal, taskTitle);
    return {
      schemaVersion: '1.0',
      kind: 'task_execution_result',
      status: 'completed',
      summary: `${input.agent.name} completed ${taskTitle}.`,
      completedItems: ['Read the authoritative Context Envelope', 'Produced a deterministic mock artifact'],
      changedArtifacts: [artifact],
      requestedContext: null,
      agentMessages: [],
      nextSuggestedActions: ['Run Post Review'],
      risks: []
    };
  }

  private executionArtifact(input: InvocationPlan, goal: string, taskTitle: string): RuntimeArtifactOutput {
    const revisionEvidence = input.contextEnvelope.L3.fileRevisions?.[0];
    if (revisionEvidence) {
      if (!revisionEvidence.complete || revisionEvidence.truncated) {
        throw new Error('REVISION_CONTEXT_INCOMPLETE: Mock Runtime requires complete revision evidence.');
      }
      const content = revisionEvidence.userDraft.content;
      return createRuntimeArtifactOutput({
        type: 'markdown',
        title: `${taskTitle} file revision proposal`,
        content,
        summary: `Proposed an update to ${revisionEvidence.filePath}`,
        metadata: {
          ...emptyRuntimeArtifactProposalMetadata(),
          fileChanges: [
            {
              path: revisionEvidence.filePath,
              operation: 'update',
              content,
              previousContent: revisionEvidence.base.content,
              encoding: 'utf-8',
              source: 'runtime_proposed_change'
            }
          ]
        }
      });
    }
    if (this.isArchitectureAgent(input)) {
      return this.architectureArtifact(input, goal);
    }
    const path = `agent-output/${safeFileName(taskTitle)}.md`;
    const content = [
      `# ${taskTitle}`,
      '',
      `Agent: ${input.agent.name}`,
      `Goal: ${goal}`,
      `Profile: ${input.agent.profileHash}`,
      `Tool Catalog: ${input.toolCatalog.catalogHash}`,
      '',
      'Mock execution completed.'
    ].join('\n');
    return createRuntimeArtifactOutput({
      type: 'markdown',
      title: `${taskTitle} execution artifact`,
      content,
      summary: `Generated ${path}`,
      metadata: {
        ...emptyRuntimeArtifactProposalMetadata(),
        fileChanges: [
          {
            path,
            operation: 'create',
            content,
            previousContent: null,
            encoding: 'utf-8',
            source: 'runtime_proposed_change'
          }
        ]
      }
    });
  }

  private isArchitectureAgent(input: InvocationPlan) {
    return input.agent.key === 'architect' || input.agent.role.toLowerCase().includes('architect');
  }

  private architectureArtifact(input: InvocationPlan, goal: string): RuntimeArtifactOutput {
    const path = 'agent-output/project-architecture-analysis.md';
    const evidencePaths = input.contextEnvelope.L3.files.map((file) => file.path);
    const detectedStack = input.contextEnvelope.L2.detectedStack ?? [];
    const content = [
      '# 项目架构分析报告',
      '',
      `Workspace: ${input.contextEnvelope.L0.workspace.rootName}`,
      `Goal: ${goal}`,
      `技术栈: ${detectedStack.length ? detectedStack.join('、') : '未识别'}`,
      '',
      '## 当前源码证据',
      ...(evidencePaths.length ? evidencePaths.map((evidencePath) => `- ${evidencePath}`) : ['- 无可用源码证据']),
      '',
      '## 主链路',
      '- 入口、配置与数据流模块由 ContextEnvelopeV2 的 L1 navigation 和 L3 正文共同确定。',
      '- Mock Runtime 只回显已选择的证据路径，不推断未提供的源码内容。'
    ].join('\n');
    return createRuntimeArtifactOutput({
      type: 'markdown',
      title: '项目架构分析报告',
      content,
      summary: `Generated ${path} from ${evidencePaths.length} grounded files`,
      metadata: {
        ...emptyRuntimeArtifactProposalMetadata(),
        fileChanges: [
          {
            path,
            operation: 'create',
            content,
            previousContent: null,
            encoding: 'utf-8',
            source: 'runtime_proposed_change'
          }
        ]
      }
    });
  }

  private postReview(): PostReviewReportOutput {
    const recommendation = process.env.MOCK_REVIEW_RECOMMENDATION;
    return {
      schemaVersion: '1.0',
      kind: 'post_review_report',
      isConsistentWithBrief: recommendation !== 'rework',
      matchedItems: ['Invocation used v2 identity, target, Catalog, and Envelope snapshots'],
      mismatchedItems: recommendation === 'rework' ? ['Forced mock rework'] : [],
      missingItems: [],
      outOfScopeChanges: [],
      testResults: ['Deterministic mock validation passed'],
      recommendation: recommendation === 'rework' || recommendation === 'ask_user' ? recommendation : 'deliver',
      actions: []
    };
  }

  private shouldRequestContext(input: InvocationPlan) {
    if (input.phase !== 'task_execution') return false;
    const configured = Number(process.env.MOCK_CONTEXT_INSUFFICIENT_TIMES ?? 0);
    const maxFailures = process.env.MOCK_CONTEXT_INSUFFICIENT === 'true'
      ? Number.POSITIVE_INFINITY
      : process.env.MOCK_CONTEXT_INSUFFICIENT_ONCE === 'true'
        ? 1
        : Number.isFinite(configured) && configured > 0
          ? configured
          : 0;
    const current = this.contextFailures.get(input.sessionId) ?? 0;
    if (current >= maxFailures) return false;
    this.contextFailures.set(input.sessionId, current + 1);
    return true;
  }

  private isForcedSmokeFailure(input: InvocationPlan) {
    return input.contextEnvelope.L5.bullets.includes('Smoke scenario: task_failed');
  }

  private contextInsufficient(input: InvocationPlan, startedAt: string): AgentRunResult {
    const availablePaths = input.contextEnvelope.L1.navigation.entries
      .filter((entry) => entry.kind === 'file' && !entry.sensitive)
      .map((entry) => entry.path);
    const sourcePaths = availablePaths.filter((path) => path.startsWith('src/'));
    const candidates = sourcePaths.length > 0 ? sourcePaths : availablePaths;
    const failureNumber = Math.max(1, this.contextFailures.get(input.sessionId) ?? 1);
    const selectedPath = candidates[(failureNumber - 1) % Math.max(1, candidates.length)];
    const requestedPaths = selectedPath ? [selectedPath] : [];
    const requestedContext: RuntimeContextRequest = {
      reason: 'Mock Runtime requested additional grounded evidence.',
      requestedRefs: [],
      requestedPaths,
      followUpInstruction: 'Read the requested files and resolve a new InvocationPlan.'
    };
    return this.failed(
      input,
      'CONTEXT_INSUFFICIENT',
      requestedContext.reason,
      true,
      startedAt,
      'failed',
      requestedContext
    );
  }

  private failed(
    input: InvocationPlan,
    code: 'CAPABILITY_BLOCKED' | 'RUNTIME_CANCELLED' | 'CONTEXT_INSUFFICIENT' | 'MODEL_ERROR',
    message: string,
    retryable: boolean,
    startedAt: string,
    status: 'failed' | 'cancelled' = 'failed',
    requestedContext?: RuntimeContextRequest
  ): AgentRunResult {
    return {
      invocationId: input.invocationId,
      runtimeType: this.type,
      status,
      output: createAgentMessageOutput({ messageKind: 'risk', content: message }),
      events: [
        {
          invocationId: input.invocationId,
          type: status === 'cancelled' ? 'runtime_failed' : 'runtime_failed',
          visibility: 'user',
          content: message,
          metadata: { code },
          createdAt: startedAt
        }
      ],
      artifacts: [],
      systemEvidence: createRuntimeArtifactSystemEvidence(input.invocationId),
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, model: this.type },
      error: { code, message, retryable, requestedContext }
    };
  }

  private async optionalDelay(signal?: AbortSignal) {
    const delayMs = Number(process.env.MOCK_RUNTIME_DELAY_MS ?? 0);
    if (!Number.isFinite(delayMs) || delayMs <= 0 || signal?.aborted) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delayMs);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }

  private usageFor(input: InvocationPlan, output: RuntimeOutput): RuntimeUsage {
    const inputTokens = Math.max(1, Math.ceil(JSON.stringify(input.contextEnvelope).length / 4));
    const outputTokens = Math.max(1, Math.ceil(JSON.stringify(output).length / 4));
    return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, model: this.type };
  }
}

function safeFileName(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'task';
}
