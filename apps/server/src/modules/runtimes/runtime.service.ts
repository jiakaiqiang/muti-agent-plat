import { Injectable } from '@nestjs/common';
import type { AgentMessageOutput, AgentRunInput, AgentRunResult, RuntimeError, RuntimeInvocationStatus } from '@agent-cluster/shared';
import { runtimeMaxRetries, runtimeTimeoutMs } from '../../common/runtime-config.js';
import { nowIso } from '../../common/time.js';
import { PersistenceService } from '../persistence/persistence.service.js';
import { ModelsService } from '../models/models.service.js';
import { ConnectionsService } from '../models/connections.service.js';
import { ClaudeCodeRuntimeAdapterService } from './claude-code-runtime-adapter.service.js';
import { CodexRuntimeAdapterService } from './codex-runtime-adapter.service.js';
import { GenericLlmRuntimeService } from './generic-llm-runtime.service.js';
import { MockRuntimeService } from './mock-runtime.service.js';

export type RuntimeInvocationLog = {
  id: string;
  runId: string;
  sessionId: string;
  taskId?: string;
  agentId: string;
  agentKey: string;
  runtimeType: string;
  phase: string;
  status: string;
  attempts: number;
  contextPack: AgentRunInput['contextPack'];
  expectedOutput: AgentRunInput['expectedOutput'];
  usage?: AgentRunResult['usage'];
  error?: AgentRunResult['error'];
  startedAt: string;
  completedAt: string;
};

type AbortReason = 'timeout' | 'cancel';

@Injectable()
export class RuntimeService {
  private readonly invocationsBySession = new Map<string, RuntimeInvocationLog[]>();
  private readonly activeRuns = new Map<string, AbortController>();
  private readonly abortReasons = new Map<string, AbortReason>();

  constructor(
    private readonly persistence: PersistenceService,
    private readonly models: ModelsService,
    private readonly connections: ConnectionsService,
    private readonly mockRuntime: MockRuntimeService,
    private readonly genericLlmRuntime: GenericLlmRuntimeService,
    private readonly codexRuntime: CodexRuntimeAdapterService,
    private readonly claudeCodeRuntime: ClaudeCodeRuntimeAdapterService
  ) {
    const persisted = this.persistence.getCollection<Record<string, RuntimeInvocationLog[]>>('runtimeInvocationsBySession', {});
    for (const [sessionId, invocations] of Object.entries(persisted)) {
      this.invocationsBySession.set(sessionId, invocations);
    }
  }

  async run(input: AgentRunInput) {
    const model = this.models.resolveForAgent(input.agent);
    const credential = this.connections.getCredential(model.connectionId);
    const resolvedInput: AgentRunInput = { ...input, model };
    const startedAt = nowIso();
    const maxRetries = runtimeMaxRetries();
    let attempts = 0;
    let result: AgentRunResult;
    do {
      attempts += 1;
      result = await this.invokeWithControls(resolvedInput, credential);
    } while (
      result.status !== 'completed' &&
      result.status !== 'cancelled' &&
      Boolean(result.error?.retryable) &&
      attempts <= maxRetries
    );
    this.recordInvocation(resolvedInput, result, startedAt, attempts);
    return result;
  }

  /** Requests cancellation of an in-flight run. Signal-aware adapters stop promptly. */
  async cancel(runId: string) {
    this.requestAbort(runId, 'cancel');
  }

  listInvocations(sessionId: string) {
    return this.invocationsBySession.get(sessionId) ?? [];
  }

  private invokeWithControls(input: AgentRunInput, credential?: string): Promise<AgentRunResult> {
    const controller = new AbortController();
    this.activeRuns.set(input.runId, controller);
    const timer = setTimeout(() => this.requestAbort(input.runId, 'timeout'), runtimeTimeoutMs());

    const lifecycle = new Promise<AgentRunResult>((resolvePromise) => {
      controller.signal.addEventListener(
        'abort',
        () => {
          const reason = this.abortReasons.get(input.runId);
          resolvePromise(reason === 'cancel' ? this.cancelledResult(input) : this.timeoutResult(input));
        },
        { once: true }
      );
    });

    return Promise.race([this.invokeAdapter(input, controller.signal, credential), lifecycle]).finally(() => {
      clearTimeout(timer);
      this.activeRuns.delete(input.runId);
      this.abortReasons.delete(input.runId);
    });
  }

  private invokeAdapter(input: AgentRunInput, signal: AbortSignal, credential?: string): Promise<AgentRunResult> {
    switch (input.agent.runtimeType) {
      case 'generic_llm':
        return this.genericLlmRuntime.run(input, credential);
      case 'codex':
        return this.codexRuntime.run(input, signal);
      case 'claude_code':
        return this.claudeCodeRuntime.run(input, signal);
      case 'mock':
        return this.mockRuntime.run(input);
      default:
        return this.mockRuntime.run(input);
    }
  }

  private requestAbort(runId: string, reason: AbortReason) {
    const controller = this.activeRuns.get(runId);
    if (controller && !controller.signal.aborted) {
      this.abortReasons.set(runId, reason);
      controller.abort();
    }
  }

  private timeoutResult(input: AgentRunInput): AgentRunResult {
    return this.controlResult(input, 'failed', {
      code: 'RUNTIME_TIMEOUT',
      message: `Runtime timed out after ${runtimeTimeoutMs()}ms during ${input.phase}.`,
      retryable: true
    });
  }

  private cancelledResult(input: AgentRunInput): AgentRunResult {
    return this.controlResult(input, 'cancelled', {
      code: 'RUNTIME_CANCELLED',
      message: `Runtime was cancelled during ${input.phase}.`,
      retryable: false
    });
  }

  private controlResult(input: AgentRunInput, status: RuntimeInvocationStatus, error: RuntimeError): AgentRunResult {
    return {
      runId: input.runId,
      runtimeType: input.agent.runtimeType,
      status,
      output: {
        kind: 'agent_message',
        messageKind: 'risk',
        content: `${input.agent.name} runtime ${status} during ${input.phase}: ${error.message}`
      } satisfies AgentMessageOutput,
      events: [
        {
          runId: input.runId,
          type: 'runtime_failed',
          content: `${input.agent.name} runtime ${status} during ${input.phase}`,
          metadata: { code: error.code },
          createdAt: nowIso()
        }
      ],
      artifacts: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, model: input.agent.runtimeType },
      error
    };
  }

  private recordInvocation(input: AgentRunInput, result: AgentRunResult, startedAt: string, attempts: number) {
    const log: RuntimeInvocationLog = {
      id: crypto.randomUUID(),
      runId: input.runId,
      sessionId: input.sessionId,
      taskId: input.taskId,
      agentId: input.agent.id,
      agentKey: input.agent.key,
      runtimeType: result.runtimeType,
      phase: input.phase,
      status: result.status,
      attempts,
      contextPack: input.contextPack,
      expectedOutput: input.expectedOutput,
      usage: result.usage,
      error: result.error,
      startedAt,
      completedAt: nowIso()
    };
    this.invocationsBySession.set(input.sessionId, [...this.listInvocations(input.sessionId), log]);
    this.persistence.setCollection('runtimeInvocationsBySession', Object.fromEntries(this.invocationsBySession));
  }
}
