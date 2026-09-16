import test from 'node:test';
import assert from 'node:assert/strict';
import type { SessionDetail } from '@agent-cluster/shared';
import { RecoveryService } from './recovery.service.js';

process.env.AGENT_CLUSTER_RECOVER_ON_BOOT = 'true';

function makeSession(status: SessionDetail['status']): SessionDetail {
  return {
    id: `session-${status.toLowerCase()}`,
    dataEpoch: 'epoch-test',
    workspaceId: `workspace-${status.toLowerCase()}`,
    status,
    currentTaskBriefId: 'brief-1'
  } as SessionDetail;
}

function makeFixture(sessions: SessionDetail[], events?: {
  list(sessionId: string): Array<Record<string, unknown>>;
  create(input: Record<string, unknown>): unknown;
}, contextManagement?: {
  activeWorkItem(session: SessionDetail): { id: string } | undefined;
  ensureInitialWorkItem(
    session: SessionDetail,
    idempotencyKey: string,
    input: string | undefined,
    workItemStatus: string | undefined
  ): Promise<{ id: string }>;
}, persistedState: Record<string, unknown> = {}, legacyMigration?: {
  report(sessions: SessionDetail[], mode?: 'report' | 'apply'): { sessionCount: number; plannedRecordCount: number; issues: unknown[]; revision: string };
  apply(sessions: SessionDetail[]): Promise<{ sessionCount: number; migratedRecordCount: number; issues: unknown[] }>;
}) {
  const interruptions: Array<{
    sessionId: string;
    invocationId?: string;
    occurredAt: string;
    graceful: boolean;
    diagnosticRef?: string;
  }> = [];
  const reconciledSessions: string[] = [];
  const service = new RecoveryService(
    {
      listRaw: () => sessions,
      async recoverFileRevisions() {
        return [];
      },
      interruptForServiceShutdown(input: (typeof interruptions)[number]) {
        interruptions.push(input);
        const session = sessions.find((candidate) => candidate.id === input.sessionId);
        if (session) session.status = 'INTERRUPTED';
        return Boolean(session);
      },
      reconcileRecoveryStateOnBoot(sessionId: string) {
        reconciledSessions.push(sessionId);
      }
    } as never,
    {
      currentDataEpoch: () => 'epoch-test',
      stateRevision: () => 1,
      async mutateStateAtomically(
        _revision: number,
        mutator: (draft: Record<string, unknown>) => unknown
      ) {
        return mutator(persistedState);
      },
      releaseWorkspaceSessionLease: async () => undefined,
      reconcileWorkspaceSessionLeases: async () => undefined
    } as never,
    undefined,
    events as never,
    contextManagement as never,
    legacyMigration as never
  );
  return { service, interruptions, reconciledSessions, persistedState };
}

test('records service_shutdown and persists the unmatched invocation as wakeable without re-running it', async () => {
  const session = makeSession('EXECUTING');
  const created: Array<Record<string, unknown>> = [];
  const events = {
    list: () => [
      {
        id: 'runtime-started',
        sessionId: session.id,
        workItemId: 'work-item-1',
        type: 'runtime_started',
        fromAgentId: 'agent-1',
        toAgentIds: [],
        content: 'started',
        metadata: {
          schemaVersion: '0.1',
          payload: { runtimeInvocationId: 'invocation-1', runtimeType: 'codex' }
        },
        createdAt: new Date().toISOString()
      }
    ],
    create: (input: Record<string, unknown>) => {
      created.push(input);
      return input;
    }
  };
  const { service, interruptions } = makeFixture([session], events);

  await service.onApplicationBootstrap();

  assert.equal(created.length, 1);
  assert.equal(created[0].workItemId, 'work-item-1');
  const payload = (created[0].metadata as { payload: Record<string, unknown> }).payload;
  assert.equal((payload.termination as { kind?: string }).kind, 'service_shutdown');
  assert.equal((payload.termination as { graceful?: boolean }).graceful, false);
  assert.equal(interruptions.length, 1);
  assert.equal(interruptions[0]?.sessionId, session.id);
  assert.equal(interruptions[0]?.invocationId, 'invocation-1');
  assert.equal(interruptions[0]?.graceful, false);
  assert.equal(interruptions[0]?.diagnosticRef, 'recovered_on_boot');
});

test('migrates legacy Session-owned records to the active WorkItem idempotently on boot', async () => {
  const previousMode = process.env.AGENT_CLUSTER_WORKITEM_MIGRATION_MODE;
  process.env.AGENT_CLUSTER_WORKITEM_MIGRATION_MODE = 'apply';
  try {
  const session = makeSession('COMPLETED');
  session.activeWorkItemId = 'work-item-legacy';
  const state: Record<string, unknown> = {
    eventsBySession: { [session.id]: [{ id: 'event-1' }] },
    briefsBySession: { [session.id]: [{ id: 'brief-1' }] },
    tasksBySession: { [session.id]: [{ id: 'task-1' }] },
    memoriesBySession: { [session.id]: [{ id: 'memory-1' }] },
    runtimeInvocationsBySession: { [session.id]: [{ id: 'invocation-1' }] },
    artifacts: {
      artifactsById: {
        'artifact-1': { id: 'artifact-1', sessionId: session.id },
        'artifact-other': { id: 'artifact-other', sessionId: 'session-other' }
      }
    },
    workflowRuntime: {
      runs: [
        { id: 'run-1', sessionId: session.id },
        { id: 'run-other', sessionId: 'session-other' }
      ]
    }
  };
  const contextManagement = {
    activeWorkItem: () => ({ id: 'work-item-legacy' }),
    async ensureInitialWorkItem() {
      throw new Error('active WorkItem should be reused');
    }
  };
  const legacyMigration = {
    report: () => ({ sessionCount: 1, plannedRecordCount: 7, issues: [], revision: '1' }),
    async apply() {
      for (const key of ['eventsBySession', 'briefsBySession', 'tasksBySession', 'memoriesBySession', 'runtimeInvocationsBySession']) {
        const records = (state[key] as Record<string, Array<Record<string, unknown>>>)[session.id] ?? [];
        for (const item of records) item.workItemId = 'work-item-legacy';
      }
      (state.artifacts as { artifactsById: Record<string, Record<string, unknown>> }).artifactsById['artifact-1'].workItemId = 'work-item-legacy';
      (state.workflowRuntime as { runs: Array<Record<string, unknown>> }).runs[0].workItemId = 'work-item-legacy';
      return { sessionCount: 1, migratedRecordCount: 7, issues: [] };
    }
  };
  const { service } = makeFixture([session], undefined, contextManagement, state, legacyMigration);

  await service.onApplicationBootstrap();
  await service.onApplicationBootstrap();

  for (const key of [
    'eventsBySession',
    'briefsBySession',
    'tasksBySession',
    'memoriesBySession',
    'runtimeInvocationsBySession'
  ]) {
    const grouped = state[key] as Record<string, Array<Record<string, unknown>>>;
    assert.equal(grouped[session.id]?.[0]?.workItemId, 'work-item-legacy');
  }
  const artifacts = state.artifacts as { artifactsById: Record<string, Record<string, unknown>> };
  assert.equal(artifacts.artifactsById['artifact-1']?.workItemId, 'work-item-legacy');
  assert.equal(artifacts.artifactsById['artifact-other']?.workItemId, undefined);
  const workflowRuntime = state.workflowRuntime as { runs: Array<Record<string, unknown>> };
  assert.equal(workflowRuntime.runs[0]?.workItemId, 'work-item-legacy');
  assert.equal(workflowRuntime.runs[1]?.workItemId, undefined);
  } finally {
    if (previousMode === undefined) delete process.env.AGENT_CLUSTER_WORKITEM_MIGRATION_MODE;
    else process.env.AGENT_CLUSTER_WORKITEM_MIGRATION_MODE = previousMode;
  }
});

test('reports legacy ownership by default without mutating persisted records', async () => {
  const session = makeSession('COMPLETED');
  session.activeWorkItemId = 'work-item-legacy';
  const state = { eventsBySession: { [session.id]: [{ id: 'event-1' }] } } as Record<string, unknown>;
  let reportMode: string | undefined;
  const legacyMigration = {
    report(_sessions: SessionDetail[], mode: 'report' | 'apply' = 'report') {
      reportMode = mode;
      return { sessionCount: 1, plannedRecordCount: 1, issues: [], revision: '1' };
    },
    async apply() { throw new Error('apply must not be called in report mode'); }
  };
  const previousMode = process.env.AGENT_CLUSTER_WORKITEM_MIGRATION_MODE;
  delete process.env.AGENT_CLUSTER_WORKITEM_MIGRATION_MODE;
  try {
    const { service } = makeFixture([session], undefined, undefined, state, legacyMigration);
    await service.onApplicationBootstrap();
    assert.equal(reportMode, 'report');
    assert.equal((state.eventsBySession as Record<string, Array<Record<string, unknown>>>)[session.id][0].workItemId, undefined);
  } finally {
    if (previousMode === undefined) delete process.env.AGENT_CLUSTER_WORKITEM_MIGRATION_MODE;
    else process.env.AGENT_CLUSTER_WORKITEM_MIGRATION_MODE = previousMode;
  }
});

test('converts every in-flight Session state to a wakeable interruption on boot', async () => {
  const activeStatuses: SessionDetail['status'][] = [
    'AGENT_DISCUSSING',
    'REVISING_BRIEF',
    'EXECUTING',
    'POST_REVIEW',
    'REWORKING'
  ];
  const sessions = activeStatuses.map(makeSession);
  const { service, interruptions, reconciledSessions } = makeFixture(sessions);

  await service.onApplicationBootstrap();

  assert.deepEqual(interruptions.map((item) => item.sessionId), sessions.map((session) => session.id));
  assert.ok(interruptions.every((item) => item.graceful === false));
  assert.ok(sessions.every((session) => session.status === 'INTERRUPTED'));
  assert.deepEqual(reconciledSessions, sessions.map((session) => session.id));
});

test('leaves user-waiting and terminal Sessions untouched on boot', async () => {
  const sessions = [
    makeSession('WAIT_USER_CONFIRM'),
    makeSession('WAIT_WORKFLOW_SELECT'),
    makeSession('WAIT_WORKFLOW_STEP_CONFIRM'),
    makeSession('WAIT_USER_DECISION'),
    makeSession('PAUSED'),
    makeSession('COMPLETED'),
    makeSession('FAILED'),
    makeSession('CANCELLED'),
    makeSession('INTERRUPTED')
  ];
  const { service, interruptions } = makeFixture(sessions);

  await service.onApplicationBootstrap();

  assert.deepEqual(interruptions, []);
});

test('bootstraps an interrupted Session WorkItem as WAITING_USER rather than FAILED', async () => {
  const previousMode = process.env.AGENT_CLUSTER_WORKITEM_MIGRATION_MODE;
  process.env.AGENT_CLUSTER_WORKITEM_MIGRATION_MODE = 'apply';
  try {
    const session = makeSession('INTERRUPTED');
    const observedStatuses: Array<string | undefined> = [];
    const contextManagement = {
      activeWorkItem: () => undefined,
      async ensureInitialWorkItem(
        _session: SessionDetail,
        _idempotencyKey: string,
        _input: string | undefined,
        workItemStatus: string | undefined
      ) {
        observedStatuses.push(workItemStatus);
        return { id: 'work-item-bootstrapped' };
      }
    };
    const legacyMigration = {
      report: () => ({ sessionCount: 1, plannedRecordCount: 0, issues: [], revision: '1' }),
      async apply() {
        return { sessionCount: 1, migratedRecordCount: 0, issues: [] };
      }
    };
    const { service } = makeFixture([session], undefined, contextManagement, {}, legacyMigration);

    await service.onApplicationBootstrap();

    assert.deepEqual(observedStatuses, ['WAITING_USER']);
  } finally {
    if (previousMode === undefined) delete process.env.AGENT_CLUSTER_WORKITEM_MIGRATION_MODE;
    else process.env.AGENT_CLUSTER_WORKITEM_MIGRATION_MODE = previousMode;
  }
});

test('honors the explicit startup interruption disable switch', async () => {
  const previous = process.env.AGENT_CLUSTER_RECOVER_ON_BOOT;
  process.env.AGENT_CLUSTER_RECOVER_ON_BOOT = 'false';
  try {
    const { service, interruptions } = makeFixture([makeSession('EXECUTING')]);
    await service.onApplicationBootstrap();
    assert.deepEqual(interruptions, []);
  } finally {
    process.env.AGENT_CLUSTER_RECOVER_ON_BOOT = previous;
  }
});
