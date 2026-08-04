import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentRunResult, AgentRuntimeAdapter, AgentRuntimeEvent, InvocationPlan, RuntimeType } from '@agent-cluster/shared';
import { createAgentMessageOutput, createRuntimeArtifactSystemEvidence } from '@agent-cluster/shared';
import { makeInvocationPlan } from './invocation-plan.fixture.js';
import { RuntimeService } from './runtime.service.js';
import { createExecutionTermination } from '../../common/execution-termination.js';

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
  initialInvocations?: Record<string, unknown[]>
) {
  const persisted = new Map<string, unknown>();
  if (initialInvocations) persisted.set('runtimeInvocationsBySession', initialInvocations);
  const registry = {
    registerAdapter: async () => {},
    getAdapter: (type: RuntimeType) => adapters.find((item) => item.type === type),
    listAll: () => adapters
  };
  const persistence = {
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
    workspaceBindings as never
  );
  return { service, persisted };
}

test('dispatches by InvocationPlan.executionTarget', async () => {
  const codex = adapter('codex');
  const { service } = createService([codex]);
  const result = await service.run(makeInvocationPlan({ executionTarget: { runtimeType: 'codex' } }));
  assert.equal(result.runtimeType, 'codex');
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
  assert.equal(log.executionTarget, plan.executionTarget);
  assert.equal(log.toolCatalog, plan.toolCatalog);
  assert.equal(log.contextEnvelope, plan.contextEnvelope);
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
  const plan = makeInvocationPlan({ executionTarget: { runtimeType: 'mock' } });
  const { service } = createService([adapter('mock')]);
  await service.run(plan);
  const [log] = service.listInvocations(plan.sessionId);
  assert.equal(log.status, 'completed');
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

test('falls back once without resume when the resumed session id mismatches', async () => {
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
  assert.equal(result.runtimeSession?.cliSessionId, 'new-session');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].resume?.cliSessionId, 'expired-session');
  assert.equal(calls[1].resume, undefined);
  assert.equal(events.filter((event) => event.metadata?.code === 'RESUME_FALLBACK').length, 1);
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
