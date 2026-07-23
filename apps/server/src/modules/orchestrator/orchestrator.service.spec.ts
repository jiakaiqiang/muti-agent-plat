import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentDefinition as Agent,
  AgentRunResult,
  AgentTask,
  Artifact,
  CollaborationEvent,
  ContextAssembly,
  InvocationPlan,
  PostReviewReportOutput,
  RuntimeArtifactOutput,
  RuntimeContextRequest,
  RuntimeError,
  SessionDetail,
  SupplementalContextResolution,
  TaskBrief,
  TaskAcceptanceDecisionOutput,
  TaskBriefOutput,
  TaskExecutionResultOutput
} from '@agent-cluster/shared';
import {
  createAgentMessageOutput,
  createMetadata,
  createRuntimeArtifactOutput,
  createRuntimeArtifactSystemEvidence,
  emptyRuntimeArtifactProposalMetadata,
  runtimeOutputExamples
} from '@agent-cluster/shared';
import { OrchestratorService, usableAgentMessageOutput } from './orchestrator.service.js';
import { makeInvocationPlan } from '../runtimes/invocation-plan.fixture.js';

function agent(key: string): Agent {
  return {
    id: key,
    key,
    name: `${key} agent`,
    role: key,
    description: `${key} test agent`,
    profileMarkdown: `# ${key}`,
    tags: [],
    status: 'active',
    capabilityIds: [],
    defaultKnowledgeBaseIds: [],
    profileRevision: 1,
    createdAt: '2026-07-03T00:00:00.000Z',
    updatedAt: '2026-07-03T00:00:00.000Z'
  };
}

function suggestedTask(
  input: Pick<TaskBriefOutput['suggestedTasks'][number], 'title' | 'description' | 'suggestedAgentKey' | 'acceptanceCriteria'>
): TaskBriefOutput['suggestedTasks'][number] {
  return {
    ...input,
    routingMode: null,
    assignmentReason: null,
    contextRequirements: [],
    verificationPlan: [],
    riskNotes: [],
    requiresUserConfirmation: false,
    dependsOnTaskTitles: []
  };
}

type ServiceRecorder = {
  events: CollaborationEvent[];
  taskUpdates: Array<Partial<AgentTask>>;
  runtimeCalls: number;
  availabilityRefreshes?: number;
};

function makeService(createdArtifacts: Artifact[] = [], recorder?: ServiceRecorder) {
  const agents = new Map(
    ['coordinator', 'requirements', 'architect', 'product-manager', 'backend', 'test', 'review'].map((key) => [
      key,
      agent(key)
    ])
  );
  return new OrchestratorService(
    {
      findByIdOrKey(key: string) {
        return agents.get(key);
      },
      getByIdOrKey(key: string) {
        const found = agents.get(key);
        if (!found) throw new Error(`Unknown agent: ${key}`);
        return found;
      }
    } as never,
    {
      create(input: Omit<CollaborationEvent, 'id' | 'createdAt' | 'toAgentIds'> & { toAgentIds?: string[] }) {
        const event: CollaborationEvent = {
          id: `event-${(recorder?.events.length ?? 0) + 1}`,
          createdAt: '2026-07-03T00:00:00.000Z',
          toAgentIds: [],
          ...input
        };
        recorder?.events.push(event);
        return event;
      },
      list() {
        return recorder?.events ?? [];
      }
    } as never,
    {
      getAdapter() {
        return undefined;
      },
      findPriorInvocation() {
        return undefined;
      },
      listAvailableRuntimeTypes() {
        return ['mock'];
      },
      async refreshRuntimeAvailability() {
        if (recorder) recorder.availabilityRefreshes = (recorder.availabilityRefreshes ?? 0) + 1;
        return [];
      },
      start(input: InvocationPlan) {
        if (recorder) recorder.runtimeCalls += 1;
        const result: AgentRunResult = {
          invocationId: input.invocationId,
          runtimeType: input.executionTarget.runtimeType,
          status: 'completed',
          output: createAgentMessageOutput({
            messageKind: 'answer',
            content: 'Completed without source evidence.'
          }),
          events: [],
          artifacts: [],
          systemEvidence: createRuntimeArtifactSystemEvidence(input.invocationId),
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, model: 'mock' }
        };
        return {
          events: (async function* () {})(),
          result: Promise.resolve(result),
          async cancel() {},
          hasStreamingEvents: false
        };
      }
    } as never,
    {
      update(task: AgentTask, changes: Partial<AgentTask>) {
        recorder?.taskUpdates.push(changes);
        Object.assign(task, changes);
        return task;
      },
      list() {
        return [];
      }
    } as never,
    {} as never,
    {} as never,
    {
      create(input: Omit<Artifact, 'id' | 'createdAt' | 'dataEpoch' | 'runtimeProposals' | 'platformProjections' | 'systemEvidence'> &
        Partial<Pick<Artifact, 'runtimeProposals' | 'platformProjections' | 'systemEvidence'>>) {
        const artifact: Artifact = {
          id: `artifact-${createdArtifacts.length + 1}`,
          dataEpoch: 'epoch-test',
          createdAt: '2026-07-03T00:00:00.000Z',
          ...input,
          runtimeProposals: input.runtimeProposals ?? [],
          platformProjections: input.platformProjections ?? [],
          systemEvidence: input.systemEvidence ?? null
        };
        createdArtifacts.push(artifact);
        return artifact;
      },
      listBySession() {
        return createdArtifacts;
      },
      get(artifactId: string) {
        const found = createdArtifacts.find((artifact) => artifact.id === artifactId);
        if (!found) throw new Error(`Unknown artifact: ${artifactId}`);
        return found;
      }
    } as never,
    {} as never,
    {
      getCollection<T>(_key: string, fallback: T) {
        return fallback;
      },
      setCollection() {}
    } as never,
    {} as never,
    {} as never,
    {
      compileIdentity({ agent: definition }: { agent: Agent }) {
        return makeInvocationPlan({ agent: { ...definition, agentId: definition.id } }).agent;
      }
    } as never
  );
}

function session(): SessionDetail {
  return {
    id: 'session-1',
    dataEpoch: 'epoch-test',
    title: 'Fix malformed suggested tasks',
    originalInput: 'Fix a backend bug',
    status: 'AGENT_DISCUSSING',
    ownerId: 'user-1',
    workspaceId: 'workspace-1',
    tokenUsed: 0,
    taskDomain: 'coding',
    taskIntent: 'implementation',
    participatingAgentIds: ['coordinator', 'backend', 'test'],
    createdAt: '2026-07-03T00:00:00.000Z',
    updatedAt: '2026-07-03T00:00:00.000Z'
  };
}

test('discussion output guard rejects missing or blank agent message content', () => {
  assert.equal(usableAgentMessageOutput({ kind: 'agent_message', messageKind: 'summary' }), false);
  assert.equal(usableAgentMessageOutput({ kind: 'agent_message', messageKind: 'summary', content: '   ' }), false);
  assert.equal(usableAgentMessageOutput({ kind: 'agent_message', messageKind: 'summary', content: 'done' }), true);
});

test('retryable provider failures retry once and then fall back inside the session allowlist', async () => {
  const recorder: ServiceRecorder = { events: [], taskUpdates: [], runtimeCalls: 0 };
  const service = makeService([], recorder) as unknown as {
    runRuntime(
      session: SessionDetail,
      input: {
        invocationId: string;
        sessionId: string;
        phase: 'discussion';
        agent: Agent;
        contextAssembly: ContextAssembly;
        expectedOutput: { kind: 'agent_message'; schemaVersion: '1.0' };
        budget: Record<string, number>;
      }
    ): Promise<AgentRunResult>;
    runRuntimeAttempt(
      session: SessionDetail,
      input: {
        invocationId: string;
        excludedRuntimeTypes?: string[];
        attempt?: InvocationPlan['attempt'];
      }
    ): Promise<AgentRunResult>;
  };
  const calls: Array<{
    invocationId: string;
    excludedRuntimeTypes?: string[];
    attempt?: InvocationPlan['attempt'];
  }> = [];
  service.runRuntimeAttempt = async (_inputSession, input) => {
    calls.push(input);
    if (calls.length < 3) {
      return {
        invocationId: input.invocationId,
        runtimeType: 'claude_code',
        status: 'failed',
        output: createAgentMessageOutput({ messageKind: 'risk', content: 'gateway timeout' }),
        events: [],
        artifacts: [],
        systemEvidence: createRuntimeArtifactSystemEvidence(input.invocationId),
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, model: 'claude_code' },
        error: {
          code: 'RUNTIME_TIMEOUT',
          message: 'Claude model gateway timed out (HTTP 524).',
          retryable: true,
          details: { providerFailure: true, httpStatus: 524, retryAfterMs: 120_000 }
        }
      };
    }
    return {
      invocationId: input.invocationId,
      runtimeType: 'codex',
      status: 'completed',
      output: createAgentMessageOutput({ messageKind: 'discussion', content: 'fallback completed' }),
      events: [],
      artifacts: [],
      systemEvidence: createRuntimeArtifactSystemEvidence(input.invocationId),
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, model: 'codex' }
    };
  };
  const inputSession = session();
  inputSession.runtimePreference = {
    preferredRuntimeType: 'claude_code',
    allowedRuntimeTypes: ['claude_code', 'codex', 'generic_llm']
  };
  const previousDelay = process.env.RUNTIME_PROVIDER_RETRY_MAX_DELAY_MS;
  process.env.RUNTIME_PROVIDER_RETRY_MAX_DELAY_MS = '0';
  try {
    const result = await service.runRuntime(inputSession, {
      invocationId: 'attempt-group',
      sessionId: inputSession.id,
      phase: 'discussion',
      agent: agent('backend'),
      contextAssembly: {} as ContextAssembly,
      expectedOutput: { kind: 'agent_message', schemaVersion: '1.0' },
      budget: {}
    });

    assert.equal(result.status, 'completed');
    assert.equal(result.runtimeType, 'codex');
    assert.equal(calls.length, 3);
    assert.equal(calls[0]?.attempt?.attempt, 1);
    assert.equal(calls[1]?.attempt?.retryOfInvocationId, 'attempt-group');
    assert.deepEqual(calls[2]?.excludedRuntimeTypes, ['claude_code']);
    assert.equal(calls[2]?.attempt?.fallbackFromRuntimeType, 'claude_code');
    assert.equal(calls[2]?.attempt?.attemptGroupId, 'attempt-group');
    assert.deepEqual(
      recorder.events
        .filter((event) => event.type === 'runtime_progress')
        .map((event) => event.metadata.payload?.code),
      ['RUNTIME_PROVIDER_RETRY_SCHEDULED', 'RUNTIME_PROVIDER_FALLBACK']
    );
  } finally {
    if (previousDelay === undefined) delete process.env.RUNTIME_PROVIDER_RETRY_MAX_DELAY_MS;
    else process.env.RUNTIME_PROVIDER_RETRY_MAX_DELAY_MS = previousDelay;
  }
});

test('provider fallback never bypasses a strict single-Runtime allowlist', async () => {
  const recorder: ServiceRecorder = { events: [], taskUpdates: [], runtimeCalls: 0 };
  const service = makeService([], recorder) as unknown as {
    runRuntime(session: SessionDetail, input: {
      invocationId: string;
      sessionId: string;
      phase: 'discussion';
      agent: Agent;
      contextAssembly: ContextAssembly;
      expectedOutput: { kind: 'agent_message'; schemaVersion: '1.0' };
      budget: Record<string, number>;
    }): Promise<AgentRunResult>;
    runRuntimeAttempt(session: SessionDetail, input: { invocationId: string }): Promise<AgentRunResult>;
  };
  let calls = 0;
  service.runRuntimeAttempt = async (_inputSession, input) => {
    calls += 1;
    return {
      invocationId: input.invocationId,
      runtimeType: 'claude_code',
      status: 'failed',
      output: createAgentMessageOutput({ messageKind: 'risk', content: 'gateway timeout' }),
      events: [],
      artifacts: [],
      systemEvidence: createRuntimeArtifactSystemEvidence(input.invocationId),
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, model: 'claude_code' },
      error: {
        code: 'RUNTIME_TIMEOUT',
        message: 'gateway timeout',
        retryable: true,
        details: { providerFailure: true, httpStatus: 524, retryAfterMs: 0 }
      }
    };
  };
  const inputSession = session();
  inputSession.runtimePreference = {
    preferredRuntimeType: 'claude_code',
    allowedRuntimeTypes: ['claude_code']
  };
  const result = await service.runRuntime(inputSession, {
    invocationId: 'strict-attempt',
    sessionId: inputSession.id,
    phase: 'discussion',
    agent: agent('backend'),
    contextAssembly: {} as ContextAssembly,
    expectedOutput: { kind: 'agent_message', schemaVersion: '1.0' },
    budget: {}
  });

  assert.equal(result.status, 'failed');
  assert.equal(calls, 2);
  assert.equal(recorder.events.some((event) => event.metadata.payload?.code === 'RUNTIME_PROVIDER_FALLBACK'), false);
});

test('fatal Claude invocation failure stops the remaining discussion agents', async () => {
  const recorder: ServiceRecorder = { events: [], taskUpdates: [], runtimeCalls: 0 };
  const service = makeService([], recorder) as unknown as {
    runDiscussion(session: SessionDetail, coordinator: Agent): Promise<void>;
    createContextAssembly(): ContextAssembly;
    runDiscussionRuntime(): Promise<AgentRunResult>;
  };
  service.createContextAssembly = () => ({ budget: {} } as ContextAssembly);
  service.runDiscussionRuntime = async () => ({
    invocationId: 'invocation-failed',
    runtimeType: 'claude_code',
    status: 'failed',
    output: createAgentMessageOutput({ messageKind: 'risk', content: 'Claude Code could not be started.' }),
    events: [],
    artifacts: [],
    systemEvidence: createRuntimeArtifactSystemEvidence('invocation-failed'),
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, model: 'claude_code' },
    error: {
      code: 'RUNTIME_INVOCATION_ERROR',
      message: 'Claude Code could not be started.',
      retryable: false,
      details: { diagnosticRef: 'invocation-failed' }
    }
  });

  await assert.rejects(
    () => service.runDiscussion(session(), agent('coordinator')),
    (error: unknown) => (error as { runtimeError?: RuntimeError }).runtimeError?.code === 'RUNTIME_INVOCATION_ERROR'
  );

  const statuses = recorder.events.filter((event) => event.type === 'agent_status_changed');
  assert.equal(statuses.some((event) => event.fromAgentId === 'backend' && event.content.includes('失败')), true);
  assert.equal(statuses.some((event) => event.fromAgentId === 'test'), false);
  assert.equal(statuses.some((event) => event.content.includes('已完成需求相关性评估')), false);
});

test('discussion refreshes Runtime availability once before Agent fan-out', async () => {
  const recorder: ServiceRecorder = { events: [], taskUpdates: [], runtimeCalls: 0 };
  const service = makeService([], recorder) as unknown as {
    runDiscussion(session: SessionDetail, coordinator: Agent): Promise<void>;
    createContextAssembly(): ContextAssembly;
    runDiscussionRuntime(): Promise<AgentRunResult>;
  };
  service.createContextAssembly = () => ({ budget: {} } as ContextAssembly);
  service.runDiscussionRuntime = async () => ({
    invocationId: crypto.randomUUID(),
    runtimeType: 'generic_llm',
    status: 'completed',
    output: createAgentMessageOutput({ messageKind: 'answer', content: 'ok' }),
    events: [],
    artifacts: [],
    systemEvidence: createRuntimeArtifactSystemEvidence('availability-refresh'),
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, model: 'test' }
  });

  await service.runDiscussion(session(), agent('coordinator'));

  assert.equal(recorder.availabilityRefreshes, 1);
});

test('provider-wide model failure opens the discussion circuit and skips remaining Agents', async () => {
  const recorder: ServiceRecorder = { events: [], taskUpdates: [], runtimeCalls: 0 };
  const service = makeService([], recorder) as unknown as {
    runDiscussion(session: SessionDetail, coordinator: Agent): Promise<void>;
    createContextAssembly(): ContextAssembly;
    runDiscussionRuntime(): Promise<AgentRunResult>;
  };
  service.createContextAssembly = () => ({ budget: {} } as ContextAssembly);
  service.runDiscussionRuntime = async () => ({
    invocationId: 'provider-failed',
    runtimeType: 'generic_llm',
    status: 'failed',
    output: createAgentMessageOutput({ messageKind: 'risk', content: 'provider unavailable' }),
    events: [],
    artifacts: [],
    systemEvidence: createRuntimeArtifactSystemEvidence('provider-failed'),
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, model: 'test' },
    error: {
      code: 'MODEL_ERROR',
      message: 'LLM request was rate limited by the model provider (HTTP 429).',
      retryable: true,
      details: { httpStatus: 429, providerFailure: true }
    }
  });

  await assert.rejects(
    () => service.runDiscussion(session(), agent('coordinator')),
    (error: unknown) => (error as { runtimeError?: RuntimeError }).runtimeError?.details?.httpStatus === 429
  );

  const statuses = recorder.events.filter((event) => event.type === 'agent_status_changed');
  assert.equal(statuses.some((event) => event.fromAgentId === 'backend' && event.content.includes('失败')), true);
  assert.equal(statuses.some((event) => event.fromAgentId === 'test'), false);
});

test('fatal discussion failure prevents the task brief Runtime invocation', async () => {
  const recorder: ServiceRecorder = { events: [], taskUpdates: [], runtimeCalls: 0 };
  const service = makeService([], recorder) as unknown as {
    discussAndCreateBrief(session: SessionDetail): Promise<unknown>;
    createContextAssembly(): ContextAssembly;
    runDiscussionRuntime(): Promise<AgentRunResult>;
  };
  service.createContextAssembly = () => ({ budget: {} } as ContextAssembly);
  service.runDiscussionRuntime = async () => ({
    invocationId: 'invocation-failed-before-brief',
    runtimeType: 'claude_code',
    status: 'failed',
    output: createAgentMessageOutput({
      messageKind: 'risk',
      content: 'Claude Code could not be started.'
    }),
    events: [],
    artifacts: [],
    systemEvidence: createRuntimeArtifactSystemEvidence('invocation-failed-before-brief'),
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, model: 'claude_code' },
    error: {
      code: 'RUNTIME_INVOCATION_ERROR',
      message: 'Claude Code could not be started.',
      retryable: false,
      details: { diagnosticRef: 'invocation-failed-before-brief' }
    }
  });

  await assert.rejects(
    () => service.discussAndCreateBrief(session()),
    (error: unknown) => (error as { runtimeError?: RuntimeError }).runtimeError?.code === 'RUNTIME_INVOCATION_ERROR'
  );
  assert.equal(recorder.runtimeCalls, 0);
});

test('selected event evidence ignores legacy events without text content', () => {
  const emptyEvent = {
    id: 'event-empty-agent-message',
    sessionId: 'session-1',
    type: 'agent_message',
    fromAgentId: 'requirements',
    toAgentIds: ['coordinator'],
    metadata: createMetadata('chat_message', {}),
    createdAt: '2026-07-03T00:00:00.000Z'
  } as unknown as CollaborationEvent;
  const service = makeService([], {
    events: [emptyEvent],
    taskUpdates: [],
    runtimeCalls: 0
  }) as unknown as {
    selectedEvidenceContent(
      session: SessionDetail,
      evidence: { type: 'event_log'; label: string; ref: string }
    ): unknown;
  };

  assert.equal(
    service.selectedEvidenceContent(session(), {
      type: 'event_log',
      label: 'empty agent message',
      ref: emptyEvent.id
    }),
    undefined
  );
});

test('Orchestrator rejects malformed Runtime brief output instead of normalizing it', () => {
  const service = makeService() as unknown as {
    completedOutput<T extends TaskBriefOutput>(result: AgentRunResult, kind: 'task_brief'): T;
  };
  const malformed = {
    kind: 'task_brief',
    goal: 'Fix the orchestration crash',
    scope: [],
    outOfScope: [],
    constraints: [],
    acceptanceCriteria: [],
    risks: [],
    openQuestions: [],
    suggestedTasks: [
      {
        title: 'Implement crash fix',
        suggestedAgentKey: 'backend'
      },
      {
        title: 'Validate fix',
        description: undefined,
        suggestedAgentKey: 'test',
        acceptanceCriteria: undefined
      },
      null
    ]
  } as unknown as TaskBriefOutput;
  let contractError: (Error & { cause?: { code?: string; retryable?: boolean; details?: Record<string, unknown> } }) | undefined;
  try {
    service.completedOutput({ status: 'completed', output: malformed } as AgentRunResult, 'task_brief');
  } catch (error) {
    contractError = error as typeof contractError;
  }
  if (!contractError) assert.fail('Expected the malformed Runtime output to throw.');
  assert.match(contractError?.message ?? '', /RUNTIME_OUTPUT_CONTRACT_VIOLATION/);
  assert.equal(contractError.cause?.code, 'RUNTIME_OUTPUT_CONTRACT_VIOLATION');
  assert.equal(contractError.cause?.retryable, false);
  assert.equal(contractError.cause?.details?.expectedKind, 'task_brief');
  assert.deepEqual(
    service.completedOutput(
      { status: 'completed', output: runtimeOutputExamples.task_brief } as unknown as AgentRunResult,
      'task_brief'
    ),
    runtimeOutputExamples.task_brief
  );
});

function architectureSession(): SessionDetail {
  return {
    ...session(),
    originalInput: 'Analyze the current project architecture and main path',
    taskDomain: 'mixed',
    taskIntent: 'analysis',
    participatingAgentIds: ['coordinator', 'architect', 'requirements', 'test', 'review']
  };
}

function architectureTask(): AgentTask {
  return {
    id: 'task-architecture',
    sessionId: 'session-1',
    title: 'Analyze current project structure and main path from an architecture viewpoint',
    description: 'Read workspaceManifest, projectMap, and selectedEvidenceContents, then produce architecture ideas and suggestions.',
    status: 'assigned',
    assignee: { type: 'agent', id: 'architect' },
    dependsOnTaskIds: [],
    acceptanceCriteria: ['Architecture analysis is grounded in workspace evidence.'],
    createdAt: '2026-07-03T00:00:00.000Z',
    updatedAt: '2026-07-03T00:00:00.000Z'
  };
}

test('workflow task knowledge query retains the user and brief semantics', () => {
  const service = makeService() as unknown as {
    taskKnowledgeQuery(session: SessionDetail, brief: TaskBrief, task: AgentTask): string;
  };
  const workflowTask: AgentTask = {
    ...architectureTask(),
    title: '工作流阶段 · 需求分析师',
    description: '执行当前工作流节点。',
    acceptanceCriteria: ['必须使用 P1_RAG_MARKER 对应知识。']
  };
  const brief: TaskBrief = {
    id: 'brief-rag',
    sessionId: workflowTask.sessionId,
    version: 1,
    goal: '分析 P1 RAG coverage，并使用知识库证据。',
    scope: [],
    outOfScope: [],
    constraints: [],
    acceptanceCriteria: workflowTask.acceptanceCriteria,
    risks: [],
    openQuestions: [],
    confirmedByUser: true,
    createdAt: '2026-07-03T00:00:00.000Z'
  };
  const query = service.taskKnowledgeQuery(
    { ...session(), originalInput: '验证 P1 RAG 检索链路。' },
    brief,
    workflowTask
  );

  assert.match(query, /验证 P1 RAG 检索链路/);
  assert.match(query, /分析 P1 RAG coverage/);
  assert.match(query, /P1_RAG_MARKER/);
});

type TaskExecutionTestService = {
  runOneTask(session: SessionDetail, brief: TaskBrief, task: AgentTask): Promise<{
    ok: boolean;
    message?: string;
    error?: RuntimeError;
    code?: RuntimeError['code'];
    retryable?: boolean;
  }>;
  createContextAssembly(): ContextAssembly;
  runRuntime(session: SessionDetail, input: {
    invocationId: string;
    phase: string;
    agent: Agent;
  }): Promise<AgentRunResult>;
  emitTaskHandoff(): void;
  createSummaryMemoryCheckpoint(): void;
};

function taskExecutionHarness(output: TaskExecutionResultOutput) {
  const recorder: ServiceRecorder = { events: [], taskUpdates: [], runtimeCalls: 0 };
  const service = makeService([], recorder) as unknown as TaskExecutionTestService;
  service.createContextAssembly = () =>
    ({
      relevantMemories: [],
      budget: { maxInputTokens: 1_000, maxOutputTokens: 200, maxTotalTokens: 1_200 }
    }) as unknown as ContextAssembly;
  service.runRuntime = async (_session, input) => ({
    invocationId: input.invocationId,
    runtimeType: 'mock',
    status: 'completed',
    output:
      input.phase === 'task_acceptance'
        ? {
            schemaVersion: '1.0',
            kind: 'task_acceptance_decision',
            status: 'accepted',
            reason: 'Backend agent accepts the task.',
            missingContext: [],
            requestedContext: null,
            handoffSuggestion: null,
            confidence: 1,
            alternativeAgentKeys: [],
            alternativeAgentIds: [],
            agentMessages: []
          }
        : output,
    events: [],
    artifacts: [],
    systemEvidence: createRuntimeArtifactSystemEvidence(input.invocationId),
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, model: 'mock' }
  });
  service.emitTaskHandoff = () => {};
  service.createSummaryMemoryCheckpoint = () => {};
  const activeSession = { ...session(), status: 'EXECUTING' as const };
  const task: AgentTask = {
    id: 'task-evidence-sensitive',
    sessionId: activeSession.id,
    title: 'Implement behavior from available evidence',
    description: 'Do not claim completion without enough source evidence.',
    status: 'assigned',
    assignee: { type: 'agent', id: 'backend' },
    dependsOnTaskIds: [],
    acceptanceCriteria: ['Unsupported completion is forbidden.'],
    createdAt: '2026-07-03T00:00:00.000Z',
    updatedAt: '2026-07-03T00:00:00.000Z'
  };
  const brief: TaskBrief = {
    id: 'brief-evidence-sensitive',
    sessionId: activeSession.id,
    version: 1,
    goal: 'Implement only when evidence is sufficient.',
    scope: [],
    outOfScope: [],
    constraints: [],
    acceptanceCriteria: task.acceptanceCriteria,
    risks: [],
    openQuestions: [],
    confirmedByUser: true,
    createdAt: '2026-07-03T00:00:00.000Z'
  };
  return { recorder, service, activeSession, task, brief };
}

test('architecture analysis generates exactly one architect task without duplicate review work', () => {
  const service = makeService() as unknown as {
    selectSuggestedTasks(session: SessionDetail, runtimeSuggestedTasks: TaskBriefOutput['suggestedTasks']): TaskBriefOutput['suggestedTasks'];
  };

  const suggestions = service.selectSuggestedTasks(architectureSession(), [
    suggestedTask({
      title: 'Generic analysis',
      description: 'A model-proposed generic analysis task.',
      suggestedAgentKey: 'requirements',
      acceptanceCriteria: []
    }),
    suggestedTask({
      title: 'Review analysis',
      description: 'A model-proposed review task.',
      suggestedAgentKey: 'test',
      acceptanceCriteria: []
    })
  ]);

  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].title, '从架构视角分析当前项目结构与主链路');
  assert.equal(suggestions[0].suggestedAgentKey, 'architect');
  assert.equal(
    suggestions.some((task) => /review|复核|审查|验证/i.test(`${task.title} ${task.description}`)),
    false
  );
});

test('architecture claim fallback does not reassign to requirements after architect has attempted', () => {
  const service = makeService() as unknown as {
    findAlternativeClaimAgent(
      session: SessionDetail,
      task: AgentTask,
      decision: TaskAcceptanceDecisionOutput,
      attemptedAgentIds: Set<string>
    ): Agent | undefined;
  };
  const decision: TaskAcceptanceDecisionOutput = {
    schemaVersion: '1.0',
    kind: 'task_acceptance_decision',
    status: 'blocked',
    reason: 'Need more architecture evidence.',
    missingContext: ['Need src/main.ts and module boundaries.'],
    handoffSuggestion: {
      targetAgentKey: 'requirements',
      targetAgentId: null,
      reason: 'Incorrect model suggestion that should be ignored for architecture ownership.',
      missingContext: [],
      riskLevel: 'medium'
    },
    requestedContext: null,
    confidence: null,
    alternativeAgentKeys: ['requirements', 'test'],
    alternativeAgentIds: [],
    agentMessages: []
  };

  const alternative = service.findAlternativeClaimAgent(
    architectureSession(),
    architectureTask(),
    decision,
    new Set(['architect'])
  );

  assert.equal(alternative, undefined);
});

test('supplemental hydration processes eight existing files and defers the remainder', async () => {
  const service = makeService() as unknown as {
    hydrateSupplementalContext(
      session: SessionDetail,
      request: RuntimeContextRequest
    ): Promise<SupplementalContextResolution>;
  };
  const paths = Array.from({ length: 12 }, (_, index) => `src/file-${index + 1}.ts`);
  const activeSession: SessionDetail = {
    ...architectureSession(),
    workspaceSnapshot: {
      rootName: 'fixture',
      scannedAt: '2026-07-13T00:00:00.000Z',
      fileCount: paths.length,
      totalBytes: paths.length * 20,
      tree: paths.map((path) => ({ path, kind: 'file' as const })),
      files: paths.map((path) => ({ path, size: 20, content: `export const source = '${path}';` })),
      skipped: []
    }
  };

  const resolution = await service.hydrateSupplementalContext(activeSession, {
    reason: 'Need architecture evidence',
    requestedRefs: [],
    requestedPaths: paths
  });

  assert.deepEqual(resolution.hydratedPaths, paths.slice(0, 8));
  assert.deepEqual(resolution.deferredPaths, paths.slice(8));
  assert.deepEqual(resolution.failedPaths, []);
  assert.ok(resolution.contentBytes > 0);
});

test('supplemental hydration reports unavailable browser reads instead of swallowing them', async () => {
  const service = makeService() as unknown as {
    hydrateSupplementalContext(
      session: SessionDetail,
      request: RuntimeContextRequest
    ): Promise<SupplementalContextResolution>;
  };
  const activeSession: SessionDetail = {
    ...architectureSession(),
    workingDirectory: {
      kind: 'browser_local',
      id: 'browser-workspace',
      name: 'fixture',
      selectedAt: '2026-07-13T00:00:00.000Z'
    },
    workspaceSnapshot: undefined
  };

  const resolution = await service.hydrateSupplementalContext(activeSession, {
    reason: 'Need a missing source file',
    requestedRefs: [],
    requestedPaths: ['src/missing.ts']
  });

  assert.deepEqual(resolution.hydratedPaths, []);
  assert.equal(resolution.failedPaths[0]?.code, 'BROKER_OFFLINE');
  assert.equal(resolution.failedPaths[0]?.retryable, true);
});

test('supplemental hydration advances past a failed batch instead of starving later paths', async () => {
  const service = makeService() as unknown as {
    hydrateSupplementalContext(
      session: SessionDetail,
      request: RuntimeContextRequest
    ): Promise<SupplementalContextResolution>;
  };
  const paths = Array.from({ length: 10 }, (_, index) => `src/file-${index + 1}.ts`);
  const activeSession: SessionDetail = {
    ...architectureSession(),
    workspaceSnapshot: {
      rootName: 'fixture',
      scannedAt: '2026-07-13T00:00:00.000Z',
      fileCount: paths.length,
      totalBytes: 20,
      tree: paths.map((path) => ({ path, kind: 'file' as const })),
      files: paths.map((path, index) => ({
        path,
        size: index === 8 ? 20 : 0,
        ...(index === 8 ? { content: 'export const reachable = true;' } : {})
      })),
      skipped: []
    }
  };

  const resolution = await service.hydrateSupplementalContext(activeSession, {
    reason: 'Need one readable path',
    requestedRefs: [],
    requestedPaths: paths
  });

  assert.deepEqual(resolution.hydratedPaths, [paths[8]]);
  assert.equal(resolution.failedPaths.length, 8);
  assert.deepEqual(resolution.deferredPaths, [paths[9]]);
});

test('architecture task waits for an architect instead of reassigning to requirements', async () => {
  const recorder: ServiceRecorder = { events: [], taskUpdates: [], runtimeCalls: 0 };
  const service = makeService([], recorder) as unknown as {
    runOneTask(session: SessionDetail, brief: TaskBrief, task: AgentTask): Promise<{ ok: boolean; message?: string }>;
  };
  const missingArchitectSession: SessionDetail = {
    ...architectureSession(),
    participatingAgentIds: ['coordinator', 'requirements']
  };
  const task: AgentTask = {
    ...architectureTask(),
    assignee: undefined
  };
  const brief: TaskBrief = {
    id: 'brief-architecture',
    sessionId: missingArchitectSession.id,
    version: 1,
    goal: 'Analyze the current project architecture.',
    scope: [],
    outOfScope: [],
    constraints: [],
    acceptanceCriteria: [],
    risks: [],
    openQuestions: [],
    confirmedByUser: true,
    createdAt: '2026-07-03T00:00:00.000Z'
  };

  const outcome = await service.runOneTask(missingArchitectSession, brief, task);

  assert.equal(outcome.ok, false);
  assert.match(outcome.message ?? '', /架构师/);
  assert.equal(task.status, 'waiting');
  assert.equal(task.assignee, undefined);
  assert.equal(recorder.runtimeCalls, 0);
  assert.equal(recorder.events.some((event) => event.type === 'task_waiting'), true);
  assert.equal(recorder.events.some((event) => event.type === 'task_reassigned'), false);
  assert.equal(recorder.events.some((event) => event.toAgentIds.includes('requirements')), false);
});

test('evidence-insufficient blocked execution waits and never emits task_completed', async () => {
  const { recorder, service, activeSession, task, brief } = taskExecutionHarness({
    schemaVersion: '1.0',
    kind: 'task_execution_result',
    status: 'blocked',
    summary: 'Available evidence is insufficient to complete the task.',
    completedItems: [],
    changedArtifacts: [],
    requestedContext: null,
    agentMessages: [],
    nextSuggestedActions: ['Provide the missing source evidence.'],
    risks: ['Completing now would produce an unsupported result.']
  });

  const outcome = await service.runOneTask(activeSession, brief, task);

  assert.equal(outcome.ok, false);
  assert.equal(task.status, 'waiting');
  assert.equal(recorder.events.some((event) => event.type === 'task_waiting'), true);
  assert.equal(recorder.events.some((event) => event.type === 'task_completed'), false);
});

test('task acceptance Runtime failure preserves the structured contract error', async () => {
  const completedOutput = runtimeOutputExamples.task_execution_result;
  const { recorder, service, activeSession, task, brief } = taskExecutionHarness(completedOutput);
  service.runRuntime = async (_session, input) => ({
    invocationId: input.invocationId,
    runtimeType: 'mock',
    status: 'failed',
    output: createAgentMessageOutput({
      messageKind: 'risk',
      content: 'task_acceptance output did not match the contract'
    }),
    events: [],
    artifacts: [],
    systemEvidence: createRuntimeArtifactSystemEvidence(input.invocationId),
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, model: 'mock' },
    error: {
      code: 'RUNTIME_OUTPUT_CONTRACT_VIOLATION',
      message: 'task_acceptance output did not match the contract',
      retryable: false,
      details: { expectedKind: 'task_acceptance_decision' }
    }
  });

  const outcome = await service.runOneTask(activeSession, brief, task);

  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'RUNTIME_OUTPUT_CONTRACT_VIOLATION');
  assert.equal(outcome.retryable, false);
  assert.deepEqual(outcome.error?.details, { expectedKind: 'task_acceptance_decision' });
  assert.equal(task.status, 'failed');
  const runtimeFailed = recorder.events.find((event) => event.type === 'runtime_failed');
  const payload = runtimeFailed?.metadata.payload as { runtimeError?: RuntimeError } | undefined;
  assert.equal(payload?.runtimeError?.code, 'RUNTIME_OUTPUT_CONTRACT_VIOLATION');
  assert.deepEqual(payload?.runtimeError?.details, { expectedKind: 'task_acceptance_decision' });
});

test('infrastructure failure classification adds contract violations without swallowing interactive errors', () => {
  const service = makeService() as unknown as {
    isInfrastructureTaskFailure(result: {
      ok: false;
      message: string;
      error?: RuntimeError;
      code?: RuntimeError['code'];
      retryable?: boolean;
    }): boolean;
  };
  const outcome = (error: RuntimeError) => ({ ok: false as const, message: error.message, error });

  assert.equal(service.isInfrastructureTaskFailure(outcome({
    code: 'RUNTIME_OUTPUT_CONTRACT_VIOLATION', message: 'invalid contract', retryable: false
  })), true);
  assert.equal(service.isInfrastructureTaskFailure(outcome({
    code: 'RUNTIME_INVOCATION_ERROR', message: 'invalid CLI arguments', retryable: false
  })), true);
  assert.equal(service.isInfrastructureTaskFailure(outcome({
    code: 'CAPABILITY_BLOCKED', message: 'capability unavailable', retryable: false
  })), false);
  assert.equal(service.isInfrastructureTaskFailure(outcome({
    code: 'TOKEN_BUDGET_EXCEEDED', message: 'budget exceeded', retryable: false
  })), false);
  assert.equal(service.isInfrastructureTaskFailure(outcome({
    code: 'CONTEXT_INSUFFICIENT', message: 'need context', retryable: false
  })), false);
});

test('needs_review execution completes with an explicit review signal', async () => {
  const { recorder, service, activeSession, task, brief } = taskExecutionHarness({
    schemaVersion: '1.0',
    kind: 'task_execution_result',
    status: 'needs_review',
    summary: 'Implementation is complete and requires focused review.',
    completedItems: ['Implemented the scoped behavior.'],
    changedArtifacts: [],
    requestedContext: null,
    agentMessages: [],
    nextSuggestedActions: ['Review the evidence-sensitive behavior.'],
    risks: ['Review the remaining ambiguity.']
  });

  const outcome = await service.runOneTask(activeSession, brief, task);

  assert.equal(outcome.ok, true);
  assert.equal(task.status, 'completed');
  const completedEvent = recorder.events.find((event) => event.type === 'task_completed');
  assert.ok(completedEvent);
  assert.equal((completedEvent.metadata.payload as Record<string, unknown>).needsReview, true);
  assert.equal(recorder.events.some((event) => event.type === 'task_waiting'), false);
});

test('Post Review evidence gap remains traceable on the ask_user execution outcome', async () => {
  const actions: NonNullable<PostReviewReportOutput['actions']> = [
    {
      action: 'request_workspace_context',
      reason: 'Review needs the implementation source before it can verify completion.',
      missingPaths: ['src/feature.ts']
    }
  ];
  const review: PostReviewReportOutput = {
    schemaVersion: '1.0',
    kind: 'post_review_report',
    isConsistentWithBrief: false,
    matchedItems: [],
    mismatchedItems: [],
    missingItems: ['Missing source evidence for src/feature.ts.'],
    outOfScopeChanges: [],
    testResults: [],
    recommendation: 'ask_user',
    actions
  };
  const service = makeService() as unknown as {
    runPipeline(
      session: SessionDetail,
      brief: TaskBrief,
      tasks: AgentTask[]
    ): Promise<{ kind: string; reason?: string; actions?: PostReviewReportOutput['actions'] }>;
    runPostReview(): Promise<PostReviewReportOutput>;
  };
  service.runPostReview = async () => review;
  const activeSession = { ...session(), status: 'EXECUTING' as const };
  const completedTask: AgentTask = {
    id: 'task-reviewed',
    sessionId: activeSession.id,
    title: 'Implement evidence-sensitive behavior',
    description: 'Implementation task.',
    status: 'completed',
    assignee: { type: 'agent', id: 'backend' },
    dependsOnTaskIds: [],
    acceptanceCriteria: [],
    createdAt: '2026-07-03T00:00:00.000Z',
    updatedAt: '2026-07-03T00:00:00.000Z'
  };
  const brief: TaskBrief = {
    id: 'brief-reviewed',
    sessionId: activeSession.id,
    version: 1,
    goal: 'Complete only with reviewable evidence.',
    scope: [],
    outOfScope: [],
    constraints: [],
    acceptanceCriteria: [],
    risks: [],
    openQuestions: [],
    confirmedByUser: true,
    createdAt: '2026-07-03T00:00:00.000Z'
  };

  const outcome = await service.runPipeline(activeSession, brief, [completedTask]);

  assert.equal(outcome.kind, 'ask_user');
  assert.deepEqual(outcome.actions, actions);
});

test('deliver_with_limitations skips repeated Post Review and enters final delivery', async () => {
  const recorder: ServiceRecorder = { events: [], taskUpdates: [], runtimeCalls: 0 };
  recorder.events.push(
    {
      id: 'event-review-completed',
      sessionId: 'session-1',
      type: 'post_review_completed',
      toAgentIds: [],
      content: 'Review needs a user decision.',
      metadata: { schemaVersion: '0.1' },
      createdAt: '2026-07-11T00:00:00.000Z'
    },
    {
      id: 'event-limited-delivery',
      sessionId: 'session-1',
      type: 'user_confirmation_resolved',
      toAgentIds: [],
      content: 'User selected limited delivery.',
      metadata: {
        schemaVersion: '0.1',
        payload: {
          selectedOptionKey: 'deliver_with_limitations',
          action: {
            action: 'deliver_with_limitations',
            limitations: ['src/feature.ts was not reviewed.']
          }
        }
      },
      createdAt: '2026-07-11T00:01:00.000Z'
    }
  );
  let finalDeliveryLimitations: string[] | undefined;
  const service = makeService([], recorder) as unknown as {
    runPipeline(session: SessionDetail, brief: TaskBrief, tasks: AgentTask[]): Promise<{ kind: string }>;
    runPostReview(): Promise<PostReviewReportOutput>;
    runFinalDelivery(
      session: SessionDetail,
      brief: TaskBrief,
      signal?: AbortSignal,
      limitations?: string[]
    ): Promise<void>;
  };
  service.runPostReview = async () => {
    throw new Error('Post Review must not repeat after limited delivery is selected.');
  };
  service.runFinalDelivery = async (_session, _brief, _signal, limitations) => {
    finalDeliveryLimitations = limitations;
  };
  const activeSession = { ...session(), status: 'EXECUTING' as const };
  const brief: TaskBrief = {
    id: 'brief-limited-delivery',
    sessionId: activeSession.id,
    version: 1,
    goal: 'Deliver with explicit limitations.',
    scope: [],
    outOfScope: [],
    constraints: [],
    acceptanceCriteria: [],
    risks: [],
    openQuestions: [],
    confirmedByUser: true,
    createdAt: '2026-07-03T00:00:00.000Z'
  };

  const outcome = await service.runPipeline(activeSession, brief, []);

  assert.equal(outcome.kind, 'delivered');
  assert.deepEqual(finalDeliveryLimitations, ['src/feature.ts was not reviewed.']);
});

test('execution artifacts keep runtime proposals separate from platform system evidence', () => {
  const service = makeService() as unknown as {
    shouldWriteGeneratedFiles(session: SessionDetail): boolean;
    createExecutionArtifact(
      sessionId: string,
      task: AgentTask,
      agentId: string,
      output: TaskExecutionResultOutput,
      systemEvidence: AgentRunResult['systemEvidence'],
      allowFileChanges: boolean
    ): Artifact;
  };
  const runtimeArtifact: RuntimeArtifactOutput = createRuntimeArtifactOutput({
    type: 'markdown',
    title: 'Unrequested file proposal',
    content: '# Analysis',
    metadata: {
      ...emptyRuntimeArtifactProposalMetadata(),
      fileChanges: [
        {
          path: 'agent-output/unrequested-analysis.md',
          operation: 'create',
          content: '# Analysis',
          previousContent: null,
          encoding: 'utf-8',
          source: 'runtime_proposed_change'
        }
      ]
    }
  });
  const output: TaskExecutionResultOutput = {
    schemaVersion: '1.0',
    kind: 'task_execution_result',
    status: 'completed',
    summary: 'Architecture analysis completed.',
    completedItems: ['Analyzed architecture'],
    changedArtifacts: [runtimeArtifact],
    requestedContext: null,
    agentMessages: [],
    nextSuggestedActions: [],
    risks: []
  };
  const readOnlySession = { ...architectureSession(), requiresCodeChanges: false };

  const readOnlyArtifact = service.createExecutionArtifact(
    readOnlySession.id,
    architectureTask(),
    'architect',
    output,
    createRuntimeArtifactSystemEvidence('read-only-artifact'),
    service.shouldWriteGeneratedFiles(readOnlySession)
  );
  assert.deepEqual(readOnlyArtifact.metadata, { phase: 'task_execution', status: 'completed' });
  assert.deepEqual(readOnlyArtifact.platformProjections, []);
  assert.deepEqual(readOnlyArtifact.runtimeProposals[0]?.metadata.fileChanges, []);

  const explicitWriteSession: SessionDetail = {
    ...readOnlySession,
    originalInput: '分析当前项目架构，并写入 agent-output/project-architecture-analysis.md'
  };
  const writeArtifact = service.createExecutionArtifact(
    explicitWriteSession.id,
    architectureTask(),
    'architect',
    output,
    createRuntimeArtifactSystemEvidence('write-artifact', {
      workspaceChangeSet: {
        id: 'change-set-write-artifact',
        baseRevision: { id: 'revision-1', observedAt: '2026-07-15T00:00:00.000Z' },
        changes: [{
          operation: 'create',
          path: 'agent-output/observed-analysis.md',
          content: '# Observed analysis',
          encoding: 'utf-8'
        }],
        createdAt: '2026-07-15T00:00:00.000Z'
      }
    }),
    service.shouldWriteGeneratedFiles(explicitWriteSession)
  );
  assert.deepEqual(writeArtifact.metadata, { phase: 'task_execution', status: 'completed' });
  assert.deepEqual(writeArtifact.platformProjections, [{
    path: 'agent-output/unrequested-analysis.md',
    operation: 'create',
    encoding: 'utf-8',
    source: 'stage_artifact',
    content: '# Analysis',
    previousContent: null
  }]);
  assert.equal(writeArtifact.runtimeProposals[0]?.metadata.fileChanges.length, 1);
  const observedChange = writeArtifact.systemEvidence?.workspaceChangeSet?.changes[0];
  if (!observedChange || observedChange.operation !== 'create') {
    assert.fail('Expected a platform-observed create change.');
  }
  assert.equal(observedChange.path, 'agent-output/observed-analysis.md');
});

test('architecture final delivery preserves the full runtime report at the canonical report path', () => {
  const fullReport = '# 系统架构说明\n\n## 数据流转\n用户输入 -> Coordinator -> Runtime -> Artifact\n';
  const createdArtifacts: Artifact[] = [
    {
      id: 'artifact-runtime-report',
      dataEpoch: 'epoch-test',
      sessionId: 'session-1',
      agentId: 'architect',
      type: 'json',
      title: '架构分析执行结果',
      contentSummary: '已完成架构分析',
      metadata: {
        phase: 'task_execution'
      },
      runtimeProposals: [createRuntimeArtifactOutput({
        type: 'markdown',
        title: '系统架构说明',
        content: fullReport
      })],
      platformProjections: [],
      systemEvidence: createRuntimeArtifactSystemEvidence('runtime-report'),
      createdAt: '2026-07-13T00:00:00.000Z'
    }
  ];
  const service = makeService(createdArtifacts) as unknown as {
    finalDeliveryFileChanges(session: SessionDetail, brief: TaskBrief, delivery: {
      kind: 'final_delivery';
      summary: string;
      completedItems: string[];
      incompleteItems: string[];
      risks: string[];
      artifactRefs: string[];
    }): Array<{ path: string; content?: string }>;
  };
  const brief: TaskBrief = {
    id: 'brief-architecture-report',
    sessionId: 'session-1',
    version: 1,
    goal: '分析当前项目系统架构和数据流转。',
    scope: [],
    outOfScope: [],
    constraints: [],
    acceptanceCriteria: [],
    risks: [],
    openQuestions: [],
    confirmedByUser: true,
    createdAt: '2026-07-13T00:00:00.000Z'
  };

  const [change] = service.finalDeliveryFileChanges(architectureSession(), brief, {
    kind: 'final_delivery',
    summary: '架构分析完成。',
    completedItems: ['已梳理数据流转。'],
    incompleteItems: [],
    risks: ['外部模型未实测。'],
    artifactRefs: []
  });

  assert.equal(change.path, 'agent-output/project-architecture-analysis.md');
  assert.match(change.content ?? '', /完整|项目架构分析交付说明/);
  assert.match(change.content ?? '', /## 数据流转/);
  assert.match(change.content ?? '', /Coordinator -> Runtime -> Artifact/);
  assert.match(change.content ?? '', /外部模型未实测/);
});

test('local architecture report is written only after the matching user confirmation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-cluster-report-confirm-'));
  try {
    const createdArtifacts: Artifact[] = [
      {
        id: 'artifact-final-report',
        dataEpoch: 'epoch-test',
        sessionId: 'session-1',
        agentId: 'coordinator',
        type: 'markdown',
        title: '完整系统架构说明',
        contentSummary: '完整报告',
        metadata: {
          phase: 'final_delivery',
          report: {
            title: '完整系统架构说明',
            format: 'markdown',
            content: '# 完整系统架构说明\n\n正文\n',
            suggestedPath: 'agent-output/project-architecture-analysis.md',
            requiresUserConfirmation: true
          }
        },
        runtimeProposals: [],
        platformProjections: [],
        systemEvidence: null,
        createdAt: '2026-07-13T00:00:00.000Z'
      }
    ];
    const recorder: ServiceRecorder = { events: [], taskUpdates: [], runtimeCalls: 0 };
    const service = makeService(createdArtifacts, recorder) as unknown as {
      decideLocalReportSave(
        session: SessionDetail,
        input: { confirmationId: string; artifactId: string; decision: 'save_local' }
      ): Promise<{ saved: boolean; path: string }>;
    };
    recorder.events.push({
      id: 'event-confirm-report',
      sessionId: 'session-1',
      type: 'user_confirmation_requested',
      toAgentIds: [],
      content: '请确认是否保存。',
      metadata: createMetadata('confirmation_card', {
        confirmationId: 'confirmation-save-report',
        reason: 'confirm_local_report_save',
        relatedArtifactId: 'artifact-final-report'
      }),
      createdAt: '2026-07-13T00:00:00.000Z'
    });
    const activeSession: SessionDetail = {
      ...architectureSession(),
      workingDirectory: {
        kind: 'server_local',
        id: 'workspace-1',
        name: 'fixture',
        path: root,
        selectedAt: '2026-07-13T00:00:00.000Z'
      }
    };

    const result = await service.decideLocalReportSave(activeSession, {
      confirmationId: 'confirmation-save-report',
      artifactId: 'artifact-final-report',
      decision: 'save_local'
    });

    assert.equal(result.saved, true);
    assert.equal(result.path, 'agent-output/project-architecture-analysis.md');
    assert.equal(
      await readFile(join(root, 'agent-output', 'project-architecture-analysis.md'), 'utf8'),
      '# 完整系统架构说明\n\n正文\n'
    );
    assert.ok(
      recorder.events.some(
        (event) =>
          event.type === 'user_confirmation_resolved' &&
          (event.metadata.payload as { confirmationId?: string }).confirmationId === 'confirmation-save-report'
      )
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('completed historical architecture sessions receive one local-save confirmation and close the old Feishu prompt', () => {
  const createdArtifacts: Artifact[] = [
    {
      id: 'artifact-historical-report',
      dataEpoch: 'epoch-test',
      sessionId: 'session-1',
      agentId: 'architect',
      type: 'json',
      title: '历史架构分析结果',
      contentSummary: '历史完整报告',
      metadata: {
        phase: 'task_execution'
      },
      runtimeProposals: [createRuntimeArtifactOutput({
        type: 'markdown',
        title: '历史系统架构说明',
        content: '# 历史系统架构说明\n\n## 数据流转\nA -> B\n'
      })],
      platformProjections: [],
      systemEvidence: createRuntimeArtifactSystemEvidence('historical-report'),
      createdAt: '2026-07-13T00:00:00.000Z'
    }
  ];
  const recorder: ServiceRecorder = { events: [], taskUpdates: [], runtimeCalls: 0 };
  recorder.events.push(
    {
      id: 'event-final-delivery-old',
      sessionId: 'session-1',
      type: 'final_delivery_created',
      toAgentIds: [],
      content: '最终交付已创建。',
      metadata: createMetadata('delivery_card', {
        summary: '历史架构分析完成。',
        completedItems: [],
        incompleteItems: [],
        risks: [],
        artifactRefs: []
      }),
      createdAt: '2026-07-13T00:01:00.000Z'
    },
    {
      id: 'event-feishu-old',
      sessionId: 'session-1',
      type: 'user_confirmation_requested',
      toAgentIds: [],
      content: '是否发送飞书通知。',
      metadata: createMetadata('confirmation_card', {
        confirmationId: 'confirmation-feishu-old',
        reason: 'confirm_feishu_notification'
      }),
      createdAt: '2026-07-13T00:02:00.000Z'
    }
  );
  const service = makeService(createdArtifacts, recorder) as unknown as {
    ensureArchitectureReportSaveConfirmation(session: SessionDetail): boolean;
  };
  const completedSession: SessionDetail = {
    ...architectureSession(),
    status: 'COMPLETED',
    workingDirectory: {
      kind: 'server_local',
      id: 'workspace-1',
      name: 'fixture',
      path: 'D:/demo/ai-langchain',
      selectedAt: '2026-07-13T00:00:00.000Z'
    }
  };

  assert.equal(service.ensureArchitectureReportSaveConfirmation(completedSession), true);
  assert.equal(service.ensureArchitectureReportSaveConfirmation(completedSession), false);
  assert.equal(
    recorder.events.filter(
      (event) =>
        event.type === 'user_confirmation_requested' &&
        (event.metadata.payload as { reason?: string }).reason === 'confirm_local_report_save'
    ).length,
    1
  );
  assert.ok(
    recorder.events.some(
      (event) =>
        event.type === 'user_confirmation_resolved' &&
        (event.metadata.payload as { confirmationId?: string }).confirmationId === 'confirmation-feishu-old'
    )
  );
});

test('persists non-streaming token estimation drift diagnostics to the session timeline', () => {
  const recorder: ServiceRecorder = { events: [], taskUpdates: [], runtimeCalls: 0 };
  const service = makeService([], recorder) as unknown as {
    recordRuntimeResultDiagnostics(input: InvocationPlan, result: AgentRunResult): void;
  };
  const input = makeInvocationPlan({
    invocationId: 'run-token-drift',
    sessionId: 'session-1',
    taskId: 'task-1',
    agent: { agentId: 'architect' },
    executionTarget: { runtimeType: 'generic_llm' }
  });
  const runtimeResult: AgentRunResult = {
    invocationId: input.invocationId,
    runtimeType: 'generic_llm',
    status: 'completed',
    output: createAgentMessageOutput({
      messageKind: 'summary',
      content: 'Completed with token diagnostics.'
    }),
    events: [
      {
        invocationId: input.invocationId,
        type: 'runtime_progress',
        visibility: 'user',
        content: 'GLM input token estimation drift detected.',
        metadata: {
          code: 'TOKEN_ESTIMATION_DRIFT',
          model: 'glm-test',
          estimated: 100,
          actual: 150,
          ratio: 1.5
        },
        createdAt: '2026-07-11T00:00:00.000Z'
      }
    ],
    artifacts: [],
    systemEvidence: createRuntimeArtifactSystemEvidence(input.invocationId),
    usage: { inputTokens: 150, outputTokens: 10, totalTokens: 160, model: 'glm-test' }
  };

  service.recordRuntimeResultDiagnostics(input, runtimeResult);

  const diagnostic = recorder.events.find(
    (event) => (event.metadata.payload as Record<string, unknown> | undefined)?.code === 'TOKEN_ESTIMATION_DRIFT'
  );
  assert.ok(diagnostic);
  assert.equal(diagnostic.type, 'runtime_progress');
  const payload = diagnostic.metadata.payload as Record<string, unknown>;
  assert.equal(payload.model, 'glm-test');
  assert.equal(payload.estimated, 100);
  assert.equal(payload.actual, 150);
});

test('normalizes a discussion-owned abort as a timeout without leaking the native abort message', () => {
  const service = makeService([], { events: [], taskUpdates: [], runtimeCalls: 0 }) as unknown as {
    normalizeDiscussionTimeoutResult(result: AgentRunResult, agentName: string, timeoutMs: number): AgentRunResult;
  };
  const cancelled: AgentRunResult = {
    invocationId: 'discussion-timeout-run',
    runtimeType: 'codex',
    status: 'cancelled',
    output: createAgentMessageOutput({ messageKind: 'risk', content: 'The operation was aborted' }),
    events: [],
    artifacts: [],
    systemEvidence: createRuntimeArtifactSystemEvidence('discussion-timeout-run'),
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, model: 'codex' },
    error: { code: 'RUNTIME_CANCELLED', message: 'The operation was aborted', retryable: false }
  };

  const result = service.normalizeDiscussionTimeoutResult(cancelled, 'Frontend engineer', 60_000);

  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'RUNTIME_TIMEOUT');
  assert.equal(result.error?.retryable, true);
  assert.equal(result.error?.message, '当前阶段执行超时，已停止本次调用（60000ms）。');
  assert.equal(result.termination?.kind, 'phase_timeout');
  assert.equal(result.error?.termination?.terminationId, result.termination?.terminationId);
  assert.deepEqual(result.error?.details?.timeout, { mode: 'deadline', timeoutMs: 60_000 });
});
