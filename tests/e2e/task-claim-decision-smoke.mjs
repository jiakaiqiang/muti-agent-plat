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

let server;

async function waitForTaskClaimedByDifferentAgent(apiBase, sessionId, taskId, declinedAgentId, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const event = (await listEvents(apiBase, sessionId)).find(
      (item) => item.type === 'task_claimed' && item.taskId === taskId && item.fromAgentId !== declinedAgentId
    );
    if (event) return event;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Timed out waiting for reassigned task to be claimed by a different agent.');
}

try {
  server = await startSmokeServer('task-claim-decision-smoke', {
    DISCUSSION_MAX_ROUNDS: '0',
    MOCK_PARALLEL_TASKS: 'true',
    MOCK_REJECT_ACCEPTANCE_AGENT_KEYS: 'requirements'
  });

  const { sessionId, briefId } = await createSessionAndWaitForBrief(
    server.apiBase,
    'Coordinate independent frontend and backend coding work with autonomous task claiming.',
    {
      agentIds: ['coordinator', 'requirements', 'architect', 'frontend', 'backend', 'test', 'review', 'notification']
    }
  );

  await api(server.apiBase, `/sessions/${sessionId}/briefs/${briefId}/confirm`, { method: 'POST' });

  const declined = await waitForMatchingEvent(
    server.apiBase,
    sessionId,
    'agent_message',
    (event) => event.metadata.payload?.phase === 'task_acceptance_blocked',
    30_000
  );

  if (!declined.taskId) {
    throw new Error('Declined claim decision must reference a task.');
  }
  if (!declined.fromAgentId) {
    throw new Error('Declined claim decision must record the declining agent.');
  }
  if (declined.metadata.payload?.claimDecision?.accepted !== false) {
    throw new Error('Declined claim decision payload must set accepted=false.');
  }
  if (declined.metadata.payload?.acceptanceDecision?.status !== 'rejected') {
    throw new Error('Acceptance decision payload must set status=rejected.');
  }
  if (!declined.metadata.payload?.handoffSuggestion?.reason) {
    throw new Error('Declined claim decision must expose a handoffSuggestion for Coordinator review.');
  }

  const reassignment = await waitForMatchingEvent(
    server.apiBase,
    sessionId,
    'task_reassigned',
    (event) =>
      event.taskId === declined.taskId &&
      event.metadata.payload?.previousAssigneeAgentId === declined.fromAgentId &&
      event.metadata.payload?.assigneeAgentId,
    30_000
  );
  if (!reassignment.toAgentIds.includes(reassignment.metadata.payload.assigneeAgentId)) {
    throw new Error('Task reassignment event must target the new assignee.');
  }

  const claimed = await waitForTaskClaimedByDifferentAgent(
    server.apiBase,
    sessionId,
    declined.taskId,
    declined.fromAgentId
  );
  if (claimed.fromAgentId !== reassignment.metadata.payload.assigneeAgentId) {
    throw new Error('Reassigned task must be claimed by the selected alternative agent.');
  }

  const acceptedDecision = await waitForMatchingEvent(
    server.apiBase,
    sessionId,
    'agent_message',
    (event) =>
      event.taskId === declined.taskId &&
      event.fromAgentId === claimed.fromAgentId &&
      event.metadata.payload?.phase === 'task_acceptance_decision' &&
      event.metadata.payload?.acceptanceDecision?.status === 'accepted' &&
      event.metadata.payload?.claimDecision?.accepted === true,
    30_000
  );
  if (!acceptedDecision.metadata.payload?.runtimeInvocationId) {
    throw new Error('Accepted claim decision must reference its runtime invocation.');
  }

  await waitForStatus(server.apiBase, sessionId, 'COMPLETED', 90_000);

  console.log('task claim decision smoke ok');
} finally {
  if (server) {
    await stopSmokeServer(server);
  }
}
