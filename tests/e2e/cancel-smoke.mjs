import {
  api,
  buildServer,
  createPublishedAgentWorkflow,
  createSessionAndWaitForBrief,
  listEvents,
  selectPublishedWorkflow,
  startSmokeServer,
  stopSmokeServer,
  waitForEvent,
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

  const workflow = await createPublishedAgentWorkflow(
    server.apiBase,
    'Cancel smoke workflow',
    ['requirements']
  );

  // Stop while the group chat is still generating its first brief, before a workflow exists.
  const chat = await api(server.apiBase, '/sessions', { method: 'POST', body: JSON.stringify({
    input: '分析群聊停止和继续的交互并输出方案',
    runtimePreference: { preferredRuntimeType: 'mock', allowedRuntimeTypes: ['mock'] }
  }) });
  const chatId = chat.data.session.id;
  await waitForEvent(server.apiBase, chatId, 'runtime_started');
  await api(server.apiBase, `/sessions/${chatId}/pause`, { method: 'POST', body: JSON.stringify({ reason: '停止当前群聊' }) });
  await waitForStatus(server.apiBase, chatId, 'PAUSED');
  await new Promise(resolve => setTimeout(resolve, 1800));
  const stoppedEvents = await listEvents(server.apiBase, chatId);
  if (stoppedEvents.some(event => event.type === 'brief_created')) throw new Error('A late brief was created after stopping chat');
  await api(server.apiBase, `/sessions/${chatId}/resume`, { method: 'POST', body: '{}' });
  await waitForStatus(server.apiBase, chatId, 'WAIT_USER_CONFIRM', 30_000);
  const resumedEvents = await listEvents(server.apiBase, chatId);
  if (resumedEvents.filter(event => event.type === 'brief_created').length !== 1) throw new Error('Chat resume must create exactly one brief');

  const { sessionId, briefId } = await createSessionAndWaitForBrief(
    server.apiBase,
    '分析执行中暂停与恢复的状态语义并输出结论',
    { runtimePreference: { preferredRuntimeType: 'mock', allowedRuntimeTypes: ['mock'] } }
  );
  await api(server.apiBase, `/sessions/${sessionId}/briefs/${briefId}/confirm`, { method: 'POST' });
  const selected = await selectPublishedWorkflow(server.apiBase, sessionId, workflow);
  const workflowTask = selected.createdTasks[0];
  if (!workflowTask) throw new Error('Cancel smoke workflow did not create a task.');
  await waitForEvent(server.apiBase, sessionId, 'task_started');

  // 执行中暂停：应中断在途 mock 调用，执行循环停止
  await api(server.apiBase, `/sessions/${sessionId}/pause`, {
    method: 'POST',
    body: JSON.stringify({ reason: '用户要求暂停执行' })
  });
  await waitForStatus(server.apiBase, sessionId, 'PAUSED', 15_000);

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
  if (detail.data.status !== 'PAUSED') {
    throw new Error(`Session left PAUSED without user action: ${detail.data.status}`);
  }

  const cancelledRuntime = laterEvents.find(
    (event) =>
      event.type === 'runtime_failed' &&
      event.metadata?.payload?.code === 'RUNTIME_CANCELLED' &&
      event.metadata?.payload?.termination?.kind === 'user_paused'
  );
  if (!cancelledRuntime) {
    throw new Error('Expected an in-flight runtime invocation to be cancelled by the user');
  }

  // 恢复：未完成任务继续执行直至交付
  await api(server.apiBase, `/sessions/${sessionId}/resume`, {
    method: 'POST',
    body: JSON.stringify({ reason: '用户确认继续执行' })
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

process.exit(0);
