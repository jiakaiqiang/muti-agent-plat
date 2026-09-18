// Phase 3 / P3-AC1, AC3, AC5: a coordinator-planned discussion on a real
// server with the mock runtime, behind MAIN_AGENT_DISCUSSION_ENABLED.
//
// The mock coordinator always proposes to consult `architect`. Scenario A
// has architect in the session, so the proposal becomes an owned delegation
// and the round closes with a synthesis built from its real reply. Scenario B
// does not, so the proposal becomes a member-addition card for the user (never
// an automatic member) and the round waits on a single clarification card
// owned by the coordinator.
import {
  api,
  buildServer,
  createSessionAndWaitForBrief,
  startSmokeServer,
  stopSmokeServer,
  waitForMatchingEvent
} from './smoke-server.mjs';

async function events(apiBase, sessionId) {
  return (await api(apiBase, `/sessions/${sessionId}/events`)).data.items;
}

await buildServer();

let server;
try {
  server = await startSmokeServer('planned-discussion', {
    DISCUSSION_MAX_ROUNDS: '1',
    MAIN_AGENT_DISCUSSION_ENABLED: 'true'
  });

  // --- Scenario A: the named expert is a participant ---
  const withArchitect = await createSessionAndWaitForBrief(server.apiBase, '分析并记录 token 使用情况，仅输出说明。', {
    agentIds: ['architect', 'backend'],
    runtimePreference: { preferredRuntimeType: 'mock', allowedRuntimeTypes: ['mock'] }
  });
  const a = await events(server.apiBase, withArchitect.sessionId);

  const plan = a.find((event) => event.type === 'agent_message' && Array.isArray(event.metadata?.payload?.plannedTargets));
  if (!plan) throw new Error('Expected the coordinator to post its discussion plan');
  if (!plan.metadata.payload.plannedTargets.includes('architect')) {
    throw new Error(`Expected architect to be planned, got ${JSON.stringify(plan.metadata.payload.plannedTargets)}`);
  }
  if (!plan.metadata.payload.discussionId) throw new Error('The plan event must carry the discussion id');

  const delegated = a.filter((event) => event.type === 'agent_status_changed' && event.metadata?.payload?.delegationId);
  const delegatedAgents = new Set(delegated.map((event) => event.fromAgentId));
  if (delegatedAgents.size !== 1) {
    throw new Error(`Only the named expert may be consulted; saw delegations for ${JSON.stringify([...delegatedAgents])}`);
  }
  if (a.some((event) => event.type === 'agent_status_changed' && event.fromAgentId === 'backend' && event.metadata?.payload?.status === 'discussing')) {
    throw new Error('backend was not named and must not be consulted');
  }

  const synthesis = a.find((event) => event.type === 'agent_message' && event.metadata?.payload?.messageKind === 'summary' && event.metadata?.payload?.sourceDelegationIds);
  if (!synthesis) throw new Error('Expected a coordinator synthesis built from delegation results');
  if (synthesis.metadata.payload.sourceDelegationIds.length !== 1) {
    throw new Error(`Synthesis must cite exactly the delegation it read, got ${JSON.stringify(synthesis.metadata.payload.sourceDelegationIds)}`);
  }
  if (/已汇总被 @Agent|一致同意/.test(synthesis.content)) throw new Error('Synthesis must not use fixed summary copy or claim consensus');
  if (a.some((event) => event.metadata?.payload?.reason === 'confirm_member_addition')) {
    throw new Error('A participant must not trigger a member-addition card');
  }
  if (a.some((event) => event.metadata?.payload?.reason === 'discussion_clarification')) {
    throw new Error('A clean round must not ask the user anything');
  }

  // --- Scenario B: the named expert is not in the session ---
  const withoutArchitect = await api(server.apiBase, '/sessions', {
    method: 'POST',
    body: JSON.stringify({
      input: '分析并记录 token 使用情况，仅输出说明。',
      agentIds: ['backend'],
      runtimePreference: { preferredRuntimeType: 'mock', allowedRuntimeTypes: ['mock'] }
    })
  });
  const sessionB = withoutArchitect.data.session.id;
  await waitForMatchingEvent(
    server.apiBase,
    sessionB,
    'user_confirmation_requested',
    (event) => event.metadata?.payload?.reason === 'confirm_member_addition',
    60_000
  );
  const b = await events(server.apiBase, sessionB);
  const addition = b.find((event) => event.metadata?.payload?.reason === 'confirm_member_addition');
  if (addition.metadata.payload.targetAgentKey !== 'architect') {
    throw new Error(`Expected the member-addition card to name architect, got ${JSON.stringify(addition.metadata.payload)}`);
  }
  if (b.some((event) => event.type === 'agent_status_changed' && event.metadata?.payload?.delegationId)) {
    throw new Error('No delegation may run for a member the user has not approved');
  }
  const clarification = await waitForMatchingEvent(
    server.apiBase,
    sessionB,
    'user_confirmation_requested',
    (event) => event.metadata?.payload?.reason === 'discussion_clarification',
    30_000
  );
  if (clarification.fromAgentId !== plan.fromAgentId) {
    throw new Error('The clarification card must be owned by the coordinator');
  }
  if (!/architect/.test(String(clarification.metadata.payload.description))) {
    throw new Error('The clarification must list the pending member addition');
  }

  console.log(
    `planned discussion smoke ok: A consulted ${[...delegatedAgents].join(',')} only and synthesised ${synthesis.metadata.payload.sourceDelegationIds.length} result; B raised member-addition + one clarification card`
  );
} finally {
  if (server) await stopSmokeServer(server);
}
