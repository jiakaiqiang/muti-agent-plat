import { Injectable } from '@nestjs/common';
import type {
  AgentMessageOutput,
  AgentRunInput,
  AgentRunResult,
  RuntimeOutput,
  RuntimeUsage
} from '@agent-cluster/shared';
import { genericLlmMockFallbackEnabled, llmApiKey, llmBaseUrl, llmModel } from '../../common/runtime-config.js';
import { nowIso } from '../../common/time.js';
import { MockRuntimeService } from './mock-runtime.service.js';

@Injectable()
export class GenericLlmRuntimeService {
  constructor(private readonly mockRuntime: MockRuntimeService) {}

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    if (genericLlmMockFallbackEnabled()) {
      return this.runFallback(input);
    }

    const missingConfig = this.missingConfig();
    if (missingConfig.length) {
      return this.failedResult(input, nowIso(), `GenericLlmRuntime missing required config: ${missingConfig.join(', ')}`);
    }

    return this.runOpenAiCompatible(input);
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
        model: process.env.LLM_MODEL ?? 'mock-generic-llm'
      }
    };
  }

  private async runOpenAiCompatible(input: AgentRunInput): Promise<AgentRunResult> {
    const startedAt = nowIso();

    try {
      const response = await fetch(this.chatCompletionsUrl(), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${llmApiKey()}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: llmModel(),
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

      const output = JSON.parse(content) as RuntimeOutput;
      if (output.kind !== input.expectedOutput.kind) {
        throw new Error(`Expected ${input.expectedOutput.kind}, got ${output.kind}`);
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
        usage: this.toUsage(body.usage, body.model)
      };
    } catch (error) {
      return this.failedResult(input, startedAt, error instanceof Error ? error.message : String(error));
    }
  }

  private missingConfig() {
    return [
      ['LLM_API_KEY', llmApiKey()],
      ['LLM_BASE_URL', llmBaseUrl()]
    ]
      .filter(([, value]) => !value?.trim())
      .map(([name]) => name);
  }

  private chatCompletionsUrl() {
    const baseUrl = llmBaseUrl()?.replace(/\/$/, '');
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
      usage: this.toUsage(undefined, llmModel()),
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
      model: model ?? llmModel()
    };
  }
}
