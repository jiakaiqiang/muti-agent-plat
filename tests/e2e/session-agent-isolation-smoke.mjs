import {
  api,
  buildServer,
  createSessionAndWaitForBrief,
  listEvents,
  startSmokeServer,
  stopSmokeServer,
  waitForStatus
} from './smoke-server.mjs';

await buildServer();

let server;

try {
  server = await startSmokeServer('session-agent-isolation-smoke', {
    DISCUSSION_AGENT_KEYS: 'requirements,architect,backend,test',
    DISCUSSION_MAX_ROUNDS: '1'
  });

  const { sessionId, briefId } = await createSessionAndWaitForBrief(
    server.apiBase,
    'Only selected agents should participate in this isolated session.',
    {
      agentIds: ['coordinator', 'requirements']
    }
  );

  await api(server.apiBase, `/sessions/${sessionId}/briefs/${briefId}/confirm`, { method: 'POST' });
  await waitForStatus(server.apiBase, sessionId, 'COMPLETED');

  const session = await api(server.apiBase, `/sessions/${sessionId}`);
  const allowed = new Set(session.data.participatingAgentIds);
  const events = await listEvents(server.apiBase, sessionId);
  const leakedEvents = events.filter((event) => event.fromAgentId && !allowed.has(event.fromAgentId));
  if (leakedEvents.length) {
    throw new Error(`Session emitted events from non-participating agents: ${JSON.stringify(leakedEvents)}`);
  }

  const tasks = await api(server.apiBase, `/sessions/${sessionId}/tasks`);
  const leakedTasks = tasks.data.filter((task) => task.assigneeAgentId && !allowed.has(task.assigneeAgentId));
  if (leakedTasks.length) {
    throw new Error(`Session assigned tasks to non-participating agents: ${JSON.stringify(leakedTasks)}`);
  }

  console.log('session agent isolation smoke ok');
} finally {
  if (server) {
    await stopSmokeServer(server);
  }
}
