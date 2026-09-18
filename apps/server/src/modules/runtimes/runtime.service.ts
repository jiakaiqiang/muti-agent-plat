import { Injectable, Logger, Optional, type OnModuleInit } from '@nestjs/common';
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
  RuntimeStopSummary,
  RuntimeType,
  SessionDetail
} from '@agent-cluster/shared';
import { createAgentMessageOutput, classifyProviderFailure, ProviderCircuit, usefulRuntimeActivity, runtimeActivityKind } from '@agent-cluster/shared';
import { cliContextRotationInputTokens, runtimeStreamingEnabledFor } from '../../common/runtime-config.js';
import { buildBudget } from '../../common/token.js';
import { nowIso } from '../../common/time.js';
import { workspaceMetrics } from '../../common/workspace-metrics.js';
import {
  abortWithTermination,
  createExecutionTermination,
  ensureStructuredTermination,
  terminationFromSignal
} from '../../common/execution-termination.js';
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
import { runtimeOutputContractAudit } from './runtime-output-schema.js';
import { emptyRuntimeSystemEvidence } from './runtime-system-evidence.js';
import { LocalRuntimeConnectionService } from '../local-runtime/local-runtime-connection.service.js';
import { ServerRuntimeWorkerService } from './server-runtime-worker.service.js';
import { InvocationWorkspaceBindingsService } from './invocation-workspace-bindings.service.js';
import { LogicalOperationStore } from './logical-operation-store.js';
import { RuntimeModelConfigService } from './runtime-model-config.service.js';
import { SessionStopStateStore } from './session-stop-state-store.js';
import {
  WORK_ITEM_BUDGET_EXHAUSTED_CODE,
  budgetCategoryFor,
  workItemBudgetExhaustedMessage
} from './work-item-budget-policy.js';
import { WorkItemBudgetStore } from './work-item-budget-store.js';
import { SessionLifecycleStore } from './session-lifecycle-store.js';
import { EventsService } from '../events/events.service.js';

export type RuntimeInvocationLog = {
  operationTelemetry?: AgentRunResult['operationTelemetry'];
  executionCandidate?: AgentRunResult['executionCandidate'];
  operation?: InvocationPlan['operation'];
  id: string;
  dataEpoch: string;
  invocationId: string;
  sessionId: string;
  workItemId?: string;
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
  /** Session lifecycle generation the CLI context belongs to; a restored session must not resume it. */
  contextGeneration?: number;
  workspaceExecution?: AgentRunResult['workspaceExecution'];
  attempt?: RuntimeAttemptTrace;
  workspaceIndexGeneration?: number;
  workspaceIndexStatus?: InvocationPlan['contextEnvelope']['L1']['navigation']['indexStatus'];
  workspaceIndexComplete?: boolean;
  workspaceRevisionAtStart: InvocationPlan['contextEnvelope']['L0']['workspace']['revision'];
  supplementalContextAttempt: number;
  supplementalContextDurationMs: number;
  evidenceBytes: number;
  evidencePaths: string[];
  startedAt: string;
  completedAt: string;
};

export type RuntimeExecutionHandle = AgentRuntimeRunHandle & {
  hasStreamingEvents: boolean;
};

@Injectable()
export class RuntimeService implements OnModuleInit {
  private readonly logger = new Logger(RuntimeService.name);
  private readonly invocationsBySession = new Map<string, RuntimeInvocationLog[]>();
  private readonly activeInvocationsBySession = new Map<
    string,
    Map<string, { handle: AgentRuntimeRunHandle; done: Promise<unknown> }>
  >();
  private readonly registrationReady: Promise<void>;
  readonly operations: LogicalOperationStore;
  readonly stopStates: SessionStopStateStore;
  readonly workItemBudgets: WorkItemBudgetStore;
  private readonly lifecycle: SessionLifecycleStore;
  private invocationWrites = Promise.resolve();
  private readonly providerCircuits = new ProviderCircuit();
  private readonly supervised = new Map<string, Map<string, RuntimeExecutionHandle>>();
  private readonly pendingStopStateSync = new Map<string, {
    sessionId: string;
    operationId: string;
    invocationId: string;
    stopState: 'confirmed' | 'unconfirmed';
    pause: boolean;
    attempts: number;
    lastError: string;
    exhausted: boolean;
    registeredAt: number;
    timer?: NodeJS.Timeout;
  }>();
  private readonly stopRequestFailures = new Map<string, string>();

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
    @Optional() private readonly localRuntime?: LocalRuntimeConnectionService,
    @Optional() private readonly serverRuntimeWorker?: ServerRuntimeWorkerService,
    @Optional() private readonly workspaceBindings?: InvocationWorkspaceBindingsService,
    @Optional() private readonly modelConfig?: RuntimeModelConfigService,
    @Optional() private readonly events?: EventsService
  ) {
    this.operations = new LogicalOperationStore(persistence);
    this.stopStates = new SessionStopStateStore(persistence);
    this.workItemBudgets = new WorkItemBudgetStore(persistence);
    this.lifecycle = new SessionLifecycleStore(persistence);
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
        const currentContract = runtimeOutputContractAudit(invocation.expectedOutput.kind, invocation.expectedOutput.schemaVersion);
        if (
          !['1.0', '2.0'].includes(invocation.expectedOutput?.schemaVersion) ||
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

  maxStructuredOutputTokens(input: InvocationPlan) {
    if (input.executionTarget.executionLocation === 'local') {
      return input.budget.maxOutputTokens;
    }
    return this.registry.getAdapter(input.executionTarget.runtimeType)?.maxStructuredOutputTokens?.({
      modelId: input.executionTarget.modelId
    });
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
          adapter.metadata?.supportedWorkspaceProviderKinds ?? ['server_local']
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
          adapter.metadata?.supportedWorkspaceProviderKinds ?? ['server_local']
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
    let adapterStartedAt: string | undefined;
    let firstUsefulOutputAt: string | undefined;
    const publishedEvents = new Set<string>();
    const submissionFailures = new Set<string>();
    const activeTools = new Set<string>();
    let toolIntervalStartedAt: number | undefined;
    let observedToolMs = 0;
    const isUseful = usefulRuntimeActivity();
    const queue = new RuntimeEventQueue();
    const controller = new AbortController();
    let underlying: RuntimeExecutionHandle | undefined;
    let timer: NodeJS.Timeout | undefined;
    let stopTimer: NodeJS.Timeout | undefined;
    let reserved = false;
    let stopUnconfirmed = false;
    let eventsSealed = false;
    let bookkeeping = Promise.resolve();
    let supervisionFailed = false;
    let stopStatePersistenceError: Error | undefined;
    let supervisorHandle: RuntimeExecutionHandle | undefined;
    let resolveStopped!: (result: AgentRunResult) => void;
    const stopped = new Promise<AgentRunResult>(resolve => { resolveStopped = resolve; });
    const stop = () => {
      if (!underlying) return;
      const termination = terminationFromSignal(controller.signal);
      void underlying.cancel(termination).catch(() => undefined);
      stopTimer ??= setTimeout(() => {
        stopUnconfirmed = true;
        const failure = this.invocationFailureResult(input, '上一调用尚未确认结束，禁止替代执行。');
        failure.error = { code: 'RUNTIME_INVOCATION_ERROR', message: '上一调用尚未确认结束，禁止替代执行。',
          retryable: false, details: { operationFailure: 'OPERATION_STOP_UNCONFIRMED', stopUnconfirmed: true, operationId: input.operation?.id } };
        resolveStopped(failure);
      }, 15_000);
    };
    const forwardAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) forwardAbort();
    else signal?.addEventListener('abort', forwardAbort, { once: true });
    controller.signal.addEventListener('abort', stop, { once: true });
    const result = (async (): Promise<AgentRunResult> => {
      try {
        const operation = await this.operations.begin({ id: input.operation?.id ?? input.invocationId,
          sessionId: input.sessionId, taskId: input.taskId, phase: input.phase });
        input.operation = { id: operation.id, deadlineAt: operation.deadlineAt,
          maxAttempts: operation.maxAttempts, policyVersion: operation.policyVersion };
        this.assertStopBarrierAllowsStart(input.sessionId);
        if (controller.signal.aborted) return ensureStructuredTermination(this.unsupportedResult(input, 'Cancelled before invocation start.'),
          { phase: input.phase, signal: controller.signal });
        await this.operations.reserve(input.sessionId, operation.id, input.invocationId, {
          transport: input.executionTarget.executionLocation === 'local' ? this.localRuntime?.invocationBinding?.(input) : undefined,
          executionKind: input.executionTarget.runtimeType === 'mock' ? 'internal' : 'process',
          outputContractKey: `${input.expectedOutput.kind}@${input.expectedOutput.schemaVersion}`
        });
        reserved = true;
        this.assertStopBarrierAllowsStart(input.sessionId);
        if (controller.signal.aborted) return ensureStructuredTermination(this.unsupportedResult(input, 'Cancelled before invocation start.'),
          { phase: input.phase, signal: controller.signal });
        const remainingMs = Date.parse(operation.deadlineAt) - Date.now();
        if (remainingMs <= 0) throw new Error('OPERATION_BUDGET_EXHAUSTED');
        // Unknown CLI connections are scoped to their workspace, never all users of a Runtime type.
        input.executionTarget.providerIdentity = this.providerIdentity(input);
        const providerKey = this.providerCircuits.key(input.executionTarget.providerIdentity);
        const circuitWait = this.providerCircuits.remaining(providerKey);
        if (circuitWait > 0) {
          const failure = this.invocationFailureResult(input, '当前模型连接处于故障等待期。');
          failure.error = { code: 'MODEL_ERROR', message: '当前模型连接处于故障等待期。', retryable: false,
            details: { providerFailure: true, circuitOpen: true, retryAfterMs: circuitWait, operationId: operation.id } };
          return failure;
        }
        timer = setTimeout(() => abortWithTermination(controller, createExecutionTermination({
          kind: 'phase_timeout', source: 'orchestrator', scope: 'phase', phase: input.phase,
          timeout: { mode: 'deadline', timeoutMs: remainingMs }
        })), remainingMs);
        // Reservation happens here on purpose: every cheap early return above
        // must not leave an allowance committed for a call that never starts.
        const budgetRefusal = await this.commitRequirementBudget(input);
        if (budgetRefusal) return budgetRefusal;
        underlying = this.startUnsupervised(input, controller.signal);
        // Reconcile from the adapter's own result so a refusal or a partial
        // failure still releases the allowance instead of holding it forever.
        // Deliberately not awaited inside the supervisor: the supervised result
        // may return through the stop barrier without waiting for the late
        // process exit, and bookkeeping must not change that.
        void underlying.result
          .then(async settled => { await this.settleRequirementBudget(input, settled); })
          .catch(() => undefined);
        adapterStartedAt = nowIso();
        const failSupervision = () => {
          supervisionFailed = true;
          abortWithTermination(controller, createExecutionTermination({
            kind: 'output_contract_failure', source: 'orchestrator', scope: 'invocation', phase: input.phase,
            diagnosticRef: 'operation_supervision_failed'
          }));
        };
        const publish = (event: AgentRuntimeEvent) => {
          if (publishedEvents.has(JSON.stringify(event))) return;
          const toolId = event.metadata?.toolCallId;
          if (typeof toolId === 'string' && event.type === 'tool_called') {
            if (activeTools.size === 0) toolIntervalStartedAt = Date.now();
            activeTools.add(toolId);
          } else if (typeof toolId === 'string' && event.type === 'tool_completed' && activeTools.delete(toolId) && activeTools.size === 0) {
            observedToolMs += Date.now() - (toolIntervalStartedAt ?? Date.now());
            toolIntervalStartedAt = undefined;
          }
          if (event.type === 'tool_completed' && event.metadata?.name === 'StructuredOutput' &&
            event.metadata.isError === true && typeof toolId === 'string' && !submissionFailures.has(toolId)) {
            submissionFailures.add(toolId);
            bookkeeping = bookkeeping.then(async () => {
              if (supervisionFailed) return;
              const permitted = await this.operations.reserveCorrection(input.sessionId, operation.id);
              if (!permitted) abortWithTermination(controller, createExecutionTermination({
                kind: 'output_contract_failure', source: 'orchestrator', scope: 'invocation', phase: input.phase,
                diagnosticRef: 'operation_submission_correction_exhausted'
              }));
            }).catch(failSupervision);
          }
          publishedEvents.add(JSON.stringify(event));
          if (isUseful(event)) firstUsefulOutputAt ??= nowIso();
          queue.push({ ...event, metadata: { ...event.metadata, operationId: operation.id,
            policyVersion: operation.policyVersion, activityKind: runtimeActivityKind(event),
            remainingMs: Math.max(0, Date.parse(operation.deadlineAt) - Date.now()) } });
        };
        const eventPump = (async () => {
          for await (const event of underlying!.events) {
            if (eventsSealed) break;
            publish(event);
          }
        })().catch(() => { if (!eventsSealed) failSupervision(); });
        // A late result clears the tombstone only; it is never delivered as a new success.
        void underlying.result.then(async resolved => {
          if (stopUnconfirmed && !resolved.error?.details?.stopUnconfirmed) {
            await this.operations.settle(input.sessionId, operation.id, input.invocationId, 'confirmed',
              terminationFromSignal(controller.signal)?.kind === 'user_paused');
          }
        }).catch(() => undefined);
        let resolved = await Promise.race([underlying.result, stopped]);
        // A transport result is the process-exit receipt. A broken event iterator
        // must not turn a completed process into a 20 minute wait.
        void eventPump;
        // Drain known accounting, not the potentially broken iterator. Buffered
        // events obey the same correction budget as streamed events.
        for (const event of resolved.events) publish(event);
        eventsSealed = true;
        await bookkeeping;
        if (supervisionFailed) {
          resolved = { ...this.invocationFailureResult(input, '执行监督信息保存或读取失败，已请求停止本次调用。'),
            executionCandidate: resolved.executionCandidate,
            error: { code: 'RUNTIME_INVOCATION_ERROR', message: '执行监督信息保存或读取失败，已请求停止本次调用。',
              retryable: false, details: { operationFailure: 'OPERATION_SUPERVISION_FAILED',
                stopUnconfirmed: Boolean(resolved.error?.details?.stopUnconfirmed) } } };
        } else {
          resolved = ensureStructuredTermination(resolved, { phase: input.phase, signal: controller.signal });
        }
        stopUnconfirmed ||= Boolean(resolved.error?.details?.stopUnconfirmed);
        if (resolved.error && (!resolved.termination || resolved.error.details?.providerFailure) && !stopUnconfirmed) {
          const failure = classifyProviderFailure(resolved.error);
          if (failure.failureClass !== 'unknown' || resolved.error.details?.providerFailure) {
            resolved.error = { ...resolved.error, retryable: failure.retryable, details: {
              ...resolved.error.details, failureClass: failure.failureClass,
              providerFailure: !['schema', 'protocol'].includes(failure.failureClass), operationId: operation.id
            } };
            if (failure.failureClass !== 'schema') this.providerCircuits.failed(providerKey, failure);
          }
        } else if (resolved.status === 'completed') this.providerCircuits.succeeded(providerKey);
        return resolved;
      } catch (error) {
        const failure = this.invocationFailureResult(input, errorMessage(error));
        failure.error = { code: errorMessage(error).includes('BUDGET_EXHAUSTED') ? 'RUNTIME_TIMEOUT' : 'RUNTIME_INVOCATION_ERROR',
          message: errorMessage(error), retryable: false,
          details: { operationId: input.operation?.id,
            operationFailure: errorMessage(error).match(/OPERATION_[A-Z_]+/)?.[0] ?? 'OPERATION_PERSISTENCE_FAILED',
            stopUnconfirmed: errorMessage(error).includes('STOP_UNCONFIRMED') } };
        return failure;
      } finally {
        eventsSealed = true;
        clearTimeout(timer);
        clearTimeout(stopTimer);
        signal?.removeEventListener('abort', forwardAbort);
        controller.signal.removeEventListener('abort', stop);
        try {
          if (reserved && input.operation) {
            const stopEvent = await this.operations.settle(input.sessionId, input.operation.id, input.invocationId,
              stopUnconfirmed ? 'unconfirmed' : 'confirmed', terminationFromSignal(controller.signal)?.kind === 'user_paused');
            if (stopEvent) this.events?.acceptCommitted(stopEvent);
          }
        } catch (error) {
          stopStatePersistenceError = error instanceof Error ? error : new Error(String(error));
          if (reserved && input.operation) this.registerPendingStopStateSync({
            sessionId: input.sessionId,
            operationId: input.operation.id,
            invocationId: input.invocationId,
            stopState: stopUnconfirmed ? 'unconfirmed' : 'confirmed',
            pause: terminationFromSignal(controller.signal)?.kind === 'user_paused',
            error: stopStatePersistenceError
          });
        } finally {
          const session = this.supervised.get(input.sessionId);
          if (!supervisorHandle || session?.get(input.invocationId) === supervisorHandle) session?.delete(input.invocationId);
          if (session && session.size === 0) this.supervised.delete(input.sessionId);
        }
      }
    })().then(async resolved => {
      if (stopStatePersistenceError) {
        const original = resolved;
        resolved = {
          ...this.invocationFailureResult(input, '执行已经结束，但停止状态保存失败，系统正在有限重试同步。'),
          executionCandidate: original.executionCandidate,
          termination: original.termination,
          systemEvidence: original.systemEvidence,
          error: {
            code: 'RUNTIME_INVOCATION_ERROR',
            message: '执行已经结束，但停止状态保存失败，系统正在有限重试同步。',
            retryable: false,
            details: {
              reason: 'STOP_STATE_PERSISTENCE_FAILED',
              operationFailure: 'OPERATION_PERSISTENCE_FAILED',
              operationId: input.operation?.id,
              originalStatus: original.status,
              diagnosticRef: 'runtime_stop_state_pending_sync'
            }
          }
        };
      }
      const completedAt = nowIso();
      const elapsedMs = Date.parse(completedAt) - Date.parse(startedAt);
      const preparationMs = adapterStartedAt ? Date.parse(adapterStartedAt) - Date.parse(startedAt) : elapsedMs;
      if (toolIntervalStartedAt !== undefined) observedToolMs += Date.parse(completedAt) - toolIntervalStartedAt;
      resolved.operationTelemetry = { operationId: input.operation?.id ?? input.invocationId,
        policyVersion: input.operation?.policyVersion ?? 'execution-reliability-v1', startedAt, adapterStartedAt,
        firstUsefulOutputAt, completedAt, elapsedMs, preparationMs, observedToolMs,
        unclassifiedMs: Math.max(0, elapsedMs - preparationMs - observedToolMs), queueWaitMs: null,
        initialEvidenceBytes: input.contextEnvelope.L3.totalByteLength,
        remainingMs: Math.max(0, Date.parse(input.operation?.deadlineAt ?? completedAt) - Date.now()),
        stopState: stopUnconfirmed ? 'unconfirmed' : 'confirmed', upstreamWaitMs: null,
        usageScope: 'reported_cumulative', billableTokens: null };
      await this.recordInvocation(input, resolved, startedAt);
      for (const event of resolved.events) {
        if (!publishedEvents.has(JSON.stringify(event))) queue.push({ ...event, metadata: {
          ...event.metadata, operationId: input.operation?.id, policyVersion: input.operation?.policyVersion
        } });
      }
      if (resolved.error) queue.push({ invocationId: input.invocationId, type: 'runtime_failed', visibility: 'user',
        content: resolved.error.message, createdAt: completedAt, metadata: { code: resolved.error.code,
          runtimeError: resolved.error, operationId: input.operation?.id, policyVersion: input.operation?.policyVersion,
          stopState: resolved.error.details?.stopUnconfirmed ? 'unconfirmed' : 'confirmed' } });
      return resolved;
    }).finally(() => queue.close());
    const handle: RuntimeExecutionHandle = { events: queue, result, hasStreamingEvents: true,
      cancel: async termination => {
        abortWithTermination(controller, termination ?? createExecutionTermination({
          kind: 'user_cancelled', source: 'user', scope: 'invocation', phase: input.phase
        }));
        await result;
      } };
    supervisorHandle = handle;
    const session = this.supervised.get(input.sessionId) ?? new Map<string, RuntimeExecutionHandle>();
    session.set(input.invocationId, handle);
    this.supervised.set(input.sessionId, session);
    return handle;
  }

  private providerIdentity(input: InvocationPlan): NonNullable<ResolvedExecutionTarget['providerIdentity']> {
    const target = input.executionTarget;
    if (this.modelConfig && (target.runtimeType === 'generic_llm' ||
      (target.executionLocation === 'local' && target.modelId))) {
      const connection = this.modelConfig.connectionForModelId(target.modelId);
      if (target.runtimeType === 'generic_llm' || connection.id === target.modelId) {
        return { connectionId: connection.id, modelId: connection.model,
          protocol: target.runtimeType === 'codex' ? 'openai_responses' : connection.provider,
          source: 'configured_connection' };
      }
    }
    return { connectionId: `unknown:${target.executionLocation}:${input.contextEnvelope.L0.workspace.workspaceId}`,
      modelId: 'unknown', protocol: target.runtimeType, source: 'unknown' };
  }

  private startUnsupervised(input: InvocationPlan, signal?: AbortSignal): RuntimeExecutionHandle {
    const startedAt = nowIso();
    const runtimeType = input.executionTarget.runtimeType;
    const isLocalExecution = input.executionTarget.executionLocation === 'local';
    const adapter = isLocalExecution ? undefined : this.registry.getAdapter(runtimeType);
    const invocationController = new AbortController();
    const forwardParentAbort = () => {
      if (!invocationController.signal.aborted) {
        invocationController.abort(signal?.reason);
      }
    };
    if (signal?.aborted) forwardParentAbort();
    else signal?.addEventListener('abort', forwardParentAbort, { once: true });
    const invocationSignal = invocationController.signal;
    let handle: AgentRuntimeRunHandle;

    if (
      (isLocalExecution && input.executionTarget.workspaceProviderKind !== 'local_bridge') ||
      (!isLocalExecution && input.executionTarget.workspaceProviderKind !== 'server_local')
    ) {
      handle = settledHandle(this.unsupportedResult(input, 'Runtime execution location does not match Workspace Provider'));
    } else if (isLocalExecution) {
      handle = this.localRuntime
        ? this.localRuntime.startInvocation(input)
        : settledHandle(this.unsupportedResult(input, 'Local Runtime CLI transport is unavailable'));
    } else if (!adapter) {
      handle = settledHandle(this.unsupportedResult(input, `Unsupported runtime: ${runtimeType}`));
    } else if (this.worktreeExecution?.shouldManage(input)) {
      handle = this.startInManagedWorktree(adapter, input, invocationSignal);
    } else {
      try {
        handle = this.startServerExecution(adapter, input, invocationSignal);
      } catch (error) {
        handle = settledHandle(this.unsupportedResult(input, errorMessage(error)));
      }
    }

    let cancellation: Promise<void> | undefined;
    const cancelUnderlyingHandle = (termination: Parameters<AgentRuntimeRunHandle['cancel']>[0]) => {
      cancellation ??= handle.cancel(termination);
      return cancellation;
    };
    const cancelLocalRuntimeOnAbort = () => {
      const termination = terminationFromSignal(invocationSignal) ?? createExecutionTermination({
        kind: 'user_cancelled',
        source: 'user',
        scope: 'invocation',
        phase: input.phase
      });
      void cancelUnderlyingHandle(termination).catch(() => undefined);
    };
    if (isLocalExecution) {
      if (invocationSignal.aborted) cancelLocalRuntimeOnAbort();
      else invocationSignal.addEventListener('abort', cancelLocalRuntimeOnAbort, { once: true });
    }

    const result = handle.result
      .catch((error: unknown) => this.unsupportedResult(input, errorMessage(error)))
      .then((resolved) => {
        const terminated = ensureStructuredTermination(normalizeRuntimeResultContext(resolved), {
          phase: input.phase,
          signal: invocationSignal
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
        return normalized;
      });
    const activeHandle = {
      events: handle.events,
      result,
      cancel: async (termination) => {
        const resolvedTermination = termination ?? createExecutionTermination({
          kind: 'user_cancelled',
          source: 'user',
          scope: 'invocation',
          phase: input.phase
        });
        abortWithTermination(invocationController, resolvedTermination);
        await cancelUnderlyingHandle(resolvedTermination);
      },
      hasStreamingEvents:
        isLocalExecution || (Boolean(adapter?.start) && runtimeStreamingEnabledFor(input.executionTarget.runtimeType))
    } satisfies RuntimeExecutionHandle;
    const sessionInvocations = this.activeInvocationsBySession.get(input.sessionId) ?? new Map();
    sessionInvocations.set(input.invocationId, {
      handle: activeHandle,
      done: result.then(
        () => {
          signal?.removeEventListener('abort', forwardParentAbort);
          invocationSignal.removeEventListener('abort', cancelLocalRuntimeOnAbort);
          this.releaseActiveInvocation(input.sessionId, input.invocationId);
        },
        () => {
          signal?.removeEventListener('abort', forwardParentAbort);
          invocationSignal.removeEventListener('abort', cancelLocalRuntimeOnAbort);
          this.releaseActiveInvocation(input.sessionId, input.invocationId);
        }
      )
    });
    this.activeInvocationsBySession.set(input.sessionId, sessionInvocations);
    return activeHandle;
  }

  async run(input: InvocationPlan, signal?: AbortSignal) {
    return this.start(input, signal).result;
  }

  async cancelSessionAndWait(
    sessionId: string,
    termination: Parameters<AgentRuntimeRunHandle['cancel']>[0],
    timeoutMs = 10_000
  ) {
    this.localRuntime?.retryUnconfirmedStops?.(sessionId);
    const active = [...(this.supervised.get(sessionId)?.values() ?? [])].map(handle => ({ handle, done: handle.result }));
    try {
      const committed = await this.stopStates.requestWithEvent(sessionId, termination?.diagnosticRef ?? termination?.kind ?? 'session_stop',
        [...(this.supervised.get(sessionId)?.keys() ?? [])]);
      this.events?.acceptCommitted(committed.event);
      this.stopRequestFailures.delete(sessionId);
    } catch (error) {
      this.stopRequestFailures.set(sessionId, errorMessage(error));
      this.logger.warn(JSON.stringify({
        event: 'runtime_stop_request_persistence_failed',
        sessionId,
        reason: 'STOP_REQUEST_PERSISTENCE_FAILED'
      }));
    }
    if (!active.length) {
      const summary = this.getStopSummary(sessionId);
      return { requested: summary.requestedCount, completed: summary.confirmedCount, timedOut: !summary.canResume };
    }

    // The result promise is authoritative. Adapter cancellation is best-effort
    // because a provider may fail while it is already shutting down.
    for (const invocation of active) {
      void invocation.handle.cancel(termination).catch(() => undefined);
    }

    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled(active.map((invocation) => invocation.done)),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.max(0, timeoutMs));
      })
    ]);
    if (timer) clearTimeout(timer);

    const remaining = this.supervised.get(sessionId)?.size ?? 0;
    const summary = this.getStopSummary(sessionId);
    return {
      requested: active.length,
      completed: active.length - remaining,
      timedOut: remaining > 0 || !summary.canResume
    };
  }

  activeInvocationCount(sessionId: string) {
    return this.supervised.get(sessionId)?.size ?? 0;
  }

  hasUnconfirmedStops(sessionId: string) {
    return this.activeInvocationCount(sessionId) > 0 || !this.getStopSummary(sessionId).canResume;
  }

  getStopSummary(sessionId: string): RuntimeStopSummary {
    this.pruneResolvedPendingStopStates(sessionId);
    this.refreshStopSyncMetrics();
    const durable = this.stopStates.summary(sessionId);
    const pending = [...this.pendingStopStateSync.values()].filter(item => item.sessionId === sessionId);
    const activeIds = [...(this.supervised.get(sessionId)?.keys() ?? [])];
    const localUnknown = this.localRuntime?.hasUnconfirmedStops?.(sessionId) ?? false;
    const unknownOperations = this.operations.list(sessionId).filter(operation => operation.stopState === 'unconfirmed' ||
      (operation.status === 'running' && operation.executionKind !== 'internal' && !activeIds.includes(operation.activeInvocationId ?? '')));
    const requestFailure = this.stopRequestFailures.get(sessionId);
    if (activeIds.length && durable.status === 'confirmed' && pending.length === 0 &&
      !localUnknown && unknownOperations.length === 0 && !requestFailure) return {
      sessionId,
      version: 0,
      status: 'idle',
      requestedCount: 0,
      confirmedCount: 0,
      targets: [],
      blockers: [],
      canResume: true
    };
    const blockers = [...durable.blockers];
    for (const item of pending) blockers.push({
      invocationId: item.invocationId,
      operationId: item.operationId,
      reason: item.exhausted ? 'stop_state_sync_exhausted' : 'stop_state_pending_sync',
      message: item.exhausted ? '停止状态同步重试已耗尽，需要重新核对。' : '执行已结束，停止状态正在同步。'
    });
    if (durable.status !== 'idle') for (const invocationId of activeIds) if (!blockers.some(item => item.invocationId === invocationId)) blockers.push({
      invocationId,
      reason: 'process_running',
      message: '正在等待执行进程结束。'
    });
    for (const operation of unknownOperations) if (!blockers.some(item => item.invocationId === operation.activeInvocationId)) blockers.push({
      invocationId: operation.activeInvocationId,
      operationId: operation.id,
      reason: 'process_exit_unknown',
      message: '服务重启后缺少可信的进程结束证据。'
    });
    if (localUnknown && !blockers.some(item => item.reason === 'process_exit_unknown')) blockers.push({
      reason: 'process_exit_unknown',
      message: '本地执行结束状态尚未确认。'
    });
    if (requestFailure) blockers.push({ reason: 'state_query_failed', message: '停止请求未能持久化，已临时阻止新执行。' });
    if (!blockers.length) return durable;
    return {
      ...durable,
      status: requestFailure ? 'unknown' : 'waiting',
      blockers,
      canResume: false
    };
  }

  private assertStopBarrierAllowsStart(sessionId: string) {
    if (!this.getStopSummary(sessionId).canResume) throw new Error('OPERATION_STOP_UNCONFIRMED');
  }

  async reconcilePendingStopStates(sessionId?: string) {
    const pending = [...this.pendingStopStateSync.values()].filter(item => !sessionId || item.sessionId === sessionId);
    for (const item of pending) {
      if (item.timer) clearTimeout(item.timer);
      item.timer = undefined;
      try {
        const stopEvent = await this.operations.settle(item.sessionId, item.operationId, item.invocationId, item.stopState, item.pause);
        if (stopEvent) this.events?.acceptCommitted(stopEvent);
        this.pendingStopStateSync.delete(item.invocationId);
        this.refreshStopSyncMetrics();
        const summary = this.stopStates.summary(item.sessionId);
        this.logger.log(JSON.stringify({
          event: 'runtime_stop_state_reconciled',
          sessionId: item.sessionId,
          stopRequestId: summary.stopRequestId,
          operationId: item.operationId,
          invocationId: item.invocationId,
          version: summary.version,
          attempts: item.attempts + 1
        }));
      } catch (error) {
        item.attempts += 1;
        item.lastError = errorMessage(error);
        item.exhausted = item.attempts >= 5;
        this.logger.warn(JSON.stringify({
          event: item.exhausted ? 'runtime_stop_state_sync_exhausted' : 'runtime_stop_state_sync_retry',
          sessionId: item.sessionId,
          stopRequestId: this.stopStates.latest(item.sessionId)?.id,
          operationId: item.operationId,
          invocationId: item.invocationId,
          attempt: item.attempts,
          reason: 'STOP_STATE_PERSISTENCE_FAILED'
        }));
        if (!item.exhausted) this.schedulePendingStopStateSync(item);
      }
    }
    return sessionId ? this.getStopSummary(sessionId) : undefined;
  }

  listInvocations(sessionId: string) {
    return this.invocationsBySession.get(sessionId) ?? [];
  }

  findExecutionCandidate(plan: InvocationPlan) {
    const previous = [...this.listInvocations(plan.sessionId)].reverse().find(item =>
      item.agentId === plan.agent.agentId && item.workItemId === plan.workItemId &&
      (item.taskId === plan.taskId || Boolean(plan.recoveryOriginTaskId && item.taskId === plan.recoveryOriginTaskId)) &&
      item.phase === 'task_execution');
    // Never resurrect an older candidate after a newer success or failed restore.
    const candidate = previous?.status === 'completed' ? undefined : previous?.executionCandidate;
    if (!candidate || candidate.workspaceId !== plan.contextEnvelope.L0.workspace.workspaceId ||
      candidate.outputVersion !== plan.expectedOutput.schemaVersion || Date.parse(candidate.expiresAt) <= Date.now() ||
      candidate.baseRevision.id !== plan.contextEnvelope.L0.workspace.revision.id) return undefined;
    return structuredClone(candidate);
  }

  private releaseActiveInvocation(sessionId: string, invocationId: string) {
    const sessionInvocations = this.activeInvocationsBySession.get(sessionId);
    if (!sessionInvocations) return;
    sessionInvocations.delete(invocationId);
    if (!sessionInvocations.size) this.activeInvocationsBySession.delete(sessionId);
  }

  private registerPendingStopStateSync(input: {
    sessionId: string;
    operationId: string;
    invocationId: string;
    stopState: 'confirmed' | 'unconfirmed';
    pause: boolean;
    error: Error;
  }) {
    const existing = this.pendingStopStateSync.get(input.invocationId);
    if (existing) {
      existing.lastError = input.error.message;
      return;
    }
    const item = { ...input, attempts: 0, lastError: input.error.message, exhausted: false, registeredAt: Date.now() };
    this.pendingStopStateSync.set(input.invocationId, item);
    this.refreshStopSyncMetrics();
    this.logger.warn(JSON.stringify({
      event: 'runtime_stop_state_sync_registered',
      sessionId: input.sessionId,
      stopRequestId: this.stopStates.latest(input.sessionId)?.id,
      operationId: input.operationId,
      invocationId: input.invocationId,
      reason: 'STOP_STATE_PERSISTENCE_FAILED'
    }));
    this.schedulePendingStopStateSync(item);
  }

  private schedulePendingStopStateSync(item: (typeof this.pendingStopStateSync extends Map<string, infer T> ? T : never)) {
    const delay = [1_000, 2_000, 5_000, 10_000, 30_000][item.attempts] ?? 30_000;
    item.timer = setTimeout(() => void this.reconcilePendingStopStates(item.sessionId), delay);
    item.timer.unref?.();
  }

  private pruneResolvedPendingStopStates(sessionId: string) {
    const operations = this.operations.list(sessionId);
    for (const item of this.pendingStopStateSync.values()) {
      if (item.sessionId !== sessionId) continue;
      const operation = operations.find(candidate => candidate.id === item.operationId);
      if (operation?.stopState === 'confirmed' && operation.activeInvocationId !== item.invocationId) {
        if (item.timer) clearTimeout(item.timer);
        this.pendingStopStateSync.delete(item.invocationId);
        this.refreshStopSyncMetrics();
      }
    }
  }

  private refreshStopSyncMetrics() {
    const pending = [...this.pendingStopStateSync.values()];
    workspaceMetrics.set('runtime_stop_pending_sync_count', pending.length);
    workspaceMetrics.set('runtime_stop_pending_sync_oldest_ms', pending.length
      ? Math.max(0, Date.now() - Math.min(...pending.map(item => item.registeredAt)))
      : 0);
  }

  private async recordInvocation(input: InvocationPlan, result: AgentRunResult, startedAt: string) {
    const log: RuntimeInvocationLog = {
      operationTelemetry: result.operationTelemetry,
      executionCandidate: result.executionCandidate,
      operation: input.operation,
      id: crypto.randomUUID(),
      dataEpoch: this.persistence.currentDataEpoch(),
      invocationId: input.invocationId,
      sessionId: input.sessionId,
      ...(input.workItemId ? { workItemId: input.workItemId } : {}),
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
      outputContract: runtimeOutputContractAudit(input.expectedOutput.kind, input.expectedOutput.schemaVersion),
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
      ...(this.lifecycle.generation(input.sessionId) !== undefined
        ? { contextGeneration: this.lifecycle.generation(input.sessionId) }
        : {}),
      workspaceExecution: result.workspaceExecution,
      attempt: input.attempt,
      workspaceIndexGeneration: input.contextEnvelope.L1.navigation.indexGeneration,
      workspaceIndexStatus: input.contextEnvelope.L1.navigation.indexStatus,
      workspaceIndexComplete: input.contextEnvelope.L1.navigation.indexComplete,
      workspaceRevisionAtStart: input.contextEnvelope.L0.workspace.revision,
      supplementalContextAttempt: input.attempt?.supplementalContextAttempt ?? 0,
      supplementalContextDurationMs: input.attempt?.supplementalContextDurationMs ?? 0,
      evidenceBytes: input.contextEnvelope.L3.totalByteLength,
      evidencePaths: input.contextEnvelope.L3.files.map((file) => file.path),
      startedAt,
      completedAt: nowIso()
    };
    const write = this.invocationWrites.then(async () => {
      const committed = await this.persistence.mutateCollections(['runtimeInvocationsBySession'], draft => {
        const all = (draft.runtimeInvocationsBySession ??= Object.fromEntries(this.invocationsBySession)) as Record<string, RuntimeInvocationLog[]>;
        const items = all[input.sessionId] ??= [];
        if (!items.some(item => item.invocationId === log.invocationId)) items.push(log);
        return structuredClone(items);
      });
      this.invocationsBySession.set(input.sessionId, committed);
    });
    this.invocationWrites = write.catch(() => undefined);
    await write;
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

  private invocationFailureResult(input: InvocationPlan, message: string): AgentRunResult {
    const result = this.unsupportedResult(input, message);
    result.output = createAgentMessageOutput({ messageKind: 'risk', content: message });
    result.events = [];
    return result;
  }

  /**
   * Commits a slice of the requirement's cumulative model budget before the
   * adapter is allowed to start, so two experts on one requirement cannot each
   * spend the whole remaining allowance.
   *
   * The requirement limit reuses the session's already-configured token budget
   * (`TOKEN_BUDGET_DEFAULT` / `session.tokenBudget`) rather than inventing a new
   * parameter. An invocation without a work item has no requirement to charge,
   * so it proceeds unchanged.
   *
   * Returns an explainable refusal when there is no allowance left, mirroring the
   * provider-circuit early return: the caller gets a typed code and the numbers
   * instead of a silently truncated request.
   */
  private async commitRequirementBudget(input: InvocationPlan): Promise<AgentRunResult | undefined> {
    const workItemId = input.workItemId;
    if (!workItemId) return undefined;
    const session = this.sessionForBudget(input.sessionId);
    if (!session) return undefined;
    const sessionBudget = buildBudget(session);
    const limitTokens = sessionBudget.maxTotalTokens;
    const requestedTokens = input.budget.maxInputTokens ?? sessionBudget.maxInputTokens;
    if (!limitTokens || !requestedTokens) return undefined;
    const category = budgetCategoryFor(input.phase, input.attempt);
    const attemptId = input.invocationId;
    const outcome = await this.workItemBudgets.reserve({
      sessionId: input.sessionId,
      workItemId,
      attemptId,
      operationId: input.operation?.id ?? attemptId,
      category,
      requestedTokens,
      limitTokens
    });
    if (outcome.status === 'reserved') return undefined;
    const message = workItemBudgetExhaustedMessage({
      availableTokens: outcome.availableTokens,
      requestedTokens: outcome.requestedTokens,
      limitTokens
    });
    const refusal = this.invocationFailureResult(input, message);
    refusal.error = {
      code: WORK_ITEM_BUDGET_EXHAUSTED_CODE,
      message,
      retryable: false,
      details: {
        workItemId,
        category,
        availableTokens: outcome.availableTokens,
        requestedTokens: outcome.requestedTokens,
        limitTokens,
        operationId: input.operation?.id,
        retryable: false
      }
    };
    return refusal;
  }

  /**
   * Reconciles the allowance against what the provider reported. Unavailable
   * usage keeps the reservation cap as a conservative bound, because the call
   * may still have been billed.
   */
  private async settleRequirementBudget(input: InvocationPlan, result: AgentRunResult): Promise<void> {
    const workItemId = input.workItemId;
    if (!workItemId) return;
    const usage = result.usage;
    // What the model actually had to read, cached or not. A cache read is cheaper
    // but it is not free and it still occupies the window, so the requirement is
    // charged for the logical total rather than only the uncached remainder.
    const reportedTokens = usage?.logicalInputTokens ?? usage?.inputTokens;
    // `measurement` is the explicit signal. Before it existed this had to infer
    // "measured" from a non-zero count plus a mock special-case, which could not
    // tell a real zero from absent usage; an explicit 'unknown' now says so.
    const hasReportedUsage =
      typeof reportedTokens === 'number' &&
      usage?.measurement !== 'unknown' &&
      (reportedTokens > 0 || usage?.measurement === 'actual' || result.runtimeType === 'mock');
    await this.workItemBudgets.settle({
      sessionId: input.sessionId,
      workItemId,
      attemptId: input.invocationId,
      outcome: hasReportedUsage
        ? { kind: 'reported', actualTokens: Math.max(0, reportedTokens ?? 0) }
        : { kind: 'unavailable' }
    }).catch(() => undefined);
  }

  private sessionForBudget(sessionId: string): SessionDetail | undefined {
    const sessions = this.persistence.getCollection<SessionDetail[]>('sessions', []);
    return sessions.find(session => session.id === sessionId);
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
        // Each managed worktree invocation gets an isolated execution directory,
        // so a CLI session tied to an older directory must not be resumed.
        activeHandle = this.startServerExecution(
          adapter,
          withoutResume(input),
          signal,
          lease.manifest.executionWorkDir
        );
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

  private workspaceExecutionFailure(
    input: InvocationPlan,
    message: string,
    cancelled = false
  ): AgentRunResult {
    const label = 'Isolated worktree';
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
            code: cancelled ? 'RUNTIME_CANCELLED' : 'WORKTREE_EXECUTION_FAILED',
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
        details: { phase: 'worktree_execution' }
      }
    };
  }

  private startServerExecution(
    adapter: AgentRuntimeAdapter,
    input: InvocationPlan,
    signal?: AbortSignal,
    workDir?: string
  ): AgentRuntimeRunHandle {
    if (['codex', 'claude_code'].includes(input.executionTarget.runtimeType)) {
      if (!this.serverRuntimeWorker) {
        return settledHandle(this.unsupportedResult(input, 'Server Runtime Worker is unavailable; in-process execution is forbidden'));
      }
      const executionWorkDir = workDir ?? this.workspaceBindings?.resolveServerRoot(input);
      if (!executionWorkDir) {
        return settledHandle(this.unsupportedResult(input, 'Server Runtime Worker could not resolve an isolated execution directory'));
      }
      const startWorker = (plan: InvocationPlan, invocationSignal?: AbortSignal) => {
        const workerHandle = this.serverRuntimeWorker!.start(plan, executionWorkDir);
        let cancellation: Promise<void> | undefined;
        const cancelOnce: AgentRuntimeRunHandle['cancel'] = (termination) => {
          cancellation ??= Promise.resolve(workerHandle.cancel(termination));
          return cancellation;
        };
        const guardedHandle: AgentRuntimeRunHandle = { ...workerHandle, cancel: cancelOnce };
        if (invocationSignal?.aborted) void guardedHandle.cancel(terminationFromSignal(invocationSignal));
        else invocationSignal?.addEventListener('abort', () => {
          void guardedHandle.cancel(terminationFromSignal(invocationSignal));
        }, { once: true });
        return guardedHandle;
      };
      const firstHandle = startWorker(input, signal);
      return withResumeFallback(startWorker, input, firstHandle, signal);
    }
    const firstHandle = startAdapter(adapter, input, signal);
    return withResumeFallback(startAdapter.bind(undefined, adapter), input, firstHandle, signal);
  }

  /**
   * A CLI conversation is private to (session, agent, task, runtime) **and** the
   * WorkItem it served; a different requirement, or a session generation that has
   * since been restored, starts a fresh context instead of replaying old history.
   *
   * Rotation: once the conversation's accumulated provider input crosses the
   * configured window threshold, the old CLI session is not resumed. Phase-end
   * checkpoints already captured the state to carry over; side-effect dedupe
   * stays with the LogicalOperation, so the new context re-runs nothing.
   */
  findPriorInvocation(
    sessionId: string,
    agentId: string,
    taskId: string,
    runtimeType: RuntimeType,
    scope: { workItemId?: string } = {}
  ): { cliSessionId: string; workDir?: string } | undefined {
    const generation = this.lifecycle.generation(sessionId);
    const chain = this.listInvocations(sessionId)
      .filter(
        (invocation) =>
          invocation.agentId === agentId &&
          invocation.taskId === taskId &&
          invocation.runtimeType === runtimeType &&
          invocation.status === 'completed' &&
          Boolean(invocation.cliSessionId) &&
          (scope.workItemId === undefined || invocation.workItemId === scope.workItemId) &&
          (generation === undefined || invocation.contextGeneration === generation)
      )
      .sort((left, right) => right.completedAt.localeCompare(left.completedAt));
    const latest = chain[0];
    if (!latest?.cliSessionId) return undefined;
    const conversationInputTokens = chain
      .filter((invocation) => invocation.cliSessionId === latest.cliSessionId)
      .reduce((sum, invocation) => sum + (invocation.usage?.inputTokens ?? 0), 0);
    if (conversationInputTokens >= cliContextRotationInputTokens()) {
      workspaceMetrics.increment('cli_context_rotated_total', 1, { runtimeType });
      return undefined;
    }
    return { cliSessionId: latest.cliSessionId, workDir: latest.workDir };
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
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
  // A completed invocation may already have side effects. A different CLI session ID is not permission to replay it.
  if (input.operation || result.status === 'completed') return false;
  const expected = input.resume?.cliSessionId;
  if (!expected || result.status === 'cancelled') return false;
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
  start: (input: InvocationPlan, signal?: AbortSignal) => AgentRuntimeRunHandle,
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

      activeHandle = start(withoutResume(input), signal);
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
