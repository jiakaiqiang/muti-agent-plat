import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentRunResult, AgentRuntimeAdapter, AgentRuntimeEvent, InvocationPlan, RuntimeType } from '@agent-cluster/shared';
import { createAgentMessageOutput, createRuntimeArtifactSystemEvidence } from '@agent-cluster/shared';
import { makeInvocationPlan } from './invocation-plan.fixture.js';
import { RuntimeService } from './runtime.service.js';
import { createExecutionTermination } from '../../common/execution-termination.js';
import { WorktreeExecutionService } from '../worktree-execution/worktree-execution.service.js';
import { SessionLifecycleStore } from './session-lifecycle-store.js';

test('R8 final Runtime selection blocks unproven adapters before any adapter start', () => {
  for (const type of ['codex', 'claude_code', 'test_runner', 'mcp_tool', 'human'] as const) {
    let starts = 0;
    const selected = adapter(type, async plan => { starts++; return completed(plan); });
    const { service, persisted } = createService([selected]);
    const plan = makeInvocationPlan({ executionTarget: { runtimeType: type } });
    persisted.set('sessions', [{ id: plan.sessionId, intentContractVersion: 'intent-understanding-v1' }]);
    plan.intentRetryBinding = {} as NonNullable<InvocationPlan['intentRetryBinding']>;
    assert.throws(() => service.start(plan), /INTENT_RETRY_RECONCILIATION_REQUIRED/); assert.equal(starts, 0);
  }
});

function completed(plan: InvocationPlan, runtimeType: RuntimeType = plan.executionTarget.runtimeType): AgentRunResult {
  return {
    invocationId: plan.invocationId,
    runtimeType,
    status: 'completed',
    output: createAgentMessageOutput({ messageKind: 'summary', content: 'completed' }),
    events: [],
    artifacts: [],
    systemEvidence: createRuntimeArtifactSystemEvidence(plan.invocationId),
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, model: runtimeType }
  };
}

function adapter(type: RuntimeType, run?: (plan: InvocationPlan) => Promise<AgentRunResult>): AgentRuntimeAdapter {
  return {
    type,
    start(plan) {
      return {
        events: (async function* () {})(),
        result: (run ?? (async (value) => completed(value, type)))(plan),
        async cancel() {}
      };
    }
  };
}

function createService(
  adapters: AgentRuntimeAdapter[],
  configuredAdapters: AgentRuntimeAdapter[] = adapters,
  executions: {
    worktree?: unknown;
    localRuntime?: unknown;
    serverWorker?: unknown | null;
    workspaceBindings?: unknown;
  } = {},
  initialInvocations?: Record<string, unknown[]>,
  discussionDocuments?: unknown
) {
  const persisted = new Map<string, unknown>();
  if (initialInvocations) persisted.set('runtimeInvocationsBySession', initialInvocations);
  const registry = {
    registerAdapter: async () => {},
    getAdapter: (type: RuntimeType) => adapters.find((item) => item.type === type),
    listAll: () => adapters
  };
  const persistence = {
    stateRevision() { return 'test-revision'; },
    async mutateCollections(_keys: string[], mutate: (state: Record<string, unknown>) => unknown) {
      const state = structuredClone(Object.fromEntries(persisted));
      const result = mutate(state);
      for (const [key, value] of Object.entries(state)) persisted.set(key, value);
      return result;
    },
    currentDataEpoch() {
      return 'epoch-test';
    },
    getCollection<T>(name: string, fallback: T): T {
      return (persisted.get(name) as T | undefined) ?? fallback;
    },
    setCollection(name: string, value: unknown) {
      persisted.set(name, value);
    }
  };
  const placeholders = [
    ...configuredAdapters,
    ...Array.from({ length: 6 }, () => adapter('human'))
  ].slice(0, 6);
  const serverWorker = executions.serverWorker === null
    ? undefined
    : executions.serverWorker ?? {
        start(plan: InvocationPlan) {
          const selected = adapters.find((item) => item.type === plan.executionTarget.runtimeType);
          if (!selected) throw new Error(`Test Worker has no adapter for ${plan.executionTarget.runtimeType}.`);
          return selected.start(plan);
        }
      };
  const workspaceBindings = executions.workspaceBindings ?? {
    resolveServerRoot: () => 'C:/isolated-test-workspace'
  };
  const service = new RuntimeService(
    persistence as never,
    registry as never,
    placeholders[0] as never,
    placeholders[1] as never,
    placeholders[2] as never,
    placeholders[3] as never,
    placeholders[4] as never,
    placeholders[5] as never,
    executions.worktree as never,
    executions.localRuntime as never,
    serverWorker as never,
    workspaceBindings as never,
    undefined,
    undefined,
    discussionDocuments as never
  );
  return { service, persisted, persistence };
}

test('scoped Codex and Claude tasks stop before adapter startup when input is over budget', async () => {
  for (const type of ['codex', 'claude_code'] as const) {
    let starts = 0;
    const selected = adapter(type, async plan => { starts++; return completed(plan); });
    const { service, persistence, persisted } = createService([selected]);
    persisted.set('sessions', [{ id: 'session', dataEpoch: 'epoch', ownerId: 'user', status: 'EXECUTING' }]);
    persisted.set('tasksBySession', { session: [{ id: 'task', sessionId: 'session', status: 'running' }] });
    await new SessionLifecycleStore(persistence as never).initialize('session', 'epoch');
    const plan = makeInvocationPlan({ sessionId: 'session', taskId: 'task', invocationId: `budget-${type}`,
      executionTarget: { runtimeType: type }, budget: { maxInputTokens: 1, maxOutputTokens: 50 },
      inputBudgetPolicy: { kind: 'agent_task', taskId: 'task', actorId: 'user', dataEpoch: 'epoch', sessionGeneration: 1, slot: `task:${type}` } });
    const result = await service.start(plan).result;
    assert.equal(starts, 0); assert.equal(result.status, 'blocked', JSON.stringify(result.error));
    assert.equal(result.error?.code, 'INPUT_BUDGET_EXCEEDED');
    assert.equal(service.operations.list('session')[0].status, 'paused');
  }
});

test('a correction arriving during asynchronous budget preparation prevents the actual adapter from starting', async () => {
  let started = 0;
  const selected = adapter('mock', async plan => { started += 1; return completed(plan); });
  const { service, persisted } = createService([selected]);
  const plan = makeInvocationPlan({ sessionId: 'correction-session', workItemId: 'held-work' });
  (service as any).commitRequirementBudget = async () => {
    persisted.set('workItemsBySession', { 'correction-session': [{ id: 'held-work', executionEpoch: 2,
      dispatchHold: { correctionId: 'correction', reason: 'intent_correction', createdAt: new Date().toISOString() } }] });
    return undefined;
  };
  const result = await service.start(plan).result;
  assert.equal(started, 0);
  assert.equal(result.status, 'failed');
  assert.match(JSON.stringify(result.error), /INTENT_DISPATCH_HELD/);
});

test('correction stop targets exact invocation ids without cancelling another WorkItem', async () => {
  const cancelled: string[] = [];
  const started: string[] = [];
  const selected: AgentRuntimeAdapter = { type: 'mock', start(plan) {
    started.push(plan.invocationId);
    let finish!: (value: AgentRunResult) => void;
    const result = new Promise<AgentRunResult>(resolve => { finish = resolve; });
    return { result, events: (async function* () {})(), async cancel() { cancelled.push(plan.invocationId); finish(completed(plan)); } };
  } };
  const { service } = createService([selected]);
  const first = service.start(makeInvocationPlan({ sessionId: 'correction-session', invocationId: 'affected', workItemId: 'one' }));
  const second = service.start(makeInvocationPlan({ sessionId: 'correction-session', invocationId: 'unaffected', workItemId: 'two' }));
  // A deterministic barrier ensures both process handles have started.
  await waitForSettlement(() => started.length === 2, 'both correction test adapters started');
  const stopped = await service.cancelIntentExecutionsAndWait('correction-session', ['affected'], 1000);
  assert.equal(stopped.stopConfirmed, true);
  assert.deepEqual(cancelled, ['affected']);
  assert.equal(service.activeInvocationCount('correction-session'), 1);
  await second.cancel(); await first.result;
});

for (const originalStatus of ['completed', 'failed'] as const) {
  test(`a late ${originalStatus} result is audited atomically and has no executable payload after correction`, async () => {
    let finish!: () => void;
    let started = false;
    const selected = adapter('mock', async plan => {
      started = true;
      await new Promise<void>(resolve => { finish = resolve; });
      return { ...completed(plan), status: originalStatus,
        runtimeSession: { cliSessionId: 'old-conversation' },
        ...(originalStatus === 'failed' ? { error: { code: 'MODEL_ERROR' as const, message: 'HTTP 503', retryable: true } } : {}) };
    });
    const { service, persisted } = createService([selected]);
    persisted.set('sessions', [{ id: 'late-session', dataEpoch: 'epoch-test' }]);
    persisted.set('workItemsBySession', { 'late-session': [{ id: 'work', executionEpoch: 1 }] });
    const plan = makeInvocationPlan({ sessionId: 'late-session', workItemId: 'work', taskId: 'task' });
    const running = service.start(plan);
    await waitForSettlement(() => started, 'adapter must be running before the correction');
    persisted.set('workItemsBySession', { 'late-session': [{ id: 'work', executionEpoch: 2,
      dispatchHold: { correctionId: 'correction', reason: 'intent_correction', createdAt: new Date().toISOString() } }] });
    finish();
    const result = await running.result;
    assert.equal(result.status, 'failed');
    assert.equal(result.intentAdmission?.status, 'superseded');
    assert.equal(result.error?.retryable, false);
    assert.equal(result.error?.details?.operationFailure, 'INTENT_EXECUTION_SUPERSEDED');
    assert.equal(result.executionCandidate, undefined);
    assert.equal(result.workspaceExecution, undefined);
    assert.equal(result.runtimeSession, undefined);
    assert.deepEqual(result.artifacts, []);
    assert.notDeepEqual(result.output, completed(plan).output);
    const log = service.listInvocations(plan.sessionId)[0];
    assert.equal(log.status, originalStatus);
    assert.equal(log.supersededResult?.status, originalStatus);
    assert.deepEqual(log.supersededResult?.output, completed(plan).output);
    assert.equal(log.intentAdmission?.reason, 'INTENT_DISPATCH_HELD');
    assert.equal(service.findPriorInvocation(plan.sessionId, plan.agent.agentId, 'task', 'mock'), undefined);
    assert.equal(service.findExecutionCandidate(plan), undefined);
  });
}

test('a correction to an unrelated WorkItem leaves the current result usable', async () => {
  const { service, persisted } = createService([adapter('mock')]);
  persisted.set('workItemsBySession', { 'session-1': [{ id: 'unrelated', executionEpoch: 2,
    dispatchHold: { correctionId: 'correction', reason: 'intent_correction', createdAt: new Date().toISOString() } }] });
  const result = await service.run(makeInvocationPlan({ sessionId: 'session-1', workItemId: 'current' }));
  assert.equal(result.status, 'completed');
  assert.equal(result.intentAdmission?.status, 'current');
});

test('a result after Session deletion cannot restore the audit collection from the process cache', async () => {
  let finish!: () => void;
  let started = false;
  const { service, persisted } = createService([adapter('mock', async plan => {
    started = true; await new Promise<void>(resolve => { finish = resolve; }); return completed(plan);
  })]);
  persisted.set('sessions', [{ id: 'deleted-session', dataEpoch: 'epoch-test' }]);
  const running = service.start(makeInvocationPlan({ sessionId: 'deleted-session', workItemId: 'work' }));
  await waitForSettlement(() => started, 'adapter must start before deletion');
  persisted.set('sessions', []);
  persisted.set('runtimeInvocationsBySession', {});
  finish();
  const result = await running.result;
  assert.equal(result.intentAdmission?.status, 'superseded');
  assert.deepEqual(persisted.get('runtimeInvocationsBySession'), {});
  assert.deepEqual(service.listInvocations('deleted-session'), []);
});

test('fails closed when a required discussion document has no complete read receipt', async () => {
  const requiredDocument = {
    documentId: 'document-required',
    revision: 1,
    relativePath: '.agent-cluster/discussion-documents/session-1/plan-revision-001.md',
    contentHash: 'a'.repeat(64)
  };
  const selected = adapter('mock', async plan => ({
    ...completed(plan),
    events: [{
      invocationId: plan.invocationId,
      type: 'tool_completed',
      visibility: 'debug',
      content: 'read_file completed',
      createdAt: new Date().toISOString(),
      metadata: {
        name: 'read_file',
        toolCallId: 'read-file-1',
        input: { path: requiredDocument.relativePath },
        truncated: false
      }
    }]
  }));
  const { service } = createService([selected], undefined, {}, undefined, {
    hasCompleteReceipt: () => false,
    recordAgentRead: async () => undefined
  });
  const result = await service.run(makeInvocationPlan({
    executionTarget: { runtimeType: 'mock' },
    contextEnvelope: { L1: { requiredDocument } }
  }));
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'CONTEXT_INSUFFICIENT');
  assert.equal(result.error?.details?.documentId, requiredDocument.documentId);
  assert.equal(result.error?.details?.documentRevision, requiredDocument.revision);
});

test('dispatches by InvocationPlan.executionTarget', async () => {
  const codex = adapter('codex');
  const { service } = createService([codex]);
  const result = await service.run(makeInvocationPlan({ executionTarget: { runtimeType: 'codex' } }));
  assert.equal(result.runtimeType, 'codex');
});

test('a completed process cannot be held open by an unfinished event iterator', async () => {
  const selected = adapter('mock');
  selected.start = plan => ({
    result: Promise.resolve(completed(plan)),
    events: (async function* () { await new Promise(() => {}); })(),
    async cancel() {}
  });
  const { service } = createService([selected]);
  const plan = makeInvocationPlan({ executionTarget: { runtimeType: 'mock' } });
  const result = await service.run(plan);
  assert.equal(result.status, 'completed');
  assert.equal(service.listInvocations(plan.sessionId).length, 1);
  assert.equal(result.operationTelemetry?.billableTokens, null);
  assert.equal(service.operations.list(plan.sessionId)[0].attemptsUsed, 1);
});

function submissionFailure(plan: InvocationPlan, toolCallId: string): AgentRuntimeEvent {
  return { invocationId: plan.invocationId, type: 'tool_completed', visibility: 'debug',
    content: 'Invalid submission', createdAt: new Date().toISOString(),
    metadata: { toolCallId, name: 'StructuredOutput', isError: true } };
}

async function* healthyProgress(plan: InvocationPlan) {
  for (let sequence = 0; sequence < 6; sequence++) {
    await new Promise(resolve => setTimeout(resolve, 20));
    yield { invocationId: plan.invocationId, type: 'runtime_progress' as const, visibility: 'debug' as const,
      content: `working ${sequence}`, metadata: { code: 'STREAM_TEXT', sequence }, createdAt: new Date().toISOString() };
  }
}

test('an admitted task finishes and repairs its submission after its time budget expires', async () => {
  const old = process.env.PHASE_TIMEOUT_TASK_EXECUTION_MS;
  process.env.PHASE_TIMEOUT_TASK_EXECUTION_MS = '50';
  let cancelCount = 0;
  const selected = adapter('mock');
  selected.start = plan => {
    let finish!: (result: AgentRunResult) => void;
    const result = new Promise<AgentRunResult>(resolve => { finish = resolve; });
    const timer = setTimeout(() => finish({ ...completed(plan), events: [submissionFailure(plan, 'late-repair')] }), 100);
    return {
      events: healthyProgress(plan), result,
      async cancel() { cancelCount++; clearTimeout(timer); finish(completed(plan)); }
    };
  };
  const { service } = createService([selected]);
  const plan = makeInvocationPlan({ phase: 'task_execution', executionTarget: { runtimeType: 'mock' } });
  try {
    const result = await service.run(plan);
    assert.equal(cancelCount, 0, 'the operation deadline must not cancel an already running task');
    assert.equal(result.status, 'completed');
    const operation = service.operations.list(plan.sessionId)[0];
    assert.equal(operation.remainingActiveMs, 0);
    assert.equal(operation.correctionsUsed, 1, 'the active call retains its single submission correction');
    const retry = await service.run({ ...plan, invocationId: 'expired-task-retry' });
    assert.equal(retry.error?.details?.operationFailure, 'OPERATION_BUDGET_EXHAUSTED');
    assert.equal(retry.error?.retryable, false);
    assert.equal(retry.termination, undefined, 'exhaustion must not become a synthetic 1ms timeout');
  } finally {
    if (old === undefined) delete process.env.PHASE_TIMEOUT_TASK_EXECUTION_MS;
    else process.env.PHASE_TIMEOUT_TASK_EXECUTION_MS = old;
  }
});

test('a control phase with no output remains active past budget until explicit user stop', async () => {
  const old = process.env.PHASE_TIMEOUT_TASK_ACCEPTANCE_MS;
  process.env.PHASE_TIMEOUT_TASK_ACCEPTANCE_MS = '30';
  let cancelCount = 0;
  const selected = adapter('mock');
  selected.start = plan => {
    let finish!: (result: AgentRunResult) => void;
    return {
      events: (async function* () {})(),
      result: new Promise<AgentRunResult>(resolve => { finish = resolve; }),
      async cancel() { cancelCount++; finish(completed(plan)); }
    };
  };
  const { service } = createService([selected]);
  try {
    const handle = service.start(makeInvocationPlan({ phase: 'task_acceptance', executionTarget: { runtimeType: 'mock' } }));
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(cancelCount, 0);
    await handle.cancel();
    const result = await handle.result;
    assert.equal(cancelCount, 1);
    assert.equal(result.termination?.kind, 'user_cancelled');
  } finally {
    if (old === undefined) delete process.env.PHASE_TIMEOUT_TASK_ACCEPTANCE_MS;
    else process.env.PHASE_TIMEOUT_TASK_ACCEPTANCE_MS = old;
  }
});

test('an over-budget active task can still be stopped by the user', async () => {
  const old = process.env.PHASE_TIMEOUT_TASK_EXECUTION_MS;
  process.env.PHASE_TIMEOUT_TASK_EXECUTION_MS = '50';
  let cancelCount = 0;
  const selected = adapter('mock');
  selected.start = plan => {
    let finish!: (result: AgentRunResult) => void;
    return {
      events: healthyProgress(plan),
      result: new Promise<AgentRunResult>(resolve => { finish = resolve; }),
      async cancel() { cancelCount++; finish(completed(plan)); }
    };
  };
  const { service } = createService([selected]);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(createExecutionTermination({
    kind: 'user_paused', source: 'user', scope: 'session'
  })), 100);
  try {
    const result = await service.run(makeInvocationPlan({ phase: 'task_execution', executionTarget: { runtimeType: 'mock' } }), controller.signal);
    assert.equal(cancelCount, 1);
    assert.equal(result.termination?.kind, 'user_paused');
    assert.notEqual(result.status, 'completed');
  } finally {
    clearTimeout(timer);
    if (old === undefined) delete process.env.PHASE_TIMEOUT_TASK_EXECUTION_MS;
    else process.env.PHASE_TIMEOUT_TASK_EXECUTION_MS = old;
  }
});

test('an over-budget task still reports a Runtime idle watchdog termination', async () => {
  const old = process.env.PHASE_TIMEOUT_TASK_EXECUTION_MS;
  process.env.PHASE_TIMEOUT_TASK_EXECUTION_MS = '50';
  const termination = createExecutionTermination({
    kind: 'runtime_timeout', source: 'runtime', scope: 'invocation',
    timeout: { mode: 'idle', timeoutMs: 100 }
  });
  const selected = adapter('mock', async plan => {
    await new Promise(resolve => setTimeout(resolve, 100));
    return { ...completed(plan), status: 'failed', termination,
      error: { code: 'RUNTIME_TIMEOUT', message: 'Runtime idle timeout', retryable: true, termination } };
  });
  const { service } = createService([selected]);
  const originalStart = selected.start.bind(selected);
  selected.start = plan => ({ ...originalStart(plan), events: healthyProgress(plan) });
  try {
    const result = await service.run(makeInvocationPlan({ phase: 'task_execution', executionTarget: { runtimeType: 'mock' } }));
    assert.equal(result.status, 'failed');
    assert.equal(result.termination?.kind, 'runtime_timeout');
    assert.equal(result.termination?.timeout?.mode, 'idle');
  } finally {
    if (old === undefined) delete process.env.PHASE_TIMEOUT_TASK_EXECUTION_MS;
    else process.env.PHASE_TIMEOUT_TASK_EXECUTION_MS = old;
  }
});

for (const phase of ['discussion', 'brief_generation', 'brief_revision', 'brief_consultation',
  'task_acceptance', 'task_execution', 'revision_synthesis', 'post_review', 'final_delivery', 'user_message_routing'] as const) {
  test(`${phase} keeps a healthy Runtime executing beyond its budget`, async () => {
    const key = `PHASE_TIMEOUT_${phase.toUpperCase()}_MS`;
    const old = process.env[key];
    process.env[key] = '60';
    let cancelled = false;
    const selected = adapter('mock');
    selected.start = plan => {
      let finish!: (result: AgentRunResult) => void;
      const result = new Promise<AgentRunResult>(resolve => { finish = resolve; });
      const timer = setTimeout(() => finish(completed(plan)), 110);
      return { result, events: healthyProgress(plan),
        async cancel() { cancelled = true; clearTimeout(timer); finish(completed(plan)); } };
    };
    const { service } = createService([selected]);
    try {
      assert.equal((await service.run(makeInvocationPlan({ phase, executionTarget: { runtimeType: 'mock' } }))).status, 'completed');
      assert.equal(cancelled, false);
    } finally {
      if (old === undefined) delete process.env[key]; else process.env[key] = old;
    }
  });
  test(`${phase} keeps a silent Runtime executing beyond the observation threshold`, async () => {
    const key = `PHASE_TIMEOUT_${phase.toUpperCase()}_MS`;
    const oldPhase = process.env[key];
    const oldObservation = process.env.RUNTIME_SILENCE_OBSERVATION_MS;
    process.env[key] = '60';
    process.env.RUNTIME_SILENCE_OBSERVATION_MS = '40';
    let cancelled = false;
    const selected = adapter('mock');
    selected.start = plan => {
      let finish!: (result: AgentRunResult) => void;
      const result = new Promise<AgentRunResult>(resolve => { finish = resolve; });
      const timer = setTimeout(() => finish(completed(plan)), 110);
      return { result, events: (async function* () {})(),
        async cancel() { cancelled = true; clearTimeout(timer); finish(completed(plan)); } };
    };
    const { service } = createService([selected]);
    try {
      const plan = makeInvocationPlan({ phase, executionTarget: { runtimeType: 'mock' } });
      assert.equal((await service.run(plan)).status, 'completed');
      assert.equal(cancelled, false);
    } finally {
      if (oldPhase === undefined) delete process.env[key]; else process.env[key] = oldPhase;
      if (oldObservation === undefined) delete process.env.RUNTIME_SILENCE_OBSERVATION_MS;
      else process.env.RUNTIME_SILENCE_OBSERVATION_MS = oldObservation;
      service.onModuleDestroy();
    }
  });
}

test('a local call continues past budget while connected, then falls back when the connection becomes unhealthy', async () => {
  const old = process.env.PHASE_TIMEOUT_TASK_ACCEPTANCE_MS;
  process.env.PHASE_TIMEOUT_TASK_ACCEPTANCE_MS = '60';
  let connected = true;
  let cancelled = false;
  const localRuntime = {
    invocationBinding: () => ({ deviceId: 'device', workspaceId: 'workspace-test', runtimeType: 'claude_code' }),
    isInvocationConnected: () => connected,
    startInvocation(plan: InvocationPlan) {
      let finish!: (result: AgentRunResult) => void;
      return {
        result: new Promise<AgentRunResult>(resolve => { finish = resolve; }),
        events: (async function* () {
          let sequence = 0;
          for await (const event of healthyProgress(plan)) {
            if (++sequence === 5) {
              assert.equal(cancelled, false, 'normal local activity must survive the initial deadline');
              connected = false;
            }
            yield event;
          }
        })(),
        async cancel() { cancelled = true; finish(completed(plan)); }
      };
    }
  };
  const { service } = createService([], [], { localRuntime, serverWorker: null });
  try {
    const result = await service.run(makeInvocationPlan({ phase: 'task_acceptance', executionTarget: {
      runtimeType: 'claude_code', executionLocation: 'local', workspaceProviderKind: 'local_bridge'
    } }));
    assert.equal(cancelled, true);
    assert.equal(result.termination?.kind, 'phase_timeout');
    assert.equal(result.termination?.diagnosticRef, 'operation_budget_fallback:runtime_disconnected');
  } finally {
    if (old === undefined) delete process.env.PHASE_TIMEOUT_TASK_ACCEPTANCE_MS;
    else process.env.PHASE_TIMEOUT_TASK_ACCEPTANCE_MS = old;
  }
});

for (const metadata of [
  { code: 'STREAM_SYSTEM', subtype: 'api_retry', raw: { status_code: 429, attempt: 7 } },
  { code: 'RUNTIME_REQUEST_OBSERVATION', observationKind: 'provider_retry' },
  { code: 'RUNTIME_REQUEST_OBSERVATION', observationKind: 'provider_error' }
]) {
  test(`expired local invocation falls back once for ${metadata.subtype ?? metadata.observationKind}, despite live Runtime and weak signals`, async t => {
    const oldPhase = process.env.PHASE_TIMEOUT_TASK_ACCEPTANCE_MS;
    const oldSilence = process.env.RUNTIME_SILENCE_OBSERVATION_MS;
    process.env.PHASE_TIMEOUT_TASK_ACCEPTANCE_MS = '40';
    process.env.RUNTIME_SILENCE_OBSERVATION_MS = '20';
    const originalTimeout = globalThis.setTimeout;
    // Accelerate only the supervisor's five-second polling, not the stop confirmation barrier.
    t.mock.method(globalThis, 'setTimeout', ((callback: Parameters<typeof setTimeout>[0], delay?: number, ...args: unknown[]) =>
      originalTimeout(callback, delay === 5000 ? 5 : delay, ...args)) as typeof setTimeout);
    let starts = 0, cancels = 0;
    let safetyTimer: ReturnType<typeof setTimeout> | undefined;
    const localRuntime = {
      invocationBinding: () => ({ deviceId: 'device', workspaceId: 'workspace-test', runtimeType: 'claude_code' }),
      isInvocationConnected: () => true,
      supportsInvocationProbe: () => false,
      startInvocation(plan: InvocationPlan) {
        starts++;
        let finish!: (result: AgentRunResult) => void;
        const result = new Promise<AgentRunResult>(resolve => { finish = resolve; });
        safetyTimer = originalTimeout(() => finish(completed(plan)), 800);
        return { result, events: (async function* () {
          await new Promise(resolve => setTimeout(resolve, 65));
          assert.equal(cancels, 0, 'silent but connected call survives its expired budget before any fault');
          yield { invocationId: plan.invocationId, type: 'runtime_progress' as const, visibility: 'debug' as const,
            content: '', metadata, createdAt: new Date().toISOString() };
          for (const observationKind of ['request_started', 'request_acknowledged', 'transport_alive']) {
            yield { invocationId: plan.invocationId, type: 'runtime_progress' as const, visibility: 'debug' as const,
              content: '', metadata: { code: 'RUNTIME_REQUEST_OBSERVATION', observationKind }, createdAt: new Date().toISOString() };
          }
        })(), async cancel() { cancels++; clearTimeout(safetyTimer); finish(completed(plan)); } };
      }
    };
    const { service } = createService([], [], { localRuntime, serverWorker: null });
    try {
      const plan = makeInvocationPlan({ phase: 'task_acceptance', executionTarget: {
        runtimeType: 'claude_code', executionLocation: 'local', workspaceProviderKind: 'local_bridge'
      } });
      const result = await service.run(plan);
      assert.equal(starts, 1);
      assert.equal(cancels, 1);
      assert.notEqual(result.status, 'completed', 'a successful result delivered after cancellation cannot advance the task');
      assert.equal(result.termination?.diagnosticRef, 'operation_budget_fallback:provider_or_tool_error');
      const snapshot = service.requestHealth.list(plan.sessionId).find(item => item.invocationId === plan.invocationId)!;
      assert.equal(snapshot.budgetFallbackReason, 'provider_or_tool_error');
      assert.equal(snapshot.capabilities.processProbe, 'unsupported');
      assert.equal(snapshot.stage, 'terminal');
      assert.equal(service.operations.list(plan.sessionId)[0].stopState, 'confirmed');
    } finally {
      clearTimeout(safetyTimer); service.onModuleDestroy(); t.mock.restoreAll();
      if (oldPhase === undefined) delete process.env.PHASE_TIMEOUT_TASK_ACCEPTANCE_MS;
      else process.env.PHASE_TIMEOUT_TASK_ACCEPTANCE_MS = oldPhase;
      if (oldSilence === undefined) delete process.env.RUNTIME_SILENCE_OBSERVATION_MS;
      else process.env.RUNTIME_SILENCE_OBSERVATION_MS = oldSilence;
    }
  });
}

test('local process probe capability comes from negotiated connection, without starting a probe or model', async () => {
  let probes = 0;
  const localRuntime = {
    isInvocationConnected: () => true, supportsInvocationProbe: () => true,
    probeInvocation: async () => { probes++; return undefined; },
    startInvocation: (plan: InvocationPlan) => ({ result: Promise.resolve(completed(plan)), events: (async function* () {})(), async cancel() {} })
  };
  const { service } = createService([], [], { localRuntime, serverWorker: null });
  try {
    const plan = makeInvocationPlan({ executionTarget: { runtimeType: 'claude_code', executionLocation: 'local', workspaceProviderKind: 'local_bridge' } });
    await service.run(plan);
    assert.equal(service.requestHealth.list(plan.sessionId)[0].capabilities.processProbe, 'supported');
    assert.equal(probes, 0);
  } finally { service.onModuleDestroy(); }
});

test('buffered submission errors share the durable correction limit and duplicate events do not spend twice', async () => {
  const selected = adapter('mock', async plan => {
    const error = submissionFailure(plan, 'first');
    return { ...completed(plan), events: [error, error] };
  });
  const { service } = createService([selected]);
  const plan = makeInvocationPlan({ executionTarget: { runtimeType: 'mock' } });
  assert.equal((await service.run(plan)).status, 'completed');
  assert.equal(service.operations.list(plan.sessionId)[0].correctionsUsed, 1);
  const next = { ...plan, invocationId: 'second-invocation' };
  const result = await service.run(next);
  assert.notEqual(result.status, 'completed');
  assert.equal(result.termination?.kind, 'output_contract_failure');
});

test('correction persistence failure cancels a live process and cannot become success', async () => {
  let cancelCount = 0;
  const selected = adapter('mock');
  selected.start = plan => {
    let finish!: (result: AgentRunResult) => void;
    return {
      events: (async function* () { yield submissionFailure(plan, 'invalid'); })(),
      result: new Promise(resolve => { finish = resolve; }),
      async cancel() { cancelCount++; finish(completed(plan)); }
    };
  };
  const { service } = createService([selected]);
  service.operations.reserveCorrection = async () => { throw new Error('isolated persistence failure'); };
  const plan = makeInvocationPlan({ executionTarget: { runtimeType: 'mock' } });
  const result = await service.run(plan);
  assert.equal(cancelCount, 1);
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.details?.operationFailure, 'OPERATION_SUPERVISION_FAILED');
  assert.equal(service.listInvocations(plan.sessionId)[0].status, 'failed');
});

test('settle persistence failure keeps admission closed after retries exhaust until explicit reconciliation succeeds', async () => {
  const selected = adapter('mock');
  let starts = 0;
  const originalStart = selected.start.bind(selected);
  selected.start = plan => {
    starts += 1;
    return originalStart(plan);
  };
  const { service } = createService([selected]);
  const originalSettle = service.operations.settle.bind(service.operations);
  let failSettle = true;
  service.operations.settle = async (...args) => {
    if (failSettle) throw new Error('isolated settle persistence failure');
    return originalSettle(...args);
  };
  const plan = makeInvocationPlan({ executionTarget: { runtimeType: 'mock' } });

  const result = await service.run(plan);

  assert.equal(service.activeInvocationCount(plan.sessionId), 0);
  assert.equal(service.hasUnconfirmedStops(plan.sessionId), true);
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.details?.reason, 'STOP_STATE_PERSISTENCE_FAILED');
  assert.equal(starts, 1);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await service.reconcilePendingStopStates(plan.sessionId);
  }
  assert.equal(service.getStopSummary(plan.sessionId).blockers[0]?.reason, 'stop_state_sync_exhausted');

  const blockedStart = await service.start({ ...plan, invocationId: 'blocked-start', operation: undefined }).result;
  assert.equal(blockedStart.error?.details?.operationFailure, 'OPERATION_STOP_UNCONFIRMED');
  const blockedRun = await service.run({ ...plan, invocationId: 'blocked-run', operation: undefined });
  assert.equal(blockedRun.error?.details?.operationFailure, 'OPERATION_STOP_UNCONFIRMED');
  assert.equal(starts, 1);

  failSettle = false;
  await service.reconcilePendingStopStates(plan.sessionId);
  assert.equal(service.hasUnconfirmedStops(plan.sessionId), false);

  const recovered = await service.run({ ...plan, invocationId: 'recovered', operation: undefined });
  assert.equal(recovered.status, 'completed');
  assert.equal(starts, 2);
});

test('a previous confirmed stop round cannot hide a current Local Runtime stop barrier', async () => {
  const selected = adapter('mock');
  let starts = 0;
  const originalStart = selected.start.bind(selected);
  selected.start = plan => {
    starts += 1;
    return originalStart(plan);
  };
  let localStopUnknown = true;
  const { service } = createService([selected], [selected], {
    localRuntime: { hasUnconfirmedStops: () => localStopUnknown }
  });
  const plan = makeInvocationPlan({ executionTarget: { runtimeType: 'mock' } });
  await service.stopStates.request(plan.sessionId, 'previous_zero_target_stop');

  const blocked = await service.run(plan);
  assert.equal(blocked.error?.details?.operationFailure, 'OPERATION_STOP_UNCONFIRMED');
  assert.equal(starts, 0);

  localStopUnknown = false;
  const recovered = await service.run({ ...plan, invocationId: 'local-barrier-recovered', operation: undefined });
  assert.equal(recovered.status, 'completed');
  assert.equal(starts, 1);
});

test('a result waits for known correction bookkeeping without waiting for the event iterator', async () => {
  let commit!: () => void;
  const selected = adapter('mock', async plan => ({ ...completed(plan), events: [submissionFailure(plan, 'pending')] }));
  const { service } = createService([selected]);
  const original = service.operations.reserveCorrection.bind(service.operations);
  service.operations.reserveCorrection = async (...args) => {
    await new Promise<void>(resolve => { commit = resolve; });
    return original(...args);
  };
  const plan = makeInvocationPlan({ executionTarget: { runtimeType: 'mock' } });
  let delivered = false;
  const result = service.run(plan).then(value => { delivered = true; return value; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(delivered, false);
  assert.equal(service.listInvocations(plan.sessionId).length, 0);
  commit();
  assert.equal((await result).status, 'completed');
  assert.equal(service.operations.list(plan.sessionId)[0].correctionsUsed, 1);
});

test('supervisor keeps an unconfirmed stop barrier until the late process exit and never republishes success', async () => {
  let finish!: (result: AgentRunResult) => void;
  let starts = 0;
  const selected = adapter('codex');
  selected.start = plan => {
    starts++;
    return { events: (async function* () {})(),
      result: new Promise(resolve => { finish = resolve; }), async cancel() {} };
  };
  const { service } = createService([selected]);
  const plan = makeInvocationPlan({ executionTarget: { runtimeType: 'codex' } });
  const running = service.start(plan);
  await new Promise<void>(resolve => setImmediate(resolve));
  await running.cancel(createExecutionTermination({ kind: 'user_paused', source: 'user', scope: 'session' }));
  const stopped = await running.result;
  assert.equal(stopped.error?.details?.stopUnconfirmed, true);
  assert.equal(service.operations.hasUnknownStop(plan.sessionId), true);
  const replacement = await service.run({ ...plan, invocationId: 'replacement', operation: undefined });
  assert.equal(replacement.error?.details?.operationFailure, 'OPERATION_STOP_UNCONFIRMED');
  assert.equal(starts, 1);
  finish(completed(plan));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(service.operations.hasUnknownStop(plan.sessionId), false);
  assert.equal(service.operations.list(plan.sessionId)[0].status, 'paused');
  assert.equal(service.listInvocations(plan.sessionId).length, 2);
  assert.ok(service.listInvocations(plan.sessionId).every(entry => entry.status !== 'completed'));
});

test('cancels every active invocation belonging to a Session and waits for results', async () => {
  const resolvers = new Map<string, (result: AgentRunResult) => void>();
  let cancelCount = 0;
  const pending: AgentRuntimeAdapter = {
    type: 'codex',
    start(plan) {
      return {
        events: (async function* () {})(),
        result: new Promise<AgentRunResult>((resolve) => {
          resolvers.set(plan.invocationId, resolve);
        }),
        async cancel() {
          cancelCount += 1;
          resolvers.get(plan.invocationId)?.(completed(plan, 'codex'));
        }
      };
    }
  };
  const { service } = createService([pending]);
  const first = service.start(makeInvocationPlan({ sessionId: 'delete-me', invocationId: 'inv-1', executionTarget: { runtimeType: 'codex' } }));
  const second = service.start(makeInvocationPlan({ sessionId: 'delete-me', invocationId: 'inv-2', executionTarget: { runtimeType: 'codex' } }));
  assert.equal(service.activeInvocationCount('delete-me'), 2);
  await new Promise<void>(resolve => setImmediate(resolve));

  const stopped = await service.cancelSessionAndWait(
    'delete-me',
    createExecutionTermination({ kind: 'frontend_disconnected', source: 'system', scope: 'session' })
  );
  await Promise.all([first.result, second.result]);

  assert.equal(cancelCount, 2);
  assert.deepEqual(stopped, { requested: 2, completed: 2, timedOut: false });
  assert.equal(service.activeInvocationCount('delete-me'), 0);
});

test('forwards a parent abort to a Local Runtime handle exactly once', async () => {
  let resolveResult!: (result: AgentRunResult) => void;
  let cancelCount = 0;
  let receivedTermination: unknown;
  const localRuntime = {
    startInvocation(plan: InvocationPlan) {
      return {
        events: (async function* () {})(),
        result: new Promise<AgentRunResult>((resolve) => {
          resolveResult = resolve;
        }),
        async cancel(termination: unknown) {
          cancelCount += 1;
          receivedTermination = termination;
          resolveResult(completed(plan, 'claude_code'));
        }
      };
    }
  };
  const { service } = createService([], [], { localRuntime, serverWorker: null });
  const controller = new AbortController();
  const plan = makeInvocationPlan({
    executionTarget: {
      runtimeType: 'claude_code',
      executionLocation: 'local',
      workspaceProviderKind: 'local_bridge'
    }
  });
  const execution = service.start(plan, controller.signal);
  await new Promise<void>(resolve => setImmediate(resolve));
  const termination = createExecutionTermination({
    kind: 'user_paused',
    source: 'user',
    scope: 'session'
  });

  controller.abort(termination);
  const result = await execution.result;

  assert.equal(cancelCount, 1);
  assert.equal((receivedTermination as { kind?: string }).kind, 'user_paused');
  assert.equal(result.status, 'cancelled');
  assert.equal(result.termination?.kind, 'user_paused');
});

test('module initialization waits for asynchronous Runtime registration', async () => {
  let releaseRegistration: (() => void) | undefined;
  const registrationGate = new Promise<void>((resolve) => {
    releaseRegistration = resolve;
  });
  let registered = 0;
  const runtime = adapter('claude_code');
  const persistence = {
    currentDataEpoch: () => 'epoch-test',
    getCollection: (_name: string, fallback: unknown) => fallback,
    setCollection() {}
  };
  const registry = {
    async registerAdapter() {
      await registrationGate;
      registered += 1;
    },
    getAdapter: () => runtime,
    listAll: () => registered ? [runtime] : []
  };
  const placeholders = Array.from({ length: 6 }, () => runtime);
  const service = new RuntimeService(
    persistence as never,
    registry as never,
    placeholders[0] as never,
    placeholders[1] as never,
    placeholders[2] as never,
    placeholders[3] as never,
    placeholders[4] as never,
    placeholders[5] as never
  );

  let initialized = false;
  const initialization = service.onModuleInit().then(() => {
    initialized = true;
  });
  await Promise.resolve();
  assert.equal(initialized, false);
  releaseRegistration?.();
  await initialization;
  assert.equal(registered, 6);
});

test('passes the exact InvocationPlan object to the adapter', async () => {
  let received: InvocationPlan | undefined;
  const plan = makeInvocationPlan({ executionTarget: { runtimeType: 'mock' } });
  const mock = adapter('mock', async (input) => {
    received = input;
    return completed(input);
  });
  const { service } = createService([mock]);
  await service.run(plan);
  assert.equal(received, plan);
});

test('fails closed when the selected Runtime is not registered', async () => {
  const plan = makeInvocationPlan({ executionTarget: { runtimeType: 'codex' } });
  const { service } = createService([]);
  const result = await service.run(plan);
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'CAPABILITY_BLOCKED');
  assert.match(result.error?.message ?? '', /Unsupported runtime/);
});

test('fails closed instead of running Codex in the Nest process when the Worker is unavailable', async () => {
  const plan = makeInvocationPlan({ executionTarget: { runtimeType: 'codex' } });
  const { service } = createService([adapter('codex')], undefined, { serverWorker: null });
  const result = await service.run(plan);
  assert.equal(result.status, 'failed');
  assert.match(result.error?.message ?? '', /Worker is unavailable; in-process execution is forbidden/i);
});

test('server GitHub task execution cannot bypass an unavailable isolated worktree', async () => {
  const previous = process.env.AGENT_CLUSTER_WORKTREE_EXECUTION;
  process.env.AGENT_CLUSTER_WORKTREE_EXECUTION = 'false';
  try {
    let starts = 0;
    const codex = adapter('codex', async plan => {
      starts += 1;
      return completed(plan);
    });
    const plan = makeInvocationPlan({ taskId: 'task-1', executionTarget: { runtimeType: 'codex' } });
    const session = {
      id: plan.sessionId,
      codeSource: { kind: 'remote_repository', provider: 'github', repositoryUrl: 'https://github.com/example/repo' },
      sourceBinding: { state: 'ready', workspaceId: plan.contextEnvelope.workspaceId }
    };

    for (const worktree of [undefined, new WorktreeExecutionService({} as never)]) {
      const { service, persisted } = createService([codex], undefined, { worktree });
      persisted.set('sessions', [session]);
      const result = await service.run(plan);
      assert.equal(result.status, 'failed');
      assert.equal(result.error?.message, 'GITHUB_TASK_REQUIRES_ISOLATED_WORKTREE');
      assert.equal(starts, 0);
    }

    const { service } = createService([codex], undefined, {
      worktree: new WorktreeExecutionService({} as never)
    });
    const ordinary = await service.run({ ...plan, sessionId: 'ordinary-session', invocationId: 'ordinary-invocation' });
    assert.equal(ordinary.status, 'completed');
    assert.equal(starts, 1, 'the setting still permits existing server directory sessions');
  } finally {
    if (previous === undefined) delete process.env.AGENT_CLUSTER_WORKTREE_EXECUTION;
    else process.env.AGENT_CLUSTER_WORKTREE_EXECUTION = previous;
  }
});

test('server GitHub task execution prepares a GitHub worktree only after source binding is ready', async () => {
  let prepares = 0;
  let starts = 0;
  const codex = adapter('codex', async plan => {
    starts += 1;
    return completed(plan);
  });
  const worktree = {
    shouldManage: () => true,
    async prepare(_plan: InvocationPlan, options: { github?: boolean }) {
      prepares += 1;
      assert.deepEqual(options, { github: true });
      return {
        manifest: { repositoryId: 'repository-1', baseRevision: { id: 'revision-1' },
          dirtyBaseline: false, executionWorkDir: 'C:/isolated-github-task' },
        release() {}
      };
    },
    async capture(_lease: unknown, result: AgentRunResult) { return result; }
  };
  const plan = makeInvocationPlan({ taskId: 'task-1', executionTarget: { runtimeType: 'codex' } });
  const { service, persisted } = createService([codex], undefined, { worktree });
  const session = {
    id: plan.sessionId,
    codeSource: { kind: 'remote_repository', provider: 'github', repositoryUrl: 'https://github.com/example/repo' },
    sourceBinding: { state: 'awaiting_base_branch', workspaceId: plan.contextEnvelope.workspaceId }
  };
  persisted.set('sessions', [session]);
  const blocked = await service.run(plan);
  assert.equal(blocked.status, 'failed');
  assert.equal(blocked.error?.message, 'GITHUB_SOURCE_NOT_READY');
  assert.equal(prepares, 0);
  assert.equal(starts, 0);

  persisted.set('sessions', [{ ...session, sourceBinding: { ...session.sourceBinding, state: 'ready' } }]);
  const ready = await service.run({ ...plan, invocationId: 'ready-invocation' });
  assert.equal(ready.status, 'completed', ready.error?.message);
  assert.equal(prepares, 1);
  assert.equal(starts, 1);
});

test('normalizes adapter promise rejection into a failed result', async () => {
  const codex = adapter('codex', async () => { throw new Error('adapter exploded'); });
  const { service } = createService([codex]);
  const result = await service.run(makeInvocationPlan({ executionTarget: { runtimeType: 'codex' } }));
  assert.equal(result.status, 'failed');
  assert.match(result.error?.message ?? '', /adapter exploded/);
});

test('persists the compiled Agent identity snapshot', async () => {
  const plan = makeInvocationPlan({
    agent: {
      profileHash: 'profile-audit',
      profileRevision: 7,
      skillBindings: [{ id: 'skill-1', key: 'review', revision: 3, contentHash: 'skill-hash' }]
    },
    executionTarget: { runtimeType: 'mock' }
  });
  const { service } = createService([adapter('mock')]);
  await service.run(plan);
  const [log] = service.listInvocations(plan.sessionId);
  assert.deepEqual(log.profileSnapshot, {
    agentId: plan.agent.agentId,
    profileHash: 'profile-audit',
    profileRevision: 7,
    resolvedSkillIds: ['skill-1'],
    resolvedSkillRevisions: { 'skill-1': 3 },
    resolvedToolIds: []
  });
});

test('persists execution target, tool catalog, and ContextEnvelope together', async () => {
  const plan = makeInvocationPlan({
    executionTarget: { runtimeType: 'mock', modelId: 'model-1' },
    attempt: {
      attemptGroupId: '00000000-0000-4000-8000-000000000904',
      attempt: 2,
      supplementalContextAttempt: 1,
      supplementalContextDurationMs: 37
    },
    contextEnvelope: {
      L1: { navigation: { indexGeneration: 4, indexStatus: 'building', indexComplete: false } },
      L3: {
        files: [{ path: 'src/main.ts', content: 'main', byteLength: 4 }],
        totalByteLength: 4
      }
    }
  });
  const { service } = createService([adapter('mock')]);
  await service.run(plan);
  const [log] = service.listInvocations(plan.sessionId);
  assert.deepEqual(log.executionTarget, plan.executionTarget);
  assert.deepEqual(log.toolCatalog, plan.toolCatalog);
  assert.deepEqual(log.contextEnvelope, plan.contextEnvelope);
  assert.equal(log.workspaceIndexGeneration, 4);
  assert.equal(log.workspaceIndexStatus, 'building');
  assert.equal(log.workspaceIndexComplete, false);
  assert.equal(log.workspaceRevisionAtStart.id, 'revision-test');
  assert.equal(log.supplementalContextAttempt, 1);
  assert.equal(log.supplementalContextDurationMs, 37);
  assert.equal(log.evidenceBytes, 4);
  assert.deepEqual(log.evidencePaths, ['src/main.ts']);
});

test('persists Runtime usage and result status', async () => {
  const plan = makeInvocationPlan({
    workItemId: '00000000-0000-4000-8000-000000000905',
    executionTarget: { runtimeType: 'mock' }
  });
  const { service } = createService([adapter('mock')]);
  await service.run(plan);
  const [log] = service.listInvocations(plan.sessionId);
  assert.equal(log.status, 'completed');
  assert.equal(log.workItemId, plan.workItemId);
  assert.equal(log.dataEpoch, 'epoch-test');
  assert.equal(log.usage?.totalTokens, 15);
  assert.equal(log.systemEvidence.invocationId, plan.invocationId);
});

test('persists the exact output contract identity used by the invocation', async () => {
  const plan = makeInvocationPlan({ executionTarget: { runtimeType: 'mock' } });
  const { service } = createService([adapter('mock')]);
  await service.run(plan);
  const [log] = service.listInvocations(plan.sessionId);
  assert.equal(log.outputContract.contractId, `runtime.output.${plan.expectedOutput.kind}`);
  assert.equal(log.outputContract.contractVersion, '1.0');
  assert.match(log.outputContract.schemaHash, /^fnv1a32:[0-9a-f]{8}$/);
});

test('listAvailableRuntimeTypes reflects the active registry', () => {
  const { service } = createService([adapter('codex'), adapter('generic_llm')]);
  assert.deepEqual(service.listAvailableRuntimeTypes(), ['codex', 'generic_llm']);
});

test('startup gate rejects persisted RuntimeInvocation without dataEpoch', () => {
  assert.throws(
    () => createService([], [], {}, { 'session-1': [{ id: 'legacy' }] }),
    /CUTOVER_REQUIRED: persisted RuntimeInvocation has no dataEpoch/
  );
});

test('startup gate rejects persisted RuntimeInvocation from a stale dataEpoch', () => {
  assert.throws(
    () => createService([], [], {}, { 'session-1': [{ id: 'stale', dataEpoch: 'epoch-old' }] }),
    /STALE_DATA_EPOCH/
  );
});

test('startup gate rejects persisted RuntimeInvocation with stale contract identity', async () => {
  const plan = makeInvocationPlan({ executionTarget: { runtimeType: 'mock' } });
  const { service } = createService([adapter('mock')]);
  await service.run(plan);
  const [validLog] = service.listInvocations(plan.sessionId);

  for (const outputContract of [
    { ...validLog.outputContract, contractId: 'runtime.output.stale' },
    { ...validLog.outputContract, schemaHash: 'fnv1a32:deadbeef' }
  ]) {
    assert.throws(
      () => createService([], [], {}, {
        [plan.sessionId]: [{ ...validLog, outputContract }]
      }),
      /CUTOVER_REQUIRED: persisted RuntimeInvocation does not satisfy the v3 contract/
    );
  }
});

test('Runtime availability reports registration, preflight reason, and workspace kinds', async () => {
  const codex = adapter('codex');
  codex.checkAvailability = async () => ({ available: false, reason: 'disabled for test' });
  codex.metadata = {
    name: 'codex',
    version: '2.0.0',
    category: 'external',
    provider: 'openai',
    capabilityIds: [],
    supportedWorkspaceCapabilities: ['read'],
    supportedWorkspaceProviderKinds: ['server_local'],
    supportedToolNames: ['read_file']
  };
  const { service } = createService([], [codex]);
  const status = (await service.listRuntimeAvailability()).find((item) => item.runtimeType === 'codex');
  assert.deepEqual(status, {
    runtimeType: 'codex',
    available: false,
    registered: false,
    reason: 'disabled for test',
    supportedWorkspaceProviderKinds: ['server_local']
  });
});

test('keeps a successful resumed CLI session without retrying', async () => {
  const calls: InvocationPlan[] = [];
  const codex = adapter('codex', async (plan) => {
    calls.push(plan);
    return { ...completed(plan, 'codex'), runtimeSession: { cliSessionId: 'session-1', workDir: '/workspace' } };
  });
  const { service } = createService([codex]);
  const plan = makeInvocationPlan({
    executionTarget: { runtimeType: 'codex' },
    resume: { cliSessionId: 'session-1', workDir: '/workspace' }
  });
  const result = await service.run(plan);
  assert.equal(result.status, 'completed');
  assert.equal(calls.length, 1);
  assert.equal(calls[0], plan);
});

test('does not replay completed work when the resumed CLI session id mismatches', async () => {
  const calls: InvocationPlan[] = [];
  const codex = adapter('codex', async (plan) => {
    calls.push(plan);
    const cliSessionId = plan.resume ? 'unexpected-session' : 'new-session';
    return { ...completed(plan, 'codex'), runtimeSession: { cliSessionId, workDir: '/workspace' } };
  });
  const { service } = createService([codex]);
  const plan = makeInvocationPlan({
    executionTarget: { runtimeType: 'codex' },
    resume: { cliSessionId: 'expired-session', workDir: '/workspace' }
  });
  const handle = service.start(plan);
  const events: AgentRuntimeEvent[] = [];
  const consume = (async () => {
    for await (const event of handle.events) events.push(event);
  })();
  const result = await handle.result;
  await consume;
  assert.equal(result.runtimeSession?.cliSessionId, 'unexpected-session');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].resume?.cliSessionId, 'expired-session');
  assert.equal(events.filter((event) => event.metadata?.code === 'RESUME_FALLBACK').length, 0);
});

test('does not fall back when a resumed Runtime invocation is rejected before execution', async () => {
  const calls: InvocationPlan[] = [];
  const claude = adapter('claude_code', async (plan) => {
    calls.push(plan);
    return {
      ...completed(plan, 'claude_code'),
      status: 'failed',
      error: {
        code: 'RUNTIME_INVOCATION_ERROR',
        message: 'Claude Code rejected the Runtime invocation arguments.',
        retryable: false,
        details: { diagnosticRef: plan.invocationId }
      }
    };
  });
  const { service } = createService([claude]);
  const plan = makeInvocationPlan({
    executionTarget: { runtimeType: 'claude_code' },
    resume: { cliSessionId: 'existing-session', workDir: '/workspace' }
  });
  const handle = service.start(plan);
  const events: AgentRuntimeEvent[] = [];
  const consume = (async () => {
    for await (const event of handle.events) events.push(event);
  })();
  const result = await handle.result;
  await consume;

  assert.equal(result.error?.code, 'RUNTIME_INVOCATION_ERROR');
  assert.equal(calls.length, 1);
  assert.equal(calls[0], plan);
  assert.equal(events.some((event) => event.metadata?.code === 'RESUME_FALLBACK'), false);
});

test('findPriorInvocation is scoped to session, agent, task, and Runtime', async () => {
  const plan = makeInvocationPlan({
    sessionId: 'session-a',
    taskId: 'task-a',
    agent: { agentId: 'agent-a' },
    executionTarget: { runtimeType: 'claude_code' }
  });
  const claude = adapter('claude_code', async (input) => ({
    ...completed(input, 'claude_code'),
    runtimeSession: { cliSessionId: 'claude-session', workDir: '/workspace' }
  }));
  const { service } = createService([claude]);
  await service.run(plan);
  assert.deepEqual(service.findPriorInvocation('session-a', 'agent-a', 'task-a', 'claude_code'), {
    cliSessionId: 'claude-session',
    workDir: '/workspace'
  });
  assert.equal(service.findPriorInvocation('session-a', 'agent-a', 'task-a', 'codex'), undefined);
});

test('a CLI conversation is never resumed across WorkItems or across a superseded session generation', async () => {
  const claude = adapter('claude_code', async (input) => ({
    ...completed(input, 'claude_code'),
    runtimeSession: { cliSessionId: `cli-${input.workItemId ?? 'none'}`, workDir: '/workspace' }
  }));
  const { service, persistence } = createService([claude]);
  await persistence.setCollection('sessionLifecyclesBySession', {
    'session-a': {
      contractVersion: 'main-agent-collaboration/v1', sessionId: 'session-a', dataEpoch: 'epoch',
      generation: 1, revision: 1, state: 'active', admission: 'open', stopStatus: 'idle'
    }
  });
  await service.run(makeInvocationPlan({
    sessionId: 'session-a', taskId: 'task-a', workItemId: 'work-a',
    agent: { agentId: 'agent-a' }, executionTarget: { runtimeType: 'claude_code' }
  }));

  assert.deepEqual(
    service.findPriorInvocation('session-a', 'agent-a', 'task-a', 'claude_code', { workItemId: 'work-a' }),
    { cliSessionId: 'cli-work-a', workDir: '/workspace' }
  );
  assert.equal(
    service.findPriorInvocation('session-a', 'agent-a', 'task-a', 'claude_code', { workItemId: 'work-b' }),
    undefined,
    'another requirement must not inherit the private CLI history'
  );

  await persistence.setCollection('sessionLifecyclesBySession', {
    'session-a': {
      contractVersion: 'main-agent-collaboration/v1', sessionId: 'session-a', dataEpoch: 'epoch',
      generation: 2, revision: 3, state: 'active', admission: 'open', stopStatus: 'confirmed'
    }
  });
  assert.equal(
    service.findPriorInvocation('session-a', 'agent-a', 'task-a', 'claude_code', { workItemId: 'work-a' }),
    undefined,
    'a restored generation starts a fresh CLI context instead of replaying the old one'
  );
});

test('a CLI conversation past the rotation threshold is not resumed; the checkpoint carries state instead', async () => {
  const previous = process.env.CLI_CONTEXT_ROTATION_INPUT_TOKENS;
  process.env.CLI_CONTEXT_ROTATION_INPUT_TOKENS = '1000';
  try {
    let call = 0;
    const claude = adapter('claude_code', async (input) => {
      call += 1;
      return {
        ...completed(input, 'claude_code'),
        usage: { inputTokens: 600, outputTokens: 10, totalTokens: 610 },
        runtimeSession: { cliSessionId: 'cli-rotating', workDir: '/workspace' }
      };
    });
    const { service } = createService([claude]);
    const plan = () => makeInvocationPlan({
      invocationId: `invocation-${call + 1}`, sessionId: 'session-a', taskId: 'task-a', workItemId: 'work-a',
      agent: { agentId: 'agent-a' }, executionTarget: { runtimeType: 'claude_code' }
    });
    await service.run(plan());
    assert.deepEqual(
      service.findPriorInvocation('session-a', 'agent-a', 'task-a', 'claude_code', { workItemId: 'work-a' }),
      { cliSessionId: 'cli-rotating', workDir: '/workspace' },
      'below the threshold the conversation resumes'
    );
    await service.run(plan());
    assert.equal(
      service.findPriorInvocation('session-a', 'agent-a', 'task-a', 'claude_code', { workItemId: 'work-a' }),
      undefined,
      'past the threshold the next invocation must start a fresh context'
    );
  } finally {
    if (previous === undefined) delete process.env.CLI_CONTEXT_ROTATION_INPUT_TOKENS;
    else process.env.CLI_CONTEXT_ROTATION_INPUT_TOKENS = previous;
  }
});

test('a fresh CLI context cannot replay a completed invocation or its side effects', async () => {
  let starts = 0;
  const claude = adapter('claude_code', async (input) => {
    starts += 1;
    return {
      ...completed(input, 'claude_code'),
      runtimeSession: { cliSessionId: `cli-context-${starts}`, workDir: '/workspace' }
    };
  });
  const { service } = createService([claude]);
  const operation = {
    id: 'operation-with-completed-side-effect',
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    policyVersion: 'execution-reliability-v1' as const,
    maxAttempts: 3
  };
  const plan = makeInvocationPlan({
    invocationId: 'completed-side-effect-invocation',
    sessionId: 'session-a',
    taskId: 'task-a',
    workItemId: 'work-a',
    agent: { agentId: 'agent-a' },
    executionTarget: { runtimeType: 'claude_code' },
    operation
  });

  assert.equal((await service.run(plan)).status, 'completed');
  const replay = await service.run({ ...plan, resume: undefined });

  assert.equal(starts, 1, 'operation/invocation dedupe must stop a second adapter process before side effects run');
  assert.equal(replay.status, 'failed');
  assert.equal(replay.error?.details?.operationFailure, 'OPERATION_DUPLICATE_INVOCATION');
});

/**
 * Settlement is deliberately asynchronous bookkeeping, so a test that asserts on
 * the ledger has to wait for it instead of assuming it already happened.
 */
async function waitForSettlement(predicate: () => boolean, label: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(`settlement never reconciled: ${label}`);
}

test('a requirement is charged before the call and settled from reported usage', async () => {
  const seen: InvocationPlan[] = [];
  const mock = adapter('mock', async plan => {
    seen.push(plan);
    return { ...completed(plan), usage: { inputTokens: 120, outputTokens: 5, totalTokens: 125, model: 'mock' } };
  });
  const { service, persisted } = createService([mock]);
  // Requirement limit reuses the session budget that is already configured.
  persisted.set('sessions', [{ id: 'session-1', tokenBudget: 1_000 }]);

  const result = await service.run(makeInvocationPlan({
    sessionId: 'session-1',
    workItemId: 'work-item-1',
    executionTarget: { runtimeType: 'mock' },
    budget: { maxInputTokens: 400, maxOutputTokens: 200, maxTotalTokens: 1_000 }
  }));

  assert.equal(result.status, 'completed');
  assert.equal(seen.length, 1, 'the call must actually run');
  await waitForSettlement(
    () => service.workItemBudgets.get('session-1', 'work-item-1')?.actualTokens === 120,
    'reported usage must replace the reservation'
  );
  const ledger = service.workItemBudgets.get('session-1', 'work-item-1');
  assert.ok(ledger, 'the requirement must have a ledger');
  assert.equal(ledger?.reservedTokens, 0, 'the reservation must be reconciled');
  assert.equal(ledger?.actualTokens, 120, 'the provider measurement must be recorded');
  assert.equal(ledger?.settlements[0]?.outcome, 'reported');
});

test('known non-model runtimes release a zero-token reservation', async () => {
  const reader = adapter('code_reader', async plan => ({
    ...completed(plan, 'code_reader'),
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, model: 'code_reader' }
  }));
  const { service, persisted } = createService([reader]);
  persisted.set('sessions', [{ id: 'session-1', tokenBudget: 1_000 }]);

  const plan = makeInvocationPlan({
    sessionId: 'session-1',
    workItemId: 'work-item-non-model',
    executionTarget: { runtimeType: 'code_reader' },
    budget: { maxInputTokens: 700, maxOutputTokens: 200, maxTotalTokens: 1_000 }
  });
  const result = await service.run(plan);

  assert.equal(result.status, 'completed');
  await waitForSettlement(
    () => service.workItemBudgets.get('session-1', 'work-item-non-model')?.settlements.length === 1,
    'known non-model usage must settle as actual zero'
  );
  const ledger = service.workItemBudgets.get('session-1', 'work-item-non-model');
  assert.equal(ledger?.reservedTokens, 0);
  assert.equal(ledger?.actualTokens, 0);
  assert.equal(ledger?.unknownTokens, 0);
  assert.equal(service.workItemBudgets.available('session-1', 'work-item-non-model'), 1_000);
});

test('a late result after cancellation settles the WorkItem ledger once without republishing success', async () => {
  let finish: (result: AgentRunResult) => void = () => {
    throw new Error('late result resolver was not initialized');
  };
  const selected = adapter('mock');
  selected.start = plan => ({
    events: (async function* () {})(),
    result: new Promise<AgentRunResult>((resolve) => { finish = resolve; }),
    // Simulate a non-cooperative provider: cancellation returns before the
    // provider eventually reports its final, billable result.
    async cancel() {}
  });
  const { service, persisted } = createService([selected]);
  persisted.set('sessions', [{ id: 'session-1', tokenBudget: 1_000 }]);
  const plan = makeInvocationPlan({
    sessionId: 'session-1',
    workItemId: 'work-item-late-result',
    executionTarget: { runtimeType: 'mock' },
    budget: { maxInputTokens: 400, maxOutputTokens: 200, maxTotalTokens: 1_000 }
  });

  const running = service.start(plan);
  await waitForSettlement(
    () => service.workItemBudgets.get('session-1', 'work-item-late-result')?.reservedTokens === 400,
    'the admission reservation must exist before cancellation'
  );
  await running.cancel(createExecutionTermination({
    kind: 'user_paused', source: 'user', scope: 'session'
  }));
  const cancelled = await running.result;
  assert.notEqual(cancelled.status, 'completed', 'the stopped invocation must not publish a success first');
  assert.equal(
    service.workItemBudgets.get('session-1', 'work-item-late-result')?.reservedTokens,
    400,
    'the provider can still have billable work until its late result arrives'
  );

  finish({
    ...completed(plan),
    usage: { inputTokens: 120, outputTokens: 5, totalTokens: 125, model: 'mock' }
  });
  await waitForSettlement(
    () => service.workItemBudgets.get('session-1', 'work-item-late-result')?.actualTokens === 120,
    'the late provider result must reconcile the outstanding reservation'
  );
  const ledger = service.workItemBudgets.get('session-1', 'work-item-late-result');
  assert.equal(ledger?.reservedTokens, 0);
  assert.equal(ledger?.actualTokens, 120);
  assert.equal(ledger?.settlements.length, 1, 'the late result must not charge the requirement twice');
  assert.equal(
    service.listInvocations(plan.sessionId).some((item) => item.status === 'completed'),
    false,
    'a late success may settle accounting but cannot revive the stopped invocation'
  );
});

test('a non-billable mock cancellation releases its reservation instead of exhausting a restored requirement', async () => {
  const mock = adapter('mock', async plan => ({
    ...completed(plan),
    status: 'cancelled',
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, model: 'mock' },
    error: { code: 'RUNTIME_CANCELLED', message: 'Mock invocation was cancelled.', retryable: false }
  }));
  const { service, persisted } = createService([mock]);
  persisted.set('sessions', [{ id: 'session-1', tokenBudget: 1_000 }]);
  const plan = makeInvocationPlan({
    sessionId: 'session-1',
    workItemId: 'work-item-restored-session',
    executionTarget: { runtimeType: 'mock' },
    budget: { maxInputTokens: 700, maxOutputTokens: 200, maxTotalTokens: 1_000 }
  });

  const result = await service.run(plan);
  assert.equal(result.status, 'cancelled');
  await waitForSettlement(
    () => service.workItemBudgets.get('session-1', 'work-item-restored-session')?.settlements.length === 1,
    'a deterministic mock cancellation must settle its reservation'
  );
  const ledger = service.workItemBudgets.get('session-1', 'work-item-restored-session');
  assert.equal(ledger?.reservedTokens, 0);
  assert.equal(ledger?.actualTokens, 0);
  assert.equal(ledger?.unknownTokens, 0);
  assert.equal(ledger?.settlements[0]?.outcome, 'reported');
  assert.equal(service.workItemBudgets.available('session-1', 'work-item-restored-session'), 1_000);
});

test('a requirement without allowance left proceeds while cumulative enforcement is disabled', async () => {
  const seen: InvocationPlan[] = [];
  const mock = adapter('mock', async plan => {
    seen.push(plan);
    // Reports the full reservation, so almost nothing is left afterwards.
    return { ...completed(plan), usage: { inputTokens: 400, outputTokens: 5, totalTokens: 405, model: 'mock' } };
  });
  const { service, persisted } = createService([mock]);
  persisted.set('sessions', [{ id: 'session-1', tokenBudget: 500 }]);

  const first = await service.run(makeInvocationPlan({
    invocationId: '00000000-0000-4000-8000-0000000009a1',
    sessionId: 'session-1',
    workItemId: 'work-item-1',
    executionTarget: { runtimeType: 'mock' },
    budget: { maxInputTokens: 400, maxOutputTokens: 200, maxTotalTokens: 500 }
  }));
  assert.equal(first.status, 'completed');
  await waitForSettlement(
    () => service.workItemBudgets.get('session-1', 'work-item-1')?.actualTokens === 400,
    'the first call must be settled before the second one is judged'
  );
  assert.equal(service.workItemBudgets.available('session-1', 'work-item-1'), 100);

  const second = await service.run(makeInvocationPlan({
    invocationId: '00000000-0000-4000-8000-0000000009a2',
    sessionId: 'session-1',
    workItemId: 'work-item-1',
    executionTarget: { runtimeType: 'mock' },
    budget: { maxInputTokens: 400, maxOutputTokens: 200, maxTotalTokens: 500 }
  }));

  assert.equal(second.status, 'completed');
  assert.equal(seen.length, 2, 'cumulative exhaustion must not block the adapter by default');
});

test('a requirement without allowance left is refused when cumulative enforcement is explicitly enabled', async () => {
  const previous = process.env.AGENT_CLUSTER_WORK_ITEM_BUDGET_ENFORCEMENT;
  process.env.AGENT_CLUSTER_WORK_ITEM_BUDGET_ENFORCEMENT = 'true';
  try {
    const seen: InvocationPlan[] = [];
    const mock = adapter('mock', async plan => {
      seen.push(plan);
      return { ...completed(plan), usage: { inputTokens: 400, outputTokens: 5, totalTokens: 405, model: 'mock' } };
    });
    const { service, persisted } = createService([mock]);
    persisted.set('sessions', [{ id: 'session-1', tokenBudget: 500 }]);

    const first = await service.run(makeInvocationPlan({
      invocationId: '00000000-0000-4000-8000-0000000009b1',
      sessionId: 'session-1',
      workItemId: 'work-item-enforced',
      executionTarget: { runtimeType: 'mock' },
      budget: { maxInputTokens: 400, maxOutputTokens: 200, maxTotalTokens: 500 }
    }));
    assert.equal(first.status, 'completed');
    await waitForSettlement(
      () => service.workItemBudgets.get('session-1', 'work-item-enforced')?.actualTokens === 400,
      'the first enforced call must settle before admission is checked again'
    );

    const second = await service.run(makeInvocationPlan({
      invocationId: '00000000-0000-4000-8000-0000000009b2',
      sessionId: 'session-1',
      workItemId: 'work-item-enforced',
      executionTarget: { runtimeType: 'mock' },
      budget: { maxInputTokens: 400, maxOutputTokens: 200, maxTotalTokens: 500 }
    }));

    assert.equal(second.status, 'failed');
    assert.equal(second.error?.code, 'WORK_ITEM_BUDGET_EXHAUSTED');
    assert.match(String(second.error?.message), /累计模型预算已不足/);
    assert.equal(seen.length, 1, 'explicit enforcement must stop the second adapter call');
    assert.equal(second.error?.details?.availableTokens, 100);
    assert.equal(second.error?.details?.requestedTokens, 400);
  } finally {
    if (previous === undefined) delete process.env.AGENT_CLUSTER_WORK_ITEM_BUDGET_ENFORCEMENT;
    else process.env.AGENT_CLUSTER_WORK_ITEM_BUDGET_ENFORCEMENT = previous;
  }
});

test('an invocation without a work item is not charged to any requirement', async () => {
  const mock = adapter('mock');
  const { service, persisted } = createService([mock]);
  persisted.set('sessions', [{ id: 'session-1', tokenBudget: 1_000 }]);

  const result = await service.run(makeInvocationPlan({
    sessionId: 'session-1',
    executionTarget: { runtimeType: 'mock' }
  }));

  assert.equal(result.status, 'completed', 'an unowned invocation keeps working unchanged');
  assert.equal(service.workItemBudgets.get('session-1', 'work-item-any'), undefined);
});
