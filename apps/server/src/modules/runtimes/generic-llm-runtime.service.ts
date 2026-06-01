import { Injectable } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type {
  AgentMessageOutput,
  AgentRunInput,
  AgentRunResult,
  ArtifactType,
  FinalDeliveryOutput,
  PostReviewReportOutput,
  ProposedFileWrite,
  ResolvedRuntimeModel,
  RuntimeArtifactOutput,
  RuntimeOutput,
  RuntimeUsage,
  SuggestedAgentTask,
  TaskBriefOutput,
  TaskExecutionResultOutput
} from '@agent-cluster/shared';
import { genericLlmMockFallbackEnabled, resolveWorkspaceRoot } from '../../common/runtime-config.js';
import { nowIso } from '../../common/time.js';
import { MockRuntimeService } from './mock-runtime.service.js';
import { ToolExecutorService, type ToolExecutionRequest, type ToolName } from './tool-executor.service.js';

// 把能力 key 映射到受控工具名。只有当 Agent 拥有对应能力（且通过高危闸门）时才会向 LLM 暴露工具，
// 真正执行仍由 ToolExecutorService 在工作区沙箱内、按能力策略 + 环境闸门把关——LLM 只能“请求”。
const toolByCapabilityKey: Record<string, ToolName> = {
  'tool.file_write': 'file_write',
  'tool.command_run': 'command_run',
  'tool.run_test': 'run_test',
  'tool.git_diff': 'git_diff'
};

@Injectable()
export class GenericLlmRuntimeService {
  constructor(
    private readonly mockRuntime: MockRuntimeService,
    private readonly toolExecutor: ToolExecutorService
  ) {}

  async run(input: AgentRunInput, credential?: string, signal?: AbortSignal): Promise<AgentRunResult> {
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

    return this.runOpenAiCompatible(input, model, credential, signal);
  }

  /** 任务执行阶段，Agent 拥有的受控工具（已按能力策略/高危闸门过滤）。其它阶段不暴露工具。 */
  private availableTools(input: AgentRunInput): ToolName[] {
    if (input.phase !== 'task_execution') {
      return [];
    }
    const tools = new Set<ToolName>();
    for (const capability of input.contextPack.capabilities ?? []) {
      const tool = toolByCapabilityKey[capability.key];
      if (tool) {
        tools.add(tool);
      }
    }
    return [...tools];
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
    credential: string | undefined,
    signal: AbortSignal | undefined
  ): Promise<AgentRunResult> {
    const startedAt = nowIso();
    const tools = this.availableTools(input);

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
                ...this.toolSystemLines(tools)
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

      const parsed = parseLooseJson(content) as { kind?: string };
      // Local models often omit the `kind` discriminator. We already requested a specific kind,
      // so assume it when absent and only reject an explicit, mismatched kind.
      if (parsed.kind && parsed.kind !== input.expectedOutput.kind) {
        throw new Error(`Expected ${input.expectedOutput.kind}, got ${String(parsed.kind)}`);
      }

      // Local models routinely omit required fields or return wrong shapes. Normalize the parsed
      // payload to the contract so downstream consumers never hit `undefined.length` / `.map`.
      const output = normalizeRuntimeOutput(parsed, input.expectedOutput.kind);

      // 若本阶段暴露了工具且 LLM 请求了工具：file_write 仅作为「提案」收集(不落盘),交由编排器
      // 暂停到 WAIT_USER_DECISION 让用户确认后再写;其余工具(命令/测试/diff)仍即时执行。
      const toolOutcome = tools.length
        ? await this.runToolRequests(parsed, tools, input, signal)
        : { artifacts: [], proposedWrites: [] };
      if (output.kind === 'task_execution_result' && toolOutcome.artifacts.length) {
        output.changedArtifacts = [...output.changedArtifacts, ...toolOutcome.artifacts];
      }

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
        artifacts: toolOutcome.artifacts,
        proposedWrites: toolOutcome.proposedWrites,
        usage: this.toUsage(body.usage, body.model ?? model.upstreamModel)
      };
    } catch (error) {
      return this.failedResult(input, startedAt, error instanceof Error ? error.message : String(error));
    }
  }

  /** Builds the tool-availability lines of the system prompt: forbid side effects unless tools are offered. */
  private toolSystemLines(tools: ToolName[]): string[] {
    if (!tools.length) {
      return ['Do not call tools, modify files, or perform external side effects.'];
    }
    return [
      `You may perform real work by requesting controlled tools: ${tools.join(', ')}.`,
      'To request tools, add a top-level "toolRequests" array to your JSON, alongside the normal output fields.',
      'Each item shape: file_write {"tool":"file_write","path":"<workspace-relative>","content":"...","summary":"..."},',
      'command_run {"tool":"command_run","command":"...","args":["..."]},',
      'run_test {"tool":"run_test","command":"...","args":["..."]},',
      'git_diff {"tool":"git_diff","staged":false}.',
      'Paths must stay inside the agent workspace; do not invent tools beyond the listed ones.',
      'If no real action is needed, return an empty toolRequests array.'
    ];
  }

  /**
   * Parses any toolRequests the model returned. file_write requests become user-confirmation
   * proposals (read current content for diff, never write here); other tools execute immediately.
   */
  private async runToolRequests(
    parsed: unknown,
    tools: ToolName[],
    input: AgentRunInput,
    signal: AbortSignal | undefined
  ): Promise<{ artifacts: RuntimeArtifactOutput[]; proposedWrites: ProposedFileWrite[] }> {
    const value = parsed as { toolRequests?: unknown };
    const requests = Array.isArray(value.toolRequests) ? value.toolRequests : [];
    const allowed = new Set(tools);
    const artifacts: RuntimeArtifactOutput[] = [];
    const proposedWrites: ProposedFileWrite[] = [];
    for (const raw of requests) {
      const request = this.asToolRequest(raw, allowed);
      if (!request) {
        continue;
      }
      if (request.tool === 'file_write') {
        proposedWrites.push(await this.toProposedWrite(request, input));
        continue;
      }
      const result = await this.toolExecutor.execute(request, {
        runId: input.runId,
        sessionId: input.sessionId,
        taskId: input.taskId,
        agentId: input.agent.id,
        agentKey: input.agent.key,
        workspaceRoot: input.workspaceDir,
        signal
      });
      if (result.artifact) {
        artifacts.push(result.artifact);
      }
    }
    return { artifacts, proposedWrites };
  }

  /** Turns a file_write request into a confirmation proposal, reading any existing file content for diff preview. */
  private async toProposedWrite(
    request: Extract<ToolExecutionRequest, { tool: 'file_write' }>,
    input: AgentRunInput
  ): Promise<ProposedFileWrite> {
    const root = resolveWorkspaceRoot(input.workspaceDir);
    let previousContent: string | undefined;
    try {
      previousContent = await readFile(resolve(root, request.path), 'utf8');
    } catch {
      previousContent = undefined;
    }
    return {
      path: request.path,
      content: request.content,
      summary: request.summary,
      previousContent
    };
  }

  /** Validates a single model-provided tool request against the allowed tool set. */
  private asToolRequest(raw: unknown, allowed: Set<ToolName>): ToolExecutionRequest | undefined {
    if (!isPlainObject(raw)) {
      return undefined;
    }
    const tool = raw.tool;
    if (typeof tool !== 'string' || !allowed.has(tool as ToolName)) {
      return undefined;
    }
    switch (tool) {
      case 'file_write':
        if (typeof raw.path !== 'string' || typeof raw.content !== 'string') {
          return undefined;
        }
        return {
          tool: 'file_write',
          path: raw.path,
          content: raw.content,
          summary: typeof raw.summary === 'string' ? raw.summary : undefined
        };
      case 'command_run':
        if (typeof raw.command !== 'string') {
          return undefined;
        }
        return { tool: 'command_run', command: raw.command, args: asStringArray(raw.args) };
      case 'run_test':
        return {
          tool: 'run_test',
          command: typeof raw.command === 'string' ? raw.command : undefined,
          args: asStringArray(raw.args)
        };
      case 'git_diff':
        return { tool: 'git_diff', pathspec: asStringArray(raw.pathspec), staged: raw.staged === true };
      default:
        return undefined;
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

/**
 * 本地模型常把 JSON 包在 ```json 围栏里,或在 JSON 前后追加说明文字,直接 JSON.parse 会抛错,
 * 进而让整个阶段(如简报生成)失败、会话变 FAILED。这里先尝试直接解析,失败再依次尝试剥离 markdown
 * 围栏、截取首个 {...} 片段,尽量从脏输出中恢复出可用 JSON;全部失败时仍抛出最后一次解析错误。
 */
function parseLooseJson(content: string): unknown {
  const trimmed = content.trim();
  const candidates = [trimmed];

  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch?.[1]) {
    candidates.push(fenceMatch[1].trim());
  }

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Failed to parse LLM JSON output');
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
