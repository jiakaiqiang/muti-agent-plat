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

  const second = await api(server.apiBase, '/sessions', {
    method: 'POST',
    body: JSON.stringify({ input: 'Parallel task in the same directory', workingDirectory })
  });
  if (second.data.session.id === session.id || second.data.session.workspaceId !== session.workspaceId) {
    throw new Error(`Expected an independent Session bound to the same workspace: ${JSON.stringify(second.data)}`);
  }

  console.log(`workspace index first smoke ok (${durationMs.toFixed(2)}ms)`);
} finally {
  if (server) await stopSmokeServer(server);
  rmSync(fixtureRoot, { recursive: true, force: true });
}
