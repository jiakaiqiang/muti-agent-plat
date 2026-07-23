import { Injectable, Optional, type OnModuleInit } from '@nestjs/common';
import type {
  AgentMessageOutput,
  AgentRunResult,
  AgentRuntimeAdapter,
  AgentRuntimeEvent,
  AgentRuntimeRunHandle,
  InvocationPlan,
  ResolvedExecutionTarget,
  ResolvedToolCatalog,
  RuntimeInvocationProfileSnapshot,
  RuntimeAttemptTrace,
  RuntimeAvailability,
  RuntimeAvailabilityStatus,
  RuntimeType
} from '@agent-cluster/shared';
import { createAgentMessageOutput } from '@agent-cluster/shared';
import { runtimeStreamingEnabledFor } from '../../common/runtime-config.js';
import { nowIso } from '../../common/time.js';
import { ensureStructuredTermination } from '../../common/execution-termination.js';
import { PersistenceService } from '../persistence/persistence.service.js';
import { ClaudeCodeRuntimeAdapterService } from './claude-code-runtime-adapter.service.js';
import { CodeReaderRuntimeAdapterService } from './code-reader-runtime-adapter.service.js';
import { CodexRuntimeAdapterService } from './codex-runtime-adapter.service.js';
import { GenericLlmRuntimeService } from './generic-llm-runtime.service.js';
import { MockRuntimeService } from './mock-runtime.service.js';
import { RuntimeRegistryService } from './runtime-registry.service.js';
import { normalizeRuntimeResultContext } from './runtime-result-context-normalizer.js';
import { TestRunnerRuntimeAdapterService } from './test-runner-runtime-adapter.service.js';
import { WorktreeExecutionService } from '../worktree-execution/worktree-execution.service.js';
import { BrowserWorkspaceMirrorService } from '../worktree-execution/browser-workspace-mirror.service.js';
import { runtimeOutputContractAudit } from './runtime-output-schema.js';
import { emptyRuntimeSystemEvidence } from './runtime-system-evidence.js';

export type RuntimeInvocationLog = {
  id: string;
  dataEpoch: string;
  invocationId: string;
  sessionId: string;
  taskId?: string;
  agentId: string;
  agentKey: string;
  runtimeType: RuntimeType;
  modelId?: string;
  phase: string;
  status: string;
  executionTarget: ResolvedExecutionTarget;
  toolCatalog: ResolvedToolCatalog;
  contextEnvelope: InvocationPlan['contextEnvelope'];
  expectedOutput: InvocationPlan['expectedOutput'];
  outputContract: ReturnType<typeof runtimeOutputContractAudit>;
  budget: InvocationPlan['budget'];
  usage?: AgentRunResult['usage'];
  streamMetrics?: AgentRunResult['streamMetrics'];
  runtimeDiagnostics?: AgentRunResult['runtimeDiagnostics'];
  systemEvidence: AgentRunResult['systemEvidence'];
  error?: AgentRunResult['error'];
  termination?: AgentRunResult['termination'];
  profileSnapshot: RuntimeInvocationProfileSnapshot;
  cliSessionId?: string;
  workDir?: string;
  workspaceExecution?: AgentRunResult['workspaceExecution'];
  attempt?: RuntimeAttemptTrace;
  startedAt: string;
  completedAt: string;
};

export type RuntimeExecutionHandle = AgentRuntimeRunHandle & {
  hasStreamingEvents: boolean;
};

@Injectable()
export class RuntimeService implements OnModuleInit {
  private readonly invocationsBySession = new Map<string, RuntimeInvocationLog[]>();
  private readonly registrationReady: Promise<void>;

  constructor(
    private readonly persistence: PersistenceService,
    private readonly registry: RuntimeRegistryService,
    private readonly mockRuntime: MockRuntimeService,
    private readonly genericLlmRuntime: GenericLlmRuntimeService,
    private readonly codexRuntime: CodexRuntimeAdapterService,
    private readonly claudeCodeRuntime: ClaudeCodeRuntimeAdapterService,
    private readonly codeReaderRuntime: CodeReaderRuntimeAdapterService,
    private readonly testRunnerRuntime: TestRunnerRuntimeAdapterService,
    @Optional() private readonly worktreeExecution?: WorktreeExecutionService,
    @Optional() private readonly browserWorkspaceMirror?: BrowserWorkspaceMirrorService
  ) {
    const persisted = this.persistence.getCollection<Record<string, RuntimeInvocationLog[]>>(
      'runtimeInvocationsBySession',
      {}
    );
    const dataEpoch = this.persistence.currentDataEpoch();
    for (const [sessionId, invocations] of Object.entries(persisted)) {
      for (const invocation of invocations) {
        if (typeof invocation.dataEpoch !== 'string' || !invocation.dataEpoch) {
          throw new Error(`CUTOVER_REQUIRED: persisted RuntimeInvocation has no dataEpoch: ${invocation.id ?? 'unknown'}`);
        }
        if (invocation.dataEpoch !== dataEpoch) {
          throw new Error(
            `STALE_DATA_EPOCH: RuntimeInvocation ${invocation.id} belongs to ${invocation.dataEpoch}, current epoch is ${dataEpoch}.`
          );
        }
        if (!invocation.expectedOutput?.kind) {
          throw new Error(`CUTOVER_REQUIRED: persisted RuntimeInvocation has no expected output kind: ${invocation.id}`);
        }
        const currentContract = runtimeOutputContractAudit(invocation.expectedOutput.kind);
        if (
          invocation.expectedOutput?.schemaVersion !== '1.0' ||
          invocation.outputContract?.contractVersion !== currentContract.contractVersion ||
          invocation.outputContract?.contractId !== currentContract.contractId ||
          invocation.outputContract?.schemaHash !== currentContract.schemaHash ||
          !invocation.systemEvidence ||
          invocation.systemEvidence.invocationId !== invocation.invocationId
        ) {
          throw new Error(
            `CUTOVER_REQUIRED: persisted RuntimeInvocation does not satisfy the v3 contract: ${invocation.id}`
          );
        }
      }
      this.invocationsBySession.set(sessionId, invocations);
    }

    this.registrationReady = Promise.all(
      this.configuredAdapters().map((adapter) => this.registry.registerAdapter(adapter))
    ).then(() => undefined);
  }

  async onModuleInit() {
    await this.registrationReady;
  }

  getAdapter(type: RuntimeType) {
    return this.registry.getAdapter(type);
  }

  listAvailableRuntimeTypes(): RuntimeType[] {
    return this.registry.listAll().map((adapter) => adapter.type);
  }

  async listRuntimeAvailability(): Promise<RuntimeAvailabilityStatus[]> {
    return Promise.all(this.configuredAdapters().map(async (adapter) => {
      let preflight: RuntimeAvailability = { available: true };
      try {
        if (adapter.checkAvailability) {
          preflight = await adapter.checkAvailability();
        }
      } catch (error) {
        preflight = {
          available: false,
          reason: error instanceof Error ? error.message : String(error)
        };
      }
      const registered = Boolean(this.registry.getAdapter(adapter.type));
      return {
        runtimeType: adapter.type,
        available: preflight.available && registered,
        registered,
        ...(preflight.reason ? { reason: preflight.reason } : {}),
        supportedWorkspaceProviderKinds:
          adapter.metadata?.supportedWorkspaceProviderKinds ?? ['server_local', 'browser_broker', 'local_bridge']
      };
    }));
  }

  async refreshRuntimeAvailability(): Promise<RuntimeAvailabilityStatus[]> {
    return Promise.all(this.configuredAdapters().map(async (adapter) => {
      let preflight: RuntimeAvailability;
      try {
        preflight = await this.registry.refreshAdapter(adapter);
      } catch (error) {
        this.registry.unregister(adapter.type);
        preflight = {
          available: false,
          reason: error instanceof Error ? error.message : String(error)
        };
      }
      return {
        runtimeType: adapter.type,
        available: preflight.available,
        registered: Boolean(this.registry.getAdapter(adapter.type)),
        ...(preflight.reason ? { reason: preflight.reason } : {}),
        supportedWorkspaceProviderKinds:
          adapter.metadata?.supportedWorkspaceProviderKinds ?? ['server_local', 'browser_broker', 'local_bridge']
      };
    }));
  }

  private configuredAdapters(): AgentRuntimeAdapter[] {
    return [
      this.mockRuntime,
      this.genericLlmRuntime,
      this.codexRuntime,
      this.claudeCodeRuntime,
      this.codeReaderRuntime,
      this.testRunnerRuntime
    ];
  }

  start(input: InvocationPlan, signal?: AbortSignal): RuntimeExecutionHandle {
    const startedAt = nowIso();
    const runtimeType = input.executionTarget.runtimeType;
    const adapter = this.registry.getAdapter(runtimeType);
    let handle: AgentRuntimeRunHandle;

    if (!adapter) {
      handle = settledHandle(this.unsupportedResult(input, `Unsupported runtime: ${runtimeType}`));
    } else if (this.browserWorkspaceMirror?.shouldManage(input)) {
      handle = this.startInBrowserMirror(adapter, input, signal);
    } else if (this.worktreeExecution?.shouldManage(input)) {
      handle = this.startInManagedWorktree(adapter, input, signal);
    } else {
      try {
        const firstHandle = startAdapter(adapter, input, signal);
        handle = withResumeFallback(adapter, input, firstHandle, signal);
      } catch (error) {
        handle = settledHandle(this.unsupportedResult(input, errorMessage(error)));
      }
    }

    const result = handle.result
      .catch((error: unknown) => this.unsupportedResult(input, errorMessage(error)))
      .then((resolved) => {
        const terminated = ensureStructuredTermination(normalizeRuntimeResultContext(resolved), {
          phase: input.phase,
          signal
        });
        const normalized = terminated.error
          ? {
              ...terminated,
              error: {
                ...terminated.error,
                details: { ...terminated.error.details, phase: input.phase }
              }
            }
          : terminated;
        this.recordInvocation(input, normalized, startedAt);
        return normalized;
      });
    return {
      events: handle.events,
      result,
      cancel: handle.cancel,
      hasStreamingEvents:
        Boolean(adapter?.start) && runtimeStreamingEnabledFor(input.executionTarget.runtimeType)
    };
  }

  async run(input: InvocationPlan, signal?: AbortSignal) {
    return this.start(input, signal).result;
  }

  listInvocations(sessionId: string) {
    return this.invocationsBySession.get(sessionId) ?? [];
  }

  private recordInvocation(input: InvocationPlan, result: AgentRunResult, startedAt: string) {
    const log: RuntimeInvocationLog = {
      id: crypto.randomUUID(),
      dataEpoch: this.persistence.currentDataEpoch(),
      invocationId: input.invocationId,
      sessionId: input.sessionId,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      agentId: input.agent.agentId,
      agentKey: input.agent.key,
      runtimeType: result.runtimeType,
      ...(input.executionTarget.modelId ? { modelId: input.executionTarget.modelId } : {}),
      phase: input.phase,
      status: result.status,
      executionTarget: input.executionTarget,
      toolCatalog: input.toolCatalog,
      contextEnvelope: input.contextEnvelope,
      expectedOutput: input.expectedOutput,
      outputContract: runtimeOutputContractAudit(input.expectedOutput.kind),
      budget: input.budget,
      usage: result.usage,
      streamMetrics: result.streamMetrics,
      runtimeDiagnostics: result.runtimeDiagnostics,
      systemEvidence: result.systemEvidence,
      error: result.error,
      termination: result.termination,
      profileSnapshot: this.buildProfileSnapshot(input),
      cliSessionId: result.runtimeSession?.cliSessionId ?? this.extractCliSessionId(result),
      workDir: result.runtimeSession?.workDir,
      workspaceExecution: result.workspaceExecution,
      attempt: input.attempt,
      startedAt,
      completedAt: nowIso()
    };
    this.invocationsBySession.set(input.sessionId, [...this.listInvocations(input.sessionId), log]);
    this.persistence.setCollection('runtimeInvocationsBySession', Object.fromEntries(this.invocationsBySession));
  }

  private buildProfileSnapshot(input: InvocationPlan): RuntimeInvocationProfileSnapshot {
    return {
      agentId: input.agent.agentId,
      profileHash: input.agent.profileHash,
      profileRevision: input.agent.profileRevision,
      resolvedSkillIds: input.agent.skillBindings.map((binding) => binding.id),
      resolvedSkillRevisions: Object.fromEntries(
        input.agent.skillBindings.map((binding) => [binding.id, binding.revision])
      ),
      resolvedToolIds: input.toolCatalog.decisions
        .filter((decision) => decision.status === 'allowed')
        .map((decision) => decision.toolId)
    };
  }

  private extractCliSessionId(result: AgentRunResult): string | undefined {
    for (const event of result.events) {
      const value = event.metadata?.cliSessionId;
      if (typeof value === 'string' && value.length > 0) return value;
      const payload = event.metadata?.payload as { cliSessionId?: unknown } | undefined;
      if (typeof payload?.cliSessionId === 'string' && payload.cliSessionId.length > 0) return payload.cliSessionId;
    }
    return undefined;
  }

  private unsupportedResult(input: InvocationPlan, message: string): AgentRunResult {
    const runtimeType = input.executionTarget.runtimeType;
    const normalizedMessage = message.toLowerCase().includes('runtime not implemented')
      ? message
      : `${message}; runtime not implemented`;
    return {
      invocationId: input.invocationId,
      runtimeType,
      status: 'failed',
      output: createAgentMessageOutput({
        messageKind: 'risk',
        content: `${input.agent.name} runtime ${runtimeType} is unavailable.`
      }) satisfies AgentMessageOutput,
      events: [
        {
          invocationId: input.invocationId,
          type: 'runtime_failed',
          visibility: 'user',
          content: `${input.agent.name} runtime is unavailable: ${runtimeType}`,
          metadata: { code: 'CAPABILITY_BLOCKED', message: normalizedMessage },
          createdAt: nowIso()
        }
      ],
      artifacts: [],
      systemEvidence: emptyRuntimeSystemEvidence(input.invocationId),
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, model: input.executionTarget.modelId ?? runtimeType },
      error: { code: 'CAPABILITY_BLOCKED', message: normalizedMessage, retryable: false }
    };
  }

  private startInManagedWorktree(
    adapter: AgentRuntimeAdapter,
    input: InvocationPlan,
    signal?: AbortSignal
  ): AgentRuntimeRunHandle {
    const queue = new RuntimeEventQueue();
    let activeHandle: AgentRuntimeRunHandle | undefined;
    let cancelled = false;

    const result = (async () => {
      let lease: Awaited<ReturnType<WorktreeExecutionService['prepare']>> | undefined;
      try {
        lease = await this.worktreeExecution!.prepare(input);
        if (cancelled || signal?.aborted) return this.workspaceExecutionFailure(input, 'Worktree execution was cancelled.', true);
        queue.push({
          invocationId: input.invocationId,
          type: 'runtime_progress',
          visibility: 'debug',
          content: 'Prepared an isolated Git worktree for this task.',
          metadata: {
            code: 'WORKTREE_PREPARED',
            repositoryId: lease.manifest.repositoryId,
            baseRevision: lease.manifest.baseRevision,
            dirtyBaseline: lease.manifest.dirtyBaseline
          },
          createdAt: nowIso()
        });
        // A browser mirror is freshly materialized for every invocation, so a
        // CLI session tied to an older mirror must not be resumed.
        activeHandle = startAdapter(adapter, withoutResume(input), signal);
        const pump = pumpEvents(activeHandle.events, queue);
        const runtimeResult = await activeHandle.result;
        await pump;
        return await this.worktreeExecution!.capture(lease, runtimeResult);
      } catch (error) {
        return this.workspaceExecutionFailure(input, errorMessage(error), cancelled || signal?.aborted === true);
      } finally {
        lease?.release();
        queue.close();
      }
    })();

    return {
      events: queue,
      result,
      cancel: async () => {
        cancelled = true;
        await activeHandle?.cancel();
      }
    };
  }

  private startInBrowserMirror(
    adapter: AgentRuntimeAdapter,
    input: InvocationPlan,
    signal?: AbortSignal
  ): AgentRuntimeRunHandle {
    const queue = new RuntimeEventQueue();
    let activeHandle: AgentRuntimeRunHandle | undefined;
    let cancelled = false;

    const result = (async () => {
      let lease: Awaited<ReturnType<BrowserWorkspaceMirrorService['prepare']>> | undefined;
      try {
        lease = await withBrowserMirrorPrepareTimeout(this.browserWorkspaceMirror!.prepare(input));
        if (cancelled || signal?.aborted) {
          return this.workspaceExecutionFailure(input, 'Browser workspace mirror execution was cancelled.', true, 'browser_mirror');
        }
        queue.push({
          invocationId: input.invocationId,
          type: 'runtime_progress',
          visibility: 'debug',
          content: 'Prepared an isolated browser workspace mirror for this Runtime.',
          metadata: {
            code: 'BROWSER_MIRROR_PREPARED',
            workspaceId: lease.manifest.workspaceId,
            baseRevision: lease.manifest.baseRevision,
            skippedFileCount: lease.manifest.skippedFiles.length
          },
          createdAt: nowIso()
        });
        const firstHandle = startAdapter(adapter, input, signal);
        activeHandle = withResumeFallback(adapter, input, firstHandle, signal);
        const pump = pumpEvents(activeHandle.events, queue);
        const runtimeResult = await activeHandle.result;
        await pump;
        return await this.browserWorkspaceMirror!.capture(lease, runtimeResult);
      } catch (error) {
        return this.workspaceExecutionFailure(
          input,
          errorMessage(error),
          cancelled || signal?.aborted === true,
          'browser_mirror'
        );
      } finally {
        lease?.release();
        queue.close();
      }
    })();

    return {
      events: queue,
      result,
      cancel: async () => {
        cancelled = true;
        await activeHandle?.cancel();
      }
    };
  }

  private workspaceExecutionFailure(
    input: InvocationPlan,
    message: string,
    cancelled = false,
    mode: 'worktree' | 'browser_mirror' = 'worktree'
  ): AgentRunResult {
    const label = mode === 'browser_mirror' ? 'Browser workspace mirror' : 'Isolated worktree';
    return {
      invocationId: input.invocationId,
      runtimeType: input.executionTarget.runtimeType,
      status: cancelled ? 'cancelled' : 'failed',
      output: createAgentMessageOutput({ messageKind: 'risk', content: message }),
      events: [
        {
          invocationId: input.invocationId,
          type: 'runtime_failed',
          visibility: 'user',
          content: cancelled ? `${label} execution was cancelled.` : `${label} execution failed.`,
          metadata: {
            code: cancelled ? 'RUNTIME_CANCELLED' : mode === 'browser_mirror' ? 'BROWSER_MIRROR_EXECUTION_FAILED' : 'WORKTREE_EXECUTION_FAILED',
            message
          },
          createdAt: nowIso()
        }
      ],
      artifacts: [],
      systemEvidence: emptyRuntimeSystemEvidence(input.invocationId),
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        model: input.executionTarget.modelId ?? input.executionTarget.runtimeType
      },
      error: {
        code: cancelled ? 'RUNTIME_CANCELLED' : 'UNKNOWN_ERROR',
        message,
        retryable: false,
        details: { phase: mode === 'browser_mirror' ? 'browser_mirror_execution' : 'worktree_execution' }
      }
    };
  }

  findPriorInvocation(
    sessionId: string,
    agentId: string,
    taskId: string,
    runtimeType: RuntimeType
  ): { cliSessionId: string; workDir?: string } | undefined {
    const latest = this.listInvocations(sessionId)
      .filter(
        (invocation) =>
          invocation.agentId === agentId &&
          invocation.taskId === taskId &&
          invocation.runtimeType === runtimeType &&
          invocation.status === 'completed' &&
          Boolean(invocation.cliSessionId)
      )
      .sort((left, right) => right.completedAt.localeCompare(left.completedAt))[0];
    if (!latest?.cliSessionId) return undefined;
    return { cliSessionId: latest.cliSessionId, workDir: latest.workDir };
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function browserMirrorPrepareTimeoutMs() {
  const parsed = Number(process.env.BROWSER_MIRROR_PREPARE_TIMEOUT_MS ?? 300_000);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 300_000;
}

// Overall watchdog for browser-mirror preparation. Lower layers (broker requests,
// git commands) each have their own timeout, but this guards against any future
// hang point so a stalled prepare turns into a failed outcome instead of a
// permanently `running` workflow node. If prepare eventually resolves after the
// timeout, its lease is released to avoid leaking the invocation binding.
async function withBrowserMirrorPrepareTimeout<T extends { release(): void }>(
  prepare: Promise<T>
): Promise<T> {
  const timeoutMs = browserMirrorPrepareTimeoutMs();
  if (timeoutMs <= 0) return prepare;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      prepare,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          prepare.then((lease) => lease.release()).catch(() => {});
          reject(new Error(`Browser workspace mirror preparation timed out after ${timeoutMs}ms.`));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function startAdapter(
  adapter: AgentRuntimeAdapter,
  input: InvocationPlan,
  signal?: AbortSignal
): AgentRuntimeRunHandle {
  return adapter.start(input, signal);
}

function withoutResume(input: InvocationPlan): InvocationPlan {
  const { resume: _resume, ...next } = input;
  return next;
}

function shouldFallbackResume(input: InvocationPlan, result: AgentRunResult) {
  const expected = input.resume?.cliSessionId;
  if (!expected || result.status === 'cancelled') return false;
  if (result.status === 'completed') return result.runtimeSession?.cliSessionId !== expected;
  return !['RUNTIME_OUTPUT_CONTRACT_VIOLATION', 'RUNTIME_INVOCATION_ERROR', 'RUNTIME_CANCELLED'].includes(
    result.error?.code ?? ''
  );
}

function fallbackEvent(input: InvocationPlan, reason: string): AgentRuntimeEvent {
  return {
    invocationId: input.invocationId,
    type: 'runtime_progress',
    visibility: 'user',
    content: 'Runtime session resume failed; retrying once with a new session.',
    metadata: {
      code: 'RESUME_FALLBACK',
      previousCliSessionId: input.resume?.cliSessionId,
      reason
    },
    createdAt: nowIso()
  };
}

function withResumeFallback(
  adapter: AgentRuntimeAdapter,
  input: InvocationPlan,
  firstHandle: AgentRuntimeRunHandle,
  signal?: AbortSignal
): AgentRuntimeRunHandle {
  if (!input.resume?.cliSessionId) return firstHandle;
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

      activeHandle = startAdapter(adapter, withoutResume(input), signal);
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

async function pumpEvents(events: AsyncIterable<AgentRuntimeEvent>, queue: RuntimeEventQueue) {
  try {
    for await (const event of events) queue.push(event);
  } catch {
    // AgentRunResult carries the authoritative runtime failure.
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
  return { async *[Symbol.asyncIterator]() {} };
}

function settledHandle(result: AgentRunResult): AgentRuntimeRunHandle {
  return { events: emptyEvents(), result: Promise.resolve(result), cancel: async () => {} };
}

function promiseHandle(result: Promise<AgentRunResult>): AgentRuntimeRunHandle {
  return { events: emptyEvents(), result, cancel: async () => {} };
}
