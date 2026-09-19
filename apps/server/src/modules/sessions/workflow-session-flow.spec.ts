import test from 'node:test';
import assert from 'node:assert/strict';
import type { SessionDetail, WorkflowRun } from '@agent-cluster/shared';
import { SessionsService } from './sessions.service.js';

function setup(emptyWorkspace = false, confirmedByUser = true) {
  const session: SessionDetail = {
    id: 'session-workflow', dataEpoch: 'epoch-test', title: 'Workflow session', originalInput: 'Implement and verify the requirement.',
    status: 'WAIT_WORKFLOW_SELECT', ownerId: 'local-user', workspaceId: 'workspace', tokenUsed: 0,
    currentTaskBriefId: 'brief-1', participatingAgentIds: ['coordinator', 'requirements'],
    ...(emptyWorkspace ? {
      workingDirectory: { kind: 'local_bridge' as const, id: 'workspace', name: 'empty-project', selectedAt: '2026-07-13T00:00:00.000Z' },
      workspaceSnapshot: {
        rootName: 'empty-project', scannedAt: '2026-07-13T00:00:00.000Z',
        fileCount: 0, totalBytes: 0, tree: [], files: [], skipped: []
      }
    } : {}),
    createdAt: '2026-07-13T00:00:00.000Z', updatedAt: '2026-07-13T00:00:00.000Z'
  };
  const events = [{
    id: 'confirmation-select', sessionId: session.id, type: 'user_confirmation_requested',
    metadata: { payload: { confirmationId: 'confirm-workflow', reason: 'select_workflow' } }
  }];
  const starts: Array<Record<string, unknown>> = [];
  let runtimeSubscriber: ((update: Record<string, unknown>) => void) | undefined;
  const version = {
    id: 'version-2', workflowId: 'workflow-1', version: 2, name: '研发交付流程',
    nodes: [{ id: 'node-requirements', type: 'agent' as const, agentId: 'requirements', order: 0 }],
    edges: [], involvedAgentIds: ['requirements'], definitionHash: 'hash', publishedBy: 'local-user', publishedAt: '2026-07-13T00:00:00.000Z'
  };
  const run: WorkflowRun = {
    id: 'run-1', workflowId: 'workflow-1', workflowVersion: 2, workflowName: version.name,
    sessionId: session.id, briefId: 'brief-1', ownerId: session.ownerId, definitionSnapshot: version,
    status: 'running', currentNodeId: 'node-requirements', revision: 1, runtimeVersion: 'v2',
    startIdempotencyKey: `${session.id}:confirm-workflow`, createdAt: session.createdAt, updatedAt: session.updatedAt
  };
  const agentsById = new Map([
    ['coordinator', { id: 'coordinator', key: 'coordinator', name: 'Coordinator', role: 'coordination' }],
    ['requirements', { id: 'requirements', key: 'requirements', name: '需求分析师', role: 'requirements' }]
  ]);
  const service = new SessionsService(
    {
      findByIdOrKey: (id: string) => agentsById.get(id),
      getByIdOrKey: (id: string) => {
        const agent = agentsById.get(id);
        if (!agent) throw new Error(`Agent not found: ${id}`);
        return agent;
      },
      list: () => [...agentsById.values()]
    } as never,
    { list: () => events, create: (event: Record<string, unknown>) => { events.push(event as never); return event; } } as never,
    {} as never,
    {} as never,
    {
      getBrief: () => ({ id: 'brief-1', sessionId: session.id, confirmedByUser, acceptanceCriteria: ['Each stage is reviewable.'] }),
      ensureArchitectureReportSaveConfirmation() {},
      registerSavePendingInvocationCallback() {},
      deleteSession() {}
    } as never,
    { cancel() {} } as never,
    { list: () => [] } as never,
    { getCollection: () => [session], currentDataEpoch: () => 'epoch-test', setCollection() {} } as never,
    { registerApprovalListener() {} } as never,
    {
      get: () => ({ id: 'workflow-1', name: version.name, status: 'published', draftRevision: 3, version: 3, currentPublishedVersion: 2, nodes: version.nodes, edges: [], createdAt: session.createdAt, updatedAt: session.updatedAt }),
      getVersion: (_id: string, requestedVersion?: number) => {
        assert.equal(requestedVersion, 2);
        return version;
      }
    } as never,
    {
      updates: () => ({ subscribe(callback: (update: Record<string, unknown>) => void) { runtimeSubscriber = callback; } }),
      findBySession: () => starts.length ? run : undefined,
      get: () => run,
      async start(input: Record<string, unknown>) { starts.push(input); return run; }
    } as never
  );
  return { service, session, starts, run, emitRuntimeUpdate: (update: Record<string, unknown>) => runtimeSubscriber?.(update) };
}

test('workflow selection binds the exact published version and delegates execution to WorkflowRuntime', async () => {
  const { service, session, starts, run } = setup();
  const result = await service.selectWorkflow(session.id, {
    workflowId: 'workflow-1', workflowVersion: 2, confirmationId: 'confirm-workflow'
  });
  assert.equal(session.status, 'EXECUTING');
  assert.equal(session.workflowRunId, run.id);
  // Selection never grows the roster on its own: a missing member raises
  // capability_mapping_required for the user to decide (AC5).
  assert.deepEqual(session.participatingAgentIds, ['coordinator', 'requirements']);
  assert.equal(starts.length, 1);
  assert.equal(starts[0].workflowVersion, 2);
  assert.ok(result.workflowRun);
  assert.equal(result.workflowRun.definitionSnapshot.version, 2);
});

test('empty workspace pauses workflow selection until bootstrap is explicitly approved', async () => {
  const { service, session, starts } = setup(true);
  const deferred = await service.selectWorkflow(session.id, {
    workflowId: 'workflow-1', workflowVersion: 2, confirmationId: 'confirm-workflow'
  });
  assert.equal(session.status, 'WAIT_USER_DECISION');
  assert.equal(session.workspaceMode, 'empty_pending_decision');
  assert.equal(deferred.workflowRun, undefined);
  assert.equal(starts.length, 0);

  const confirmation = (service as unknown as { events: { list(sessionId: string): Array<{ metadata: { payload?: Record<string, unknown> } }> } })
    .events.list(session.id)
    .find((event) => event.metadata.payload?.reason === 'initialize_empty_workspace');
  assert.ok(confirmation);
  await service.resolveEmptyWorkspaceDecision(session.id, {
    confirmationId: String(confirmation.metadata.payload?.confirmationId),
    decision: 'initialize_project'
  });
  assert.equal(session.workspaceMode, 'bootstrap');
  assert.equal(session.status, 'EXECUTING');
  assert.equal(starts.length, 1);
});

test('workflow selection replays one confirmation once and rejects switching its version', async () => {
  const { service, session, starts, run } = setup();
  const input = { workflowId: 'workflow-1', workflowVersion: 2, confirmationId: 'confirm-workflow' };
  await service.selectWorkflow(session.id, input);
  const replay = await service.selectWorkflow(session.id, input);
  assert.equal(replay.workflowRun?.id, run.id);
  assert.equal(starts.length, 1);
  await assert.rejects(service.selectWorkflow(session.id, { ...input, workflowVersion: 3 }), /different workflow version/);
  assert.equal(starts.length, 1);
});

test('an unconfirmed revised brief cannot start a selected workflow', async () => {
  const { service, session, starts } = setup(false, false);
  await assert.rejects(service.selectWorkflow(session.id, { workflowId: 'workflow-1', workflowVersion: 2, confirmationId: 'confirm-workflow' }), /confirmed brief is missing/);
  assert.equal(starts.length, 0);
});

test('completed empty Provider index pauses workflow selection without a legacy Snapshot', async () => {
  const { service, session, starts } = setup();
  const observedAt = '2026-07-30T00:00:00.000Z';
  session.workingDirectory = {
    kind: 'local_bridge', id: 'workspace', name: 'empty-indexed-project', selectedAt: observedAt
  };
  session.workspaceIndex = {
    workspaceId: 'workspace', revision: { id: 'revision-empty', observedAt }, generation: 1,
    status: 'ready', complete: true, entries: [], entrypoints: [], detectedStack: [], indexedEntries: 0,
    truncated: false, updatedAt: observedAt,
    coverage: {
      visitedEntries: 0, indexedEntries: 0, excludedGenerated: 0, sensitiveEntries: 0,
      skippedSymlinks: 0, failedEntries: 0
    }
  };

  const deferred = await service.selectWorkflow(session.id, {
    workflowId: 'workflow-1', workflowVersion: 2, confirmationId: 'confirm-workflow'
  });

  assert.equal(session.status, 'WAIT_USER_DECISION');
  assert.equal(session.workspaceMode, 'empty_pending_decision');
  assert.equal(deferred.workflowRun, undefined);
  assert.equal(starts.length, 0);
});

test('workflow runtime projection pauses the session only for an explicit human gate', async () => {
  const { service, session, emitRuntimeUpdate } = setup();
  await service.selectWorkflow(session.id, { workflowId: 'workflow-1', workflowVersion: 2, confirmationId: 'confirm-workflow' });
  emitRuntimeUpdate({ kind: 'projection', sessionId: session.id, workflowRunId: 'run-1', status: 'waiting_human', revision: 4 });
  assert.equal(session.status, 'WAIT_WORKFLOW_STEP_CONFIRM');
  emitRuntimeUpdate({ kind: 'projection', sessionId: session.id, workflowRunId: 'run-1', status: 'running', revision: 5 });
  assert.equal(session.status, 'EXECUTING');
});
