import {
  api,
  buildServer,
  confirmBriefAndSelectWorkflow,
  createPublishedAgentWorkflow,
  createSessionAndWaitForBrief,
  listEvents,
  startSmokeServer,
  stopSmokeServer,
  waitForStatus
} from './smoke-server.mjs';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

await buildServer();

let server;
const workspaceRoot = mkdtempSync(join(tmpdir(), 'context-insufficient-multi-retry-'));

try {
  mkdirSync(join(workspaceRoot, 'src'), { recursive: true });
  writeFileSync(join(workspaceRoot, 'src', 'index.ts'), 'export const indexMarker = "MULTI_RETRY_INDEX_AAA";');
  writeFileSync(join(workspaceRoot, 'src', 'utils.ts'), 'export const utilsMarker = "MULTI_RETRY_UTILS_BBB";');
  writeFileSync(join(workspaceRoot, 'src', 'config.ts'), 'export const configMarker = "MULTI_RETRY_CONFIG_CCC";');
  writeFileSync(join(workspaceRoot, 'package.json'), '{"scripts":{"typecheck":"tsc --noEmit","test":"vitest run","build":"vite build"}}');
  server = await startSmokeServer('context-insufficient-multi-retry-smoke', {
    DISCUSSION_MAX_ROUNDS: '0',
    // Mock returns CONTEXT_INSUFFICIENT for the first 2 task_execution attempts,
    // requesting a different workspace file each round so T06 dedupe still
    // allows the retry through. The 3rd attempt succeeds.
    MOCK_CONTEXT_INSUFFICIENT_TIMES: '2'
  });
  const workflow = await createPublishedAgentWorkflow(
    server.apiBase,
    'Context insufficient multi-retry workflow',
    ['product-manager']
  );

  const { sessionId, briefId } = await createSessionAndWaitForBrief(
    server.apiBase,
    'Implement a small workspace change and retry the current phase after requesting missing source context more than once.',
    {
      tokenBudget: 50_000,
      runtimePreference: { preferredRuntimeType: 'mock', allowedRuntimeTypes: ['mock'] },
      workingDirectory: {
        kind: 'server_local',
        id: 'context-insufficient-multi-retry-workspace',
        name: 'context-insufficient-multi-retry-project',
        path: workspaceRoot,
        selectedAt: new Date().toISOString()
      },
      workspaceSnapshot: {
        rootName: 'context-insufficient-multi-retry-project',
        scannedAt: new Date().toISOString(),
        fileCount: 4,
        totalBytes: 512,
        tree: [
          { path: 'src/index.ts', kind: 'file' },
          { path: 'src/utils.ts', kind: 'file' },
          { path: 'src/config.ts', kind: 'file' },
          { path: 'package.json', kind: 'file' }
        ],
        files: [
          {
            path: 'src/index.ts',
            size: 64,
            language: 'typescript',
            content: 'export const indexMarker = "MULTI_RETRY_INDEX_AAA";',
            summary: 'Entry file summary only.'
          },
          {
            path: 'src/utils.ts',
            size: 64,
            language: 'typescript',
            content: 'export const utilsMarker = "MULTI_RETRY_UTILS_BBB";',
            summary: 'Utility module summary only.'
          },
          {
            path: 'src/config.ts',
            size: 64,
            language: 'typescript',
            content: 'export const configMarker = "MULTI_RETRY_CONFIG_CCC";',
            summary: 'Config module summary only.'
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

  await confirmBriefAndSelectWorkflow(server.apiBase, sessionId, briefId, workflow);
  await waitForStatus(server.apiBase, sessionId, 'COMPLETED', 90_000);

  const events = await listEvents(server.apiBase, sessionId);
  const insufficientEvents = events.filter(
    (event) => event.type === 'runtime_failed' && event.metadata.payload?.code === 'CONTEXT_INSUFFICIENT'
  );
  if (insufficientEvents.length < 2) {
    throw new Error(
      `Expected at least 2 CONTEXT_INSUFFICIENT runtime_failed events for a multi-retry session, got ${insufficientEvents.length}: ${JSON.stringify(
        insufficientEvents.map((event) => ({
          taskId: event.taskId,
          requestedPaths: event.metadata.payload?.requestedContext?.requestedPaths
        }))
      )}`
    );
  }
  const failedTaskId = insufficientEvents[0].taskId;
  const sameTaskFailures = insufficientEvents.filter((event) => event.taskId === failedTaskId);
  if (sameTaskFailures.length < 2) {
    throw new Error(
      `Expected the same task to fail with CONTEXT_INSUFFICIENT at least twice, got ${sameTaskFailures.length}.`
    );
  }

  // Each retry must have requested a different path - otherwise dedupe would
  // have rejected the second attempt and the session would have failed.
  const requestedPaths = sameTaskFailures.map((event) => {
    const paths = event.metadata.payload?.requestedContext?.requestedPaths ?? [];
    return paths[0];
  });
  const uniquePaths = new Set(requestedPaths.filter(Boolean));
  if (uniquePaths.size < 2) {
    throw new Error(
      `Expected at least 2 distinct paths across retries (so dedupe lets each one through), got ${JSON.stringify(requestedPaths)}.`
    );
  }

  const retryStarts = events.filter((event) => event.type === 'runtime_started' && event.taskId === failedTaskId);
  if (retryStarts.length < 3) {
    throw new Error(`Expected the task to be retried twice (so 3 runtime_started events), got ${retryStarts.length}.`);
  }

  const supplementEvents = events.filter(
    (event) =>
      event.type === 'agent_message' &&
      event.taskId === failedTaskId &&
      event.metadata.payload?.phase === 'context_supplement' &&
      event.metadata.payload?.requestedContext?.reason &&
      event.metadata.payload?.rejectionReason === undefined
  );
  if (supplementEvents.length < 2) {
    throw new Error(
      `Expected at least 2 visible context_supplement agent_message events without rejection, got ${supplementEvents.length}.`
    );
  }

  const rejectionEvents = events.filter(
    (event) =>
      event.type === 'agent_message' &&
      event.metadata.payload?.phase === 'context_supplement' &&
      event.metadata.payload?.rejectionReason
  );
  if (rejectionEvents.length > 0) {
    throw new Error(
      `Expected no dedupe rejections during a happy-path multi-retry session, got ${rejectionEvents.length}: ${JSON.stringify(rejectionEvents)}`
    );
  }

  const tasks = await api(server.apiBase, `/sessions/${sessionId}/tasks`);
  const retriedTask = tasks.data.find((task) => task.id === failedTaskId);
  if (retriedTask?.status !== 'completed') {
    throw new Error(`Expected retried task to complete after multi-retry, got ${JSON.stringify(retriedTask)}`);
  }

  console.log('context insufficient multi-retry smoke ok');
} finally {
  if (server) {
    await stopSmokeServer(server);
  }
  rmSync(workspaceRoot, { recursive: true, force: true });
}
