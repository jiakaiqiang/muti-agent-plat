import { api, buildServer, createSessionAndWaitForBrief, startSmokeServer, stopSmokeServer } from './smoke-server.mjs';

await buildServer();
let server;
try {
  server = await startSmokeServer('skill-injection-smoke', { DISCUSSION_MAX_ROUNDS: '1', REQUIRE_USER_CONFIRMATION: 'false' });
  const created = await api(server.apiBase, '/skills', {
    method: 'POST',
    body: JSON.stringify({ name: 'Contract Review', content: 'Always verify shared contracts before delivery.', files: [{ path: 'checklist.md', content: 'Run typecheck.' }] })
  });
  const skill = created.data;
  const requirements = await api(server.apiBase, '/agents/requirements');
  await api(server.apiBase, '/agents/requirements', {
    method: 'PATCH',
    body: JSON.stringify({
      profileMarkdown: `${requirements.data.profileMarkdown}\n\n\${skill:${skill.key}}`
    })
  });
  const { sessionId } = await createSessionAndWaitForBrief(
    server.apiBase,
    'Review the current requirements contract and produce a non-coding compliance summary using profile-referenced skills.'
  );
  const invocations = await api(server.apiBase, `/sessions/${sessionId}/debug/runtime-invocations`);
  const requirementsInvocation = invocations.data.items.find(
    (item) =>
      item.agentKey === 'requirements' &&
      item.identity?.resolvedSkillIds?.includes(skill.id) &&
      item.identity?.resolvedSkillRevisions?.[skill.id] === skill.revision
  );
  if (!requirementsInvocation) {
    throw new Error(`Profile-referenced Skill was not resolved into the requirements invocation identity: ${JSON.stringify(invocations.data.items)}`);
  }
  console.log('skill injection smoke ok');
} finally {
  if (server) await stopSmokeServer(server);
}
