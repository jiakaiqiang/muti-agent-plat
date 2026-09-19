import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentTask, SessionDetail, UserMessageHandlingPlan, WorkspaceWritebackRecord } from '@agent-cluster/shared';
import { requirementConfirmationFingerprint } from '@agent-cluster/shared';
import { SessionsService } from './sessions.service.js';

test('failed brief resumes at generation, consumes its confirmation once and rejects a stale confirmation', async () => {
  const fixture = makeService();
  const { session } = await fixture.service.create({ input: 'Recover failed brief' });
  const service = fixture.service as any;
  let generations = 0;
  let executions = 0;
  service.generateBriefInBackground = () => { generations++; };
  service.resumeExecution = () => { executions++; };
  service.failSession(session, new Error('PERSISTENCE_REVISION_CONFLICT'), 'brief_generation');
  const confirmationId = session.activeRecoveryCheckpoint!.confirmationId;
  await fixture.service.resume(session.id, 'retry', confirmationId);
  await fixture.service.resume(session.id, 'duplicate', confirmationId);
  await fixture.service.resume(session.id);
  assert.equal(session.status, 'AGENT_DISCUSSING');
  assert.equal(generations, 1);
  assert.equal(executions, 0);
  service.failSession(session, new Error('new failure'), 'brief_generation');
  await assert.rejects(fixture.service.resume(session.id, 'old card', confirmationId), /已过期/);
  assert.equal(session.status, 'FAILED');
  assert.equal(generations, 1);
});

test('failed task with a brief resumes execution while an unconfirmed stop remains a barrier', async () => {
  const fixture = makeService();
  const { session } = await fixture.service.create({ input: 'Recover execution' });
  const service = fixture.service as any;
  session.currentTaskBriefId = 'existing-brief';
  let executions = 0;
  service.resumeExecution = () => { executions++; };
  service.generateBriefInBackground = () => { throw new Error('must not regenerate'); };
  service.failSession(session, new Error('task failed'), 'task_execution');
  const confirmationId = session.activeRecoveryCheckpoint!.confirmationId;
  service.runtime = { hasUnconfirmedStops: () => true };
  await assert.rejects(fixture.service.resume(session.id, 'retry', confirmationId), /停止状态尚未确认/);
  assert.equal(session.activeRecoveryCheckpoint!.confirmationId, confirmationId);
  service.runtime.hasUnconfirmedStops = () => false;
  await fixture.service.resume(session.id, 'retry', confirmationId);
  await fixture.service.resume(session.id, 'duplicate', confirmationId);
  assert.equal(session.status, 'EXECUTING');
  assert.equal(executions, 1);
});

test('work-item budget exhaustion is durable waiting state and cannot resume the exhausted task', async () => {
  const fixture = makeService();
  const { session } = await fixture.service.create({ input: 'Implement the entire product in one task' });
  const service = fixture.service as any;
  service.briefGenerationRuns.delete(session.id);
  session.status = 'EXECUTING';
  session.currentTaskBriefId = 'brief-budget-exhausted';

  fixture.service.applyOutcome(session.id, {
    kind: 'work_item_budget_exhausted',
    reason: '当前需求的累计预算已用尽。',
    taskId: 'task-budget-exhausted',
    workItemId: 'work-item-budget-exhausted',
    error: {
      code: 'WORK_ITEM_BUDGET_EXHAUSTED',
      message: '当前需求的累计预算已用尽。',
      retryable: false
    }
  });

  assert.equal(session.status, 'WAIT_USER_DECISION');
  const request = fixture.events.find((event) => event.type === 'user_confirmation_requested');
  const payload = (request?.metadata as {
    payload?: { confirmationId?: string; reason?: string; options?: Array<{ key: string }> }
  } | undefined)?.payload;
  assert.equal(payload?.reason, 'work_item_budget_exhausted');
  assert.deepEqual(payload?.options?.map((option) => option.key), ['submit_narrowed_requirement', 'cancel']);
  await assert.rejects(
    fixture.service.resume(session.id, 'retry unchanged input', payload?.confirmationId),
    /当前确认不允许通过继续按钮执行/
  );
  assert.equal(session.status, 'WAIT_USER_DECISION');
});

test('an asynchronous work-item budget failure uses the narrowed-requirement confirmation', async () => {
  const fixture = makeService();
  const { session } = await fixture.service.create({ input: '分析并记录 token 使用情况，仅输出说明。' });
  const service = fixture.service as unknown as {
    briefGenerationRuns: Map<string, unknown>;
    failSessionWithFullError(session: SessionDetail, error: unknown, phase: string): void;
  };
  service.briefGenerationRuns.delete(session.id);

  const runtimeError = {
    code: 'WORK_ITEM_BUDGET_EXHAUSTED' as const,
    message: '当前需求的累计模型预算已不足。',
    retryable: false
  };
  service.failSessionWithFullError(
    session,
    Object.assign(new Error(runtimeError.message), { cause: runtimeError, runtimeError }),
    'brief_generation'
  );

  assert.equal(session.status, 'WAIT_USER_DECISION');
  const request = fixture.events.find((event) => event.type === 'user_confirmation_requested');
  const payload = (request?.metadata as {
    payload?: { reason?: string; options?: Array<{ key: string }> }
  } | undefined)?.payload;
  assert.equal(payload?.reason, 'work_item_budget_exhausted');
  assert.deepEqual(payload?.options?.map((option) => option.key), ['submit_narrowed_requirement', 'cancel']);
  assert.equal(fixture.events.some((event) => event.type === 'error_reported'), false);
});

test('an exact continue command retries a failed brief revision even when the previous brief exists', async () => {
  const fixture = makeService();
  const { session } = await fixture.service.create({ input: 'Revise existing brief' });
  const service = fixture.service as any;
  service.briefGenerationRuns.delete(session.id);
  session.currentTaskBriefId = 'previous-brief';
  let generations = 0;
  service.generateBriefInBackground = () => { generations++; };
  service.resumeExecution = () => { throw new Error('must not execute an obsolete brief'); };
  service.failSession(session, new Error('brief revision failed'), 'brief_revision');
  await fixture.service.sendMessage(session.id, '继续');
  assert.equal(generations, 1);
  assert.equal(session.status, 'AGENT_DISCUSSING');
});

test('legacy missing-brief dead end recovers generation without bypassing ordinary requirement confirmation', async () => {
  const fixture = makeService();
  const { session } = await fixture.service.create({ input: 'Recover missing brief' });
  const service = fixture.service as any;
  service.failSession(session, new Error('brief failure'), 'brief_generation');
  service.resumeExecution(session);
  assert.equal(session.status, 'WAIT_USER_DECISION');
  let generations = 0;
  service.generateBriefInBackground = () => { generations++; };
  await fixture.service.resume(session.id, 'retry', session.activeRecoveryCheckpoint!.confirmationId);
  assert.equal(session.status, 'AGENT_DISCUSSING');
  assert.equal(generations, 1);
  session.status = 'WAIT_USER_CONFIRM';
  await assert.rejects(fixture.service.resume(session.id), /任务契约尚未生成/);
  assert.equal(session.status, 'WAIT_USER_CONFIRM');
});

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
  /** Makes the physical record purge report failure so the deletion path can be asserted. */
  sessionPurgeFails?: boolean;
  runtimeCalls?: string[];
  permissionGrants?: string[];
  executionRunning?: boolean;
  initialSessions?: SessionDetail[];
  localWorkspace?: {
    workspaceId: string;
    displayName: string;
    files?: Record<string, string>;
    runtimeTypes?: Array<'codex' | 'claude_code'>;
    /** Runtimes the CLI still reports for routing; defaults to runtimeTypes. Empty = CLI offline. */
    connectedRuntimeTypes?: Array<'codex' | 'claude_code'>;
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
  workflowSubstitutionCalls?: Array<{ runId: string; taskId: string; agentId: string; confirmationId?: string }>;
  workflowSkipCalls?: Array<{ runId: string; taskId: string; reason: string; confirmationId?: string }>;
  followUpHandlingPlan?: {
    requirementRelation: 'continuation' | 'new_requirement';
    failedExecutionAction: 'none' | 'resume' | 'replan';
  };
  routingRecovery?: {
    routings: Array<Record<string, any>>;
    followUps: Array<Record<string, any>>;
    actionStatusUpdates?: string[];
    followUpStatusUpdates?: string[];
  };
} = {}) {
  const persistedSessions: SessionDetail[] = structuredClone(options.initialSessions ?? []);
  const persistedState: Record<string, unknown> = { sessions: persistedSessions };
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
  const memberConsultations: Array<{ sessionId: string; discussionId: string; agentId: string }> = [];
  const executionConsultations: Array<{ sessionId: string; content: string; agentIds: string[] }> = [];
  const acceptedSyntheses: Array<{ sessionId: string; discussionId: string }> = [];
  const workspaceOfflineEmitters: Array<(value: { workspaceId: string; reason: string; occurredAt: string }) => void> = [];
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
        return ['backend', 'test'].map((id) => findAgentById(id)!);
      },
      getForSurface(id: string) {
        return findAgentById(id)!;
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
      acceptCommitted(event: Record<string, unknown>) {
        if (events.some((item) => item.id === event.id)) return false;
        events.push(event);
        return true;
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
      async consultApprovedMember(session: SessionDetail, input: { discussionId: string; agentId: string }) {
        memberConsultations.push({ sessionId: session.id, ...input });
      },
      async consultDuringExecution(session: SessionDetail, content: string, agentIds: string[]) {
        executionConsultations.push({ sessionId: session.id, content, agentIds });
        return true;
      },
      async acceptDiscussionSynthesis(session: SessionDetail, discussionId: string) {
        acceptedSyntheses.push({ sessionId: session.id, discussionId });
      },
      confirmBrief(session: SessionDetail, briefId: string) {
        return {
          id: briefId,
          sessionId: session.id,
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
      getCollection(key: string, fallback: unknown) {
        return structuredClone(persistedState[key] ?? fallback);
      },
      assertWritable() {},
      currentDataEpoch() {
        return 'epoch-test';
      },
      async acquireWorkspaceSessionLease() {
        return true;
      },
      async releaseWorkspaceSessionLease() {},
      async deleteSessionData(sessionId: string) {
        options.cleanupCalls?.push(`purge:${sessionId}`);
        return !options.sessionPurgeFails;
      },
      setCollection(key: string, value: unknown) {
        persistedState[key] = structuredClone(value);
        if (key === 'sessions') {
          const sessions = value as SessionDetail[];
          persistedSnapshots.push(structuredClone(sessions));
          persistedSessions.splice(0, persistedSessions.length, ...sessions);
          persistedState.sessions = persistedSessions;
        }
      },
      async mutateCollections<T>(keys: string[], mutate: (draft: Record<string, unknown>) => T) {
        const draft = structuredClone(Object.fromEntries(
          keys.filter((key) => persistedState[key] !== undefined).map((key) => [key, persistedState[key]])
        ));
        const result = mutate(draft);
        for (const key of keys) if (draft[key] !== undefined) persistedState[key] = structuredClone(draft[key]);
        if (draft.sessions) {
          const sessions = draft.sessions as SessionDetail[];
          persistedSessions.splice(0, persistedSessions.length, ...structuredClone(sessions));
          persistedState.sessions = persistedSessions;
        }
        return result;
      }
    } as never,
    {
      checkInvocation(capabilityId: string) {
        return { allowed: options.capabilityChecks?.[capabilityId] ?? true };
      },
      registerApprovalListener() {}
    } as never,
    undefined,
    options.workflowResumeCalls || options.workflowSubstitutionCalls || options.workflowSkipCalls ? {
      updates() {
        return { subscribe() { return { unsubscribe() {} }; } };
      },
      async resumeCurrentExecution(runId: string) {
        options.workflowResumeCalls?.push(runId);
        return true;
      },
      async substituteCurrentAgent(input: { runId: string; taskId: string; agentId: string; confirmationId?: string }) {
        options.workflowSubstitutionCalls?.push(input);
        return input;
      },
      async skipCurrentAgent(input: { runId: string; taskId: string; reason: string; confirmationId?: string }) {
        options.workflowSkipCalls?.push(input);
        return input;
      },
      get() {
        return { status: options.workflowSkipCalls ? 'running' : 'failed' };
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
      listRuntimeCandidates(workspaceId: string) {
        if (workspaceId !== options.localWorkspace?.workspaceId) return [];
        const runtimeTypes = options.localWorkspace.connectedRuntimeTypes
          ?? options.localWorkspace.runtimeTypes
          ?? ['codex'];
        return runtimeTypes.map((runtimeType) => ({
          runtimeType,
          available: true,
          supportedWorkspaceCapabilities: ['read', 'write', 'command', 'test'],
          supportedWorkspaceProviderKinds: ['local_bridge'],
          supportedToolNames: ['read_file', 'search_code', 'write_file', 'run_test']
        }));
      },
      interruptions() {
        return { subscribe() { return { unsubscribe() {} }; } };
      },
      workspaceOffline() {
        return {
          subscribe(observer: (value: { workspaceId: string; reason: string; occurredAt: string }) => void) {
            workspaceOfflineEmitters.push(observer);
            return { unsubscribe() {} };
          }
        };
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
    options.workspaceWritebacks as never,
    options.routingRecovery ? {
      listRoutingRecords() {
        return options.routingRecovery!.routings;
      },
      listFollowUps() {
        return options.routingRecovery!.followUps;
      },
      async updateRoutingActionStatus(_sessionId: string, routingId: string, status: string) {
        options.routingRecovery!.actionStatusUpdates?.push(status);
        const routing = options.routingRecovery!.routings.find((item) => item.id === routingId);
        if (routing) routing.actionStatus = status;
        return routing;
      },
      async updateFollowUpStatus(_sessionId: string, followUpId: string, status: string) {
        options.routingRecovery!.followUpStatusUpdates?.push(status);
        const followUp = options.routingRecovery!.followUps.find((item) => item.id === followUpId);
        if (followUp) followUp.status = status;
        return followUp;
      }
    } as never : undefined,
    options.routingRecovery ? {} as never : undefined,
    undefined,
    undefined,
    {
      deleteSession(sessionId: string) {
        options.cleanupCalls?.push(`artifacts:${sessionId}`);
      }
    } as never
  );
  return {
    service,
    memberConsultations,
    executionConsultations,
    acceptedSyntheses,
    persistedState,
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
    cancelledTasks,
    emitWorkspaceOffline(workspaceId: string) {
      for (const emit of workspaceOfflineEmitters) {
        emit({ workspaceId, reason: 'local runtime disconnected', occurredAt: '2026-08-11T10:13:43.000Z' });
      }
    }
  };
}

test('confirming a Task Brief closes the exact confirmation request', async () => {
  const session: SessionDetail = {
    id: 'session-brief-confirmation-id',
    dataEpoch: 'epoch-test',
    title: 'Brief confirmation id',
    originalInput: 'Confirm the current brief.',
    status: 'WAIT_USER_CONFIRM',
    ownerId: 'local-user',
    workspaceId: 'workspace-brief-confirmation-id',
    tokenUsed: 0,
    currentTaskBriefId: 'brief-confirmation-id',
    participatingAgentIds: ['coordinator'],
    createdAt: '2026-08-12T00:00:00.000Z',
    updatedAt: '2026-08-12T00:00:00.000Z'
  };
  const fixture = makeService({ initialSessions: [session] });
  fixture.events.push({
    id: 'brief-confirmation-request',
    sessionId: session.id,
    type: 'user_confirmation_requested',
    content: 'Confirm the brief.',
    toAgentIds: [],
    metadata: {
      schemaVersion: '0.1',
      payload: {
        confirmationId: 'brief-confirmation-1',
        reason: 'confirm_task_brief',
        relatedBriefId: session.currentTaskBriefId,
        options: [{ key: 'approve', label: 'Approve' }]
      }
    },
    createdAt: '2026-08-12T00:00:00.000Z'
  });

  await fixture.service.confirmBrief(session.id, session.currentTaskBriefId!, 'brief-confirmation-1');

  const resolved = fixture.events.find((event) => event.type === 'user_confirmation_resolved');
  assert.equal((resolved?.metadata as { payload?: { confirmationId?: string } })?.payload?.confirmationId, 'brief-confirmation-1');
  assert.equal(fixture.service.get(session.id).status, 'WAIT_WORKFLOW_SELECT');
});

test('boot recovery expires stale confirmations and exact continue consumes one durable checkpoint', async () => {
  const workflowResumeCalls: string[] = [];
  const session: SessionDetail = {
    id: 'session-recovery-checkpoint',
    dataEpoch: 'epoch-test',
    title: 'Recovery checkpoint',
    originalInput: 'Resume the failed workflow.',
    status: 'WAIT_USER_DECISION',
    ownerId: 'local-user',
    workspaceId: 'workspace-recovery-checkpoint',
    tokenUsed: 0,
    currentTaskBriefId: 'brief-recovery-checkpoint',
    workflowRunId: 'workflow-run-recovery-checkpoint',
    participatingAgentIds: ['coordinator'],
    createdAt: '2026-08-12T00:00:00.000Z',
    updatedAt: '2026-08-12T00:00:00.000Z'
  };
  const fixture = makeService({ initialSessions: [session], workflowResumeCalls });
  for (const [index, reason] of ['confirm_task_brief', 'coordinator_routing_needs_user_decision'].entries()) {
    fixture.events.push({
      id: `stale-confirmation-event-${index}`,
      sessionId: session.id,
      type: 'user_confirmation_requested',
      content: `Stale confirmation ${index}`,
      toAgentIds: [],
      metadata: {
        schemaVersion: '0.1',
        payload: {
          confirmationId: `stale-confirmation-${index}`,
          reason,
          options: [{ key: 'resume', label: 'Resume' }, { key: 'cancel', label: 'Cancel' }]
        }
      },
      createdAt: `2026-08-12T00:00:0${index}.000Z`
    });
  }

  await fixture.service.reconcileRecoveryStateOnBoot(session.id);

  const checkpoint = fixture.service.get(session.id).activeRecoveryCheckpoint;
  assert.ok(checkpoint);
  assert.equal(checkpoint.reason, 'coordinator_routing_needs_user_decision');
  const expiredIds = fixture.events
    .filter((event) => event.type === 'user_confirmation_resolved')
    .filter((event) => (event.metadata as { payload?: { status?: string } })?.payload?.status === 'expired')
    .map((event) => (event.metadata as { payload?: { confirmationId?: string } })?.payload?.confirmationId);
  assert.deepEqual(expiredIds, ['stale-confirmation-0', 'stale-confirmation-1']);

  await fixture.service.sendMessage(session.id, '继续');

  assert.equal(fixture.service.get(session.id).activeRecoveryCheckpoint, undefined);
  assert.equal(fixture.service.get(session.id).status, 'EXECUTING');
  assert.deepEqual(workflowResumeCalls, ['workflow-run-recovery-checkpoint']);
  const recoveryResolution = fixture.events.find((event) =>
    event.type === 'user_confirmation_resolved' &&
    (event.metadata as { payload?: { confirmationId?: string } })?.payload?.confirmationId === checkpoint.confirmationId
  );
  assert.ok(recoveryResolution);
});

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

test('capability approval waits for a reconnect when the local Runtime went offline while parked', async () => {
  const session: SessionDetail = {
    id: 'session-capability-offline',
    dataEpoch: 'epoch-test',
    title: 'Capability resume without local Runtime',
    originalInput: 'Write implementation files.',
    status: 'WAIT_USER_DECISION',
    ownerId: 'local-user',
    workspaceId: 'workspace-local-offline',
    tokenUsed: 0,
    currentTaskBriefId: 'brief-capability-offline',
    participatingAgentIds: ['backend'],
    workingDirectory: {
      kind: 'local_bridge',
      id: 'workspace-local-offline',
      name: 'offline-workspace',
      selectedAt: '2026-08-11T09:08:16.091Z'
    },
    runtimePreference: { preferredRuntimeType: 'claude_code', allowedRuntimeTypes: ['claude_code', 'codex'] },
    pendingInvocations: [{
      invocationId: 'invocation-capability-offline',
      sessionId: 'session-capability-offline',
      taskId: 'task-capability-offline',
      agentId: 'backend',
      phase: 'task_acceptance',
      pendingApprovals: [{
        toolId: 'cap-file-write',
        toolKey: 'tool.file_write',
        approvalId: 'approval-write',
        reasons: ['HUMAN_APPROVAL_REQUIRED']
      }],
      createdAt: '2026-08-11T09:56:49.000Z'
    }],
    createdAt: '2026-08-11T09:08:16.659Z',
    updatedAt: '2026-08-11T09:56:49.000Z'
  };
  const task: AgentTask = {
    id: 'task-capability-offline',
    sessionId: session.id,
    title: 'Write implementation files',
    description: 'Use file tools.',
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
    capabilityChecks: { 'cap-file-write': true },
    localWorkspace: {
      workspaceId: 'workspace-local-offline',
      displayName: 'offline-workspace',
      runtimeTypes: ['claude_code', 'codex'],
      connectedRuntimeTypes: []
    }
  });

  await fixture.service.retryPendingApprovalTasks(session.id, 'cap-file-write');
  await new Promise<void>((resolve) => setImmediate(resolve));

  const parked = fixture.service.get(session.id);
  assert.deepEqual(parked.pendingInvocations, []);
  assert.equal(parked.status, 'WAIT_USER_DECISION');
  assert.equal(fixture.executionStarts.length, 0);
  const request = fixture.events.find((event) => event.type === 'user_confirmation_requested');
  const payload = (request?.metadata as { payload?: { reason?: string; options?: Array<{ key: string }> } } | undefined)?.payload;
  assert.equal(payload?.reason, 'reconnect_local_runtime');
  assert.deepEqual(payload?.options?.map((option) => option.key), ['resume', 'cancel']);
});

test('retrying a failed Session waits for a reconnect when the local Runtime is offline', async () => {
  const session: SessionDetail = {
    id: 'session-retry-offline',
    dataEpoch: 'epoch-test',
    title: 'Retry without local Runtime',
    originalInput: 'Add ranking and sound effects to the snake game.',
    status: 'FAILED',
    ownerId: 'local-user',
    workspaceId: 'workspace-retry-offline',
    tokenUsed: 0,
    participatingAgentIds: ['backend'],
    workingDirectory: {
      kind: 'local_bridge',
      id: 'workspace-retry-offline',
      name: 'offline-workspace',
      selectedAt: '2026-08-28T13:00:00.000Z'
    },
    runtimePreference: { preferredRuntimeType: 'claude_code', allowedRuntimeTypes: ['claude_code', 'codex'] },
    createdAt: '2026-08-28T13:00:00.000Z',
    updatedAt: '2026-08-28T13:27:40.000Z'
  };
  const fixture = makeService({
    initialSessions: [session],
    localWorkspace: {
      workspaceId: 'workspace-retry-offline',
      displayName: 'offline-workspace',
      runtimeTypes: ['claude_code', 'codex'],
      connectedRuntimeTypes: []
    }
  });

  const retry = fixture.service as unknown as {
    retryFailedSession(session: SessionDetail, sourceEventId: string): void;
  };
  retry.retryFailedSession(fixture.service.get(session.id), 'event-retry-offline');
  await new Promise<void>((resolve) => setImmediate(resolve));

  const parked = fixture.service.get(session.id);
  assert.equal(parked.status, 'WAIT_USER_DECISION');
  const request = fixture.events.find((event) => event.type === 'user_confirmation_requested');
  const payload = (request?.metadata as {
    payload?: { reason?: string; trigger?: string; options?: Array<{ key: string }> };
  } | undefined)?.payload;
  assert.equal(payload?.reason, 'reconnect_local_runtime');
  assert.equal(payload?.trigger, 'failed_session_retry');
  assert.deepEqual(payload?.options?.map((option) => option.key), ['resume', 'cancel']);
  const rediscussed = fixture.events.some((event) =>
    (event.metadata as { payload?: { reason?: string } } | undefined)?.payload?.reason ===
      'failed_brief_generation_user_retry'
  );
  assert.equal(rediscussed, false, 'offline retry must not restart the discussion phase');
});

test('a local workspace going offline notifies Sessions parked on the user', () => {
  const session: SessionDetail = {
    id: 'session-parked-offline-notice',
    dataEpoch: 'epoch-test',
    title: 'Parked session',
    originalInput: 'Write implementation files.',
    status: 'WAIT_USER_DECISION',
    ownerId: 'local-user',
    workspaceId: 'workspace-parked-offline',
    tokenUsed: 0,
    participatingAgentIds: ['backend'],
    workingDirectory: {
      kind: 'local_bridge',
      id: 'workspace-parked-offline',
      name: 'parked-workspace',
      selectedAt: '2026-08-11T09:08:16.091Z'
    },
    createdAt: '2026-08-11T09:08:16.659Z',
    updatedAt: '2026-08-11T09:56:49.000Z'
  };
  const fixture = makeService({
    initialSessions: [session],
    localWorkspace: {
      workspaceId: 'workspace-parked-offline',
      displayName: 'parked-workspace',
      runtimeTypes: ['claude_code']
    }
  });

  fixture.emitWorkspaceOffline('workspace-parked-offline');

  const notice = fixture.events.find((event) =>
    event.type === 'session_status_changed' &&
    (event.metadata as { payload?: { reason?: string } } | undefined)?.payload?.reason === 'local_runtime_disconnected'
  );
  assert.ok(notice, 'expected a local_runtime_disconnected notice for the parked Session');
  assert.equal(notice?.sessionId, session.id);
  assert.equal(fixture.service.get(session.id).status, 'WAIT_USER_DECISION');
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
    wakeable: true,
    previousStatus: 'AGENT_DISCUSSING',
    workItemId: session.activeWorkItemId,
    phase: 'discussion'
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
    wakeable: true,
    previousStatus: 'AGENT_DISCUSSING',
    workItemId: session.activeWorkItemId,
    phase: 'discussion'
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

  // delivered 是产物真的落地的权威终态，允许它把中断会话推到 COMPLETED；
  // 迟到的 failed / rework 仍被吞，保留中断标记和恢复卡供用户决策。
  fixture.service.applyOutcome(session.id, { kind: 'delivered' });
  assert.equal(session.status, 'COMPLETED');
});

test('an interrupted Session still swallows a late failure so the recovery card survives', async () => {
  const fixture = makeService();
  const { session } = await fixture.service.create({ input: 'Keep the recovery card after a late failure' });

  fixture.service.beforeApplicationShutdown('SIGTERM');
  assert.equal(session.status, 'INTERRUPTED');
  assert.equal(session.interruption?.reason, 'service_shutdown');
  assert.ok(session.activeRecoveryCheckpoint);

  fixture.service.applyOutcome(session.id, { kind: 'failed', reason: 'late runtime failure' });

  assert.equal(session.status, 'INTERRUPTED');
  assert.equal(session.interruption?.reason, 'service_shutdown');
  assert.ok(session.activeRecoveryCheckpoint);
});

test('an interrupted Session normalises a continuation follow-up into a replan', async () => {
  const fixture = makeService();
  const { session } = await fixture.service.create({ input: 'Normalise a follow-up while interrupted' });
  session.status = 'INTERRUPTED';
  const normalize = fixture.service as unknown as {
    normalizeFollowUpHandlingPlan(session: SessionDetail, plan: UserMessageHandlingPlan): UserMessageHandlingPlan;
  };

  const plan = normalize.normalizeFollowUpHandlingPlan(session, {
    intent: 'constraint',
    requirementRelation: 'continuation',
    failedExecutionAction: 'none',
    priority: 'normal',
    shouldPause: false,
    affectedTaskIds: [],
    affectedAgentIds: [],
    requiresBriefRevision: false,
    requiresUserConfirmation: false,
    coordinatorInstruction: ''
  });

  // replan 让 processNextFollowUp 走 AGENT_DISCUSSING 并合并旧契约；resume 会丢内容。
  assert.equal(plan.failedExecutionAction, 'replan');
  assert.equal(plan.requirementRelation, 'continuation');
});

test('a failed Session keeps resuming a continuation follow-up rather than replanning', async () => {
  const fixture = makeService();
  const { session } = await fixture.service.create({ input: 'Keep the failed-session behaviour intact' });
  session.status = 'FAILED';
  const normalize = fixture.service as unknown as {
    normalizeFollowUpHandlingPlan(session: SessionDetail, plan: UserMessageHandlingPlan): UserMessageHandlingPlan;
  };

  const plan = normalize.normalizeFollowUpHandlingPlan(session, {
    intent: 'constraint',
    requirementRelation: 'continuation',
    failedExecutionAction: 'none',
    priority: 'normal',
    shouldPause: false,
    affectedTaskIds: [],
    affectedAgentIds: [],
    requiresBriefRevision: false,
    requiresUserConfirmation: false,
    coordinatorInstruction: ''
  });

  assert.equal(plan.failedExecutionAction, 'resume');
});

test('an interrupted Session can be moved to discussion by an explicit control request', async () => {
  // 方案 A 下补充需求会把中断会话带回讨论态，所以这条转移必须在状态机里合法。
  const fixture = makeService();
  const { session } = await fixture.service.create({ input: 'Move an interrupted Session back to discussion' });
  session.status = 'EXECUTING';
  fixture.service.beforeApplicationShutdown('SIGTERM');
  assert.equal(session.status, 'INTERRUPTED');

  fixture.service.control(session.id, 'AGENT_DISCUSSING', '补充需求需要重新生成契约');

  assert.equal(fixture.service.get(session.id).status, 'AGENT_DISCUSSING');
});

test('interruption records the phase of the status it interrupted', async () => {
  const fixture = makeService();
  const { session } = await fixture.service.create({ input: 'Record the interrupted phase for later recovery' });
  session.status = 'EXECUTING';

  fixture.service.beforeApplicationShutdown('SIGTERM');

  assert.equal(session.status, 'INTERRUPTED');
  assert.equal(session.interruption?.previousStatus, 'EXECUTING');
  assert.equal(session.interruption?.phase, 'task_execution');
});

test('retry after a discussion-phase interruption regenerates the contract instead of resuming a draft', async () => {
  const fixture = makeService();
  const { session } = await fixture.service.create({ input: 'Interrupt while the contract is still being discussed' });
  // A brief id exists but the contract was never finalised, so only the recorded
  // phase can tell retry to rebuild it rather than resume it.
  session.currentTaskBriefId = 'brief-draft';
  session.status = 'AGENT_DISCUSSING';

  fixture.service.beforeApplicationShutdown('SIGTERM');
  assert.equal(session.interruption?.phase, 'discussion');

  const retry = fixture.service as unknown as {
    retryFailedSession(session: SessionDetail, sourceEventId: string): void;
  };
  retry.retryFailedSession(fixture.service.get(session.id), 'event-retry-interrupted');

  const resumed = fixture.service.get(session.id);
  assert.equal(resumed.status, 'AGENT_DISCUSSING');
  assert.equal(resumed.interruption, undefined);
  assert.ok(fixture.events.some((event) =>
    (event.metadata as { payload?: { reason?: string } } | undefined)?.payload?.reason ===
      'failed_brief_generation_user_retry'
  ));
});

test('retry falls back to the latest failure phase when no interruption phase was recorded', async () => {
  const fixture = makeService();
  const { session } = await fixture.service.create({ input: 'Retry a failed brief revision without an interruption' });
  const service = fixture.service as any;
  let generations = 0;
  service.generateBriefInBackground = () => { generations++; };
  session.currentTaskBriefId = 'brief-existing';
  // No interruption ever happened, so the phase must come from the failure event.
  service.failSession(session, new Error('revision failed'), 'brief_revision');
  assert.equal(session.interruption, undefined);

  const retry = fixture.service as unknown as {
    retryFailedSession(session: SessionDetail, sourceEventId: string): void;
  };
  retry.retryFailedSession(fixture.service.get(session.id), 'event-retry-fallback');

  assert.equal(fixture.service.get(session.id).status, 'AGENT_DISCUSSING');
  assert.equal(generations, 1);
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

  await fixture.service.resume(session.id, '用户恢复当前执行');
  assert.equal(session.pauseState, undefined);
  fixture.service.control(session.id, 'CANCELLED', '用户取消整个会话');

  assert.equal(session.status, 'CANCELLED');
  assert.equal((fixture.executionTerminations[1] as { kind?: string })?.kind, 'user_cancelled');
  assert.equal((fixture.executionTerminations[1] as { scope?: string })?.scope, 'session');
});

test('pause cancels in-flight chat intent recognition without retrying or leaving the confirmation state on resume', async () => {
  const fixture = makeService();
  const { session } = await fixture.service.create({ input: 'Pause a chat message during intent recognition' });
  session.status = 'WAIT_USER_CONFIRM';
  const service = fixture.service as any;
  const route = { id: 'route-paused', status: 'CLASSIFYING', reasonCodes: [] as string[], snapshotId: 'snap' };
  let started = false;
  let calls = 0;
  service.contextManagement = {
    listRoutingRecords: () => [route], listSnapshots: () => [{ id: 'snap' }], listFollowUps: () => [],
    claimIntentRouting: async () => ({ state: 'claimed', routing: route }),
    updateRoutingRecord: async (_session: string, _id: string, patch: object) => Object.assign(route, patch)
  };
  service.semanticIntentRouter = { classify: async (_s: unknown, _r: unknown, _p: unknown, signal: AbortSignal) => {
    calls++; started = true;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } };
  const processing = service.processIntentRouting(session.id, route.id, 'snap', 'followup');
  await waitFor(() => started);
  await fixture.service.pause(session.id);
  await processing;
  assert.equal(session.status, 'PAUSED');
  assert.equal(route.status, 'PENDING_RETRY');
  assert.equal(service.intentRoutingRetryTimers.size, 0);
  await fixture.service.resume(session.id);
  assert.equal(session.status, 'WAIT_USER_CONFIRM');
  assert.equal(calls, 1);
});

test('deleting a Session also stops Runtime-owned invocations', async () => {
  const runtimeCalls: string[] = [];
  const { service } = makeService({ runtimeCalls });
  const { session } = await service.create({ input: 'Delete while Runtime is active' });

  await service.delete(session.id);

  assert.deepEqual(runtimeCalls, [`runtime:${session.id}`]);
});

test('deleting a Session keeps directories, artifacts and persisted history recoverable', async () => {
  const cleanupCalls: string[] = [];
  const { service, persistedSessions } = makeService({ cleanupCalls });
  const { session } = await service.create({ input: 'Delete this Session later' });

  const result = await service.delete(session.id);

  assert.deepEqual(cleanupCalls, [`terminate:${session.id}`]);
  assert.equal(result.deleted, true);
  assert.equal(result.lifecycle.state, 'deleted');
  assert.equal(persistedSessions.length, 1);
  assert.throws(() => service.get(session.id), /会话已删除/);
  assert.equal(service.getIncludingDeleted(session.id).id, session.id);
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

test('recoverable deletion never calls the physical purge path', async () => {
  const cleanupCalls: string[] = [];
  const { service } = makeService({ cleanupCalls, sessionPurgeFails: true });
  const { session } = await service.create({ input: 'Fail the record purge for this Session' });

  const result = await service.delete(session.id);

  assert.equal(result.deleted, true);
  assert.deepEqual(cleanupCalls, [`terminate:${session.id}`]);
  assert.equal(
    (service as unknown as { deletingSessionIds: Set<string> }).deletingSessionIds.has(session.id),
    false
  );
});

test('restoring a deleted Session returns it paused without starting a model or losing history', async () => {
  const fixture = makeService();
  const { session } = await fixture.service.create({ input: 'Keep this history through restore' });
  const deleted = await fixture.service.delete(session.id, 'delete-request-restore');
  const discussionCount = fixture.discussionStarts.length;

  const restored = await fixture.service.restore(session.id, {
    requestId: 'restore-request-1',
    expectedGeneration: deleted.lifecycle.generation
  });

  assert.equal(restored.lifecycle.state, 'active');
  assert.equal(restored.lifecycle.admission, 'closed');
  assert.equal(restored.session.status, 'PAUSED');
  assert.equal(fixture.discussionStarts.length, discussionCount);
  assert.equal(fixture.service.list('active').some(item => item.id === session.id), true);
  assert.equal(fixture.events.some(event => event.content === 'Keep this history through restore'), true);
});

test('deleting one Session blocks its late outcome without changing a sibling Session', async () => {
  const fixture = makeService();
  const first = await fixture.service.create({ input: 'First Session' });
  const second = await fixture.service.create({ input: 'Second Session' });
  const generation = fixture.service.lifecycleState(first.session.id).lifecycle.generation;
  second.session.status = 'EXECUTING';

  await fixture.service.delete(first.session.id, 'delete-request-isolation');
  fixture.service.applyOutcome(first.session.id, { kind: 'delivered' }, generation);

  assert.equal(fixture.service.getIncludingDeleted(first.session.id).status, 'PAUSED');
  assert.equal(fixture.service.get(second.session.id).status, 'EXECUTING');
  assert.equal(fixture.service.list('deleted').map(item => item.id).includes(first.session.id), true);
  assert.equal(fixture.service.list('active').map(item => item.id).includes(second.session.id), true);
});

test('a queued outcome from before deletion cannot mutate the restored generation', async () => {
  const fixture = makeService();
  const { session } = await fixture.service.create({ input: 'Reject an obsolete queued result' });
  const oldGeneration = fixture.service.lifecycleState(session.id).lifecycle.generation;
  session.status = 'EXECUTING';
  session.activeFollowUpMessageId = 'obsolete-follow-up';
  session.pendingFollowUpMessages = [{
    id: 'obsolete-follow-up',
    sourceEventId: 'obsolete-event',
    content: '旧 generation 的队列工作',
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
    queuedAt: '2026-09-16T00:00:00.000Z'
  }];
  const deleted = await fixture.service.delete(session.id, 'delete-obsolete-queue');
  await fixture.service.restore(session.id, {
    requestId: 'restore-obsolete-queue',
    expectedGeneration: deleted.lifecycle.generation
  });
  const eventCount = fixture.events.length;

  await fixture.service.applyQueuedExecutionOutcome(session.id, { kind: 'delivered' }, oldGeneration);

  assert.equal(session.status, 'PAUSED');
  assert.equal(session.activeFollowUpMessageId, 'obsolete-follow-up');
  assert.equal(session.pendingFollowUpMessages?.[0]?.status, 'executing');
  assert.equal(fixture.events.length, eventCount);
});

test('deleting a Session drops only its own pending intent routing retries', async () => {
  const { service } = makeService();
  const { session } = await service.create({ input: 'Delete while a routing retry is pending' });
  const survivor = await service.create({ input: 'Keep this Session and its pending retry' });
  const internals = service as unknown as { intentRoutingRetryTimers: Map<string, NodeJS.Timeout> };
  const fired: string[] = [];
  const keys = [`${session.id}:routing-1`, `${session.id}:routing-2`, `${survivor.session.id}:routing-1`];
  for (const key of keys) {
    internals.intentRoutingRetryTimers.set(key, setTimeout(() => fired.push(key), 20));
  }

  await service.delete(session.id);

  assert.deepEqual([...internals.intentRoutingRetryTimers.keys()], [`${survivor.session.id}:routing-1`]);
  await new Promise<void>((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(fired, [`${survivor.session.id}:routing-1`]);
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
  const { service, executionStarts, followUpPreparations, events } = makeService();
  const { session } = await service.create({ input: 'Analyze the workspace' });
  (service as unknown as { briefGenerationRuns: Map<string, unknown> }).briefGenerationRuns.delete(session.id);
  session.status = 'COMPLETED';
  const eventCountBeforeFollowUp = events.length;

  const result = await service.sendMessage(session.id, '继续补充实现审计日志', ['backend']);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(result.deferred, false);
  assert.deepEqual(followUpPreparations, [
    { content: '继续补充实现审计日志', mentionedAgentIds: ['backend'] }
  ]);
  assert.equal(executionStarts.length, 1);
  assert.equal(session.status, 'EXECUTING');
  assert.equal(session.pendingFollowUpMessages?.[0]?.status, 'executing');
  const followUpEvents = events.slice(eventCountBeforeFollowUp);
  assert.ok(followUpEvents.some((event) =>
    event.type === 'session_status_changed' &&
    (event.metadata as { payload?: { reason?: string; status?: string } }).payload?.reason ===
      'follow_up_continuation_planning_started' &&
    (event.metadata as { payload?: { reason?: string; status?: string } }).payload?.status === 'EXECUTING'
  ));
  assert.equal(followUpEvents.some((event) =>
    event.type === 'session_status_changed' &&
    (event.metadata as { payload?: { status?: string } }).payload?.status === 'AGENT_DISCUSSING'
  ), false);
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

test('a content message in an interrupted Session drains the queue into discussion', async () => {
  // 双锁解开前：hasActiveSessionWork 判 deferred，processNextFollowUp 又早退，五个出队
  // 触发点全死，用户在中断会话里说什么都不会被消费。
  // 用 Runtime 断开造中断态：beforeApplicationShutdown 会把 shuttingDown 永久置真，
  // 而真实重启后是新进程实例，该标志为假。用它会让调度被 shuttingDown 挡住而测不到本意。
  const { service, followUpPreparations, events } = makeService();
  const { session } = await service.create({ input: 'Continue an interrupted Session with new content' });
  (service as unknown as { briefGenerationRuns: Map<string, unknown> }).briefGenerationRuns.delete(session.id);
  session.status = 'EXECUTING';
  await service.interruptForRuntimeDisconnect({
    sessionId: session.id,
    invocationId: 'invocation-interrupted-continuation',
    reason: 'local_runtime_disconnected',
    occurredAt: '2026-09-15T00:00:00.000Z'
  });
  assert.equal(session.status, 'INTERRUPTED');

  const result = await service.sendMessage(session.id, '登录页再加一个记住密码功能', ['backend']);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(result.deferred, false);
  assert.equal(followUpPreparations.length, 1);
  // 方案 A：补充需求先回讨论态重新生成契约（AGENT_DISCUSSING 是中间态，prepare 之后
  // processNextFollowUp 会推到 EXECUTING），所以断言事件流里出现过讨论阶段。
  assert.ok(events.some((event) =>
    event.type === 'session_status_changed' &&
    (event.metadata as { payload?: { reason?: string } }).payload?.reason === 'follow_up_discussion_started'
  ));
});

test('a bare resume hands control to a message queued before the crash', async () => {
  const { service, followUpPreparations, events } = makeService();
  const { session } = await service.create({ input: 'Resume with a message already queued' });
  (service as unknown as { briefGenerationRuns: Map<string, unknown> }).briefGenerationRuns.delete(session.id);
  session.status = 'EXECUTING';
  session.currentTaskBriefId = 'brief-existing';
  await service.interruptForRuntimeDisconnect({
    sessionId: session.id,
    invocationId: 'invocation-queued-before-crash',
    reason: 'local_runtime_disconnected',
    occurredAt: '2026-09-15T00:00:00.000Z'
  });
  // 崩溃前已入队但从未被消费的消息。
  session.pendingFollowUpMessages = [{
    id: 'follow-up-queued-before-crash',
    sourceEventId: 'event-queued-before-crash',
    content: '顺便把登录失败的提示文案也改掉',
    mentionedAgentIds: [],
    handlingPlan: {
      intent: 'constraint',
      requirementRelation: 'continuation',
      failedExecutionAction: 'none',
      priority: 'normal',
      shouldPause: false,
      affectedTaskIds: [],
      affectedAgentIds: [],
      requiresBriefRevision: false,
      requiresUserConfirmation: false,
      coordinatorInstruction: ''
    },
    status: 'queued',
    queuedAt: '2026-09-15T00:00:00.000Z'
  }] as never;

  const retry = service as unknown as {
    retryFailedSession(session: SessionDetail, sourceEventId: string): void;
  };
  retry.retryFailedSession(service.get(session.id), 'event-bare-resume');
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));

  // 排队消息被消费，而不是被静默忽略。
  assert.equal(followUpPreparations.length, 1);
  assert.ok(events.some((event) =>
    (event.metadata as { payload?: { reason?: string } }).payload?.reason ===
      'resume_hands_over_to_queued_follow_up'
  ));
});

test('a bare resume without queued messages still recovers from the checkpoint', async () => {
  const { service, followUpPreparations } = makeService();
  const { session } = await service.create({ input: 'Resume from the checkpoint with an empty queue' });
  const svc = service as any;
  let executions = 0;
  svc.resumeExecution = () => { executions++; };
  (service as unknown as { briefGenerationRuns: Map<string, unknown> }).briefGenerationRuns.delete(session.id);
  session.status = 'EXECUTING';
  session.currentTaskBriefId = 'brief-existing';
  await service.interruptForRuntimeDisconnect({
    sessionId: session.id,
    invocationId: 'invocation-empty-queue',
    reason: 'local_runtime_disconnected',
    occurredAt: '2026-09-15T00:00:00.000Z'
  });
  session.pendingFollowUpMessages = [];

  const retry = service as unknown as {
    retryFailedSession(session: SessionDetail, sourceEventId: string): void;
  };
  retry.retryFailedSession(service.get(session.id), 'event-bare-resume-empty');
  await new Promise<void>((resolve) => setImmediate(resolve));

  // 裸「继续」在没有排队消息时仍走检查点恢复，不重建契约。
  assert.equal(followUpPreparations.length, 0);
  assert.equal(executions, 1);
});

test('restart recovery leaves an interrupted Session queued instead of redriving it', async () => {
  // recovery.service 的边界：运行时调用绝不自动重驱（会重复执行命令、重复写文件）。
  // 双锁解开后这条门禁必须显式挡住 INTERRUPTED，否则启动即自动重排。
  const fixture = routingRecoveryFixture({
    sessionStatus: 'INTERRUPTED',
    requestedAction: 'continue_work_item',
    actionStatus: 'pending',
    followUpStatus: 'queued'
  });

  const recovered = await fixture.service.recoverIntentRoutings([fixture.session.id]);

  assert.equal(recovered.some((item) => item.action === 'follow_up_rescheduled'), false);
  assert.equal(fixture.followUp.status, 'queued');
  assert.equal(fixture.executionStarts.length, 0);
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
  assert.deepEqual(session.pendingFollowUpMessages ?? [], []);
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
  assert.deepEqual(session.pendingFollowUpMessages ?? [], []);
});

test('continue resolves a resumable user decision without invoking Receiver or creating a new brief', async () => {
  const fixture = makeService();
  const { session } = await fixture.service.create({ input: 'Continue the current implementation' });
  (fixture.service as unknown as { briefGenerationRuns: Map<string, unknown> }).briefGenerationRuns.delete(session.id);
  session.currentTaskBriefId = 'brief-existing';
  session.status = 'WAIT_USER_DECISION';
  fixture.events.push({
    id: 'confirmation-event-resume-current',
    sessionId: session.id,
    type: 'user_confirmation_requested',
    toAgentIds: [],
    content: '路由需要用户决定是否继续。',
    metadata: {
      payload: {
        confirmationId: 'confirmation-resume-current',
        reason: 'coordinator_routing_needs_user_decision',
        options: [
          { key: 'resume', label: '继续执行' },
          { key: 'cancel', label: '取消' }
        ]
      }
    },
    createdAt: '2026-08-11T00:00:00.000Z'
  });

  const first = await fixture.service.sendMessage(session.id, '继续', [], 'resume-current-1');
  const replay = await fixture.service.sendMessage(session.id, '继续', [], 'resume-current-1');

  assert.equal(first.handlingPlan.intent, 'command');
  assert.equal(first.handlingPlan.failedExecutionAction, 'resume');
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.handlingPlan.intent, 'command');
  assert.equal(session.status, 'EXECUTING');
  assert.deepEqual(fixture.followUpRecognitions, []);
  assert.equal(fixture.followUpPreparations.length, 0);
  assert.equal(fixture.executionStarts.length, 1);
  assert.deepEqual(session.pendingFollowUpMessages ?? [], []);
  assert.ok(fixture.events.some((event) =>
    event.type === 'user_confirmation_resolved' &&
    (event.metadata as { payload?: { confirmationId?: string } }).payload?.confirmationId ===
      'confirmation-resume-current'
  ));
  const exactRoutingMessage = fixture.events.find((event) =>
    event.type === 'agent_message' &&
    (event.metadata as { payload?: { phase?: string } }).payload?.phase === 'exact_command_routing'
  );
  assert.equal(exactRoutingMessage?.content, '已收到继续指令，正在恢复当前任务。');
});

test('continue fails closed when more than one unresolved confirmation exists', async () => {
  const fixture = makeService();
  const { session } = await fixture.service.create({ input: 'Wait for an explicit decision' });
  (fixture.service as unknown as { briefGenerationRuns: Map<string, unknown> }).briefGenerationRuns.delete(session.id);
  session.currentTaskBriefId = 'brief-existing';
  session.status = 'WAIT_USER_DECISION';
  for (const confirmationId of ['confirmation-a', 'confirmation-b']) {
    fixture.events.push({
      id: `event-${confirmationId}`,
      sessionId: session.id,
      type: 'user_confirmation_requested',
      toAgentIds: [],
      content: '请选择下一步。',
      metadata: {
        payload: {
          confirmationId,
          reason: 'coordinator_routing_needs_user_decision',
          options: [{ key: 'resume', label: '继续执行' }]
        }
      },
      createdAt: '2026-08-11T00:00:00.000Z'
    });
  }

  const result = await fixture.service.sendMessage(session.id, '继续');

  assert.equal(result.handlingPlan.requiresUserConfirmation, true);
  assert.equal(session.status, 'WAIT_USER_DECISION');
  assert.equal(fixture.executionStarts.length, 0);
  assert.equal(fixture.events.filter((event) => event.type === 'user_confirmation_resolved').length, 0);
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

  const generation = service.lifecycleState(session.id).lifecycle.generation;
  await service.applyQueuedExecutionOutcome(session.id, { kind: 'delivered' }, generation);

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

test('workflow Agent substitution requires an explicit candidate selection', async () => {
  const workflowSubstitutionCalls: Array<{ runId: string; taskId: string; agentId: string; confirmationId?: string }> = [];
  const { service, events } = makeService({ workflowSubstitutionCalls });
  const { session } = await service.create({ input: 'Run a backend workflow stage.' });
  session.workflowRunId = 'workflow-run-substitution';
  session.participatingAgentIds = ['coordinator', 'backend', 'test'];

  service.applyOutcome(session.id, {
    kind: 'ask_user',
    reason: 'Backend Agent rejected the current stage.',
    workflowAgentSubstitution: {
      taskId: 'workflow-task-substitution',
      workflowRunId: session.workflowRunId,
      workflowNodeId: 'backend-node',
      currentAgentId: 'backend',
      candidates: [{ id: 'test', key: 'test', name: 'test', role: 'test' }]
    }
  });

  const confirmation = events.find((event) => event.type === 'user_confirmation_requested');
  const payload = confirmation?.metadata
    ? (confirmation.metadata as { payload?: {
        confirmationId?: string;
        reason?: string;
        candidateAgentIds?: string[];
        options?: Array<{ key: string }>;
      } }).payload
    : undefined;
  assert.equal(payload?.reason, 'workflow_agent_substitution');
  assert.deepEqual(payload?.candidateAgentIds, ['test']);
  assert.deepEqual(payload?.options?.map((option: { key: string }) => option.key), ['agent:test', 'skip_agent', 'cancel']);
  const confirmationId = payload?.confirmationId;
  assert.ok(confirmationId);

  await assert.rejects(
    service.resolveWorkflowAgentSubstitution(session.id, {
      confirmationId,
      taskId: 'workflow-task-substitution',
      agentId: 'backend'
    }),
    /not an approved substitution candidate/
  );

  await service.resolveWorkflowAgentSubstitution(session.id, {
    confirmationId,
    taskId: 'workflow-task-substitution',
    agentId: 'test'
  });

  assert.deepEqual(workflowSubstitutionCalls, [{
    runId: 'workflow-run-substitution',
    taskId: 'workflow-task-substitution',
    agentId: 'test',
    confirmationId
  }]);
  assert.equal(session.status, 'EXECUTING');
  assert.ok(events.some((event) => event.type === 'user_confirmation_resolved'));
});

test('ordinary resume keeps a parked workflow Agent substitution waiting for an explicit decision', async () => {
  const fixture = makeService();
  const { session } = await fixture.service.create({ input: 'Run a backend workflow stage.' });
  session.workflowRunId = 'workflow-run-resume-guard';
  session.status = 'WAIT_USER_DECISION';
  (fixture.service as unknown as { workflowRuntime: unknown }).workflowRuntime = {
    awaitsAgentSubstitution: (runId: string) => runId === session.workflowRunId,
    awaitsUpstreamRerun: () => false
  } as never;

  const result = await fixture.service.resume(session.id, '继续执行');

  assert.equal(result.session.status, 'WAIT_USER_DECISION');
  assert.equal(result.event?.metadata.payload?.status, 'WAIT_USER_DECISION');
  assert.equal(result.event?.metadata.payload?.requestedStatus, 'EXECUTING');
  assert.equal(result.confirmationEvent, undefined);
});

test('chat skip-current-Agent command resolves workflow substitution without creating a follow-up brief', async () => {
  const workflowSkipCalls: Array<{ runId: string; taskId: string; reason: string; confirmationId?: string }> = [];
  const fixture = makeService({ workflowSkipCalls });
  const { session } = await fixture.service.create({ input: 'Run a backend workflow stage.' });
  (fixture.service as unknown as { briefGenerationRuns: Map<string, unknown> }).briefGenerationRuns.delete(session.id);
  session.workflowRunId = 'workflow-run-skip';
  session.participatingAgentIds = ['coordinator', 'backend', 'test'];

  fixture.service.applyOutcome(session.id, {
    kind: 'ask_user',
    reason: 'Backend Agent rejected the current stage.',
    workflowAgentSubstitution: {
      taskId: 'workflow-task-skip',
      workflowRunId: session.workflowRunId,
      workflowNodeId: 'backend-node',
      currentAgentId: 'backend',
      candidates: [{ id: 'test', key: 'test', name: 'test', role: 'test' }]
    }
  });
  const eventCountBeforeCommand = fixture.events.length;

  const result = await fixture.service.sendMessage(session.id, '跳过这个 Agent，继续执行');

  assert.equal(result.handlingPlan.intent, 'command');
  assert.equal(result.followUpMessageId, undefined);
  assert.deepEqual(workflowSkipCalls, [{
    runId: 'workflow-run-skip',
    taskId: 'workflow-task-skip',
    reason: '跳过这个 Agent，继续执行',
    confirmationId: 'workflow-agent-substitution:workflow-run-skip:workflow-task-skip'
  }]);
  assert.equal(fixture.followUpPreparations.length, 0);
  assert.equal(session.pendingFollowUpMessages?.length ?? 0, 0);
  assert.equal(session.status, 'EXECUTING');
  const commandEvents = fixture.events.slice(eventCountBeforeCommand);
  assert.ok(commandEvents.some((event) => event.type === 'user_confirmation_resolved'));
  assert.equal(commandEvents.some((event) =>
    event.type === 'session_status_changed' &&
    (event.metadata as { payload?: { status?: string } }).payload?.status === 'AGENT_DISCUSSING'
  ), false);
});

async function substitutionDirectiveFixture() {
  const workflowSubstitutionCalls: Array<{ runId: string; taskId: string; agentId: string; confirmationId?: string }> = [];
  const fixture = makeService({ workflowSubstitutionCalls });
  const { session } = await fixture.service.create({ input: 'Run a backend workflow stage.' });
  (fixture.service as unknown as { briefGenerationRuns: Map<string, unknown> }).briefGenerationRuns.delete(session.id);
  session.workflowRunId = 'workflow-run-directive';
  session.participatingAgentIds = ['coordinator', 'backend', 'test', 'frontend'];
  fixture.service.applyOutcome(session.id, {
    kind: 'ask_user',
    reason: 'Backend Agent rejected the current stage.',
    workflowAgentSubstitution: {
      taskId: 'workflow-task-directive',
      workflowRunId: session.workflowRunId,
      workflowNodeId: 'backend-node',
      currentAgentId: 'backend',
      candidates: [
        { id: 'test', key: 'test', name: 'test', role: 'test' },
        { id: 'frontend', key: 'frontend', name: 'frontend', role: 'frontend' }
      ]
    }
  });
  return { fixture, session, workflowSubstitutionCalls };
}

test('chat Agent directive reassigns the workflow node to the named candidate', async () => {
  const { fixture, session, workflowSubstitutionCalls } = await substitutionDirectiveFixture();

  const result = await fixture.service.sendMessage(session.id, '让 frontend 执行');

  assert.equal(result.handlingPlan.intent, 'command');
  assert.equal(result.followUpMessageId, undefined);
  assert.deepEqual(workflowSubstitutionCalls, [{
    runId: 'workflow-run-directive',
    taskId: 'workflow-task-directive',
    agentId: 'frontend',
    confirmationId: 'workflow-agent-substitution:workflow-run-directive:workflow-task-directive'
  }]);
  assert.equal(session.status, 'EXECUTING');
  assert.equal(fixture.followUpPreparations.length, 0);
});

test('chat Agent directive asks back instead of guessing an unknown or ambiguous target', async () => {
  const unknown = await substitutionDirectiveFixture();
  const unknownResult = await unknown.fixture.service.sendMessage(unknown.session.id, '让数据库工程师执行');
  assert.equal(unknownResult.handlingPlan.requiresUserConfirmation, true);
  assert.deepEqual(unknown.workflowSubstitutionCalls, []);
  assert.equal(unknown.session.status, 'WAIT_USER_DECISION');
  assert.ok(unknown.fixture.events.some((event) =>
    event.type === 'agent_message' && String(event.content).includes('没有匹配到')
  ));

  const ordinary = await substitutionDirectiveFixture();
  const ordinaryResult = await ordinary.fixture.service.sendMessage(
    ordinary.session.id,
    '让登录页面支持记住密码'
  );
  // An ordinary requirement must stay on the normal routing path even while the card is open.
  assert.deepEqual(ordinary.workflowSubstitutionCalls, []);
  assert.notEqual(ordinaryResult.handlingPlan.coordinatorInstruction, '按用户指定的 Agent 改派当前工作流节点。');
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

function routingRecoveryFixture(input: {
  sessionStatus: SessionDetail['status'];
  requestedAction: 'pause' | 'cancel' | 'continue_work_item';
  actionStatus: 'pending' | 'applying' | 'applied' | 'failed';
  followUpStatus: 'queued' | 'planning' | 'executing' | 'completed' | 'failed' | 'cancelled';
  includePendingFollowUp?: boolean;
  routingStatus?: 'CLASSIFYING' | 'VALIDATING' | 'APPLYING' | 'ROUTED';
  leaseExpiresAt?: string;
  rolloutMode?: 'shadow' | 'enforce_new_sessions';
}) {
  const sessionId = `session-routing-recovery-${input.requestedAction}-${input.actionStatus}`;
  const followUp = {
    id: `follow-up-${sessionId}`,
    sourceEventId: `event-${sessionId}`,
    content: 'Recover the persisted routing action.',
    mentionedAgentIds: [],
    handlingPlan: {
      intent: 'command',
      priority: 'normal',
      shouldPause: false,
      affectedTaskIds: [],
      affectedAgentIds: [],
      requiresBriefRevision: false,
      requiresUserConfirmation: false,
      coordinatorInstruction: 'Recover the action.'
    },
    routingId: `routing-${sessionId}`,
    status: input.followUpStatus,
    queuedAt: '2026-08-08T00:00:00.000Z'
  };
  const session = {
    id: sessionId,
    dataEpoch: 'epoch-test',
    title: 'Routing recovery',
    originalInput: 'Recover routing state.',
    status: input.sessionStatus,
    ownerId: 'local-user',
    workspaceId: `workspace-${sessionId}`,
    tokenUsed: 0,
    participatingAgentIds: ['coordinator'],
    pendingFollowUpMessages: input.includePendingFollowUp === false ? [] : [structuredClone(followUp)],
    activeFollowUpMessageId: input.includePendingFollowUp === false ? undefined : followUp.id,
    createdAt: '2026-08-08T00:00:00.000Z',
    updatedAt: '2026-08-08T00:00:00.000Z'
  } as SessionDetail;
  const routing = {
    id: followUp.routingId,
    sessionId,
    sourceEventId: followUp.sourceEventId,
    sessionSeq: 1,
    status: input.routingStatus ?? 'ROUTED',
    policyVersion: 'intent-v2-test',
    rolloutMode: input.rolloutMode ?? 'enforce_new_sessions',
    decision: { requestedAction: input.requestedAction },
    actionStatus: input.actionStatus,
    snapshotId: input.routingStatus && input.routingStatus !== 'ROUTED' ? `snapshot-${sessionId}` : undefined,
    leaseOwner: input.leaseExpiresAt ? 'other-worker' : undefined,
    leaseExpiresAt: input.leaseExpiresAt,
    reasonCodes: [],
    retryCount: 0,
    idempotencyKey: `routing:${sessionId}`,
    createdAt: '2026-08-08T00:00:00.000Z',
    updatedAt: '2026-08-08T00:00:00.000Z'
  };
  const actionStatusUpdates: string[] = [];
  const followUpStatusUpdates: string[] = [];
  return {
    ...makeService({
      initialSessions: [session],
      routingRecovery: {
        routings: [routing],
        followUps: [followUp],
        actionStatusUpdates,
        followUpStatusUpdates
      }
    }),
    session,
    routing,
    followUp,
    actionStatusUpdates,
    followUpStatusUpdates
  };
}

test('intent routing recovery finalizes an applied pause without planning the FollowUp again', async () => {
  const fixture = routingRecoveryFixture({
    sessionStatus: 'PAUSED',
    requestedAction: 'pause',
    actionStatus: 'applied',
    followUpStatus: 'queued'
  });

  const recovered = await fixture.service.recoverIntentRoutings([fixture.session.id]);

  assert.deepEqual(recovered.map((item) => item.action), ['pause_completion_recovered']);
  assert.deepEqual(fixture.followUpStatusUpdates, ['completed']);
  assert.equal(fixture.followUp.status, 'completed');
  assert.deepEqual(fixture.service.get(fixture.session.id).pendingFollowUpMessages, []);
  assert.equal(fixture.executionStarts.length, 0);
});

test('intent routing recovery preserves an active worker lease and schedules takeover retry', async () => {
  const fixture = routingRecoveryFixture({
    sessionStatus: 'WAIT_USER_DECISION',
    requestedAction: 'continue_work_item',
    actionStatus: 'pending',
    followUpStatus: 'queued',
    routingStatus: 'CLASSIFYING',
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString()
  });
  try {
    const recovered = await fixture.service.recoverIntentRoutings([fixture.session.id]);
    assert.deepEqual(recovered.map((item) => item.action), ['active_lease_preserved']);
    assert.equal(fixture.routing.status, 'CLASSIFYING');
    assert.equal(fixture.routing.leaseOwner, 'other-worker');
  } finally {
    fixture.service.onModuleDestroy();
  }
});

test('intent routing recovery treats an already cancelled Session as an idempotently applied action', async () => {
  const fixture = routingRecoveryFixture({
    sessionStatus: 'CANCELLED',
    requestedAction: 'cancel',
    actionStatus: 'applying',
    followUpStatus: 'queued'
  });

  const recovered = await fixture.service.recoverIntentRoutings([fixture.session.id]);

  assert.deepEqual(recovered.map((item) => item.action), ['cancel_recovered']);
  assert.deepEqual(fixture.actionStatusUpdates, ['applying', 'applied']);
  assert.deepEqual(fixture.followUpStatusUpdates, ['cancelled']);
  assert.equal(fixture.routing.actionStatus, 'applied');
  assert.equal(fixture.followUp.status, 'cancelled');
  assert.deepEqual(fixture.executionCancels, []);
});

test('intent routing recovery does not requeue a terminal FollowUp after restart', async () => {
  const fixture = routingRecoveryFixture({
    sessionStatus: 'COMPLETED',
    requestedAction: 'continue_work_item',
    actionStatus: 'applied',
    followUpStatus: 'completed',
    includePendingFollowUp: false
  });

  const recovered = await fixture.service.recoverIntentRoutings([fixture.session.id]);

  assert.deepEqual(recovered, []);
  assert.deepEqual(fixture.session.pendingFollowUpMessages, []);
  assert.deepEqual(fixture.followUpStatusUpdates, []);
  assert.equal(fixture.executionStarts.length, 0);
});

test('intent routing recovery does not apply a shadow-mode pause after restart', async () => {
  // `finish()` records shadow decisions as ROUTED too, so without the rollout gate
  // a pause that was never meant to run would be applied on the next boot.
  const fixture = routingRecoveryFixture({
    sessionStatus: 'EXECUTING',
    requestedAction: 'pause',
    actionStatus: 'pending',
    followUpStatus: 'queued',
    rolloutMode: 'shadow'
  });

  const recovered = await fixture.service.recoverIntentRoutings([fixture.session.id]);

  assert.equal(fixture.service.get(fixture.session.id).status, 'EXECUTING');
  assert.equal(recovered.some((item) => item.action === 'pause_recovered'), false);
  assert.deepEqual(fixture.actionStatusUpdates, []);
});

test('intent routing recovery does not apply a shadow-mode cancel after restart', async () => {
  const fixture = routingRecoveryFixture({
    sessionStatus: 'EXECUTING',
    requestedAction: 'cancel',
    actionStatus: 'pending',
    followUpStatus: 'queued',
    rolloutMode: 'shadow'
  });

  const recovered = await fixture.service.recoverIntentRoutings([fixture.session.id]);

  assert.equal(fixture.service.get(fixture.session.id).status, 'EXECUTING');
  assert.equal(recovered.some((item) => item.action === 'cancel_recovered'), false);
  assert.deepEqual(fixture.actionStatusUpdates, []);
});

// ---------------------------------------------------------------------------
// Phase 4 T2: the confirmation binds to the exact document version shown
// ---------------------------------------------------------------------------

function documentConfirmationFixture(input: { cardDocumentRevision: number; cardHash: string; latestRevision: number; latestHash: string }) {
  const session: SessionDetail = {
    id: 'session-doc-confirm',
    dataEpoch: 'epoch-test',
    title: 'Document confirmation',
    originalInput: 'Confirm the current document.',
    status: 'WAIT_USER_CONFIRM',
    ownerId: 'local-user',
    workspaceId: 'workspace-doc-confirm',
    tokenUsed: 0,
    currentTaskBriefId: 'brief-doc',
    activeWorkItemId: 'wi-doc',
    decisionLedgerRevision: 2,
    participatingAgentIds: ['coordinator'],
    createdAt: '2026-09-19T00:00:00.000Z',
    updatedAt: '2026-09-19T00:00:00.000Z'
  };
  const fixture = makeService({ initialSessions: [session] });
  fixture.persistedState.workItemsBySession = { [session.id]: [{ id: 'wi-doc', revision: 3 }] };
  const document = (revision: number, hash: string, status: string) => ({
    id: `doc-${revision}`, sessionId: session.id, workItemId: 'wi-doc', workItemRevision: 3, documentRevision: revision,
    contentHash: hash, status, publishedByAgentId: 'coordinator', sourceDecisionIds: [], sourceDelegationIds: [],
    sections: { goal: `v${revision}`, scope: [], outOfScope: [], acceptanceCriteria: [], risks: [], pendingItems: [] },
    createdAt: '2026-09-19T00:00:00.000Z'
  });
  const docs = input.latestRevision > input.cardDocumentRevision
    ? [document(input.cardDocumentRevision, input.cardHash, 'superseded'), document(input.latestRevision, input.latestHash, 'formal')]
    : [document(input.cardDocumentRevision, input.cardHash, 'formal')];
  fixture.persistedState.requirementDocumentsBySession = { [session.id]: docs };
  fixture.events.push({
    id: 'doc-confirmation-request',
    sessionId: session.id,
    type: 'user_confirmation_requested',
    content: 'Confirm the document.',
    toAgentIds: [],
    metadata: {
      schemaVersion: '0.1',
      payload: {
        confirmationId: 'doc-confirmation-1',
        reason: 'confirm_task_brief',
        relatedBriefId: 'brief-doc',
        documentId: `doc-${input.cardDocumentRevision}`,
        documentRevision: input.cardDocumentRevision,
        contentHash: input.cardHash,
        workItemRevision: 3,
        businessFingerprint: requirementConfirmationFingerprint({ workItemRevision: 3, documentRevision: input.cardDocumentRevision, contentHash: input.cardHash, decisionLedgerRevision: 2 }),
        options: [{ key: 'approve', label: 'Approve' }]
      }
    },
    createdAt: '2026-09-19T00:00:00.000Z'
  });
  return { session, fixture };
}

test('a confirmation for a version the user no longer sees is refused as stale with the current version attached', async () => {
  const { session, fixture } = documentConfirmationFixture({ cardDocumentRevision: 1, cardHash: 'h1', latestRevision: 2, latestHash: 'h2' });

  await assert.rejects(
    () => fixture.service.confirmBrief(session.id, 'brief-doc', 'doc-confirmation-1'),
    (error: unknown) => {
      const response = (error as { getResponse?: () => unknown }).getResponse?.() as { code?: string; current?: { documentRevision?: number; contentHash?: string } } | undefined;
      return response?.code === 'stale_confirmation' && response.current?.documentRevision === 2 && response.current?.contentHash === 'h2';
    }
  );
  assert.equal(fixture.service.get(session.id).status, 'WAIT_USER_CONFIRM', 'nothing was approved');
  assert.equal(fixture.events.some((event) => event.type === 'user_confirmation_resolved' && (event.metadata as { payload?: { status?: string } }).payload?.status === 'approved'), false);
  const docs = fixture.persistedState.requirementDocumentsBySession as Record<string, Array<{ status: string }>>;
  assert.equal(docs[session.id]?.some((item) => item.status === 'confirmed'), false, 'no document was confirmed');
});

test('a matching confirmation confirms the exact document version once and is idempotent on replay', async () => {
  const { session, fixture } = documentConfirmationFixture({ cardDocumentRevision: 1, cardHash: 'h1', latestRevision: 1, latestHash: 'h1' });

  await fixture.service.confirmBrief(session.id, 'brief-doc', 'doc-confirmation-1');

  const docs = fixture.persistedState.requirementDocumentsBySession as Record<string, Array<{ id: string; status: string; confirmationId?: string }>>;
  assert.equal(docs[session.id]?.[0]?.status, 'confirmed');
  assert.equal(docs[session.id]?.[0]?.confirmationId, 'doc-confirmation-1');
  assert.equal(fixture.service.get(session.id).status, 'WAIT_WORKFLOW_SELECT');
  const resolvedBefore = fixture.events.filter((event) => event.type === 'user_confirmation_resolved').length;

  // A double click or a retried request is the same confirmation, not an error.
  await fixture.service.confirmBrief(session.id, 'brief-doc', 'doc-confirmation-1');
  assert.equal(fixture.events.filter((event) => event.type === 'user_confirmation_resolved').length, resolvedBefore, 'no second resolution');
  assert.equal(fixture.service.get(session.id).status, 'WAIT_WORKFLOW_SELECT');
});

// ---------------------------------------------------------------------------
// Phase 4 T2-3: the two phase-3 cards get their decisions
// ---------------------------------------------------------------------------

function discussionCardFixture(card: 'confirm_member_addition' | 'discussion_clarification') {
  const session: SessionDetail = {
    id: 'session-cards',
    dataEpoch: 'epoch-test',
    title: 'Cards',
    originalInput: 'x',
    status: 'AGENT_DISCUSSING',
    ownerId: 'local-user',
    workspaceId: 'workspace-cards',
    tokenUsed: 0,
    activeWorkItemId: 'wi-1',
    participatingAgentIds: ['coordinator', 'backend'],
    createdAt: '2026-09-19T00:00:00.000Z',
    updatedAt: '2026-09-19T00:00:00.000Z'
  };
  const fixture = makeService({ initialSessions: [session] });
  fixture.events.push({
    id: `${card}-request`,
    sessionId: session.id,
    type: 'user_confirmation_requested',
    content: 'card',
    toAgentIds: [],
    metadata: {
      schemaVersion: '0.1',
      payload: card === 'confirm_member_addition'
        ? { confirmationId: 'card-1', reason: card, discussionId: 'run-1', targetAgentId: 'architect', targetAgentKey: 'architect', objective: '评估架构', expectedResult: '风险', options: [] }
        : { confirmationId: 'card-1', reason: card, discussionId: 'run-1', options: [] }
    },
    createdAt: '2026-09-19T00:00:00.000Z'
  });
  return { session, fixture };
}

test('approving a member addition adds the member and consults them; declining only closes the card', async () => {
  const approved = discussionCardFixture('confirm_member_addition');
  await approved.fixture.service.resolveMemberAddition(approved.session.id, { discussionId: 'run-1', confirmationId: 'card-1', decision: 'approve' });
  assert.deepEqual(approved.fixture.service.get(approved.session.id).participatingAgentIds, ['coordinator', 'backend', 'architect']);
  assert.deepEqual(approved.fixture.memberConsultations, [{ sessionId: approved.session.id, discussionId: 'run-1', agentId: 'architect', objective: '评估架构', expectedResult: '风险' }]);
  const resolved = approved.fixture.events.find((event) => event.type === 'user_confirmation_resolved');
  assert.equal((resolved?.metadata as { payload?: { status?: string } })?.payload?.status, 'approved');

  const declined = discussionCardFixture('confirm_member_addition');
  await declined.fixture.service.resolveMemberAddition(declined.session.id, { discussionId: 'run-1', confirmationId: 'card-1', decision: 'decline' });
  assert.deepEqual(declined.fixture.service.get(declined.session.id).participatingAgentIds, ['coordinator', 'backend'], 'declined members are not added');
  assert.deepEqual(declined.fixture.memberConsultations, []);
  assert.equal((declined.fixture.events.find((event) => event.type === 'user_confirmation_resolved')?.metadata as { payload?: { status?: string } })?.payload?.status, 'declined');

  // The same card cannot be decided twice.
  await assert.rejects(() => approved.fixture.service.resolveMemberAddition(approved.session.id, { discussionId: 'run-1', confirmationId: 'card-1', decision: 'approve' }));
});

test('a clarification card is answered in chat or accepted as-is, never silently', async () => {
  const proceed = discussionCardFixture('discussion_clarification');
  await proceed.fixture.service.resolveDiscussionClarification(proceed.session.id, { discussionId: 'run-1', confirmationId: 'card-1', decision: 'proceed_anyway' });
  assert.deepEqual(proceed.fixture.acceptedSyntheses, [{ sessionId: proceed.session.id, discussionId: 'run-1' }]);

  const answer = discussionCardFixture('discussion_clarification');
  await answer.fixture.service.resolveDiscussionClarification(answer.session.id, { discussionId: 'run-1', confirmationId: 'card-1', decision: 'answer_in_chat' });
  assert.deepEqual(answer.fixture.acceptedSyntheses, [], 'answering in chat does not close the run; the next message reopens a round');
  const resolved = answer.fixture.events.find((event) => event.type === 'user_confirmation_resolved');
  assert.equal((resolved?.metadata as { payload?: { selectedOptionKey?: string } })?.payload?.selectedOptionKey, 'answer_in_chat');
});

// ---------------------------------------------------------------------------
// Phase 4 T3: workflow selection is read-only and never silently adds members
// ---------------------------------------------------------------------------

function workflowSelectionFixture(input: { involvedAgentIds: string[]; participating: string[]; confirmedBrief?: boolean }) {
  const session: SessionDetail = {
    id: 'session-select',
    dataEpoch: 'epoch-test',
    title: 'Select',
    originalInput: 'x',
    status: 'WAIT_WORKFLOW_SELECT',
    ownerId: 'local-user',
    workspaceId: 'workspace-select',
    tokenUsed: 0,
    currentTaskBriefId: 'brief-select',
    activeWorkItemId: 'wi-1',
    workspaceMode: 'bootstrap',
    participatingAgentIds: input.participating,
    createdAt: '2026-09-19T00:00:00.000Z',
    updatedAt: '2026-09-19T00:00:00.000Z'
  };
  const fixture = makeService({ initialSessions: [session] });
  const version = {
    id: 'wf-1@1', workflowId: 'wf-1', version: 1, name: 'Delivery', nodes: [], edges: [],
    involvedAgentIds: input.involvedAgentIds, definitionHash: 'hash-wf-1', publishedBy: 'admin', publishedAt: '2026-09-19T00:00:00.000Z'
  };
  const starts: unknown[] = [];
  (fixture.service as unknown as { workflows: unknown }).workflows = {
    get: () => ({ id: 'wf-1', name: 'Delivery', status: 'published', nodes: [], version: 1, currentPublishedVersion: 1 }),
    getVersion: () => version,
    list: () => []
  } as never;
  const run = { id: 'run-1', workflowId: 'wf-1', workflowVersion: 1, startIdempotencyKey: 'k', status: 'running' };
  (fixture.service as unknown as { workflowRuntime: unknown }).workflowRuntime = {
    findBySession: () => undefined,
    get: () => run,
    async start(startInput: unknown) {
      starts.push(startInput);
      return run;
    }
  } as never;
  (fixture.service as unknown as { orchestrator: { getBrief: unknown } }).orchestrator.getBrief = () => ({
    id: 'brief-select', sessionId: session.id, version: 1, goal: 'g', scope: [], outOfScope: [], constraints: [],
    acceptanceCriteria: [], risks: [], openQuestions: [], confirmedByUser: input.confirmedBrief ?? true, createdAt: '2026-09-19T00:00:00.000Z'
  });
  fixture.events.push({
    id: 'select-request', sessionId: session.id, type: 'user_confirmation_requested', content: 'select', toAgentIds: [],
    metadata: { schemaVersion: '0.1', payload: { confirmationId: 'select-1', reason: 'select_workflow', options: [] } },
    createdAt: '2026-09-19T00:00:00.000Z'
  });
  return { session, fixture, starts };
}

test('selecting a workflow whose agents are not all in the session asks the user instead of adding them', async () => {
  const { session, fixture, starts } = workflowSelectionFixture({ involvedAgentIds: ['coordinator', 'architect'], participating: ['coordinator'] });

  await assert.rejects(
    () => fixture.service.selectWorkflow(session.id, { workflowId: 'wf-1', confirmationId: 'select-1' }),
    (error: unknown) => {
      const response = (error as { getResponse?: () => unknown }).getResponse?.() as { code?: string } | undefined;
      return response?.code === 'capability_mapping_required';
    }
  );
  assert.deepEqual(fixture.service.get(session.id).participatingAgentIds, ['coordinator'], 'no silent member merge');
  assert.equal(starts.length, 0, 'no run started');
  const card = fixture.events.find((event) => (event.metadata as { payload?: { reason?: string } }).payload?.reason === 'confirm_workflow_member_mapping');
  assert.ok(card, 'the coordinator asks the user to resolve the mapping');
  const payload = (card!.metadata as { payload: Record<string, unknown> }).payload;
  assert.deepEqual(payload.addableAgentIds, ['architect']);
  assert.equal(payload.workflowId, 'wf-1');
  assert.equal(payload.workflowVersion, 1);
  assert.equal(payload.definitionHash, 'hash-wf-1', 'the card locks the exact version it was evaluated against');
  assert.equal(fixture.service.get(session.id).status, 'WAIT_WORKFLOW_SELECT', 'selection stays open');
});

test('approving the mapping card adds the members and the same selection then starts against the locked version', async () => {
  const { session, fixture, starts } = workflowSelectionFixture({ involvedAgentIds: ['coordinator', 'architect'], participating: ['coordinator'] });
  await assert.rejects(() => fixture.service.selectWorkflow(session.id, { workflowId: 'wf-1', confirmationId: 'select-1' }));
  const card = fixture.events.find((event) => (event.metadata as { payload?: { reason?: string } }).payload?.reason === 'confirm_workflow_member_mapping')!;
  const mappingConfirmationId = (card.metadata as { payload: { confirmationId: string } }).payload.confirmationId;

  await fixture.service.resolveWorkflowMemberMapping(session.id, { confirmationId: mappingConfirmationId, decision: 'approve' });
  assert.deepEqual(fixture.service.get(session.id).participatingAgentIds, ['coordinator', 'architect']);

  await fixture.service.selectWorkflow(session.id, { workflowId: 'wf-1', confirmationId: 'select-1' });
  assert.equal(starts.length, 1);
  const start = starts[0] as { workflowVersion?: number; definitionHash?: string };
  assert.equal(start.workflowVersion, 1);
  assert.equal(start.definitionHash, 'hash-wf-1', 'the start binds the version hash the user saw');
});

test('a workflow whose agent is disabled cannot be resolved by inviting and stays blocked', async () => {
  const { session, fixture, starts } = workflowSelectionFixture({ involvedAgentIds: ['coordinator', 'retired-agent'], participating: ['coordinator'] });
  (fixture.service as unknown as { agents: { findByIdOrKey: unknown } }).agents.findByIdOrKey = (id: string) =>
    id === 'retired-agent' ? { id, key: id, name: 'Retired', status: 'disabled' } : { id, key: id, name: id, status: 'active' };

  await assert.rejects(() => fixture.service.selectWorkflow(session.id, { workflowId: 'wf-1', confirmationId: 'select-1' }));
  const card = fixture.events.find((event) => (event.metadata as { payload?: { reason?: string } }).payload?.reason === 'confirm_workflow_member_mapping')!;
  const payload = (card.metadata as { payload: Record<string, unknown> }).payload;
  assert.deepEqual(payload.addableAgentIds, []);
  assert.match(String(payload.description), /Retired/);
  assert.equal(starts.length, 0);
});

test('selection requires a confirmed brief', async () => {
  const { session, fixture } = workflowSelectionFixture({ involvedAgentIds: ['coordinator'], participating: ['coordinator'], confirmedBrief: false });
  await assert.rejects(() => fixture.service.selectWorkflow(session.id, { workflowId: 'wf-1', confirmationId: 'select-1' }), /confirmed brief/);
});

type StartStoreView = {
  workflowStarts: {
    list(sessionId: string): Array<{
      id: string;
      logicalKey: string;
      status: string;
      claimedBy?: string;
      workflowRunId?: string;
      binding: Record<string, unknown>;
    }>;
  };
};

test('a selection submits one durable start request bound to the document and workflow versions', async () => {
  const { session, fixture, starts } = workflowSelectionFixture({ involvedAgentIds: ['coordinator'], participating: ['coordinator'] });

  await fixture.service.selectWorkflow(session.id, { workflowId: 'wf-1', confirmationId: 'select-1' });

  const requests = (fixture.service as unknown as StartStoreView).workflowStarts.list(session.id);
  assert.equal(requests.length, 1, 'one decision is one durable start request');
  assert.equal(requests[0].status, 'completed');
  assert.equal(requests[0].workflowRunId, 'run-1', 'the request records the run it produced');
  assert.ok(requests[0].claimedBy, 'the dispatching worker is attributable after a crash');
  assert.equal(requests[0].binding.definitionHash, 'hash-wf-1');
  assert.equal(requests[0].binding.workflowVersion, 1);
  assert.equal(starts.length, 1);
});

test('a replayed selection resolves to the recorded run instead of starting a second one', async () => {
  const { session, fixture, starts } = workflowSelectionFixture({ involvedAgentIds: ['coordinator'], participating: ['coordinator'] });
  await fixture.service.selectWorkflow(session.id, { workflowId: 'wf-1', confirmationId: 'select-1' });
  session.status = 'WAIT_WORKFLOW_SELECT';

  const replay = await fixture.service.selectWorkflow(session.id, { workflowId: 'wf-1', confirmationId: 'select-1' });

  assert.equal(starts.length, 1, 'a retried click must not start the requirement twice');
  assert.equal(replay.workflowRun?.id, 'run-1');
  assert.equal((fixture.service as unknown as StartStoreView).workflowStarts.list(session.id).length, 1);
});

test('a dispatch that crashed before recording its run is recovered without forking the request', async () => {
  const { session, fixture, starts } = workflowSelectionFixture({ involvedAgentIds: ['coordinator'], participating: ['coordinator'] });
  const store = (fixture.service as unknown as StartStoreView).workflowStarts as unknown as {
    list(sessionId: string): Array<{ id: string; status: string; workflowRunId?: string }>;
    submit(input: { binding: Record<string, unknown>; generation?: number }): Promise<{ status: string; request: { id: string } }>;
    claim(id: string, input: { workerId: string }): Promise<{ status: string }>;
  };
  // A worker claimed the request and died before WorkflowRuntime recorded a run.
  const submitted = await store.submit({
    binding: {
      sessionId: session.id, workItemId: 'wi-1', workItemRevision: 1, confirmationId: 'select-1',
      documentId: 'brief-select', documentRevision: 1, contentHash: 'brief:brief-select:1',
      workflowId: 'wf-1', workflowVersion: 1, definitionHash: 'hash-wf-1'
    }
  });
  await store.claim(submitted.request.id, { workerId: 'worker-crashed' });
  assert.equal(store.list(session.id)[0].status, 'dispatched');
  assert.equal(store.list(session.id)[0].workflowRunId, undefined);

  await fixture.service.selectWorkflow(session.id, { workflowId: 'wf-1', confirmationId: 'select-1' });

  const requests = store.list(session.id);
  assert.equal(requests.length, 1, 'recovery reuses the request rather than submitting a new one');
  assert.equal(requests[0].status, 'completed');
  assert.equal(requests[0].workflowRunId, 'run-1');
  assert.equal(starts.length, 1);
});

test('a progress question during execution is answered from state without any model call', async () => {
  const runtimeCalls: string[] = [];
  const fixture = makeService({ runtimeCalls });
  const { session } = await fixture.service.create({ input: '实现订单导出。' });
  session.status = 'EXECUTING';
  session.workflowRunId = 'run-status';
  (fixture.service as unknown as { workflowRuntime: unknown }).workflowRuntime = {
    findBySession: () => ({
      id: 'run-status', status: 'running', currentNodeId: 'develop',
      definitionSnapshot: { nodes: [
        { id: 'requirements', type: 'agent', name: '需求梳理', order: 0 },
        { id: 'develop', type: 'agent', name: '开发实现', order: 1 }
      ] }
    })
  } as never;

  const before = fixture.followUpRecognitions.length;
  const result = await fixture.service.sendMessage(session.id, '现在做到哪一步了？');

  // The answer is a coordinator message derived from the published graph.
  const answer = fixture.events.filter((event) => event.type === 'agent_message').at(-1);
  assert.ok(String((answer?.metadata as { payload?: { text?: string } })?.payload?.text ?? answer?.content ?? '')
    .includes('开发实现'), 'the answer names the current stage from the snapshot');
  assert.equal(result.handlingPlan.intent, 'question');
  assert.equal(result.handlingPlan.shouldPause, false);
  assert.equal(result.handlingPlan.requiresBriefRevision, false, 'a read-only question never revises the contract');
  // No expert discussion, no runtime invocation: the whole point of the short circuit.
  assert.equal(runtimeCalls.length, 0, 'answering progress must not call a model');
  assert.equal(fixture.followUpRecognitions.length, before, 'no semantic routing for a plain status read');
  assert.equal(fixture.service.get(session.id).status, 'EXECUTING', 'the run keeps going');
});

test('a progress question that also carries a requirement is not short circuited', async () => {
  const fixture = makeService();
  const { session } = await fixture.service.create({ input: '实现订单导出。' });
  session.status = 'EXECUTING';
  session.workflowRunId = 'run-status-2';

  const before = fixture.followUpRecognitions.length;
  await fixture.service.sendMessage(session.id, '进度如何？顺便加一个导出按钮');

  assert.ok(fixture.followUpRecognitions.length > before, 'a scope change must reach the router, not the status reply');
});

test('an @ question during execution is a bounded consultation that leaves the run alone', async () => {
  const runtimeCalls: string[] = [];
  const fixture = makeService({ runtimeCalls });
  const { session } = await fixture.service.create({ input: '实现订单导出。' });
  session.status = 'EXECUTING';
  session.workflowRunId = 'run-consult';
  session.participatingAgentIds = ['coordinator', 'architect'];

  const plans = fixture.followUpPreparations.length;
  const result = await fixture.service.sendMessage(session.id, '这个改动对架构影响大吗？', ['architect']);

  // Exactly one targeted consultation; no follow-up brief, no task re-planning.
  assert.deepEqual(
    fixture.executionConsultations.map((item) => item.agentIds),
    [['architect']],
    'only the named expert is consulted'
  );
  assert.equal(fixture.followUpPreparations.length, plans, 'a question must not re-plan the requirement');
  assert.equal(result.handlingPlan.requiresBriefRevision, false);
  assert.equal(result.handlingPlan.shouldPause, false);
  assert.equal(fixture.service.get(session.id).status, 'EXECUTING', 'the run keeps going');
  assert.equal(fixture.executionCancels.length, 0, 'no workflow node is cancelled or re-run');
});

test('an @ message that changes scope during execution is not treated as a consultation', async () => {
  const fixture = makeService();
  const { session } = await fixture.service.create({ input: '实现订单导出。' });
  session.status = 'EXECUTING';
  session.workflowRunId = 'run-consult-2';
  session.participatingAgentIds = ['coordinator', 'architect'];

  await fixture.service.sendMessage(session.id, '@架构 把导出改成分页接口', ['architect']);

  assert.deepEqual(fixture.executionConsultations, [], 'a requirement must not be answered as a read-only consultation');
});

test('an execution-time scope change opens one analysed change request and leaves the contract alone', async () => {
  const fixture = makeService({ taskItems: [
    { id: 'task-1', sessionId: 'x', title: '实现导出接口', status: 'running', workflowNodeId: 'develop' } as never,
    { id: 'task-2', sessionId: 'x', title: '补充用例', status: 'pending', workflowNodeId: 'quality' } as never
  ] });
  const { session } = await fixture.service.create({ input: '实现订单导出。' });
  session.status = 'EXECUTING';
  session.workflowRunId = 'run-change';
  session.activeWorkItemId = 'wi-change';

  const plans = fixture.followUpPreparations.length;
  const result = await fixture.service.sendMessage(session.id, '顺便加一个导出按钮');

  // One durable request, analysed against the versions it was raised on.
  const requests = (fixture.service as unknown as {
    changeRequests: { list(sessionId: string): Array<Record<string, unknown>> };
  }).changeRequests.list(session.id);
  assert.equal(requests.length, 1, 'one message opens exactly one change request');
  assert.equal(requests[0].status, 'waiting_user', 'the user must choose before anything moves');
  const analysis = requests[0].analysis as { affectedTaskIds?: string[]; options?: string[] } | undefined;
  assert.ok(analysis, 'the card must carry an impact analysis, not a bare ack');
  assert.ok((analysis.options ?? []).includes('pause_and_revise'), 'the choice set is offered explicitly');

  // The card is the handoff to the user; the contract is untouched until they pick.
  const card = fixture.events.find((event) => event.type === 'user_confirmation_requested'
    && (event.metadata as { payload?: { reason?: string } })?.payload?.reason === 'execution_scope_change');
  assert.ok(card, 'a scope change raises its own confirmation card');
  assert.equal(result.handlingPlan.requiresBriefRevision, false, 'nothing is revised before the user chooses');
  assert.equal(fixture.followUpPreparations.length, plans, 'no re-planning happens on the raise');
  assert.equal(fixture.service.get(session.id).status, 'EXECUTING', 'the run is not stopped by the raise itself');

  // A replayed submit (web + desktop) is the same request.
  await fixture.service.sendMessage(session.id, '顺便加一个导出按钮');
  assert.equal((fixture.service as unknown as {
    changeRequests: { list(sessionId: string): unknown[] };
  }).changeRequests.list(session.id).length, 1, 'a duplicate submit does not queue twice');
});
