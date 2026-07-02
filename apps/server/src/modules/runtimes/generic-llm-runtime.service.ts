import { Injectable } from '@nestjs/common';
import type {
  AgentMessageOutput,
  AgentRunInput,
  AgentRunResult,
  AgentRuntimeAdapter,
  FinalDeliveryOutput,
  PostReviewReportOutput,
  RuntimeError,
  RuntimeArtifactOutput,
  RuntimeContextRequest,
  RuntimeOutput,
  RuntimeUsage,
  TaskAcceptanceDecisionOutput,
  TaskClaimDecisionOutput,
  UserMessageHandlingPlanOutput
} from '@agent-cluster/shared';
import {
  genericLlmMockFallbackEnabled,
  llmLocalMaxOutputTokens,
  llmLocalNumCtx,
  llmMaxRetries,
  llmTimeoutMs
} from '../../common/runtime-config.js';
import { nowIso } from '../../common/time.js';
import { MockRuntimeService } from './mock-runtime.service.js';
import { RuntimeModelConfigService, type RuntimeModelConnection } from './runtime-model-config.service.js';
import { WorkspaceToolsService } from './workspace-tools.service.js';

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

type RuntimeOutputKind = RuntimeOutput['kind'];

@Injectable()
export class GenericLlmRuntimeService implements AgentRuntimeAdapter {
  readonly type = 'generic_llm' as const;

  constructor(
    private readonly mockRuntime: MockRuntimeService,
    private readonly modelConfig: RuntimeModelConfigService,
    private readonly workspaceTools: WorkspaceToolsService
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

    const hasTools = input.contextPack.availableTools && input.contextPack.availableTools.length > 0;
    if (hasTools && input.contextPack.workingDirectory?.kind === 'server_local' && input.contextPack.workingDirectory?.path) {
      return this.runWithToolLoop(input, selectedConnection, signal);
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
        const requestBody: Record<string, unknown> = {
          model: selectedModel,
          stream: false,
          temperature: 0.2,
          messages: [
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
                contextPack: input.contextPack,
                budget: input.budget
              })
            }
          ]
        };

        if (selectedConnection.kind === 'remote') {
          requestBody.response_format = { type: 'json_object' };
        } else {
          requestBody.max_tokens = Math.min(
            input.budget.maxOutputTokens ?? llmLocalMaxOutputTokens(),
            llmLocalMaxOutputTokens()
          );
          requestBody.options = { num_ctx: llmLocalNumCtx() };
          requestBody.think = false;
          requestBody.reasoning_effort = 'none';
        }

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
          const retryable = response.status >= 500 || response.status === 429;
          throw Object.assign(new Error(`LLM request failed: ${response.status}`), { retryable });
        }

        const rawBody = (await response.json()) as unknown;
        const body = this.asResponseBody(rawBody);
        const extracted = this.extractRuntimeOutput(body, input.expectedOutput.kind);
        if (!extracted.output) {
          return this.failedResult(
            input,
            startedAt,
            selectedModel,
            'LLM response did not include usable RuntimeOutput JSON',
            'OUTPUT_SCHEMA_INVALID',
            { responseShape: this.summarizeResponseShape(rawBody) }
          );
        }

        // Output schema problems are not retryable: a retry would produce the same shape.
        let output = extracted.output;
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

  /**
   * Multi-turn tool-loop mode for availableTools. Iterates up to MAX_TOOL_ROUNDS,
   * parsing `<<TOOL_CALL>>` blocks from model output, executing them, feeding results
   * back as `<<TOOL_RESULT>>` blocks. Final round forces JSON output to match the
   * expected RuntimeOutput kind.
   */
  private async runWithToolLoop(
    input: AgentRunInput,
    selectedConnection: RuntimeModelConnection,
    signal?: AbortSignal
  ): Promise<AgentRunResult> {
    const startedAt = nowIso();
    const selectedModel = selectedConnection.model;
    const rootPath = input.contextPack.workingDirectory?.path ?? '';
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
      'Use contextPack.taskContext, projectMap, workspaceManifest, and selectedEvidenceContents as usual.',
      input.expectedOutput.kind === 'agent_message'
        ? 'For agent_message, "content" must be a plain-text string in Chinese.'
        : '',
      input.expectedOutput.kind === 'task_execution_result'
        ? 'For task_execution_result, include changedArtifacts with file changes if applicable.'
        : ''
    ]
      .filter(Boolean)
      .join('\n');

    const contextPayload = JSON.stringify({
      phase: input.phase,
      expectedOutput: input.expectedOutput,
      contextPack: input.contextPack,
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
        stream: false,
        temperature: 0.2,
        messages
      };

      if (selectedConnection.kind === 'local') {
        requestBody.max_tokens = Math.min(input.budget.maxOutputTokens ?? llmLocalMaxOutputTokens(), llmLocalMaxOutputTokens());
        requestBody.options = { num_ctx: llmLocalNumCtx() };
      }

      let rawResponse: string;
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      let timedOut = false;
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
          body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
          return this.failedResult(
            input,
            startedAt,
            selectedModel,
            `Tool-loop LLM request failed: ${response.status}`,
            'MODEL_ERROR'
          );
        }

        const rawBody = (await response.json()) as unknown;
        const body = this.asResponseBody(rawBody);
        rawResponse = this.extractTextFromBody(body);
      } catch (error) {
        const isAbort = error instanceof Error && (error.name === 'AbortError' || Boolean(signal?.aborted));
        if (isAbort && timedOut && !signal?.aborted) {
          return this.failedResult(
            input,
            startedAt,
            selectedModel,
            `Tool-loop LLM request timed out after ${timeoutMs}ms`,
            'RUNTIME_TIMEOUT'
          );
        }
        if (isAbort) {
          const timeoutMessage = this.upstreamTimeoutMessage(signal);
          return this.failedResult(
            input,
            startedAt,
            selectedModel,
            timeoutMessage ?? 'Tool loop cancelled by user.',
            timeoutMessage ? 'RUNTIME_TIMEOUT' : 'RUNTIME_CANCELLED'
          );
        }
        return this.failedResult(
          input,
          startedAt,
          selectedModel,
          `Tool-loop fetch error: ${error instanceof Error ? error.message : String(error)}`,
          'MODEL_ERROR'
        );
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
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
            'OUTPUT_SCHEMA_INVALID'
          );
        }
        let output = extracted.output;
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
              content: `${input.agent.name} GenericLlmRuntime tool-loop started`,
              createdAt: startedAt
            },
            {
              runId: input.runId,
              type: 'runtime_completed',
              content: `${input.agent.name} GenericLlmRuntime tool-loop completed (${toolCallHistory.length} tool calls)`,
              createdAt: nowIso()
            }
          ],
          artifacts: [],
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
          const result = await this.workspaceTools.readFile(rootPath, call.input as { path?: unknown });
          const output = result.ok ? result.output : `ERROR [${result.errorCode}]: ${result.errorMessage}`;
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
  private buildLocalSystemPrompt(input: AgentRunInput): string {
    // For local small models, use ultra-minimal prompts to avoid triggering reasoning mode
    const parts = ['Return only valid JSON.', `Output kind: ${input.expectedOutput.kind}`];

    if (input.expectedOutput.kind === 'task_brief') {
      parts.push('Include: goal, scope, constraints, acceptanceCriteria.');
    } else if (input.expectedOutput.kind === 'agent_message') {
      parts.push('The "content" field must be plain-text string in Chinese.');
    } else if (input.expectedOutput.kind === 'task_execution_result') {
      parts.push('Include: summary, status.');
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
  private buildRemoteSystemPrompt(input: AgentRunInput): string {
    return [
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
      input.contextPack.workspaceManifest
        ? 'Before analyzing the user requirement, inspect contextPack.workspaceManifest for project structure and contextPack.selectedEvidenceContents for readable evidence content. workspaceSnapshot is only a manifest-style fallback and may omit file contents.'
        : 'No workspace manifest is available; say when file-level conclusions are assumptions.',
      'Be specific and useful. Avoid one-sentence generic output; include concrete decisions, assumptions, risks, and next actions.',
      input.expectedOutput.kind === 'agent_message'
        ? 'For agent_message, the "content" field must be one plain-text string (never an object or array). Write a detailed Chinese response with 3-6 concise paragraphs or bullets covering understanding, concerns, and recommendations.'
        : '',
      input.expectedOutput.kind === 'task_acceptance_decision'
        ? 'For task_acceptance_decision, decide whether this assigned agent can execute the currentTask. Return status accepted, blocked, or rejected; reason; optional missingContext; optional handoffSuggestion { targetAgentKey or targetAgentId, reason, riskLevel }; optional confidence; optional alternativeAgentKeys/alternativeAgentIds; and optional agentMessages. Do not reassign the task yourself.'
        : '',
      input.expectedOutput.kind === 'task_claim_decision'
        ? 'For legacy task_claim_decision, decide whether this agent should accept the currentTask. Return accepted, reason, optional confidence, optional alternativeAgentKeys/alternativeAgentIds, optional handoffSuggestion, and optional agentMessages for coordination. Do not reassign the task yourself.'
        : '',
      input.expectedOutput.kind === 'task_execution_result'
        ? 'For task_execution_result, include changedArtifacts. If this is a validation task or the agent is the Validation Agent, include a test_report artifact with metadata.validationEvidence mapping each taskContext.validationRules item to verdicts and taskContext.evidenceRefs, plus validatorAgentKey, validatorAgentId, and independentFromAgentKeys from taskContext.agentResponsibilities. If workspaceManifest is present, analyze the impact surface from manifest paths, but ground content-specific changes only in selectedEvidenceContents. Do not collapse a multi-file requirement into one file. Use agent-output only for auxiliary summaries. Include optional agentMessages when progress, risks, questions, or handoffs should be sent to other agents; target them with targetAgentKeys such as coordinator, frontend, backend, test, review.'
        : '',
      input.contextPack.workingDirectory
        ? 'A local working directory is selected. Return file changes only as RuntimeArtifactOutput.metadata.fileChanges with safe relative paths. The browser applies those changes inside the selected directory.'
        : 'No local working directory is selected. Do not return fileChanges.'
    ]
      .filter(Boolean)
      .join('\n');
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
    const candidates: Array<[string, unknown]> = [
      ['response_body', body],
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
      const output = this.toRuntimeOutput(value, expectedKind);
      if (output) {
        return { output, source };
      }
    }

    const extracted = this.extractMessageContent(body);
    if (!extracted.content) {
      return {};
    }

    const output = this.toRuntimeOutput(extracted.content, expectedKind);
    return output ? { output, source: extracted.source } : {};
  }

  private toRuntimeOutput(value: unknown, expectedKind: RuntimeOutputKind, depth = 0): RuntimeOutput | undefined {
    if (depth > 4 || value === undefined || value === null) {
      return undefined;
    }

    if (typeof value === 'string') {
      return this.parseRuntimeOutputText(value, expectedKind, depth);
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        const output = this.toRuntimeOutput(item, expectedKind, depth + 1);
        if (output) {
          return output;
        }
      }
      return undefined;
    }

    if (typeof value !== 'object') {
      return undefined;
    }

    const record = value as Record<string, unknown>;
    if (record.kind === expectedKind) {
      return record as RuntimeOutput;
    }
    if (expectedKind === 'task_acceptance_decision' && record.kind === 'task_claim_decision') {
      return this.coerceRuntimeOutputWithoutKind(record, expectedKind);
    }
    if (typeof record.kind === 'string') {
      return undefined;
    }

    const directOutput = this.coerceRuntimeOutputWithoutKind(record, expectedKind);
    if (directOutput && this.isDirectRuntimeOutputShape(record, expectedKind)) {
      return directOutput;
    }

    for (const key of ['output', 'result', 'final_output', 'data', 'content', 'message', 'text', 'output_text', 'value']) {
      const output = this.toRuntimeOutput(record[key], expectedKind, depth + 1);
      if (output) {
        return output;
      }
    }

    return directOutput;
  }

  private parseRuntimeOutputText(content: string, expectedKind: RuntimeOutputKind, depth: number) {
    const trimmed = content.trim();
    if (!trimmed) {
      return undefined;
    }

    let sawExplicitWrongKind = false;
    for (const candidate of this.jsonTextCandidates(trimmed)) {
      try {
        const parsed = JSON.parse(candidate) as unknown;
        sawExplicitWrongKind ||= this.hasExplicitWrongKind(parsed, expectedKind);
        const output = this.toRuntimeOutput(parsed, expectedKind, depth + 1);
        if (output) {
          return output;
        }
      } catch {
        // Try the next candidate shape.
      }
    }

    if (expectedKind === 'agent_message' && !sawExplicitWrongKind) {
      return {
        kind: 'agent_message',
        messageKind: 'summary',
        content: trimmed
      } satisfies AgentMessageOutput;
    }

    return undefined;
  }

  private coerceRuntimeOutputWithoutKind(
    record: Record<string, unknown>,
    expectedKind: RuntimeOutputKind
  ): RuntimeOutput | undefined {
    if (expectedKind === 'agent_message') {
      const content = this.firstPlainText(record.content, record.message, record.text, record.output_text, record.value).trim();
      if (!content) {
        return undefined;
      }
      return {
        kind: 'agent_message',
        messageKind: this.asAgentMessageKind(record.messageKind),
        content,
        targetAgentIds: this.optionalStringArray(record.targetAgentIds),
        targetAgentKeys: this.optionalStringArray(record.targetAgentKeys),
        mentionedAgentIds: this.optionalStringArray(record.mentionedAgentIds),
        relatedTaskIds: this.optionalStringArray(record.relatedTaskIds)
      } satisfies AgentMessageOutput;
    }

    if (expectedKind === 'task_brief') {
      const goal = this.firstPlainText(record.goal, record.summary, record.content).trim();
      if (!goal) {
        return undefined;
      }
      return {
        kind: 'task_brief',
        goal,
        scope: this.stringArray(record.scope),
        outOfScope: this.stringArray(record.outOfScope),
        constraints: this.stringArray(record.constraints),
        acceptanceCriteria: this.stringArray(record.acceptanceCriteria),
        risks: this.stringArray(record.risks),
        openQuestions: this.stringArray(record.openQuestions),
        suggestedTasks: Array.isArray(record.suggestedTasks) ? (record.suggestedTasks as never[]) : []
      };
    }

    if (expectedKind === 'task_execution_result') {
      const summary = this.firstPlainText(record.summary, record.content, record.message, record.text).trim();
      if (!summary) {
        return undefined;
      }
      return {
        kind: 'task_execution_result',
        status: this.asTaskExecutionStatus(record.status),
        summary,
        completedItems: this.stringArray(record.completedItems),
        changedArtifacts: this.artifacts(record.changedArtifacts),
        requestedContext: this.optionalContextRequest(record.requestedContext),
        agentMessages: this.agentMessages(record.agentMessages),
        nextSuggestedActions: this.stringArray(record.nextSuggestedActions),
        risks: this.stringArray(record.risks)
      };
    }

    if (expectedKind === 'task_acceptance_decision') {
      const reason = this.firstPlainText(record.reason, record.summary, record.content, record.message).trim();
      if (!reason && record.status === undefined && typeof record.accepted !== 'boolean') {
        return undefined;
      }
      return {
        kind: 'task_acceptance_decision',
        status: this.asTaskAcceptanceStatus(record.status, record.accepted),
        reason: reason || 'Model returned an acceptance decision without a reason.',
        missingContext: this.optionalStringArray(record.missingContext),
        handoffSuggestion: this.optionalHandoffSuggestion(record.handoffSuggestion),
        confidence: typeof record.confidence === 'number' ? record.confidence : undefined,
        alternativeAgentKeys: this.optionalStringArray(record.alternativeAgentKeys),
        alternativeAgentIds: this.optionalStringArray(record.alternativeAgentIds),
        agentMessages: this.agentMessages(record.agentMessages)
      } satisfies TaskAcceptanceDecisionOutput;
    }

    if (expectedKind === 'task_claim_decision') {
      const reason = this.firstPlainText(record.reason, record.summary, record.content, record.message).trim();
      if (!reason && typeof record.accepted !== 'boolean') {
        return undefined;
      }
      return {
        kind: 'task_claim_decision',
        accepted: typeof record.accepted === 'boolean' ? record.accepted : true,
        reason: reason || 'Model returned a claim decision without a reason.',
        confidence: typeof record.confidence === 'number' ? record.confidence : undefined,
        missingContext: this.optionalStringArray(record.missingContext),
        handoffSuggestion: this.optionalHandoffSuggestion(record.handoffSuggestion),
        alternativeAgentKeys: this.optionalStringArray(record.alternativeAgentKeys),
        alternativeAgentIds: this.optionalStringArray(record.alternativeAgentIds),
        agentMessages: this.agentMessages(record.agentMessages)
      } satisfies TaskClaimDecisionOutput;
    }

    if (expectedKind === 'post_review_report') {
      const recommendation = this.asPostReviewRecommendation(record.recommendation);
      if (!recommendation && record.isConsistentWithBrief === undefined) {
        return undefined;
      }
      return {
        kind: 'post_review_report',
        isConsistentWithBrief: record.isConsistentWithBrief !== false,
        matchedItems: this.stringArray(record.matchedItems),
        mismatchedItems: this.stringArray(record.mismatchedItems),
        missingItems: this.stringArray(record.missingItems),
        outOfScopeChanges: this.stringArray(record.outOfScopeChanges),
        testResults: this.stringArray(record.testResults),
        recommendation: recommendation ?? 'ask_user'
      } satisfies PostReviewReportOutput;
    }

    if (expectedKind === 'final_delivery') {
      const summary = this.firstPlainText(record.summary, record.content, record.message, record.text).trim();
      if (!summary) {
        return undefined;
      }
      return {
        kind: 'final_delivery',
        summary,
        completedItems: this.stringArray(record.completedItems),
        incompleteItems: this.stringArray(record.incompleteItems),
        risks: this.stringArray(record.risks),
        artifactRefs: this.stringArray(record.artifactRefs)
      } satisfies FinalDeliveryOutput;
    }

    if (expectedKind === 'user_message_handling_plan') {
      const coordinatorInstruction = this.firstPlainText(
        record.coordinatorInstruction,
        record.instruction,
        record.summary,
        record.content
      ).trim();
      if (!coordinatorInstruction && !record.intent) {
        return undefined;
      }
      return {
        kind: 'user_message_handling_plan',
        intent: this.asUserMessageIntent(record.intent),
        priority: this.asEventPriority(record.priority),
        shouldPause: record.shouldPause === true,
        affectedTaskIds: this.stringArray(record.affectedTaskIds),
        affectedAgentIds: this.stringArray(record.affectedAgentIds),
        requiresBriefRevision: record.requiresBriefRevision === true,
        requiresUserConfirmation: record.requiresUserConfirmation === true,
        coordinatorInstruction: coordinatorInstruction || 'Handle the user message according to the current session state.'
      } satisfies UserMessageHandlingPlanOutput;
    }

    return undefined;
  }

  private isDirectRuntimeOutputShape(record: Record<string, unknown>, expectedKind: RuntimeOutputKind) {
    if (expectedKind === 'agent_message') {
      return (
        record.content !== undefined ||
        record.messageKind !== undefined ||
        record.targetAgentKeys !== undefined ||
        record.targetAgentIds !== undefined
      );
    }
    if (expectedKind === 'task_brief') {
      return record.goal !== undefined || record.acceptanceCriteria !== undefined || record.suggestedTasks !== undefined;
    }
    if (expectedKind === 'task_execution_result') {
      return record.summary !== undefined || record.status !== undefined || record.completedItems !== undefined;
    }
    if (expectedKind === 'task_acceptance_decision') {
      return record.status !== undefined || record.accepted !== undefined || record.reason !== undefined;
    }
    if (expectedKind === 'task_claim_decision') {
      return record.accepted !== undefined || record.reason !== undefined;
    }
    if (expectedKind === 'post_review_report') {
      return record.recommendation !== undefined || record.isConsistentWithBrief !== undefined;
    }
    if (expectedKind === 'final_delivery') {
      return record.summary !== undefined || record.completedItems !== undefined || record.artifactRefs !== undefined;
    }
    return record.intent !== undefined || record.coordinatorInstruction !== undefined;
  }

  private hasExplicitWrongKind(value: unknown, expectedKind: RuntimeOutputKind, depth = 0): boolean {
    if (depth > 4 || value === undefined || value === null) {
      return false;
    }
    if (Array.isArray(value)) {
      return value.some((item) => this.hasExplicitWrongKind(item, expectedKind, depth + 1));
    }
    if (typeof value !== 'object') {
      return false;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.kind === 'string') {
      return record.kind !== expectedKind;
    }
    return ['output', 'result', 'final_output', 'data', 'content', 'message', 'text', 'output_text', 'value'].some((key) =>
      this.hasExplicitWrongKind(record[key], expectedKind, depth + 1)
    );
  }

  private firstPlainText(...values: unknown[]) {
    for (const value of values) {
      const text = this.toPlainText(value).trim();
      if (text) {
        return text;
      }
    }
    return '';
  }

  private stringArray(value: unknown): string[] {
    return this.optionalStringArray(value) ?? [];
  }

  private optionalStringArray(value: unknown): string[] | undefined {
    if (value === undefined || value === null) {
      return undefined;
    }
    const values = Array.isArray(value) ? value : [value];
    return values.map((item) => this.toPlainText(item).trim()).filter(Boolean);
  }

  private agentMessages(value: unknown): AgentMessageOutput[] | undefined {
    if (!Array.isArray(value)) {
      return undefined;
    }
    const messages = value
      .map((item) =>
        item && typeof item === 'object'
          ? this.coerceRuntimeOutputWithoutKind(item as Record<string, unknown>, 'agent_message')
          : this.toRuntimeOutput(item, 'agent_message')
      )
      .filter((item): item is AgentMessageOutput => item?.kind === 'agent_message');
    return messages.length ? messages : undefined;
  }

  private artifacts(value: unknown): RuntimeArtifactOutput[] {
    return Array.isArray(value) ? (value as RuntimeArtifactOutput[]) : [];
  }

  private optionalContextRequest(value: unknown): RuntimeContextRequest | undefined {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as RuntimeContextRequest) : undefined;
  }

  private optionalHandoffSuggestion(value: unknown): TaskAcceptanceDecisionOutput['handoffSuggestion'] {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }
    const record = value as Record<string, unknown>;
    const reason = this.firstPlainText(record.reason, record.summary, record.content, record.message).trim();
    if (!reason) {
      return undefined;
    }
    const riskLevel = ['low', 'medium', 'high'].includes(String(record.riskLevel))
      ? (record.riskLevel as 'low' | 'medium' | 'high')
      : undefined;
    return {
      targetAgentKey: typeof record.targetAgentKey === 'string' ? record.targetAgentKey : undefined,
      targetAgentId: typeof record.targetAgentId === 'string' ? record.targetAgentId : undefined,
      reason,
      missingContext: this.optionalStringArray(record.missingContext),
      riskLevel
    };
  }

  private asAgentMessageKind(value: unknown): AgentMessageOutput['messageKind'] {
    return ['discussion', 'answer', 'handoff', 'progress', 'risk', 'decision', 'summary'].includes(String(value))
      ? (value as AgentMessageOutput['messageKind'])
      : 'summary';
  }

  private asTaskExecutionStatus(value: unknown) {
    return ['completed', 'failed', 'blocked', 'needs_review'].includes(String(value))
      ? (value as 'completed' | 'failed' | 'blocked' | 'needs_review')
      : 'completed';
  }

  private asTaskAcceptanceStatus(status: unknown, accepted?: unknown): TaskAcceptanceDecisionOutput['status'] {
    if (['accepted', 'blocked', 'rejected'].includes(String(status))) {
      return status as TaskAcceptanceDecisionOutput['status'];
    }
    if (typeof accepted === 'boolean') {
      return accepted ? 'accepted' : 'rejected';
    }
    return 'accepted';
  }

  private asPostReviewRecommendation(value: unknown) {
    return ['deliver', 'rework', 'ask_user'].includes(String(value))
      ? (value as 'deliver' | 'rework' | 'ask_user')
      : undefined;
  }

  private asUserMessageIntent(value: unknown) {
    return ['clarification', 'constraint', 'command', 'question', 'correction', 'knowledge_input', 'preference_input'].includes(
      String(value)
    )
      ? (value as UserMessageHandlingPlanOutput['intent'])
      : 'question';
  }

  private asEventPriority(value: unknown) {
    return ['low', 'normal', 'high', 'critical'].includes(String(value))
      ? (value as UserMessageHandlingPlanOutput['priority'])
      : 'normal';
  }

  private jsonTextCandidates(content: string) {
    const candidates = new Set<string>([content]);
    const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
    if (fenced) {
      candidates.add(fenced);
    }

    const firstBrace = content.indexOf('{');
    const lastBrace = content.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      candidates.add(content.slice(firstBrace, lastBrace + 1));
    }

    return [...candidates];
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
    code: RuntimeError['code'] = 'MODEL_ERROR',
    details?: Record<string, unknown>
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
          metadata: { message, code, details },
          createdAt: nowIso()
        }
      ],
      artifacts: [],
      usage: this.toUsage(undefined, model),
      error: {
        code,
        message,
        retryable: !['OUTPUT_SCHEMA_INVALID', 'RUNTIME_CANCELLED', 'CAPABILITY_BLOCKED'].includes(code),
        details
      }
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
