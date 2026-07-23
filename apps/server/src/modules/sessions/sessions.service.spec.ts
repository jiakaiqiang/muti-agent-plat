import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionDetail } from '@agent-cluster/shared';
import { SessionsService } from './sessions.service.js';

function makeService(options: { failHydration?: boolean; cleanupCalls?: string[] } = {}) {
  const persistedSessions: SessionDetail[] = [];
  const events: Array<Record<string, unknown>> = [];
  const executionStarts: Array<{ sessionId: string; taskCount: number }> = [];
  const executionCancels: string[] = [];
  const discussionStarts: string[] = [];
  const service = new SessionsService(
    {
      resolveIds(agentIds?: string[]) {
        return agentIds ?? ['coordinator'];
      },
      findByIdOrKey(id: string) {
        return {
          id,
          key: id,
          name: id,
          role: id,
          status: 'active',
          capabilityIds: [],
          defaultKnowledgeBaseIds: [],
          createdAt: '2026-07-11T00:00:00.000Z',
          updatedAt: '2026-07-11T00:00:00.000Z'
        };
      },
      list() {
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
      list() {
        return events;
      },
      deleteSession() {}
    } as never,
    { deleteSession() {} } as never,
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
      discussAndCreateBrief(_session: SessionDetail, signal?: AbortSignal) {
        discussionStarts.push('started');
        return new Promise((_resolve, reject) => {
          if (signal?.aborted) reject(signal.reason);
          else signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
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
      async hydrateSupplementalContext(_session: SessionDetail, requestedContext: { requestedPaths?: string[] }) {
        const requestedPaths = requestedContext.requestedPaths ?? [];
        const hydratedPaths = options.failHydration ? [] : requestedPaths;
        return {
          requestedPaths,
          hydratedPaths,
          failedPaths: options.failHydration
            ? requestedPaths.map((path) => ({ path, code: 'BROKER_OFFLINE', retryable: true }))
            : [],
          deferredPaths: [],
          contentBytes: hydratedPaths.length * 10
        };
      },
      deleteSession() {}
    } as never,
    {
      start(session: SessionDetail, _brief: unknown, tasks: unknown[]) {
        executionStarts.push({ sessionId: session.id, taskCount: tasks.length });
      },
      cancel(sessionId: string) {
        executionCancels.push(sessionId);
      },
      async cancelAndWait(sessionId: string) {
        executionCancels.push(sessionId);
        options.cleanupCalls?.push(`terminate:${sessionId}`);
        return { requested: true, completed: true, timedOut: false };
      }
    } as never,
    {
      resetStaleRunning() {},
      unfinished() {
        return [];
      },
      cancelUnfinished() {
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
      setCollection(_key: string, value: SessionDetail[]) {
        persistedSessions.splice(0, persistedSessions.length, ...value);
      }
    } as never,
    undefined,
    undefined,
    options.cleanupCalls ? { async deleteSessionDirectory(sessionId: string) { options.cleanupCalls!.push(`worktree:${sessionId}`); } } as never : undefined,
    options.cleanupCalls ? { async deleteSessionDirectory(sessionId: string) { options.cleanupCalls!.push(`mirror:${sessionId}`); } } as never : undefined,
    options.cleanupCalls ? { deleteSessionDirectory(sessionId: string) { options.cleanupCalls!.push(`brief:${sessionId}`); } } as never : undefined
  );
  return { service, persistedSessions, events, executionStarts, executionCancels, discussionStarts };
}

test('deleting a Session clears all corresponding runtime directories before persistence', async () => {
  const cleanupCalls: string[] = [];
  const { service, persistedSessions } = makeService({ cleanupCalls });
  const { session } = await service.create({ input: 'Delete this Session later' });

  const result = await service.delete(session.id);

  assert.deepEqual(cleanupCalls, [
    `terminate:${session.id}`,
    `worktree:${session.id}`,
    `mirror:${session.id}`,
    `brief:${session.id}`
  ]);
  assert.deepEqual(result, { deleted: true, sessionId: session.id });
  assert.equal(persistedSessions.length, 0);
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

test('continue retries failed task-contract generation instead of only emitting a receiver message', async () => {
  const { service, events, discussionStarts } = makeService();
  const { session } = await service.create({ input: 'Analyze the workspace' });
  session.status = 'FAILED';
  session.currentTaskBriefId = undefined;

  await service.sendMessage(session.id, '继续');

  assert.equal(session.status, 'AGENT_DISCUSSING');
  assert.equal(discussionStarts.length, 2);
  assert.ok(events.some((event) =>
    event.type === 'session_status_changed' &&
    event.content === '收到继续指令，正在重新生成任务契约。'
  ));
});

test('continue retries failed task-contract regeneration even when an older Brief exists', async () => {
  const { service, events, discussionStarts, executionStarts } = makeService();
  const { session } = await service.create({ input: 'Analyze the workspace' });
  session.currentTaskBriefId = 'brief-existing';
  (service as unknown as {
    failSession(session: SessionDetail, error: unknown, phase: string): void;
  }).failSession(session, new Error('brief regeneration failed'), 'brief_generation');

  await service.sendMessage(session.id, '重试');

  assert.equal(session.status, 'AGENT_DISCUSSING');
  assert.equal(discussionStarts.length, 2);
  assert.equal(executionStarts.length, 0);
  assert.ok(events.some((event) =>
    event.type === 'session_status_changed' &&
    event.content === '收到继续指令，正在重新生成任务契约。'
  ));
});

test('explicit server-local working directory is validated and scanned before persistence', async () => {
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
    assert.equal(session.workspaceSnapshot?.rootName, session.workingDirectory?.name);
    assert.ok(session.workspaceSnapshot?.files.some((file) => file.path === 'package.json'));
    assert.equal(persistedSessions[0]?.workingDirectory?.path, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('browser-local working directory becomes the Session workspace identity', async () => {
  const { service } = makeService();
  const { session } = await service.create({
    input: 'Analyze this browser workspace',
    workingDirectory: {
      kind: 'browser_local',
      id: 'browser-workspace-id',
      name: 'browser-project',
      selectedAt: '2026-07-14T00:00:00.000Z'
    },
    workspaceSnapshot: {
      rootName: 'browser-project',
      tree: [],
      files: [],
      skipped: [],
      fileCount: 0,
      totalBytes: 0,
      scannedAt: '2026-07-14T00:00:00.000Z'
    },
    runtimePreference: { preferredRuntimeType: 'codex', allowedRuntimeTypes: ['codex'] }
  });

  assert.equal(session.workspaceId, 'browser-workspace-id');
  assert.equal(session.workingDirectory?.kind, 'browser_local');
});

test('refreshing a canonical browser workspace updates every Session that shares its workspaceId', async () => {
  const { service, persistedSessions } = makeService();
  const workingDirectory = {
    kind: 'browser_local' as const,
    id: 'shared-browser-workspace',
    name: 'shared-project',
    selectedAt: '2026-07-14T00:00:00.000Z'
  };
  const initialSnapshot = {
    rootName: 'shared-project',
    scannedAt: '2026-07-14T00:00:00.000Z',
    revision: { id: 'revision-1', observedAt: '2026-07-14T00:00:00.000Z' },
    fileCount: 0,
    totalBytes: 0,
    tree: [],
    files: [],
    skipped: []
  };
  const first = (await service.create({ input: 'First task', workingDirectory, workspaceSnapshot: initialSnapshot })).session;
  const second = (await service.create({ input: 'Second task', workingDirectory, workspaceSnapshot: initialSnapshot })).session;
  const refreshedSnapshot = {
    ...initialSnapshot,
    scannedAt: '2026-07-14T00:01:00.000Z',
    revision: { id: 'revision-2', observedAt: '2026-07-14T00:01:00.000Z' },
    fileCount: 1,
    totalBytes: 12,
    files: [{ path: 'src/main.ts', size: 12, content: 'export {}\n' }]
  };

  const result = service.refreshBrowserWorkspaceSnapshot(first.id, workingDirectory.id, refreshedSnapshot);

  assert.deepEqual(new Set(result.updatedSessionIds), new Set([first.id, second.id]));
  assert.equal(service.get(first.id).workspaceSnapshot?.revision?.id, 'revision-2');
  assert.equal(service.get(second.id).workspaceSnapshot?.revision?.id, 'revision-2');
  assert.equal(persistedSessions.find((item) => item.id === second.id)?.workspaceSnapshot?.fileCount, 1);
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
    context.session.supplementalContextRequests?.at(-1)?.requestedContext.requestedPaths,
    ['src/feature.ts']
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
