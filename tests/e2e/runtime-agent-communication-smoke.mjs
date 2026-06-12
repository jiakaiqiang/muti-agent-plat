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

try {
  server = await startSmokeServer('runtime-agent-communication-smoke', {
    DISCUSSION_MAX_ROUNDS: '0',
    MOCK_RUNTIME_AGENT_COMMUNICATION: 'true'
  });

  const { sessionId, briefId } = await createSessionAndWaitForBrief(
    server.apiBase,
    'Implement a feature and let the coding agent coordinate with peer reviewers during execution.'
  );

  await api(server.apiBase, `/sessions/${sessionId}/briefs/${briefId}/confirm`, { method: 'POST' });

  const communication = await waitForMatchingEvent(
    server.apiBase,
    sessionId,
    'agent_message',
    (event) => event.metadata.payload?.phase === 'agent_runtime_communication',
    30_000
  );

  if (!communication.taskId) {
    throw new Error('Runtime agent communication must be associated with the executing task.');
  }
  if (!communication.fromAgentId) {
    throw new Error('Runtime agent communication must record the sending agent.');
  }
  if (!Array.isArray(communication.toAgentIds) || communication.toAgentIds.length === 0) {
    throw new Error('Runtime agent communication must target at least one peer agent.');
  }
  if (!communication.metadata.payload?.runtimeInvocationId) {
    throw new Error('Runtime agent communication must reference the runtime invocation.');
  }
  if (!communication.metadata.payload?.relatedTaskIds?.includes(communication.taskId)) {
    throw new Error('Runtime agent communication must include the executing task in relatedTaskIds.');
  }

  const events = await listEvents(server.apiBase, sessionId);
  const communicationIndex = events.findIndex((event) => event.id === communication.id);
  const taskCompletionIndex = events.findIndex(
    (event) => event.type === 'task_completed' && event.taskId === communication.taskId
  );
  if (taskCompletionIndex !== -1 && taskCompletionIndex < communicationIndex) {
    throw new Error('Runtime agent communication should be visible no later than task completion.');
  }

  await waitForStatus(server.apiBase, sessionId, 'COMPLETED', 60_000);

  console.log('runtime agent communication smoke ok');
} finally {
  if (server) {
    await stopSmokeServer(server);
  }
}
