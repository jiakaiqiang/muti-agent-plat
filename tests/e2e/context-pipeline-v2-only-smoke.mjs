import { api, buildServer, startSmokeServer, stopSmokeServer } from './smoke-server.mjs';

await buildServer();

let server;

try {
  server = await startSmokeServer('context-pipeline-v2-only', {
    DISCUSSION_MAX_ROUNDS: '0'
  });
  const v2 = await createSession(server.apiBase, 'Create a v2-only context pipeline session.');
  const health = (await api(server.apiBase, '/health')).data;
  assertV2Only(v2, health);
  const v2Again = await api(server.apiBase, `/sessions/${v2.id}`);
  assertV2Only(v2Again.data, health);

  console.log('context pipeline v2-only smoke ok');
} finally {
  if (server) await stopSmokeServer(server);
}

async function createSession(apiBase, input) {
  const created = await api(apiBase, '/sessions', {
    method: 'POST',
    body: JSON.stringify({
      input,
      agentIds: ['coordinator', 'requirements', 'architect']
    })
  });
  return created.data.session;
}

function assertV2Only(session, health) {
  if (health.pipelineVersion !== 'v2' || health.dataSchemaVersion !== 3) {
    throw new Error(`Expected v2-only health contract, got ${JSON.stringify(health)}`);
  }
  if (!session.dataEpoch || session.dataEpoch !== health.dataEpoch) {
    throw new Error(`Expected Session dataEpoch to match v2 health, got ${JSON.stringify({ session, health })}`);
  }
}
