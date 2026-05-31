import { Injectable } from '@nestjs/common';
import type {
  AgentMessageOutput,
  AgentRunInput,
  AgentRunResult,
  ArtifactType,
  FinalDeliveryOutput,
  PostReviewReportOutput,
  ResolvedRuntimeModel,
  RuntimeArtifactOutput,
  RuntimeOutput,
  RuntimeUsage,
  SuggestedAgentTask,
  TaskBriefOutput,
  TaskExecutionResultOutput
} from '@agent-cluster/shared';
import { genericLlmMockFallbackEnabled } from '../../common/runtime-config.js';
import { nowIso } from '../../common/time.js';
import { MockRuntimeService } from './mock-runtime.service.js';

@Injectable()
export class GenericLlmRuntimeService {
  constructor(private readonly mockRuntime: MockRuntimeService) {}

  async run(input: AgentRunInput, credential?: string): Promise<AgentRunResult> {
    if (genericLlmMockFallbackEnabled()) {
      return this.runFallback(input);
    }

    const model = input.model;
    if (!model) {
      return this.failedResult(input, nowIso(), 'GenericLlmRuntime missing resolved model configuration.');
    }

    const missingConfig = this.missingConfig(model, credential);
    if (missingConfig.length) {
      return this.failedResult(input, nowIso(), `GenericLlmRuntime missing required config: ${missingConfig.join(', ')}`);
    }

    return this.runOpenAiCompatible(input, model, credential);
  }

  private async runFallback(input: AgentRunInput): Promise<AgentRunResult> {
    const result = await this.mockRuntime.run(input);
    return {
      ...result,
      runtimeType: 'generic_llm',
      events: result.events.map((event) => ({
        ...event,
        content: event.content.replace(input.agent.name, `${input.agent.name} GenericLlmRuntime fallback`)
      })),
      usage: {
        ...result.usage,
        model: input.model?.upstreamModel ?? 'mock-generic-llm'
      }
    };
  }

  private async runOpenAiCompatible(
    input: AgentRunInput,
    model: ResolvedRuntimeModel,
    credential: string | undefined
  ): Promise<AgentRunResult> {
    const startedAt = nowIso();

    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (credential) {
        headers.authorization = `Bearer ${credential}`;
      }
      const response = await fetch(this.chatCompletionsUrl(model), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: model.upstreamModel,
          temperature: model.defaults?.temperature ?? 0.2,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content: [
                input.agent.systemPrompt,
                'Return only valid JSON matching the requested RuntimeOutput kind.',
                `Expected kind: ${input.expectedOutput.kind}`,
                'Do not call tools, modify files, or perform external side effects.'
              ].join('\n')
            },
            {
              role: 'user',
              content: JSON.stringify({
                phase: input.phase,
                expectedOutput: input.expectedOutput,
                contextPack: input.contextPack,
                budget: input.budget
              })
            }
          ]
        })
      });

      if (!response.ok) {
        throw new Error(`LLM request failed: ${response.status}`);
      }

      const body = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
        model?: string;
      };
      const content = body.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error('LLM response did not include message content');
      }

      const parsed = JSON.parse(content) as { kind?: string };
      // Local models often omit the `kind` discriminator. We already requested a specific kind,
      // so assume it when absent and only reject an explicit, mismatched kind.
      if (parsed.kind && parsed.kind !== input.expectedOutput.kind) {
        throw new Error(`Expected ${input.expectedOutput.kind}, got ${String(parsed.kind)}`);
      }

      // Local models routinely omit required fields or return wrong shapes. Normalize the parsed
      // payload to the contract so downstream consumers never hit `undefined.length` / `.map`.
      const output = normalizeRuntimeOutput(parsed, input.expectedOutput.kind);

      return {
        runId: input.runId,
        runtimeType: 'generic_llm',
        status: 'completed',
        output,
        events: [
          {
            runId: input.runId,
            type: 'runtime_started',
            content: `${input.agent.name} GenericLlmRuntime started ${input.phase}`,
            createdAt: startedAt
          },
          {
            runId: input.runId,
            type: 'runtime_completed',
            content: `${input.agent.name} GenericLlmRuntime completed ${input.phase}`,
            createdAt: nowIso()
          }
        ],
        artifacts: [],
        usage: this.toUsage(body.usage, body.model ?? model.upstreamModel)
      };
    } catch (error) {
      return this.failedResult(input, startedAt, error instanceof Error ? error.message : String(error));
    }
  }

  private missingConfig(model: ResolvedRuntimeModel, credential: string | undefined) {
    const missing: string[] = [];
    if (!model.baseUrl?.trim()) {
      missing.push('baseUrl');
    }
    if (model.source === 'official' && !credential?.trim()) {
      missing.push('apiKey');
    }
    return missing;
  }

  private chatCompletionsUrl(model: ResolvedRuntimeModel) {
    const baseUrl = model.baseUrl.replace(/\/$/, '');
    return `${baseUrl}/chat/completions`;
  }

  private failedResult(input: AgentRunInput, startedAt: string, message: string): AgentRunResult {
    return {
      runId: input.runId,
      runtimeType: 'generic_llm',
      status: 'failed',
      output: {
        kind: 'agent_message',
        messageKind: 'risk',
        content: `GenericLlmRuntime failed during ${input.phase}.`
      } satisfies AgentMessageOutput,
      events: [
        {
          runId: input.runId,
          type: 'runtime_started',
          content: `${input.agent.name} GenericLlmRuntime started ${input.phase}`,
          createdAt: startedAt
        },
        {
          runId: input.runId,
          type: 'runtime_failed',
          content: `${input.agent.name} GenericLlmRuntime failed ${input.phase}`,
          metadata: { message },
          createdAt: nowIso()
        }
      ],
      artifacts: [],
      usage: this.toUsage(undefined, input.model?.upstreamModel),
      error: {
        code: 'MODEL_ERROR',
        message,
        retryable: true
      }
    };
  }

  private toUsage(
    usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined,
    model: string | undefined
  ): RuntimeUsage {
    return {
      inputTokens: usage?.prompt_tokens ?? 0,
      outputTokens: usage?.completion_tokens ?? 0,
      totalTokens: usage?.total_tokens ?? 0,
      model
    };
  }
}

function normalizeRuntimeOutput(raw: { kind?: string }, expectedKind: RuntimeOutput['kind']): RuntimeOutput {
  const value = raw as Record<string, unknown>;
  switch (expectedKind) {
    case 'task_brief':
      return {
        kind: 'task_brief',
        goal: asString(value.goal),
        scope: asStringArray(value.scope),
        outOfScope: asStringArray(value.outOfScope),
        constraints: asStringArray(value.constraints),
        acceptanceCriteria: asStringArray(value.acceptanceCriteria),
        risks: asStringArray(value.risks),
        openQuestions: asStringArray(value.openQuestions),
        suggestedTasks: asArray(value.suggestedTasks).map(normalizeSuggestedTask)
      } satisfies TaskBriefOutput;
    case 'task_execution_result':
      return {
        kind: 'task_execution_result',
        status: asEnum(value.status, ['completed', 'failed', 'blocked', 'needs_review'] as const, 'completed'),
        summary: asString(value.summary),
        completedItems: asStringArray(value.completedItems),
        changedArtifacts: asArray(value.changedArtifacts).map(normalizeArtifact),
        nextSuggestedActions: asStringArray(value.nextSuggestedActions),
        risks: asStringArray(value.risks)
      } satisfies TaskExecutionResultOutput;
    case 'post_review_report':
      return {
        kind: 'post_review_report',
        isConsistentWithBrief: value.isConsistentWithBrief === true,
        matchedItems: asStringArray(value.matchedItems),
        mismatchedItems: asStringArray(value.mismatchedItems),
        missingItems: asStringArray(value.missingItems),
        outOfScopeChanges: asStringArray(value.outOfScopeChanges),
        testResults: asStringArray(value.testResults),
        recommendation: asEnum(value.recommendation, ['deliver', 'rework', 'ask_user'] as const, 'deliver')
      } satisfies PostReviewReportOutput;
    case 'final_delivery':
      return {
        kind: 'final_delivery',
        summary: asString(value.summary),
        completedItems: asStringArray(value.completedItems),
        incompleteItems: asStringArray(value.incompleteItems),
        risks: asStringArray(value.risks),
        artifactRefs: asStringArray(value.artifactRefs)
      } satisfies FinalDeliveryOutput;
    case 'agent_message':
      // Preserve any extra fields the caller's jsonSchema asked for (e.g. answer / references,
      // relevant / response, taskTitle used by interactive user-message routing) while still
      // normalizing the standard chat fields. Without the spread these custom fields are dropped
      // and downstream handlers read `undefined`.
      return {
        ...value,
        kind: 'agent_message',
        messageKind: asEnum(
          value.messageKind,
          ['discussion', 'answer', 'handoff', 'progress', 'risk', 'decision', 'summary'] as const,
          'discussion'
        ),
        content: asString(value.content),
        mentionedAgentIds: asStringArray(value.mentionedAgentIds),
        relatedTaskIds: asStringArray(value.relatedTaskIds)
      } as AgentMessageOutput;
    default:
      // Unknown / deterministically-produced kinds (e.g. user_message_handling_plan) pass through
      // with the requested kind applied.
      return { ...value, kind: expectedKind } as RuntimeOutput;
  }
}

function normalizeSuggestedTask(raw: unknown): SuggestedAgentTask {
  const value = (raw ?? {}) as Record<string, unknown>;
  return {
    title: asString(value.title),
    description: asString(value.description),
    suggestedAgentKey: typeof value.suggestedAgentKey === 'string' ? value.suggestedAgentKey : undefined,
    dependsOnTaskTitles: asStringArray(value.dependsOnTaskTitles),
    acceptanceCriteria: asStringArray(value.acceptanceCriteria)
  };
}

function normalizeArtifact(raw: unknown): RuntimeArtifactOutput {
  const value = (raw ?? {}) as Record<string, unknown>;
  return {
    type: asString(value.type, 'markdown') as ArtifactType,
    title: asString(value.title),
    content: typeof value.content === 'string' ? value.content : undefined,
    uri: typeof value.uri === 'string' ? value.uri : undefined,
    summary: typeof value.summary === 'string' ? value.summary : undefined,
    metadata: isPlainObject(value.metadata) ? value.metadata : undefined
  };
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function asArray<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function asEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
