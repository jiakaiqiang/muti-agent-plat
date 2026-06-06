import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../..', import.meta.url));
const npmCli = process.env.npm_execpath;

export function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
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
  if (!handle.server.killed) {
    handle.server.kill();
  }
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 2_000);
    handle.server.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
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
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for status ${status}, last=${last}`);
}

export async function createSessionAndWaitForBrief(apiBase, input, extra = {}) {
  const created = await api(apiBase, '/sessions', {
    method: 'POST',
    body: JSON.stringify({
      input,
      agentIds: ['coordinator', 'requirements', 'architect', 'backend', 'test', 'review', 'notification'],
      ...extra
    })
  });
  const sessionId = created.data.session.id;
  const briefEvent = await waitForEvent(apiBase, sessionId, 'brief_created');
  return { sessionId, briefId: briefEvent.metadata.payload.briefId };
}
