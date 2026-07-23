import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

await buildServer();
const execFile = promisify(execFileCallback);

let server;
let workspaceRoot;
let worktreeRoot;

try {
  worktreeRoot = join(tmpdir(), `ac-wt-cl-${process.pid}-${Date.now()}`);
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
      "  schemaVersion: '1.0',",
      "  kind: 'task_acceptance_decision',",
      "  status: 'accepted',",
      "  reason: 'Claude stub accepts the task.',",
      '  missingContext: [],',
      '  requestedContext: null,',
      '  handoffSuggestion: null,',
      '  confidence: 0.91,',
      '  alternativeAgentKeys: [],',
      '  alternativeAgentIds: [],',
      '  agentMessages: []',
      '}));',
      '} else {',
      "mkdirSync('src', { recursive: true });",
      "writeFileSync('src/feature.txt', 'after from claude stub\\n');",
      "writeFileSync('src/generated.txt', 'created by claude stub\\n');",
      'console.log(JSON.stringify({',
      "  schemaVersion: '1.0',",
      "  kind: 'task_execution_result',",
      "  status: 'completed',",
      "  summary: 'Claude stub edited real files on disk.',",
      "  completedItems: ['Stub changed files'],",
      '  changedArtifacts: [],',
      '  requestedContext: null,',
      '  agentMessages: [],',
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
  await execFile('git', ['init'], { cwd: workspaceRoot });
  await execFile('git', ['config', 'user.email', 'claude-stub@example.invalid'], { cwd: workspaceRoot });
  await execFile('git', ['config', 'user.name', 'Claude Stub'], { cwd: workspaceRoot });
  await execFile('git', ['add', '.'], { cwd: workspaceRoot });
  await execFile('git', ['commit', '-m', 'initial fixture'], { cwd: workspaceRoot });

  server = await startSmokeServer('claude-code-runtime-stub-smoke', {
    DISCUSSION_MAX_ROUNDS: '0',
    REQUIRE_USER_CONFIRMATION: 'false',
    CLAUDE_CODE_ENABLED: 'true',
    CLAUDE_CODE_COMMAND: process.execPath,
    CLAUDE_CODE_ARGS_JSON: JSON.stringify([join(process.cwd(), 'tests', 'e2e', 'fixtures', 'claude-stream-json-stub.mjs')]),
    CLAUDE_CODE_TEST_COMMAND: 'npm test',
    RUNTIME_STREAMING: 'all',
    STUB_EDIT_FILES: 'claude',
    STUB_SKIP_CONTROL: '1',
    AGENT_CLUSTER_WORKTREE_ROOT: worktreeRoot
  });

  await api(server.apiBase, '/agents/backend', {
    method: 'PATCH',
    body: JSON.stringify({ runtimeType: 'claude_code' })
  });

  const agents = (await api(server.apiBase, '/agents')).data;
  const backend = agents.find((agent) => agent.key === 'backend');
  if (!backend) throw new Error('Claude stub smoke requires the backend Agent.');
  const draft = (await api(server.apiBase, '/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Claude runtime stub workflow',
      nodes: [{ id: 'claude-runtime-stub-node', type: 'agent', agentId: backend.id, order: 0 }]
    })
  })).data;
  const workflow = (await api(server.apiBase, `/workflows/${draft.id}/publish`, {
    method: 'POST',
    body: JSON.stringify({ expectedDraftRevision: draft.draftRevision })
  })).data;

  const { sessionId, briefId } = await createSessionAndWaitForBrief(
    server.apiBase,
    `Use Claude Code to update files in ${workspaceRoot}`,
    {
      workingDirectory: {
        kind: 'server_local',
        id: workspaceRoot,
        name: 'claude-stub-workspace',
        path: workspaceRoot,
        selectedAt: new Date().toISOString()
      },
      runtimePreference: { preferredRuntimeType: 'claude_code', allowedRuntimeTypes: ['claude_code'] }
    }
  );
  await api(server.apiBase, `/sessions/${sessionId}/briefs/${briefId}/confirm`, { method: 'POST' });
  await waitForStatus(server.apiBase, sessionId, 'WAIT_WORKFLOW_SELECT');
  const workflowSelection = await waitForMatchingEvent(
    server.apiBase,
    sessionId,
    'user_confirmation_requested',
    (event) => event.metadata.payload.reason === 'select_workflow'
  );
  await api(server.apiBase, `/sessions/${sessionId}/workflow/select`, {
    method: 'POST',
    body: JSON.stringify({
      workflowId: workflow.id,
      workflowVersion: workflow.currentPublishedVersion,
      confirmationId: workflowSelection.metadata.payload.confirmationId
    })
  });
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
  if (updated !== 'before\n' || created) {
    throw new Error(
      `Managed Claude worktree must not directly mutate the selected source workspace. Events: ${JSON.stringify(
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
      event.metadata.payload?.systemEvidence?.workspaceChangeSet?.changes?.some(
        (change) => change.path === 'src/feature.txt'
      )
  );
  if (!taskArtifact) {
    throw new Error('Expected task artifact to include captured actual fileChanges from Claude Code runtime.');
  }

  const fileChanges = taskArtifact.metadata.payload.systemEvidence.workspaceChangeSet.changes;
  if (
    !fileChanges.some(
      (change) =>
        change.path === 'src/feature.txt' &&
        change.operation === 'update' &&
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
        change.content?.includes('created by claude stub')
    )
  ) {
    throw new Error('Expected create fileChange for src/generated.txt.');
  }
  if (typeof taskArtifact.metadata.payload?.contentSummary !== 'string') {
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
  if (worktreeRoot) {
    await rm(worktreeRoot, { recursive: true, force: true });
  }
}
