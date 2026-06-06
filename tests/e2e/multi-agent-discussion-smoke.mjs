import {
  api,
  buildServer,
  createSessionAndWaitForBrief,
  listEvents,
  startSmokeServer,
  stopSmokeServer
} from './smoke-server.mjs';

await buildServer();

let server;

try {
  server = await startSmokeServer('multi-agent-discussion-smoke', {
    DISCUSSION_AGENT_KEYS: 'requirements,architect,backend,test',
    DISCUSSION_MAX_ROUNDS: '1'
  });

  const { sessionId } = await createSessionAndWaitForBrief(
    server.apiBase,
    'Multi-agent discussion smoke should call several participating agents.'
  );
  const invocations = await api(server.apiBase, `/sessions/${sessionId}/debug/runtime-invocations`);
  const discussionAgents = new Set(
    invocations.data.items
      .filter((item) => item.phase === 'discussion')
      .map((item) => item.agentKey)
  );
  if (discussionAgents.size < 3) {
    throw new Error(`Expected discussion invocations from several agents: ${JSON.stringify(invocations)}`);
  }

  const discussionMessages = (await listEvents(server.apiBase, sessionId)).filter(
    (event) => event.type === 'agent_message' && event.metadata.payload.round === 1
  );
  if (discussionMessages.length < 3) {
    throw new Error(`Expected discussion agent messages: ${JSON.stringify(discussionMessages)}`);
  }

  console.log('multi-agent discussion smoke ok');
} finally {
  if (server) {
    await stopSmokeServer(server);
  }
}
