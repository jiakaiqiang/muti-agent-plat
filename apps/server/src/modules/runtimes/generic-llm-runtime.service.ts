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
        `GenericLlmRuntime missing required config: ${missingConfig.join(', ')}`
      );
    }

    return this.runOpenAiCompatible(input, selectedConnection, signal);
  }

  private async runFallback(input: AgentRunInput, selectedModel: string, signal?: AbortSignal): Promise<AgentRunResult> {
    const result = await this.mockRuntime.run(input, signal);
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
        retryable: !['OUTPUT_SCHEMA_INVALID', 'RUNTIME_CANCELLED'].includes(code)
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
