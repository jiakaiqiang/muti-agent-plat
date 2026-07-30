import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSmokeV2State } from './smoke-server.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const npmCli = process.env.npm_execpath;
const dataFile = join(root, '.cache', 'agent-cluster', `ops-smoke-${Date.now()}.json`);

function findFreePort() {
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

function run(command, args, options = {}) {
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

function runNpm(args) {
  if (!npmCli) {
    throw new Error('npm_execpath is required; run this script through npm.');
  }
  return run(process.execPath, [npmCli, ...args]);
}

async function waitForServer(apiBase) {
  const deadline = Date.now() + 15_000;
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

async function api(apiBase, path) {
  const response = await fetch(`${apiBase}${path}`);
  if (!response.ok) {
    throw new Error(`GET ${path} failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

await runNpm(['run', 'build', '-w', '@agent-cluster/shared']);
await runNpm(['run', 'build', '-w', '@agent-cluster/server']);

const port = await findFreePort();
const apiBase = `http://127.0.0.1:${port}/api`;
mkdirSync(dirname(dataFile), { recursive: true });
writeFileSync(dataFile, JSON.stringify(createSmokeV2State()), 'utf8');
const server = spawn(process.execPath, ['apps/server/dist/apps/server/src/main.js'], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    SERVER_PORT: port,
    AGENT_CLUSTER_PERSISTENCE_BACKEND: 'file',
    AGENT_CLUSTER_DATA_FILE: dataFile,
    LOG_FORMAT: 'json'
  }
});

server.stdout.on('data', (chunk) => process.stdout.write(chunk));
server.stderr.on('data', (chunk) => process.stderr.write(chunk));

try {
  await waitForServer(apiBase);
  const health = await api(apiBase, '/health');
  if (health.data?.status !== 'ok') {
    throw new Error(`Unexpected health status: ${JSON.stringify(health)}`);
  }
  const queues = await api(apiBase, '/ops/queues');
  if (!Array.isArray(queues.data?.queues) || queues.data.queues.length < 1) {
    throw new Error(`Queue summary missing: ${JSON.stringify(queues)}`);
  }
  if (typeof queues.data.enabled !== 'boolean') {
    throw new Error(`Queue enabled flag missing: ${JSON.stringify(queues)}`);
  }
  const workspaceMetrics = await api(apiBase, '/ops/workspace-metrics');
  const expectedWorkspaceMetricNames = [
    'workspace_authorization_duration_ms',
    'session_create_duration_ms',
    'workspace_index_status_total',
    'workspace_index_entries_total',
    'workspace_index_generation_duration_ms',
    'supplemental_context_duration_ms',
    'supplemental_context_bytes_total',
    'supplemental_context_retry_total',
    'context_insufficient_terminal_total',
    'workspace_active_session_conflict_total',
    'workspace_revision_unstable_total'
  ];
  if (!Array.isArray(workspaceMetrics.data?.names) || !Array.isArray(workspaceMetrics.data?.series)) {
    throw new Error(`Workspace metrics snapshot missing: ${JSON.stringify(workspaceMetrics)}`);
  }
  for (const name of expectedWorkspaceMetricNames) {
    if (!workspaceMetrics.data.names.includes(name)) {
      throw new Error(`Workspace metric name missing: ${name}`);
    }
  }
  console.log('ops smoke ok');
} finally {
  if (!server.killed) {
    server.kill();
  }
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 2_000);
    server.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  rmSync(dataFile, { force: true });
}
