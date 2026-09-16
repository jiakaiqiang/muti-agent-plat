import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../..', import.meta.url));
const npmCli = process.env.npm_execpath;

export function createSmokeV2State() {
  const now = new Date().toISOString();
  const dataEpoch = randomUUID();
  const cutoverAuditId = randomUUID();
  return {
    agents: [],
    capabilities: { capabilities: [], approvals: [], definitionExtensions: {} },
    skills: [],
    sessions: [],
    eventsBySession: {},
    tasksBySession: {},
    briefsBySession: {},
    suggestedTasksByBriefId: {},
    memoriesBySession: {},
    runtimeInvocationsBySession: {},
    artifacts: { artifactsById: {}, artifactIdsBySession: {} },
    knowledge: { knowledgeBases: {}, documentsByBase: {}, chunksByBase: {} },
    autopilots: [],
    autopilotRuns: [],
    systemDataMetadata: {
      dataSchemaVersion: 3,
      dataEpoch,
      pipelineVersion: 'v2',
      cutoverAt: now,
      cutoverAuditId
    },
    cutoverAudits: [
      {
        id: cutoverAuditId,
        appliedAt: now,
        environment: 'e2e-smoke',
        result: 'applied',
        dataEpoch
      }
    ]
  };
}

export async function findFreePort() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    // Windows can return ports from system-excluded dynamic ranges for listen(0),
    // then deny a second process binding the same port. Stay below that range for
    // multi-process browser smokes while still probing the exact candidate.
    const candidate = process.platform === 'win32'
      ? 20_000 + Math.floor(Math.random() * 25_000)
      : 0;
    const port = await probeFreePort(candidate).catch(() => undefined);
    if (port) return port;
  }
  throw new Error('Could not allocate a free port after 50 attempts');
}

function probeFreePort(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === 'object' && address?.port) {
          resolve(String(address.port));
        } else {
          reject(new Error('Could not allocate a free port'));
        }
      });
    });
  });
}

export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: options.stdio ?? 'inherit',
      env: {
        ...process.env,
        ...(options.env ?? {})
      }
    });

    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(' ')} exited with ${code}`));
      }
    });
    child.on('error', reject);
  });
}

export function runNpm(args) {
  if (!npmCli) {
    throw new Error('npm_execpath is required; run this script through npm.');
  }
  return run(process.execPath, [npmCli, ...args]);
}

export async function buildServer() {
  await runNpm(['run', 'build', '-w', '@agent-cluster/shared']);
  await runNpm(['run', 'build', '-w', '@agent-cluster/server']);
}

export async function waitForServer(apiBase) {
  const deadline = Date.now() + 20_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${apiBase}/health`);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw lastError ?? new Error('Server did not become ready');
}

export async function startSmokeServer(name, env = {}) {
  const port = await findFreePort();
  const apiBase = `http://127.0.0.1:${port}/api`;
  const dataFile = join(root, '.cache', 'agent-cluster', `${name}-${Date.now()}.json`);
  mkdirSync(dirname(dataFile), { recursive: true });
  writeFileSync(dataFile, JSON.stringify(createSmokeV2State()), 'utf8');
  const server = spawn(process.execPath, ['apps/server/dist/apps/server/src/main.js'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      SERVER_PORT: port,
      AGENT_CLUSTER_PERSISTENCE: 'true',
      AGENT_CLUSTER_PERSISTENCE_BACKEND: 'file',
      AGENT_CLUSTER_DATA_FILE: dataFile,
      AGENT_CLUSTER_SEED_DEFAULT_AGENTS: 'true',
      LLM_DRY_RUN: 'true',
      LLM_MOCK_FALLBACK: 'true',
      MOCK_RUNTIME_ENABLED: 'true',
      ...env
    }
  });

  server.stdout.on('data', (chunk) => process.stdout.write(chunk));
  server.stderr.on('data', (chunk) => process.stderr.write(chunk));
  await waitForServer(apiBase);
  return { apiBase, dataFile, server };
}

export async function stopSmokeServer(handle) {
  let terminated = false;
  if (handle.server.pid && process.platform === 'win32') {
    terminated = await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(handle.server.pid), '/T', '/F'], { stdio: 'ignore' });
      const timer = setTimeout(() => resolve(false), 5_000);
      killer.once('exit', (code) => { clearTimeout(timer); resolve(code === 0); });
      killer.once('error', () => { clearTimeout(timer); resolve(false); });
    });
  }
  if (!terminated && !handle.server.killed) {
    terminated = handle.server.kill();
  }
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 2_000);
    handle.server.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  handle.server.stdout?.destroy();
  handle.server.stderr?.destroy();
  rmSync(handle.dataFile, { force: true });
}

export async function api(apiBase, path, init) {
  const response = await fetch(`${apiBase}${path}`, {
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {})
    },
    ...init
  });
  if (!response.ok) {
    throw new Error(`${init?.method ?? 'GET'} ${path} failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

export async function listEvents(apiBase, sessionId) {
  const response = await api(apiBase, `/sessions/${sessionId}/events?limit=300`);
  return response.data.items;
}

export async function createPublishedAgentWorkflow(apiBase, name, agentKeys) {
  if (!Array.isArray(agentKeys) || agentKeys.length === 0) {
    throw new Error('createPublishedAgentWorkflow requires at least one Agent key.');
  }
  const agents = (await api(apiBase, '/agents')).data;
  const byKey = new Map(agents.map((agent) => [agent.key, agent]));
  const nodes = agentKeys.map((agentKey, index) => {
    const agent = byKey.get(agentKey);
    if (!agent) throw new Error(`Workflow Agent is unavailable: ${agentKey}`);
    return {
      id: `e2e-agent-${index + 1}-${agentKey}`,
      type: 'agent',
      agentId: agent.id,
      stageDescription: `Execute the ${agentKey} stage for the E2E workflow.`,
      outputContract: [`Produce an accepted ${agentKey} stage result.`],
      order: index
    };
  });
  const draft = (await api(apiBase, '/workflows', {
    method: 'POST',
    body: JSON.stringify({ name, nodes })
  })).data;
  return (await api(apiBase, `/workflows/${draft.id}/publish`, {
    method: 'POST',
    body: JSON.stringify({ expectedDraftRevision: draft.draftRevision })
  })).data;
}

export async function selectPublishedWorkflow(apiBase, sessionId, workflow, timeoutMs = 20_000) {
  await waitForStatus(apiBase, sessionId, 'WAIT_WORKFLOW_SELECT', timeoutMs);
  const workflowSelection = await waitForMatchingEvent(
    apiBase,
    sessionId,
    'user_confirmation_requested',
    (event) => event.metadata.payload?.reason === 'select_workflow',
    timeoutMs
  );
  return (await api(apiBase, `/sessions/${sessionId}/workflow/select`, {
    method: 'POST',
    body: JSON.stringify({
      workflowId: workflow.id,
      workflowVersion: workflow.currentPublishedVersion,
      confirmationId: workflowSelection.metadata.payload.confirmationId
    })
  })).data;
}

export async function confirmBriefAndSelectWorkflow(apiBase, sessionId, briefId, workflow, timeoutMs = 20_000) {
  await api(apiBase, `/sessions/${sessionId}/briefs/${briefId}/confirm`, { method: 'POST' });
  return selectPublishedWorkflow(apiBase, sessionId, workflow, timeoutMs);
}

export async function waitForEvent(apiBase, sessionId, type, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const event = (await listEvents(apiBase, sessionId)).find((item) => item.type === type);
    if (event) return event;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for event: ${type}`);
}

export async function waitForMatchingEvent(apiBase, sessionId, type, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const event = (await listEvents(apiBase, sessionId)).find((item) => item.type === type && predicate(item));
    if (event) return event;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for matching event: ${type}`);
}

export async function waitForStatus(apiBase, sessionId, status, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    const detail = await api(apiBase, `/sessions/${sessionId}`);
    last = detail.data.status;
    if (last === status) return detail.data;
    if (last === 'FAILED' && status !== 'FAILED') {
      const events = await listEvents(apiBase, sessionId);
      const diagnostics = events
        .filter((event) =>
          ['error_reported', 'runtime_failed', 'session_status_changed', 'workflow_run_failed'].includes(event.type)
        )
        .slice(-8);
      throw new Error(
        `Session failed while waiting for ${status}: ${JSON.stringify({ session: detail.data, diagnostics })}`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for status ${status}, last=${last}`);
}

export async function createSessionAndWaitForBrief(apiBase, input, extra = {}) {
  const created = await api(apiBase, '/sessions', {
    method: 'POST',
    body: JSON.stringify({
      input,
      ...extra
    })
  });
  const sessionId = created.data.session.id;
  const session = await waitForStatus(apiBase, sessionId, 'WAIT_USER_CONFIRM');
  const briefId =
    session.currentTaskBriefId ??
    (await waitForEvent(apiBase, sessionId, 'brief_created')).metadata.payload.briefId;
  return { sessionId, briefId };
}
