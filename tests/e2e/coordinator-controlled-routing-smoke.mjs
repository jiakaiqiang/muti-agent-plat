import {
  api,
  buildServer,
  createSessionAndWaitForBrief,
  listEvents,
  startSmokeServer,
  stopSmokeServer,
  waitForMatchingEvent,
  waitForStatus
} from './smoke-server.mjs';

await buildServer();

async function assertNoSubAgentReassignment(apiBase, sessionId) {
  const events = await listEvents(apiBase, sessionId);
  const invalid = events.find(
    (event) =>
      event.type === 'task_reassigned' &&
      event.fromAgentId &&
      event.metadata.payload?.assignedByAgentId &&
      event.fromAgentId !== event.metadata.payload.assignedByAgentId
  );
  if (invalid) {
    throw new Error(`task_reassigned must be emitted by Coordinator only: ${JSON.stringify(invalid)}`);
  }
}

async function waitForMatchingEventWithDebug(apiBase, sessionId, type, predicate, timeoutMs = 20_000) {
  try {
    return await waitForMatchingEvent(apiBase, sessionId, type, predicate, timeoutMs);
  } catch (error) {
    const events = await listEvents(apiBase, sessionId);
    const summary = events
      .map((event) =>
        [
          event.type,
          event.taskId ?? '-',
          event.fromAgentId ?? '-',
          event.metadata.payload?.phase ?? '-',
          event.metadata.payload?.status ?? '-',
          event.metadata.payload?.assigneeAgentId ?? '-',
          event.metadata.payload?.autoResolutionAttempted ?? '-',
          event.content
        ].join(' | ')
      )
      .join('\n');
    console.error(`Event summary before ${type} timeout:\n${summary}`);
    throw error;
  }
}

async function runAcceptAndReassignScenario() {
  let server;
  try {
    server = await startSmokeServer('coordinator-controlled-routing-reassign-smoke', {
      DISCUSSION_MAX_ROUNDS: '0',
      MOCK_PARALLEL_TASKS: 'true',
      MOCK_REJECT_ACCEPTANCE_AGENT_KEYS: 'requirements'
    });

    const { sessionId, briefId } = await createSessionAndWaitForBrief(
      server.apiBase,
      'Coordinate independent frontend and backend coding work with Coordinator-controlled task routing.',
      {
        agentIds: ['coordinator', 'requirements', 'architect', 'frontend', 'backend', 'test', 'review', 'notification']
      }
    );

    await api(server.apiBase, `/sessions/${sessionId}/briefs/${briefId}/confirm`, { method: 'POST' });

    const assigned = await waitForMatchingEvent(
      server.apiBase,
      sessionId,
      'task_assigned',
      (event) =>
        event.fromAgentId === event.metadata.payload?.assignedByAgentId &&
        event.metadata.payload?.routingMode === 'coordinator_controlled',
      30_000
    );
    if (!assigned.metadata.payload?.assigneeAgentId) {
      throw new Error('task_assigned must include assigneeAgentId.');
    }

    const blocked = await waitForMatchingEventWithDebug(
      server.apiBase,
      sessionId,
      'task_blocked',
      (event) =>
        event.metadata.payload?.autoResolutionAttempted === true &&
        event.metadata.payload?.handoffSuggestion?.reason,
      30_000
    );

    const reassigned = await waitForMatchingEvent(
      server.apiBase,
      sessionId,
      'task_reassigned',
      (event) =>
        event.taskId === blocked.taskId &&
        event.fromAgentId === event.metadata.payload?.assignedByAgentId &&
        event.metadata.payload?.previousAssigneeAgentId === blocked.fromAgentId &&
        event.metadata.payload?.assigneeAgentId,
      30_000
    );

    const accepted = await waitForMatchingEvent(
      server.apiBase,
      sessionId,
      'task_accepted',
      (event) =>
        event.taskId === reassigned.taskId &&
        event.fromAgentId === reassigned.metadata.payload.assigneeAgentId &&
        event.metadata.payload?.status === 'accepted',
      30_000
    );
    if (!accepted.metadata.payload?.autoResolutionAttempted) {
      throw new Error('Accepted reassigned task should preserve autoResolutionAttempted=true.');
    }

    await waitForStatus(server.apiBase, sessionId, 'COMPLETED', 90_000);
    await assertNoSubAgentReassignment(server.apiBase, sessionId);
  } finally {
    if (server) {
      await stopSmokeServer(server);
    }
  }
}

async function runSecondFailureUserDecisionScenario() {
  let server;
  try {
    server = await startSmokeServer('coordinator-controlled-routing-user-decision-smoke', {
      DISCUSSION_MAX_ROUNDS: '0',
      MOCK_REJECT_ACCEPTANCE_AGENT_KEYS: 'all'
    });

    const { sessionId, briefId } = await createSessionAndWaitForBrief(
      server.apiBase,
      'Implement a small backend endpoint so every assigned agent rejects acceptance in this smoke run.',
      {
        agentIds: ['coordinator', 'requirements', 'architect', 'frontend', 'backend', 'test', 'review', 'notification']
      }
    );

    await api(server.apiBase, `/sessions/${sessionId}/briefs/${briefId}/confirm`, { method: 'POST' });

    await waitForMatchingEvent(
      server.apiBase,
      sessionId,
      'task_reassigned',
      (event) => event.metadata.payload?.autoResolutionAttempted === true,
      30_000
    );

    await waitForStatus(server.apiBase, sessionId, 'WAIT_USER_DECISION', 60_000);

    await waitForMatchingEvent(
      server.apiBase,
      sessionId,
      'user_confirmation_requested',
      (event) => event.metadata.payload?.reason === 'coordinator_routing_needs_user_decision',
      30_000
    );

    const blockedEvents = (await listEvents(server.apiBase, sessionId)).filter((event) => event.type === 'task_blocked');
    if (blockedEvents.length < 2) {
      throw new Error('Expected at least two task_blocked events before user decision.');
    }

    await assertNoSubAgentReassignment(server.apiBase, sessionId);
  } finally {
    if (server) {
      await stopSmokeServer(server);
    }
  }
}

await runAcceptAndReassignScenario();
await runSecondFailureUserDecisionScenario();

console.log('coordinator controlled routing smoke ok');
