import {
  api,
  buildServer,
  confirmBriefAndSelectWorkflow,
  createSessionAndWaitForBrief,
  listEvents,
  startSmokeServer,
  stopSmokeServer,
  waitForStatus
} from './smoke-server.mjs';

await buildServer();

let server;

try {
  server = await startSmokeServer('parallel-ready-tasks-smoke', {
    DISCUSSION_MAX_ROUNDS: '0',
    MOCK_RUNTIME_DELAY_MS: '1600'
  });

  const agents = (await api(server.apiBase, '/agents')).data;
  const byKey = new Map(agents.map((agent) => [agent.key, agent]));
  const requirements = byKey.get('requirements');
  const productManager = byKey.get('product-manager');
  if (!requirements || !productManager) {
    throw new Error('V1 linear workflow smoke requires requirements and product-manager Agents.');
  }
  const firstNodeId = 'v1-linear-requirements';
  const secondNodeId = 'v1-linear-product-manager';
  const draft = (await api(server.apiBase, '/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name: 'V1 linear two-agent workflow',
      nodes: [
        {
          id: firstNodeId,
          type: 'agent',
          name: 'Analyze requirements first',
          agentId: requirements.id,
          order: 0
        },
        {
          id: secondNodeId,
          type: 'agent',
          name: 'Produce product plan second',
          agentId: productManager.id,
          order: 1
        }
      ],
      edges: []
    })
  })).data;
  if (
    draft.edges.length !== 1 ||
    draft.edges[0].sourceNodeId !== firstNodeId ||
    draft.edges[0].targetNodeId !== secondNodeId
  ) {
    throw new Error(
      `V1 must compile two Agent nodes into one canonical linear edge; received ${JSON.stringify(draft.edges)}`
    );
  }
  const workflow = (await api(server.apiBase, `/workflows/${draft.id}/publish`, {
    method: 'POST',
    body: JSON.stringify({ expectedDraftRevision: draft.draftRevision })
  })).data;

  const { sessionId, briefId } = await createSessionAndWaitForBrief(
    server.apiBase,
    '分析并记录两个协作阶段的线性先后顺序，仅输出说明。',
    {
      agentIds: ['coordinator', 'requirements', 'product-manager', 'review', 'notification'],
      runtimePreference: {
        preferredRuntimeType: 'mock',
        allowedRuntimeTypes: ['mock']
      }
    }
  );

  await confirmBriefAndSelectWorkflow(server.apiBase, sessionId, briefId, workflow);
  await waitForStatus(server.apiBase, sessionId, 'COMPLETED', 90_000);
  const events = await listEvents(server.apiBase, sessionId);
  const firstCompletedIndex = events.findIndex(
    (event) =>
      event.type === 'workflow_node_completed' && event.metadata.payload?.workflowNodeId === firstNodeId
  );
  const secondStartedIndex = events.findIndex(
    (event) =>
      event.type === 'workflow_node_started' && event.metadata.payload?.workflowNodeId === secondNodeId
  );
  if (firstCompletedIndex < 0 || secondStartedIndex < 0 || firstCompletedIndex > secondStartedIndex) {
    throw new Error('V1 linear workflow must complete the first node before starting the second node.');
  }

  console.log('V1 linear workflow contract smoke ok');
} finally {
  if (server) {
    await stopSmokeServer(server);
  }
}
