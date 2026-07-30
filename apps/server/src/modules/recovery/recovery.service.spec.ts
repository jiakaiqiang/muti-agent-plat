import test from 'node:test';
import assert from 'node:assert/strict';
import type { SessionDetail } from '@agent-cluster/shared';
import { RecoveryService } from './recovery.service.js';

process.env.AGENT_CLUSTER_RECOVER_ON_BOOT = 'true';

function makeSession(status: SessionDetail['status']): SessionDetail {
  return {
    id: `session-${status.toLowerCase()}`,
    dataEpoch: 'epoch-test',
    status,
    currentTaskBriefId: 'brief-1'
  } as SessionDetail;
}

function makeFixture(sessions: SessionDetail[], events?: {
  list(sessionId: string): Array<Record<string, unknown>>;
  create(input: Record<string, unknown>): unknown;
}) {
  const interruptions: Array<{
    sessionId: string;
    invocationId?: string;
    occurredAt: string;
    graceful: boolean;
    diagnosticRef?: string;
  }> = [];
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
      }
    } as never,
    { currentDataEpoch: () => 'epoch-test' } as never,
    undefined,
    events as never
  );
  return { service, interruptions };
}

test('records service_shutdown and persists the unmatched invocation as wakeable without re-running it', async () => {
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
  const { service, interruptions } = makeFixture([session], events);

  await service.onApplicationBootstrap();

  assert.equal(created.length, 1);
  const payload = (created[0].metadata as { payload: Record<string, unknown> }).payload;
  assert.equal((payload.termination as { kind?: string }).kind, 'service_shutdown');
  assert.equal((payload.termination as { graceful?: boolean }).graceful, false);
  assert.equal(interruptions.length, 1);
  assert.equal(interruptions[0]?.sessionId, session.id);
  assert.equal(interruptions[0]?.invocationId, 'invocation-1');
  assert.equal(interruptions[0]?.graceful, false);
  assert.equal(interruptions[0]?.diagnosticRef, 'recovered_on_boot');
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
  const { service, interruptions } = makeFixture(sessions);

  await service.onApplicationBootstrap();

  assert.deepEqual(interruptions.map((item) => item.sessionId), sessions.map((session) => session.id));
  assert.ok(interruptions.every((item) => item.graceful === false));
  assert.ok(sessions.every((session) => session.status === 'INTERRUPTED'));
});

test('leaves user-waiting and terminal Sessions untouched on boot', async () => {
  const sessions = [
    makeSession('WAIT_USER_CONFIRM'),
    makeSession('WAIT_WORKFLOW_SELECT'),
    makeSession('WAIT_WORKFLOW_STEP_CONFIRM'),
    makeSession('WAIT_USER_DECISION'),
    makeSession('COMPLETED'),
    makeSession('FAILED'),
    makeSession('CANCELLED'),
    makeSession('INTERRUPTED')
  ];
  const { service, interruptions } = makeFixture(sessions);

  await service.onApplicationBootstrap();

  assert.deepEqual(interruptions, []);
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
