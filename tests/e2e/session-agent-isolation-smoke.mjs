import {
  api,
  buildServer,
  confirmBriefAndSelectWorkflow,
  createPublishedAgentWorkflow,
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
    DISCUSSION_MAX_ROUNDS: '1',
    GLOBAL_DEFAULT_RUNTIME_TYPE: 'mock'
  });
  const workflow = await createPublishedAgentWorkflow(server.apiBase, 'Session agent isolation smoke', ['requirements']);

  const { sessionId, briefId } = await createSessionAndWaitForBrief(
    server.apiBase,
    '分析隔离会话中的 Agent 参与范围并输出说明。',
    {
      // Coordinator is a trusted internal Agent and is intentionally hidden
      // from the public chat surface; only chat-surface members are supplied
      // to Session creation.
      agentIds: ['requirements'],
      runtimePreference: { preferredRuntimeType: 'mock', allowedRuntimeTypes: ['mock'] }
    }
  );

  await confirmBriefAndSelectWorkflow(server.apiBase, sessionId, briefId, workflow);
  await waitForStatus(server.apiBase, sessionId, 'COMPLETED');

  const session = await api(server.apiBase, `/sessions/${sessionId}`);
  const allowed = new Set(session.data.participatingAgentIds);
  // Internal coordination events/tasks may still be authored by the trusted
  // main Agent even though it is not persisted as a chat participant.
  const coordinator = (await api(server.apiBase, '/agents')).data.find((agent) => agent.key === 'coordinator');
  if (!coordinator) throw new Error('Coordinator Agent is required for the isolation smoke.');
  allowed.add(coordinator.id);
  const events = await listEvents(server.apiBase, sessionId);
  const leakedEvents = events.filter(
    (event) => event.actor?.type === 'agent' && !allowed.has(event.actor.id)
  );
  if (leakedEvents.length) {
    throw new Error(`Session emitted events from non-participating agents: ${JSON.stringify(leakedEvents)}`);
  }

  const tasks = await api(server.apiBase, `/sessions/${sessionId}/tasks`);
  const leakedTasks = tasks.data.filter(
    (task) => task.assignee?.type === 'agent' && !allowed.has(task.assignee.id)
  );
  if (leakedTasks.length) {
    throw new Error(`Session assigned tasks to non-participating agents: ${JSON.stringify(leakedTasks)}`);
  }

  console.log('session agent isolation smoke ok');
} finally {
  if (server) {
    await stopSmokeServer(server);
  }
}
