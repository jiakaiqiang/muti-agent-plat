import {
  api,
  buildServer,
  createSessionAndWaitForBrief,
  waitForEvent
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
  handle = await startBrowserSmokeServer('browser-collaboration-task-board');
  const { server, webPort } = handle;
  const { sessionId, briefId } = await createSessionAndWaitForBrief(
    server.apiBase,
    'Implement a small dashboard change and verify the group-chat task decomposition delivery evidence.'
  );
  Object.assign(handle, await startBrowserPage(server.apiBase, webPort));
  const { page, web } = handle;
  await page.goto(`${web.webBase}/?view=chat`, { waitUntil: 'domcontentloaded' });

  await assertVisible(page, '协作计划', 'Chat task board header');
  await page.locator('.task-board-collapse-button').click();
  await assertVisible(page, '讨论证据', 'Discussion evidence section');
  await assertVisible(page, '任务契约', 'Task brief section');
  await assertVisible(page, '任务拆解', 'Task decomposition section');
  await assertVisible(page, '评审与交付', 'Review and delivery section');
  await assertVisible(page, '契约关口', 'Brief confirmation gate');
  await assertVisible(page, '建议', 'Suggested pre-confirmation tasks');

  await page.locator('.confirmation-card__actions .action-button.primary').first().click();
  await waitForEvent(server.apiBase, sessionId, 'final_delivery_created', 40_000);
  await api(server.apiBase, `/sessions/${sessionId}`);

  await assertVisible(page, '交付证据', 'Artifact-backed delivery evidence');
  await assertVisible(page, '验收覆盖', 'Acceptance coverage metric');
  await assertVisible(page, '验证信号', 'Validation signal metric');
  await assertVisible(page, '未关闭风险', 'Open risk metric');
  await assertVisible(page, '已完成', 'Completed task status');

  const boardText = await page.locator('.collaboration-task-board').innerText();
  for (const expected of ['讨论证据', '任务契约', '任务拆解', '评审与交付']) {
    if (!boardText.includes(expected)) {
      throw new Error(`Task board must include ${expected}`);
    }
  }
  if (!boardText.includes('验收覆盖') || !boardText.includes('交付证据')) {
    throw new Error('Task board must connect final delivery to validation and artifacts');
  }
  if (!briefId || !sessionId) {
    throw new Error('Smoke setup must create a session and brief');
  }

  console.log('browser collaboration task board smoke ok');
} finally {
  if (handle) {
    await stopBrowserCollaborationSmoke(handle);
  }
}
