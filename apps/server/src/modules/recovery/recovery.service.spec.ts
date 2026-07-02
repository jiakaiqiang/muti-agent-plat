import test from 'node:test';
import assert from 'node:assert/strict';
import type { SessionDetail } from '@agent-cluster/shared';
import { RecoveryService } from './recovery.service.js';

process.env.AGENT_CLUSTER_RECOVER_ON_BOOT = 'true';
process.env.ENABLE_BULLMQ = 'false';

function makeSession(status: SessionDetail['status']): SessionDetail {
  return {
    id: `session-${status.toLowerCase()}`,
    status,
    currentTaskBriefId: 'brief-1'
  } as SessionDetail;
}

function makeDeps(sessions: SessionDetail[]) {
  const calls = {
    resumedBriefSessionIds: [] as string[],
    executionStartedSessionIds: [] as string[],
    outcomes: [] as Array<{ sessionId: string; kind: string }>
  };
  const sessionsService = {
    listRaw: () => sessions,
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
    executionService as never
  );
  return { service, calls };
}

test('recovers AGENT_DISCUSSING sessions by re-driving brief generation', () => {
  const session = makeSession('AGENT_DISCUSSING');
  const { service, calls } = makeDeps([session]);

  service.onApplicationBootstrap();

  assert.deepEqual(calls.resumedBriefSessionIds, [session.id]);
  assert.deepEqual(calls.executionStartedSessionIds, []);
  assert.deepEqual(calls.outcomes, []);
});

test('still recovers EXECUTING sessions through the execution pipeline', () => {
  const session = makeSession('EXECUTING');
  const { service, calls } = makeDeps([session]);

  service.onApplicationBootstrap();

  assert.deepEqual(calls.resumedBriefSessionIds, []);
  assert.deepEqual(calls.executionStartedSessionIds, [session.id]);
});

test('leaves sessions waiting on the user untouched', () => {
  const { service, calls } = makeDeps([makeSession('WAIT_USER_CONFIRM'), makeSession('WAIT_USER_DECISION')]);

  service.onApplicationBootstrap();

  assert.deepEqual(calls.resumedBriefSessionIds, []);
  assert.deepEqual(calls.executionStartedSessionIds, []);
  assert.deepEqual(calls.outcomes, []);
});
