import {
  api,
  buildServer,
  createSessionAndWaitForBrief,
  listEvents,
  startSmokeServer,
  stopSmokeServer,
  waitForEvent,
  waitForMatchingEvent,
  waitForStatus
} from './smoke-server.mjs';

await buildServer();

let server;

try {
  server = await startSmokeServer('cancel-smoke', {
    DISCUSSION_MAX_ROUNDS: '0',
    MOCK_RUNTIME_DELAY_MS: '1500',
    GLOBAL_DEFAULT_RUNTIME_TYPE: 'mock'
  });

  const agents = (await api(server.apiBase, '/agents')).data;
  const taskAgent = agents.find((agent) => agent.key === 'requirements') ?? agents[0];
  if (!taskAgent) throw new Error('Cancel smoke requires at least one Agent.');
  const workflow = (await api(server.apiBase, '/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Cancel smoke workflow',
      nodes: [{ id: 'cancel-smoke-node', type: 'agent', agentId: taskAgent.id, order: 0 }]
    })
  })).data;

  const { sessionId, briefId } = await createSessionAndWaitForBrief(
    server.apiBase,
    '分析执行中暂停与恢复的状态语义并输出结论',
    { runtimePreference: { preferredRuntimeType: 'mock', allowedRuntimeTypes: ['mock'] } }
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
      confirmationId: workflowSelection.metadata.payload.confirmationId
    })
  })).data;
  const workflowTask = selected.createdTasks[0];
  if (!workflowTask) throw new Error('Cancel smoke workflow did not create a task.');
  await waitForEvent(server.apiBase, sessionId, 'task_started');

  // 执行中暂停：应中断在途 mock 调用，执行循环停止
  await api(server.apiBase, `/sessions/${sessionId}/pause`, {
    method: 'POST',
    body: JSON.stringify({ reason: '用户要求暂停执行' })
  });
  await waitForStatus(server.apiBase, sessionId, 'WAIT_USER_DECISION', 15_000);

  // 取消传播需要一个任务边界；等它落定后统计进展类事件
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  const progressTypes = new Set(['task_completed', 'runtime_completed', 'final_delivery_created']);
  const countProgress = (events) => events.filter((event) => progressTypes.has(event.type)).length;
  const pausedProgress = countProgress(await listEvents(server.apiBase, sessionId));

  await new Promise((resolve) => setTimeout(resolve, 4_000));
  const laterEvents = await listEvents(server.apiBase, sessionId);
  const laterProgress = countProgress(laterEvents);
  if (laterProgress !== pausedProgress) {
    throw new Error(
      `Execution kept making progress after pause: ${pausedProgress} -> ${laterProgress} progress events`
    );
  }

  const detail = await api(server.apiBase, `/sessions/${sessionId}`);
  if (detail.data.status !== 'WAIT_USER_DECISION') {
    throw new Error(`Session left WAIT_USER_DECISION without user action: ${detail.data.status}`);
  }

  const cancelledRuntime = laterEvents.find(
    (event) =>
      event.type === 'runtime_failed' &&
      event.metadata?.payload?.code === 'RUNTIME_CANCELLED' &&
      event.metadata?.payload?.termination?.kind === 'user_cancelled'
  );
  if (!cancelledRuntime) {
    throw new Error('Expected an in-flight runtime invocation to be cancelled by the user');
  }

  // 恢复：未完成任务继续执行直至交付
  await api(server.apiBase, `/sessions/${sessionId}/resume`, {
    method: 'POST',
    body: JSON.stringify({ reason: '用户确认继续执行' })
  });
  await waitForStatus(server.apiBase, sessionId, 'WAIT_WORKFLOW_STEP_CONFIRM', 90_000);
  const stepConfirmation = await waitForMatchingEvent(
    server.apiBase,
    sessionId,
    'user_confirmation_requested',
    (event) =>
      event.metadata.payload.reason === 'confirm_workflow_step' &&
      event.metadata.payload.relatedTaskId === workflowTask.id
  );
  await api(server.apiBase, `/sessions/${sessionId}/workflow/steps/${workflowTask.id}/decision`, {
    method: 'POST',
    body: JSON.stringify({
      confirmationId: stepConfirmation.metadata.payload.confirmationId,
      decision: 'approve'
    })
  });
  await waitForStatus(server.apiBase, sessionId, 'COMPLETED', 90_000);

  const finalEvents = await listEvents(server.apiBase, sessionId);
  const deliveries = finalEvents.filter((event) => event.type === 'final_delivery_created');
  if (deliveries.length !== 1) {
    throw new Error(`Expected exactly 1 final_delivery_created after resume, got ${deliveries.length}`);
  }

  console.log('cancel smoke passed: pause aborted the running pipeline and resume completed the session');
} finally {
  if (server) {
    await stopSmokeServer(server);
  }
}
