import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  Agent,
  AgentRunInput,
  AgentRunResult,
  AgentTask,
  Artifact,
  CollaborationEvent,
  PostReviewReportOutput,
  RuntimeArtifactOutput,
  SessionDetail,
  TaskBrief,
  TaskAcceptanceDecisionOutput,
  TaskBriefOutput,
  TaskExecutionResultOutput
} from '@agent-cluster/shared';
import {
  estimateRuntimeInputTokens,
  fitContextToBudget,
  reserveInputTokenSafetyMargin
} from '../../common/token.js';
import { OrchestratorService } from './orchestrator.service.js';

function agent(key: string): Agent {
  return {
    id: key,
    key,
    name: `${key} agent`,
    role: key,
    runtimeType: 'mock',
    status: 'active',
    capabilityIds: [],
    defaultKnowledgeBaseIds: [],
    createdAt: '2026-07-03T00:00:00.000Z',
    updatedAt: '2026-07-03T00:00:00.000Z'
  };
}

type ServiceRecorder = {
  events: CollaborationEvent[];
  taskUpdates: Array<Partial<AgentTask>>;
  runtimeCalls: number;
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
      start(input: AgentRunInput) {
        if (recorder) recorder.runtimeCalls += 1;
        const result: AgentRunResult = {
          runId: input.runId,
          runtimeType: input.agent.runtimeType,
          status: 'completed',
          output: {
            kind: 'agent_message',
            messageKind: 'answer',
            content: 'Completed without source evidence.'
          },
          events: [],
          artifacts: [],
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
      create(input: Omit<Artifact, 'id' | 'createdAt'>) {
        const artifact: Artifact = {
          id: `artifact-${createdArtifacts.length + 1}`,
          createdAt: '2026-07-03T00:00:00.000Z',
          ...input,
          metadata: input.metadata ?? {}
        };
        createdArtifacts.push(artifact);
        return artifact;
      },
      listBySession() {
        return createdArtifacts;
      }
    } as never,
    {} as never,
    {} as never,
    {
      getCollection<T>(_key: string, fallback: T) {
        return fallback;
      },
      setCollection() {}
    } as never,
    {} as never,
    {} as never,
    {} as never
  );
}

function session(): SessionDetail {
  return {
    id: 'session-1',
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

test('normalizes malformed runtime suggested tasks before selection', () => {
  const service = makeService() as unknown as {
    normalizeTaskBriefOutput(output: TaskBriefOutput): TaskBriefOutput;
    selectSuggestedTasks(session: SessionDetail, runtimeSuggestedTasks: TaskBriefOutput['suggestedTasks']): TaskBriefOutput['suggestedTasks'];
  };
  const output = service.normalizeTaskBriefOutput({
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
  } as unknown as TaskBriefOutput);

  assert.equal(output.suggestedTasks.length, 2);
  assert.equal(output.suggestedTasks[0].description, 'Implement crash fix');
  assert.deepEqual(output.suggestedTasks[1].acceptanceCriteria, []);
  assert.doesNotThrow(() => service.selectSuggestedTasks(session(), output.suggestedTasks));
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
    assigneeAgentId: 'architect',
    dependsOnTaskIds: [],
    acceptanceCriteria: ['Architecture analysis is grounded in workspace evidence.'],
    createdAt: '2026-07-03T00:00:00.000Z',
    updatedAt: '2026-07-03T00:00:00.000Z'
  };
}

type TaskExecutionTestService = {
  runOneTask(session: SessionDetail, brief: TaskBrief, task: AgentTask): Promise<{ ok: boolean; message?: string }>;
  createContextPack(): AgentRunInput['contextPack'];
  runRuntime(session: SessionDetail, input: AgentRunInput): Promise<AgentRunResult>;
  emitTaskHandoff(): void;
  createSummaryMemoryCheckpoint(): void;
};

function taskExecutionHarness(output: TaskExecutionResultOutput) {
  const recorder: ServiceRecorder = { events: [], taskUpdates: [], runtimeCalls: 0 };
  const service = makeService([], recorder) as unknown as TaskExecutionTestService;
  service.createContextPack = () =>
    ({
      relevantMemories: [],
      budget: { maxInputTokens: 1_000, maxOutputTokens: 200, maxTotalTokens: 1_200 }
    }) as unknown as AgentRunInput['contextPack'];
  service.runRuntime = async (_session, input) => ({
    runId: input.runId,
    runtimeType: input.agent.runtimeType,
    status: 'completed',
    output:
      input.phase === 'task_acceptance'
        ? {
            kind: 'task_acceptance_decision',
            status: 'accepted',
            reason: 'Backend agent accepts the task.'
          }
        : output,
    events: [],
    artifacts: [],
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
    assigneeAgentId: 'backend',
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
    {
      title: 'Generic analysis',
      description: 'A model-proposed generic analysis task.',
      suggestedAgentKey: 'requirements',
      acceptanceCriteria: []
    },
    {
      title: 'Review analysis',
      description: 'A model-proposed review task.',
      suggestedAgentKey: 'test',
      acceptanceCriteria: []
    }
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
    kind: 'task_acceptance_decision',
    status: 'blocked',
    reason: 'Need more architecture evidence.',
    missingContext: ['Need src/main.ts and module boundaries.'],
    handoffSuggestion: {
      targetAgentKey: 'requirements',
      reason: 'Incorrect model suggestion that should be ignored for architecture ownership.',
      riskLevel: 'medium'
    },
    alternativeAgentKeys: ['requirements', 'test']
  };

  const alternative = service.findAlternativeClaimAgent(
    architectureSession(),
    architectureTask(),
    decision,
    new Set(['architect'])
  );

  assert.equal(alternative, undefined);
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
    assigneeAgentId: undefined,
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
  assert.equal(task.assigneeAgentId, undefined);
  assert.equal(recorder.runtimeCalls, 0);
  assert.equal(recorder.events.some((event) => event.type === 'task_waiting'), true);
  assert.equal(recorder.events.some((event) => event.type === 'task_reassigned'), false);
  assert.equal(recorder.events.some((event) => event.toAgentIds.includes('requirements')), false);
});

test('evidence-insufficient blocked execution waits and never emits task_completed', async () => {
  const { recorder, service, activeSession, task, brief } = taskExecutionHarness({
    kind: 'task_execution_result',
    status: 'blocked',
    summary: 'Available evidence is insufficient to complete the task.',
    completedItems: [],
    changedArtifacts: [],
    nextSuggestedActions: ['Provide the missing source evidence.'],
    risks: ['Completing now would produce an unsupported result.']
  });

  const outcome = await service.runOneTask(activeSession, brief, task);

  assert.equal(outcome.ok, false);
  assert.equal(task.status, 'waiting');
  assert.equal(recorder.events.some((event) => event.type === 'task_waiting'), true);
  assert.equal(recorder.events.some((event) => event.type === 'task_completed'), false);
});

test('needs_review execution completes with an explicit review signal', async () => {
  const { recorder, service, activeSession, task, brief } = taskExecutionHarness({
    kind: 'task_execution_result',
    status: 'needs_review',
    summary: 'Implementation is complete and requires focused review.',
    completedItems: ['Implemented the scoped behavior.'],
    changedArtifacts: [],
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
    assigneeAgentId: 'backend',
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

test('navigation_only analysis returns CONTEXT_INSUFFICIENT before Runtime can complete', async () => {
  const recorder: ServiceRecorder = { events: [], taskUpdates: [], runtimeCalls: 0 };
  const service = makeService([], recorder) as unknown as {
    runRuntime(session: SessionDetail, input: AgentRunInput): Promise<AgentRunResult>;
    runtimeInputEstimateParts(input: AgentRunInput): {
      systemPrompt?: string;
      outputSchema?: unknown;
      outputExample?: unknown;
      additionalPromptText?: string[];
    };
  };
  const baseContextPack = {
    systemRules: ['Ground conclusions in source evidence.'],
    sessionGoal: 'Analyze the current project architecture.',
    taskContext: {
      domain: 'mixed',
      intent: 'analysis',
      currentStage: 'task_execution',
      taskMap: { kind: 'project_map', summary: 'Project map', items: [] },
      stagePlan: { phase: 'task_execution', read: [], do: [], validate: [] },
      executionMode: 'single_agent',
      validationMode: 'human_review',
      requiresCodeChanges: false,
      requiresExternalEvidence: false,
      validationRules: [],
      agentResponsibilities: [],
      evidenceSelection: {
        phase: 'task_execution',
        strategy: 'architecture_analysis',
        query: 'architecture',
        maxEvidenceRefs: 1,
        selectedCount: 1,
        omittedCount: 0,
        selectedTypes: ['workspace_file'],
        omittedTypes: [],
        selectedRefs: [{ type: 'workspace_file', label: 'src/main.ts', ref: 'src/main.ts' }],
        omittedRefs: [],
        rules: []
      },
      evidenceRefs: [{ type: 'workspace_file', label: 'src/main.ts', ref: 'src/main.ts' }]
    },
    summaryMemory: {
      goal: 'Analyze architecture',
      currentState: 'Need source evidence',
      confirmedFacts: [],
      completed: [],
      decisions: [],
      openQuestions: [],
      risks: [],
      nextSteps: []
    },
    continuationState: {
      phase: 'task_execution',
      sessionStatus: 'EXECUTING',
      pendingTaskIds: [],
      runningTaskIds: [],
      completedTaskIds: [],
      blockedTaskIds: [],
      nextAgentKeys: [],
      handoffRefs: [],
      sourceEventIds: [],
      sourceArtifactIds: [],
      resumeHints: []
    },
    agentProfile: {
      id: 'architect',
      key: 'architect',
      name: 'Architect',
      role: 'architect',
      systemPrompt: 'x'.repeat(2_000),
      runtimeType: 'mock',
      capabilityIds: []
    },
    workspaceManifest: {
      rootName: 'demo',
      fileCount: 1,
      readableFileCount: 0,
      skippedFileCount: 0,
      tree: [],
      files: [],
      entrypoints: ['src/main.ts']
    },
    workspaceFocus: {
      relevantFiles: ['src/main.ts'],
      impactedFiles: [],
      testFiles: [],
      configFiles: [],
      possibleEntryPoints: ['src/main.ts'],
      detectedStack: ['typescript'],
      validationCommands: [],
      rationale: 'Navigation only fixture'
    },
    selectedEvidenceContents: [],
    relevantEvents: [],
    relevantMemories: [],
    ragSnippets: [],
    artifacts: [],
    capabilities: [],
    constraints: [],
    budget: { maxInputTokens: 1, maxOutputTokens: 32, maxTotalTokens: 64 }
  } as unknown as AgentRunInput['contextPack'];
  const measured = fitContextToBudget(baseContextPack);
  const navigationTokens = measured.diagnostics.stages.find((stage) => stage.name === 'navigation_only')?.estimatedTokens;
  assert.ok(navigationTokens, 'fixture must reach navigation_only');
  const navigationBudget = navigationTokens + 16;
  const provisionalInput: AgentRunInput = {
    runId: 'run-navigation-only',
    sessionId: 'session-architecture',
    taskId: 'task-architecture',
    phase: 'task_execution',
    agent: baseContextPack.agentProfile,
    contextPack: baseContextPack,
    expectedOutput: { kind: 'task_execution_result', schemaVersion: '0.1' },
    budget: baseContextPack.budget
  };
  const fixedEstimate = estimateRuntimeInputTokens({
    contextPack: { ...baseContextPack, budget: { ...baseContextPack.budget, maxInputTokens: 0 } },
    ...service.runtimeInputEstimateParts(provisionalInput)
  });
  const fixedInputTokens = fixedEstimate.totalTokens - fixedEstimate.contextTokens;
  const requiredEffectiveInputBudget = fixedInputTokens + navigationBudget;
  const totalInputBudget = Math.ceil(requiredEffectiveInputBudget / 0.9);
  const effectiveInputBudget = reserveInputTokenSafetyMargin(totalInputBudget, 0.1).effectiveMaxInputTokens;
  assert.ok(effectiveInputBudget && effectiveInputBudget >= requiredEffectiveInputBudget);
  const contextPack = {
    ...baseContextPack,
    budget: { maxInputTokens: totalInputBudget, maxOutputTokens: 32, maxTotalTokens: totalInputBudget + 32 }
  };
  const fitted = fitContextToBudget({
    ...contextPack,
    budget: { ...contextPack.budget, maxInputTokens: effectiveInputBudget - fixedInputTokens }
  });
  assert.equal(fitted.diagnostics.finalStage, 'navigation_only');
  assert.ok(fitted.estimatedTokens <= navigationBudget);
  const input: AgentRunInput = {
    ...provisionalInput,
    agent: contextPack.agentProfile,
    contextPack,
    budget: contextPack.budget
  };

  const result = await service.runRuntime(architectureSession(), input);

  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'CONTEXT_INSUFFICIENT');
  assert.deepEqual(result.error?.requestedContext?.requestedPaths, ['src/main.ts']);
  assert.equal(recorder.runtimeCalls, 0);
});

test('analysis execution artifacts suppress fileChanges unless the user explicitly requests a file', () => {
  const service = makeService() as unknown as {
    shouldWriteGeneratedFiles(session: SessionDetail): boolean;
    createExecutionArtifact(
      sessionId: string,
      task: AgentTask,
      agentId: string,
      output: TaskExecutionResultOutput,
      runtimeArtifacts: RuntimeArtifactOutput[],
      allowFileChanges: boolean
    ): Artifact;
  };
  const runtimeArtifact: RuntimeArtifactOutput = {
    type: 'markdown',
    title: 'Unrequested file proposal',
    content: '# Analysis',
    metadata: {
      fileChanges: [
        {
          path: 'agent-output/unrequested-analysis.md',
          operation: 'create',
          content: '# Analysis'
        }
      ]
    }
  };
  const output: TaskExecutionResultOutput = {
    kind: 'task_execution_result',
    status: 'completed',
    summary: 'Architecture analysis completed.',
    completedItems: ['Analyzed architecture'],
    changedArtifacts: [runtimeArtifact],
    nextSuggestedActions: [],
    risks: []
  };
  const readOnlySession = { ...architectureSession(), requiresCodeChanges: false };

  const readOnlyArtifact = service.createExecutionArtifact(
    readOnlySession.id,
    architectureTask(),
    'architect',
    output,
    [],
    service.shouldWriteGeneratedFiles(readOnlySession)
  );
  assert.deepEqual(readOnlyArtifact.metadata.fileChanges, []);
  const storedReadOnlyOutput = readOnlyArtifact.metadata.output as TaskExecutionResultOutput;
  assert.deepEqual(storedReadOnlyOutput.changedArtifacts[0]?.metadata?.fileChanges, []);

  const explicitWriteSession: SessionDetail = {
    ...readOnlySession,
    originalInput: '分析当前项目架构，并写入 agent-output/project-architecture-analysis.md'
  };
  const writeArtifact = service.createExecutionArtifact(
    explicitWriteSession.id,
    architectureTask(),
    'architect',
    output,
    [],
    service.shouldWriteGeneratedFiles(explicitWriteSession)
  );
  assert.equal((writeArtifact.metadata.fileChanges as unknown[]).length, 1);
});

test('persists non-streaming token estimation drift diagnostics to the session timeline', () => {
  const recorder: ServiceRecorder = { events: [], taskUpdates: [], runtimeCalls: 0 };
  const service = makeService([], recorder) as unknown as {
    recordRuntimeResultDiagnostics(input: AgentRunInput, result: AgentRunResult): void;
  };
  const input = {
    runId: 'run-token-drift',
    sessionId: 'session-1',
    taskId: 'task-1',
    agent: { id: 'architect' }
  } as AgentRunInput;
  const runtimeResult: AgentRunResult = {
    runId: input.runId,
    runtimeType: 'generic_llm',
    status: 'completed',
    output: {
      kind: 'agent_message',
      messageKind: 'summary',
      content: 'Completed with token diagnostics.'
    },
    events: [
      {
        runId: input.runId,
        type: 'runtime_progress',
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

import { buildResumeOptions } from './build-resume-options.js';

test('M4-03: task_execution 阶段 + prior invocation → resume 存在', () => {
  const options = buildResumeOptions('task_execution', { cliSessionId: 'cli-123', workDir: '/prior' });
  assert.deepEqual(options?.resume, { cliSessionId: 'cli-123', workDir: '/prior' });
});

test('M4-03: task_execution 阶段 + 无 prior → resume undefined', () => {
  const options = buildResumeOptions('task_execution', undefined);
  assert.equal(options, undefined);
});

test('M4-03: 非 task_execution 阶段（brief_generation） → resume undefined', () => {
  const options = buildResumeOptions('brief_generation', { cliSessionId: 'cli-999', workDir: '/fake' });
  assert.equal(options, undefined);
});
