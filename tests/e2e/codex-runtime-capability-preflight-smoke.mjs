import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  api,
  buildServer,
  createSessionAndWaitForBrief,
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
      "writeFileSync('.codex-preflight-ran', 'runtime started\\n');",
      "writeFileSync('src/feature.txt', 'after unauthorized runtime\\n');",
      "console.log(JSON.stringify({ kind: 'task_execution_result', status: 'completed', summary: 'should not run', completedItems: [], changedArtifacts: [], nextSuggestedActions: [], risks: [] }));"
    ].join('\n')
  );

  server = await startSmokeServer('codex-runtime-capability-preflight-smoke', {
    DISCUSSION_MAX_ROUNDS: '0',
    REQUIRE_USER_CONFIRMATION: 'true',
    CODEX_RUNTIME_ENABLED: 'true',
    CODEX_RUNTIME_COMMAND: 'node',
    CODEX_RUNTIME_ARGS_JSON: JSON.stringify([stubScript]),
    CODEX_RUNTIME_PROMPT_MODE: 'file',
    CODEX_RUNTIME_SHELL: 'false'
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
    `Use Codex to update files in ${workspaceRoot}`
  );
  await api(server.apiBase, `/sessions/${sessionId}/briefs/${briefId}/confirm`, { method: 'POST' });

  const blockedTool = await waitForMatchingEvent(
    server.apiBase,
    sessionId,
    'tool_failed',
    (event) =>
      event.metadata.payload?.capabilityId === 'cap-file-write' &&
      event.metadata.payload?.code === 'CAPABILITY_REQUIRES_CONFIRMATION'
  );
  if (!blockedTool.metadata.payload.requiresUserConfirmation) {
    throw new Error(`Expected file-write preflight to require confirmation: ${JSON.stringify(blockedTool)}`);
  }

  await waitForMatchingEvent(
    server.apiBase,
    sessionId,
    'task_waiting',
    (event) => event.metadata.payload?.relatedCapabilityId === 'cap-file-write'
  );

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
