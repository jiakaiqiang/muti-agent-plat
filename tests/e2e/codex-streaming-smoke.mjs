import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import {
  api,
  buildServer,
  createSessionAndWaitForBrief,
  listEvents,
  startSmokeServer,
  stopSmokeServer,
  waitForMatchingEvent,
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
const execFile = promisify(execFileCallback);

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
    CLAUDE_CODE_ENABLED: 'false',
    CODEX_RUNTIME_COMMAND: process.execPath,
    CODEX_RUNTIME_ARGS_JSON: JSON.stringify([stubPath]),
    CODEX_RUNTIME_SHELL: 'false',
    RUNTIME_STREAMING: 'codex',
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

  const agents = (await api(server.apiBase, '/agents')).data;
  const backend = agents.find((agent) => agent.key === 'backend');
  if (!backend) throw new Error('Codex streaming smoke requires the backend Agent.');
  const draft = (await api(server.apiBase, '/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Codex streaming smoke workflow',
      nodes: [{ id: 'codex-streaming-node', type: 'agent', agentId: backend.id, order: 0 }]
    })
  })).data;
  const workflow = (await api(server.apiBase, `/workflows/${draft.id}/publish`, {
    method: 'POST',
    body: JSON.stringify({ expectedDraftRevision: draft.draftRevision })
  })).data;

  const { sessionId, briefId } = await createSessionAndWaitForBrief(
    server.apiBase,
    `Use Codex streaming in ${workspaceRoot}`,
    { runtimePreference: { preferredRuntimeType: 'codex', allowedRuntimeTypes: ['codex'] } }
  );
  await api(server.apiBase, `/sessions/${sessionId}/briefs/${briefId}/confirm`, { method: 'POST' });
  await waitForStatus(server.apiBase, sessionId, 'WAIT_WORKFLOW_SELECT');
  const selection = await waitForMatchingEvent(
    server.apiBase,
    sessionId,
    'user_confirmation_requested',
    (event) => event.metadata.payload.reason === 'select_workflow'
  );
  await execFile('git', ['init'], { cwd: workspaceRoot });
  await execFile('git', ['config', 'user.email', 'codex-smoke@example.invalid'], { cwd: workspaceRoot });
  await execFile('git', ['config', 'user.name', 'Codex Smoke'], { cwd: workspaceRoot });
  await execFile('git', ['add', '.'], { cwd: workspaceRoot });
  await execFile('git', ['commit', '-m', 'initial fixture'], { cwd: workspaceRoot });
  await api(server.apiBase, `/sessions/${sessionId}/workflow/select`, {
    method: 'POST',
    body: JSON.stringify({
      workflowId: workflow.id,
      workflowVersion: workflow.currentPublishedVersion,
      confirmationId: selection.metadata.payload.confirmationId
    })
  });
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
  const leakedInternalNotification = events.find(
    (event) =>
      event.metadata?.payload?.code === 'STREAM_TEXT' ||
      event.metadata?.payload?.code === 'STREAM_SYSTEM' ||
      ['thread/started', 'remoteControl/status/changed', 'mcpServer/startupStatus/updated'].includes(event.content)
  );
  if (leakedInternalNotification) {
    throw new Error(`Internal Codex notification leaked into the timeline: ${JSON.stringify(leakedInternalNotification)}`);
  }

  const invocations = (await api(
    server.apiBase,
    `/sessions/${sessionId}/debug/runtime-invocations`
  )).data.items;
  const audited = invocations.find(
    (item) =>
      item.outputContract?.contractId === 'runtime.output.task_execution_result' &&
      item.runtimeDiagnostics?.providerNotifications?.some(
        (notification) => notification.method === 'thread/started'
      )
  );
  if (!audited) throw new Error('Codex internal notifications were not retained in invocation diagnostics.');
  if (
    audited.outputContract?.contractId !== 'runtime.output.task_execution_result' ||
    audited.outputContract?.contractVersion !== '1.0' ||
    !/^fnv1a32:[0-9a-f]{8}$/.test(audited.outputContract?.schemaHash ?? '')
  ) {
    throw new Error(`Runtime contract audit is incomplete: ${JSON.stringify(audited.outputContract)}`);
  }

  console.log('codex streaming smoke ok');
} finally {
  if (server) await stopSmokeServer(server);
  if (workspaceRoot) await rm(workspaceRoot, { recursive: true, force: true });
}
