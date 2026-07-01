import {
  api,
  buildServer,
  createSessionAndWaitForBrief,
  startSmokeServer,
  stopSmokeServer,
  waitForMatchingEvent,
  waitForStatus
} from './smoke-server.mjs';

await buildServer();

let server;

try {
  server = await startSmokeServer('task-claim-fallback-smoke', {
    DISCUSSION_MAX_ROUNDS: '0'
  });

  const { sessionId, briefId } = await createSessionAndWaitForBrief(
    server.apiBase,
    '请输出一个新功能的需求范围、实施计划和验收建议。',
    {
      agentIds: ['coordinator', 'backend', 'architect']
    }
  );

  await api(server.apiBase, `/sessions/${sessionId}/briefs/${briefId}/confirm`, { method: 'POST' });

  const declined = await waitForMatchingEvent(
    server.apiBase,
    sessionId,
    'agent_message',
    (event) =>
      event.metadata.payload?.phase === 'task_acceptance_blocked' &&
      event.metadata.payload?.claimDecision?.accepted === false &&
      event.metadata.payload?.acceptanceDecision?.status === 'rejected',
    30_000
  );

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

  const claimed = await waitForMatchingEvent(
    server.apiBase,
    sessionId,
    'task_claimed',
    (event) => event.taskId === declined.taskId && event.fromAgentId === reassignment.metadata.payload.assigneeAgentId,
    30_000
  );

  if (claimed.fromAgentId === declined.fromAgentId) {
    throw new Error('Fallback claim must be assigned to a different available participant.');
  }

  await waitForStatus(server.apiBase, sessionId, 'COMPLETED', 90_000);

  console.log('task claim fallback smoke ok');
} finally {
  if (server) {
    await stopSmokeServer(server);
  }
}
