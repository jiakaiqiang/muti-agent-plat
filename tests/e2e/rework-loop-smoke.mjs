import {
  api,
  buildServer,
  createSessionAndWaitForBrief,
  listEvents,
  startSmokeServer,
  stopSmokeServer,
  waitForStatus
} from './smoke-server.mjs';

await buildServer();

let server;

try {
  server = await startSmokeServer('rework-loop-smoke', {
    DISCUSSION_MAX_ROUNDS: '0',
    MOCK_REVIEW_RECOMMENDATION: 'rework',
    REWORK_MAX_ROUNDS: '1'
  });

  const { sessionId, briefId } = await createSessionAndWaitForBrief(
    server.apiBase,
    '验证复盘返工自动重跑与上限保护链路'
  );
  await api(server.apiBase, `/sessions/${sessionId}/briefs/${briefId}/confirm`, { method: 'POST' });

  // 第一次复盘 rework -> 自动返工一轮 -> 第二次复盘 rework -> 超上限 -> WAIT_USER_DECISION
  await waitForStatus(server.apiBase, sessionId, 'WAIT_USER_DECISION', 60_000);

  const events = await listEvents(server.apiBase, sessionId);

  const reworkOutcomes = events.filter(
    (event) => event.type === 'session_status_changed' && event.metadata?.payload?.outcome === 'rework'
  );
  if (reworkOutcomes.length !== 2) {
    throw new Error(`Expected 2 rework outcomes (initial + after auto-rework), got ${reworkOutcomes.length}`);
  }

  const reworkStarts = events.filter(
    (event) => event.type === 'session_status_changed' && event.metadata?.payload?.reworkRound !== undefined
  );
  if (reworkStarts.length !== 1) {
    throw new Error(`Expected exactly 1 automatic rework round, got ${reworkStarts.length}`);
  }

  const limitCard = events.find(
    (event) =>
      event.type === 'user_confirmation_requested' && event.metadata?.payload?.reason === 'rework_limit_reached'
  );
  if (!limitCard) {
    throw new Error('Expected a rework_limit_reached confirmation card after exceeding REWORK_MAX_ROUNDS');
  }

  const taskCreatedCount = events.filter((event) => event.type === 'task_created').length;
  const taskStartedCount = events.filter((event) => event.type === 'task_started').length;
  if (taskCreatedCount === 0 || taskStartedCount < taskCreatedCount * 2) {
    throw new Error(
      `Expected tasks to be re-executed during rework (created=${taskCreatedCount}, started=${taskStartedCount})`
    );
  }

  if (events.some((event) => event.type === 'final_delivery_created')) {
    throw new Error('final_delivery_created must not be emitted while review keeps requesting rework');
  }

  console.log('rework-loop smoke passed: auto rework ran once, then handed over to the user at the limit');
} finally {
  if (server) {
    await stopSmokeServer(server);
  }
}
