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

await buildServer();
let handle;

try {
  handle = await startBrowserSmokeServer('browser-context-insufficient-retry', {
    DISCUSSION_MAX_ROUNDS: '0',
    MOCK_CONTEXT_INSUFFICIENT_ONCE: 'true'
  });
  const { server, webPort } = handle;
  const { sessionId, briefId } = await createSessionAndWaitForBrief(
    server.apiBase,
    'Implement a small workspace change and surface the context retry in the group-chat task board.',
    {
      tokenBudget: 50_000,
      workspaceSnapshot: {
        rootName: 'browser-context-retry-project',
        scannedAt: new Date().toISOString(),
        fileCount: 2,
        totalBytes: 256,
        tree: [
          { path: 'src/index.ts', kind: 'file' },
          { path: 'package.json', kind: 'file' }
        ],
        files: [
          {
            path: 'src/index.ts',
            size: 64,
            language: 'typescript',
            content: 'export const browserContextRetryMarker = "BROWSER_CONTEXT_RETRY_9137";',
            summary: 'Entry file summary only.'
          },
          {
            path: 'package.json',
            size: 128,
            language: 'json',
            content: '{"scripts":{"typecheck":"tsc --noEmit","test":"vitest run","build":"vite build"}}'
          }
        ],
        skipped: [],
        detectedStack: ['typescript'],
        entrypoints: ['src/index.ts']
      }
    }
  );
  Object.assign(handle, await startBrowserPage(server.apiBase, webPort));
  const { page, web } = handle;

  await page.goto(`${web.webBase}/?view=chat`, { waitUntil: 'domcontentloaded' });
  await assertVisible(page, 'Collaboration Plan', 'Chat task board header');
  await assertVisible(page, 'Brief Gate', 'Initial brief gate');

  await page.locator('.confirmation-card__actions .action-button.primary').first().click();
  await waitForStatus(server.apiBase, sessionId, 'COMPLETED', 90_000);
  await page.reload({ waitUntil: 'domcontentloaded' });

  const events = await listEvents(server.apiBase, sessionId);
  const insufficientEvent = events.find(
    (event) => event.type === 'runtime_failed' && event.metadata.payload?.code === 'CONTEXT_INSUFFICIENT'
  );
  if (!insufficientEvent) {
    throw new Error('Expected CONTEXT_INSUFFICIENT runtime failure before retry');
  }
  const supplementEvent = events.find(
    (event) =>
      event.type === 'agent_message' &&
      event.metadata.payload?.phase === 'context_supplement' &&
      event.metadata.payload?.requestedContext?.requestedPaths?.includes('src/index.ts')
  );
  if (!supplementEvent) {
    throw new Error('Expected visible context_supplement event for requested source path');
  }
  const failedTaskId = insufficientEvent.taskId;
  const retryStarts = events.filter((event) => event.type === 'runtime_started' && event.taskId === failedTaskId);
  if (retryStarts.length < 2) {
    throw new Error(`Expected retry after context supplement, got ${retryStarts.length}`);
  }

  await assertVisible(page, 'Context', 'Task board context summary');
  await assertVisible(page, 'supplements', 'Task board supplemental context count');
  await assertVisible(page, 'Requested paths', 'Chat timeline requested paths block');
  await assertVisible(page, 'src/index.ts', 'Requested source path in chat timeline');
  await assertVisible(page, 'Delivery Evidence', 'Delivery evidence after retry');
  await assertVisible(page, 'Done', 'Completed task status after retry');

  const boardText = await page.locator('.collaboration-task-board').innerText();
  const supplementMatch = boardText.match(/(\d+)\s+supplements/);
  if (!supplementMatch || Number(supplementMatch[1]) < 1) {
    throw new Error('Task board must surface supplemental context count after retry');
  }
  if (!boardText.includes('Review & Delivery') || !boardText.includes('Delivery Evidence')) {
    throw new Error('Task board must still reach final delivery after context retry');
  }

  const invocations = await api(server.apiBase, `/sessions/${sessionId}/debug/runtime-invocations`);
  const blockedInvocation = invocations.data.items.find(
    (item) => item.taskId === failedTaskId && item.error?.code === 'CONTEXT_INSUFFICIENT'
  );
  const completedInvocation = invocations.data.items.find(
    (item) => item.taskId === failedTaskId && item.status === 'completed'
  );
  if (!blockedInvocation || !completedInvocation) {
    throw new Error('Expected debug data to retain both blocked and completed retry invocations');
  }

  console.log('browser context insufficient retry smoke ok');
} finally {
  if (handle) {
    await stopBrowserCollaborationSmoke(handle);
  }
}
