import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { api, buildServer, startSmokeServer, stopSmokeServer } from './smoke-server.mjs';

await buildServer();
const fixtureRoot = join(tmpdir(), `agent-cluster-workspace-index-first-${process.pid}`);
let server;

try {
  rmSync(fixtureRoot, { recursive: true, force: true });
  mkdirSync(join(fixtureRoot, 'src'), { recursive: true });
  for (let index = 0; index < 500; index += 1) {
    writeFileSync(join(fixtureRoot, 'src', `file-${index}.ts`), `export const value${index} = ${index};\n`);
  }
  server = await startSmokeServer('workspace-index-first-smoke', {
    DISCUSSION_MAX_ROUNDS: '0',
    GLOBAL_DEFAULT_RUNTIME_TYPE: 'mock'
  });
  const workingDirectory = {
    kind: 'server_local', id: 'client-placeholder', name: 'workspace-index-first',
    path: fixtureRoot, selectedAt: new Date().toISOString()
  };
  const startedAt = performance.now();
  const created = await api(server.apiBase, '/sessions', {
    method: 'POST',
    body: JSON.stringify({ input: 'Analyze the selected project', workingDirectory })
  });
  const durationMs = performance.now() - startedAt;
  const session = created.data.session;

  if (durationMs >= 1_000) throw new Error(`Session create exceeded 1s: ${durationMs}ms`);
  if (session.workspaceSnapshot !== undefined) throw new Error('Session create synchronously returned a legacy workspaceSnapshot.');
  if (session.workspaceContext?.binding?.providerKind !== 'server_local') {
    throw new Error(`Missing lightweight server workspace binding: ${JSON.stringify(session.workspaceContext)}`);
  }
  if (created.data.firstEvent?.type !== 'user_message') {
    throw new Error(`Session create did not return the first user event: ${JSON.stringify(created.data)}`);
  }

  const conflict = await fetch(`${server.apiBase}/sessions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input: 'Competing task', workingDirectory })
  });
  const conflictBody = await conflict.json();
  if (
    conflict.status !== 409 ||
    conflictBody.error?.code !== 'WORKSPACE_ACTIVE_SESSION_CONFLICT' ||
    conflictBody.error?.details?.activeSessionId !== session.id
  ) {
    throw new Error(`Expected structured active Session conflict: ${conflict.status} ${JSON.stringify(conflictBody)}`);
  }

  console.log(`workspace index first smoke ok (${durationMs.toFixed(2)}ms)`);
} finally {
  if (server) await stopSmokeServer(server);
  rmSync(fixtureRoot, { recursive: true, force: true });
}
