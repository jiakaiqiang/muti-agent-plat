import {
  api,
  buildServer,
  createSessionAndWaitForBrief,
  listEvents,
  waitForStatus
} from './smoke-server.mjs';
import {
  assertVisible,
  startBrowserPage,
  startBrowserSmokeServer,
  stopBrowserCollaborationSmoke
} from './browser-smoke-utils.mjs';

async function waitForBriefCount(apiBase, sessionId, count, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const briefs = await api(apiBase, `/sessions/${sessionId}/briefs`);
    if (briefs.data.length >= count) {
      return briefs.data;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${count} briefs`);
}

async function waitForConfirmationCount(apiBase, sessionId, count, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const confirmations = (await listEvents(apiBase, sessionId)).filter(
      (event) => event.type === 'user_confirmation_requested'
    );
    if (confirmations.length >= count) {
      return confirmations;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${count} confirmation requests`);
}

await buildServer();
let handle;

try {
  handle = await startBrowserSmokeServer('browser-brief-revision');
  const { server, webPort } = handle;
  const { sessionId, briefId: firstBriefId } = await createSessionAndWaitForBrief(
    server.apiBase,
    'Build a workflow that lets the user revise the task contract before assignment.'
  );
  Object.assign(handle, await startBrowserPage(server.apiBase, webPort));
  const { page, web } = handle;

  await page.goto(`${web.webBase}/?view=chat`, { waitUntil: 'domcontentloaded' });
  await assertVisible(page, 'Collaboration Plan', 'Chat task board header');
  await assertVisible(page, 'Brief Gate', 'Brief gate before revision');
  await assertVisible(page, 'Needs user confirmation', 'Initial brief confirmation state');

  await page.locator('.confirmation-card__actions .action-button.default').first().click();
  await page.locator('.brief-revision-dialog textarea').waitFor({ state: 'visible', timeout: 20_000 });

  const revisionMarker = 'browser-mainline-revision-marker';
  await page.locator('.brief-revision-dialog textarea').fill(
    [
      'Build a workflow that lets the user revise the task contract before assignment.',
      `Revision marker: ${revisionMarker}`,
      'Every agent must re-check relevance before final task assignment.'
    ].join('\n')
  );
  await page.locator('.brief-revision-dialog button.primary').click();

  const briefs = await waitForBriefCount(server.apiBase, sessionId, 2);
  const latestBrief = briefs.at(-1);
  if (!latestBrief || latestBrief.id === firstBriefId) {
    throw new Error('Revision must create a new current brief');
  }
  await waitForStatus(server.apiBase, sessionId, 'WAIT_USER_CONFIRM');
  await waitForConfirmationCount(server.apiBase, sessionId, 2);

  await assertVisible(page, revisionMarker, 'Revised brief marker in chat mainline');
  await assertVisible(page, 'Needs user confirmation', 'Revised brief confirmation gate');
  await assertVisible(page, 'Proposed', 'Revised suggested tasks before confirmation');
  await assertVisible(page, 'Discussion Evidence', 'Discussion evidence remains visible after revision');

  const boardText = await page.locator('.collaboration-task-board').innerText();
  for (const expected of ['Task Brief', 'Task Decomposition', 'Brief Gate', 'Needs user confirmation']) {
    if (!boardText.includes(expected)) {
      throw new Error(`Revised task board must include ${expected}`);
    }
  }

  console.log('browser brief revision smoke ok');
} finally {
  if (handle) {
    await stopBrowserCollaborationSmoke(handle);
  }
}
