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
  worktreeRoot = join(tmpdir(), `ac-wt-c-${process.pid}-${Date.now()}`);
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
      "    schemaVersion: '1.0',",
      "    kind: 'task_acceptance_decision',",
      "    status: 'accepted',",
      "    reason: 'Codex stub accepts the task.',",
      '    missingContext: [],',
      '    requestedContext: null,',
      '    handoffSuggestion: null,',
      '    confidence: 0.91,',
      '    alternativeAgentKeys: [],',
      '    alternativeAgentIds: [],',
      '    agentMessages: []',
      '  }));',
      '} else {',
      "  mkdirSync('src', { recursive: true });",
      "  writeFileSync('src/feature.txt', 'after from codex stub\\n');",
      "  writeFileSync('src/generated-by-codex.txt', 'created by codex stub\\n');",
      '  console.log(JSON.stringify({',
      "    schemaVersion: '1.0',",
      "    kind: 'task_execution_result',",
      "    status: 'completed',",
      "    summary: 'Codex stub edited real files on disk.',",
      "    completedItems: ['Stub changed files'],",
      '    changedArtifacts: [],',
      '    requestedContext: null,',
      '    agentMessages: [],',
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
  await execFile('git', ['init'], { cwd: workspaceRoot });
  await execFile('git', ['config', 'user.email', 'codex-stub@example.invalid'], { cwd: workspaceRoot });
  await execFile('git', ['config', 'user.name', 'Codex Stub'], { cwd: workspaceRoot });
  await execFile('git', ['add', '.'], { cwd: workspaceRoot });
  await execFile('git', ['commit', '-m', 'initial fixture'], { cwd: workspaceRoot });

  server = await startSmokeServer('codex-runtime-stub-smoke', {
    DISCUSSION_MAX_ROUNDS: '0',
    REQUIRE_USER_CONFIRMATION: 'false',
    CODEX_RUNTIME_ENABLED: 'true',
    CODEX_RUNTIME_COMMAND: process.execPath,
    CODEX_RUNTIME_ARGS_JSON: JSON.stringify([join(process.cwd(), 'tests', 'e2e', 'fixtures', 'codex-appserver-stub.mjs')]),
    CODEX_RUNTIME_SHELL: 'false',
    CODEX_RUNTIME_TEST_COMMAND: 'npm test',
    RUNTIME_STREAMING: 'codex',
    STUB_EDIT_FILES: 'codex',
    AGENT_CLUSTER_WORKTREE_ROOT: worktreeRoot
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
  if (!backend) throw new Error('Codex stub smoke requires the backend Agent.');
  const draft = (await api(server.apiBase, '/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Codex runtime stub workflow',
      nodes: [{ id: 'codex-runtime-stub-node', type: 'agent', agentId: backend.id, order: 0 }]
    })
  })).data;
  const workflow = (await api(server.apiBase, `/workflows/${draft.id}/publish`, {
    method: 'POST',
    body: JSON.stringify({ expectedDraftRevision: draft.draftRevision })
  })).data;

  const { sessionId, briefId } = await createSessionAndWaitForBrief(
    server.apiBase,
    `Use Codex to update files in ${workspaceRoot}`,
    {
      workingDirectory: {
        kind: 'server_local',
        id: workspaceRoot,
        name: 'codex-stub-workspace',
        path: workspaceRoot,
        selectedAt: new Date().toISOString()
      },
      runtimePreference: { preferredRuntimeType: 'codex', allowedRuntimeTypes: ['codex'] }
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
  const codexRuntimeCompleted = events.find(
    (event) => event.type === 'runtime_completed' && event.metadata.payload?.runtimeType === 'codex'
  );
  if (!codexRuntimeCompleted?.taskId) {
    throw new Error('Expected the backend execution task to complete through codex runtime.');
  }

  const updated = await readFile(join(workspaceRoot, 'src', 'feature.txt'), 'utf8').catch(() => '');
  const created = await readFile(join(workspaceRoot, 'src', 'generated-by-codex.txt'), 'utf8').catch(() => '');
  if (updated !== 'before\n' || created) {
    throw new Error('Managed Codex worktree must not directly mutate the selected source workspace.');
  }

  const acceptanceDecision = events.find(
    (event) =>
      event.type === 'agent_message' &&
      event.metadata.payload?.phase === 'task_acceptance_decision' &&
      event.metadata.payload?.acceptanceDecision?.status === 'accepted'
  );
  if (!acceptanceDecision) {
    throw new Error('Expected Codex runtime to participate in task acceptance decision.');
  }

  const taskArtifact = events.find(
    (event) =>
      event.type === 'artifact_created' &&
      event.taskId === codexRuntimeCompleted.taskId &&
      event.metadata.payload?.systemEvidence?.workspaceChangeSet?.changes?.some(
        (change) => change.path === 'src/feature.txt'
      )
  );
  if (!taskArtifact) {
    throw new Error(
      `Expected task artifact to include captured actual fileChanges from Codex runtime. Artifacts: ${JSON.stringify(
        events
          .filter((event) => event.type === 'artifact_created')
          .map((event) => ({
            taskId: event.taskId,
            title: event.metadata.payload?.title,
            observedChanges: (event.metadata.payload?.systemEvidence?.workspaceChangeSet?.changes ?? []).map((change) => ({
              path: change.path,
              operation: change.operation
            }))
          })),
        null,
        2
      )}`
    );
  }

  const fileChanges = taskArtifact.metadata.payload.systemEvidence.workspaceChangeSet.changes;
  if (
    !fileChanges.some(
      (change) =>
        change.path === 'src/feature.txt' &&
        change.operation === 'update' &&
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
  if (worktreeRoot) {
    await rm(worktreeRoot, { recursive: true, force: true });
  }
}
