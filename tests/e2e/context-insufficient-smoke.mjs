import {
  api,
  buildServer,
  confirmBriefAndSelectWorkflow,
  createPublishedAgentWorkflow,
  createSessionAndWaitForBrief,
  startSmokeServer,
  stopSmokeServer,
  waitForMatchingEvent
} from './smoke-server.mjs';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

await buildServer();

let server;
const workspaceRoot = mkdtempSync(join(tmpdir(), 'context-insufficient-'));

try {
  mkdirSync(join(workspaceRoot, 'src'), { recursive: true });
  writeFileSync(join(workspaceRoot, 'src', 'index.ts'), 'export const contextMarker = "CONTEXT_INSUFFICIENT_SOURCE";');
  writeFileSync(join(workspaceRoot, 'package.json'), '{"scripts":{"typecheck":"tsc --noEmit","test":"vitest run","build":"vite build"}}');
  server = await startSmokeServer('context-insufficient-smoke', {
    DISCUSSION_MAX_ROUNDS: '0',
    MOCK_CONTEXT_INSUFFICIENT: 'true'
  });
  const workflow = await createPublishedAgentWorkflow(
    server.apiBase,
    'Context insufficient workflow',
    ['product-manager']
  );

  const { sessionId, briefId } = await createSessionAndWaitForBrief(
    server.apiBase,
    'Implement a small workspace change, but request more context when selected evidence is not enough.',
    {
      tokenBudget: 50_000,
      runtimePreference: { preferredRuntimeType: 'mock', allowedRuntimeTypes: ['mock'] },
      workingDirectory: {
        kind: 'server_local',
        id: 'context-insufficient-workspace',
        name: 'context-insufficient-project',
        path: workspaceRoot,
        selectedAt: new Date().toISOString()
      },
      workspaceSnapshot: {
        rootName: 'context-insufficient-project',
        scannedAt: new Date().toISOString(),
        fileCount: 2,
        totalBytes: 256,
        tree: [
          { path: 'src/index.ts', kind: 'file' },
          { path: 'package.json', kind: 'file' }
        ],
        files: [
          { path: 'src/index.ts', size: 64, language: 'typescript', summary: 'Entry file summary only.' },
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

  const runtimeFailed = await waitForMatchingEvent(
    server.apiBase,
    sessionId,
    'runtime_failed',
    (event) => event.metadata.payload?.code === 'CONTEXT_INSUFFICIENT'
  );
  const requestedContext = runtimeFailed.metadata.payload.requestedContext;
  if (!requestedContext?.reason || !requestedContext.requestedPaths?.length) {
    throw new Error(`Expected runtime_failed requestedContext: ${JSON.stringify(runtimeFailed)}`);
  }

  const taskWaiting = await waitForMatchingEvent(
    server.apiBase,
    sessionId,
    'task_waiting',
    (event) => event.metadata.payload?.requestedContext?.reason === requestedContext.reason
  );
  if (taskWaiting.metadata.payload.status !== 'waiting') {
    throw new Error(`Expected task_waiting status waiting: ${JSON.stringify(taskWaiting)}`);
  }

  const tasks = await api(server.apiBase, `/sessions/${sessionId}/tasks`);
  const waitingTask = tasks.data.find((task) => task.status === 'waiting');
  if (!waitingTask) {
    throw new Error(`Expected a waiting task after CONTEXT_INSUFFICIENT: ${JSON.stringify(tasks)}`);
  }

  const invocations = await api(server.apiBase, `/sessions/${sessionId}/debug/runtime-invocations`);
  const blockedInvocation = invocations.data.items.find(
    (item) => item.error?.code === 'CONTEXT_INSUFFICIENT' && item.summary?.requestedContextPathCount > 0
  );
  if (!blockedInvocation) {
    throw new Error(`Expected debug invocation to expose requestedContext counts: ${JSON.stringify(invocations)}`);
  }

  console.log('context insufficient smoke ok');
} finally {
  if (server) {
    await stopSmokeServer(server);
  }
  rmSync(workspaceRoot, { recursive: true, force: true });
}
