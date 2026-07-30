import { api, buildServer, startSmokeServer, stopSmokeServer } from './smoke-server.mjs';

await buildServer();
let server;

try {
  server = await startSmokeServer('workspace-snapshot-payload-smoke', {
    DISCUSSION_MAX_ROUNDS: '0',
    GLOBAL_DEFAULT_RUNTIME_TYPE: 'mock'
  });

  await assertRejectsClientSnapshot(server.apiBase, {
    rootName: 'client-supplied-workspace',
    scannedAt: new Date().toISOString(),
    fileCount: 1,
    totalBytes: 17,
    tree: [{ path: 'README.md', kind: 'file' }],
    files: [{ path: 'README.md', size: 17, content: '# uploaded data\n' }],
    skipped: []
  });

  console.log('client workspace snapshot rejection smoke ok');
} finally {
  if (server) await stopSmokeServer(server);
}

process.exit(0);

async function assertRejectsClientSnapshot(apiBase, workspaceSnapshot) {
  let rejected = false;
  try {
    await api(apiBase, '/sessions', {
      method: 'POST',
      body: JSON.stringify({
        input: 'A client-provided workspace snapshot must be rejected.',
        agentIds: ['00000000-0000-0000-0000-000000000001'],
        workspaceSnapshot
      })
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    rejected = /400/.test(message) && /Unsupported Session create fields/.test(message);
  }
  if (!rejected) {
    throw new Error('POST /sessions accepted a client-provided workspaceSnapshot.');
  }
}
