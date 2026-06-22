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
  server = await startSmokeServer('engineering-runtime-selection-smoke', {
    DEFAULT_AGENT_RUNTIME_TYPE: 'generic_llm',
    DISCUSSION_MAX_ROUNDS: '0',
    REQUIRE_USER_CONFIRMATION: 'false'
  });

  const { sessionId, briefId } = await createSessionAndWaitForBrief(
    server.apiBase,
    'Implement a small TypeScript change with the session selected engineering runtime.',
    {
      tokenBudget: 50_000,
      engineeringRuntime: {
        sessionDefaultRuntimeType: 'mock'
      },
      workspaceSnapshot: {
        rootName: 'engineering-runtime-selection-project',
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
            size: 32,
            language: 'typescript',
            content: 'export const value = 1;'
          },
          {
            path: 'package.json',
            size: 96,
            language: 'json',
            content: '{"scripts":{"typecheck":"tsc --noEmit","test":"vitest run"}}'
          }
        ],
        skipped: [],
        detectedStack: ['typescript'],
        entrypoints: ['src/index.ts']
      }
    }
  );

  await api(server.apiBase, `/sessions/${sessionId}/briefs/${briefId}/confirm`, { method: 'POST' });
  await waitForStatus(server.apiBase, sessionId, 'COMPLETED', 60_000);

  const invocations = await api(server.apiBase, `/sessions/${sessionId}/debug/runtime-invocations`);
  const executionInvocation = invocations.data.items.find((item) => item.phase === 'task_execution');
  if (!executionInvocation) {
    throw new Error(`Expected task_execution invocation: ${JSON.stringify(invocations)}`);
  }
  if (executionInvocation.runtimeType !== 'mock') {
    throw new Error(`Expected effective task_execution runtime to be mock: ${JSON.stringify(executionInvocation)}`);
  }
  if (executionInvocation.contextPackSummary.runtimeSelectionSource !== 'session_override') {
    throw new Error(`Expected session override source in debug summary: ${JSON.stringify(executionInvocation)}`);
  }
  if (executionInvocation.contextPackSummary.effectiveRuntimeType !== 'mock') {
    throw new Error(`Expected effectiveRuntimeType=mock in debug summary: ${JSON.stringify(executionInvocation)}`);
  }

  const contextPacks = await api(server.apiBase, `/sessions/${sessionId}/debug/context-packs`);
  const executionPack = contextPacks.data.items.find((item) => item.phase === 'task_execution');
  if (executionPack?.contextPack?.runtimeSelection?.source !== 'session_override') {
    throw new Error(`Expected runtimeSelection in ContextPack: ${JSON.stringify(executionPack)}`);
  }
  if (executionPack.contextPack.agentProfile.runtimeType !== 'mock') {
    throw new Error(`Expected runtime agent profile to use effective mock runtime: ${JSON.stringify(executionPack)}`);
  }
  if (executionPack.contextPack.agentProfile.configuredRuntimeType !== 'generic_llm') {
    throw new Error(`Expected configured runtime to remain visible: ${JSON.stringify(executionPack)}`);
  }

  const events = await listEvents(server.apiBase, sessionId);
  const runtimeStarted = events.find(
    (event) =>
      event.type === 'runtime_started' &&
      event.metadata.payload?.runtimeType === 'mock' &&
      event.metadata.payload?.runtimeSelection?.source === 'session_override'
  );
  if (!runtimeStarted) {
    throw new Error(`Expected runtime_started event to expose runtimeSelection: ${JSON.stringify(events)}`);
  }

  console.log('engineering runtime selection smoke ok');
} finally {
  if (server) {
    await stopSmokeServer(server);
  }
}
