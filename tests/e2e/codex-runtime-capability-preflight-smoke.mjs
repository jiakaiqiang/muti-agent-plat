import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildServer,
  confirmBriefAndSelectWorkflow,
  createPublishedAgentWorkflow,
  createSessionAndWaitForBrief,
  listEvents,
  startSmokeServer,
  stopSmokeServer,
  waitForMatchingEvent
} from './smoke-server.mjs';

await buildServer();

let server;
let workspaceRoot;

try {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'agent-cluster-codex-preflight-'));
  await mkdir(join(workspaceRoot, 'src'), { recursive: true });
  await writeFile(join(workspaceRoot, 'src', 'feature.txt'), 'before preflight\n');
  await writeFile(join(workspaceRoot, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "console.log(1)"' } }, null, 2));

  const stubScript = join(workspaceRoot, 'codex-preflight-stub.mjs');
  await writeFile(
    stubScript,
    [
      "import { writeFileSync } from 'node:fs';",
      "const requiredKind = process.env.AGENT_CLUSTER_EXPECTED_OUTPUT_KIND ?? 'task_execution_result';",
      "if (requiredKind === 'task_brief') {",
      "  console.log(JSON.stringify({ schemaVersion: '1.0', kind: 'task_brief', goal: 'Verify Codex capability preflight.', scope: [], outOfScope: [], constraints: [], acceptanceCriteria: [], risks: [], openQuestions: [], suggestedTasks: [] }));",
      "} else {",
      "  writeFileSync('.codex-preflight-ran', 'runtime started\\n');",
      "  writeFileSync('src/feature.txt', 'after unauthorized runtime\\n');",
      "  console.log(JSON.stringify({ schemaVersion: '1.0', kind: 'task_execution_result', status: 'completed', summary: 'should not run', completedItems: [], changedArtifacts: [], requestedContext: null, agentMessages: [], nextSuggestedActions: [], risks: [] }));",
      "}"
    ].join('\n')
  );

  server = await startSmokeServer('codex-runtime-capability-preflight-smoke', {
    DISCUSSION_MAX_ROUNDS: '0',
    REQUIRE_USER_CONFIRMATION: 'true',
    CODEX_RUNTIME_ENABLED: 'true',
    CODEX_RUNTIME_COMMAND: 'node',
    CODEX_RUNTIME_ARGS_JSON: JSON.stringify([stubScript]),
    CODEX_RUNTIME_PROMPT_MODE: 'file',
    CODEX_RUNTIME_SHELL: 'false',
    RUNTIME_STREAMING: 'off'
  });

  const workflow = await createPublishedAgentWorkflow(
    server.apiBase,
    'Codex capability preflight workflow',
    ['backend']
  );

  const { sessionId, briefId } = await createSessionAndWaitForBrief(
    server.apiBase,
    `Use Codex to update files in ${workspaceRoot}`,
    {
      workingDirectory: {
        kind: 'server_local',
        id: workspaceRoot,
        name: 'codex-preflight-workspace',
        path: workspaceRoot,
        selectedAt: new Date().toISOString()
      },
      runtimePreference: { preferredRuntimeType: 'codex', allowedRuntimeTypes: ['codex'] }
    }
  );
  await confirmBriefAndSelectWorkflow(server.apiBase, sessionId, briefId, workflow);

  let blockedRuntime;
  try {
    blockedRuntime = await waitForMatchingEvent(
      server.apiBase,
      sessionId,
      'runtime_failed',
      (event) =>
        event.metadata.payload?.code === 'CAPABILITY_BLOCKED' &&
        event.metadata.payload?.message?.includes('tool.file_write')
    );
  } catch (error) {
    const events = await listEvents(server.apiBase, sessionId);
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nEvents: ${JSON.stringify(
        events.map((event) => ({ type: event.type, taskId: event.taskId, content: event.content, payload: event.metadata.payload })),
        null,
        2
      )}`
    );
  }
  if (blockedRuntime.metadata.payload.runtimeError?.retryable !== false) {
    throw new Error(`Expected blocked capability preflight to fail closed without retry: ${JSON.stringify(blockedRuntime)}`);
  }

  const events = await listEvents(server.apiBase, sessionId);
  const taskRuntimeStarted = events.find(
    (event) => event.type === 'runtime_started' && event.taskId === blockedRuntime.taskId
  );
  if (taskRuntimeStarted) {
    throw new Error(`Blocked task must not start its runtime: ${JSON.stringify(taskRuntimeStarted)}`);
  }

  const source = await readFile(join(workspaceRoot, 'src', 'feature.txt'), 'utf8');
  if (source !== 'before preflight\n') {
    throw new Error(`Codex runtime must not run before file-write approval. Got: ${source}`);
  }
  const marker = await readFile(join(workspaceRoot, '.codex-preflight-ran'), 'utf8').catch(() => '');
  if (marker) {
    throw new Error(`Codex stub should not have been executed before approval. Marker: ${marker}`);
  }

  console.log('codex runtime capability preflight smoke ok');
} finally {
  if (server) {
    await stopSmokeServer(server);
  }
  if (workspaceRoot) {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}
