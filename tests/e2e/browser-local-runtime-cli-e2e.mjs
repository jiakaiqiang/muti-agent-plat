import { spawn } from 'node:child_process';
import { readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile as execFileCallback } from 'node:child_process';
import {
  api,
  buildServer,
  createPublishedAgentWorkflow,
  listEvents,
  root,
  selectPublishedWorkflow,
  waitForStatus
} from './smoke-server.mjs';
import {
  runNpm,
  startBrowserPage,
  startBrowserSmokeServer,
  stopBrowserCollaborationSmoke
} from './browser-smoke-utils.mjs';

const execFile = promisify(execFileCallback);
const adminToken = 'local-runtime-e2e-administrator-token-2026';
const fixture = join(root, 'tests', 'e2e', 'fixtures', 'local-runtime-codex-stub.mjs');
const cliEntry = join(root, 'packages', 'local-runtime-cli', 'dist', 'local-runtime-cli', 'src', 'cli.js');
const stateFile = join(tmpdir(), `agent-runtime-e2e-state-${process.pid}-${Date.now()}.json`);
const workspaceRoot = join(tmpdir(), `agent-runtime-e2e-workspace-${process.pid}-${Date.now()}`);
let handle;
let cli;

await buildServer();
await runNpm(['run', 'build', '-w', '@agent-cluster/local-runtime-cli']);

try {
  await mkdir(join(workspaceRoot, 'src'), { recursive: true });
  await writeFile(join(workspaceRoot, 'README.md'), '# Local Runtime E2E fixture\n', 'utf8');
  handle = await startBrowserSmokeServer('browser-local-runtime-cli-e2e', {
    LOCAL_RUNTIME_ADMIN_TOKEN: adminToken,
    DISCUSSION_MAX_ROUNDS: '0',
    REQUIRE_USER_CONFIRMATION: 'false',
    CODEX_RUNTIME_ENABLED: 'true',
    PROJECT_POLICY_RUNTIME_TYPE: 'mock'
  });
  const serverUrl = new URL(handle.server.apiBase).origin;
  const cliEnv = {
    ...process.env,
    AGENT_RUNTIME_STATE_FILE: stateFile,
    AGENT_RUNTIME_CODEX_VERSION: 'local-runtime-codex-stub 1.0.0',
    AGENT_RUNTIME_CODEX_COMMAND: process.execPath,
    AGENT_RUNTIME_CODEX_ARGS_JSON: JSON.stringify([fixture])
  };

  await runCli(['login', '--approve', '--server', serverUrl, '--admin-token', adminToken], cliEnv);
  await runCli(['workspace', 'add', workspaceRoot, '--name', 'local-runtime-e2e'], cliEnv);
  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  const workspaceId = state.workspaces[0]?.workspaceId;
  if (!workspaceId) throw new Error('The Local Runtime CLI did not persist the workspace registration.');
  await runCli(['workspace', 'grant', workspaceId, 'command_execute'], cliEnv);

  cli = spawn(process.execPath, [cliEntry, 'start'], {
    cwd: root,
    env: cliEnv,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  cli.stdout.on('data', (chunk) => process.stdout.write(chunk));
  cli.stderr.on('data', (chunk) => process.stderr.write(chunk));
  await waitForLocalWorkspace(handle.server.apiBase, workspaceId);

  const agents = (await api(handle.server.apiBase, '/agents')).data;
  const backend = agents.find((agent) => agent.key === 'backend');
  if (!backend) throw new Error('The Local Runtime browser E2E requires the backend Agent.');
  const workflow = await createPublishedAgentWorkflow(
    handle.server.apiBase,
    'Local Runtime browser E2E workflow',
    ['backend']
  );
  Object.assign(handle, await startBrowserPage(handle.server.apiBase, handle.webPort));
  const { page, web } = handle;
  await page.addInitScript((token) => {
    sessionStorage.setItem('agent-cluster.local-runtime-admin-token', token);
  }, adminToken);
  await page.goto(`${web.webBase}/?view=chat`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '新建会话' }).click();
  const dialog = page.getByRole('region', { name: '新建会话' });
  await dialog.getByRole('button', { name: '本地', exact: true }).click();
  await dialog.locator('.local-runtime-workspace-picker select').selectOption(workspaceId);
  await dialog.getByLabel('Runtime 偏好').selectOption('codex');
  await dialog.getByLabel('任务').fill('通过本机 Runtime 创建 src/local-runtime-e2e.txt');
  await dialog.locator('.dialog-agent-picker button').filter({ hasText: backend.name }).click();
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  const confirmation = page.getByRole('region', { name: '确认保存会话' });
  const createResponsePromise = page.waitForResponse((response) =>
    response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/sessions'
  );
  await confirmation.getByRole('button', { name: '确认保存' }).click();
  const createResponse = await createResponsePromise;
  if (!createResponse.ok()) {
    throw new Error(`Browser Session create failed: ${createResponse.status()} ${await createResponse.text()}`);
  }
  const session = (await createResponse.json()).data.session;
  await confirmation.waitFor({ state: 'hidden', timeout: 20_000 });

  const waiting = await waitForStatus(handle.server.apiBase, session.id, 'WAIT_USER_CONFIRM', 60_000);
  const briefId = waiting.currentTaskBriefId;
  if (!briefId) throw new Error('The browser-created Local Runtime session did not produce a Task Brief.');
  await api(handle.server.apiBase, `/sessions/${session.id}/briefs/${briefId}/confirm`, { method: 'POST' });
  await selectPublishedWorkflow(handle.server.apiBase, session.id, workflow, 60_000);
  await waitForCompletion(handle.server.apiBase, session.id, 90_000);

  const content = await readFile(join(workspaceRoot, 'src', 'local-runtime-e2e.txt'), 'utf8');
  if (content !== 'written through local Runtime ChangeSet\n') {
    throw new Error(`Unexpected Local Runtime file content: ${JSON.stringify(content)}`);
  }
  const invocations = (await api(
    handle.server.apiBase,
    `/sessions/${session.id}/debug/runtime-invocations`
  )).data.items;
  const completedLocalInvocation = invocations.some((invocation) =>
    invocation.executionTarget?.executionLocation === 'local' && invocation.status === 'completed'
  );
  if (!completedLocalInvocation) {
    throw new Error(
      `The browser-created session did not complete through executionLocation=local: ${JSON.stringify(invocations)}`
    );
  }
  const persisted = await readFile(handle.server.dataFile, 'utf8');
  if (persisted.toLowerCase().includes(workspaceRoot.toLowerCase())) {
    throw new Error('The platform persistence file leaked the Local Runtime absolute workspace path.');
  }
  console.log('browser -> backend -> Local Runtime CLI -> ChangeSet -> local file E2E ok');
} finally {
  if (cli) await cleanup('Local Runtime CLI', () => stopChild(cli));
  if (handle) await cleanup('browser smoke services', () => stopBrowserCollaborationSmoke(handle));
  await cleanup('Local Runtime state file', () => rm(stateFile, { force: true }));
  await cleanup('Local Runtime workspace fixture', () => rm(workspaceRoot, { recursive: true, force: true }));
}

process.exit(0);

async function cleanup(label, action) {
  try {
    await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Cleanup warning for ${label}: ${message}`);
  }
}

async function runCli(args, env) {
  const result = await execFile(process.execPath, [cliEntry, ...args], {
    cwd: root,
    env,
    timeout: 30_000,
    windowsHide: true
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

async function waitForLocalWorkspace(apiBase, workspaceId) {
  const deadline = Date.now() + 20_000;
  let lastResponse;
  let lastError;
  while (Date.now() < deadline) {
    const response = await api(apiBase, '/local-runtime/workspaces', {
      headers: { authorization: `Bearer ${adminToken}` }
    }).catch((error) => {
      lastError = error instanceof Error ? error.message : String(error);
      return undefined;
    });
    lastResponse = response;
    if (response?.data?.some((workspace) => workspace.workspaceId === workspaceId)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Timed out waiting for Local Runtime workspace ${workspaceId}: ${JSON.stringify({ lastResponse, lastError })}`
  );
}

async function waitForCompletion(apiBase, sessionId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let decisionSince;
  let lastSession;
  while (Date.now() < deadline) {
    lastSession = (await api(apiBase, `/sessions/${sessionId}`)).data;
    if (lastSession.status === 'COMPLETED') return lastSession;
    if (lastSession.status === 'WAIT_USER_DECISION') {
      decisionSince ??= Date.now();
      if (Date.now() - decisionSince >= 2_000) {
        throw await sessionProgressError(apiBase, lastSession, 'requires an unexpected user decision');
      }
    } else {
      decisionSince = undefined;
    }
    if (lastSession.status === 'FAILED' || lastSession.status === 'CANCELLED' || lastSession.status === 'INTERRUPTED') {
      throw await sessionProgressError(apiBase, lastSession, `entered terminal status ${lastSession.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw await sessionProgressError(apiBase, lastSession, `timed out after ${timeoutMs} ms`);
}

async function sessionProgressError(apiBase, session, reason) {
  const events = await listEvents(apiBase, session.id);
  const diagnosticTypes = new Set([
    'user_confirmation_requested',
    'user_confirmation_resolved',
    'session_status_changed',
    'task_blocked',
    'task_waiting',
    'runtime_failed',
    'runtime_completed',
    'error_reported',
    'workflow_run_failed'
  ]);
  const diagnostics = events.filter((event) => diagnosticTypes.has(event.type)).slice(-20);
  return new Error(`Local Runtime E2E ${reason}: ${JSON.stringify({ session, diagnostics })}`);
}

async function stopChild(child) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    await execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      timeout: 5_000
    }).catch(() => undefined);
  } else {
    child.kill('SIGTERM');
  }
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 2_000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}
