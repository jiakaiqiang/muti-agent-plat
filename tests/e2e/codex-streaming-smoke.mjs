import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  api,
  buildServer,
  createSessionAndWaitForBrief,
  listEvents,
  startSmokeServer,
  stopSmokeServer,
  waitForStatus
} from './smoke-server.mjs';

/**
 * M1-17 · codex 流式端到端 smoke。
 * - env=codex → CodexAdapter 走 startCodexStreaming
 * - stub 来自 tests/e2e/fixtures/codex-appserver-stub.mjs(JSON-RPC 2.0)
 * - 验证:tool_called/tool_completed/artifact_created 中至少一类事件出现,
 *   runtime_completed 存在,status=COMPLETED。
 */

await buildServer();

const __dirname = dirname(fileURLToPath(import.meta.url));
const stubPath = join(__dirname, 'fixtures', 'codex-appserver-stub.mjs');

let server;
let workspaceRoot;

try {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'agent-cluster-codex-streaming-'));
  await mkdir(join(workspaceRoot, 'src'), { recursive: true });
  await writeFile(
    join(workspaceRoot, 'package.json'),
    JSON.stringify({ name: 'stub', scripts: { test: "node -e \"console.log('ok')\"" } }, null, 2)
  );

  server = await startSmokeServer('codex-streaming-smoke', {
    DISCUSSION_MAX_ROUNDS: '0',
    REQUIRE_USER_CONFIRMATION: 'false',
    CODEX_RUNTIME_ENABLED: 'true',
    CODEX_RUNTIME_COMMAND: process.execPath,
    CODEX_RUNTIME_ARGS_JSON: JSON.stringify([stubPath]),
    CODEX_RUNTIME_SHELL: 'false',
    ENGINEERING_RUNTIME_STREAMING: 'codex',
    STUB_KIND: 'task_execution_result'
  });

  await api(server.apiBase, '/agents/backend', {
    method: 'PATCH',
    body: JSON.stringify({ runtimeType: 'codex' })
  });
  await api(server.apiBase, '/agents/test', {
    method: 'PATCH',
    body: JSON.stringify({ runtimeType: 'mock' })
  });
  await api(server.apiBase, '/agents/review', {
    method: 'PATCH',
    body: JSON.stringify({ runtimeType: 'mock' })
  });

  const { sessionId, briefId } = await createSessionAndWaitForBrief(
    server.apiBase,
    `Use Codex streaming in ${workspaceRoot}`
  );
  await api(server.apiBase, `/sessions/${sessionId}/briefs/${briefId}/confirm`, { method: 'POST' });
  await waitForStatus(server.apiBase, sessionId, 'COMPLETED', 60_000);

  const events = await listEvents(server.apiBase, sessionId);
  const runtimeCompleted = events.find(
    (e) => e.type === 'runtime_completed' && e.metadata?.payload?.runtimeType === 'codex'
  );
  if (!runtimeCompleted) {
    throw new Error('Expected a runtime_completed event from streaming Codex adapter.');
  }
  const toolEvents = events.filter((e) => e.type === 'tool_called' || e.type === 'tool_completed');
  if (toolEvents.length === 0) {
    throw new Error('Expected at least one tool_called/tool_completed event from stream.');
  }
  const heartbeat = events.find(
    (e) => e.metadata?.payload?.code === 'RUNTIME_HEARTBEAT'
  );
  if (heartbeat) {
    throw new Error('Streaming path must not emit RUNTIME_HEARTBEAT events.');
  }

  console.log('codex streaming smoke ok');
} finally {
  if (server) await stopSmokeServer(server);
  if (workspaceRoot) await rm(workspaceRoot, { recursive: true, force: true });
}
