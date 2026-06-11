import { rmSync } from 'node:fs';
import {
  api,
  buildServer,
  createSessionAndWaitForBrief,
  listEvents,
  startSmokeServer,
  stopSmokeServer,
  waitForEvent,
  waitForStatus
} from './smoke-server.mjs';

await buildServer();

let firstServer;
let secondServer;

try {
  firstServer = await startSmokeServer('recovery-smoke', {
    DISCUSSION_MAX_ROUNDS: '0',
    MOCK_RUNTIME_DELAY_MS: '1500'
  });

  const { sessionId, briefId } = await createSessionAndWaitForBrief(
    firstServer.apiBase,
    '验证服务崩溃重启后自动恢复执行'
  );
  await api(firstServer.apiBase, `/sessions/${sessionId}/briefs/${briefId}/confirm`, { method: 'POST' });
  await waitForEvent(firstServer.apiBase, sessionId, 'task_started');
  // 给文件持久化一个写盘窗口，然后模拟进程崩溃（绕过优雅关闭）
  await new Promise((resolve) => setTimeout(resolve, 400));
  firstServer.server.kill('SIGKILL');
  await new Promise((resolve) => setTimeout(resolve, 500));

  // 复用同一数据文件重启：RecoveryService 应续跑 EXECUTING 会话
  secondServer = await startSmokeServer('recovery-smoke-restart', {
    DISCUSSION_MAX_ROUNDS: '0',
    AGENT_CLUSTER_DATA_FILE: firstServer.dataFile
  });

  const recovered = await waitForStatus(secondServer.apiBase, sessionId, 'COMPLETED', 60_000);
  if (recovered.status !== 'COMPLETED') {
    throw new Error(`Recovered session did not complete: ${recovered.status}`);
  }

  const events = await listEvents(secondServer.apiBase, sessionId);
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
}
