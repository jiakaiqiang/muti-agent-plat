import {
  api,
  buildServer,
  createSessionAndWaitForBrief,
  listEvents,
  waitForEvent,
  waitForMatchingEvent,
  waitForStatus
} from './smoke-server.mjs';
import {
  assertVisible,
  startBrowserPage,
  startBrowserSmokeServer,
  stopBrowserCollaborationSmoke
} from './browser-smoke-utils.mjs';

await buildServer();
let handle;

try {
  handle = await startBrowserSmokeServer('browser-executing-user-interrupt', {
    DISCUSSION_MAX_ROUNDS: '0',
    MOCK_RUNTIME_DELAY_MS: '1800'
  });
  const { server, webPort } = handle;
  const { sessionId, briefId } = await createSessionAndWaitForBrief(
    server.apiBase,
    'Execute a delayed implementation task so the user can change constraints while agents are running.'
  );

  Object.assign(handle, await startBrowserPage(server.apiBase, webPort));
  const { page, web } = handle;
  await page.goto(`${web.webBase}/?view=chat`, { waitUntil: 'domcontentloaded' });

  await assertVisible(page, 'Collaboration Plan', 'Chat task board header');
  await assertVisible(page, 'Brief Gate', 'Brief confirmation gate');
  await page.locator('.confirmation-card__actions .action-button.primary').first().click();

  const firstTaskStarted = await waitForEvent(server.apiBase, sessionId, 'task_started', 20_000);
  const firstTaskId = firstTaskStarted.taskId;
  if (!firstTaskId) {
    throw new Error('Expected a running task before sending the executing interrupt.');
  }

  const supplement = 'While executing, add this visible browser interrupt constraint and route it to the active task.';
  await page.locator('.user-input-box textarea').fill(supplement);
  await page.locator('.user-input-box .send-button').click();

  const rescheduled = await waitForMatchingEvent(
    server.apiBase,
    sessionId,
    'session_status_changed',
    (event) => event.metadata.payload?.reason === 'executing_user_interrupt_rescheduled',
    20_000
  );
  const affectedTaskIds = rescheduled.metadata.payload?.affectedTaskIds ?? [];
  if (!affectedTaskIds.includes(firstTaskId)) {
    throw new Error('Browser interrupt must reference the task that was running when the user changed constraints.');
  }

  await assertVisible(page, 'Execution Interrupts', 'Task board executing interrupt section');
  await assertVisible(page, 'Affected Agents', 'Task board affected agent list');
  await assertVisible(page, 'Affected Tasks', 'Task board affected task list');
  await assertVisible(page, 'rescheduled', 'Task board reschedule status');
  await assertVisible(page, supplement, 'Chat timeline keeps the user interrupt visible');

  await waitForStatus(server.apiBase, sessionId, 'COMPLETED', 90_000);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await assertVisible(page, 'Execution Interrupts', 'Task board retains interrupt evidence after completion');
  await assertVisible(page, 'Review & Delivery', 'Review and delivery still completes after interrupt');
  await assertVisible(page, 'Delivery Evidence', 'Delivery evidence after interrupt reschedule');

  const events = await listEvents(server.apiBase, sessionId);
  const startsForTask = events.filter((event) => event.type === 'task_started' && event.taskId === firstTaskId);
  if (startsForTask.length < 2) {
    throw new Error(`Expected active task to restart after browser interrupt, got ${startsForTask.length} starts.`);
  }
  const routed = events.find(
    (event) => event.type === 'agent_message' && event.metadata.payload?.phase === 'user_message_routing'
  );
  if (!routed?.toAgentIds?.length || !routed.content.includes('browser interrupt constraint')) {
    throw new Error('Executing interrupt must stay visible as a routed group-chat event.');
  }

  await api(server.apiBase, `/sessions/${sessionId}`);
  if (!briefId) {
    throw new Error('Smoke setup must create a brief before confirmation.');
  }

  console.log('browser executing user interrupt smoke ok');
} finally {
  if (handle) {
    await stopBrowserCollaborationSmoke(handle);
  }
}
