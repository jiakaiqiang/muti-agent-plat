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
  server = await startSmokeServer('task-dependency-smoke', {
    DISCUSSION_MAX_ROUNDS: '0'
  });

  const agents = (await api(server.apiBase, '/agents')).data;
  const byKey = new Map(agents.map((agent) => [agent.key, agent]));
  const requirements = byKey.get('requirements');
  const productManager = byKey.get('product-manager');
  if (!requirements || !productManager) {
    throw new Error('Task dependency smoke requires requirements and product-manager Agents.');
  }
  const upstreamNodeId = 'dependency-upstream-requirements';
  const downstreamNodeId = 'dependency-downstream-plan';
  const draft = (await api(server.apiBase, '/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Task dependency workflow',
      nodes: [
        {
          id: upstreamNodeId,
          type: 'agent',
          name: 'Analyze dependency prerequisites',
          agentId: requirements.id,
          order: 0
        },
        {
          id: downstreamNodeId,
          type: 'agent',
          name: 'Produce dependent plan',
          agentId: productManager.id,
          order: 1
        }
      ],
      edges: [{ sourceNodeId: upstreamNodeId, targetNodeId: downstreamNodeId }]
    })
  })).data;
  const workflow = (await api(server.apiBase, `/workflows/${draft.id}/publish`, {
    method: 'POST',
    body: JSON.stringify({ expectedDraftRevision: draft.draftRevision })
  })).data;

  const { sessionId, briefId } = await createSessionAndWaitForBrief(
    server.apiBase,
    '分析并记录依赖规划阶段的先后顺序，仅输出说明。',
    {
      runtimePreference: {
        preferredRuntimeType: 'mock',
        allowedRuntimeTypes: ['mock']
      }
    }
  );
  await confirmBriefAndSelectWorkflow(server.apiBase, sessionId, briefId, workflow);
  await waitForStatus(server.apiBase, sessionId, 'COMPLETED');

  const tasksResponse = await api(server.apiBase, `/sessions/${sessionId}/tasks`);
  const tasks = tasksResponse.data;
  const upstreamTask = tasks.find((task) => task.workflowNodeId === upstreamNodeId);
  const downstreamTask = tasks.find((task) => task.workflowNodeId === downstreamNodeId);
  if (!upstreamTask || !downstreamTask) {
    throw new Error(`Expected workflow dependency tasks: ${JSON.stringify(tasks)}`);
  }
  const events = await listEvents(server.apiBase, sessionId);
  const dependencyCompletedAt = events.findIndex(
    (event) => event.type === 'workflow_node_completed' && event.taskId === upstreamTask.id
  );
  const dependentStartedAt = events.findIndex(
    (event) => event.type === 'workflow_node_started' && event.taskId === downstreamTask.id
  );
  if (dependencyCompletedAt < 0 || dependentStartedAt < 0 || dependencyCompletedAt > dependentStartedAt) {
    throw new Error('Dependent task must start only after its dependency completes');
  }

  console.log('task dependency smoke ok');
} finally {
  if (server) {
    await stopSmokeServer(server);
  }
}
