import { api, buildServer, startSmokeServer, stopSmokeServer } from './smoke-server.mjs';

await buildServer();
let server;
try {
  server = await startSmokeServer('autopilot-smoke', {
    DISCUSSION_MAX_ROUNDS: '0', REQUIRE_USER_CONFIRMATION: 'false', AUTOPILOT_POLL_MS: '50'
  });
  const created = await api(server.apiBase, '/autopilots', {
    method: 'POST', body: JSON.stringify({ name: 'Deterministic smoke', prompt: 'Produce a safe mock delivery.', enabled: true })
  });
  const autopilotId = created.data.id;
  const triggered = await api(server.apiBase, `/autopilots/${autopilotId}/trigger`, { method: 'POST', body: '{}' });
  const runId = triggered.data.run.id;
  const deadline = Date.now() + 60_000;
  let run;
  while (Date.now() < deadline) {
    const response = await api(server.apiBase, `/autopilots/${autopilotId}/runs`);
    run = response.data.find((item) => item.id === runId);
    if (run?.status === 'completed' || run?.status === 'failed') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (run?.status !== 'completed' || !run.sessionId) throw new Error(`Autopilot run did not complete: ${JSON.stringify(run)}`);
  const session = await api(server.apiBase, `/sessions/${run.sessionId}`);
  if (session.data.origin !== 'autopilot' || session.data.autopilotRunId !== run.id) {
    throw new Error('Autopilot session trace fields are missing.');
  }
  console.log('autopilot smoke ok');
} finally {
  if (server) await stopSmokeServer(server);
}
