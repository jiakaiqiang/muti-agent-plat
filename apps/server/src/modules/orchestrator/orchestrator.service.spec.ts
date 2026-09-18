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
  FileRevisionCandidateOutput,
  FileRevisionRun,
  InvocationPlan,
  PostReviewReportOutput,
  RuntimeArtifactOutput,
  RuntimeContextRequest,
  RuntimeError,
  SessionDetail,
  SupplementalContextResolution,
  TaskBrief,
  TaskContext,
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
import { createExecutionTermination } from '../../common/execution-termination.js';
import { workspaceMetrics } from '../../common/workspace-metrics.js';
import {
  artifactCreatedEventPayload,
  effectiveStructuredOutputLimit,
  type ExecutionOutcome,
  OrchestratorService,
  usableAgentMessageOutput
} from './orchestrator.service.js';
import { makeInvocationPlan } from '../runtimes/invocation-plan.fixture.js';
import { agent, makeService, session, type ServiceRecorder } from './orchestrator.test-fixtures.js';
import { InvocationResolutionError } from '../runtime-routing/invocation-resolver.service.js';

test('task retries reuse acceptance but recheck permissions and changed scope before execution', async () => {
  const recorder: ServiceRecorder = { events: [], taskUpdates: [], runtimeCalls: 0 };
  const service = makeService([], recorder) as any;
  const activeSession = { ...session(), workspaceMode: 'bootstrap', status: 'EXECUTING' };
  const task = { id: 'explicit-task', sessionId: activeSession.id, workflowNodeRunId: 'node-1',
    title: 'Implementation', description: 'Implement the approved scope', status: 'assigned',
    assignee: { type: 'agent', id: 'backend' }, acceptanceCriteria: ['Check changes'], dependsOnTaskIds: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as AgentTask;
  let permitted = true;
  let resolutions = 0;
  service.invocationWorkspace = () => ({});
  service.createContextAssembly = () => ({ taskContext: { intent: 'implementation', requiresCodeChanges: true },
    systemRules: [], budget: { maxInputTokens: 1000, maxOutputTokens: 800, maxTotalTokens: 1800 } });
  service.invocationResolver = { resolve() {
    resolutions++;
    if (!permitted) throw new InvocationResolutionError('CAPABILITY_BLOCKED', 'workspace permission revoked');
    return makeInvocationPlan({ agent: { agentId: 'backend' } });
  } };
  service.taskDependencyArtifacts = () => [];
  service.runRuntime = () => { throw new Error('explicit workflow acceptance must not call a model'); };
  const claim = () => service.resolveTaskClaim(activeSession, {}, task, agent('backend'), agent('coordinator'), undefined, new Set());
  const first = await claim();
  assert.equal(first.ok, true);
  task.status = 'running';
  task.updatedAt = new Date().toISOString();
  const retry = await claim();
  assert.equal(retry.invocationId, first.invocationId);
  assert.equal(resolutions, 2, 'reuse must still recheck current capabilities');
  task.description = 'Revised implementation scope';
  const revised = await claim();
  assert.notEqual(revised.invocationId, first.invocationId);
  permitted = false;
  const revoked = await claim();
  assert.equal(revoked.ok, false);
  assert.equal(revoked.error.code, 'CAPABILITY_BLOCKED');
  assert.equal(task.acceptanceCheckpoint?.decisionSource, 'rule');
});

test('recovery with a failed submission never replays development when safe repair is unavailable or exhausted', async () => {
  for (const runtimeType of ['claude_code', 'codex'] as const) {
    const recorder: ServiceRecorder = { events: [], taskUpdates: [], runtimeCalls: 0 };
    const service = makeService([], recorder) as any;
    const activeSession = { ...session(), workspaceMode: 'bootstrap', status: 'EXECUTING' };
    const candidate = { id: 'saved-candidate', schemaErrors: ['blockers missing'], originalSubmission: { summary: 'done' }, outputVersion: '2.0' };
    service.refreshWorkspaceIndex = async () => {};
    service.invocationWorkspace = () => ({});
    service.invocationResolver = { resolve: () => makeInvocationPlan({ executionTarget: { runtimeType } }) };
    service.tasks.find = () => ({ recoveryOriginTaskId: 'prior-task' });
    service.runtime.findExecutionCandidate = () => candidate;
    service.runtime.operations = { reserveCorrection: async () => false };
    service.runtime.start = () => { throw new Error('must not launch development'); };
    const result = await service.runRuntimeAttempt(activeSession, {
      invocationId: 'recovery', sessionId: activeSession.id, taskId: 'task', phase: 'task_execution',
      agent: agent('backend'), contextAssembly: { taskContext: { intent: 'implementation', requiresCodeChanges: true } },
      operation: { id: 'operation' }, expectedOutput: { kind: 'task_execution_result', schemaVersion: '2.0' }, budget: {}
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.error.details.operationFailure, 'OPERATION_SUBMISSION_REPAIR_BLOCKED');
    assert.equal(result.executionCandidate.id, candidate.id);
    assert.equal(recorder.runtimeCalls, 0);
    assert.equal(recorder.events.some(event => event.metadata?.payload?.code === 'SUBMISSION_REPAIR_STARTED'), false);
  }
});

test('runtime results cannot enter orchestrator post-processing after Session admission closes', async () => {
  const recorder: ServiceRecorder = { events: [], taskUpdates: [], runtimeCalls: 0 };
  const service = makeService([], recorder) as any;
  service.lifecycle = { isActive: () => false };
  service.runRuntimeProviderAttempts = async () => ({
    invocationId: 'late-invocation', runtimeType: 'mock', status: 'completed',
    output: createAgentMessageOutput({ messageKind: 'answer', content: 'late output' }),
    events: [], artifacts: [], systemEvidence: createRuntimeArtifactSystemEvidence('late-invocation'),
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, model: 'mock' }
  });

  await assert.rejects(
    service.runRuntime(session(), {
      invocationId: 'late-invocation', sessionId: 'session-1', phase: 'discussion',
      agent: agent('coordinator'), contextAssembly: { taskContext: {} },
      expectedOutput: { kind: 'agent_message', schemaVersion: '1.0' }, budget: {},
      operation: {
        id: 'late-operation', deadlineAt: '2026-09-16T00:00:00.000Z',
        policyVersion: 'execution-reliability-v1', maxAttempts: 3, sessionGeneration: 1
      }
    }),
    /SESSION_ADMISSION_CLOSED/
  );
  assert.equal(recorder.events.length, 0);
  assert.equal(recorder.taskUpdates.length, 0);
});

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

test('discussion output guard rejects missing or blank agent message content', () => {
  assert.equal(usableAgentMessageOutput({ kind: 'agent_message', messageKind: 'summary' }), false);
  assert.equal(usableAgentMessageOutput({ kind: 'agent_message', messageKind: 'summary', content: '   ' }), false);
  assert.equal(usableAgentMessageOutput({ kind: 'agent_message', messageKind: 'summary', content: 'done' }), true);
});

test('runtime orchestration checks the long-conversation checkpoint threshold before provider dispatch', async () => {
  const service = makeService() as any;
  const triggers: string[] = [];
  service.createSummaryMemoryCheckpoint = async (...args: unknown[]) => {
    triggers.push(String(args[5]));
  };
  service.runRuntimeProviderAttempts = async (_activeSession: SessionDetail, input: { invocationId: string }) => ({
    invocationId: input.invocationId,
    runtimeType: 'mock',
    status: 'completed',
    output: createAgentMessageOutput({ messageKind: 'summary', content: 'completed' }),
    events: [],
    artifacts: [],
    systemEvidence: createRuntimeArtifactSystemEvidence(input.invocationId),
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, model: 'mock' }
  });

  await service.runRuntime(
    { ...session(), activeWorkItemId: 'work-1' },
    {
      invocationId: 'threshold-invocation',
      sessionId: 'session-1',
      phase: 'discussion',
      agent: agent('coordinator'),
      contextAssembly: { workItemId: 'work-1', sessionGoal: 'Continue the requirement.' },
      expectedOutput: { kind: 'agent_message', schemaVersion: '1.0' },
      budget: {}
    }
  );

  assert.deepEqual(triggers, ['budget_threshold']);
});

test('context rebuilding reads the durable checkpoint when its artifact projection is missing', () => {
  const service = makeService() as any;
  service.summaryCheckpoints = {
    latest() {
      return {
        checkpointId: 'checkpoint-durable-only',
        sessionId: 'session-1',
        workItemId: 'work-1',
        logicalKey: 'work-1|seq:24|wi:1|dl:0|summary-checkpoint-v2',
        coveredEventSeq: 24,
        workItemRevision: 1,
        decisionLedgerRevision: 0,
        policyVersion: 'summary-checkpoint-v2',
        contentHash: 'durable-content-hash',
        phase: 'task_execution',
        summaryMemory: {
          goal: 'Durable requirement',
          currentState: 'EXECUTING / task_execution',
          confirmedFacts: ['DURABLE_CHECKPOINT_FACT'],
          completed: ['already-written-file.ts'],
          decisions: [],
          openQuestions: [],
          risks: [],
          nextSteps: ['Continue validation']
        },
        sourceEventIds: ['event-24'],
        sourceArtifactIds: [],
        sourceMemoryIds: [],
        sourceDecisionIds: [],
        createdAt: '2026-09-17T00:00:00.000Z'
      };
    }
  };
  const activeSession = { ...session(), activeWorkItemId: 'work-1' };
  const contextSlice = {
    workItem: {
      id: 'work-1', sessionId: activeSession.id, title: 'Durable requirement', goal: 'Durable requirement',
      status: 'OPEN', revision: 1, inheritedDecisionIds: [], inheritedArtifactIds: [],
      createdAt: activeSession.createdAt, updatedAt: activeSession.updatedAt
    },
    decisions: [], tasks: [], events: [], memories: [], artifacts: [],
    inheritedDecisionIds: [], inheritedArtifactIds: []
  };

  const latest = service.latestSummaryMemoryCheckpoint(activeSession.id, 'work-1');
  const rebuilt = service.createSummaryMemory(activeSession, undefined, undefined, 'discussion', contextSlice);

  assert.equal(latest?.checkpoint.checkpointId, 'checkpoint-durable-only');
  assert.equal(latest?.artifact, undefined, 'an artifact is only a display projection, not the durable read source');
  assert.ok(rebuilt.confirmedFacts.includes('DURABLE_CHECKPOINT_FACT'));
  assert.ok(rebuilt.completed.includes('already-written-file.ts'));
});

test('a checkpoint keeps superseded decision and event sources without restoring old event prose into current context', async () => {
  const service = makeService() as any;
  const current = {
    id: 'decision-current', sessionId: 'session-1', workItemId: 'work-1', kind: 'constraint',
    status: 'confirmed', content: '只允许 Excel', sourceEventId: 'event-current', revision: 1,
    createdAt: '2026-09-17T00:00:00.000Z', updatedAt: '2026-09-17T00:00:00.000Z'
  };
  const superseded = {
    ...current, id: 'decision-old', status: 'superseded', content: '允许 CSV', sourceEventId: 'event-old'
  };
  const activeSession = { ...session(), activeWorkItemId: 'work-1', decisionLedgerRevision: 2 };
  service.createWorkItemContextSlice = () => ({
    workItem: {
      id: 'work-1', sessionId: activeSession.id, title: '导出', goal: '导出 Excel', status: 'OPEN',
      revision: 2, inheritedDecisionIds: [], inheritedArtifactIds: [],
      createdAt: activeSession.createdAt, updatedAt: activeSession.updatedAt
    },
    decisions: [current], tasks: [], events: [{
      id: 'event-old-brief', sessionId: activeSession.id, workItemId: 'work-1', type: 'brief_created',
      content: '旧版需求允许 CSV', actor: { type: 'system', id: 'system' }, toAgentIds: [],
      metadata: { schemaVersion: '0.1', payload: {} }, createdAt: '2026-09-17T00:00:00.000Z'
    }], memories: [], artifacts: [],
    inheritedDecisionIds: [], inheritedArtifactIds: []
  });
  service.contextManagement = { listDecisions: () => [superseded, current] };
  let sourceDecisionIds: string[] = [];
  let sourceEventIds: string[] = [];
  let summary: { decisions: string[] } | undefined;
  service.summaryCheckpoints = {
    latest() {
      return undefined;
    },
    async checkpoint(request: { snapshot: { sourceDecisionIds: string[]; sourceEventIds: string[] }; generate(): { decisions: string[] } }) {
      sourceDecisionIds = request.snapshot.sourceDecisionIds;
      sourceEventIds = request.snapshot.sourceEventIds;
      summary = request.generate();
      return { status: 'skipped', reason: 'already_covered' };
    }
  };

  await service.createSummaryMemoryCheckpoint(
    activeSession, agent('coordinator'), 'task_execution', undefined, undefined, 'phase_end'
  );

  assert.deepEqual(sourceDecisionIds.sort(), ['decision-current', 'decision-old']);
  assert.deepEqual(sourceEventIds, ['event-old-brief']);
  assert.deepEqual(summary?.decisions, ['[decision-current] 只允许 Excel']);
  assert.equal(JSON.stringify(summary).includes('允许 CSV'), false);
});

test('file revision artifact events never inline proposal or system evidence content', () => {
  const payload = artifactCreatedEventPayload({
    id: 'artifact-revision-secret',
    type: 'code_change',
    title: 'Revision proposal',
    contentSummary: 'Proposal generated.',
    runtimeProposals: [{
      kind: 'artifact',
      title: 'Secret proposal',
      content: 'USER_DRAFT_SECRET',
      format: 'markdown',
      metadata: { fileChanges: [] }
    }],
    platformProjections: [],
    systemEvidence: {
      source: 'platform',
      invocationId: 'invocation-secret',
      workspaceChangeSet: {
        id: 'change-secret',
        changes: [{ operation: 'update', path: 'result.md', content: 'CANDIDATE_SECRET' }]
      }
    }
  } as unknown as Artifact, undefined, true);

  const serialized = JSON.stringify(payload);
  assert.equal('proposalOnly' in payload && payload.proposalOnly, true);
  assert.equal('runtimeProposals' in payload, false);
  assert.equal('systemEvidence' in payload, false);
  assert.doesNotMatch(serialized, /USER_DRAFT_SECRET|CANDIDATE_SECRET/);
});

test('file revision output preflight uses the lower of Session budget and Runtime capacity', () => {
  assert.equal(effectiveStructuredOutputLimit(40_000, 4_096), 4_096);
  assert.equal(effectiveStructuredOutputLimit(2_000, 4_096), 2_000);
  assert.equal(effectiveStructuredOutputLimit(undefined, 1_024), 1_024);
});

test('file revision processing fails closed when the system default Receiver is unavailable', async () => {
  const service = makeService(
    [],
    { events: [], taskUpdates: [], runtimeCalls: 0 },
    { markProcessing: async () => { throw new Error('markProcessing must not run without Receiver'); } },
    undefined,
    ['backend', 'test']
  ) as unknown as {
    processFileRevision(session: SessionDetail, revisionId: string): Promise<FileRevisionRun>;
  };

  await assert.rejects(
    service.processFileRevision(session(), 'revision-without-receiver'),
    /REVISION_RECEIVER_UNAVAILABLE/
  );
});

test('file revision processing uses one Receiver for single/multi Agent and fails closed on partial Agent failure', async () => {
  workspaceMetrics.resetForTests();
  for (const scenario of [
    { targetAgentIds: ['backend', 'test'], failedAgentId: undefined },
    { targetAgentIds: ['backend'], failedAgentId: undefined },
    { targetAgentIds: ['backend', 'test'], failedAgentId: 'test' }
  ]) {
  const createdTasks: AgentTask[] = [];
  const recorder: ServiceRecorder = { events: [], createdTasks, taskUpdates: [], runtimeCalls: 0 };
  const run = {
    id: 'revision-1',
    chainId: 'chain-1',
    iteration: 1,
    sessionId: 'session-1',
    filePath: 'result.md',
    status: 'submitted',
    userDraftHash: { algorithm: 'sha256', value: 'draft-hash' },
    contextSnapshotHash: 'evidence-hash',
    targetAgentIds: scenario.targetAgentIds,
    instruction: 'Preserve the user-approved terminology.',
    agentResults: [],
    diffSummary: { addedLines: 1, removedLines: 1, unchangedLines: 2, hunkCount: 1 }
  } as unknown as FileRevisionRun;
  let maxConcurrentAgents = 0;
  let concurrentAgents = 0;
  const fileRevisions = {
    getRun() {
      return run;
    },
    async markProcessing() {
      run.status = 'processing';
      return run;
    },
    async recordAgentResult(_sessionId: string, _revisionId: string, result: FileRevisionRun['agentResults'][number]) {
      run.agentResults.push(result);
      return run;
    },
    storeProposedContent(_content: string, filePath: string) {
      return `content:${filePath}:${run.agentResults.length}`;
    },
    async markSynthesizing() {
      run.status = 'synthesizing';
      return run;
    },
    async markAwaitingConfirmation(
      _sessionId: string,
      _revisionId: string,
      input: { confirmationId: string; synthesisTaskId: string }
    ) {
      run.status = 'awaiting_confirmation';
      run.confirmationId = input.confirmationId;
      run.synthesisTaskId = input.synthesisTaskId;
      run.candidateChangeSetId = 'candidate-1';
      run.candidateHash = { algorithm: 'sha256', value: 'candidate-hash' };
      return run;
    },
    getChain() {
      return { id: 'chain-1', stateVersion: 2 };
    },
    evidence() {
      return { complete: true, truncated: false };
    }
  };
  const service = makeService([], recorder, fileRevisions) as unknown as {
    processFileRevision(session: SessionDetail, revisionId: string): Promise<FileRevisionRun>;
    continueFileRevisionAfterPartialFailure(session: SessionDetail, revisionId: string): Promise<FileRevisionRun>;
    runOneTask(session: SessionDetail, brief: TaskBrief, task: AgentTask): Promise<{ ok: true }>;
    fileRevisionCandidateContent(sessionId: string, taskId: string, filePath: string): string;
    runFileRevisionSynthesis(
      session: SessionDetail,
      brief: TaskBrief,
      run: FileRevisionRun,
      receiver: Agent,
      task: AgentTask
    ): Promise<{ invocationId: string; output: FileRevisionCandidateOutput }>;
  };
  service.runOneTask = async (_session, _brief, task) => {
    if (task.executionPurpose === 'file_revision') {
      concurrentAgents += 1;
      maxConcurrentAgents = Math.max(maxConcurrentAgents, concurrentAgents);
      await new Promise((resolve) => setImmediate(resolve));
      concurrentAgents -= 1;
      if (task.assignee?.id === scenario.failedAgentId) throw new Error('selected Agent failed');
    }
    task.resultSummary = `${task.executionPurpose} completed`;
    return { ok: true };
  };
  service.fileRevisionCandidateContent = (_sessionId, taskId) => `complete proposal from ${taskId}`;
  service.runFileRevisionSynthesis = async (_session, _brief, currentRun) => ({
    invocationId: 'receiver-invocation',
    output: {
      schemaVersion: '1.0',
      kind: 'file_revision_candidate',
      revisionId: currentRun.id,
      chainId: currentRun.chainId,
      iteration: currentRun.iteration,
      sourceDraftHash: currentRun.userDraftHash,
      evidenceHash: currentRun.contextSnapshotHash,
      content: 'Receiver complete candidate',
      summary: 'Receiver synthesis completed.',
      incorporatedAgentResultIds: currentRun.agentResults
        .filter((item) => item.status === 'completed')
        .map((item) => item.id),
      unresolvedConflicts: []
    }
  });

  if (scenario.failedAgentId) {
    await assert.rejects(
      service.processFileRevision(session(), run.id),
      /REVISION_PARTIAL_AGENT_FAILURE/
    );
    assert.equal(run.agentResults.length, scenario.targetAgentIds.length);
    assert.equal(run.agentResults.filter((item) => item.status === 'failed').length, 1);
    assert.equal(createdTasks.filter((task) => task.executionPurpose === 'revision_synthesis').length, 0);
    assert.equal(recorder.events.some((event) => event.type === 'file_revision_candidate_generated'), false);
    const continued = await service.continueFileRevisionAfterPartialFailure(session(), run.id);
    assert.equal(continued.status, 'awaiting_confirmation');
    assert.equal(createdTasks.filter((task) => task.executionPurpose === 'revision_synthesis').length, 1);
    assert.equal(recorder.events.some((event) => event.type === 'file_revision_candidate_generated'), true);
    continue;
  }

  const result = await service.processFileRevision(session(), run.id);

  assert.equal(maxConcurrentAgents, scenario.targetAgentIds.length);
  assert.equal(result.status, 'awaiting_confirmation');
  assert.equal(result.agentResults.length, scenario.targetAgentIds.length);
  assert.equal(createdTasks.filter((task) => task.executionPurpose === 'file_revision').length, scenario.targetAgentIds.length);
  assert.equal(createdTasks.filter((task) => task.executionPurpose === 'revision_synthesis').length, 1);
  assert.equal(
    createdTasks.find((task) => task.executionPurpose === 'revision_synthesis')?.assignee?.id,
    'coordinator'
  );
    assert.ok(createdTasks.every((task) => task.description.includes('Preserve the user-approved terminology.')));
    assert.ok(recorder.events.some((event) => event.type === 'file_revision_candidate_generated'));
    assert.ok(recorder.events.some((event) => event.type === 'user_confirmation_requested'));
    assert.doesNotMatch(
      JSON.stringify(recorder.events),
      /deterministic diff|changedArtifacts metadata\.fileChanges|Preserve the user-approved terminology/
    );
  }
  assert.equal(
    workspaceMetrics.snapshot().series.find((item) => item.name === 'file_revision_synthesis_duration_ms')?.count,
    3
  );
});

test('receiver Runtime recognizes every follow-up intent without requesting interruption', async () => {
  const service = makeService() as unknown as {
    recognizeFollowUpMessage(
      session: SessionDetail,
      content: string,
      mentionedAgentIds: string[]
    ): Promise<{
      intent: string;
      requirementRelation?: string;
      failedExecutionAction?: string;
      shouldPause: boolean;
      coordinatorInstruction: string;
    }>;
    createContextAssembly(): ContextAssembly;
    runRuntime(
      session: SessionDetail,
      input: { phase: string; contextAssembly: ContextAssembly }
    ): Promise<AgentRunResult>;
  };
  let invocationPhase = '';
  let routedContext: ContextAssembly | undefined;
  service.createContextAssembly = () => ({
    systemRules: [],
    constraints: [],
    relevantEvents: [],
    budget: {}
  } as unknown as ContextAssembly);
  service.runRuntime = async (_session, input) => {
    invocationPhase = input.phase;
    routedContext = input.contextAssembly;
    return {
      invocationId: 'intent-run',
      runtimeType: 'mock',
      status: 'completed',
      output: {
        schemaVersion: '1.0',
        kind: 'user_message_handling_plan',
        intent: 'command',
        requirementRelation: 'continuation',
        failedExecutionAction: 'none',
        priority: 'normal',
        shouldPause: true,
        affectedTaskIds: [],
        affectedAgentIds: ['backend'],
        requiresBriefRevision: false,
        requiresUserConfirmation: false,
        coordinatorInstruction: 'decompose later'
      },
      events: [],
      artifacts: [],
      systemEvidence: createRuntimeArtifactSystemEvidence('intent-run'),
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, model: 'mock' }
    };
  };

  const plan = await service.recognizeFollowUpMessage(session(), '完成后增加缓存', ['backend']);

  assert.equal(invocationPhase, 'user_message_routing');
  assert.equal(plan.intent, 'command');
  assert.equal(plan.requirementRelation, 'continuation');
  assert.equal(plan.failedExecutionAction, 'none');
  assert.equal(plan.shouldPause, false);
  assert.equal(plan.coordinatorInstruction, 'decompose later');
  assert.equal(routedContext?.currentUserMessage, '完成后增加缓存');
  assert.equal(routedContext?.constraints.some((item) => item.startsWith('Current user message:')), false);
});

test('multiple mentioned agents discuss first and receiver decomposition stays within that agent set', async () => {
  const service = makeService() as unknown as {
    prepareFollowUpExecution(
      session: SessionDetail,
      content: string,
      sourceEventId: string,
      mentionedAgentIds: string[]
    ): Promise<{ brief: TaskBrief; tasks: AgentTask[] }>;
    getBrief(sessionId: string, briefId: string): TaskBrief | undefined;
    memories: { create(input: unknown): unknown };
    createContextAssembly(): ContextAssembly;
    runFollowUpDiscussion(
      session: SessionDetail,
      coordinator: Agent,
      participants: Agent[],
      content: string
    ): Promise<void>;
    runRuntime(): Promise<AgentRunResult>;
    selectSuggestedTasks(
      session: SessionDetail,
      tasks: TaskBriefOutput['suggestedTasks']
    ): TaskBriefOutput['suggestedTasks'];
    prepareExecution(session: SessionDetail, briefId: string): { brief: TaskBrief; tasks: AgentTask[] };
    suggestedTasksByBriefId: Map<string, TaskBriefOutput['suggestedTasks']>;
  };
  let discussedKeys: string[] = [];
  service.memories = { create() { return {}; } };
  service.createContextAssembly = () => ({
    systemRules: [],
    constraints: [],
    relevantEvents: [],
    budget: {}
  } as unknown as ContextAssembly);
  service.runFollowUpDiscussion = async (_session, _coordinator, participants) => {
    discussedKeys = participants.map((participant) => participant.key);
  };
  const runtimeTasks = [
    suggestedTask({ title: 'Implement', description: 'Implement change', suggestedAgentKey: 'coordinator', acceptanceCriteria: [] }),
    suggestedTask({ title: 'Verify', description: 'Verify change', suggestedAgentKey: null, acceptanceCriteria: [] }),
    suggestedTask({ title: 'Document', description: 'Document change', suggestedAgentKey: 'requirements', acceptanceCriteria: [] })
  ];
  service.runRuntime = async () => ({
    invocationId: 'decomposition-run',
    runtimeType: 'mock',
    status: 'completed',
    output: {
      schemaVersion: '1.0',
      kind: 'task_brief',
      goal: 'Implement follow-up',
      scope: [],
      outOfScope: [],
      constraints: [],
      acceptanceCriteria: [],
      risks: [],
      openQuestions: [],
      suggestedTasks: runtimeTasks
    },
    events: [],
    artifacts: [],
    systemEvidence: createRuntimeArtifactSystemEvidence('decomposition-run'),
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, model: 'mock' }
  });
  service.selectSuggestedTasks = (_session, tasks) => tasks;
  service.prepareExecution = (inputSession, briefId) => ({
    brief: service.getBrief(inputSession.id, briefId)!,
    tasks: []
  });

  const inputSession = session();
  await service.prepareFollowUpExecution(inputSession, '实现并验证新需求', 'event-follow-up', ['backend', 'test']);
  const latestBrief = service.getBrief(inputSession.id, inputSession.currentTaskBriefId ?? '') ??
    (service as unknown as { briefsBySession: Map<string, TaskBrief[]> }).briefsBySession.get(inputSession.id)?.at(-1);
  assert.deepEqual(discussedKeys, ['backend', 'test']);
  assert.ok(latestBrief);
  assert.deepEqual(
    service.suggestedTasksByBriefId.get(latestBrief!.id)?.map((task) => task.suggestedAgentKey),
    ['backend', 'test', 'backend']
  );
});

test('receiver rejection fallback cannot escape an explicit mentioned-agent boundary', () => {
  const service = makeService() as unknown as {
    findAlternativeClaimAgent(
      session: SessionDetail,
      task: AgentTask,
      decision: TaskAcceptanceDecisionOutput,
      attemptedAgentIds: Set<string>
    ): Agent | undefined;
  };
  const inputSession = session();
  const task: AgentTask = {
    id: 'task-mentioned-boundary',
    sessionId: inputSession.id,
    title: 'Implement cache',
    description: 'Implement and verify cache behavior',
    status: 'blocked',
    assignee: { type: 'agent', id: 'backend' },
    eligibleAgentIds: ['backend', 'test'],
    dependsOnTaskIds: [],
    acceptanceCriteria: [],
    createdAt: '2026-07-03T00:00:00.000Z',
    updatedAt: '2026-07-03T00:00:00.000Z'
  };
  const decision: TaskAcceptanceDecisionOutput = {
    schemaVersion: '1.0',
    kind: 'task_acceptance_decision',
    status: 'rejected',
    reason: 'backend cannot verify this change',
    missingContext: [],
    requestedContext: null,
    handoffSuggestion: null,
    confidence: 0.8,
    alternativeAgentKeys: ['requirements'],
    alternativeAgentIds: [],
    agentMessages: []
  };

  const alternative = service.findAlternativeClaimAgent(inputSession, task, decision, new Set(['backend']));

  assert.equal(alternative?.key, 'test');
});

test('workflow receiver rejection never triggers an automatic cross-role fallback', () => {
  const service = makeService() as unknown as {
    findAlternativeClaimAgent(
      session: SessionDetail,
      task: AgentTask,
      decision: TaskAcceptanceDecisionOutput,
      attemptedAgentIds: Set<string>
    ): Agent | undefined;
  };
  const inputSession = session();
  const task: AgentTask = {
    id: 'workflow-task-fixed-agent',
    sessionId: inputSession.id,
    title: '发放',
    description: '执行工作流中的后端专业阶段。',
    status: 'blocked',
    assignee: { type: 'agent', id: 'backend' },
    eligibleAgentIds: ['backend'],
    workflowRunId: 'workflow-run-1',
    workflowNodeId: 'backend-node',
    workflowNodeRunId: 'backend-node-run',
    dependsOnTaskIds: [],
    acceptanceCriteria: [],
    createdAt: '2026-07-03T00:00:00.000Z',
    updatedAt: '2026-07-03T00:00:00.000Z'
  };
  const decision: TaskAcceptanceDecisionOutput = {
    schemaVersion: '1.0',
    kind: 'task_acceptance_decision',
    status: 'rejected',
    reason: 'Missing implementation evidence.',
    missingContext: [],
    requestedContext: null,
    handoffSuggestion: {
      targetAgentKey: 'requirements',
      targetAgentId: null,
      reason: 'Ask requirements.',
      riskLevel: 'low',
      missingContext: []
    },
    confidence: 0.8,
    alternativeAgentKeys: ['requirements'],
    alternativeAgentIds: [],
    agentMessages: []
  };

  const alternative = service.findAlternativeClaimAgent(inputSession, task, decision, new Set(['backend']));

  assert.equal(alternative, undefined);
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
  (service as unknown as { backoffRuntimeProviderRetry(ms: number): Promise<void> }).backoffRuntimeProviderRetry = async (ms) => {
    assert.equal(ms, 120_000);
  };
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
    approvalRequired?: boolean;
    workItemBudgetExhausted?: boolean;
  }>;
  createContextAssembly(): ContextAssembly;
  runRuntime(session: SessionDetail, input: {
    invocationId: string;
    phase: string;
    agent: Agent;
  }): Promise<AgentRunResult>;
  emitTaskHandoff(): void;
  createSummaryMemoryCheckpoint(): void;
  createTaskContext(
    session: SessionDetail,
    brief: TaskBrief | undefined,
    task: AgentTask | undefined,
    phase: 'execution',
    relevantMemories: ContextAssembly['relevantMemories'],
    ragSnippets: ContextAssembly['ragSnippets']
  ): TaskContext;
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

test('supplemental semantic refs resolve exact artifacts and expose full bounded proposal content', async () => {
  const artifact: Artifact = {
    id: 'artifact-architecture',
    dataEpoch: 'epoch-test',
    sessionId: 'session-1',
    taskId: 'task-architect',
    agentId: 'architect',
    type: 'markdown',
    title: 'System architecture',
    contentSummary: 'Architecture completed.',
    metadata: { phase: 'task_execution' },
    runtimeProposals: [createRuntimeArtifactOutput({
      type: 'markdown',
      title: 'System architecture details',
      summary: 'Concrete schema and API design.',
      content: 'Database schema: users(id, email). API: POST /users with request and response schemas.'
    })],
    platformProjections: [],
    systemEvidence: null,
    createdAt: '2026-07-03T00:00:00.000Z'
  };
  const service = makeService([artifact]) as unknown as {
    hydrateSupplementalContext(session: SessionDetail, request: RuntimeContextRequest): Promise<SupplementalContextResolution>;
    selectedEvidenceContent(session: SessionDetail, evidence: { type: 'artifact'; label: string; ref: string }): { content?: string } | undefined;
  };
  const activeSession = session();
  const resolution = await service.hydrateSupplementalContext(activeSession, {
    reason: 'Need the architecture body',
    requestedRefs: [{ type: 'artifact', label: 'System architecture' }],
    requestedFiles: []
  });

  assert.deepEqual(resolution.resolvedRefs, [{ type: 'artifact', label: 'System architecture', ref: artifact.id }]);
  assert.deepEqual(resolution.failedRefs, []);
  assert.equal(resolution.outcome, 'resolved');
  assert.ok(resolution.contentBytes > (artifact.contentSummary?.length ?? 0));
  assert.match(service.selectedEvidenceContent(activeSession, {
    type: 'artifact', label: artifact.title, ref: artifact.id
  })?.content ?? '', /POST \/users/);
});

test('resolved semantic refs are injected into the immediate Runtime retry', async () => {
  const artifact: Artifact = {
    id: 'artifact-runtime-retry-architecture',
    dataEpoch: 'epoch-test',
    sessionId: 'session-1',
    taskId: 'task-architect',
    agentId: 'architect',
    type: 'markdown',
    title: 'Runtime retry architecture',
    contentSummary: 'Architecture summary.',
    metadata: { phase: 'task_execution' },
    runtimeProposals: [createRuntimeArtifactOutput({
      type: 'markdown',
      title: 'Runtime retry architecture details',
      summary: 'Detailed architecture.',
      content: 'RETRY_ARCHITECTURE_BODY: POST /projects uses ProjectCreateRequest and ProjectResponse.'
    })],
    platformProjections: [],
    systemEvidence: null,
    createdAt: '2026-07-31T00:00:00.000Z'
  };
  const service = makeService([artifact]) as unknown as {
    runRuntime(session: SessionDetail, input: {
      invocationId: string;
      sessionId: string;
      phase: 'discussion';
      agent: Agent;
      contextAssembly: ContextAssembly;
      expectedOutput: { kind: 'agent_message'; schemaVersion: '1.0' };
      budget: Record<string, number>;
    }): Promise<AgentRunResult>;
    runRuntimeAttempt(session: SessionDetail, input: {
      invocationId: string;
      contextAssembly: ContextAssembly;
    }): Promise<AgentRunResult>;
    recordSupplementalContextRequest(): void;
  };
  const retryEvidence: Array<ContextAssembly['selectedEvidenceContents']> = [];
  let attempt = 0;
  service.recordSupplementalContextRequest = () => {};
  service.runRuntimeAttempt = async (_activeSession, input) => {
    attempt += 1;
    retryEvidence.push(input.contextAssembly.selectedEvidenceContents);
    if (attempt === 1) {
      return {
        invocationId: input.invocationId,
        runtimeType: 'mock',
        status: 'failed',
        output: createAgentMessageOutput({ messageKind: 'risk', content: 'Need the architecture body.' }),
        events: [],
        artifacts: [],
        systemEvidence: createRuntimeArtifactSystemEvidence(input.invocationId),
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, model: 'mock' },
        error: {
          code: 'CONTEXT_INSUFFICIENT',
          message: 'Need the architecture body.',
          retryable: true,
          requestedContext: {
            reason: 'Need the architecture body.',
            requestedRefs: [{ type: 'artifact', label: artifact.title }],
            requestedFiles: []
          }
        }
      };
    }
    return {
      invocationId: input.invocationId,
      runtimeType: 'mock',
      status: 'completed',
      output: createAgentMessageOutput({ messageKind: 'answer', content: 'Implemented from the architecture.' }),
      events: [],
      artifacts: [],
      systemEvidence: createRuntimeArtifactSystemEvidence(input.invocationId),
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, model: 'mock' }
    };
  };

  const result = await service.runRuntime(session(), {
    invocationId: 'semantic-ref-retry',
    sessionId: 'session-1',
    phase: 'discussion',
    agent: agent('backend'),
    contextAssembly: {
      taskContext: { evidenceRefs: [] } as unknown as TaskContext,
      selectedEvidenceContents: []
    } as unknown as ContextAssembly,
    expectedOutput: { kind: 'agent_message', schemaVersion: '1.0' },
    budget: {}
  });

  assert.equal(result.status, 'completed');
  assert.equal(attempt, 2);
  assert.match(JSON.stringify(retryEvidence[1]), /RETRY_ARCHITECTURE_BODY/);
  assert.equal(retryEvidence[1]?.some((item) => item.ref === artifact.id), true);
});

test('supplemental semantic refs report invalid null refs as exhausted instead of resolved', async () => {
  const service = makeService() as unknown as {
    hydrateSupplementalContext(session: SessionDetail, request: RuntimeContextRequest): Promise<SupplementalContextResolution>;
  };
  const resolution = await service.hydrateSupplementalContext(session(), {
    reason: 'Need a missing decision',
    requestedRefs: [{ type: 'historical_decision', label: 'User-confirmed task details' }]
  });

  assert.deepEqual(resolution.resolvedRefs, []);
  assert.equal(resolution.failedRefs?.[0]?.code, 'INVALID_REFERENCE');
  assert.equal(resolution.outcome, 'exhausted');
});

test('bootstrap workflow task can auto-recover once when an upstream dependency artifact exists', async () => {
  const recorder: ServiceRecorder = { events: [], taskUpdates: [], runtimeCalls: 0 };
  const upstreamArtifact: Artifact = {
    id: 'artifact-architecture',
    dataEpoch: 'epoch-test',
    sessionId: 'session-1',
    taskId: 'task-architecture',
    agentId: 'architect',
    type: 'json',
    title: 'Architecture execution result',
    contentSummary: 'Architecture, API contracts, and data model are defined.',
    metadata: { phase: 'task_execution' },
    runtimeProposals: [],
    platformProjections: [],
    systemEvidence: null,
    createdAt: '2026-07-31T00:00:00.000Z'
  };
  const service = makeService(
    [upstreamArtifact],
    recorder,
    undefined,
    undefined,
    ['coordinator', 'architect', 'frontend', 'backend']
  ) as unknown as TaskExecutionTestService;
  service.createContextAssembly = () => ({
    relevantMemories: [],
    budget: { maxInputTokens: 2_000, maxOutputTokens: 500, maxTotalTokens: 2_500 }
  }) as unknown as ContextAssembly;
  service.runRuntime = async (_session, input) => ({
    invocationId: input.invocationId,
    runtimeType: 'mock',
    status: 'completed',
    output: input.phase === 'task_acceptance'
      ? {
          ...runtimeOutputExamples.task_acceptance_decision,
          status: input.agent.key === 'frontend' ? 'blocked' : 'accepted',
          reason: input.agent.key === 'frontend'
            ? 'Frontend needs the upstream architecture contract.'
            : 'Backend can continue from the upstream architecture.',
          handoffSuggestion: input.agent.key === 'frontend'
            ? {
                targetAgentKey: 'backend', targetAgentId: null,
                reason: 'Backend can initialize the shared contracts.', missingContext: [], riskLevel: 'low'
              }
            : null,
          alternativeAgentKeys: input.agent.key === 'frontend' ? ['backend'] : []
        }
      : runtimeOutputExamples.task_execution_result,
    events: [],
    artifacts: [],
    systemEvidence: createRuntimeArtifactSystemEvidence(input.invocationId),
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, model: 'mock' }
  });
  service.emitTaskHandoff = () => {};
  service.createSummaryMemoryCheckpoint = () => {};

  const activeSession: SessionDetail = {
    ...session(),
    status: 'EXECUTING',
    workspaceMode: 'bootstrap',
    participatingAgentIds: ['coordinator', 'architect', 'frontend', 'backend']
  };
  const task: AgentTask = {
    id: 'task-frontend',
    sessionId: activeSession.id,
    title: 'Implement the frontend stage',
    description: 'Use the upstream design contract to initialize the project.',
    status: 'assigned',
    assignee: { type: 'agent', id: 'frontend' },
    routingMode: 'coordinator_controlled',
    autoResolutionAttempted: false,
    dependsOnTaskIds: ['task-architecture'],
    acceptanceCriteria: ['Frontend implementation is initialized.'],
    createdAt: '2026-07-31T00:00:00.000Z',
    updatedAt: '2026-07-31T00:00:00.000Z'
  };
  const brief: TaskBrief = {
    id: 'brief-bootstrap', sessionId: activeSession.id, version: 1,
    goal: 'Build a new project from scratch.', scope: [], outOfScope: [], constraints: [],
    acceptanceCriteria: task.acceptanceCriteria, risks: [], openQuestions: [], confirmedByUser: true,
    createdAt: '2026-07-31T00:00:00.000Z'
  };

  const outcome = await service.runOneTask(activeSession, brief, task);

  assert.equal(outcome.ok, true);
  assert.equal(task.autoResolutionAttempted, true);
  assert.deepEqual(task.assignee, { type: 'agent', id: 'backend' });
  assert.ok(recorder.events.some((event) => event.type === 'task_reassigned'));
});

test('task context exposes upstream dependency artifacts as directly readable evidence', () => {
  const upstreamArtifact: Artifact = {
    id: 'artifact-upstream-contract',
    dataEpoch: 'epoch-test',
    sessionId: 'session-1',
    taskId: 'task-upstream',
    agentId: 'architect',
    type: 'markdown',
    title: 'Upstream architecture contract',
    contentSummary: 'Use POST /api/projects and the Project data model.',
    metadata: { phase: 'task_execution' },
    runtimeProposals: [],
    platformProjections: [],
    systemEvidence: null,
    createdAt: '2026-07-31T00:00:00.000Z'
  };
  const service = makeService([upstreamArtifact]) as unknown as TaskExecutionTestService;
  const activeSession: SessionDetail = {
    ...session(),
    taskDomain: 'non_coding'
  };
  const task: AgentTask = {
    id: 'task-downstream',
    sessionId: activeSession.id,
    title: 'Implement the frontend stage',
    description: 'Consume the upstream contract.',
    status: 'assigned',
    assignee: { type: 'agent', id: 'frontend' },
    dependsOnTaskIds: ['task-upstream'],
    acceptanceCriteria: ['Frontend stage is complete.'],
    createdAt: '2026-07-31T00:00:00.000Z',
    updatedAt: '2026-07-31T00:00:00.000Z'
  };

  const context = service.createTaskContext(activeSession, undefined, task, 'execution', [], []);
  const dependencyRef = context.evidenceRefs.find((ref) => ref.ref === upstreamArtifact.id);

  assert.equal(dependencyRef?.type, 'artifact');
  assert.equal(dependencyRef?.selectionReason, 'Upstream task dependency.');
});

test('runtime index refresh requests a bounded task-relevant projection instead of a full snapshot', async () => {
  const revision = { id: 'revision-query', observedAt: '2026-07-28T00:00:00.000Z' };
  let queryInput: { query?: string; pathHints?: string[]; limit?: number } | undefined;
  const workspaceProviders = {
    resolve() {
      return {
        capabilities: () => ({ read: true, write: false, command: false, test: false }),
        queryWorkspaceIndex: async (input: typeof queryInput) => {
          queryInput = input;
          return {
            workspaceId: 'workspace-1', revision, generation: 2, status: 'ready', complete: true,
            entries: [{ path: 'src/main.ts', kind: 'file', size: 20, generated: false, sensitive: false }],
            matched: 1, entrypoints: ['src/main.ts'], detectedStack: ['TypeScript'],
            indexedEntries: 100_000, truncated: false, updatedAt: revision.observedAt
          };
        },
        getIndexSnapshot: async () => { throw new Error('full index snapshot must not be requested'); }
      };
    }
  };
  const service = makeService([], undefined, undefined, workspaceProviders) as unknown as {
    refreshWorkspaceIndex(session: SessionDetail, input: unknown): Promise<void>;
  };
  const activeSession = architectureSession();

  await service.refreshWorkspaceIndex(activeSession, {
    contextAssembly: {
      sessionGoal: 'Analyze the application entrypoint',
      taskContext: {
        intent: 'architecture_analysis',
        evidenceRefs: [{ type: 'workspace_file', label: 'main', ref: 'src/main.ts' }],
        taskMap: { items: [] }
      }
    }
  });

  assert.equal(queryInput?.limit, 50);
  assert.deepEqual(queryInput?.pathHints, ['src/main.ts']);
  assert.equal(activeSession.workspaceIndex?.entries.length, 1);
  assert.equal(activeSession.workspaceIndex?.indexedEntries, 100_000);
});

test('architecture preload is strictly bounded and continues when the Provider read fails', async () => {
  const revision = { id: 'revision-preload', observedAt: '2026-07-28T00:00:00.000Z' };
  const activeSession: SessionDetail = {
    ...architectureSession(),
    workspaceIndex: {
      workspaceId: 'workspace-1',
      revision,
      generation: 2,
      status: 'ready',
      complete: true,
      entries: [
        'package.json',
        'README.md',
        'tsconfig.json',
        'vite.config.ts',
        'src/main.ts',
        'src/App.vue',
        'src/router.ts',
        'src/store.ts',
        'src/services/api.ts',
        'src/components/Panel.vue'
      ].map((path) => ({ path, kind: 'file' as const, size: 20, generated: false, sensitive: false })),
      entrypoints: ['package.json', 'src/main.ts'],
      detectedStack: ['TypeScript'],
      indexedEntries: 10,
      truncated: false,
      updatedAt: revision.observedAt,
      coverage: {
        visitedEntries: 10, indexedEntries: 10, excludedGenerated: 0,
        sensitiveEntries: 0, skippedSymlinks: 0, failedEntries: 0
      }
    }
  };
  let capturedRequest: RuntimeContextRequest | undefined;
  let capturedOptions: { deadlineMs?: number; maxOperations?: number; maxContentBytes?: number } | undefined;
  const service = makeService() as unknown as {
    preloadArchitectureTaskContext(session: SessionDetail, task: AgentTask, agentId: string): Promise<void>;
    hydrateSupplementalContext(
      session: SessionDetail,
      request: RuntimeContextRequest,
      options?: { deadlineMs?: number; maxOperations?: number; maxContentBytes?: number }
    ): Promise<SupplementalContextResolution>;
  };
  service.hydrateSupplementalContext = async (_session, request, options) => {
    capturedRequest = request;
    capturedOptions = options;
    throw new Error('Provider deadline reached');
  };

  await assert.doesNotReject(
    service.preloadArchitectureTaskContext(activeSession, architectureTask(), 'architect')
  );

  assert.equal(capturedRequest?.requestedFiles?.length, 8);
  assert.equal(capturedRequest?.requestedFiles?.some((item) => item.path === 'package.json'), true);
  assert.deepEqual(capturedOptions, {
    deadlineMs: 1_500,
    maxOperations: 8,
    maxContentBytes: 256 * 1024
  });
});

test('supplemental hydration processes eight existing files and defers the remainder', async () => {
  const revision = { id: 'revision-cache', observedAt: '2026-07-28T00:00:00.000Z' };
  const workspaceProviders = {
    resolve() {
      return {
        capabilities: () => ({ read: true, write: false, command: false, test: false }),
        getRevision: async () => revision,
        readFile: async () => { throw new Error('same-revision cached evidence must not be re-read'); }
      };
    }
  };
  const service = makeService([], undefined, undefined, workspaceProviders) as unknown as {
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
      files: paths.map((path) => ({ path, size: 20, content: `export const source = '${path}';`, revision })),
      skipped: []
    },
    workspaceIndex: {
      workspaceId: 'workspace-1', revision, generation: 1, status: 'ready', complete: true,
      entries: paths.map((path) => ({ path, kind: 'file' as const, size: 20, generated: false, sensitive: false })),
      entrypoints: [], detectedStack: [], indexedEntries: paths.length, truncated: false,
      updatedAt: revision.observedAt,
      coverage: {
        visitedEntries: paths.length, indexedEntries: paths.length, excludedGenerated: 0,
        sensitiveEntries: 0, skippedSymlinks: 0, failedEntries: 0
      }
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

test('supplemental hydration reports unavailable Local Runtime reads instead of swallowing them', async () => {
  const service = makeService() as unknown as {
    hydrateSupplementalContext(
      session: SessionDetail,
      request: RuntimeContextRequest
    ): Promise<SupplementalContextResolution>;
  };
  const activeSession: SessionDetail = {
    ...architectureSession(),
    workingDirectory: {
      kind: 'local_bridge',
      id: 'local-runtime-workspace',
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
  assert.equal(resolution.failedPaths[0]?.code, 'READ_UNAVAILABLE');
  assert.equal(resolution.failedPaths[0]?.retryable, true);
});

test('supplemental hydration enforces the eight-operation bound and defers later paths', async () => {
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

  assert.deepEqual(resolution.hydratedPaths, []);
  assert.equal(resolution.failedPaths.length, 8);
  assert.deepEqual(resolution.deferredPaths, paths.slice(8));
});

test('supplemental hydration supports bounded directory listing and text search evidence', async () => {
  const revision = { id: 'revision-1', observedAt: '2026-07-28T00:00:00.000Z' };
  const workspaceProviders = {
    resolve() {
      return {
        capabilities: () => ({ read: true, write: false, command: false, test: false }),
        getRevision: async () => revision,
        listDirectory: async () => ({
          path: 'src',
          revision,
          entries: [{ path: 'src/main.ts', kind: 'file', size: 20, revision }]
        }),
        searchText: async () => ({
          revision,
          truncated: false,
          matches: [{ path: 'src/main.ts', line: 1, column: 14, preview: 'export const main = true;' }]
        })
      };
    }
  };
  const service = makeService([], undefined, undefined, workspaceProviders) as unknown as {
    hydrateSupplementalContext(
      session: SessionDetail,
      request: RuntimeContextRequest
    ): Promise<SupplementalContextResolution>;
  };
  const activeSession = architectureSession();
  const resolution = await service.hydrateSupplementalContext(activeSession, {
    reason: 'Need navigation and symbol evidence',
    requestedRefs: [],
    requestedDirectories: [{ path: 'src', depth: 1 }],
    requestedSearches: [{ query: 'main', path: 'src', include: ['**/*.ts'] }]
  });

  assert.deepEqual(resolution.listedDirectories, ['src']);
  assert.deepEqual(resolution.completedSearches, [JSON.stringify(['main', 'src', ['**/*.ts'], []])]);
  assert.deepEqual(resolution.hydratedPaths, ['src/', 'search:main']);
  assert.equal(resolution.evidenceRevisions?.['src/']?.id, revision.id);
  assert.equal(resolution.evidenceRevisions?.['search:main']?.id, revision.id);
  assert.equal(activeSession.workspaceSnapshot?.files.some((file) => file.path === 'src/'), true);
  assert.equal(activeSession.workspaceSnapshot?.files.some((file) => file.path === 'search:main'), true);
});

test('supplemental file evidence retries once when the workspace revision changes', async () => {
  let reads = 0;
  const revision = (id: string) => ({ id, observedAt: '2026-07-28T00:00:00.000Z' });
  const workspaceProviders = {
    resolve() {
      return {
        capabilities: () => ({ read: true, write: false, command: false, test: false }),
        readFile: async ({ path }: { path: string }) => {
          reads += 1;
          const current = revision(reads === 1 ? 'revision-1' : 'revision-2');
          return {
            path,
            content: `content-${reads}`,
            encoding: 'utf-8',
            byteLength: 9,
            truncated: false,
            revision: current,
            hash: { algorithm: 'sha256', value: `hash-${reads}` }
          };
        },
        getRevision: async () => revision('revision-2')
      };
    }
  };
  const service = makeService([], undefined, undefined, workspaceProviders) as unknown as {
    hydrateSupplementalContext(session: SessionDetail, request: RuntimeContextRequest): Promise<SupplementalContextResolution>;
  };
  const activeSession = architectureSession();
  const resolution = await service.hydrateSupplementalContext(activeSession, {
    reason: 'Need stable source evidence',
    requestedRefs: [],
    requestedPaths: ['src/main.ts']
  });

  assert.equal(reads, 2);
  assert.deepEqual(resolution.hydratedPaths, ['src/main.ts']);
  assert.equal(activeSession.workspaceSnapshot?.files[0]?.revision?.id, 'revision-2');
  assert.equal(activeSession.workspaceSnapshot?.files[0]?.hash?.value, 'hash-2');
});

test('supplemental hydration re-reads cached file content from an older revision', async () => {
  const currentRevision = { id: 'revision-2', observedAt: '2026-07-28T00:00:00.000Z' };
  let reads = 0;
  const workspaceProviders = {
    resolve() {
      return {
        capabilities: () => ({ read: true, write: false, command: false, test: false }),
        getRevision: async () => currentRevision,
        readFile: async ({ path }: { path: string }) => {
          reads += 1;
          return {
            path, content: 'current body', encoding: 'utf-8', byteLength: 12, truncated: false,
            revision: currentRevision, hash: { algorithm: 'sha256', value: 'current-hash' }
          };
        }
      };
    }
  };
  const service = makeService([], undefined, undefined, workspaceProviders) as unknown as {
    hydrateSupplementalContext(session: SessionDetail, request: RuntimeContextRequest): Promise<SupplementalContextResolution>;
  };
  const activeSession: SessionDetail = {
    ...architectureSession(),
    workspaceSnapshot: {
      rootName: 'fixture', scannedAt: '2026-07-27T00:00:00.000Z', fileCount: 1, totalBytes: 10,
      tree: [{ path: 'src/main.ts', kind: 'file' }],
      files: [{
        path: 'src/main.ts', size: 10, content: 'stale body',
        revision: { id: 'revision-1', observedAt: '2026-07-27T00:00:00.000Z' }
      }],
      skipped: []
    }
  };

  const resolution = await service.hydrateSupplementalContext(activeSession, {
    reason: 'Need current source', requestedRefs: [], requestedPaths: ['src/main.ts']
  });

  assert.equal(reads, 1);
  assert.equal(activeSession.workspaceSnapshot?.files[0]?.content, 'current body');
  assert.equal(resolution.evidenceRevisions?.['src/main.ts']?.id, currentRevision.id);
});

test('supplemental hydration caps materialized evidence at 512KB and defers remaining operations', async () => {
  const revision = { id: 'revision-budget', observedAt: '2026-07-28T00:00:00.000Z' };
  const content = 'x'.repeat(100 * 1024);
  const workspaceProviders = {
    resolve() {
      return {
        capabilities: () => ({ read: true, write: false, command: false, test: false }),
        getRevision: async () => revision,
        readFile: async ({ path }: { path: string }) => ({
          path, content, encoding: 'utf-8', byteLength: content.length, truncated: false, revision,
          hash: { algorithm: 'sha256', value: `hash-${path}` }
        })
      };
    }
  };
  const service = makeService([], undefined, undefined, workspaceProviders) as unknown as {
    hydrateSupplementalContext(session: SessionDetail, request: RuntimeContextRequest): Promise<SupplementalContextResolution>;
  };
  const paths = Array.from({ length: 8 }, (_, index) => `src/large-${index}.txt`);

  const resolution = await service.hydrateSupplementalContext(architectureSession(), {
    reason: 'Need bounded bodies', requestedRefs: [], requestedPaths: paths
  });

  assert.equal(resolution.contentBytes, 512 * 1024);
  assert.equal(resolution.hydratedPaths.length, 6);
  assert.deepEqual(resolution.deferredPaths, paths.slice(6));
});

test('supplemental evidence cache remains bounded across repeated hydration rounds', async () => {
  const revision = { id: 'revision-bounded-cache', observedAt: '2026-07-28T00:00:00.000Z' };
  const content = 'x'.repeat(64 * 1024);
  const workspaceProviders = {
    resolve() {
      return {
        capabilities: () => ({ read: true, write: false, command: false, test: false }),
        getRevision: async () => revision,
        readFile: async ({ path }: { path: string }) => ({
          path,
          content,
          encoding: 'utf-8',
          byteLength: content.length,
          truncated: false,
          revision,
          rangeHash: { algorithm: 'sha256', value: `range-${path}` }
        })
      };
    }
  };
  const service = makeService([], undefined, undefined, workspaceProviders) as unknown as {
    hydrateSupplementalContext(session: SessionDetail, request: RuntimeContextRequest): Promise<SupplementalContextResolution>;
  };
  const activeSession = architectureSession();

  for (let round = 0; round < 5; round += 1) {
    await service.hydrateSupplementalContext(activeSession, {
      reason: 'Need bounded evidence',
      requestedRefs: [],
      requestedPaths: Array.from({ length: 8 }, (_, index) => `src/round-${round}-${index}.ts`)
    });
  }

  const cached = activeSession.workspaceSnapshot?.files ?? [];
  const cachedBytes = cached.reduce((total, file) => total + Buffer.byteLength(file.content ?? '', 'utf8'), 0);
  assert.ok(cached.length <= 32);
  assert.ok(cachedBytes <= 512 * 1024);
  assert.equal(cached.some((file) => file.hash?.value.startsWith('range-')), true);
});

test('supplemental hydration returns a structured deadline failure instead of waiting indefinitely', async () => {
  const previous = process.env.AGENT_CLUSTER_SUPPLEMENTAL_CONTEXT_DEADLINE_MS;
  process.env.AGENT_CLUSTER_SUPPLEMENTAL_CONTEXT_DEADLINE_MS = '5';
  try {
    const workspaceProviders = {
      resolve() {
        return {
          capabilities: () => ({ read: true, write: false, command: false, test: false }),
          getRevision: async () => await new Promise<never>(() => {}),
          readFile: async () => await new Promise<never>(() => {})
        };
      }
    };
    const service = makeService([], undefined, undefined, workspaceProviders) as unknown as {
      hydrateSupplementalContext(session: SessionDetail, request: RuntimeContextRequest): Promise<SupplementalContextResolution>;
    };

    const resolution = await service.hydrateSupplementalContext(architectureSession(), {
      reason: 'Bound the wait', requestedRefs: [], requestedPaths: ['src/main.ts']
    });

    assert.equal(resolution.failedPaths[0]?.code, 'DEADLINE_EXCEEDED');
    assert.equal(resolution.failedPaths[0]?.retryable, false);
  } finally {
    if (previous === undefined) delete process.env.AGENT_CLUSTER_SUPPLEMENTAL_CONTEXT_DEADLINE_MS;
    else process.env.AGENT_CLUSTER_SUPPLEMENTAL_CONTEXT_DEADLINE_MS = previous;
  }
});

test('supplemental file evidence fails explicitly after two unstable revisions', async () => {
  let revisionCounter = 0;
  const nextRevision = () => ({ id: `revision-${++revisionCounter}`, observedAt: '2026-07-28T00:00:00.000Z' });
  const workspaceProviders = {
    resolve() {
      return {
        capabilities: () => ({ read: true, write: false, command: false, test: false }),
        readFile: async ({ path }: { path: string }) => ({
          path,
          content: 'unstable',
          encoding: 'utf-8',
          byteLength: 8,
          truncated: false,
          revision: nextRevision(),
          hash: { algorithm: 'sha256', value: 'hash' }
        }),
        getRevision: async () => nextRevision()
      };
    }
  };
  const service = makeService([], undefined, undefined, workspaceProviders) as unknown as {
    hydrateSupplementalContext(session: SessionDetail, request: RuntimeContextRequest): Promise<SupplementalContextResolution>;
  };
  const resolution = await service.hydrateSupplementalContext(architectureSession(), {
    reason: 'Need stable source evidence',
    requestedRefs: [],
    requestedPaths: ['src/main.ts']
  });

  assert.deepEqual(resolution.hydratedPaths, []);
  assert.equal(resolution.failedPaths[0]?.code, 'WORKSPACE_REVISION_UNSTABLE');
  assert.equal(resolution.failedPaths[0]?.retryable, false);
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

test('file revision task events omit model summaries, prompt details, risks, and handoff content', async () => {
  const secret = 'FILE_REVISION_MODEL_OUTPUT_SECRET';
  const { recorder, service, activeSession, task, brief } = taskExecutionHarness({
    schemaVersion: '1.0',
    kind: 'task_execution_result',
    status: 'completed',
    summary: `${secret}: summary`,
    completedItems: [`${secret}: completed item`],
    changedArtifacts: [],
    requestedContext: null,
    agentMessages: [],
    nextSuggestedActions: [`${secret}: next action`],
    risks: [`${secret}: risk`]
  });
  task.executionPurpose = 'file_revision';
  task.fileRevisionId = 'revision-secret';
  task.description = `${secret}: internal deterministic diff prompt`;
  task.contextRequirements = [`${secret}: frozen evidence`];
  task.acceptanceCriteria = [`${secret}: internal output contract`];

  const outcome = await service.runOneTask(activeSession, brief, task);

  assert.equal(outcome.ok, true);
  const serializedEvents = JSON.stringify(recorder.events);
  assert.doesNotMatch(serializedEvents, new RegExp(secret));
  assert.doesNotMatch(serializedEvents, /deterministic diff|frozen evidence|internal output contract/);
  const artifactEvent = recorder.events.find((event) => event.type === 'artifact_created');
  assert.equal('contentSummary' in (artifactEvent?.metadata.payload as Record<string, unknown>), false);
});

test('file revision accepted task hides acceptance reason, messages, requested context, and handoff', async () => {
  const secret = 'FILE_REVISION_ACCEPTANCE_SECRET';
  const executionOutput = runtimeOutputExamples.task_execution_result;
  const { recorder, service, activeSession, task, brief } = taskExecutionHarness(executionOutput);
  task.executionPurpose = 'file_revision';
  task.fileRevisionId = 'revision-acceptance-secret';
  service.runRuntime = async (_session, input) => ({
    invocationId: input.invocationId,
    runtimeType: 'mock',
    status: 'completed',
    output: input.phase === 'task_acceptance'
      ? {
          ...runtimeOutputExamples.task_acceptance_decision,
          reason: `${secret}: accepted reason`,
          requestedContext: {
            reason: `${secret}: requested context`,
            requestedRefs: [],
            requestedPaths: [`${secret}.md`],
            requestedDirectories: null,
            requestedSearches: null,
            requestedCommands: [],
            followUpInstruction: null
          },
          handoffSuggestion: {
            targetAgentKey: 'test',
            targetAgentId: null,
            reason: `${secret}: handoff`,
            missingContext: [secret],
            riskLevel: 'high'
          },
          agentMessages: [createAgentMessageOutput({
            messageKind: 'handoff',
            content: `${secret}: agent message`
          })]
        }
      : executionOutput,
    events: [],
    artifacts: [],
    systemEvidence: createRuntimeArtifactSystemEvidence(input.invocationId),
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, model: 'mock' }
  });

  const outcome = await service.runOneTask(activeSession, brief, task);

  assert.equal(outcome.ok, true);
  assert.doesNotMatch(JSON.stringify({ events: recorder.events, updates: recorder.taskUpdates }), new RegExp(secret));
  assert.equal(
    recorder.events.some((event) =>
      event.type === 'agent_message' &&
      (event.metadata.payload as { phase?: string } | undefined)?.phase?.startsWith('task_acceptance')
    ),
    false
  );
});

test('file revision blocked or rejected acceptance stores only stable public state', async () => {
  for (const status of ['blocked', 'rejected'] as const) {
    const secret = `FILE_REVISION_${status.toUpperCase()}_SECRET`;
    const { recorder, service, activeSession, task, brief } = taskExecutionHarness(
      runtimeOutputExamples.task_execution_result
    );
    task.executionPurpose = 'file_revision';
    task.fileRevisionId = `revision-${status}-secret`;
    service.runRuntime = async (_session, input) => ({
      invocationId: input.invocationId,
      runtimeType: 'mock',
      status: 'completed',
      output: {
        ...runtimeOutputExamples.task_acceptance_decision,
        status,
        reason: `${secret}: decision reason`,
        missingContext: [`${secret}: missing context`],
        requestedContext: {
          reason: `${secret}: requested context`,
          requestedRefs: [],
          requestedPaths: [`${secret}.md`],
          requestedDirectories: null,
          requestedSearches: null,
          requestedCommands: [],
          followUpInstruction: null
        },
        handoffSuggestion: {
          targetAgentKey: 'test',
          targetAgentId: null,
          reason: `${secret}: handoff`,
          missingContext: [secret],
          riskLevel: 'high'
        },
        agentMessages: [createAgentMessageOutput({
          messageKind: 'risk',
          content: `${secret}: agent message`
        })]
      },
      events: [],
      artifacts: [],
      systemEvidence: createRuntimeArtifactSystemEvidence(input.invocationId),
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, model: 'mock' }
    });

    const outcome = await service.runOneTask(activeSession, brief, task);

    assert.equal(outcome.ok, false);
    assert.equal(outcome.message, 'File revision task acceptance was blocked.');
    assert.doesNotMatch(JSON.stringify({ events: recorder.events, updates: recorder.taskUpdates }), new RegExp(secret));
    const blockedEvent = recorder.events.find((event) =>
      event.type === (status === 'rejected' ? 'task_rejected' : 'task_blocked')
    );
    assert.equal(
      (blockedEvent?.metadata.payload as { resultSummary?: string } | undefined)?.resultSummary,
      'File revision task acceptance was blocked.'
    );
  }
});

test('ordinary execution failure emits task_failed and never impersonates an intake rejection', async () => {
  const { recorder, service, activeSession, task, brief } = taskExecutionHarness(
    runtimeOutputExamples.task_execution_result
  );
  service.runRuntime = async (_session, input) => ({
    invocationId: input.invocationId,
    runtimeType: 'mock',
    status: input.phase === 'task_acceptance' ? 'completed' : 'failed',
    output: input.phase === 'task_acceptance'
      ? runtimeOutputExamples.task_acceptance_decision
      : runtimeOutputExamples.task_execution_result,
    events: [],
    artifacts: [],
    systemEvidence: createRuntimeArtifactSystemEvidence(input.invocationId),
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, model: 'mock' },
    ...(input.phase === 'task_acceptance' ? {} : {
      error: { code: 'MODEL_ERROR' as const, message: 'Execution failed.', retryable: false }
    })
  });

  const outcome = await service.runOneTask(activeSession, brief, task);

  assert.equal(outcome.ok, false);
  assert.equal(task.status, 'failed');
  assert.ok(recorder.events.some((event) => event.type === 'runtime_failed'));
  assert.ok(recorder.events.some((event) => event.type === 'task_failed'));
  assert.equal(recorder.events.some((event) => event.type === 'task_rejected'), false);
});

test('file revision task acceptance Runtime failure omits raw error context and details', async () => {
  const secret = 'FILE_REVISION_ACCEPTANCE_FAILURE_SECRET';
  const { recorder, service, activeSession, task, brief } = taskExecutionHarness(
    runtimeOutputExamples.task_execution_result
  );
  task.executionPurpose = 'file_revision';
  task.fileRevisionId = 'revision-acceptance-failure-secret';
  service.runRuntime = async (_session, input) => ({
    invocationId: input.invocationId,
    runtimeType: 'mock',
    status: 'failed',
    output: runtimeOutputExamples.task_execution_result,
    events: [],
    artifacts: [],
    systemEvidence: createRuntimeArtifactSystemEvidence(input.invocationId),
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, model: 'mock' },
    error: {
      code: 'CONTEXT_INSUFFICIENT',
      message: `${secret}: provider message`,
      retryable: true,
      requestedContext: {
        reason: `${secret}: requested context`,
        requestedRefs: [],
        requestedPaths: [`${secret}.md`]
      },
      details: { secret }
    }
  });

  const outcome = await service.runOneTask(activeSession, brief, task);

  assert.equal(outcome.ok, false);
  assert.equal(outcome.error?.message, 'File revision task acceptance failed.');
  assert.equal(outcome.error?.requestedContext, undefined);
  assert.equal(outcome.error?.details, undefined);
  assert.doesNotMatch(JSON.stringify({ events: recorder.events, updates: recorder.taskUpdates }), new RegExp(secret));
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

test('workflow task acceptance supplements context and retries the original Agent first', async () => {
  const { service, activeSession, task, brief } = taskExecutionHarness(runtimeOutputExamples.task_execution_result);
  task.workflowRunId = 'workflow-run-context-retry';
  task.workflowNodeId = 'backend-node';
  task.workflowNodeRunId = 'backend-node-run';
  const phases: string[] = [];
  let acceptanceAttempt = 0;
  (service as any).hydrateSupplementalContext = async () => ({
    requestedFiles: [{ path: 'src/backend.ts' }],
    hydratedPaths: ['src/backend.ts'],
    resolvedRefs: [],
    failedRefs: [],
    failedPaths: [],
    deferredPaths: [],
    contentBytes: 128,
    outcome: 'resolved',
    attempt: 1,
    maxAttempts: 1
  });
  (service as any).recordSupplementalContextRequest = (
    inputSession: SessionDetail,
    inputTask: AgentTask,
    agentId: string,
    requestedContext: RuntimeContextRequest,
    resolution: SupplementalContextResolution
  ) => {
    inputSession.supplementalContextRequests = [{
      id: 'context-request-1',
      taskId: inputTask.id,
      agentId,
      requestedContext,
      resolution,
      createdAt: '2026-07-03T00:00:00.000Z'
    }];
  };
  service.runRuntime = async (_session, input) => {
    phases.push(input.phase);
    if (input.phase === 'task_acceptance' && acceptanceAttempt++ === 0) {
      return {
        invocationId: input.invocationId,
        runtimeType: 'mock',
        status: 'failed',
        output: createAgentMessageOutput({ messageKind: 'risk', content: 'Need the backend source.' }),
        events: [],
        artifacts: [],
        systemEvidence: createRuntimeArtifactSystemEvidence(input.invocationId),
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, model: 'mock' },
        error: {
          code: 'CONTEXT_INSUFFICIENT',
          message: 'Need the backend source.',
          retryable: true,
          requestedContext: {
            reason: 'Read the implementation before accepting.',
            requestedRefs: [],
            requestedFiles: [{ path: 'src/backend.ts' }]
          }
        }
      };
    }
    return {
      invocationId: input.invocationId,
      runtimeType: 'mock',
      status: 'completed',
      output: input.phase === 'task_acceptance'
        ? runtimeOutputExamples.task_acceptance_decision
        : runtimeOutputExamples.task_execution_result,
      events: [],
      artifacts: [],
      systemEvidence: createRuntimeArtifactSystemEvidence(input.invocationId),
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, model: 'mock' }
    };
  };

  const outcome = await service.runOneTask(activeSession, brief, task);

  assert.equal(outcome.ok, true);
  assert.deepEqual(phases, ['task_acceptance', 'task_acceptance', 'task_execution']);
  assert.equal(task.assignee?.id, 'backend');
  assert.equal(activeSession.supplementalContextRequests?.length, 1);
});

test('task execution pending approval waits without emitting failure events', async () => {
  const { recorder, service, activeSession, task, brief } = taskExecutionHarness(
    runtimeOutputExamples.task_execution_result
  );
  service.runRuntime = async (_session, input) => ({
    invocationId: input.invocationId,
    runtimeType: 'mock',
    status: input.phase === 'task_acceptance' ? 'completed' : 'pending_approval',
    output: input.phase === 'task_acceptance'
      ? runtimeOutputExamples.task_acceptance_decision
      : createAgentMessageOutput({ messageKind: 'progress', content: 'Approval required.' }),
    events: [],
    artifacts: [],
    systemEvidence: createRuntimeArtifactSystemEvidence(input.invocationId),
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, model: 'mock' },
    ...(input.phase === 'task_acceptance' ? {} : {
      error: {
        code: 'HUMAN_APPROVAL_REQUIRED' as const,
        message: 'Approval required.',
        retryable: true
      }
    })
  });

  const outcome = await service.runOneTask(activeSession, brief, task);

  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.approvalRequired, true);
  assert.equal(task.status, 'waiting');
  assert.equal(recorder.events.some((event) => event.type === 'runtime_failed'), false);
  assert.equal(recorder.events.some((event) => event.type === 'task_rejected'), false);
  assert.ok(recorder.events.some((event) =>
    event.type === 'task_waiting' &&
    (event.metadata.payload as { reason?: string }).reason === 'capability_approval_required'
  ));
});

test('pipeline preserves pending approval as an interactive outcome', async () => {
  const service = makeService() as unknown as {
    runPipeline(session: SessionDetail, brief: TaskBrief, tasks: AgentTask[]): Promise<ExecutionOutcome>;
    runOneTask(): Promise<{ ok: false; message: string; approvalRequired: true }>;
  };
  service.runOneTask = async () => ({
    ok: false,
    message: 'Approval required.',
    approvalRequired: true
  });
  const activeSession = { ...session(), status: 'EXECUTING' as const };
  const task: AgentTask = {
    id: 'task-approval-required',
    sessionId: activeSession.id,
    title: 'Write implementation files',
    description: 'Requires high-risk tools.',
    status: 'assigned',
    dependsOnTaskIds: [],
    acceptanceCriteria: [],
    createdAt: '2026-07-03T00:00:00.000Z',
    updatedAt: '2026-07-03T00:00:00.000Z'
  };
  const brief: TaskBrief = {
    id: 'brief-approval-required',
    sessionId: activeSession.id,
    version: 1,
    goal: 'Write implementation files.',
    scope: [],
    outOfScope: [],
    constraints: [],
    acceptanceCriteria: [],
    risks: [],
    openQuestions: [],
    confirmedByUser: true,
    createdAt: '2026-07-03T00:00:00.000Z'
  };

  const outcome = await service.runPipeline(activeSession, brief, [task]);

  assert.deepEqual(outcome, { kind: 'approval_required', reason: 'Approval required.' });
});

test('work-item budget exhaustion parks the task and produces a non-retry execution outcome', async () => {
  const { recorder, service, activeSession, task, brief } = taskExecutionHarness(
    runtimeOutputExamples.task_execution_result
  );
  task.workItemId = 'work-item-budget-exhausted';
  const runRuntimeNormally = service.runRuntime;
  service.runRuntime = async (session, input) => {
    if (input.phase !== 'task_execution') return runRuntimeNormally(session, input);
    return {
    invocationId: input.invocationId,
    runtimeType: 'mock',
    status: 'failed',
    output: createAgentMessageOutput({ messageKind: 'progress', content: 'Budget exhausted.' }),
    events: [],
    artifacts: [],
    systemEvidence: createRuntimeArtifactSystemEvidence(input.invocationId),
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, model: 'mock' },
    error: {
      code: 'WORK_ITEM_BUDGET_EXHAUSTED',
      message: '当前需求的累计预算已用尽。',
      retryable: false
    }
    };
  };

  const taskOutcome = await service.runOneTask(activeSession, brief, task);

  assert.equal(taskOutcome.ok, false);
  if (taskOutcome.ok) return;
  assert.equal(taskOutcome.workItemBudgetExhausted, true);
  assert.equal(task.status, 'waiting');
  assert.ok(recorder.events.some((event) =>
    event.type === 'task_waiting' &&
    (event.metadata.payload as { reason?: string }).reason === 'work_item_budget_exhausted'
  ));
  assert.equal(recorder.events.some((event) => event.type === 'task_failed'), false);

  const pipeline = makeService() as unknown as {
    runPipeline(session: SessionDetail, brief: TaskBrief, tasks: AgentTask[]): Promise<ExecutionOutcome>;
    runOneTask(): Promise<typeof taskOutcome>;
  };
  pipeline.runOneTask = async () => taskOutcome;
  task.status = 'assigned';
  const outcome = await pipeline.runPipeline(activeSession, brief, [task]);

  assert.equal(outcome.kind, 'work_item_budget_exhausted');
  if (outcome.kind !== 'work_item_budget_exhausted') return;
  assert.equal(outcome.taskId, task.id);
  assert.equal(outcome.workItemId, task.workItemId);
  assert.equal(outcome.error.code, 'WORK_ITEM_BUDGET_EXHAUSTED');
});

test('work-item budget exhaustion during task acceptance also parks the task', async () => {
  const { recorder, service, activeSession, task, brief } = taskExecutionHarness(
    runtimeOutputExamples.task_execution_result
  );
  task.workItemId = 'work-item-budget-exhausted-at-acceptance';
  const runRuntimeNormally = service.runRuntime;
  service.runRuntime = async (session, input) => {
    if (input.phase !== 'task_acceptance') return runRuntimeNormally(session, input);
    return {
      invocationId: input.invocationId,
      runtimeType: 'mock',
      status: 'failed',
      output: createAgentMessageOutput({ messageKind: 'progress', content: 'Budget exhausted.' }),
      events: [],
      artifacts: [],
      systemEvidence: createRuntimeArtifactSystemEvidence(input.invocationId),
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, model: 'mock' },
      error: {
        code: 'WORK_ITEM_BUDGET_EXHAUSTED',
        message: '当前需求的累计预算已用尽。',
        retryable: false
      }
    };
  };

  const outcome = await service.runOneTask(activeSession, brief, task);

  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.workItemBudgetExhausted, true);
  assert.equal(task.status, 'waiting');
  assert.ok(recorder.events.some((event) =>
    event.type === 'task_waiting' &&
    (event.metadata.payload as { reason?: string }).reason === 'work_item_budget_exhausted'
  ));
  assert.equal(recorder.events.some((event) => event.type === 'task_failed'), false);
});

test('work-item budget exhaustion during terminal phases remains user-recoverable', async () => {
  const runtimeError: RuntimeError = {
    code: 'WORK_ITEM_BUDGET_EXHAUSTED',
    message: '当前需求的累计模型预算已不足。',
    retryable: false
  };
  const brief: TaskBrief = {
    id: 'brief-terminal-budget',
    sessionId: 'session-1',
    version: 1,
    goal: 'Produce a concise report.',
    scope: [],
    outOfScope: [],
    constraints: [],
    acceptanceCriteria: [],
    risks: [],
    openQuestions: [],
    confirmedByUser: true,
    createdAt: '2026-07-03T00:00:00.000Z'
  };

  for (const phase of ['post_review', 'final_delivery'] as const) {
    const service = makeService() as unknown as {
      runPipeline(session: SessionDetail, brief: TaskBrief, tasks: AgentTask[]): Promise<ExecutionOutcome>;
      runPostReview(): Promise<PostReviewReportOutput>;
      runFinalDelivery(): Promise<void>;
      latestLimitedDeliveryAction(): { limitations: string[] } | undefined;
    };
    const failure = () => Object.assign(new Error(runtimeError.message), { cause: runtimeError, runtimeError });
    if (phase === 'post_review') {
      service.runPostReview = async () => { throw failure(); };
    } else {
      service.latestLimitedDeliveryAction = () => ({ limitations: [] });
      service.runFinalDelivery = async () => { throw failure(); };
    }

    const outcome = await service.runPipeline(
      { ...session(), status: 'EXECUTING', activeWorkItemId: 'work-item-terminal-budget' },
      brief,
      []
    );

    assert.equal(outcome.kind, 'work_item_budget_exhausted', `${phase} must not become a failed Session`);
    if (outcome.kind !== 'work_item_budget_exhausted') continue;
    assert.equal(outcome.taskId, undefined, `${phase} does not invent an AgentTask`);
    assert.equal(outcome.workItemId, 'work-item-terminal-budget');
    assert.equal(outcome.error, runtimeError);
  }
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

test('cancelled pipeline preserves the structured termination from its AbortSignal', async () => {
  const service = makeService();
  const controller = new AbortController();
  const termination = createExecutionTermination({
    kind: 'user_cancelled',
    source: 'user',
    scope: 'invocation'
  });
  controller.abort(termination);
  const activeSession = { ...session(), status: 'EXECUTING' as const };
  const brief: TaskBrief = {
    id: 'brief-paused',
    sessionId: activeSession.id,
    version: 1,
    goal: 'Preserve pause termination semantics.',
    scope: [],
    outOfScope: [],
    constraints: [],
    acceptanceCriteria: [],
    risks: [],
    openQuestions: [],
    confirmedByUser: true,
    createdAt: '2026-07-03T00:00:00.000Z'
  };

  const outcome = await service.runPipeline(activeSession, brief, [], controller.signal);

  assert.equal(outcome.kind, 'cancelled');
  if (outcome.kind !== 'cancelled') return;
  assert.deepEqual(outcome.termination, termination);
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

test('brief deadline is shared by provider attempts and is cleaned up after completion', async () => {
  const service = makeService() as any;
  const old = process.env.PHASE_TIMEOUT_BRIEF_GENERATION_MS;
  process.env.PHASE_TIMEOUT_BRIEF_GENERATION_MS = '25';
  let reason: any;
  service.runRuntimeProviderAttemptsWithinDeadline = async (_s: unknown, _i: unknown, signal: AbortSignal) => {
    await new Promise<void>(resolve => signal.addEventListener('abort', () => { reason = signal.reason; resolve(); }, { once: true }));
    return { status: 'failed' };
  };
  try {
    await service.runRuntimeProviderAttempts({}, { phase: 'brief_generation' });
    assert.equal(reason.kind, 'phase_timeout');
    let completedSignal: AbortSignal | undefined;
    service.runRuntimeProviderAttemptsWithinDeadline = async (_s: unknown, _i: unknown, signal: AbortSignal) => { completedSignal = signal; return { status: 'completed' }; };
    await service.runRuntimeProviderAttempts({}, { phase: 'brief_generation' });
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(completedSignal?.aborted, false);
  } finally {
    if (old === undefined) delete process.env.PHASE_TIMEOUT_BRIEF_GENERATION_MS;
    else process.env.PHASE_TIMEOUT_BRIEF_GENERATION_MS = old;
  }
});
