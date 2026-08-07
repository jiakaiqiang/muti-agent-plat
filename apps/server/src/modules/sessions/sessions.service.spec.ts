import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentTask, SessionDetail, WorkspaceWritebackRecord } from '@agent-cluster/shared';
import { SessionsService } from './sessions.service.js';

async function waitFor(predicate: () => boolean, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for asynchronous Session state.');
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

function makeService(options: {
  failHydration?: boolean;
  cleanupCalls?: string[];
  runtimeCalls?: string[];
  permissionGrants?: string[];
  executionRunning?: boolean;
  initialSessions?: SessionDetail[];
  localWorkspace?: {
    workspaceId: string;
    displayName: string;
    files?: Record<string, string>;
    runtimeTypes?: Array<'codex' | 'claude_code'>;
  };
  fileRevisions?: unknown;
  fileRevisionDispatches?: string[];
  fileRevisionContinuations?: string[];
  receiverAvailable?: boolean;
  taskItems?: AgentTask[];
  workspaceWritebacks?: {
    list(sessionId: string): WorkspaceWritebackRecord[];
    resolve(session: SessionDetail, writebackId: string, input: unknown): Promise<WorkspaceWritebackRecord>;
  };
  capabilityChecks?: Record<string, boolean>;
  workflowResumeCalls?: string[];
  followUpHandlingPlan?: {
    requirementRelation: 'continuation' | 'new_requirement';
    failedExecutionAction: 'none' | 'resume' | 'replan';
  };
} = {}) {
  const persistedSessions: SessionDetail[] = structuredClone(options.initialSessions ?? []);
  const persistedSnapshots: SessionDetail[][] = [];
  const events: Array<Record<string, unknown>> = [];
  const executionStarts: Array<{ sessionId: string; taskCount: number }> = [];
  const executionCancels: string[] = [];
  const executionTerminations: unknown[] = [];
  const discussionTerminations: unknown[] = [];
  const cancelledTasks: Array<{ sessionId: string; reason: string }> = [];
  const discussionStarts: string[] = [];
  const followUpRecognitions: string[] = [];
  const followUpPreparations: Array<{ content: string; mentionedAgentIds: string[] }> = [];
  const eventOnceKeys = new Set<string>();
  const findAgentById = (id: string) => {
    if (id === 'coordinator' && options.receiverAvailable === false) return undefined;
    return {
      id,
      key: id,
      name: id,
      role: id,
      status: 'active' as const,
      capabilityIds: [],
      defaultKnowledgeBaseIds: [],
      createdAt: '2026-07-11T00:00:00.000Z',
      updatedAt: '2026-07-11T00:00:00.000Z'
    };
  };
  const service = new SessionsService(
    {
      resolveIds(agentIds?: string[]) {
        return agentIds ?? ['coordinator'];
      },
      findByIdOrKey(id: string) {
        return findAgentById(id);
      },
      findSystemByKey(key: string) {
        return key === 'coordinator' ? findAgentById(key) : undefined;
      },
      list() {
        return [];
      },
      listForSurface() {
        return [];
      }
    } as never,
    {
      create(input: Record<string, unknown>) {
        const event = {
          id: `event-${events.length + 1}`,
          createdAt: '2026-07-11T00:00:00.000Z',
          ...input
        };
        events.push(event);
        return event;
      },
      createOnce(key: string, input: Record<string, unknown>) {
        if (eventOnceKeys.has(key)) return undefined;
        eventOnceKeys.add(key);
        const event = {
          id: `event-${events.length + 1}`,
          createdAt: '2026-07-11T00:00:00.000Z',
          ...input
        };
        events.push(event);
        return event;
      },
      list() {
        return events;
      },
      deleteSession() {}
    } as never,
    {
      create(input: Record<string, unknown>) {
        return { id: `memory-${events.length + 1}`, ...input };
      },
      deleteSession() {}
    } as never,
    {
      recognizeTask() {
        return { domain: 'coding', intent: 'implementation', requiresCodeChanges: true };
      },
      recognizeUserMessage() {
        return {
          intent: 'command',
          priority: 'normal',
          shouldPause: false,
          affectedTaskIds: [],
          affectedAgentIds: [],
          requiresBriefRevision: false,
          requiresUserConfirmation: false,
          coordinatorInstruction: 'ok'
        };
      }
    } as never,
    {
      async recognizeFollowUpMessage() {
        followUpRecognitions.push('recognized');
        return {
          intent: 'command',
          requirementRelation: options.followUpHandlingPlan?.requirementRelation ?? 'continuation',
          failedExecutionAction: options.followUpHandlingPlan?.failedExecutionAction ?? 'none',
          priority: 'normal',
          shouldPause: false,
          affectedTaskIds: [],
          affectedAgentIds: [],
          requiresBriefRevision: false,
          requiresUserConfirmation: false,
          coordinatorInstruction: 'receiver recognized intent'
        };
      },
      async prepareFollowUpExecution(
        session: SessionDetail,
        content: string,
        _sourceEventId: string,
        mentionedAgentIds: string[],
        _options?: unknown
      ) {
        followUpPreparations.push({ content, mentionedAgentIds });
        return {
          brief: {
            id: `follow-up-brief-${followUpPreparations.length}`,
            sessionId: session.id,
            version: followUpPreparations.length,
            goal: content,
            scope: [content],
            outOfScope: [],
            constraints: [],
            acceptanceCriteria: [],
            risks: [],
            openQuestions: [],
            confirmedByUser: true,
            createdAt: '2026-07-11T00:00:00.000Z'
          },
          tasks: [{ id: `follow-up-task-${followUpPreparations.length}` }]
        };
      },
      discussAndCreateBrief(_session: SessionDetail, signal?: AbortSignal) {
        discussionStarts.push('started');
        return new Promise((_resolve, reject) => {
          if (signal?.aborted) reject(signal.reason);
          else signal?.addEventListener('abort', () => {
            discussionTerminations.push(signal.reason);
            reject(signal.reason);
          }, { once: true });
        });
      },
      getBrief(sessionId: string, briefId: string) {
        return {
          id: briefId,
          sessionId,
          version: 1,
          goal: 'Review with explicit user action routing.',
          scope: [],
          outOfScope: [],
          constraints: [],
          acceptanceCriteria: [],
          risks: [],
          openQuestions: [],
          confirmedByUser: true,
          createdAt: '2026-07-11T00:00:00.000Z'
        };
      },
      async hydrateSupplementalContext(_session: SessionDetail, requestedContext: { requestedFiles?: Array<{ path: string }> }) {
        const requestedFiles = requestedContext.requestedFiles ?? [];
        const requestedPaths = requestedFiles.map((item) => item.path);
        const hydratedPaths = options.failHydration ? [] : requestedPaths;
        return {
          requestedFiles,
          hydratedPaths,
          resolvedRefs: [],
          failedRefs: [],
          failedPaths: options.failHydration
            ? requestedPaths.map((path) => ({ path, code: 'BROKER_OFFLINE', retryable: true }))
            : [],
          deferredPaths: [],
          contentBytes: hydratedPaths.length * 10,
          outcome: options.failHydration ? 'exhausted' : 'resolved',
          attempt: 1,
          maxAttempts: 1
        };
      },
      registerSavePendingInvocationCallback() {},
      ensureArchitectureReportSaveConfirmation() {},
      async processFileRevision(_session: SessionDetail, revisionId: string) {
        options.fileRevisionDispatches?.push(revisionId);
        await new Promise((resolve) => setImmediate(resolve));
        return { id: revisionId };
      },
      async continueFileRevisionAfterPartialFailure(_session: SessionDetail, revisionId: string) {
        options.fileRevisionContinuations?.push(revisionId);
        await new Promise((resolve) => setImmediate(resolve));
        return { id: revisionId };
      },
      deleteSession() {}
    } as never,
    {
      start(session: SessionDetail, _brief: unknown, tasks: unknown[]) {
        executionStarts.push({ sessionId: session.id, taskCount: tasks.length });
      },
      isRunning() {
        return options.executionRunning ?? false;
      },
      cancel(sessionId: string, termination?: unknown) {
        executionCancels.push(sessionId);
        if (termination) executionTerminations.push(termination);
      },
      async cancelAndWait(sessionId: string, termination: unknown) {
        executionCancels.push(sessionId);
        executionTerminations.push(termination);
        options.cleanupCalls?.push(`terminate:${sessionId}`);
        return { requested: true, completed: true, timedOut: false };
      }
    } as never,
    {
      resetStaleRunning(sessionId: string) {
        for (const task of options.taskItems ?? []) {
          if (task.sessionId === sessionId && task.status === 'running') task.status = 'pending';
        }
      },
      list(sessionId: string) {
        return (options.taskItems ?? []).filter((task) => task.sessionId === sessionId);
      },
      find(sessionId: string, taskId: string) {
        return (options.taskItems ?? []).find((task) => task.sessionId === sessionId && task.id === taskId);
      },
      update(task: AgentTask, patch: Partial<AgentTask>) {
        Object.assign(task, patch);
        return task;
      },
      unfinished(sessionId: string) {
        return (options.taskItems ?? []).filter((task) =>
          task.sessionId === sessionId &&
          ['pending', 'assigned', 'accepted', 'claimed', 'running', 'waiting', 'blocked', 'reworking'].includes(task.status)
        );
      },
      cancelUnfinished(sessionId: string, reason: string) {
        cancelledTasks.push({ sessionId, reason });
        return undefined;
      },
      interruptUnfinished(sessionId: string, reason: string) {
        cancelledTasks.push({ sessionId, reason });
        return undefined;
      },
      deleteSession() {}
    } as never,
    {
      getCollection() {
        return persistedSessions;
      },
      assertWritable() {},
      currentDataEpoch() {
        return 'epoch-test';
      },
      async acquireWorkspaceSessionLease() {
        return true;
      },
      async releaseWorkspaceSessionLease() {},
      setCollection(_key: string, value: SessionDetail[]) {
        persistedSnapshots.push(structuredClone(value));
        persistedSessions.splice(0, persistedSessions.length, ...value);
      }
    } as never,
    {
      checkInvocation(capabilityId: string) {
        return { allowed: options.capabilityChecks?.[capabilityId] ?? true };
      },
      registerApprovalListener() {}
    } as never,
    undefined,
    options.workflowResumeCalls ? {
      updates() {
        return { subscribe() { return { unsubscribe() {} }; } };
      },
      async resumeCurrentExecution(runId: string) {
        options.workflowResumeCalls!.push(runId);
        return true;
      },
      get() {
        return { status: 'failed' };
      }
    } as never : undefined,
    options.cleanupCalls ? { async deleteSessionDirectory(sessionId: string) { options.cleanupCalls!.push(`worktree:${sessionId}`); } } as never : undefined,
    options.cleanupCalls ? { deleteSessionDirectory(sessionId: string) { options.cleanupCalls!.push(`brief:${sessionId}`); } } as never : undefined,
    options.runtimeCalls ? {
      async cancelSessionAndWait(sessionId: string) {
        options.runtimeCalls!.push(`runtime:${sessionId}`);
        return { requested: 1, completed: 1, timedOut: false };
      }
    } as never : undefined,
    options.localWorkspace ? {
      getWorkspace(workspaceId: string) {
        if (workspaceId !== options.localWorkspace?.workspaceId) return undefined;
        return {
          workspaceId,
          displayName: options.localWorkspace.displayName,
          capabilities: { read: true, write: true, command: true, test: true },
          revision: { id: 'local-revision', observedAt: '2026-07-24T00:00:00.000Z' }
        };
      },
      isRuntimeAvailable(workspaceId: string, runtimeType: string) {
        return workspaceId === options.localWorkspace?.workspaceId
          && (options.localWorkspace.runtimeTypes ?? ['codex']).includes(runtimeType as 'codex' | 'claude_code');
      },
      async grantWorkspacePermissionOnce(workspaceId: string, permission: string) {
        options.permissionGrants?.push(`${workspaceId}:${permission}`);
        return { workspaceId, displayName: options.localWorkspace?.displayName };
      },
      interruptions() {
        return { subscribe() { return { unsubscribe() {} }; } };
      }
    } as never : undefined,
    {
      resolveWorkingDirectory(workingDirectory: { kind?: string }) {
        if (workingDirectory.kind === 'local_bridge') {
          return options.localWorkspace
            ? localWorkspaceProvider(options.localWorkspace.files ?? { 'README.md': '# local project\n' })
            : undefined;
        }
        if (workingDirectory.kind === 'server_local') {
          const revision = { id: 'server-revision', observedAt: '2026-07-24T00:00:00.000Z' };
          return {
            kind: 'server_local',
            capabilities: () => ({ read: true, write: true, command: true, test: true }),
            getRevision: async () => revision,
            listDirectory: async () => { throw new Error('Session creation must not list the workspace.'); },
            readFile: async () => { throw new Error('Session creation must not read workspace files.'); }
          };
        }
        return undefined;
      }
    } as never,
    options.fileRevisions as never,
    options.workspaceWritebacks as never
  );
  return {
    service,
    persistedSessions,
    persistedSnapshots,
    events,
    executionStarts,
    executionCancels,
    executionTerminations,
    discussionStarts,
    followUpPreparations,
    followUpRecognitions,
    discussionTerminations,
    cancelledTasks
  };
}

test('completed capability approvals resume the waiting task through the execution pipeline', async () => {
  const session: SessionDetail = {
    id: 'session-capability-resume',
    dataEpoch: 'epoch-test',
    title: 'Capability resume',
    originalInput: 'Write implementation files.',
    status: 'WAIT_USER_DECISION',
    ownerId: 'local-user',
    workspaceId: 'workspace-capability-resume',
    tokenUsed: 0,
    currentTaskBriefId: 'brief-capability-resume',
    participatingAgentIds: ['backend'],
    pendingInvocations: [{
      invocationId: 'invocation-capability-resume',
      sessionId: 'session-capability-resume',
      taskId: 'task-capability-resume',
      agentId: 'backend',
      phase: 'task_execution',
      pendingApprovals: [
        {
          toolId: 'cap-command-run',
          toolKey: 'tool.command_run',
          approvalId: 'approval-command',
          reasons: ['HUMAN_APPROVAL_REQUIRED']
        },
        {
          toolId: 'cap-file-write',
          toolKey: 'tool.file_write',
          approvalId: 'approval-write',
          reasons: ['HUMAN_APPROVAL_REQUIRED']
        }
      ],
      createdAt: '2026-07-31T00:00:00.000Z'
    }],
    createdAt: '2026-07-31T00:00:00.000Z',
    updatedAt: '2026-07-31T00:00:00.000Z'
  };
  const task: AgentTask = {
    id: 'task-capability-resume',
    sessionId: session.id,
    title: 'Write implementation files',
    description: 'Use command and file tools.',
    status: 'waiting',
    assignee: { type: 'agent', id: 'backend' },
    dependsOnTaskIds: [],
    acceptanceCriteria: [],
    createdAt: session.createdAt,
    updatedAt: session.updatedAt
  };
  const fixture = makeService({
    initialSessions: [session],
    taskItems: [task],
    capabilityChecks: {
      'cap-command-run': true,
      'cap-file-write': true
    }
  });

  await fixture.service.retryPendingApprovalTasks(session.id, 'cap-file-write');
  await new Promise<void>((resolve) => setImmediate(resolve));

  const resumedSession = fixture.service.get(session.id);
  assert.deepEqual(resumedSession.pendingInvocations, []);
  assert.equal(resumedSession.status, 'EXECUTING');
  assert.equal(task.status, 'pending');
  assert.equal(fixture.executionStarts.length, 1);
  assert.deepEqual(fixture.executionStarts[0], { sessionId: session.id, taskCount: 1 });
});

test('file revision background dispatch is single-flight per revision id', async () => {
  const dispatches: string[] = [];
  const fixture = makeService({
    fileRevisionDispatches: dispatches,
    fileRevisions: {
      getRun() {
        return { status: 'submitted' };
      }
    }
  });
  const dispatch = fixture.service as unknown as {
    dispatchFileRevisionProcessing(session: SessionDetail, revisionId: string): void;
  };
  const session = { id: 'session-revision-dispatch' } as SessionDetail;

  dispatch.dispatchFileRevisionProcessing(session, 'revision-single-flight');
  dispatch.dispatchFileRevisionProcessing(session, 'revision-single-flight');
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(dispatches, ['revision-single-flight']);
});

test('file revision start rejects before creating a run when the system Receiver is unavailable', async () => {
  let createRunCalled = false;
  const session = {
    id: 'session-without-receiver',
    dataEpoch: 'epoch-test',
    title: 'File revision without Receiver',
    originalInput: 'Process a file revision.',
    status: 'COMPLETED',
    ownerId: 'user-test',
    workspaceId: 'default-workspace',
    participatingAgentIds: ['backend'],
    createdAt: '2026-07-29T00:00:00.000Z',
    updatedAt: '2026-07-29T00:00:00.000Z'
  } as SessionDetail;
  const fixture = makeService({
    receiverAvailable: false,
    initialSessions: [session],
    fileRevisions: {
      listChains() {
        return [];
      },
      async createRun() {
        createRunCalled = true;
        throw new Error('createRun must not be called');
      }
    }
  });

  await assert.rejects(
    fixture.service.startFileRevision(session.id, {
      baselineId: 'baseline-1',
      targetAgentIds: ['backend']
    }),
    /REVISION_RECEIVER_UNAVAILABLE/
  );
  assert.equal(createRunCalled, false);
});

test('file revision applied event exposes post-apply baseline status without raw errors', async () => {
  const candidateHash = { algorithm: 'sha256' as const, value: 'a'.repeat(64) };
  const run = {
    id: 'revision-applied-event',
    chainId: 'chain-applied-event',
    iteration: 1,
    filePath: 'result.md',
    status: 'awaiting_confirmation',
    confirmationId: 'confirmation-applied-event',
    candidateHash
  };
  const session = {
    id: 'session-applied-event',
    dataEpoch: 'epoch-test',
    title: 'Applied event privacy',
    originalInput: 'Apply a file revision candidate.',
    status: 'WAIT_USER_DECISION',
    ownerId: 'user-test',
    workspaceId: 'default-workspace',
    participatingAgentIds: ['coordinator', 'backend'],
    createdAt: '2026-07-29T00:00:00.000Z',
    updatedAt: '2026-07-29T00:00:00.000Z'
  } as SessionDetail;
  const fixture = makeService({
    initialSessions: [session],
    fileRevisions: {
      getRun() {
        return run;
      },
      async applyCandidate() {
        run.status = 'applied';
        return {
          run,
          chain: { id: run.chainId, postApplyBaselineStatus: 'failed' },
          applied: true,
          persistenceRecoveryRequired: false,
          postApplyBaselineError: 'POST_APPLY_PROVIDER_SECRET',
          changeSet: { id: 'changeset-applied-event' },
          result: { ok: true, revision: { id: 'workspace-revision', observedAt: '2026-07-29T00:00:00.000Z' } }
        };
      }
    }
  });
  fixture.events.push({
    sessionId: session.id,
    type: 'user_confirmation_requested',
    metadata: {
      payload: {
        confirmationId: run.confirmationId,
        reason: 'confirm_file_revision_apply'
      }
    }
  });

  await fixture.service.decideFileRevision(session.id, run.id, {
    confirmationId: run.confirmationId,
    candidateHash,
    expectedStateVersion: 1,
    decision: 'apply_candidate'
  });

  const event = fixture.events.find((item) => item.type === 'file_revision_applied');
  assert.ok(event);
  assert.equal((event.metadata as { payload?: { postApplyBaselineStatus?: string } }).payload?.postApplyBaselineStatus, 'failed');
  assert.doesNotMatch(JSON.stringify(event), /POST_APPLY_PROVIDER_SECRET/);
});

test('partial file revision failure decision resumes only Receiver synthesis when requested', async () => {
  const continuations: string[] = [];
  const run = {
    id: 'revision-partial',
    chainId: 'chain-partial',
    status: 'failed',
    errorCode: 'REVISION_PARTIAL_AGENT_FAILURE',
    agentResults: [
      { id: 'result-ok', status: 'completed' },
      { id: 'result-failed', status: 'failed' }
    ]
  };
  const chain = { id: run.chainId, status: 'failed', stateVersion: 4 };
  const fixture = makeService({
    fileRevisionContinuations: continuations,
    fileRevisions: {
      getRun() {
        return run;
      },
      async resolvePartialFailure(_sessionId: string, _revisionId: string, input: { decision: string }) {
        run.status = input.decision === 'continue_with_successful' ? 'processing' : 'submitted';
        chain.status = 'active';
        chain.stateVersion += 1;
        return { run, chain, decision: input.decision };
      }
    }
  });
  const { session } = await fixture.service.create({ input: 'Resolve a partial file revision failure.' });
  session.status = 'WAIT_USER_DECISION';

  await fixture.service.resolveFileRevisionFailure(session.id, run.id, {
    expectedStateVersion: 4,
    decision: 'continue_with_successful'
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(continuations, [run.id]);
  assert.equal(session.status, 'WAIT_USER_DECISION');
  assert.ok(fixture.events.some((event) => event.type === 'file_revision_failure_resolved'));
});

test('interrupted file revision public retry dispatches only the recovered stage', async () => {
  const dispatches: string[] = [];
  const continuations: string[] = [];
  const runs = new Map([
    ['revision-agent-retry', { id: 'revision-agent-retry', chainId: 'chain-agent-retry', status: 'submitted' }],
    ['revision-receiver-retry', { id: 'revision-receiver-retry', chainId: 'chain-receiver-retry', status: 'processing' }],
    ['revision-apply-reconcile', { id: 'revision-apply-reconcile', chainId: 'chain-apply-reconcile', status: 'awaiting_confirmation' }]
  ]);
  const fixture = makeService({
    fileRevisionDispatches: dispatches,
    fileRevisionContinuations: continuations,
    fileRevisions: {
      getRun(_sessionId: string, revisionId: string) {
        return runs.get(revisionId);
      },
      async retryInterrupted(_session: SessionDetail, revisionId: string) {
        const run = runs.get(revisionId)!;
        const mode = revisionId === 'revision-agent-retry'
          ? 'run_agents'
          : revisionId === 'revision-receiver-retry'
            ? 'receiver_only'
            : 'apply_reconcile';
        return {
          run,
          chain: { id: run.chainId, status: 'active', stateVersion: 5 },
          mode
        };
      }
    }
  });
  const { session } = await fixture.service.create({ input: 'Retry interrupted file revisions.' });

  await fixture.service.retryInterruptedFileRevision(session.id, 'revision-agent-retry', {
    expectedStateVersion: 4,
    retryKey: 'retry-agent'
  });
  await fixture.service.retryInterruptedFileRevision(session.id, 'revision-receiver-retry', {
    expectedStateVersion: 4,
    retryKey: 'retry-receiver'
  });
  await fixture.service.retryInterruptedFileRevision(session.id, 'revision-apply-reconcile', {
    expectedStateVersion: 4,
    retryKey: 'retry-apply'
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(dispatches, ['revision-agent-retry']);
  assert.deepEqual(continuations, ['revision-receiver-retry']);
  assert.equal(
    fixture.events.find((event) => (
      event.metadata as { payload?: { retryMode?: string } }
    )?.payload?.retryMode === 'apply_reconcile')?.content,
    '文件修订已恢复，系统已根据当前 Workspace 状态完成写回结果核对。'
  );
});

function localWorkspaceProvider(files: Record<string, string>) {
  const revision = { id: 'local-revision', observedAt: '2026-07-24T00:00:00.000Z' };
  return {
    kind: 'local_bridge',
    capabilities: () => ({ read: true, write: true, command: true, test: true }),
    getRevision: async () => revision,
    listDirectory: async () => ({
      path: '.',
      revision,
      entries: Object.entries(files).map(([path, content]) => ({
        path,
        kind: 'file',
        size: Buffer.byteLength(content),
        hash: { algorithm: 'sha256', value: `hash-${path}` },
        revision
      }))
    }),
    readFile: async ({ path }: { path: string }) => ({
      path,
      content: files[path] ?? '',
      encoding: 'utf-8',
      byteLength: Buffer.byteLength(files[path] ?? ''),
      truncated: false,
      revision,
      hash: { algorithm: 'sha256', value: `hash-${path}` },
      startLine: 1,
      endLine: (files[path] ?? '').split(/\r?\n/).length
    }),
    statFile: async () => { throw new Error('not used'); },
    searchText: async () => { throw new Error('not used'); },
    applyChangeSet: async () => { throw new Error('not used'); }
  };
}

test('Local Runtime disconnect interrupts the invocation and persists a wakeable Session state', async () => {
  const runtimeCalls: string[] = [];
  const fixture = makeService({ runtimeCalls });
  const { session } = await fixture.service.create({ input: 'Stop the invocation when Local Runtime disconnects' });

  const cancelled = await fixture.service.interruptForRuntimeDisconnect({
    sessionId: session.id,
    invocationId: 'invocation-1',
    reason: 'local_runtime_disconnected',
    occurredAt: '2026-07-24T00:00:00.000Z'
  });

  assert.equal(cancelled, true);
  assert.equal(session.status, 'INTERRUPTED');
  assert.deepEqual(session.interruption, {
    reason: 'local_runtime_disconnected',
    invocationId: 'invocation-1',
    occurredAt: '2026-07-24T00:00:00.000Z',
    wakeable: true
  });
  assert.deepEqual(fixture.persistedSnapshots.at(-1)?.[0]?.interruption, session.interruption);
  assert.deepEqual(fixture.executionCancels, [session.id]);
  assert.equal((fixture.executionTerminations[0] as { kind?: string })?.kind, 'runtime_disconnected');
  assert.equal((fixture.discussionTerminations[0] as { kind?: string })?.kind, 'runtime_disconnected');
  assert.deepEqual(runtimeCalls, [`runtime:${session.id}`]);
  assert.deepEqual(fixture.cancelledTasks, [{
    sessionId: session.id,
    reason: 'Local Runtime disconnected; waiting for a future user wake-up.'
  }]);
  const cancellationEvent = fixture.events.find((event) =>
    event.type === 'session_status_changed' &&
    (event.metadata as { payload?: { reason?: string } })?.payload?.reason === 'local_runtime_disconnected'
  );
  assert.ok(cancellationEvent);
  assert.equal(
    ((cancellationEvent.metadata as { payload?: { termination?: { kind?: string } } }).payload?.termination?.kind),
    'runtime_disconnected'
  );
  assert.equal(await fixture.service.interruptForRuntimeDisconnect({
    sessionId: session.id,
    invocationId: 'invocation-1',
    reason: 'local_runtime_disconnected',
    occurredAt: '2026-07-24T00:00:00.000Z'
  }), false);
});

test('backend shutdown persists active work as wakeable and ignores late execution outcomes', async () => {
  const fixture = makeService();
  const { session } = await fixture.service.create({ input: 'Do not automatically resume after a backend restart' });

  fixture.service.beforeApplicationShutdown('SIGTERM');

  assert.equal(session.status, 'INTERRUPTED');
  assert.deepEqual(session.interruption, {
    reason: 'service_shutdown',
    invocationId: undefined,
    occurredAt: session.interruption?.occurredAt,
    wakeable: true
  });
  assert.deepEqual(fixture.persistedSnapshots.at(-1)?.[0]?.interruption, session.interruption);
  assert.equal((fixture.discussionTerminations[0] as { kind?: string })?.kind, 'service_shutdown');
  assert.deepEqual(fixture.cancelledTasks, [{
    sessionId: session.id,
    reason: 'Platform backend stopped; waiting for a future user wake-up.'
  }]);
  const shutdownEvent = fixture.events.find((event) =>
    event.type === 'session_status_changed' &&
    (event.metadata as { payload?: { reason?: string } })?.payload?.reason === 'service_shutdown'
  );
  assert.equal(
    ((shutdownEvent?.metadata as { payload?: { termination?: { kind?: string; graceful?: boolean } } })
      ?.payload?.termination?.kind),
    'service_shutdown'
  );
  assert.equal(
    ((shutdownEvent?.metadata as { payload?: { termination?: { graceful?: boolean } } })
      ?.payload?.termination?.graceful),
    true
  );

  fixture.service.applyOutcome(session.id, { kind: 'delivered' });
  assert.equal(session.status, 'INTERRUPTED');
});

test('pause stops Session execution and Runtime work while preserving a resumable checkpoint', async () => {
  const runtimeCalls: string[] = [];
  const fixture = makeService({ runtimeCalls });
  const { session } = await fixture.service.create({ input: 'Pause and resume the current workflow invocation' });
  session.status = 'EXECUTING';

  await fixture.service.pause(session.id, '用户停止当前执行');

  assert.equal(session.status, 'PAUSED');
  assert.equal(session.pauseState?.previousStatus, 'EXECUTING');
  assert.equal((fixture.executionTerminations[0] as { kind?: string })?.kind, 'user_paused');
  assert.equal((fixture.executionTerminations[0] as { scope?: string })?.scope, 'session');
  assert.deepEqual(runtimeCalls, [`runtime:${session.id}`]);

  fixture.service.resume(session.id, '用户恢复当前执行');
  assert.equal(session.pauseState, undefined);
  fixture.service.control(session.id, 'CANCELLED', '用户取消整个会话');

  assert.equal(session.status, 'CANCELLED');
  assert.equal((fixture.executionTerminations[1] as { kind?: string })?.kind, 'user_cancelled');
  assert.equal((fixture.executionTerminations[1] as { scope?: string })?.scope, 'session');
});

test('deleting a Session also stops Runtime-owned invocations', async () => {
  const runtimeCalls: string[] = [];
  const { service } = makeService({ runtimeCalls });
  const { session } = await service.create({ input: 'Delete while Runtime is active' });

  await service.delete(session.id);

  assert.deepEqual(runtimeCalls, [`runtime:${session.id}`]);
});

test('deleting a Session clears all corresponding runtime directories before persistence', async () => {
  const cleanupCalls: string[] = [];
  const { service, persistedSessions } = makeService({ cleanupCalls });
  const { session } = await service.create({ input: 'Delete this Session later' });

  const result = await service.delete(session.id);

  assert.deepEqual(cleanupCalls, [
    `terminate:${session.id}`,
    `worktree:${session.id}`,
    `brief:${session.id}`
  ]);
  assert.deepEqual(result, { deleted: true, sessionId: session.id });
  assert.equal(persistedSessions.length, 0);
});

test('rejects Session deletion after backend shutdown starts without removing persisted state', async () => {
  const cleanupCalls: string[] = [];
  const { service, persistedSessions } = makeService({ cleanupCalls });
  const { session } = await service.create({ input: 'Keep this Session while the backend shuts down' });

  service.beforeApplicationShutdown('SIGTERM');

  await assert.rejects(service.delete(session.id), /后端正在关闭/);
  assert.equal(persistedSessions.length, 1);
  assert.deepEqual(cleanupCalls, []);
});

test('new SessionDetail stores only the normalized Runtime preference routing input', async () => {
  const { service, persistedSessions } = makeService();
  const { session } = await service.create({
    input: 'Implement context pipeline v2',
    runtimePreference: {
      preferredRuntimeType: 'generic_llm',
      preferredModelId: ' model-1 ',
      allowedRuntimeTypes: ['generic_llm', 'generic_llm', 'codex']
    }
  });

  assert.deepEqual(session.runtimePreference, {
    preferredRuntimeType: 'generic_llm',
    preferredModelId: 'model-1',
    allowedRuntimeTypes: ['generic_llm', 'codex']
  });
  assert.equal('contextPipelineVersion' in session, false);
  assert.equal('engineeringRuntime' in session, false);
  assert.equal('executionTarget' in session, false);
  assert.equal(session.requiresCodeChanges, true);
  assert.deepEqual(persistedSessions[0]?.runtimePreference, session.runtimePreference);
  assert.equal(persistedSessions[0]?.requiresCodeChanges, true);
});

test('failed execution outcome persists structured RuntimeError in the error card', async () => {
  const { service, events } = makeService();
  const { session } = await service.create({ input: 'Trigger a contract error' });
  const runtimeError = {
    code: 'RUNTIME_OUTPUT_CONTRACT_VIOLATION' as const,
    message: 'schema mismatch',
    retryable: false,
    details: { contractId: 'runtime.output.task_brief', schemaHash: 'fnv1a32:deadbeef' }
  };

  service.applyOutcome(session.id, { kind: 'failed', reason: 'Runtime output rejected', error: runtimeError });

  const event = events.find((candidate) => candidate.type === 'error_reported');
  const metadata = event?.metadata as { payload?: { runtimeError?: unknown } } | undefined;
  assert.deepEqual(metadata?.payload?.runtimeError, runtimeError);
});

test('Local Runtime dangerous actions pause for one-time user approval and resume after the grant', async () => {
  const permissionGrants: string[] = [];
  const fixture = makeService({
    permissionGrants,
    localWorkspace: { workspaceId: 'workspace-local', displayName: 'local-project' }
  });
  const { session } = await fixture.service.create({
    input: 'Delete a generated file after confirmation',
    runtimePreference: { preferredRuntimeType: 'codex', allowedRuntimeTypes: ['codex'] },
    workingDirectory: {
      kind: 'local_bridge',
      id: 'workspace-local',
      name: 'local-project',
      selectedAt: '2026-07-25T00:00:00.000Z'
    }
  });
  session.currentTaskBriefId = 'brief-local';
  session.status = 'EXECUTING';
  fixture.service.applyOutcome(session.id, {
    kind: 'failed',
    reason: 'LOCAL_CONFIRMATION_REQUIRED: workspace_delete',
    error: {
      code: 'CAPABILITY_BLOCKED',
      message: 'LOCAL_CONFIRMATION_REQUIRED: workspace_delete',
      retryable: false,
      details: {
        confirmationRequired: true,
        permission: 'workspace_delete',
        workspaceId: 'workspace-local',
        phase: 'task_execution'
      }
    }
  });

  assert.equal(session.status, 'WAIT_USER_DECISION');
  const request = fixture.events.find((event) => event.type === 'user_confirmation_requested');
  const metadata = request?.metadata as { payload?: { confirmationId?: string; reason?: string } } | undefined;
  assert.equal(metadata?.payload?.reason, 'approve_local_runtime_permission');
  assert.ok(metadata?.payload?.confirmationId);

  await fixture.service.resolveLocalRuntimePermission(session.id, {
    confirmationId: metadata!.payload!.confirmationId!,
    decision: 'approve_once'
  });

  assert.deepEqual(permissionGrants, ['workspace-local:workspace_delete']);
  assert.equal(session.status, 'EXECUTING');
  assert.equal(fixture.executionStarts.at(-1)?.sessionId, session.id);
});

test('workflow failure events prefer the safe structured RuntimeError message', async () => {
  const { service, events } = makeService();
  const { session } = await service.create({ input: 'Resume a failed workflow' });
  const runtimeError = {
    code: 'RUNTIME_INVOCATION_ERROR' as const,
    message: 'Claude Code could not be started.',
    retryable: false,
    details: { diagnosticRef: 'workflow-safe' }
  };
  const wrapped = new Error('Command failed: claude --json-schema {"type":"object"} C:\\private\\workspace', {
    cause: runtimeError
  });

  (service as unknown as {
    failSession(session: SessionDetail, error: unknown, phase: string): void;
  }).failSession(session, wrapped, 'workflow_resume');

  const failureEvents = events.filter((candidate) =>
    candidate.type === 'session_status_changed' || candidate.type === 'error_reported'
  );
  assert.equal(failureEvents.length, 2);
  for (const event of failureEvents) {
    assert.match(String(event.content), /Claude Code could not be started/);
    assert.doesNotMatch(JSON.stringify(event), /json-schema|private|workspace/i);
  }
});

test('brief workflow failures surface the actual Runtime phase from structured error details', async () => {
  const { service, events } = makeService();
  const { session } = await service.create({ input: 'Discuss before generating a brief' });
  const runtimeError = {
    code: 'RUNTIME_TIMEOUT' as const,
    message: 'Claude model gateway timed out (HTTP 524).',
    retryable: true,
    details: { providerFailure: true, httpStatus: 524, phase: 'discussion' }
  };
  const wrapped = Object.assign(new Error(runtimeError.message), { cause: runtimeError, runtimeError });

  (service as unknown as {
    failSessionWithFullError(session: SessionDetail, error: unknown, phase: string): void;
  }).failSessionWithFullError(session, wrapped, 'brief_generation');

  const failureEvents = events.filter((candidate) =>
    candidate.type === 'session_status_changed' || candidate.type === 'error_reported'
  );
  assert.equal(failureEvents.length, 2);
  for (const event of failureEvents) {
    const metadata = event.metadata as { payload?: { phase?: string; phaseLabel?: string } };
    const payload = metadata.payload;
    assert.equal(payload?.phase, 'discussion');
    assert.equal(payload?.phaseLabel, 'Agent 讨论');
    assert.match(String(event.content), /会话在Agent 讨论阶段失败/);
  }
});

test('an idle existing Session routes a new message through receiver decomposition and starts execution', async () => {
  const { service, executionStarts, followUpPreparations } = makeService();
  const { session } = await service.create({ input: 'Analyze the workspace' });
  (service as unknown as { briefGenerationRuns: Map<string, unknown> }).briefGenerationRuns.delete(session.id);
  session.status = 'COMPLETED';

  const result = await service.sendMessage(session.id, '继续补充实现审计日志', ['backend']);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(result.deferred, false);
  assert.deepEqual(followUpPreparations, [
    { content: '继续补充实现审计日志', mentionedAgentIds: ['backend'] }
  ]);
  assert.equal(executionStarts.length, 1);
  assert.equal(session.status, 'EXECUTING');
  assert.equal(session.pendingFollowUpMessages?.[0]?.status, 'executing');
});

test('a message received during execution is recognized immediately but deferred without interrupting the task', async () => {
  const { service, executionStarts, followUpPreparations, events } = makeService({ executionRunning: true });
  const { session } = await service.create({ input: 'Analyze the workspace' });
  session.status = 'EXECUTING';

  const result = await service.sendMessage(session.id, '@backend 完成后增加缓存', ['backend']);

  assert.equal(result.deferred, true);
  assert.equal(followUpPreparations.length, 0);
  assert.equal(executionStarts.length, 0);
  assert.equal(session.pendingFollowUpMessages?.[0]?.status, 'queued');
  assert.ok(events.some((event) =>
    event.type === 'session_status_changed' &&
    (event.metadata as { payload?: { reason?: string } }).payload?.reason ===
      'follow_up_deferred_until_current_task_finishes'
  ));
});

test('a message received while paused remains queued without invoking the Receiver Runtime', async () => {
  const { service, executionStarts, followUpPreparations, followUpRecognitions } = makeService();
  const { session } = await service.create({ input: 'Analyze the workspace' });
  (service as unknown as { briefGenerationRuns: Map<string, unknown> }).briefGenerationRuns.delete(session.id);
  session.status = 'PAUSED';
  session.pauseState = {
    previousStatus: 'EXECUTING',
    pausedAt: '2026-08-01T00:00:00.000Z'
  };

  const result = await service.sendMessage(session.id, '继续时补充审计日志', ['backend']);

  assert.equal(result.deferred, true);
  assert.equal(session.status, 'PAUSED');
  assert.equal(followUpPreparations.length, 0);
  assert.equal(followUpRecognitions.length, 0);
  assert.equal(executionStarts.length, 0);
  assert.equal(session.pendingFollowUpMessages?.[0]?.status, 'queued');
  assert.equal(session.pendingFollowUpMessages?.[0]?.receiverRecognitionPending, true);

  session.status = 'COMPLETED';
  await (service as unknown as { processNextFollowUp(sessionId: string): Promise<void> })
    .processNextFollowUp(session.id);

  assert.equal(followUpRecognitions.length, 1);
  assert.equal(followUpPreparations.length, 1);
  assert.equal(executionStarts.length, 1);
  assert.equal(session.pendingFollowUpMessages?.[0]?.receiverRecognitionPending, undefined);
});

test('message ingress replays the durable event and follow-up for the same Idempotency-Key', async () => {
  const fixture = makeService();
  const { session } = await fixture.service.create({ input: 'Analyze the workspace' });
  (fixture.service as unknown as { briefGenerationRuns: Map<string, unknown> }).briefGenerationRuns.delete(session.id);
  session.status = 'PAUSED';
  session.pauseState = {
    previousStatus: 'EXECUTING',
    pausedAt: '2026-08-07T00:00:00.000Z'
  };

  const first = await fixture.service.sendMessage(session.id, '继续时增加审计日志', [], 'client-message-1');
  const replay = await fixture.service.sendMessage(session.id, '这段内容不会再次落库', [], 'client-message-1');

  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.event.id, first.event.id);
  assert.equal(replay.followUpMessageId, first.followUpMessageId);
  assert.equal(session.pendingFollowUpMessages?.length, 1);
  assert.equal(fixture.events.filter((event) =>
    event.type === 'user_message' &&
    (event.metadata as { idempotencyKey?: string } | undefined)?.idempotencyKey === 'message:' + session.id + ':client-message-1'
  ).length, 1);
});

test('a continuation after failure resumes the previous brief instead of creating a new follow-up brief', async () => {
  const failedTask: AgentTask = {
    id: 'failed-task',
    sessionId: 'placeholder',
    title: 'Implement current requirement',
    description: 'Continue the previous work',
    status: 'failed',
    dependsOnTaskIds: [],
    acceptanceCriteria: [],
    resultSummary: 'Runtime unavailable',
    createdAt: '2026-07-11T00:00:00.000Z',
    updatedAt: '2026-07-11T00:00:00.000Z'
  };
  const fixture = makeService({
    taskItems: [failedTask],
    followUpHandlingPlan: { requirementRelation: 'continuation', failedExecutionAction: 'resume' }
  });
  const { session } = await fixture.service.create({ input: 'Implement current requirement' });
  (fixture.service as unknown as { briefGenerationRuns: Map<string, unknown> }).briefGenerationRuns.delete(session.id);
  failedTask.sessionId = session.id;
  session.currentTaskBriefId = 'brief-existing';
  session.status = 'FAILED';

  const result = await fixture.service.sendMessage(session.id, '继续之前失败的实现');
  assert.equal(result.handlingPlan.requirementRelation, 'continuation');
  assert.equal(result.handlingPlan.failedExecutionAction, 'resume');
  assert.equal(result.deferred, false);
  await waitFor(() => failedTask.status === 'pending');

  assert.equal(fixture.followUpPreparations.length, 0);
  assert.equal(failedTask.status, 'pending');
  assert.equal(fixture.executionStarts.length, 1);
  assert.equal(session.currentTaskBriefId, 'brief-existing');
  assert.deepEqual(session.pendingFollowUpMessages, []);
});

test('an explicit resume command bypasses Receiver misclassification after failure', async () => {
  const failedTask: AgentTask = {
    id: 'failed-task-explicit-resume',
    sessionId: 'placeholder',
    title: 'Implement current requirement',
    description: 'Continue the previous work',
    status: 'failed',
    dependsOnTaskIds: [],
    acceptanceCriteria: [],
    resultSummary: 'Runtime unavailable',
    createdAt: '2026-07-11T00:00:00.000Z',
    updatedAt: '2026-07-11T00:00:00.000Z'
  };
  const fixture = makeService({
    taskItems: [failedTask],
    followUpHandlingPlan: { requirementRelation: 'new_requirement', failedExecutionAction: 'none' }
  });
  const { session } = await fixture.service.create({ input: 'Implement current requirement' });
  (fixture.service as unknown as { briefGenerationRuns: Map<string, unknown> }).briefGenerationRuns.delete(session.id);
  failedTask.sessionId = session.id;
  session.currentTaskBriefId = 'brief-existing';
  session.status = 'FAILED';

  const result = await fixture.service.sendMessage(session.id, '继续');
  await waitFor(() => failedTask.status === 'pending');

  assert.equal(result.handlingPlan.requirementRelation, 'continuation');
  assert.equal(result.handlingPlan.failedExecutionAction, 'resume');
  assert.deepEqual(fixture.followUpRecognitions, []);
  assert.equal(fixture.followUpPreparations.length, 0);
  assert.equal(fixture.executionStarts.length, 1);
  assert.equal(session.currentTaskBriefId, 'brief-existing');
  assert.deepEqual(session.pendingFollowUpMessages, []);
});

test('a continuation after workflow failure delegates retry without reopening the failed task record', async () => {
  const failedTask: AgentTask = {
    id: 'failed-workflow-task',
    sessionId: 'placeholder',
    title: 'Retry workflow stage',
    description: 'Preserve the failed attempt and create a new workflow attempt.',
    status: 'failed',
    dependsOnTaskIds: [],
    acceptanceCriteria: [],
    resultSummary: 'Runtime failed',
    createdAt: '2026-07-11T00:00:00.000Z',
    updatedAt: '2026-07-11T00:00:00.000Z'
  };
  const workflowResumeCalls: string[] = [];
  const fixture = makeService({
    taskItems: [failedTask],
    workflowResumeCalls,
    followUpHandlingPlan: { requirementRelation: 'continuation', failedExecutionAction: 'resume' }
  });
  const { session } = await fixture.service.create({ input: 'Retry the failed workflow stage' });
  (fixture.service as unknown as { briefGenerationRuns: Map<string, unknown> }).briefGenerationRuns.delete(session.id);
  failedTask.sessionId = session.id;
  session.currentTaskBriefId = 'brief-existing';
  session.workflowRunId = 'workflow-run-failed';
  session.status = 'WAIT_USER_DECISION';

  await fixture.service.sendMessage(session.id, 'continue');
  await waitFor(() => workflowResumeCalls.length === 1);

  assert.deepEqual(workflowResumeCalls, ['workflow-run-failed']);
  assert.equal(failedTask.status, 'failed');
  assert.equal(fixture.executionStarts.length, 0);
  assert.equal(session.status, 'EXECUTING');
});

test('a new requirement after failure starts a fresh discussion and follow-up brief', async () => {
  const fixture = makeService({
    followUpHandlingPlan: { requirementRelation: 'new_requirement', failedExecutionAction: 'none' }
  });
  const { session } = await fixture.service.create({ input: 'Implement current requirement' });
  (fixture.service as unknown as { briefGenerationRuns: Map<string, unknown> }).briefGenerationRuns.delete(session.id);
  session.currentTaskBriefId = 'brief-existing';
  session.status = 'FAILED';

  const result = await fixture.service.sendMessage(session.id, '这是一个新需求：增加审计导出');
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(result.handlingPlan.requirementRelation, 'new_requirement');
  assert.equal(result.handlingPlan.failedExecutionAction, 'none');
  assert.equal(fixture.followUpPreparations.length, 1);
  assert.equal(fixture.executionStarts.length, 1);
  assert.notEqual(session.currentTaskBriefId, 'brief-existing');
});

test('queued worker outcomes close the active follow-up and publish the final Session status', async () => {
  const { service, events } = makeService();
  const { session } = await service.create({ input: 'Analyze the workspace' });
  (service as unknown as { briefGenerationRuns: Map<string, unknown> }).briefGenerationRuns.delete(session.id);
  session.status = 'EXECUTING';
  session.activeFollowUpMessageId = 'follow-up-active';
  session.pendingFollowUpMessages = [{
    id: 'follow-up-active',
    sourceEventId: 'event-follow-up',
    content: '增加缓存',
    mentionedAgentIds: ['backend'],
    handlingPlan: {
      intent: 'command',
      priority: 'normal',
      shouldPause: false,
      affectedTaskIds: [],
      affectedAgentIds: ['backend'],
      requiresBriefRevision: false,
      requiresUserConfirmation: false,
      coordinatorInstruction: 'dispatch'
    },
    status: 'executing',
    queuedAt: '2026-07-11T00:00:00.000Z'
  }];

  await service.applyQueuedExecutionOutcome(session.id, { kind: 'delivered' });

  assert.equal(session.activeFollowUpMessageId, undefined);
  assert.deepEqual(session.pendingFollowUpMessages, []);
  assert.equal(session.status, 'COMPLETED');
  assert.ok(events.some((event) =>
    event.type === 'session_status_changed' &&
    (event.metadata as { payload?: { status?: string; reason?: string } }).payload?.status === 'COMPLETED' &&
    (event.metadata as { payload?: { status?: string; reason?: string } }).payload?.reason === 'execution_delivered'
  ));
});

test('a delivered outcome starts a queued follow-up without publishing a stale completed status', async () => {
  const { service, events } = makeService();
  const { session } = await service.create({ input: 'Analyze the workspace' });
  (service as unknown as { briefGenerationRuns: Map<string, unknown> }).briefGenerationRuns.delete(session.id);
  session.status = 'EXECUTING';
  session.pendingFollowUpMessages = [{
    id: 'follow-up-queued',
    sourceEventId: 'event-follow-up',
    content: 'Add caching',
    mentionedAgentIds: ['backend'],
    handlingPlan: {
      intent: 'command',
      priority: 'normal',
      shouldPause: false,
      affectedTaskIds: [],
      affectedAgentIds: ['backend'],
      requiresBriefRevision: false,
      requiresUserConfirmation: false,
      coordinatorInstruction: 'dispatch'
    },
    status: 'queued',
    queuedAt: '2026-07-11T00:00:00.000Z'
  }];

  service.applyOutcome(session.id, { kind: 'delivered' });

  assert.notEqual(session.status, 'COMPLETED');
  assert.equal(events.some((event) =>
    event.type === 'session_status_changed' &&
    (event.metadata as { payload?: { status?: string } }).payload?.status === 'COMPLETED'
  ), false);
});

test('explicit server-local working directory is bound without scanning before persistence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-cluster-server-workspace-'));
  try {
    await writeFile(join(root, 'package.json'), '{"name":"fixture"}', 'utf8');
    const { service, persistedSessions } = makeService();
    const { session } = await service.create({
      input: 'Analyze this project',
      workingDirectory: {
        kind: 'server_local',
        id: 'client-placeholder',
        name: 'fixture',
        path: root,
        selectedAt: '2026-07-13T00:00:00.000Z'
      },
      runtimePreference: { preferredRuntimeType: 'codex', allowedRuntimeTypes: ['codex'] }
    });

    assert.equal(session.workingDirectory?.kind, 'server_local');
    assert.equal(session.workingDirectory?.path, root);
    assert.equal(session.workspaceSnapshot, undefined);
    assert.equal(session.workspaceContext?.binding.providerKind, 'server_local');
    assert.equal(session.workspaceContext?.binding.boundRevision.id, 'server-revision');
    assert.equal(session.workspaceContext?.indexComplete, false);
    assert.equal(persistedSessions[0]?.workingDirectory?.path, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('allows multiple active Sessions for the same normalized workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-cluster-workspace-lease-'));
  try {
    const { service } = makeService();
    const workingDirectory = {
      kind: 'server_local' as const,
      id: 'client-placeholder',
      name: 'lease-fixture',
      path: root,
      selectedAt: '2026-07-13T00:00:00.000Z'
    };
    const first = await service.create({ input: 'First active task', workingDirectory });

    const second = await service.create({ input: 'Second active task', workingDirectory });
    assert.notEqual(second.session.id, first.session.id);
    assert.equal(second.session.workspaceId, first.session.workspaceId);
    assert.equal(first.session.status, 'AGENT_DISCUSSING');
    assert.equal(second.session.status, 'AGENT_DISCUSSING');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('persisted interrupted Sessions do not block a new Session for the same workspace after restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-cluster-workspace-lease-restart-'));
  try {
    const workingDirectory = {
      kind: 'server_local' as const,
      id: 'client-placeholder',
      name: 'restart-fixture',
      path: root,
      selectedAt: '2026-07-13T00:00:00.000Z'
    };
    const created = await makeService().service.create({ input: 'Interrupted task', workingDirectory });
    created.session.status = 'INTERRUPTED';
    const restarted = makeService({ initialSessions: [created.session] });

    const competing = await restarted.service.create({ input: 'Competing task after restart', workingDirectory });
    assert.notEqual(competing.session.id, created.session.id);
    assert.equal(competing.session.workspaceId, created.session.workspaceId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('applied workspace writeback completes the waiting task and resumes unfinished execution', async () => {
  const task: AgentTask = {
    id: 'task-writeback',
    sessionId: 'session-writeback',
    title: 'Apply isolated changes',
    description: 'Apply changes',
    status: 'waiting',
    dependsOnTaskIds: [],
    acceptanceCriteria: [],
    createdAt: '2026-07-30T00:00:00.000Z',
    updatedAt: '2026-07-30T00:00:00.000Z'
  };
  const writeback = {
    id: 'writeback-applied',
    sessionId: 'session-writeback',
    taskId: task.id,
    invocationId: 'invocation-writeback',
    workspaceId: 'default-workspace',
    providerKind: 'server_local',
    changeSet: {
      id: 'changes-writeback',
      baseRevision: { id: 'base', observedAt: '2026-07-30T00:00:00.000Z' },
      changes: [],
      createdAt: '2026-07-30T00:00:00.000Z'
    },
    resultSummary: 'Runtime implementation completed.',
    status: 'applied',
    conflicts: [],
    createdAt: '2026-07-30T00:00:00.000Z',
    updatedAt: '2026-07-30T00:00:01.000Z'
  } satisfies WorkspaceWritebackRecord;
  const fixture = makeService({
    taskItems: [task],
    workspaceWritebacks: {
      list: () => [writeback],
      resolve: async () => writeback
    }
  });
  const { session } = await fixture.service.create({ input: 'Apply isolated changes' });
  task.sessionId = session.id;
  writeback.sessionId = session.id;
  session.currentTaskBriefId = 'brief-writeback';
  session.status = 'WAIT_WORKSPACE_CONFLICT_RESOLUTION';

  await fixture.service.resolveWorkspaceWriteback(session.id, writeback.id, { action: 'retry_merge' });

  assert.equal(task.status, 'completed');
  assert.equal(task.resultSummary, 'Runtime implementation completed.');
  assert.equal(session.status, 'EXECUTING');
  assert.equal(fixture.executionStarts.length, 1);
});

test('Session waits for every blocking workspace writeback before resuming parallel tasks', async () => {
  const tasks = ['task-writeback-a', 'task-writeback-b'].map((id) => ({
    id,
    sessionId: 'session-writeback-multiple',
    title: id,
    description: id,
    status: 'waiting',
    dependsOnTaskIds: [],
    acceptanceCriteria: [],
    createdAt: '2026-07-30T00:00:00.000Z',
    updatedAt: '2026-07-30T00:00:00.000Z'
  })) satisfies AgentTask[];
  const records: WorkspaceWritebackRecord[] = tasks.map((task, index) => ({
    id: `writeback-multiple-${index}`,
    sessionId: 'session-writeback-multiple',
    taskId: task.id,
    invocationId: `invocation-multiple-${index}`,
    workspaceId: 'default-workspace',
    providerKind: 'server_local',
    changeSet: {
      id: `changes-multiple-${index}`,
      baseRevision: { id: 'base', observedAt: '2026-07-30T00:00:00.000Z' },
      changes: [],
      createdAt: '2026-07-30T00:00:00.000Z'
    },
    resultSummary: `result-${index}`,
    status: 'conflicted',
    conflicts: [],
    createdAt: `2026-07-30T00:00:0${index}.000Z`,
    updatedAt: `2026-07-30T00:00:0${index}.000Z`
  }));
  const fixture = makeService({
    taskItems: tasks,
    workspaceWritebacks: {
      list: () => records,
      resolve: async (_session, writebackId) => {
        const record = records.find((item) => item.id === writebackId)!;
        record.status = 'abandoned';
        return record;
      }
    }
  });
  const { session } = await fixture.service.create({ input: 'Resolve parallel writebacks' });
  for (const task of tasks) task.sessionId = session.id;
  for (const record of records) record.sessionId = session.id;
  session.currentTaskBriefId = 'brief-writeback-multiple';
  session.status = 'WAIT_WORKSPACE_CONFLICT_RESOLUTION';

  await fixture.service.resolveWorkspaceWriteback(session.id, records[0].id, { action: 'keep_workspace' });
  assert.equal(session.status, 'WAIT_WORKSPACE_CONFLICT_RESOLUTION');
  assert.deepEqual(tasks.map((task) => task.status), ['waiting', 'waiting']);
  assert.equal(fixture.executionStarts.length, 0);

  await fixture.service.resolveWorkspaceWriteback(session.id, records[1].id, { action: 'keep_workspace' });
  assert.equal(session.status, 'EXECUTING');
  assert.deepEqual(tasks.map((task) => task.status), ['completed', 'completed']);
  assert.equal(fixture.executionStarts.length, 1);
});

test('Session remains applying until every writeback is terminal and ignores a stale conflict outcome', async () => {
  const tasks = ['task-writeback-conflict', 'task-writeback-applying'].map((id) => ({
    id,
    sessionId: 'session-writeback-in-flight',
    title: id,
    description: id,
    status: 'waiting',
    dependsOnTaskIds: [],
    acceptanceCriteria: [],
    createdAt: '2026-07-30T00:00:00.000Z',
    updatedAt: '2026-07-30T00:00:00.000Z'
  })) satisfies AgentTask[];
  const records: WorkspaceWritebackRecord[] = [
    {
      id: 'writeback-conflict', sessionId: 'session-writeback-in-flight', taskId: tasks[0].id,
      invocationId: 'invocation-conflict', workspaceId: 'default-workspace', providerKind: 'server_local',
      changeSet: { id: 'changes-conflict', baseRevision: { id: 'base', observedAt: '2026-07-30T00:00:00.000Z' }, changes: [], createdAt: '2026-07-30T00:00:00.000Z' },
      status: 'conflicted', conflicts: [], createdAt: '2026-07-30T00:00:00.000Z', updatedAt: '2026-07-30T00:00:00.000Z'
    },
    {
      id: 'writeback-applying', sessionId: 'session-writeback-in-flight', taskId: tasks[1].id,
      invocationId: 'invocation-applying', workspaceId: 'default-workspace', providerKind: 'server_local',
      changeSet: { id: 'changes-applying', baseRevision: { id: 'base', observedAt: '2026-07-30T00:00:00.000Z' }, changes: [], createdAt: '2026-07-30T00:00:00.000Z' },
      status: 'applying', conflicts: [], createdAt: '2026-07-30T00:00:01.000Z', updatedAt: '2026-07-30T00:00:01.000Z'
    }
  ];
  const fixture = makeService({
    taskItems: tasks,
    workspaceWritebacks: {
      list: () => records,
      resolve: async (_session, writebackId) => {
        const record = records.find((item) => item.id === writebackId)!;
        record.status = 'abandoned';
        return record;
      }
    }
  });
  const { session } = await fixture.service.create({ input: 'Resolve while another writeback applies' });
  for (const task of tasks) task.sessionId = session.id;
  for (const record of records) record.sessionId = session.id;
  session.currentTaskBriefId = 'brief-writeback-in-flight';
  session.status = 'WAIT_WORKSPACE_CONFLICT_RESOLUTION';

  await fixture.service.resolveWorkspaceWriteback(session.id, records[0].id, { action: 'keep_workspace' });
  assert.equal(session.status, 'APPLYING_CHANGES');
  assert.equal(fixture.executionStarts.length, 0);

  records[1].status = 'applied';
  fixture.service.applyOutcome(session.id, { kind: 'workspace_conflict', reason: 'stale task outcome' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(session.status, 'EXECUTING');
  assert.deepEqual(tasks.map((task) => task.status), ['completed', 'completed']);
  assert.equal(fixture.executionStarts.length, 1);
});

test('restart converts an interrupted writeback into a user-resolvable Session state', () => {
  const session = {
    id: 'session-writeback-restart',
    dataEpoch: 'epoch-test',
    title: 'Recover writeback',
    originalInput: 'Recover writeback',
    status: 'APPLYING_CHANGES',
    ownerId: 'local-user',
    workspaceId: 'default-workspace',
    tokenUsed: 0,
    participatingAgentIds: ['coordinator'],
    createdAt: '2026-07-30T00:00:00.000Z',
    updatedAt: '2026-07-30T00:00:00.000Z'
  } satisfies SessionDetail;
  const writeback = {
    id: 'writeback-restart',
    sessionId: session.id,
    invocationId: 'invocation-restart',
    workspaceId: session.workspaceId,
    providerKind: 'server_local',
    changeSet: {
      id: 'changes-restart',
      baseRevision: { id: 'base', observedAt: session.createdAt },
      changes: [],
      createdAt: session.createdAt
    },
    status: 'failed',
    conflicts: [],
    error: 'Workspace writeback was interrupted by a backend restart.',
    createdAt: session.createdAt,
    updatedAt: session.createdAt
  } satisfies WorkspaceWritebackRecord;

  const fixture = makeService({
    initialSessions: [session],
    workspaceWritebacks: { list: () => [writeback], resolve: async () => writeback }
  });

  assert.equal(fixture.service.get(session.id).status, 'WAIT_WORKSPACE_CONFLICT_RESOLUTION');
  assert.equal(fixture.persistedSnapshots.at(-1)?.[0]?.status, 'WAIT_WORKSPACE_CONFLICT_RESOLUTION');
});

test('restart keeps the Session blocked when an older writeback failed before a newer one completed', () => {
  const session = {
    id: 'session-writeback-restart-multiple',
    dataEpoch: 'epoch-test',
    title: 'Recover multiple writebacks',
    originalInput: 'Recover multiple writebacks',
    status: 'APPLYING_CHANGES',
    ownerId: 'local-user',
    workspaceId: 'default-workspace',
    tokenUsed: 0,
    participatingAgentIds: ['coordinator'],
    createdAt: '2026-07-30T00:00:00.000Z',
    updatedAt: '2026-07-30T00:00:00.000Z'
  } satisfies SessionDetail;
  const records: WorkspaceWritebackRecord[] = ['failed', 'applied'].map((status, index) => ({
    id: `writeback-restart-multiple-${index}`,
    sessionId: session.id,
    invocationId: `invocation-restart-multiple-${index}`,
    workspaceId: session.workspaceId,
    providerKind: 'server_local',
    changeSet: {
      id: `changes-restart-multiple-${index}`,
      baseRevision: { id: 'base', observedAt: session.createdAt },
      changes: [],
      createdAt: session.createdAt
    },
    status: status as 'failed' | 'applied',
    conflicts: [],
    createdAt: `2026-07-30T00:00:0${index}.000Z`,
    updatedAt: `2026-07-30T00:00:0${index}.000Z`
  }));

  const fixture = makeService({
    initialSessions: [session],
    workspaceWritebacks: { list: () => records, resolve: async () => records[0] }
  });

  assert.equal(fixture.service.get(session.id).status, 'WAIT_WORKSPACE_CONFLICT_RESOLUTION');
});

test('retired browser-local working directories are rejected', async () => {
  const { service } = makeService();
  await assert.rejects(
    service.create({
      input: 'Reject the retired browser workspace mode',
      workingDirectory: {
        kind: 'browser_local',
        id: 'browser-workspace-id',
        name: 'browser-project',
        selectedAt: '2026-07-14T00:00:00.000Z'
      } as never
    }),
    /must be local_bridge or server_local/
  );
});

test('local_bridge Session stores only a connected opaque workspace identity', async () => {
  const { service, persistedSessions } = makeService({
    localWorkspace: { workspaceId: 'local-workspace-id', displayName: 'local-project' }
  });
  const { session } = await service.create({
    input: 'Modify the authorized local project',
    workingDirectory: {
      kind: 'local_bridge',
      id: 'local-workspace-id',
      name: 'local-project',
      selectedAt: '2026-07-24T00:00:00.000Z'
    },
    runtimePreference: { preferredRuntimeType: 'codex', allowedRuntimeTypes: ['codex'] }
  });

  assert.equal(session.workspaceId, 'local-workspace-id');
  assert.equal(session.workingDirectory?.kind, 'local_bridge');
  assert.equal(session.workingDirectory?.path, undefined);
  assert.equal(session.workspaceSnapshot, undefined);
  assert.equal(session.workspaceContext?.binding.providerKind, 'local_bridge');
  assert.equal(session.workspaceContext?.binding.boundRevision.id, 'local-revision');
  assert.equal(persistedSessions[0]?.workingDirectory?.path, undefined);
  assert.equal(JSON.stringify(persistedSessions[0]).includes('C:\\'), false);
});

test('local_bridge Session rejects a Runtime that the connected device cannot execute', async () => {
  const { service } = makeService({
    localWorkspace: {
      workspaceId: 'local-workspace-id',
      displayName: 'local-project',
      runtimeTypes: ['codex']
    }
  });

  await assert.rejects(
    service.create({
      input: 'Use an unavailable local Runtime',
      workingDirectory: {
        kind: 'local_bridge',
        id: 'local-workspace-id',
        name: 'local-project',
        selectedAt: '2026-08-06T00:00:00.000Z'
      },
      runtimePreference: { preferredRuntimeType: 'claude_code', allowedRuntimeTypes: ['claude_code'] }
    }),
    /LOCAL_RUNTIME_UNAVAILABLE: Runtime claude_code/
  );
});

test('local_bridge Session requires an explicit preferred Runtime', async () => {
  const { service } = makeService({
    localWorkspace: { workspaceId: 'local-workspace-id', displayName: 'local-project' }
  });

  await assert.rejects(
    service.create({
      input: 'Do not route a local workspace through the global default',
      workingDirectory: {
        kind: 'local_bridge',
        id: 'local-workspace-id',
        name: 'local-project',
        selectedAt: '2026-08-06T00:00:00.000Z'
      }
    }),
    /LOCAL_RUNTIME_REQUIRED/
  );
});

test('local_bridge Session rejects paths, offline workspaces, and mismatched registration names', async () => {
  const fixture = makeService({
    localWorkspace: { workspaceId: 'local-workspace-id', displayName: 'local-project' }
  });
  const base = {
    kind: 'local_bridge' as const,
    id: 'local-workspace-id',
    name: 'local-project',
    selectedAt: '2026-07-24T00:00:00.000Z'
  };

  await assert.rejects(
    fixture.service.create({ input: 'Reject leaked path', workingDirectory: { ...base, path: 'C:\\private\\project' } }),
    /must not expose a server-accessible path/
  );
  await assert.rejects(
    makeService().service.create({ input: 'Reject offline bridge', workingDirectory: base }),
    /not connected/
  );
  await assert.rejects(
    fixture.service.create({ input: 'Reject spoofed name', workingDirectory: { ...base, name: 'other-project' } }),
    /name does not match/
  );
  await assert.rejects(
    fixture.service.create({
      input: 'Reject browser supplied Local Runtime evidence',
      workingDirectory: base,
      workspaceSnapshot: {
        rootName: 'local-project',
        scannedAt: '2026-07-24T00:00:00.000Z',
        fileCount: 0,
        totalBytes: 0,
        tree: [],
        files: [],
        skipped: []
      }
    } as never),
    /server-generated and cannot be supplied/
  );
});

test('absolute paths in ordinary task text never become a server_local workspace', async () => {
  const { service } = makeService();
  const { session } = await service.create({
    input: 'Please edit D:\\business-project\\src\\main.ts and run its tests'
  });

  assert.equal(session.workingDirectory, undefined);
  assert.equal(session.workspaceSnapshot, undefined);
});

test('ask_user confirmation payload preserves structured Post Review actions', async () => {
  const { service, events } = makeService();
  const { session } = await service.create({ input: 'Review an implementation with incomplete evidence' });
  const actions = [
    {
      action: 'request_workspace_context' as const,
      reason: 'Review needs the implementation source before it can verify completion.',
      missingPaths: ['src/feature.ts']
    },
    {
      action: 'deliver_with_limitations' as const,
      limitations: ['src/feature.ts was not reviewed.']
    },
    { action: 'save_progress' as const, artifactIds: [] },
    { action: 'cancel' as const, reason: 'Stop without sufficient evidence.' }
  ];

  service.applyOutcome(session.id, {
    kind: 'ask_user',
    reason: 'Post Review needs more workspace evidence.',
    actions
  });

  const confirmation = events.find((event) => event.type === 'user_confirmation_requested');
  assert.ok(confirmation);
  const metadata = confirmation.metadata as { payload?: { actions?: unknown } };
  assert.deepEqual(metadata.payload?.actions, actions);
});

async function postReviewActionFixture(action: {
  action: 'request_workspace_context' | 'deliver_with_limitations' | 'save_progress' | 'cancel';
  reason?: string;
  missingPaths?: string[];
  limitations?: string[];
}, options: { failHydration?: boolean } = {}) {
  const fixture = makeService(options);
  const { session } = await fixture.service.create({ input: 'Resolve a Post Review action' });
  session.currentTaskBriefId = 'brief-post-review-action';
  fixture.service.applyOutcome(session.id, {
    kind: 'ask_user',
    reason: 'Post Review requires a user decision.',
    actions: [action] as never
  });
  const confirmation = fixture.events.find((event) => event.type === 'user_confirmation_requested');
  const confirmationId = (confirmation?.metadata as { payload?: { confirmationId?: string } })?.payload?.confirmationId;
  assert.ok(confirmationId);
  return { ...fixture, session, confirmationId };
}

test('Post Review actions select distinct Session recovery flows', async () => {
  const context = await postReviewActionFixture({
    action: 'request_workspace_context',
    reason: 'Read missing source.',
    missingPaths: ['src/feature.ts']
  });
  await context.service.resolvePostReviewAction(context.session.id, {
    confirmationId: context.confirmationId,
    action: 'request_workspace_context'
  });
  assert.equal(context.session.status, 'EXECUTING');
  assert.deepEqual(
    context.session.supplementalContextRequests?.at(-1)?.requestedContext.requestedFiles,
    [{ path: 'src/feature.ts' }]
  );
  assert.deepEqual(context.session.supplementalContextRequests?.at(-1)?.resolution.hydratedPaths, ['src/feature.ts']);
  assert.equal(context.executionStarts.length, 1);

  const limited = await postReviewActionFixture({
    action: 'deliver_with_limitations',
    limitations: ['src/feature.ts was not reviewed.']
  });
  await limited.service.resolvePostReviewAction(limited.session.id, {
    confirmationId: limited.confirmationId,
    action: 'deliver_with_limitations'
  });
  assert.equal(limited.session.status, 'EXECUTING');
  assert.equal(limited.executionStarts.length, 1);

  const saved = await postReviewActionFixture({ action: 'save_progress' });
  await saved.service.resolvePostReviewAction(saved.session.id, {
    confirmationId: saved.confirmationId,
    action: 'save_progress'
  });
  assert.equal(saved.session.status, 'WAIT_USER_DECISION');
  assert.equal(saved.executionStarts.length, 0);
  assert.equal(saved.executionCancels.length, 0);

  const cancelled = await postReviewActionFixture({ action: 'cancel', reason: 'Stop.' });
  await cancelled.service.resolvePostReviewAction(cancelled.session.id, {
    confirmationId: cancelled.confirmationId,
    action: 'cancel'
  });
  assert.equal(cancelled.session.status, 'CANCELLED');
  assert.deepEqual(cancelled.executionCancels, [cancelled.session.id]);
});

test('Post Review does not resume execution when requested workspace context cannot be hydrated', async () => {
  const context = await postReviewActionFixture(
    { action: 'request_workspace_context', reason: 'Read missing source.', missingPaths: ['src/missing.ts'] },
    { failHydration: true }
  );
  await context.service.resolvePostReviewAction(context.session.id, {
    confirmationId: context.confirmationId,
    action: 'request_workspace_context'
  });
  assert.equal(context.session.status, 'WAIT_USER_DECISION');
  assert.equal(context.executionStarts.length, 0);
  assert.equal(context.session.supplementalContextRequests?.at(-1)?.resolution.failedPaths[0]?.code, 'BROKER_OFFLINE');
});
