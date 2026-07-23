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

async function waitForTaskClaimedByDifferentAgent(apiBase, sessionId, taskId, declinedAgentId, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const event = (await listEvents(apiBase, sessionId)).find(
      (item) => item.type === 'task_claimed' && item.taskId === taskId && item.fromAgentId !== declinedAgentId
    );
    if (event) return event;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Timed out waiting for reassigned task to be claimed by a different agent.');
}

try {
  server = await startSmokeServer('task-acceptance-decision-smoke', {
    DISCUSSION_MAX_ROUNDS: '0',
    MOCK_RUNTIME_ENABLED: 'true',
    GLOBAL_DEFAULT_RUNTIME_TYPE: 'mock',
    MOCK_PARALLEL_TASKS: 'true',
    MOCK_REJECT_ACCEPTANCE_AGENT_KEYS: 'requirements'
  });

  const agents = (await api(server.apiBase, '/agents')).data;
  const requirements = agents.find((agent) => agent.key === 'requirements');
  if (!requirements) throw new Error('Task acceptance smoke requires the requirements Agent.');
  const draft = (await api(server.apiBase, '/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Task acceptance decision workflow',
      nodes: [{ id: 'acceptance-node', type: 'agent', agentId: requirements.id, order: 0 }]
    })
  })).data;
  const workflow = (await api(server.apiBase, `/workflows/${draft.id}/publish`, {
    method: 'POST',
    body: JSON.stringify({ expectedDraftRevision: draft.draftRevision })
  })).data;

  const { sessionId, briefId } = await createSessionAndWaitForBrief(
    server.apiBase,
    'Analyze autonomous task acceptance routing and summarize the coordination decision.',
    {
      agentIds: ['coordinator', 'requirements', 'architect', 'frontend', 'backend', 'test', 'review', 'notification'],
      runtimePreference: { preferredRuntimeType: 'mock', allowedRuntimeTypes: ['mock'] }
    }
  );

  await api(server.apiBase, `/sessions/${sessionId}/briefs/${briefId}/confirm`, { method: 'POST' });
  await waitForStatus(server.apiBase, sessionId, 'WAIT_WORKFLOW_SELECT');
  const workflowSelection = await waitForMatchingEvent(
    server.apiBase,
    sessionId,
    'user_confirmation_requested',
    (event) => event.metadata.payload?.reason === 'select_workflow'
  );
  await api(server.apiBase, `/sessions/${sessionId}/workflow/select`, {
    method: 'POST',
    body: JSON.stringify({
      workflowId: workflow.id,
      workflowVersion: workflow.currentPublishedVersion,
      confirmationId: workflowSelection.metadata.payload.confirmationId
    })
  });

  const declined = await waitForMatchingEvent(
    server.apiBase,
    sessionId,
    'agent_message',
    (event) => event.metadata.payload?.phase === 'task_acceptance_blocked',
    30_000
  );

  if (!declined.taskId) {
    throw new Error('Declined claim decision must reference a task.');
  }
  if (!declined.fromAgentId) {
    throw new Error('Declined claim decision must record the declining agent.');
  }
  if (declined.metadata.payload?.acceptanceDecision?.status !== 'rejected') {
    throw new Error('Acceptance decision payload must set status=rejected.');
  }
  if (!declined.metadata.payload?.acceptanceDecision?.alternativeAgentKeys?.includes('coordinator')) {
    throw new Error('Declined acceptance decision must expose its contract-defined alternative Agent keys.');
  }

  const reassignment = await waitForMatchingEvent(
    server.apiBase,
    sessionId,
    'task_reassigned',
    (event) =>
      event.taskId === declined.taskId &&
      event.metadata.payload?.previousAssignee?.id === declined.fromAgentId &&
      event.metadata.payload?.assignee?.id,
    30_000
  );
  if (!reassignment.toAgentIds.includes(reassignment.metadata.payload.assignee.id)) {
    throw new Error('Task reassignment event must target the new assignee.');
  }

  const claimed = await waitForTaskClaimedByDifferentAgent(
    server.apiBase,
    sessionId,
    declined.taskId,
    declined.fromAgentId
  );
  if (claimed.fromAgentId !== reassignment.metadata.payload.assignee.id) {
    throw new Error('Reassigned task must be claimed by the selected alternative agent.');
  }

  const acceptedDecision = await waitForMatchingEvent(
    server.apiBase,
    sessionId,
    'agent_message',
    (event) =>
      event.taskId === declined.taskId &&
      event.fromAgentId === claimed.fromAgentId &&
      event.metadata.payload?.phase === 'task_acceptance_decision' &&
      event.metadata.payload?.acceptanceDecision?.status === 'accepted',
    30_000
  );
  if (!acceptedDecision.metadata.payload?.runtimeInvocationId) {
    throw new Error('Accepted claim decision must reference its runtime invocation.');
  }

  console.log('task acceptance decision smoke ok');
} finally {
  if (server) {
    await stopSmokeServer(server);
  }
}
