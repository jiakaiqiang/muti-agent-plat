import { Injectable, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type {
  AgentMessageOutput,
  InvocationPlan,
  AgentRunResult,
  AgentRuntimeAdapter,
  AgentRuntimeRunHandle,
  FinalDeliveryOutput,
  PostReviewReportOutput,
  RuntimeError,
  RuntimeArtifactOutput,
  RuntimeContextRequest,
  RuntimeOutput,
  RuntimeUsage,
  TaskAcceptanceDecisionOutput,
  UserMessageHandlingPlanOutput
} from '@agent-cluster/shared';
import { createAgentMessageOutput, createRuntimeArtifactSystemEvidence } from '@agent-cluster/shared';
import { buildStructuredOutputInstructions, modelProviderSupportsRuntime } from '@agent-cluster/shared';
import {
  genericLlmMockFallbackEnabled,
  llmDiagnosticPreviewChars,
  llmLocalMaxOutputTokens,
  llmLocalNumCtx,
  llmMaxRetries,
  llmRemoteMaxOutputTokens,
  llmRemoteStreamingEnabled,
  llmSchemaRepairAttempts,
  llmStructuredOutputMode,
  llmTimeoutMs
} from '../../common/runtime-config.js';
import { nowIso } from '../../common/time.js';
import { promiseHandle } from './promise-run-handle.js';
import { withStructuredTermination } from './structured-termination-run-handle.js';
import { MockRuntimeService } from './mock-runtime.service.js';
import { POST_REVIEW_CONTEXT_ACTION_INSTRUCTION } from './post-review-action-normalizer.js';
import { RuntimeModelConfigService, type RuntimeModelConnection } from './runtime-model-config.service.js';
import {
  runtimeOutputExample,
  runtimeOutputSchema,
  validateRuntimeOutput
} from './runtime-output-schema.js';
import { WorkspaceToolsService } from './workspace-tools.service.js';
import { ToolInvocationAuditService } from '../tools/tool-invocation-audit.service.js';
import { InvocationWorkspaceBindingsService } from './invocation-workspace-bindings.service.js';
import {
  abortWithTermination,
  createExecutionTermination,
  isExecutionTermination,
  safeTerminationMessage
} from '../../common/execution-termination.js';

type GenericLlmResponseBody = {
  choices?: Array<{
    finish_reason?: unknown;
    message?: {
      content?: unknown;
      reasoning?: unknown;
      reasoning_content?: unknown;
    };
    text?: unknown;
  }>;
  message?: unknown;
  output?: unknown;
  output_text?: unknown;
  response?: unknown;
  usage?: GenericLlmUsage;
  model?: string;
};

type GenericLlmUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
};

type GenericLlmStreamingChunk = {
  choices?: Array<{
    delta?: {
      content?: unknown;
      reasoning?: unknown;
      reasoning_content?: unknown;
    };
    message?: {
      content?: unknown;
    };
    text?: unknown;
    finish_reason?: unknown;
  }>;
  usage?: GenericLlmUsage;
  model?: string;
  output_text?: unknown;
  response?: unknown;
};

type RuntimeOutputKind = RuntimeOutput['kind'];
type ActiveStructuredOutputMode = 'json_schema' | 'json_object';

type CompletionResponse = {
  rawBody: unknown;
  body: GenericLlmResponseBody;
};

type RuntimeOutputDiagnostics = {
  parseState: 'valid' | 'no_content' | 'invalid_json' | 'wrong_kind' | 'schema_invalid' | 'unrecognized_shape';
  detectedKind?: string;
  validationErrors: string[];
  content: string;
  contentLength: number;
  contentHash: string;
  sanitizedPreview: string;
};

type HttpRuntimeError = {
  message: string;
  code: RuntimeError['code'];
  retryable: boolean;
  details: Record<string, unknown>;
};

@Injectable()
export class GenericLlmRuntimeService implements AgentRuntimeAdapter {
  readonly type = 'generic_llm' as const;
  readonly metadata = {
    name: 'generic-llm',
    version: '2.0.0',
    category: 'external' as const,
    provider: 'openai-compatible',
    capabilityIds: ['cap-file-read', 'cap-code-search'] as const,
    supportedWorkspaceCapabilities: ['read'] as const,
    supportedWorkspaceProviderKinds: ['server_local'] as const,
    supportedToolNames: ['read_file', 'search_code'] as const
  };
  private readonly structuredOutputCapabilities = new Map<string, ActiveStructuredOutputMode>();

  constructor(
    private readonly mockRuntime: MockRuntimeService,
    private readonly modelConfig: RuntimeModelConfigService,
    private readonly workspaceTools: WorkspaceToolsService,
    private readonly workspaceBindings: InvocationWorkspaceBindingsService,
    @Optional() private readonly toolAudit?: ToolInvocationAuditService
  ) {}

  maxStructuredOutputTokens(input: { modelId?: string }) {
    const connection = this.modelConfig.connectionForModelId(input.modelId);
    return connection.kind === 'remote' ? llmRemoteMaxOutputTokens() : llmLocalMaxOutputTokens();
  }

  async checkAvailability() {
    if (genericLlmMockFallbackEnabled()) return { available: true };
    const connection = this.modelConfig.connectionForModelId(undefined);
    const compatibilityError = this.connectionCompatibilityError(connection);
    if (compatibilityError) return { available: false, reason: compatibilityError };
    const missing = this.missingConfig(connection);
    if (missing.length) {
      return { available: false, reason: `Generic LLM configuration is missing: ${missing.join(', ')}` };
    }
    const baseUrl = connection.baseUrl;
    const apiKey = connection.apiKey;
    if (!baseUrl || !apiKey) {
      return { available: false, reason: 'Generic LLM configuration is missing: baseUrl, apiKey' };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, {
        method: 'GET',
        signal: controller.signal,
        headers: { authorization: `Bearer ${apiKey}` }
      });
      if (response.ok || response.status === 404 || response.status === 405) return { available: true };
      return { available: false, reason: `Generic LLM preflight failed with HTTP ${response.status}` };
    } catch (error) {
      return {
        available: false,
        reason: error instanceof Error && error.name === 'AbortError'
          ? 'Generic LLM preflight timed out.'
          : `Generic LLM preflight failed: ${error instanceof Error ? error.message : String(error)}`
      };
    } finally {
      clearTimeout(timer);
    }
  }

  start(input: InvocationPlan, signal?: AbortSignal): AgentRuntimeRunHandle {
    return withStructuredTermination(promiseHandle(this.execute(input, signal)), input, signal);
  }

  private async execute(input: InvocationPlan, signal?: AbortSignal): Promise<AgentRunResult> {
    const startedAt = nowIso();
    const selectedConnection = this.modelConfig.connectionForModelId(input.executionTarget.modelId);
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

    const compatibilityError = this.connectionCompatibilityError(selectedConnection);
    if (compatibilityError) {
      return this.failedResult(input, startedAt, selectedConnection.model, compatibilityError, 'CAPABILITY_BLOCKED');
    }

    const missingConfig = this.missingConfig(selectedConnection);
    if (missingConfig.length) {
      return this.withTokenEstimationDiagnostic(input, this.failedResult(
        input,
        startedAt,
        selectedConnection.model,
        `通用大模型未配置（缺少 ${missingConfig.join('、')}），本次执行已中止而不会回退到模拟运行时。请在 .env 设置 LLM_PROVIDER/LLM_MODEL/LLM_API_KEY/LLM_BASE_URL，或在运行时模型管理中添加并选择可用模型；如需本地演示模式，请显式设置 LLM_MOCK_FALLBACK=true。`,
        'CAPABILITY_BLOCKED'
      ));
    }

    const hasTools = input.toolCatalog.tools.length > 0;
    if (hasTools && this.workspaceBindings.resolveServerRoot(input)) {
      return this.withTokenEstimationDiagnostic(input, await this.runWithToolLoop(input, selectedConnection, signal));
    }

    return this.withTokenEstimationDiagnostic(input, await this.runOpenAiCompatible(input, selectedConnection, signal));
  }

  private withTokenEstimationDiagnostic(input: InvocationPlan, result: AgentRunResult): AgentRunResult {
    return result;
  }

  private connectionCompatibilityError(connection: RuntimeModelConnection): string | undefined {
    const provider = connection.provider ?? 'openai-compatible';
    const credentialLocation = connection.credentialLocation ?? 'server';
    if (!modelProviderSupportsRuntime(provider, 'generic_llm')) {
      return `Model protocol ${provider} is incompatible with Generic LLM. Use an OpenAI-compatible or Ollama connection.`;
    }
    if (credentialLocation !== 'server') {
      return 'A locally stored credential can only be used by a Local Runtime invocation.';
    }
    return undefined;
  }

  private async runFallback(input: InvocationPlan, selectedModel: string, signal?: AbortSignal): Promise<AgentRunResult> {
    const result = await this.mockRuntime.start(input, signal).result;
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
    input: InvocationPlan,
    selectedConnection: RuntimeModelConnection,
    signal?: AbortSignal
  ): Promise<AgentRunResult> {
    const startedAt = nowIso();
    const selectedModel = selectedConnection.model;
    const maxRetries = llmMaxRetries();
    const timeoutMs = llmTimeoutMs();
    let lastMessage = 'unknown error';
    let lastCode: RuntimeError['code'] = 'MODEL_ERROR';
    let lastDetails: Record<string, unknown> | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const controller = new AbortController();
      let cancelledByUser = false;
      let timedOut = false;
      const onAbort = () => {
        cancelledByUser = true;
        abortWithTermination(
          controller,
          isExecutionTermination(signal?.reason)
            ? signal.reason
            : createExecutionTermination({
                kind: 'user_cancelled',
                source: 'user',
                scope: 'invocation',
                phase: input.phase
              })
        );
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
        abortWithTermination(
          controller,
          createExecutionTermination({
            kind: 'runtime_timeout',
            source: 'runtime',
            scope: 'invocation',
            phase: input.phase,
            timeout: { mode: 'absolute', timeoutMs }
          })
        );
      }, timeoutMs);
      try {
        const messages = [
          {
            role: 'system',
            content:
              selectedConnection.kind === 'local'
                ? this.buildLocalSystemPrompt(input)
                : this.buildRemoteSystemPrompt(input)
          },
          {
            role: 'user',
            content: JSON.stringify({
              phase: input.phase,
              expectedOutput: input.expectedOutput,
              contextEnvelope: input.contextEnvelope,
              toolCatalog: input.toolCatalog,
              budget: input.budget
            })
          }
        ];
        let completion = await this.requestCompletion(
          input,
          selectedConnection,
          messages,
          controller.signal,
          'LLM request'
        );
        let usage = this.toUsage(completion.body.usage, selectedModel);
        let evaluated = this.evaluateRuntimeOutput(completion.body, input.expectedOutput.kind);
        let repairAttempts = 0;

        while (!evaluated.output && repairAttempts < llmSchemaRepairAttempts()) {
          repairAttempts += 1;
          completion = await this.requestCompletion(
            input,
            selectedConnection,
            this.schemaRepairMessages(input.expectedOutput.kind, evaluated.diagnostics),
            controller.signal,
            `LLM schema repair ${repairAttempts}`
          );
          usage = this.mergeUsage(usage, this.toUsage(completion.body.usage, selectedModel));
          evaluated = this.evaluateRuntimeOutput(completion.body, input.expectedOutput.kind);
        }

        if (!evaluated.output) {
          const diagnostics = evaluated.diagnostics;
          const detected = diagnostics.detectedKind ? `, detected ${diagnostics.detectedKind}` : '';
          return this.failedResult(
            input,
            startedAt,
            selectedModel,
            `Expected ${input.expectedOutput.kind}${detected}; model output remained unusable after ${repairAttempts} schema repair attempt(s).`,
            'RUNTIME_OUTPUT_CONTRACT_VIOLATION',
            {
              responseShape: this.summarizeResponseShape(completion.rawBody),
              parseState: diagnostics.parseState,
              detectedKind: diagnostics.detectedKind,
              validationErrors: diagnostics.validationErrors,
              contentLength: diagnostics.contentLength,
              contentHash: diagnostics.contentHash,
              sanitizedPreview: diagnostics.sanitizedPreview,
              repairAttempts
            },
            usage
          );
        }
        const output = evaluated.output;

        return {
          invocationId: input.invocationId,
          runtimeType: 'generic_llm',
          status: 'completed',
          output,
          events: [
            {
              invocationId: input.invocationId,
              type: 'runtime_started',
              visibility: 'user',
              content: `${input.agent.name} GenericLlmRuntime started ${input.phase}`,
              createdAt: startedAt
            },
            {
              invocationId: input.invocationId,
              type: 'runtime_completed',
              visibility: 'user',
              content: `${input.agent.name} GenericLlmRuntime completed ${input.phase}`,
              createdAt: nowIso()
            }
          ],
          artifacts: output.kind === 'task_execution_result' ? output.changedArtifacts : [],
          systemEvidence: createRuntimeArtifactSystemEvidence(input.invocationId),
          usage
        };
      } catch (error) {
        const isAbort = error instanceof Error && (error.name === 'AbortError' || Boolean(signal?.aborted));
        const upstreamTimeoutMessage = this.upstreamTimeoutMessage(signal);
        const wasUpstreamTimeout = isAbort && Boolean(upstreamTimeoutMessage);
        const wasUserCancelled = isAbort && !wasUpstreamTimeout && (cancelledByUser || signal?.aborted);
        lastCode =
          wasUserCancelled
            ? 'RUNTIME_CANCELLED'
            : isAbort && (timedOut || wasUpstreamTimeout)
              ? 'RUNTIME_TIMEOUT'
              : this.errorCode(error);
        lastMessage = wasUserCancelled
          ? 'Runtime request cancelled by user.'
          : wasUpstreamTimeout
            ? (upstreamTimeoutMessage ?? 'Runtime timed out.')
            : isAbort && timedOut
            ? `LLM request timed out after ${timeoutMs}ms`
            : error instanceof Error
              ? error.message
              : String(error);
        lastDetails = {
          ...this.errorDetails(error),
          ...(!isAbort ? { providerFailure: true } : {}),
          ...(isAbort && timedOut ? { timeoutMs } : {})
        };
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

    return this.failedResult(input, startedAt, selectedModel, lastMessage, lastCode, lastDetails);
  }

  private async requestCompletion(
    input: InvocationPlan,
    connection: RuntimeModelConnection,
    messages: Array<{ role: string; content: string }>,
    signal: AbortSignal,
    context: string
  ): Promise<CompletionResponse> {
    const configuredMode = llmStructuredOutputMode();
    let activeMode =
      connection.kind === 'remote'
        ? configuredMode === 'auto'
          ? this.structuredOutputCapabilities.get(this.structuredOutputCapabilityKey(connection)) ?? 'json_schema'
          : configuredMode
        : undefined;

    for (;;) {
      const requestBody = this.completionRequestBody(input, connection, messages, activeMode);
      const response = await fetch(this.chatCompletionsUrl(connection.baseUrl), {
        method: 'POST',
        signal,
        headers: {
          authorization: `Bearer ${connection.apiKey}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        if (
          connection.kind === 'remote' &&
          configuredMode === 'auto' &&
          activeMode === 'json_schema' &&
          (await this.isUnsupportedJsonSchemaResponse(response))
        ) {
          activeMode = 'json_object';
          this.structuredOutputCapabilities.set(this.structuredOutputCapabilityKey(connection), activeMode);
          continue;
        }
        const httpError = await this.httpRuntimeError(response, context);
        throw Object.assign(new Error(httpError.message), {
          retryable: httpError.retryable,
          code: httpError.code,
          details: httpError.details
        });
      }

      if (connection.kind === 'remote' && configuredMode === 'auto' && activeMode) {
        this.structuredOutputCapabilities.set(this.structuredOutputCapabilityKey(connection), activeMode);
      }
      const rawBody =
        requestBody.stream === true && this.isEventStreamResponse(response)
          ? await this.parseStreamingResponse(response, context)
          : await this.parseJsonResponse(response, context);
      return {
        rawBody,
        body: this.asResponseBody(rawBody)
      };
    }
  }

  private completionRequestBody(
    input: InvocationPlan,
    connection: RuntimeModelConnection,
    messages: Array<{ role: string; content: string }>,
    structuredOutputMode?: ActiveStructuredOutputMode
  ) {
    const requestBody: Record<string, unknown> = {
      model: connection.model,
      stream: connection.kind === 'remote' ? llmRemoteStreamingEnabled() : false,
      temperature: 0.2,
      messages
    };
    if (connection.kind === 'remote' && structuredOutputMode) {
      requestBody.max_tokens = Math.min(
        input.budget.maxOutputTokens ?? llmRemoteMaxOutputTokens(),
        llmRemoteMaxOutputTokens()
      );
      requestBody.response_format =
        structuredOutputMode === 'json_schema'
          ? {
              type: 'json_schema',
              json_schema: {
                name: `runtime_output_${input.expectedOutput.kind}`,
                strict: true,
                schema: runtimeOutputSchema(input.expectedOutput.kind)
              }
            }
          : { type: 'json_object' };
    } else if (connection.kind === 'local') {
      requestBody.max_tokens = Math.min(
        input.budget.maxOutputTokens ?? llmLocalMaxOutputTokens(),
        llmLocalMaxOutputTokens()
      );
      requestBody.options = { num_ctx: llmLocalNumCtx() };
      requestBody.think = false;
      requestBody.reasoning_effort = 'none';
    }
    return requestBody;
  }

  private isEventStreamResponse(response: Response) {
    return (response.headers.get('content-type') ?? '').toLowerCase().includes('text/event-stream');
  }

  private structuredOutputCapabilityKey(connection: RuntimeModelConnection) {
    return `${connection.baseUrl ?? ''}\n${connection.model}`;
  }

  private async isUnsupportedJsonSchemaResponse(response: Response) {
    if (response.status !== 400 && response.status !== 422) {
      return false;
    }
    const body = await response.clone().text().catch(() => '');
    return /json_schema|response_format|structured.?output/i.test(body) &&
      /not supported|unsupported|unknown|invalid|not allowed/i.test(body);
  }

  private schemaRepairMessages(kind: RuntimeOutputKind, diagnostics: RuntimeOutputDiagnostics) {
    return [
      {
        role: 'system',
        content: [
          'Schema repair mode. Convert the supplied model output into exactly one valid JSON object.',
          `Required RuntimeOutput kind: ${kind}`,
          'Do not add commentary, Markdown fences, tools, or external side effects.',
          `JSON Schema: ${JSON.stringify(runtimeOutputSchema(kind))}`,
          `Minimal example: ${JSON.stringify(runtimeOutputExample(kind))}`
        ].join('\n')
      },
      {
        role: 'user',
        content: JSON.stringify({
          expectedKind: kind,
          parseState: diagnostics.parseState,
          detectedKind: diagnostics.detectedKind,
          validationErrors: diagnostics.validationErrors,
          invalidOutput: diagnostics.content
        })
      }
    ];
  }

  /**
   * Multi-turn tool-loop mode for the resolved Tool Catalog. Iterates up to MAX_TOOL_ROUNDS,
   * parsing `<<TOOL_CALL>>` blocks from model output, executing them, feeding results
   * back as `<<TOOL_RESULT>>` blocks. Final round forces JSON output to match the
   * expected RuntimeOutput kind.
   */
  private async runWithToolLoop(
    input: InvocationPlan,
    selectedConnection: RuntimeModelConnection,
    signal?: AbortSignal
  ): Promise<AgentRunResult> {
    const startedAt = nowIso();
    const selectedModel = selectedConnection.model;
    const rootPath = this.workspaceBindings.resolveServerRoot(input) ?? '';
    const MAX_TOOL_ROUNDS = 5;
    const MAX_TOOL_CALLS_TOTAL = 12;
    const MAX_TOOL_OUTPUT_CHARS = 80_000;
    const timeoutMs = llmTimeoutMs();

    let totalToolCalls = 0;
    let totalToolOutputChars = 0;
    const toolCallHistory: Array<{ name: string; input: unknown; output: string; error?: string }> = [];

    const baseSystemPrompt = [
      input.agent.systemPrompt,
      'You can read files from the working directory using the tool protocol described below.',
      'Return structured JSON matching the expected RuntimeOutput kind after you have enough context.',
      `Expected kind: ${input.expectedOutput.kind}`,
      '',
      '## Tool Protocol',
      'To read a file, output:',
      '<<TOOL_CALL>>',
      '{"name":"read_file","input":{"path":"relative/path/to/file.ts"}}',
      '<<END_TOOL_CALL>>',
      '',
      'You will receive:',
      '<<TOOL_RESULT name="read_file" path="relative/path/to/file.ts" truncated="false">>',
      '...file content...',
      '<<END_TOOL_RESULT>>',
      '',
      'You may call multiple tools in one response. When you have enough information, return the final JSON output without any tool calls.',
      '',
      'Use ContextEnvelopeV2 L1/L2 for navigation and L3 for grounded evidence.',
      input.expectedOutput.kind === 'agent_message'
        ? 'For agent_message, "content" must be a plain-text string in Chinese.'
        : '',
      input.expectedOutput.kind === 'task_execution_result'
        ? 'For task_execution_result, include changedArtifacts with file changes if applicable.'
        : '',
      input.expectedOutput.kind === 'post_review_report' ? POST_REVIEW_CONTEXT_ACTION_INSTRUCTION : ''
    ]
      .filter(Boolean)
      .join('\n');

    const contextPayload = JSON.stringify({
      phase: input.phase,
      expectedOutput: input.expectedOutput,
      contextEnvelope: input.contextEnvelope,
      toolCatalog: input.toolCatalog,
      budget: input.budget
    });

    let messages: Array<{ role: string; content: string }> = [
      { role: 'system', content: baseSystemPrompt },
      { role: 'user', content: contextPayload }
    ];

    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      if (signal?.aborted) {
        return this.failedResult(
          input,
          startedAt,
          selectedModel,
          'Tool loop cancelled by user.',
          'RUNTIME_CANCELLED'
        );
      }

      const isFinalRound = round === MAX_TOOL_ROUNDS - 1;
      const budgetExceeded = totalToolCalls >= MAX_TOOL_CALLS_TOTAL || totalToolOutputChars >= MAX_TOOL_OUTPUT_CHARS;

      if (isFinalRound || budgetExceeded) {
        // Force final JSON output
        messages.push({
          role: 'system',
          content: `Tool budget reached or final round. Output the final JSON now (kind=${input.expectedOutput.kind}). Do not call more tools.`
        });
      }

      const requestBody: Record<string, unknown> = {
        model: selectedModel,
        stream: selectedConnection.kind === 'remote' ? llmRemoteStreamingEnabled() : false,
        temperature: 0.2,
        messages
      };

      if (selectedConnection.kind === 'remote') {
        requestBody.max_tokens = Math.min(
          input.budget.maxOutputTokens ?? llmRemoteMaxOutputTokens(),
          llmRemoteMaxOutputTokens()
        );
      } else if (selectedConnection.kind === 'local') {
        requestBody.max_tokens = Math.min(input.budget.maxOutputTokens ?? llmLocalMaxOutputTokens(), llmLocalMaxOutputTokens());
        requestBody.options = { num_ctx: llmLocalNumCtx() };
      }

      let rawResponse: string | undefined;
      const maxRetries = llmMaxRetries();
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        const controller = new AbortController();
        let cancelledByUser = false;
        let timedOut = false;
        const onAbort = () => {
          cancelledByUser = true;
          abortWithTermination(
            controller,
            isExecutionTermination(signal?.reason)
              ? signal.reason
              : createExecutionTermination({
                  kind: 'user_cancelled',
                  source: 'user',
                  scope: 'invocation',
                  phase: input.phase
                })
          );
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        const timer = setTimeout(() => {
          timedOut = true;
          abortWithTermination(
            controller,
            createExecutionTermination({
              kind: 'runtime_timeout',
              source: 'runtime',
              scope: 'invocation',
              phase: input.phase,
              timeout: { mode: 'absolute', timeoutMs }
            })
          );
        }, timeoutMs);
        try {
          const response = await fetch(this.chatCompletionsUrl(selectedConnection.baseUrl), {
            method: 'POST',
            signal: controller.signal,
            headers: {
              authorization: `Bearer ${selectedConnection.apiKey}`,
              'content-type': 'application/json'
            },
            body: JSON.stringify(requestBody)
          });

          if (!response.ok) {
            const httpError = await this.httpRuntimeError(response, 'Tool-loop LLM request');
            if (!httpError.retryable || attempt === maxRetries) {
              return this.failedResult(
                input,
                startedAt,
                selectedModel,
                httpError.message,
                httpError.code,
                httpError.details
              );
            }
            await this.backoff(attempt, signal);
            continue;
          }

          const rawBody =
            requestBody.stream === true && this.isEventStreamResponse(response)
              ? await this.parseStreamingResponse(response, 'Tool-loop LLM request')
              : await this.parseJsonResponse(response, 'Tool-loop LLM request');
          const body = this.asResponseBody(rawBody);
          rawResponse = this.extractTextFromBody(body);
          break;
        } catch (error) {
          const isAbort = error instanceof Error && (error.name === 'AbortError' || Boolean(signal?.aborted));
          const timeoutMessage = this.upstreamTimeoutMessage(signal);
          const wasUpstreamTimeout = isAbort && Boolean(timeoutMessage);
          const wasUserCancelled = isAbort && !wasUpstreamTimeout && (cancelledByUser || signal?.aborted);
          const retryable =
            !wasUserCancelled && !wasUpstreamTimeout && (isAbort || (error as { retryable?: boolean }).retryable !== false);
          if (!retryable || attempt === maxRetries) {
            if (wasUserCancelled || wasUpstreamTimeout || isAbort) {
              return this.failedResult(
                input,
                startedAt,
                selectedModel,
                wasUserCancelled
                  ? 'Tool loop cancelled by user.'
                  : timeoutMessage ?? (timedOut ? `Tool-loop LLM request timed out after ${timeoutMs}ms` : 'Tool loop cancelled by user.'),
                wasUserCancelled ? 'RUNTIME_CANCELLED' : 'RUNTIME_TIMEOUT',
                wasUserCancelled ? undefined : { timeoutMs }
              );
            }
            return this.failedResult(
              input,
              startedAt,
              selectedModel,
              `Tool-loop fetch error: ${error instanceof Error ? error.message : String(error)}`,
              this.errorCode(error),
              this.errorDetails(error)
            );
          }
          await this.backoff(attempt, signal);
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
        }
      }

      if (rawResponse === undefined) {
        return this.failedResult(
          input,
          startedAt,
          selectedModel,
          'Tool-loop LLM request ended without a response.',
          'MODEL_ERROR'
        );
      }

      const toolCalls = this.parseToolCalls(rawResponse);

      if (toolCalls.length === 0 || isFinalRound || budgetExceeded) {
        // Attempt to extract final JSON
        const extracted = this.extractRuntimeOutput(
          { choices: [{ message: { content: rawResponse } }] },
          input.expectedOutput.kind
        );
        if (!extracted.output) {
          return this.failedResult(
            input,
            startedAt,
            selectedModel,
            `Tool-loop completed but model did not return valid JSON. Raw: ${rawResponse.slice(0, 500)}`,
            'RUNTIME_OUTPUT_CONTRACT_VIOLATION'
          );
        }
        const output = extracted.output;
        if (output.kind !== input.expectedOutput.kind) {
          return this.failedResult(
            input,
            startedAt,
            selectedModel,
            `Expected ${input.expectedOutput.kind}, got ${String(output.kind)}`,
            'RUNTIME_OUTPUT_CONTRACT_VIOLATION'
          );
        }
        const validation = validateRuntimeOutput(output, input.expectedOutput.kind);
        if (!validation.valid) {
          return this.failedResult(
            input,
            startedAt,
            selectedModel,
            `Tool-loop output failed RuntimeOutput validation: ${validation.errors.join('; ')}`,
            'RUNTIME_OUTPUT_CONTRACT_VIOLATION',
            {
              parseState: 'schema_invalid',
              validationErrors: validation.errors,
              repairAttempts: 0
            }
          );
        }

        return {
          invocationId: input.invocationId,
          runtimeType: 'generic_llm',
          status: 'completed',
          output,
          events: [
            {
              invocationId: input.invocationId,
              type: 'runtime_started',
              visibility: 'user',
              content: `${input.agent.name} GenericLlmRuntime tool-loop started`,
              createdAt: startedAt
            },
            {
              invocationId: input.invocationId,
              type: 'runtime_completed',
              visibility: 'user',
              content: `${input.agent.name} GenericLlmRuntime tool-loop completed (${toolCallHistory.length} tool calls)`,
              createdAt: nowIso()
            }
          ],
          artifacts: output.kind === 'task_execution_result' ? output.changedArtifacts : [],
          systemEvidence: createRuntimeArtifactSystemEvidence(input.invocationId),
          usage: {
            model: selectedModel,
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0
          }
        };
      }

      // Execute tools
      const toolResults: string[] = [];
      for (const call of toolCalls) {
        if (totalToolCalls >= MAX_TOOL_CALLS_TOTAL) {
          toolResults.push(
            `<<TOOL_RESULT name="${call.name}" error="BUDGET_EXCEEDED">>\nTool call limit reached (${MAX_TOOL_CALLS_TOTAL}).\n<<END_TOOL_RESULT>>`
          );
          break;
        }
        totalToolCalls += 1;

        if (call.name === 'read_file') {
          const toolStartedAt = nowIso();
          const result = await this.workspaceTools.readFile(rootPath, call.input as { path?: unknown });
          const output = result.ok ? result.output : `ERROR [${result.errorCode}]: ${result.errorMessage}`;
          await this.toolAudit?.record({
            externalId: `tool:${input.invocationId}:${totalToolCalls}`,
            runtimeInvocationExternalId: input.invocationId,
            toolName: call.name,
            providerCallId: `${input.invocationId}:${totalToolCalls}`,
            provider: 'generic_llm',
            arguments: call.input,
            result,
            success: result.ok,
            errorCode: result.ok ? undefined : result.errorCode,
            errorMessage: result.ok ? undefined : result.errorMessage,
            agentExternalId: input.agent.agentId,
            startedAt: toolStartedAt,
            completedAt: nowIso()
          });
          const truncated = result.truncated ? 'true' : 'false';
          const error = result.ok ? '' : ` error="${result.errorCode}"`;
          toolResults.push(
            `<<TOOL_RESULT name="read_file" path="${(call.input as { path?: string })?.path ?? 'unknown'}" truncated="${truncated}"${error}>>\n${output}\n<<END_TOOL_RESULT>>`
          );
          totalToolOutputChars += output.length;
          toolCallHistory.push({ name: call.name, input: call.input, output, error: result.ok ? undefined : result.errorCode });
        } else {
          toolResults.push(
            `<<TOOL_RESULT name="${call.name}" error="UNKNOWN_TOOL">>\nUnknown tool: ${call.name}\n<<END_TOOL_RESULT>>`
          );
          toolCallHistory.push({ name: call.name, input: call.input, output: '', error: 'UNKNOWN_TOOL' });
        }

        if (totalToolOutputChars >= MAX_TOOL_OUTPUT_CHARS) {
          toolResults.push(
            `<<TOOL_RESULT error="BUDGET_EXCEEDED">>\nTool output budget reached (${MAX_TOOL_OUTPUT_CHARS} chars).\n<<END_TOOL_RESULT>>`
          );
          break;
        }
      }

      messages.push({ role: 'assistant', content: rawResponse });
      messages.push({ role: 'user', content: toolResults.join('\n\n') });
    }

    return this.failedResult(
      input,
      startedAt,
      selectedModel,
      `Tool loop exceeded ${MAX_TOOL_ROUNDS} rounds without producing final output.`,
      'MODEL_ERROR'
    );
  }

  private parseToolCalls(text: string): Array<{ name: string; input: unknown }> {
    const regex = /<<TOOL_CALL>>\s*(\{[^]*?\})\s*<<END_TOOL_CALL>>/g;
    const calls: Array<{ name: string; input: unknown }> = [];
    let match;
    while ((match = regex.exec(text)) !== null) {
      try {
        const parsed = JSON.parse(match[1]);
        if (typeof parsed?.name === 'string' && parsed?.input !== undefined) {
          calls.push({ name: parsed.name, input: parsed.input });
        }
      } catch {
        // Invalid JSON, skip this call
      }
    }
    return calls;
  }

  private extractTextFromBody(body: GenericLlmResponseBody): string {
    const choice = body.choices?.[0];
    if (choice?.message?.content && typeof choice.message.content === 'string') {
      return choice.message.content;
    }
    if (choice?.text && typeof choice.text === 'string') {
      return choice.text;
    }
    if (body.message && typeof body.message === 'string') {
      return body.message;
    }
    if (body.output_text && typeof body.output_text === 'string') {
      return body.output_text;
    }
    if (body.response && typeof body.response === 'string') {
      return body.response;
    }
    return '';
  }

  /**
   * Build a simplified system prompt for local models. Local Ollama models
   * (especially <7B params) struggle with verbose multi-conditional prompts,
   * so we strip down to the bare essentials.
   */
  private buildLocalSystemPrompt(input: InvocationPlan): string {
    // Keep local-model output instructions concise to avoid triggering reasoning mode.
    const parts = [
      'Return only valid JSON.',
      `Output kind: ${input.expectedOutput.kind}`,
      buildStructuredOutputInstructions(input.expectedOutput.kind)
    ];

    if (input.expectedOutput.kind === 'task_brief') {
      parts.push('Include: goal, scope, constraints, acceptanceCriteria.');
    } else if (input.expectedOutput.kind === 'agent_message') {
      parts.push('The "content" field must be plain-text string in Chinese.');
    } else if (input.expectedOutput.kind === 'task_execution_result') {
      parts.push('Include: summary, status. status must be one of: completed, failed, blocked, needs_review.');
    } else if (input.expectedOutput.kind === 'post_review_report') {
      parts.push(POST_REVIEW_CONTEXT_ACTION_INSTRUCTION);
    }

    return parts.join(' ');
  }

  /**
   * Extract a 2-3 line summary from a verbose agent systemPrompt.
   * Typically the agent.role + first abilities bullet point.
   */
  private simplifyAgentPrompt(fullPrompt: string, role: string): string {
    // Use the role field as the core identity (it's already concise)
    return `你是 Agent。角色：${role}\n输出必须是有效 JSON。`;
  }

  /**
   * Build the full system prompt for remote (cloud) models. These can handle
   * the detailed multi-conditional instructions.
   */
  private buildRemoteSystemPrompt(input: InvocationPlan): string {
    return [
      input.agent.systemPrompt,
      'Return only valid JSON matching the requested RuntimeOutput kind.',
      `Expected kind: ${input.expectedOutput.kind}`,
      `Required JSON Schema: ${JSON.stringify(runtimeOutputSchema(input.expectedOutput.kind))}`,
      `Minimal valid example: ${JSON.stringify(runtimeOutputExample(input.expectedOutput.kind))}`,
      'Never return a different RuntimeOutput kind, Markdown fences, or explanatory text outside the JSON object.',
      input.expectedOutput.kind === 'task_acceptance_decision'
        ? 'For task_acceptance_decision, status must be exactly one of: accepted, blocked, rejected.'
        : 'When task_execution_result has a status field, status must be exactly one of: completed, failed, blocked, needs_review.',
      buildStructuredOutputInstructions(input.expectedOutput.kind),
      'Do not call tools, modify files, or perform external side effects.',
      'Use ContextEnvelopeV2 L1 for the task and navigation, L2 for the project map, and L3 for grounded evidence.',
      'Treat taskContext.evidenceSelection.omittedRefs as intentionally excluded context; ask for more evidence instead of inventing details when selected evidence is insufficient.',
      'When selected evidence is insufficient for the expected output, return the expected JSON kind with status "blocked" when supported, summary explaining the gap, and requestedContext containing reason, requestedRefs, requestedPaths, optional requestedDirectories, optional requestedSearches, requestedCommands, and followUpInstruction. Do not fabricate file contents, APIs, test results, or logs.',
      'For non-coding tasks, validate fact consistency, scope consistency, traceability, and delivery completeness instead of inventing implementation evidence.',
      input.expectedOutput.kind === 'task_brief'
        ? 'When the user asks to analyze, understand, or become familiar with a project/repository architecture, assign exactly one architect task. The architect scenario is only: analyze the current project structure and main execution/collaboration path from an architecture viewpoint, then provide architecture ideas, risks, and suggestions grounded in workspaceManifest/projectMap/selectedEvidenceContents. Do not add a separate review/test task unless the user explicitly asks for validation.'
        : '',
      input.contextEnvelope.L1.navigation.entries.length > 0
        ? 'Inspect L1 navigation for project structure and L3 for readable evidence content.'
        : 'No workspace navigation is available; say when file-level conclusions are assumptions.',
      'Be specific and useful. Avoid one-sentence generic output; include concrete decisions, assumptions, risks, and next actions.',
      input.expectedOutput.kind === 'agent_message'
        ? 'For agent_message, the "content" field must be one plain-text string (never an object or array). Write a detailed Chinese response with 3-6 concise paragraphs or bullets covering understanding, concerns, and recommendations.'
        : '',
      input.expectedOutput.kind === 'task_acceptance_decision'
        ? 'Return the task_acceptance_decision fields required by the schema, including requestedContext when evidence is insufficient.'
        : '',
      input.expectedOutput.kind === 'task_execution_result'
        ? 'For task_execution_result, include changedArtifacts. If this is a validation task or the agent is the Validation Agent, include a test_report artifact with metadata.validationEvidence mapping each taskContext.validationRules item to verdicts and taskContext.evidenceRefs, plus validatorAgentKey, validatorAgentId, and independentFromAgentKeys from taskContext.agentResponsibilities. If workspaceManifest is present, analyze the impact surface from manifest paths, but ground content-specific changes only in selectedEvidenceContents. Do not collapse a multi-file requirement into one file. Use agent-output only for auxiliary summaries. Include optional agentMessages when progress, risks, questions, or handoffs should be sent to other agents; target them with targetAgentKeys such as coordinator, frontend, backend, test, review.'
        : '',
      input.expectedOutput.kind === 'post_review_report' ? POST_REVIEW_CONTEXT_ACTION_INSTRUCTION : '',
      this.workspaceBindings.resolveServerRoot(input)
        ? 'A local working directory is selected. Return file changes only as RuntimeArtifactOutput.metadata.fileChanges with safe relative paths. The browser applies those changes inside the selected directory.'
        : 'No local working directory is selected. Do not return fileChanges.'
    ]
      .filter(Boolean)
      .join('\n');
  }

  private evaluateRuntimeOutput(
    body: GenericLlmResponseBody,
    expectedKind: RuntimeOutputKind
  ): { output?: RuntimeOutput; diagnostics: RuntimeOutputDiagnostics } {
    const extracted = this.extractRuntimeOutput(body, expectedKind);
    if (extracted.output) {
      const validation = validateRuntimeOutput(extracted.output, expectedKind);
      if (validation.valid) {
        return {
          output: validation.value,
          diagnostics: this.runtimeOutputDiagnostics(body, expectedKind, 'valid', validation.errors)
        };
      }
      return {
        diagnostics: this.runtimeOutputDiagnostics(body, expectedKind, 'schema_invalid', validation.errors)
      };
    }

    const content = this.extractMessageContent(body).content?.trim() ?? '';
    if (!content) {
      return {
        diagnostics: this.runtimeOutputDiagnostics(body, expectedKind, 'no_content', ['No model message content was found.'])
      };
    }
    const parsed = this.firstParsedJsonValue(content);
    if (parsed === undefined) {
      return {
        diagnostics: this.runtimeOutputDiagnostics(body, expectedKind, 'invalid_json', ['Model content is not valid JSON.'])
      };
    }
    const detectedKind = this.detectRuntimeOutputKind(parsed);
    if (detectedKind && detectedKind !== expectedKind) {
      return {
        diagnostics: this.runtimeOutputDiagnostics(
          body,
          expectedKind,
          'wrong_kind',
          [`Expected kind ${expectedKind}, received ${detectedKind}.`],
          detectedKind
        )
      };
    }
    const validation = validateRuntimeOutput(parsed, expectedKind);
    return {
      diagnostics: this.runtimeOutputDiagnostics(
        body,
        expectedKind,
        validation.errors.length ? 'schema_invalid' : 'unrecognized_shape',
        validation.errors.length ? validation.errors : ['JSON did not map to a supported RuntimeOutput shape.'],
        detectedKind
      )
    };
  }

  private runtimeOutputDiagnostics(
    body: GenericLlmResponseBody,
    expectedKind: RuntimeOutputKind,
    parseState: RuntimeOutputDiagnostics['parseState'],
    validationErrors: string[],
    detectedKind?: string
  ): RuntimeOutputDiagnostics {
    const content = this.extractMessageContent(body).content?.trim() ?? '';
    return {
      parseState,
      detectedKind: detectedKind ?? this.detectRuntimeOutputKind(this.firstParsedJsonValue(content)),
      validationErrors,
      content,
      contentLength: content.length,
      contentHash: createHash('sha256').update(content).digest('hex'),
      sanitizedPreview: this.sanitizeDiagnosticPreview(content)
    };
  }

  private firstParsedJsonValue(content: string): unknown {
    if (!content) {
      return undefined;
    }
    for (const candidate of this.jsonTextCandidates(content)) {
      try {
        return JSON.parse(candidate) as unknown;
      } catch {
        continue;
      }
    }
    return undefined;
  }

  private detectRuntimeOutputKind(value: unknown, depth = 0): string | undefined {
    if (!value || depth > 4) {
      return undefined;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        const detected = this.detectRuntimeOutputKind(item, depth + 1);
        if (detected) {
          return detected;
        }
      }
      return undefined;
    }
    if (typeof value !== 'object') {
      return undefined;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.kind === 'string') {
      return record.kind;
    }
    for (const key of ['output', 'result', 'final_output', 'data', 'content', 'message', 'value']) {
      const detected = this.detectRuntimeOutputKind(record[key], depth + 1);
      if (detected) {
        return detected;
      }
    }
    return undefined;
  }

  private sanitizeDiagnosticPreview(content: string) {
    const redacted = content
      .replace(
        /("(?:api[_-]?key|access[_-]?token|authorization|password|secret)"\s*:\s*")[^"]*(")/gi,
        '$1[REDACTED]$2'
      )
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
      .replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, '[REDACTED]');
    return redacted.replace(/\s+/g, ' ').trim().slice(0, llmDiagnosticPreviewChars());
  }

  private extractMessageContent(body: GenericLlmResponseBody): { content?: string; source?: string } {
    const candidates: Array<[string, unknown]> = [
      ['choices[0].message.content', body.choices?.[0]?.message?.content],
      ['choices[0].message.reasoning', body.choices?.[0]?.message?.reasoning],
      ['choices[0].message.reasoning_content', body.choices?.[0]?.message?.reasoning_content],
      ['choices[0].text', body.choices?.[0]?.text],
      ['output_text', body.output_text],
      ['output', body.output],
      ['message', body.message],
      ['response', body.response]
    ];

    for (const [source, value] of candidates) {
      const content = this.extractText(value).trim();
      if (content) {
        return { content, source };
      }
    }

    return {};
  }

  private extractRuntimeOutput(
    body: GenericLlmResponseBody,
    expectedKind: RuntimeOutputKind
  ): { output?: RuntimeOutput; source?: string } {
    const directOutput = this.toRuntimeOutput(body, expectedKind);
    if (directOutput) {
      return { output: directOutput, source: 'response_body' };
    }

    const extracted = this.extractMessageContent(body);
    if (!extracted.content) {
      return {};
    }

    const output = this.toRuntimeOutput(extracted.content, expectedKind);
    return output ? { output, source: extracted.source } : {};
  }

  private toRuntimeOutput(value: unknown, expectedKind: RuntimeOutputKind): RuntimeOutput | undefined {
    if (value === undefined || value === null) {
      return undefined;
    }

    if (typeof value === 'string') {
      return this.parseRuntimeOutputText(value, expectedKind);
    }

    if (typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }

    const record = value as Record<string, unknown>;
    if (record.kind === expectedKind) {
      const validation = validateRuntimeOutput(record, expectedKind);
      return validation.valid ? validation.value : undefined;
    }
    return undefined;
  }

  private parseRuntimeOutputText(content: string, expectedKind: RuntimeOutputKind) {
    const trimmed = content.trim();
    if (!trimmed) {
      return undefined;
    }

    for (const candidate of this.jsonTextCandidates(trimmed)) {
      try {
        const parsed = JSON.parse(candidate) as unknown;
        const output = this.toRuntimeOutput(parsed, expectedKind);
        if (output) {
          return output;
        }
      } catch {
        // Try the next candidate shape.
      }
    }

    return undefined;
  }

  private jsonTextCandidates(content: string) {
    return [content];
  }

  private asResponseBody(value: unknown): GenericLlmResponseBody {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as GenericLlmResponseBody) : {};
  }

  private extractText(value: unknown): string {
    if (typeof value === 'string') {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.extractText(item)).join('');
    }
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      const candidates = [record.text, record.output_text, record.content, record.value, record.message];
      for (const candidate of candidates) {
        const content = this.extractText(candidate);
        if (content.trim()) {
          return content;
        }
      }
    }
    return '';
  }

  private summarizeResponseShape(value: unknown) {
    const body = this.asResponseBody(value);
    const firstChoice = body.choices?.[0] as Record<string, unknown> | undefined;
    const firstMessage = firstChoice?.message as Record<string, unknown> | undefined;
    return {
      rootType: this.valueKind(value),
      topLevelKeys: Object.keys(body).slice(0, 20),
      choicesLength: Array.isArray(body.choices) ? body.choices.length : undefined,
      firstChoiceKeys: firstChoice ? Object.keys(firstChoice).slice(0, 20) : undefined,
      firstMessageKeys: firstMessage ? Object.keys(firstMessage).slice(0, 20) : undefined,
      firstFinishReason: firstChoice?.finish_reason,
      messageContentType: this.valueKind(firstMessage?.content),
      reasoningType: this.valueKind(firstMessage?.reasoning),
      reasoningContentType: this.valueKind(firstMessage?.reasoning_content),
      outputTextType: this.valueKind(body.output_text),
      outputType: this.valueKind(body.output),
      responseType: this.valueKind(body.response)
    };
  }

  private valueKind(value: unknown): string {
    if (value === undefined) return 'missing';
    if (value === null) return 'null';
    if (Array.isArray(value)) return `array(${value.length})`;
    if (typeof value === 'object') return `object(${Object.keys(value as Record<string, unknown>).slice(0, 8).join(',')})`;
    if (typeof value === 'string') return `string(${value.length})`;
    return typeof value;
  }

  private upstreamTimeoutMessage(signal?: AbortSignal) {
    if (!signal?.aborted) {
      return undefined;
    }
    const reason = signal.reason;
    if (isExecutionTermination(reason)) {
      return reason.kind === 'phase_timeout' || reason.kind === 'runtime_timeout'
        ? safeTerminationMessage(reason)
        : undefined;
    }
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

  private async parseStreamingResponse(response: Response, context: string): Promise<unknown> {
    if (!response.body) {
      throw Object.assign(new Error(`${context} returned an empty streaming response body.`), { retryable: true });
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let usage: GenericLlmUsage | undefined;
    let model: string | undefined;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) {
          continue;
        }
        const data = trimmed.slice('data:'.length).trim();
        if (!data || data === '[DONE]') {
          continue;
        }
        let chunk: GenericLlmStreamingChunk;
        try {
          chunk = JSON.parse(data) as GenericLlmStreamingChunk;
        } catch {
          continue;
        }
        const delta = chunk.choices?.[0]?.delta;
        const message = chunk.choices?.[0]?.message;
        const text = chunk.choices?.[0]?.text;
        const outputText = chunk.output_text;
        const responseText = chunk.response;
        content +=
          (typeof delta?.content === 'string' ? delta.content : '') ||
          (typeof message?.content === 'string' ? message.content : '') ||
          (typeof text === 'string' ? text : '') ||
          (typeof outputText === 'string' ? outputText : '') ||
          (typeof responseText === 'string' ? responseText : '');
        usage = chunk.usage ?? usage;
        model = chunk.model ?? model;
      }
    }

    const trailing = decoder.decode();
    if (trailing) {
      buffer += trailing;
    }
    for (const line of buffer.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) {
        continue;
      }
      const data = trimmed.slice('data:'.length).trim();
      if (!data || data === '[DONE]') {
        continue;
      }
      try {
        const chunk = JSON.parse(data) as GenericLlmStreamingChunk;
        const delta = chunk.choices?.[0]?.delta;
        content += typeof delta?.content === 'string' ? delta.content : '';
        usage = chunk.usage ?? usage;
        model = chunk.model ?? model;
      } catch {
        // Ignore malformed trailing stream lines. The accumulated content is still useful.
      }
    }

    if (!content.trim()) {
      throw Object.assign(new Error(`${context} returned an empty streaming response.`), { retryable: true });
    }

    return {
      choices: [
        {
          message: { content },
          finish_reason: 'stop'
        }
      ],
      usage,
      model
    } satisfies GenericLlmResponseBody;
  }

  private async parseJsonResponse(response: Response, context: string): Promise<unknown> {
    const rawBody = await response.text();
    if (!rawBody.trim()) {
      throw Object.assign(new Error(`${context} returned an empty response body.`), { retryable: false });
    }

    try {
      return JSON.parse(rawBody) as unknown;
    } catch {
      const contentType = response.headers.get('content-type') ?? 'unknown content-type';
      const preview = this.compactPreview(rawBody);
      const htmlHint =
        contentType.toLowerCase().includes('html') || rawBody.trimStart().startsWith('<')
          ? 'The configured Base URL appears to return an HTML page instead of an OpenAI-compatible JSON API response. Check that the model gateway URL includes the API prefix, usually ending in /v1.'
          : 'The provider returned non-JSON content.';
      throw Object.assign(
        new Error(`${context} returned non-JSON response (${contentType}). ${htmlHint} Preview: ${preview}`),
        { retryable: false }
      );
    }
  }

  private async responseBodyPreview(response: Response) {
    const text = await response.text().catch(() => '');
    return this.compactPreview(text);
  }

  private compactPreview(value: string) {
    return value.replace(/\s+/g, ' ').trim().slice(0, 240);
  }

  private async httpRuntimeError(response: Response, context: string): Promise<HttpRuntimeError> {
    const preview = await this.responseBodyPreview(response);
    const contentType = response.headers.get('content-type') ?? 'unknown content-type';
    const retryable = response.status === 429 || response.status >= 500;
    const timeoutStatus = response.status === 408 || response.status === 504 || response.status === 524;
    const retryAfterMs = this.retryAfterMs(response.headers.get('retry-after'));
    const code: RuntimeError['code'] = timeoutStatus ? 'RUNTIME_TIMEOUT' : 'MODEL_ERROR';
    const providerMessage = this.httpStatusMessage(response.status, context);
    const htmlHint =
      contentType.toLowerCase().includes('html') || preview.trimStart().startsWith('<')
        ? ' Provider returned an HTML error page; the raw HTML was suppressed.'
        : '';
    const retryHint = retryable ? ' The request may succeed if retried later.' : '';

    return {
      message: `${providerMessage}.${htmlHint}${retryHint}`.replace(/\s+/g, ' ').trim(),
      code,
      retryable,
      details: {
        provider: 'openai-compatible',
        providerFailure: true,
        stage: 'provider_response',
        httpStatus: response.status,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        contentType,
        responsePreview: preview
      }
    };
  }

  private retryAfterMs(value: string | null) {
    if (!value) {
      return undefined;
    }
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.round(seconds * 1_000);
    }
    const retryAt = Date.parse(value);
    return Number.isFinite(retryAt) ? Math.max(0, retryAt - Date.now()) : undefined;
  }

  private httpStatusMessage(status: number, context: string) {
    if (status === 524) {
      return `${context} timed out at the model gateway (HTTP 524)`;
    }
    if (status === 504) {
      return `${context} timed out at the model gateway (HTTP 504)`;
    }
    if (status === 408) {
      return `${context} timed out before the provider completed the request (HTTP 408)`;
    }
    if (status === 429) {
      return `${context} was rate limited by the model provider (HTTP 429)`;
    }
    return `${context} failed with HTTP ${status}`;
  }

  private errorCode(error: unknown): RuntimeError['code'] {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' && this.isRuntimeErrorCode(code) ? code : 'MODEL_ERROR';
  }

  private errorDetails(error: unknown): Record<string, unknown> | undefined {
    const details = (error as { details?: unknown }).details;
    return details && typeof details === 'object' && !Array.isArray(details)
      ? (details as Record<string, unknown>)
      : undefined;
  }

  private isRuntimeErrorCode(code: string): code is RuntimeError['code'] {
    return [
      'RUNTIME_TIMEOUT',
      'RUNTIME_CANCELLED',
      'MODEL_ERROR',
      'RUNTIME_OUTPUT_CONTRACT_VIOLATION',
      'CAPABILITY_BLOCKED',
      'CONTEXT_INSUFFICIENT',
      'TOKEN_BUDGET_EXCEEDED',
      'UNKNOWN_ERROR'
    ].includes(code);
  }

  private failedResult(
    input: InvocationPlan,
    startedAt: string,
    model: string,
    message: string,
    code: RuntimeError['code'] = 'MODEL_ERROR',
    details?: Record<string, unknown>,
    usage?: RuntimeUsage
  ): AgentRunResult {
    return {
      invocationId: input.invocationId,
      runtimeType: 'generic_llm',
      status: 'failed',
      output: createAgentMessageOutput({
        messageKind: 'risk',
        content: `GenericLlmRuntime failed during ${input.phase}.`
      }) satisfies AgentMessageOutput,
      events: [
        {
          invocationId: input.invocationId,
          type: 'runtime_started',
          visibility: 'user',
          content: `${input.agent.name} GenericLlmRuntime started ${input.phase}`,
          createdAt: startedAt
        },
        {
          invocationId: input.invocationId,
          type: 'runtime_failed',
          visibility: 'user',
          content: `${input.agent.name} GenericLlmRuntime failed ${input.phase}`,
          metadata: { message, code, details },
          createdAt: nowIso()
        }
      ],
      artifacts: [],
      systemEvidence: createRuntimeArtifactSystemEvidence(input.invocationId),
      usage: usage ?? this.toUsage(undefined, model),
      error: {
        code,
        message,
        retryable: this.retryableRuntimeError(code, details),
        details
      }
    };
  }

  private retryableRuntimeError(code: RuntimeError['code'], details?: Record<string, unknown>) {
    const httpStatus = details?.httpStatus;
    if (typeof httpStatus === 'number') {
      return httpStatus === 408 || httpStatus === 429 || httpStatus === 504 || httpStatus === 524 || httpStatus >= 500;
    }
    return !['RUNTIME_OUTPUT_CONTRACT_VIOLATION', 'RUNTIME_CANCELLED', 'CAPABILITY_BLOCKED'].includes(code);
  }

  private mergeUsage(left: RuntimeUsage, right: RuntimeUsage): RuntimeUsage {
    return {
      inputTokens: left.inputTokens + right.inputTokens,
      outputTokens: left.outputTokens + right.outputTokens,
      totalTokens: left.totalTokens + right.totalTokens,
      model: right.model || left.model
    };
  }

  private toUsage(usage: GenericLlmUsage | undefined, model: string): RuntimeUsage {
    return {
      inputTokens: usage?.prompt_tokens ?? usage?.input_tokens ?? 0,
      outputTokens: usage?.completion_tokens ?? usage?.output_tokens ?? 0,
      totalTokens: usage?.total_tokens ?? 0,
      model
    };
  }
}
