import { Injectable } from '@nestjs/common';
import type { AgentMessageOutput, AgentRunInput, AgentRunResult, AgentRuntimeAdapter, RuntimeType } from '@agent-cluster/shared';
import { nowIso } from '../../common/time.js';
import { PersistenceService } from '../persistence/persistence.service.js';
import { ClaudeCodeRuntimeAdapterService } from './claude-code-runtime-adapter.service.js';
import { CodeReaderRuntimeAdapterService } from './code-reader-runtime-adapter.service.js';
import { CodexRuntimeAdapterService } from './codex-runtime-adapter.service.js';
import { GenericLlmRuntimeService } from './generic-llm-runtime.service.js';
import { MockRuntimeService } from './mock-runtime.service.js';
import { RuntimeRegistryService } from './runtime-registry.service.js';
import { TestRunnerRuntimeAdapterService } from './test-runner-runtime-adapter.service.js';

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
  contextPack: AgentRunInput['contextPack'];
  expectedOutput: AgentRunInput['expectedOutput'];
  usage?: AgentRunResult['usage'];
  error?: AgentRunResult['error'];
  startedAt: string;
  completedAt: string;
};

@Injectable()
export class RuntimeService {
  private readonly invocationsBySession = new Map<string, RuntimeInvocationLog[]>();

  constructor(
    private readonly persistence: PersistenceService,
    private readonly registry: RuntimeRegistryService,
    private readonly mockRuntime: MockRuntimeService,
    private readonly genericLlmRuntime: GenericLlmRuntimeService,
    private readonly codexRuntime: CodexRuntimeAdapterService,
    private readonly claudeCodeRuntime: ClaudeCodeRuntimeAdapterService,
    private readonly codeReaderRuntime: CodeReaderRuntimeAdapterService,
    private readonly testRunnerRuntime: TestRunnerRuntimeAdapterService
  ) {
    const persisted = this.persistence.getCollection<Record<string, RuntimeInvocationLog[]>>('runtimeInvocationsBySession', {});
    for (const [sessionId, invocations] of Object.entries(persisted)) {
      this.invocationsBySession.set(sessionId, invocations);
    }

    void this.registry.registerAdapter(this.mockRuntime);
    void this.registry.registerAdapter(this.genericLlmRuntime);
    void this.registry.registerAdapter(this.codexRuntime);
    void this.registry.registerAdapter(this.claudeCodeRuntime);
    void this.registry.registerAdapter(this.codeReaderRuntime);
    void this.registry.registerAdapter(this.testRunnerRuntime);
  }

  async run(input: AgentRunInput, signal?: AbortSignal) {
    const startedAt = nowIso();
    const adapter = this.registry.getAdapter(input.agent.runtimeType);
    let result: AgentRunResult;
    if (!adapter) {
      result = this.unsupportedResult(input, `Unsupported runtime: ${input.agent.runtimeType}`);
    } else {
      try {
        result = await adapter.run(input, signal);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result = this.unsupportedResult(input, message);
      }
    }
    this.recordInvocation(input, result, startedAt);
    return result;
  }

  listInvocations(sessionId: string) {
    return this.invocationsBySession.get(sessionId) ?? [];
  }

  private recordInvocation(input: AgentRunInput, result: AgentRunResult, startedAt: string) {
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

  private unsupportedResult(input: AgentRunInput, message: string): AgentRunResult {
    const normalizedMessage = message.toLowerCase().includes('runtime not implemented')
      ? message
      : `${message}; runtime not implemented`;
    return {
      runId: input.runId,
      runtimeType: input.agent.runtimeType,
      status: 'failed',
      output: {
        kind: 'agent_message',
        messageKind: 'risk',
        content: `${input.agent.name} 的 ${input.agent.runtimeType} 运行时尚未实现。`
      } satisfies AgentMessageOutput,
      events: [
        {
          runId: input.runId,
          type: 'runtime_failed',
          content: `${input.agent.name} 的运行时尚未实现：${input.agent.runtimeType}`,
          metadata: {
            code: 'CAPABILITY_BLOCKED',
            message: normalizedMessage
          },
          createdAt: nowIso()
        }
      ],
      artifacts: [],
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        model: input.agent.runtimeType
      },
      error: {
        code: 'CAPABILITY_BLOCKED',
        message: normalizedMessage,
        retryable: false
      }
    };
  }
}
