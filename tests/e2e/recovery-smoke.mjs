import { rmSync } from 'node:fs';
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

let firstServer;
let secondServer;
let thirdServer;
let fourthServer;

try {
  firstServer = await startSmokeServer('recovery-smoke', {
    DISCUSSION_MAX_ROUNDS: '0',
    MOCK_RUNTIME_DELAY_MS: '1500',
    GLOBAL_DEFAULT_RUNTIME_TYPE: 'mock'
  });

  const agents = (await api(firstServer.apiBase, '/agents')).data;
  const taskAgent = agents.find((agent) => agent.key === 'requirements') ?? agents[0];
  if (!taskAgent) throw new Error('Recovery smoke requires at least one Agent.');
  const workflow = (await api(firstServer.apiBase, '/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Recovery smoke workflow',
      nodes: [{ id: 'recovery-smoke-node', type: 'agent', agentId: taskAgent.id, order: 0 }]
    })
  })).data;

  const { sessionId, briefId } = await createSessionAndWaitForBrief(
    firstServer.apiBase,
    '分析服务崩溃重启后的恢复语义并输出结论',
    { runtimePreference: { preferredRuntimeType: 'mock', allowedRuntimeTypes: ['mock'] } }
  );
  await api(firstServer.apiBase, `/sessions/${sessionId}/briefs/${briefId}/confirm`, { method: 'POST' });
  await waitForStatus(firstServer.apiBase, sessionId, 'WAIT_WORKFLOW_SELECT');
  const workflowSelection = await waitForMatchingEvent(
    firstServer.apiBase,
    sessionId,
    'user_confirmation_requested',
    (event) => event.metadata.payload.reason === 'select_workflow'
  );
  const selected = (await api(firstServer.apiBase, `/sessions/${sessionId}/workflow/select`, {
    method: 'POST',
    body: JSON.stringify({
      workflowId: workflow.id,
      confirmationId: workflowSelection.metadata.payload.confirmationId
    })
  })).data;
  const workflowTask = selected.createdTasks[0];
  if (!workflowTask) throw new Error('Recovery smoke workflow did not create a task.');
  await waitForEvent(firstServer.apiBase, sessionId, 'task_started');
  // 给文件持久化一个写盘窗口，然后模拟进程崩溃（绕过优雅关闭）
  await new Promise((resolve) => setTimeout(resolve, 400));
  firstServer.server.kill('SIGKILL');
  await new Promise((resolve) => setTimeout(resolve, 500));

  // 复用同一数据文件重启：RecoveryService 应续跑 EXECUTING 会话
  secondServer = await startSmokeServer('recovery-smoke-restart', {
    DISCUSSION_MAX_ROUNDS: '0',
    GLOBAL_DEFAULT_RUNTIME_TYPE: 'mock',
    AGENT_CLUSTER_DATA_FILE: firstServer.dataFile
  });

  await waitForStatus(secondServer.apiBase, sessionId, 'WAIT_WORKFLOW_STEP_CONFIRM', 60_000);
  const stepConfirmation = await waitForMatchingEvent(
    secondServer.apiBase,
    sessionId,
    'user_confirmation_requested',
    (event) =>
      event.metadata.payload.reason === 'confirm_workflow_step' &&
      event.metadata.payload.relatedTaskId === workflowTask.id
  );
  await api(secondServer.apiBase, `/sessions/${sessionId}/workflow/steps/${workflowTask.id}/decision`, {
    method: 'POST',
    body: JSON.stringify({
      confirmationId: stepConfirmation.metadata.payload.confirmationId,
      decision: 'approve'
    })
  });
  const recovered = await waitForStatus(secondServer.apiBase, sessionId, 'COMPLETED', 60_000);
  if (recovered.status !== 'COMPLETED') {
    throw new Error(`Recovered session did not complete: ${recovered.status}`);
  }

  const events = await listEvents(secondServer.apiBase, sessionId);
  const interrupted = events.find(
    (event) =>
      event.type === 'runtime_failed' &&
      event.metadata?.payload?.termination?.kind === 'service_shutdown' &&
      event.metadata.payload.termination.graceful === false
  );
  if (!interrupted) {
    throw new Error('Expected crash recovery to record service_shutdown with graceful=false');
  }
  const deliveries = events.filter((event) => event.type === 'final_delivery_created');
  if (deliveries.length !== 1) {
    throw new Error(`Expected exactly 1 final_delivery_created after recovery, got ${deliveries.length}`);
  }

  const tasks = await api(secondServer.apiBase, `/sessions/${sessionId}/tasks`);
  const notCompleted = tasks.data.filter((task) => task.status !== 'completed');
  if (notCompleted.length) {
    throw new Error(
      `Expected all tasks completed after recovery, found: ${notCompleted.map((task) => `${task.title}=${task.status}`).join(', ')}`
    );
  }

  console.log('recovery smoke passed: crashed mid-execution session resumed on boot and delivered exactly once');

  // 场景 2：讨论阶段（AGENT_DISCUSSING）崩溃。契约生成挂在进程内 promise 上，
  // 重启后 RecoveryService 必须重新驱动，否则会话永久停在最后一条事件。
  thirdServer = await startSmokeServer('recovery-smoke-discussing', {
    DISCUSSION_MAX_ROUNDS: '1',
    MOCK_RUNTIME_DELAY_MS: '1500',
    GLOBAL_DEFAULT_RUNTIME_TYPE: 'mock'
  });

  const createdDiscussing = await api(thirdServer.apiBase, '/sessions', {
    method: 'POST',
    body: JSON.stringify({
      input: '验证讨论阶段崩溃重启后自动恢复契约生成',
      agentIds: ['coordinator', 'requirements', 'architect', 'backend', 'test', 'review', 'notification'],
      runtimePreference: { preferredRuntimeType: 'mock', allowedRuntimeTypes: ['mock'] }
    })
  });
  const discussingSessionId = createdDiscussing.data.session.id;

  // 给事件与会话记录一个写盘窗口；1.5s/次的 mock 延迟保证讨论仍在进行
  await new Promise((resolve) => setTimeout(resolve, 800));
  const beforeCrash = await api(thirdServer.apiBase, `/sessions/${discussingSessionId}`);
  if (beforeCrash.data.status !== 'AGENT_DISCUSSING') {
    throw new Error(`Expected session to still be AGENT_DISCUSSING before crash, got ${beforeCrash.data.status}`);
  }
  thirdServer.server.kill('SIGKILL');
  await new Promise((resolve) => setTimeout(resolve, 500));

  fourthServer = await startSmokeServer('recovery-smoke-discussing-restart', {
    DISCUSSION_MAX_ROUNDS: '0',
    GLOBAL_DEFAULT_RUNTIME_TYPE: 'mock',
    AGENT_CLUSTER_DATA_FILE: thirdServer.dataFile
  });

  const recoveredDiscussing = await waitForStatus(
    fourthServer.apiBase,
    discussingSessionId,
    'WAIT_USER_CONFIRM',
    60_000
  );
  if (!recoveredDiscussing.currentTaskBriefId) {
    await waitForEvent(fourthServer.apiBase, discussingSessionId, 'brief_created');
  }

  const discussingEvents = await listEvents(fourthServer.apiBase, discussingSessionId);
  const recoveryNotices = discussingEvents.filter(
    (event) =>
      event.type === 'session_status_changed' &&
      event.metadata?.payload?.reason === 'brief_generation_recovered_on_boot'
  );
  if (recoveryNotices.length !== 1) {
    throw new Error(`Expected exactly 1 discussion recovery notice, got ${recoveryNotices.length}`);
  }

  console.log('recovery smoke passed: crashed mid-discussion session re-drove brief generation on boot');
} finally {
  if (secondServer) {
    await stopSmokeServer(secondServer);
  }
  if (firstServer) {
    if (!firstServer.server.killed) {
      firstServer.server.kill('SIGKILL');
    }
    rmSync(firstServer.dataFile, { force: true });
  }
  if (fourthServer) {
    await stopSmokeServer(fourthServer);
  }
  if (thirdServer) {
    if (!thirdServer.server.killed) {
      thirdServer.server.kill('SIGKILL');
    }
    rmSync(thirdServer.dataFile, { force: true });
  }
}
