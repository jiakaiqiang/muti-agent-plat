import { Injectable } from '@nestjs/common';
import type {
  AgentMessageOutput,
  AgentRunInput,
  AgentRunResult,
  AgentRuntimeAdapter,
  RuntimeError,
  RuntimeOutput,
  RuntimeUsage
} from '@agent-cluster/shared';
import {
  genericLlmMockFallbackEnabled,
  llmMaxRetries,
  llmTimeoutMs
} from '../../common/runtime-config.js';
import { nowIso } from '../../common/time.js';
import { MockRuntimeService } from './mock-runtime.service.js';
import { RuntimeModelConfigService, type RuntimeModelConnection } from './runtime-model-config.service.js';

@Injectable()
export class GenericLlmRuntimeService implements AgentRuntimeAdapter {
  readonly type = 'generic_llm' as const;

  constructor(
    private readonly mockRuntime: MockRuntimeService,
    private readonly modelConfig: RuntimeModelConfigService
  ) {}

  async run(input: AgentRunInput, signal?: AbortSignal): Promise<AgentRunResult> {
    const startedAt = nowIso();
    const selectedConnection = this.modelConfig.connectionForModelId(input.agent.modelId);
    if (signal?.aborted) {
      const timeoutMessage = this.upstreamTimeoutMessage(signal);
      return this.failedResult(
        input,
        startedAt,
        selectedConnection.model,
        timeoutMessage ?? 'Runtime request cancelled by user.',
        timeoutMessage ? 'RUNTIME_TIMEOUT' : 'RUNTIME_CANCELLED'
      );
    }

    if (genericLlmMockFallbackEnabled()) {
      return this.runFallback(input, selectedConnection.model, signal);
    }

    const missingConfig = this.missingConfig(selectedConnection);
    if (missingConfig.length) {
      return this.failedResult(
        input,
        startedAt,
        selectedConnection.model,
        `通用大模型未配置（缺少 ${missingConfig.join('、')}），本次执行已中止而不会回退到模拟运行时。请在 .env 设置 LLM_PROVIDER/LLM_MODEL/LLM_API_KEY/LLM_BASE_URL，或在运行时模型管理中添加并选择可用模型；如需本地演示模式，请显式设置 LLM_MOCK_FALLBACK=true。`,
        'CAPABILITY_BLOCKED'
      );
    }

    return this.runOpenAiCompatible(input, selectedConnection, signal);
  }

  private async runFallback(input: AgentRunInput, selectedModel: string, signal?: AbortSignal): Promise<AgentRunResult> {
    const result = await this.mockRuntime.run(
      {
        ...input,
        options: {
          ...(input.options ?? {}),
          allowMockFallback: true
        }
      },
      signal
    );
    return {
      ...result,
      runtimeType: 'generic_llm',
      events: result.events.map((event) => ({
        ...event,
        content: event.content.replace(input.agent.name, `${input.agent.name} GenericLlmRuntime fallback`)
      })),
      usage: {
        ...result.usage,
        model: selectedModel
      }
    };
  }

  private async runOpenAiCompatible(
    input: AgentRunInput,
    selectedConnection: RuntimeModelConnection,
    signal?: AbortSignal
  ): Promise<AgentRunResult> {
    const startedAt = nowIso();
    const selectedModel = selectedConnection.model;
    const maxRetries = llmMaxRetries();
    const timeoutMs = llmTimeoutMs();
    let lastMessage = 'unknown error';
    let lastCode: RuntimeError['code'] = 'MODEL_ERROR';

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const controller = new AbortController();
      let cancelledByUser = false;
      let timedOut = false;
      const onAbort = () => {
        cancelledByUser = true;
        controller.abort();
      };
      if (signal?.aborted) {
        const timeoutMessage = this.upstreamTimeoutMessage(signal);
        return this.failedResult(
          input,
          startedAt,
          selectedModel,
          timeoutMessage ?? 'Runtime request cancelled by user.',
          timeoutMessage ? 'RUNTIME_TIMEOUT' : 'RUNTIME_CANCELLED'
        );
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      try {
        const response = await fetch(this.chatCompletionsUrl(selectedConnection.baseUrl), {
          method: 'POST',
          signal: controller.signal,
          headers: {
            authorization: `Bearer ${selectedConnection.apiKey}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            model: selectedModel,
            temperature: 0.2,
            response_format: { type: 'json_object' },
            messages: [
              {
                role: 'system',
                content: [
                  input.agent.systemPrompt,
                  'Return only valid JSON matching the requested RuntimeOutput kind.',
                  `Expected kind: ${input.expectedOutput.kind}`,
                  'Do not call tools, modify files, or perform external side effects.',
                  'Use contextPack.taskContext as the Task Context Pack: follow its stagePlan read/do/validate items, taskMap, evidenceSelection.selectedRefs/evidenceRefs, validationRules, and agentResponsibilities. Keep conclusions traceable to those fields.',
                  'Use contextPack.projectMap when present as the structured project index; prefer its modules, sourceRefs, validationCommands, and riskBoundaries over guessing project layout.',
                  'Treat taskContext.evidenceSelection.omittedRefs as intentionally excluded context; ask for more evidence instead of inventing details when selected evidence is insufficient.',
                  'When selected evidence is insufficient for the expected output, return the expected JSON kind with status "blocked" when supported, summary explaining the gap, and requestedContext containing reason, requestedRefs, requestedPaths, requestedCommands, and followUpInstruction. Do not fabricate file contents, APIs, test results, or logs.',
                  'Use contextPack.continuationState to resume or hand off work consistently across phases, agents, pauses, validation, review, and final delivery.',
                  'For non-coding tasks, validate fact consistency, scope consistency, traceability, and delivery completeness instead of inventing implementation evidence.',
                  input.contextPack.workspaceSnapshot
                    ? 'Before analyzing the user requirement, inspect contextPack.workspaceSnapshot and contextPack.workspaceFocus. Ground the response in real workspace files and project structure.'
                    : 'No workspace snapshot is available; say when file-level conclusions are assumptions.',
                  'Be specific and useful. Avoid one-sentence generic output; include concrete decisions, assumptions, risks, and next actions.',
                  input.expectedOutput.kind === 'agent_message'
                    ? 'For agent_message, the "content" field must be one plain-text string (never an object or array). Write a detailed Chinese response with 3-6 concise paragraphs or bullets covering understanding, concerns, and recommendations.'
                    : '',
                  input.expectedOutput.kind === 'task_claim_decision'
                    ? 'For task_claim_decision, decide whether this agent should accept the currentTask. Return accepted, reason, optional confidence, optional alternativeAgentKeys/alternativeAgentIds, and optional agentMessages for handoff or coordination.'
                    : '',
                  input.expectedOutput.kind === 'task_execution_result'
                    ? 'For task_execution_result, include changedArtifacts. If this is a validation task or the agent is the Validation Agent, include a test_report artifact with metadata.validationEvidence mapping each taskContext.validationRules item to verdicts and taskContext.evidenceRefs, plus validatorAgentKey, validatorAgentId, and independentFromAgentKeys from taskContext.agentResponsibilities. If workspaceSnapshot is present, analyze the full impact surface and return fileChanges for every real workspace path that must change, especially all relevantFiles. Do not collapse a multi-file requirement into one file. Use agent-output only for auxiliary summaries. Include optional agentMessages when progress, risks, questions, or handoffs should be sent to other agents; target them with targetAgentKeys such as coordinator, frontend, backend, test, review.'
                    : '',
                  input.contextPack.workingDirectory
                    ? 'A local working directory is selected. Return file changes only as RuntimeArtifactOutput.metadata.fileChanges with safe relative paths. The browser applies those changes inside the selected directory.'
                    : 'No local working directory is selected. Do not return fileChanges.'
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
          const retryable = response.status >= 500 || response.status === 429;
          throw Object.assign(new Error(`LLM request failed: ${response.status}`), { retryable });
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

        // Output schema problems are not retryable: a retry would produce the same shape.
        let output: RuntimeOutput;
        try {
          output = JSON.parse(content) as RuntimeOutput;
        } catch {
          return this.failedResult(input, startedAt, selectedModel, 'LLM response was not valid JSON', 'OUTPUT_SCHEMA_INVALID');
        }
        if (output.kind !== input.expectedOutput.kind) {
          return this.failedResult(
            input,
            startedAt,
            selectedModel,
            `Expected ${input.expectedOutput.kind}, got ${String(output.kind)}`,
            'OUTPUT_SCHEMA_INVALID'
          );
        }
        output = this.normalizeOutput(output);

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
          usage: this.toUsage(body.usage, selectedModel)
        };
      } catch (error) {
        const isAbort = error instanceof Error && (error.name === 'AbortError' || Boolean(signal?.aborted));
        const upstreamTimeoutMessage = this.upstreamTimeoutMessage(signal);
        const wasUpstreamTimeout = isAbort && Boolean(upstreamTimeoutMessage);
        const wasUserCancelled = isAbort && !wasUpstreamTimeout && (cancelledByUser || signal?.aborted);
        lastCode =
          wasUserCancelled ? 'RUNTIME_CANCELLED' : isAbort && (timedOut || wasUpstreamTimeout) ? 'RUNTIME_TIMEOUT' : 'MODEL_ERROR';
        lastMessage = wasUserCancelled
          ? 'Runtime request cancelled by user.'
          : wasUpstreamTimeout
            ? (upstreamTimeoutMessage ?? 'Runtime timed out.')
            : isAbort && timedOut
            ? `LLM request timed out after ${timeoutMs}ms`
            : error instanceof Error
              ? error.message
              : String(error);
        const retryable =
          !wasUserCancelled && !wasUpstreamTimeout && (isAbort || (error as { retryable?: boolean }).retryable !== false);
        if (!retryable || attempt === maxRetries) {
          break;
        }
        await this.backoff(attempt, signal);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }
    }

    return this.failedResult(input, startedAt, selectedModel, lastMessage, lastCode);
  }

  /** Small local models sometimes return nested objects where the contract expects plain text. */
  private normalizeOutput(output: RuntimeOutput): RuntimeOutput {
    if (output.kind === 'agent_message' && typeof output.content !== 'string') {
      const fallbackFields = { ...(output as unknown as Record<string, unknown>) };
      delete fallbackFields.kind;
      delete fallbackFields.messageKind;
      delete fallbackFields.content;
      const normalized = this.toPlainText(output.content).trim() || this.toPlainText(fallbackFields).trim();
      return { ...output, content: normalized };
    }
    return output;
  }

  private toPlainText(value: unknown): string {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map((item) => this.toPlainText(item)).join('\n');
    if (value && typeof value === 'object') {
      return Object.entries(value as Record<string, unknown>)
        .map(([key, item]) => `${key}: ${this.toPlainText(item)}`)
        .join('\n');
    }
    return String(value ?? '');
  }

  private upstreamTimeoutMessage(signal?: AbortSignal) {
    if (!signal?.aborted) {
      return undefined;
    }
    const reason = signal.reason;
    const message =
      typeof reason === 'string' ? reason : reason instanceof Error ? reason.message : reason ? String(reason) : '';
    const normalized = message.toLowerCase();
    const name = reason instanceof Error ? reason.name.toLowerCase() : '';
    return normalized.includes('timed out') || normalized.includes('timeout') || name === 'timeouterror'
      ? message || 'Runtime timed out.'
      : undefined;
  }

  private async backoff(attempt: number, signal?: AbortSignal) {
    const delayMs = 500 * 2 ** attempt;
    await new Promise<void>((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, delayMs);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true }
      );
    });
  }

  private missingConfig(connection: RuntimeModelConnection) {
    return [
      ['model', connection.model],
      ['apiKey', connection.apiKey],
      ['baseUrl', connection.baseUrl]
    ]
      .filter(([, value]) => !value?.trim())
      .map(([name]) => name);
  }

  private chatCompletionsUrl(value?: string) {
    const baseUrl = value?.replace(/\/$/, '');
    return `${baseUrl}/chat/completions`;
  }

  private failedResult(
    input: AgentRunInput,
    startedAt: string,
    model: string,
    message: string,
    code: RuntimeError['code'] = 'MODEL_ERROR'
  ): AgentRunResult {
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
          metadata: { message, code },
          createdAt: nowIso()
        }
      ],
      artifacts: [],
      usage: this.toUsage(undefined, model),
      error: {
        code,
        message,
        retryable: !['OUTPUT_SCHEMA_INVALID', 'RUNTIME_CANCELLED', 'CAPABILITY_BLOCKED'].includes(code)
      }
    };
  }

  private toUsage(
    usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined,
    model: string
  ): RuntimeUsage {
    return {
      inputTokens: usage?.prompt_tokens ?? 0,
      outputTokens: usage?.completion_tokens ?? 0,
      totalTokens: usage?.total_tokens ?? 0,
      model
    };
  }
}
