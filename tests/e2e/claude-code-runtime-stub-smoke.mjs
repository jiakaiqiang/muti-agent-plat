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
  workspaceRoot = await mkdtemp(join(tmpdir(), 'agent-cluster-claude-stub-'));
  await mkdir(join(workspaceRoot, 'src'), { recursive: true });
  await writeFile(join(workspaceRoot, 'package.json'), JSON.stringify({ scripts: { test: 'node test-smoke.mjs' } }, null, 2));
  await writeFile(join(workspaceRoot, 'src', 'feature.txt'), 'before\n');
  await writeFile(join(workspaceRoot, 'test-smoke.mjs'), "console.log('stub tests passed');\n");

  const stubScript = join(workspaceRoot, 'claude-stub.mjs');
  const stubCommand = join(workspaceRoot, process.platform === 'win32' ? 'claude-stub.cmd' : 'claude-stub.sh');
  await writeFile(
    stubScript,
    [
      "import { existsSync, mkdirSync, writeFileSync } from 'node:fs';",
      "const marker = '.claude-stub-accepted';",
      "if (!existsSync(marker)) {",
      "writeFileSync(marker, 'accepted\\n');",
      'console.log(JSON.stringify({',
      "  kind: 'task_claim_decision',",
      '  accepted: true,',
      "  reason: 'Claude stub accepts the task.',",
      '  confidence: 0.91',
      '}));',
      '} else {',
      "mkdirSync('src', { recursive: true });",
      "writeFileSync('src/feature.txt', 'after from claude stub\\n');",
      "writeFileSync('src/generated.txt', 'created by claude stub\\n');",
      'console.log(JSON.stringify({',
      "  kind: 'task_execution_result',",
      "  status: 'completed',",
      "  summary: 'Claude stub edited real files on disk.',",
      "  completedItems: ['Stub changed files'],",
      '  changedArtifacts: [],',
      "  nextSuggestedActions: ['Inspect captured fileChanges'],",
      '  risks: []',
      '}));',
      '}'
    ].join('\n')
  );
  if (process.platform === 'win32') {
    await writeFile(stubCommand, `@echo off\r\nnode "%~dp0claude-stub.mjs" %*\r\n`);
  } else {
    await writeFile(stubCommand, `#!/bin/sh\nnode "$(dirname "$0")/claude-stub.mjs" "$@"\n`);
  }

  server = await startSmokeServer('claude-code-runtime-stub-smoke', {
    DISCUSSION_MAX_ROUNDS: '0',
    CLAUDE_CODE_ENABLED: 'true',
    CLAUDE_CODE_COMMAND: stubCommand,
    CLAUDE_CODE_PROMPT_MODE: 'file',
    CLAUDE_CODE_TEST_COMMAND: 'npm test'
  });

  await api(server.apiBase, '/agents/backend', {
    method: 'PATCH',
    body: JSON.stringify({ runtimeType: 'claude_code' })
  });

  const { sessionId, briefId } = await createSessionAndWaitForBrief(
    server.apiBase,
    `Use Claude Code to update files in ${workspaceRoot}`
  );
  await api(server.apiBase, `/sessions/${sessionId}/briefs/${briefId}/confirm`, { method: 'POST' });
  await waitForStatus(server.apiBase, sessionId, 'COMPLETED', 60_000);

  const events = await listEvents(server.apiBase, sessionId);
  const claudeRuntimeCompleted = events.find(
    (event) => event.type === 'runtime_completed' && event.metadata.payload?.runtimeType === 'claude_code'
  );
  if (!claudeRuntimeCompleted?.taskId) {
    throw new Error('Expected the backend execution task to complete through claude_code runtime.');
  }

  const updated = await readFile(join(workspaceRoot, 'src', 'feature.txt'), 'utf8').catch(() => '');
  const created = await readFile(join(workspaceRoot, 'src', 'generated.txt'), 'utf8').catch(() => '');
  if (!updated.includes('after from claude stub') || !created.includes('created by claude stub')) {
    throw new Error(
      `Claude Code stub must make real filesystem edits. Events: ${JSON.stringify(
        events.map((event) => ({
          type: event.type,
          taskId: event.taskId,
          fromAgentId: event.fromAgentId,
          content: event.content,
          payload: event.metadata.payload
        })),
        null,
        2
      )}`
    );
  }

  const taskArtifact = events.find(
    (event) =>
      event.type === 'artifact_created' &&
      event.taskId === claudeRuntimeCompleted.taskId &&
      event.metadata.payload?.fileChanges?.some((change) => change.path === 'src/feature.txt')
  );
  if (!taskArtifact) {
    throw new Error('Expected task artifact to include captured actual fileChanges from Claude Code runtime.');
  }

  const fileChanges = taskArtifact.metadata.payload.fileChanges;
  if (
    !fileChanges.some(
      (change) =>
        change.path === 'src/feature.txt' &&
        change.operation === 'update' &&
        change.source === 'actual_filesystem_snapshot' &&
        change.content?.includes('after from claude stub')
    )
  ) {
    throw new Error('Expected update fileChange for src/feature.txt.');
  }
  if (
    !fileChanges.some(
      (change) =>
        change.path === 'src/generated.txt' &&
        change.operation === 'create' &&
        change.source === 'actual_filesystem_snapshot' &&
        change.content?.includes('created by claude stub')
    )
  ) {
    throw new Error('Expected create fileChange for src/generated.txt.');
  }
  const testReport = events.find(
    (event) =>
      event.type === 'artifact_created' &&
      event.metadata.payload?.title?.includes('执行结果') &&
      event.metadata.payload?.contentSummary?.includes('Claude stub edited real files')
  );
  if (!testReport) {
    throw new Error('Expected Claude Code execution artifact to remain visible after test command capture.');
  }

  console.log('claude code runtime stub smoke ok');
} finally {
  if (server) {
    await stopSmokeServer(server);
  }
  if (workspaceRoot) {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}
