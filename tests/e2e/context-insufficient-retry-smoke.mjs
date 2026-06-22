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
  server = await startSmokeServer('context-insufficient-retry-smoke', {
    DISCUSSION_MAX_ROUNDS: '0',
    MOCK_CONTEXT_INSUFFICIENT_ONCE: 'true'
  });

  const { sessionId, briefId } = await createSessionAndWaitForBrief(
    server.apiBase,
    'Implement a small workspace change and retry the current phase after requesting missing source context.',
    {
      tokenBudget: 50_000,
      workspaceSnapshot: {
        rootName: 'context-insufficient-retry-project',
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
            content: 'export const supplementalRetryMarker = "REQUESTED_SOURCE_CONTEXT_7421";',
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

  await api(server.apiBase, `/sessions/${sessionId}/briefs/${briefId}/confirm`, { method: 'POST' });
  await waitForStatus(server.apiBase, sessionId, 'COMPLETED', 90_000);

  const events = await listEvents(server.apiBase, sessionId);
  const insufficientEvents = events.filter(
    (event) => event.type === 'runtime_failed' && event.metadata.payload?.code === 'CONTEXT_INSUFFICIENT'
  );
  if (!insufficientEvents.length) {
    throw new Error(`Expected a CONTEXT_INSUFFICIENT runtime_failed event: ${JSON.stringify(events)}`);
  }
  const failedTaskId = insufficientEvents[0].taskId;
  const retryStarts = events.filter((event) => event.type === 'runtime_started' && event.taskId === failedTaskId);
  if (retryStarts.length < 2) {
    throw new Error(`Expected the same task to be retried after supplemental context, got ${retryStarts.length}`);
  }

  const supplementEvent = events.find(
    (event) =>
      event.type === 'agent_message' &&
      event.taskId === failedTaskId &&
      event.metadata.payload?.phase === 'context_supplement' &&
      event.metadata.payload?.requestedContext?.reason
  );
  if (!supplementEvent) {
    throw new Error('Expected a visible context_supplement agent_message with requestedContext.');
  }

  const tasks = await api(server.apiBase, `/sessions/${sessionId}/tasks`);
  const retriedTask = tasks.data.find((task) => task.id === failedTaskId);
  if (retriedTask?.status !== 'completed') {
    throw new Error(`Expected retried task to complete, got ${JSON.stringify(retriedTask)}`);
  }

  const invocations = await api(server.apiBase, `/sessions/${sessionId}/debug/runtime-invocations`);
  const blockedInvocation = invocations.data.items.find(
    (item) => item.taskId === failedTaskId && item.error?.code === 'CONTEXT_INSUFFICIENT'
  );
  const completedInvocation = invocations.data.items.find(
    (item) => item.taskId === failedTaskId && item.status === 'completed'
  );
  if (!blockedInvocation || !completedInvocation) {
    throw new Error(`Expected blocked and completed debug invocations for retry: ${JSON.stringify(invocations)}`);
  }

  const contextPacks = await api(server.apiBase, `/sessions/${sessionId}/debug/context-packs`);
  const retriedPack = contextPacks.data.items
    .filter((item) => item.taskId === failedTaskId)
    .at(-1)?.contextPack;
  const selectedContents = retriedPack?.selectedEvidenceContents ?? [];
  const requestedSource = selectedContents.find((item) => item.ref === 'src/index.ts');
  if (!requestedSource?.content?.includes('REQUESTED_SOURCE_CONTEXT_7421')) {
    throw new Error(`Expected requested source path content to be injected on retry: ${JSON.stringify(selectedContents)}`);
  }
  const selectedRefs = retriedPack?.taskContext?.evidenceSelection?.selectedRefs ?? [];
  const requestedRef = selectedRefs.find((item) => item.ref === 'src/index.ts');
  if (!requestedRef?.selectionReason?.includes('Requested by runtime after CONTEXT_INSUFFICIENT')) {
    throw new Error(`Expected requested source path to be selected with supplemental reason: ${JSON.stringify(selectedRefs)}`);
  }
  if ((retriedPack?.workspaceManifest?.files.length ?? 0) > 20) {
    throw new Error(`Expected manifest to stay compact after retry: ${JSON.stringify(retriedPack?.workspaceManifest)}`);
  }
  if ((retriedPack?.selectedEvidenceContents?.length ?? 0) > 3) {
    throw new Error(`Expected selected evidence contents to stay compact after retry: ${JSON.stringify(retriedPack?.selectedEvidenceContents)}`);
  }

  console.log('context insufficient retry smoke ok');
} finally {
  if (server) {
    await stopSmokeServer(server);
  }
}
