import test from 'node:test';
import assert from 'node:assert/strict';
import type { SessionDetail } from '@agent-cluster/shared';
import { RecoveryService } from './recovery.service.js';
import { BrokerGateway } from '../workspaces/browser-broker/broker-gateway.js';

process.env.AGENT_CLUSTER_RECOVER_ON_BOOT = 'true';
process.env.ENABLE_BULLMQ = 'false';

function makeSession(status: SessionDetail['status']): SessionDetail {
  return {
    id: `session-${status.toLowerCase()}`,
    dataEpoch: 'epoch-test',
    status,
    currentTaskBriefId: 'brief-1'
  } as SessionDetail;
}

function makeBrowserSession(status: SessionDetail['status']): SessionDetail {
  return {
    ...makeSession(status),
    workspaceId: 'workspace-browser',
    workingDirectory: {
      kind: 'browser_local',
      id: 'workspace-browser',
      name: 'browser-workspace',
      selectedAt: '2026-07-22T00:00:00.000Z'
    }
  } as SessionDetail;
}

function makeDeps(sessions: SessionDetail[], brokerGateway?: BrokerGateway) {
  const calls = {
    resumedBriefSessionIds: [] as string[],
    executionStartedSessionIds: [] as string[],
    outcomes: [] as Array<{ sessionId: string; kind: string }>
  };
  const sessionsService = {
    listRaw: () => sessions,
    get: (sessionId: string) => {
      const session = sessions.find((candidate) => candidate.id === sessionId);
      if (!session) throw new Error(`Session not found: ${sessionId}`);
      return session;
    },
    resumeBriefGeneration: (sessionId: string) => {
      calls.resumedBriefSessionIds.push(sessionId);
      return true;
    },
    applyOutcome: (sessionId: string, outcome: { kind: string }) => {
      calls.outcomes.push({ sessionId, kind: outcome.kind });
    }
  };
  const tasksService = {
    resetStaleRunning: () => undefined,
    unfinished: () => []
  };
  const orchestratorService = {
    listBriefs: () => [{ id: 'brief-1' }]
  };
  const executionService = {
    start: (session: SessionDetail) => {
      calls.executionStartedSessionIds.push(session.id);
    }
  };
  const service = new RecoveryService(
    sessionsService as never,
    tasksService as never,
    orchestratorService as never,
    executionService as never,
    { currentDataEpoch: () => 'epoch-test' } as never,
    undefined,
    undefined,
    undefined,
    brokerGateway
  );
  return { service, calls };
}

test('records a recoverable service shutdown for an invocation left running by a crash', async () => {
  const session = makeSession('EXECUTING');
  const created: Array<Record<string, unknown>> = [];
  const events = {
    list: () => [
      {
        id: 'runtime-started',
        sessionId: session.id,
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
  const service = new RecoveryService(
    { listRaw: () => [session], get: () => session, applyOutcome() {} } as never,
    { resetStaleRunning() {}, unfinished: () => [] } as never,
    { listBriefs: () => [{ id: 'brief-1' }] } as never,
    { start() {} } as never,
    { currentDataEpoch: () => 'epoch-test' } as never,
    undefined,
    events as never
  );

  await service.onApplicationBootstrap();

  assert.equal(created.length, 1);
  const payload = (created[0].metadata as { payload: Record<string, unknown> }).payload;
  assert.equal((payload.termination as { kind?: string }).kind, 'service_shutdown');
  assert.equal((payload.termination as { graceful?: boolean }).graceful, false);
});

test('recovers AGENT_DISCUSSING sessions by re-driving brief generation', async () => {
  const session = makeSession('AGENT_DISCUSSING');
  const { service, calls } = makeDeps([session]);

  await service.onApplicationBootstrap();

  assert.deepEqual(calls.resumedBriefSessionIds, [session.id]);
  assert.deepEqual(calls.executionStartedSessionIds, []);
  assert.deepEqual(calls.outcomes, []);
});

test('recovers in-process brief generation even when BullMQ execution is enabled', async () => {
  const previous = process.env.ENABLE_BULLMQ;
  process.env.ENABLE_BULLMQ = 'true';
  try {
    const discussing = makeSession('AGENT_DISCUSSING');
    const executing = makeSession('EXECUTING');
    const { service, calls } = makeDeps([discussing, executing]);

    await service.onApplicationBootstrap();

    assert.deepEqual(calls.resumedBriefSessionIds, [discussing.id]);
    assert.deepEqual(calls.executionStartedSessionIds, []);
  } finally {
    process.env.ENABLE_BULLMQ = previous;
  }
});

test('still recovers EXECUTING sessions through the execution pipeline', async () => {
  const session = makeSession('EXECUTING');
  const { service, calls } = makeDeps([session]);

  await service.onApplicationBootstrap();

  assert.deepEqual(calls.resumedBriefSessionIds, []);
  assert.deepEqual(calls.executionStartedSessionIds, [session.id]);
});

test('leaves sessions waiting on the user untouched', async () => {
  const { service, calls } = makeDeps([makeSession('WAIT_USER_CONFIRM'), makeSession('WAIT_USER_DECISION')]);

  await service.onApplicationBootstrap();

  assert.deepEqual(calls.resumedBriefSessionIds, []);
  assert.deepEqual(calls.executionStartedSessionIds, []);
  assert.deepEqual(calls.outcomes, []);
});

test('waits for a browser workspace to reconnect before recovering discussion', async () => {
  const session = makeBrowserSession('AGENT_DISCUSSING');
  const gateway = new BrokerGateway(() => 'epoch-test');
  const { service, calls } = makeDeps([session], gateway);

  await service.onApplicationBootstrap();
  assert.deepEqual(calls.resumedBriefSessionIds, []);

  gateway.registerWorkspace(
    { clientId: 'client-1', send() {} },
    {
      clientId: 'client-1',
      workspaceId: session.workspaceId,
      providerKind: 'browser_broker',
      capabilities: { read: true, write: true, command: false, test: false },
      displayName: 'browser-workspace'
    }
  );
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(calls.resumedBriefSessionIds, [session.id]);
});

test('waits for a browser workspace to reconnect before recovering execution', async () => {
  const session = makeBrowserSession('EXECUTING');
  const gateway = new BrokerGateway(() => 'epoch-test');
  const { service, calls } = makeDeps([session], gateway);

  await service.onApplicationBootstrap();
  assert.deepEqual(calls.executionStartedSessionIds, []);

  gateway.registerWorkspace(
    { clientId: 'client-1', send() {} },
    {
      clientId: 'client-1',
      workspaceId: session.workspaceId,
      providerKind: 'browser_broker',
      capabilities: { read: true, write: true, command: false, test: false },
      displayName: 'browser-workspace'
    }
  );
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(calls.executionStartedSessionIds, [session.id]);
});
