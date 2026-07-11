import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  AgentMessageOutput,
  AgentRunInput,
  AgentRunResult,
  AgentRuntimeEvent,
  AgentRuntimeRunHandle,
  RuntimeInvocationProfileSnapshot,
  RuntimeType
} from '@agent-cluster/shared';
import { engineeringRuntimeStreamingEnabledFor } from '../../common/runtime-config.js';
import { nowIso } from '../../common/time.js';
import { calculateInputTokenEstimationError, type InputTokenEstimationError } from '../../common/token.js';
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
  inputTokenEstimation?: InputTokenEstimationError;
  streamMetrics?: AgentRunResult['streamMetrics'];
  error?: AgentRunResult['error'];
  profileSnapshot?: RuntimeInvocationProfileSnapshot;
  cliSessionId?: string;
  workDir?: string;
  startedAt: string;
  completedAt: string;
};

export type RuntimeExecutionHandle = AgentRuntimeRunHandle & {
  hasStreamingEvents: boolean;
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

  getAdapter(type: RuntimeType) {
    return this.registry.getAdapter(type);
  }

  start(input: AgentRunInput, signal?: AbortSignal): RuntimeExecutionHandle {
    const startedAt = nowIso();
    const runtimeType = input.executionTarget?.runtimeType ?? input.agent.runtimeType;
    const adapter = this.registry.getAdapter(runtimeType);
    let handle: AgentRuntimeRunHandle;
    if (!adapter) {
      handle = settledHandle(this.unsupportedResult(input, `Unsupported runtime: ${runtimeType}`));
    } else {
      try {
        const validation = validateResumeInput(input);
        const firstInput = validation.valid ? input : withoutResume(input);
        const firstHandle = startAdapter(adapter, firstInput, signal);
        handle = validation.valid
          ? withResumeFallback(adapter, input, firstHandle, signal)
          : withInitialFallbackNotice(firstHandle, input, validation.reason ?? 'Resume metadata is invalid.');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        handle = settledHandle(this.unsupportedResult(input, message));
      }
    }
    const result = handle.result
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        return this.unsupportedResult(input, message);
      })
      .then((resolved) => {
        this.recordInvocation(input, resolved, startedAt);
        return resolved;
      });
    return {
      events: handle.events,
      result,
      cancel: handle.cancel,
      hasStreamingEvents:
        Boolean(adapter?.start) && engineeringRuntimeStreamingEnabledFor(input.agent.runtimeType)
    };
  }

  async run(input: AgentRunInput, signal?: AbortSignal) {
    return this.start(input, signal).result;
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
      inputTokenEstimation: calculateInputTokenEstimationError(
        input.estimatedInputTokens,
        result.usage?.inputTokens
      ),
      streamMetrics: result.streamMetrics,
      error: result.error,
      profileSnapshot: this.buildProfileSnapshot(input, result),
      cliSessionId: result.runtimeSession?.cliSessionId ?? this.extractCliSessionId(result),
      workDir: result.runtimeSession?.workDir ?? this.extractWorkDir(input),
      startedAt,
      completedAt: nowIso()
    };
    this.invocationsBySession.set(input.sessionId, [...this.listInvocations(input.sessionId), log]);
    this.persistence.setCollection('runtimeInvocationsBySession', Object.fromEntries(this.invocationsBySession));
  }

  private buildProfileSnapshot(input: AgentRunInput, result: AgentRunResult): RuntimeInvocationProfileSnapshot {
    const agent = input.agent;
    const profileHash = createHash('sha256')
      .update(agent.systemPrompt ?? agent.profileMarkdown ?? '')
      .digest('hex');
    return {
      runtimeType: result.runtimeType,
      modelId: result.usage?.model ?? agent.modelId,
      agentId: agent.id,
      profileHash,
      resolvedSkillIds: agent.skillIds ?? [],
      resolvedSkillRevisions: {},
      resolvedToolIds: agent.capabilityIds ?? []
    };
  }

  private extractCliSessionId(result: AgentRunResult): string | undefined {
    for (const event of result.events) {
      const value = event.metadata?.cliSessionId;
      if (typeof value === 'string' && value.length > 0) return value;
      const payload = event.metadata?.payload as { cliSessionId?: unknown } | undefined;
      if (typeof payload?.cliSessionId === 'string' && payload.cliSessionId.length > 0) {
        return payload.cliSessionId;
      }
    }
    return undefined;
  }

  private extractWorkDir(input: AgentRunInput): string | undefined {
    const resumeWorkDir = (input.options as { resume?: { workDir?: unknown } } | undefined)?.resume?.workDir;
    if (typeof resumeWorkDir === 'string' && resumeWorkDir.length > 0) return resumeWorkDir;
    const optionWorkDir = (input.options as { workDir?: unknown } | undefined)?.workDir;
    if (typeof optionWorkDir === 'string' && optionWorkDir.length > 0) return optionWorkDir;
    const wd = input.contextPack.workingDirectory;
    return wd?.kind === 'server_local' ? wd.path : undefined;
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

  findPriorInvocation(
    sessionId: string,
    agentId: string,
    taskId: string,
    runtimeType?: RuntimeType
  ): { cliSessionId?: string; workDir?: string } | undefined {
    const invocations = this.invocationsBySession.get(sessionId) ?? [];
    const candidates = invocations
      .filter(
        (inv) =>
          inv.agentId === agentId &&
          inv.taskId === taskId &&
          (!runtimeType || inv.runtimeType === runtimeType) &&
          inv.status === 'completed'
      )
      .sort((a, b) => b.completedAt.localeCompare(a.completedAt));
    const latest = candidates[0];
    if (!latest) return undefined;
    return {
      cliSessionId: latest.cliSessionId,
      workDir: latest.workDir
    };
  }
}

function startAdapter(
  adapter: { start?: AgentRuntimeRunHandleFactory; run: (input: AgentRunInput, signal?: AbortSignal) => Promise<AgentRunResult> },
  input: AgentRunInput,
  signal?: AbortSignal
): AgentRuntimeRunHandle {
  return adapter.start?.(input, signal) ?? promiseHandle(adapter.run(input, signal));
}

type AgentRuntimeRunHandleFactory = (
  input: AgentRunInput,
  signal?: AbortSignal
) => AgentRuntimeRunHandle;

function resumeRef(input: AgentRunInput): { cliSessionId?: string; workDir?: string } | undefined {
  const raw = input.options?.resume;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const resume = raw as Record<string, unknown>;
  return {
    cliSessionId: typeof resume.cliSessionId === 'string' ? resume.cliSessionId : undefined,
    workDir: typeof resume.workDir === 'string' ? resume.workDir : undefined
  };
}

function validateResumeInput(input: AgentRunInput): { valid: boolean; reason?: string } {
  const resume = resumeRef(input);
  if (!resume?.cliSessionId) return { valid: true };
  const allowedWorkDir =
    input.contextPack.workingDirectory?.kind === 'server_local'
      ? input.contextPack.workingDirectory.path
      : undefined;
  if (!allowedWorkDir) {
    return { valid: false, reason: 'Resume requires a server_local working directory.' };
  }
  if (resume.workDir && resolve(resume.workDir) !== resolve(allowedWorkDir)) {
    return { valid: false, reason: 'Resume workDir is outside the current session working directory.' };
  }
  const workDir = resume.workDir ?? allowedWorkDir;
  if (!existsSync(workDir)) {
    return { valid: false, reason: `Resume workDir does not exist: ${workDir}` };
  }
  return { valid: true };
}

function withoutResume(input: AgentRunInput): AgentRunInput {
  const options = { ...(input.options ?? {}) };
  delete options.resume;
  return { ...input, options: Object.keys(options).length > 0 ? options : undefined };
}

function shouldFallbackResume(input: AgentRunInput, result: AgentRunResult): boolean {
  const expected = resumeRef(input)?.cliSessionId;
  if (!expected || result.status === 'cancelled') return false;
  if (result.status === 'completed') {
    return result.runtimeSession?.cliSessionId !== expected;
  }
  return result.error?.code !== 'OUTPUT_SCHEMA_INVALID' && result.error?.code !== 'RUNTIME_CANCELLED';
}

function fallbackEvent(input: AgentRunInput, reason: string): AgentRuntimeEvent {
  return {
    runId: input.runId,
    type: 'runtime_progress',
    content: 'Runtime session resume failed; retrying once with a new session.',
    metadata: {
      code: 'RESUME_FALLBACK',
      previousCliSessionId: resumeRef(input)?.cliSessionId,
      reason
    },
    createdAt: nowIso()
  };
}

function withInitialFallbackNotice(
  handle: AgentRuntimeRunHandle,
  input: AgentRunInput,
  reason: string
): AgentRuntimeRunHandle {
  return {
    events: prependEvent(fallbackEvent(input, reason), handle.events),
    result: handle.result,
    cancel: handle.cancel
  };
}

function withResumeFallback(
  adapter: { start?: AgentRuntimeRunHandleFactory; run: (input: AgentRunInput, signal?: AbortSignal) => Promise<AgentRunResult> },
  input: AgentRunInput,
  firstHandle: AgentRuntimeRunHandle,
  signal?: AbortSignal
): AgentRuntimeRunHandle {
  if (!resumeRef(input)?.cliSessionId) return firstHandle;
  const queue = new RuntimeEventQueue();
  let activeHandle = firstHandle;
  let cancelled = false;

  const result = (async () => {
    try {
      const firstPump = pumpEvents(firstHandle.events, queue);
      const firstResult = await firstHandle.result;
      await firstPump;
      if (cancelled || !shouldFallbackResume(input, firstResult)) return firstResult;

      const reason =
        firstResult.status === 'completed'
          ? `Resumed session id mismatch: ${firstResult.runtimeSession?.cliSessionId ?? 'missing'}.`
          : firstResult.error?.message ?? `Resume attempt ended with ${firstResult.status}.`;
      queue.push(fallbackEvent(input, reason));

      const fallbackInput = withoutResume(input);
      activeHandle = startAdapter(adapter, fallbackInput, signal);
      const fallbackPump = pumpEvents(activeHandle.events, queue);
      const fallbackResult = await activeHandle.result;
      await fallbackPump;
      return fallbackResult;
    } finally {
      queue.close();
    }
  })();

  return {
    events: queue,
    result,
    cancel: async () => {
      cancelled = true;
      await activeHandle.cancel();
    }
  };
}

function prependEvent(
  first: AgentRuntimeEvent,
  rest: AsyncIterable<AgentRuntimeEvent>
): AsyncIterable<AgentRuntimeEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      yield first;
      yield* rest;
    }
  };
}

async function pumpEvents(events: AsyncIterable<AgentRuntimeEvent>, queue: RuntimeEventQueue) {
  try {
    for await (const event of events) queue.push(event);
  } catch {
    // Result carries the authoritative runtime failure.
  }
}

class RuntimeEventQueue implements AsyncIterable<AgentRuntimeEvent> {
  private readonly queue: AgentRuntimeEvent[] = [];
  private readonly waiters: Array<(value: IteratorResult<AgentRuntimeEvent>) => void> = [];
  private closed = false;

  push(event: AgentRuntimeEvent) {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value: event });
    else this.queue.push(event);
  }

  close() {
    this.closed = true;
    while (this.waiters.length > 0) this.waiters.shift()?.({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentRuntimeEvent> {
    return {
      next: () => {
        const event = this.queue.shift();
        if (event) return Promise.resolve({ done: false, value: event });
        if (this.closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise<IteratorResult<AgentRuntimeEvent>>((resolveNext) => this.waiters.push(resolveNext));
      }
    };
  }
}

function emptyEvents(): AsyncIterable<AgentRuntimeEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      // no intermediate frames
    }
  };
}

function settledHandle(result: AgentRunResult): AgentRuntimeRunHandle {
  return { events: emptyEvents(), result: Promise.resolve(result), cancel: async () => {} };
}

function promiseHandle(result: Promise<AgentRunResult>): AgentRuntimeRunHandle {
  return { events: emptyEvents(), result, cancel: async () => {} };
}
