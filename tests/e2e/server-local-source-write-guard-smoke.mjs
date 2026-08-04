import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
  worktreeRoot = join(tmpdir(), `ac-wt-sg-${process.pid}-${Date.now()}`);
  workspaceRoot = await mkdtemp(join(tmpdir(), 'agent-cluster-source-guard-'));
  await mkdir(join(workspaceRoot, 'src'), { recursive: true });
  await writeFile(join(workspaceRoot, 'package.json'), JSON.stringify({ scripts: { test: 'node test-smoke.mjs' } }, null, 2));
  await writeFile(join(workspaceRoot, 'src', 'feature.txt'), 'original source\n');
  await writeFile(join(workspaceRoot, 'test-smoke.mjs'), "console.log('guard tests passed');\n");
  await execFile('git', ['init'], { cwd: workspaceRoot });
  await execFile('git', ['config', 'user.email', 'source-guard@example.invalid'], { cwd: workspaceRoot });
  await execFile('git', ['config', 'user.name', 'Source Guard'], { cwd: workspaceRoot });
  await execFile('git', ['add', '.'], { cwd: workspaceRoot });
  await execFile('git', ['commit', '-m', 'initial fixture'], { cwd: workspaceRoot });

  server = await startSmokeServer('server-local-source-write-guard-smoke', {
    DISCUSSION_MAX_ROUNDS: '0',
    REQUIRE_USER_CONFIRMATION: 'false',
    CODEX_RUNTIME_ENABLED: 'true',
    CODEX_RUNTIME_COMMAND: process.execPath,
    CODEX_RUNTIME_ARGS_JSON: JSON.stringify([join(process.cwd(), 'tests', 'e2e', 'fixtures', 'codex-appserver-stub.mjs')]),
    CODEX_RUNTIME_SHELL: 'false',
    CODEX_RUNTIME_TEST_COMMAND: 'npm test',
    RUNTIME_STREAMING: 'codex',
    CODEX_RUNTIME_STUB_EDIT_FILES: 'codex',
    STUB_FIRST_DELAY_MS: '1200',
    AGENT_CLUSTER_WORKTREE_ROOT: worktreeRoot
  });

  await api(server.apiBase, '/agents/backend', {
    method: 'PATCH',
    body: JSON.stringify({ runtimeType: 'codex' })
  });

  const agents = (await api(server.apiBase, '/agents')).data;
  const backend = agents.find((agent) => agent.key === 'backend');
  if (!backend) throw new Error('Source write guard smoke requires the backend Agent.');
  const draft = (await api(server.apiBase, '/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Server-local source write guard workflow',
      nodes: [{ id: 'source-guard-node', type: 'agent', agentId: backend.id, order: 0 }]
    })
  })).data;
  const workflow = (await api(server.apiBase, `/workflows/${draft.id}/publish`, {
    method: 'POST',
    body: JSON.stringify({ expectedDraftRevision: draft.draftRevision })
  })).data;

  const { sessionId, briefId } = await createSessionAndWaitForBrief(
    server.apiBase,
    `Generate concrete source updates in ${workspaceRoot}`,
    {
      workingDirectory: {
        kind: 'server_local',
        id: workspaceRoot,
        name: 'source-guard-workspace',
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
    (event) => event.metadata.payload?.reason === 'select_workflow'
  );
  await api(server.apiBase, `/sessions/${sessionId}/workflow/select`, {
    method: 'POST',
    body: JSON.stringify({
      workflowId: workflow.id,
      workflowVersion: workflow.currentPublishedVersion,
      confirmationId: workflowSelection.metadata.payload.confirmationId
    })
  });
  await waitForStatus(server.apiBase, sessionId, 'EXECUTING', 60_000);
  const sourceDuringExecution = await readFile(join(workspaceRoot, 'src', 'feature.txt'), 'utf8');
  if (sourceDuringExecution !== 'original source\n') {
    throw new Error(`Runtime must not directly overwrite server-local source files. Got: ${sourceDuringExecution}`);
  }
  await waitForStatus(server.apiBase, sessionId, 'COMPLETED', 60_000);

  const events = await listEvents(server.apiBase, sessionId);
  const sourceFile = await readFile(join(workspaceRoot, 'src', 'feature.txt'), 'utf8');
  if (sourceFile !== 'after from codex stub\n') {
    throw new Error(`Platform writeback must apply the isolated update after execution. Got: ${sourceFile}`);
  }
  await stat(join(workspaceRoot, 'src', 'generated-by-codex.txt'));

  const session = (await api(server.apiBase, `/sessions/${sessionId}`)).data;
  const writeback = session.workspaceWritebacks?.at(-1);
  if (writeback?.status !== 'applied') {
    throw new Error(`Expected an applied workspace writeback record. Got: ${JSON.stringify(writeback)}`);
  }

  const observedSourceChange = events
    .filter((event) => event.type === 'artifact_created')
    .flatMap((event) => event.metadata.payload?.systemEvidence?.workspaceChangeSet?.changes ?? [])
    .find((change) => change.path === 'src/feature.txt' && change.operation === 'update');
  if (!observedSourceChange?.content?.includes('after from codex stub')) {
    throw new Error('Expected the managed Codex worktree update only in authoritative systemEvidence.');
  }
  const incorrectlyPromoted = events
    .filter((event) => event.type === 'artifact_created')
    .flatMap((event) => event.metadata.payload?.platformProjections ?? [])
    .find((change) => change.path === 'src/feature.txt');
  if (incorrectlyPromoted) {
    throw new Error('Observed Runtime source changes must not be promoted into platform projections.');
  }

  await stat(join(workspaceRoot, 'agent-output', 'final-delivery.md'));

  console.log('server local isolated execution and automatic writeback smoke ok');
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

process.exit(0);
