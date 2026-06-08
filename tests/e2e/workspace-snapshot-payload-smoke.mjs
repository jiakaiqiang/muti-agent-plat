import { api, buildServer, listEvents, startSmokeServer, stopSmokeServer, waitForEvent } from './smoke-server.mjs';

await buildServer();

let server;

try {
  server = await startSmokeServer('workspace-snapshot-payload-smoke', {
    DEFAULT_AGENT_RUNTIME_TYPE: 'mock',
    MOCK_RUNTIME_ENABLED: 'true',
    DISCUSSION_MAX_ROUNDS: '0'
  });

  const content = 'x'.repeat(220_000);
  const files = Array.from({ length: 4 }, (_, index) => ({
    path: `src/file-${index}.ts`,
    size: content.length,
    language: 'typescript',
    content
  }));

  const created = await api(server.apiBase, '/sessions', {
    method: 'POST',
    body: JSON.stringify({
      input: 'Workspace snapshot payload should not return server 500.',
      agentIds: ['00000000-0000-0000-0000-000000000001'],
      workingDirectory: {
        kind: 'browser_local',
        id: 'payload-smoke-workspace',
        name: 'payload-smoke-workspace',
        selectedAt: new Date().toISOString()
      },
      workspaceSnapshot: {
        rootName: 'payload-smoke-workspace',
        scannedAt: new Date().toISOString(),
        fileCount: files.length,
        totalBytes: files.reduce((total, file) => total + file.size, 0),
        tree: files.map((file) => ({ path: file.path, kind: 'file' })),
        files,
        skipped: [],
        detectedStack: ['typescript'],
        entrypoints: ['src/file-0.ts']
      }
    })
  });

  if (!created.data?.session?.id) {
    throw new Error('Expected session creation to succeed for bounded workspace snapshot');
  }

  const manyFiles = Array.from({ length: 80 }, (_, index) => ({
    path: index < 2 ? ['AGENTS.md', 'client/package.json'][index] : `src/file-${index}.ts`,
    size: 6_000,
    language: index === 0 ? 'markdown' : index === 1 ? 'json' : 'typescript',
    content: `${index}: ${'workspace context '.repeat(300)}`
  }));
  const manyFilesSession = await api(server.apiBase, '/sessions', {
    method: 'POST',
    body: JSON.stringify({
      input: 'Use the selected workspace to analyze the implementation request without exceeding token budget.',
      agentIds: ['00000000-0000-0000-0000-000000000001'],
      tokenBudget: 21_000,
      workingDirectory: {
        kind: 'browser_local',
        id: 'payload-smoke-many-files',
        name: 'payload-smoke-many-files',
        selectedAt: new Date().toISOString()
      },
      workspaceSnapshot: {
        rootName: 'payload-smoke-many-files',
        scannedAt: new Date().toISOString(),
        fileCount: 335,
        totalBytes: manyFiles.reduce((total, file) => total + file.size, 0),
        tree: manyFiles.map((file) => ({ path: file.path, kind: 'file' })),
        files: manyFiles,
        skipped: Array.from({ length: 153 }, (_, index) => ({ path: `node_modules/skipped-${index}`, reason: 'ignored_directory' })),
        detectedStack: ['vue', 'vite'],
        entrypoints: ['AGENTS.md', 'client/package.json']
      }
    })
  });
  const manyFilesSessionId = manyFilesSession.data.session.id;
  await waitForEvent(server.apiBase, manyFilesSessionId, 'brief_created');
  const manyFilesEvents = await listEvents(server.apiBase, manyFilesSessionId);
  const tokenBudgetExceeded = manyFilesEvents.find(
    (event) => event.type === 'error_reported' && event.metadata.payload?.code === 'TOKEN_BUDGET_EXCEEDED'
  );
  if (tokenBudgetExceeded) {
    throw new Error(`Expected workspace context to be compacted before runtime: ${tokenBudgetExceeded.content}`);
  }

  console.log('workspace snapshot payload smoke ok');
} finally {
  if (server) {
    await stopSmokeServer(server);
  }
}
