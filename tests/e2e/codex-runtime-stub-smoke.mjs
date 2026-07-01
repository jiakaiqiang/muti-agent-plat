import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
let workspaceRoot;

try {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'agent-cluster-codex-stub-'));
  await mkdir(join(workspaceRoot, 'src'), { recursive: true });
  await writeFile(join(workspaceRoot, 'package.json'), JSON.stringify({ scripts: { test: 'node test-smoke.mjs' } }, null, 2));
  await writeFile(join(workspaceRoot, 'src', 'feature.txt'), 'before\n');
  await writeFile(join(workspaceRoot, 'test-smoke.mjs'), "console.log('codex stub tests passed');\n");

  const stubScript = join(workspaceRoot, 'codex-stub.mjs');
  const stubCommand = join(workspaceRoot, process.platform === 'win32' ? 'codex-stub.cmd' : 'codex-stub.sh');
  await writeFile(
    stubScript,
    [
      "import { existsSync, mkdirSync, writeFileSync } from 'node:fs';",
      "const marker = '.codex-stub-accepted';",
      "if (!existsSync(marker)) {",
      "  writeFileSync(marker, 'accepted\\n');",
      '  console.log(JSON.stringify({',
      "    kind: 'task_claim_decision',",
      '    accepted: true,',
      "    reason: 'Codex stub accepts the task.',",
      '    confidence: 0.91',
      '  }));',
      '} else {',
      "  mkdirSync('src', { recursive: true });",
      "  writeFileSync('src/feature.txt', 'after from codex stub\\n');",
      "  writeFileSync('src/generated-by-codex.txt', 'created by codex stub\\n');",
      '  console.log(JSON.stringify({',
      "    kind: 'task_execution_result',",
      "    status: 'completed',",
      "    summary: 'Codex stub edited real files on disk.',",
      "    completedItems: ['Stub changed files'],",
      '    changedArtifacts: [],',
      "    nextSuggestedActions: ['Inspect captured fileChanges'],",
      '    risks: []',
      '  }));',
      '}'
    ].join('\n')
  );
  if (process.platform === 'win32') {
    await writeFile(stubCommand, `@echo off\r\nnode "%~dp0codex-stub.mjs" %*\r\n`);
  } else {
    await writeFile(stubCommand, `#!/bin/sh\nnode "$(dirname "$0")/codex-stub.mjs" "$@"\n`);
  }

  server = await startSmokeServer('codex-runtime-stub-smoke', {
    DISCUSSION_MAX_ROUNDS: '0',
    REQUIRE_USER_CONFIRMATION: 'false',
    CODEX_RUNTIME_ENABLED: 'true',
    CODEX_RUNTIME_COMMAND: 'node',
    CODEX_RUNTIME_ARGS_JSON: JSON.stringify([stubScript]),
    CODEX_RUNTIME_PROMPT_MODE: 'file',
    CODEX_RUNTIME_SHELL: 'false',
    CODEX_RUNTIME_TEST_COMMAND: 'npm test'
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
  await waitForStatus(server.apiBase, sessionId, 'COMPLETED', 60_000);

  const events = await listEvents(server.apiBase, sessionId);
  const codexRuntimeCompleted = events.find(
    (event) => event.type === 'runtime_completed' && event.metadata.payload?.runtimeType === 'codex'
  );
  if (!codexRuntimeCompleted?.taskId) {
    throw new Error('Expected the backend execution task to complete through codex runtime.');
  }

  const updated = await readFile(join(workspaceRoot, 'src', 'feature.txt'), 'utf8').catch(() => '');
  const created = await readFile(join(workspaceRoot, 'src', 'generated-by-codex.txt'), 'utf8').catch(() => '');
  if (!updated.includes('after from codex stub') || !created.includes('created by codex stub')) {
    throw new Error('Codex stub must make real filesystem edits.');
  }

  const claimDecision = events.find(
    (event) =>
      event.type === 'agent_message' &&
      event.metadata.payload?.phase === 'task_acceptance_decision' &&
      event.metadata.payload?.acceptanceDecision?.status === 'accepted' &&
      event.metadata.payload?.claimDecision?.accepted === true
  );
  if (!claimDecision) {
    throw new Error('Expected Codex runtime to participate in task acceptance decision.');
  }

  const taskArtifact = events.find(
    (event) =>
      event.type === 'artifact_created' &&
      event.taskId === codexRuntimeCompleted.taskId &&
      event.metadata.payload?.fileChanges?.some((change) => change.path === 'src/feature.txt')
  );
  if (!taskArtifact) {
    throw new Error(
      `Expected task artifact to include captured actual fileChanges from Codex runtime. Artifacts: ${JSON.stringify(
        events
          .filter((event) => event.type === 'artifact_created')
          .map((event) => ({
            taskId: event.taskId,
            title: event.metadata.payload?.title,
            fileChanges: (event.metadata.payload?.fileChanges ?? []).map((change) => ({
              path: change.path,
              operation: change.operation,
              source: change.source
            }))
          })),
        null,
        2
      )}`
    );
  }

  const fileChanges = taskArtifact.metadata.payload.fileChanges;
  if (
    !fileChanges.some(
      (change) =>
        change.path === 'src/feature.txt' &&
        change.operation === 'update' &&
        change.source === 'actual_filesystem_snapshot' &&
        change.previousContent === 'before\n' &&
        change.content?.includes('after from codex stub')
    )
  ) {
    throw new Error('Expected update fileChange for src/feature.txt.');
  }
  if (
    !fileChanges.some(
      (change) =>
        change.path === 'src/generated-by-codex.txt' &&
        change.operation === 'create' &&
        change.source === 'actual_filesystem_snapshot' &&
        change.previousContent === null &&
        change.content?.includes('created by codex stub')
    )
  ) {
    throw new Error('Expected create fileChange for src/generated-by-codex.txt.');
  }

  console.log('codex runtime stub smoke ok');
} finally {
  if (server) {
    await stopSmokeServer(server);
  }
  if (workspaceRoot) {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}
