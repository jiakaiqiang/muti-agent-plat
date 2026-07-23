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

async function waitForWorkflowStep(apiBase, sessionId, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const session = (await api(apiBase, `/sessions/${sessionId}`)).data;
    if (session.status === 'WAIT_WORKFLOW_STEP_CONFIRM') return session;
    if (session.status === 'WAIT_USER_DECISION' || session.status === 'FAILED') {
      const events = (await listEvents(apiBase, sessionId)).filter((event) =>
        ['task_blocked', 'task_waiting', 'runtime_failed', 'error_reported', 'session_status_changed'].includes(event.type)
      );
      throw new Error(`Workflow step could not continue: ${JSON.stringify(events.slice(-12))}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Timed out waiting for workflow step confirmation.');
}

await buildServer();

let server;
try {
  server = await startSmokeServer('workflow-managed-execution-smoke', {
    DISCUSSION_AGENT_KEYS: 'requirements,product-manager',
    DISCUSSION_MAX_ROUNDS: '1',
    GLOBAL_DEFAULT_RUNTIME_TYPE: 'generic_llm',
    PROJECT_POLICY_RUNTIME_TYPE: ''
  });
  const agents = (await api(server.apiBase, '/agents')).data;
  const byKey = new Map(agents.map((agent) => [agent.key, agent]));
  const requirements = byKey.get('requirements');
  const product = byKey.get('product-manager');
  if (!requirements || !product) throw new Error('Workflow smoke requires requirements and product-manager Agents.');

  const draft = (await api(server.apiBase, '/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Workflow smoke sequence',
      nodes: [
        { id: 'workflow-node-requirements', type: 'agent', agentId: requirements.id, order: 0 },
        {
          id: 'workflow-gate-requirements',
          type: 'human_approval',
          title: '确认需求分析',
          instruction: '请确认需求分析输出后继续。',
          assignee: 'session_owner',
          allowedDecisions: ['approve', 'revise', 'cancel'],
          order: 1
        },
        { id: 'workflow-node-product', type: 'agent', agentId: product.id, order: 2 },
        {
          id: 'workflow-gate-test',
          type: 'human_approval',
          title: '确认验证结果',
          instruction: '请确认验证结果后完成流程。',
          assignee: 'session_owner',
          allowedDecisions: ['approve', 'revise', 'cancel'],
          order: 3
        }
      ]
    })
  })).data;
  const workflow = (await api(server.apiBase, `/workflows/${draft.id}/publish`, {
    method: 'POST',
    body: JSON.stringify({ expectedDraftRevision: draft.draftRevision })
  })).data;

  const { sessionId, briefId } = await createSessionAndWaitForBrief(
    server.apiBase,
    '分析需求，并独立验证最终结论。',
    {
      runtimePreference: {
        preferredRuntimeType: 'generic_llm',
        allowedRuntimeTypes: ['generic_llm', 'code_reader', 'test_runner']
      }
    }
  );
  await api(server.apiBase, `/sessions/${sessionId}/briefs/${briefId}/confirm`, { method: 'POST' });
  await waitForStatus(server.apiBase, sessionId, 'WAIT_WORKFLOW_SELECT');
  const workflowSelection = await waitForMatchingEvent(
    server.apiBase,
    sessionId,
    'user_confirmation_requested',
    (event) => event.metadata.payload.reason === 'select_workflow'
  );
  const selected = (await api(server.apiBase, `/sessions/${sessionId}/workflow/select`, {
    method: 'POST',
    body: JSON.stringify({
      workflowId: workflow.id,
      workflowVersion: workflow.currentPublishedVersion,
      confirmationId: workflowSelection.metadata.payload.confirmationId
    })
  })).data;

  if (selected.workflowRun.workflowVersion !== workflow.currentPublishedVersion) {
    throw new Error(`Workflow run did not bind the published version: ${JSON.stringify(selected.workflowRun)}`);
  }
  const expectedGates = ['workflow-gate-requirements', 'workflow-gate-test'];
  const expectedAgentNodes = ['workflow-node-requirements', 'workflow-node-product'];
  for (let index = 0; index < expectedGates.length; index += 1) {
    await waitForWorkflowStep(server.apiBase, sessionId);
    const confirmation = await waitForMatchingEvent(
      server.apiBase,
      sessionId,
      'user_confirmation_requested',
      (event) =>
        event.metadata.payload.reason === 'confirm_workflow_human_gate' &&
        event.metadata.payload.workflowNodeId === expectedGates[index]
    );
    const events = await listEvents(server.apiBase, sessionId);
    if (!events.some(
      (event) =>
        event.type === 'workflow_node_completed' &&
        event.metadata.payload.workflowNodeId === expectedAgentNodes[index]
    )) {
      throw new Error(`Workflow node completion is missing for ${expectedAgentNodes[index]}.`);
    }
    await api(
      server.apiBase,
      `/workflow-runs/${confirmation.metadata.payload.workflowRunId}/nodes/${confirmation.metadata.payload.workflowNodeRunId}/decision`,
      {
      method: 'POST',
      body: JSON.stringify({
        confirmationId: confirmation.metadata.payload.confirmationId,
        expectedRunRevision: confirmation.metadata.payload.expectedRunRevision,
        decision: 'approve'
      })
      }
    );
  }

  const completed = await waitForStatus(server.apiBase, sessionId, 'COMPLETED');
  const runDetail = (await api(server.apiBase, `/workflow-runs/${selected.workflowRun.id}`)).data;
  if (runDetail.run.status !== 'completed') {
    throw new Error(`Workflow run did not complete: ${JSON.stringify(runDetail)}`);
  }
  console.log('workflow managed execution smoke ok');
} finally {
  if (server) await stopSmokeServer(server);
}
