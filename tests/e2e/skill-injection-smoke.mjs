import { api, buildServer, createSessionAndWaitForBrief, startSmokeServer, stopSmokeServer, waitForStatus } from './smoke-server.mjs';

await buildServer();
let server;
try {
  server = await startSmokeServer('skill-injection-smoke', { DISCUSSION_MAX_ROUNDS: '0', REQUIRE_USER_CONFIRMATION: 'false' });
  const created = await api(server.apiBase, '/skills', {
    method: 'POST',
    body: JSON.stringify({ name: 'Contract Review', content: 'Always verify shared contracts before delivery.', files: [{ path: 'checklist.md', content: 'Run typecheck.' }] })
  });
  const skillId = created.data.id;
  await api(server.apiBase, `/agents/requirements/skills/${skillId}`, { method: 'POST' });
  const { sessionId, briefId } = await createSessionAndWaitForBrief(server.apiBase, 'Implement a backend change with bound skills.');
  await api(server.apiBase, `/sessions/${sessionId}/briefs/${briefId}/confirm`, { method: 'POST' });
  await waitForStatus(server.apiBase, sessionId, 'COMPLETED', 60_000);
  const packs = await api(server.apiBase, `/sessions/${sessionId}/debug/context-packs`);
  const requirementsPack = packs.data.items.find((item) => item.agentKey === 'requirements' && item.phase === 'task_execution');
  if (!requirementsPack?.contextPack?.systemRules?.some((rule) => rule.startsWith('[Skill:Contract Review]'))) {
    const requirements = await api(server.apiBase, '/agents/requirements');
    throw new Error(`Bound skill was not injected into requirements ContextPack.systemRules: ${JSON.stringify({ requirements: requirements.data, packs: packs.data.items.map((item) => ({ agentKey: item.agentKey, phase: item.phase, systemRules: item.contextPack?.systemRules })) })}`);
  }
  console.log('skill injection smoke ok');
} finally {
  if (server) await stopSmokeServer(server);
}
