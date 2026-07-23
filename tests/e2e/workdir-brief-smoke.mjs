import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { execFile as execFileCallback } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  buildServer,
  confirmBriefAndSelectWorkflow,
  createPublishedAgentWorkflow,
  createSessionAndWaitForBrief,
  listEvents,
  startSmokeServer,
  stopSmokeServer,
  waitForStatus
} from './smoke-server.mjs';

await buildServer();
const __dirname = dirname(fileURLToPath(import.meta.url));
const stubPath = join(__dirname, 'fixtures', 'codex-appserver-stub.mjs');
const execFile = promisify(execFileCallback);
let server;
let root;
let worktreeRoot;

async function findManifest(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const found = await findManifest(path);
      if (found) return found;
    } else if (entry.name === 'backup-manifest.json') return path;
  }
}

try {
  root = await mkdtemp(join(tmpdir(), 'agent-cluster-workdir-brief-'));
  worktreeRoot = join(tmpdir(), `ac-wt-b-${process.pid}-${Date.now()}`);
  const workspace = join(root, 'workspace');
  const staging = join(root, 'staging');
  await mkdir(workspace, { recursive: true });
  const original = '# Existing instructions\r\nkeep exactly\r\n';
  await writeFile(join(workspace, 'AGENTS.md'), original, 'utf8');
  await execFile('git', ['init'], { cwd: workspace });
  await execFile('git', ['config', 'user.email', 'workdir-brief@example.invalid'], { cwd: workspace });
  await execFile('git', ['config', 'user.name', 'Workdir Brief'], { cwd: workspace });
  await execFile('git', ['add', '.'], { cwd: workspace });
  await execFile('git', ['commit', '-m', 'initial fixture'], { cwd: workspace });
  server = await startSmokeServer('workdir-brief-smoke', {
    DISCUSSION_MAX_ROUNDS: '0', REQUIRE_USER_CONFIRMATION: 'false', CODEX_RUNTIME_ENABLED: 'true',
    CODEX_RUNTIME_COMMAND: process.execPath, CODEX_RUNTIME_ARGS_JSON: JSON.stringify([stubPath]),
    CODEX_RUNTIME_SHELL: 'false', RUNTIME_STREAMING: 'codex', STUB_KIND: 'task_execution_result',
    AGENT_CLUSTER_BRIEF_STAGING_DIR: staging, AGENT_CLUSTER_WORKTREE_ROOT: worktreeRoot
  });
  const workflow = await createPublishedAgentWorkflow(server.apiBase, 'Workdir brief workflow', ['backend']);
  const { sessionId, briefId } = await createSessionAndWaitForBrief(
    server.apiBase,
    `Implement safely in ${workspace}`,
    {
      workingDirectory: {
        kind: 'server_local',
        id: workspace,
        name: 'workdir-brief-workspace',
        path: workspace,
        selectedAt: new Date().toISOString()
      },
      runtimePreference: { preferredRuntimeType: 'codex', allowedRuntimeTypes: ['codex'] }
    }
  );
  await confirmBriefAndSelectWorkflow(server.apiBase, sessionId, briefId, workflow);
  await waitForStatus(server.apiBase, sessionId, 'COMPLETED', 60_000);
  const events = await listEvents(server.apiBase, sessionId);
  if (!events.some((event) => event.type === 'runtime_completed' && event.metadata.payload?.runtimeType === 'codex')) {
    throw new Error('Expected workdir brief smoke to execute through Codex runtime.');
  }
  if ((await readFile(join(workspace, 'AGENTS.md'), 'utf8')) !== original) throw new Error('AGENTS.md was not restored exactly.');
  const manifestPath = await findManifest(staging);
  const manifest = manifestPath ? JSON.parse(await readFile(manifestPath, 'utf8')) : undefined;
  if (manifest?.status !== 'restored') throw new Error('Expected restored workdir brief manifest.');
  console.log('workdir brief smoke ok');
} finally {
  if (server) await stopSmokeServer(server);
  if (root) await rm(root, { recursive: true, force: true });
  if (worktreeRoot) await rm(worktreeRoot, { recursive: true, force: true });
}
