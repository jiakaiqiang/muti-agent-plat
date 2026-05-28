import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const npmCli = process.env.npm_execpath;
const dataFile = join(root, '.cache', 'agent-cluster', `persistence-smoke-${Date.now()}.json`);

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
      const response = await fetch(`${apiBase}/agents`);
      if (response.ok) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw lastError ?? new Error('Server did not become ready');
}

async function startServer() {
  const port = await findFreePort();
  const apiBase = `http://127.0.0.1:${port}/api`;
  const server = spawn(process.execPath, ['apps/server/dist/apps/server/src/main.js'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      SERVER_PORT: port,
      AGENT_CLUSTER_DATA_FILE: dataFile
    }
  });

  server.stdout.on('data', (chunk) => process.stdout.write(chunk));
  server.stderr.on('data', (chunk) => process.stderr.write(chunk));
  await waitForServer(apiBase);
  return { apiBase, server };
}

async function stopServer(server) {
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
}

async function api(apiBase, path, init) {
  const response = await fetch(`${apiBase}${path}`, {
    headers: {
      'content-type': 'application/json'
    },
    ...init
  });

  if (!response.ok) {
    throw new Error(`${init?.method ?? 'GET'} ${path} failed: ${response.status}`);
  }
  return response.json();
}

await runNpm(['run', 'build', '-w', '@agent-cluster/shared']);
await runNpm(['run', 'build', '-w', '@agent-cluster/server']);

let first;
let second;

try {
  first = await startServer();
  const created = await api(first.apiBase, '/sessions', {
    method: 'POST',
    body: JSON.stringify({
      input: 'Persistence smoke session',
      agentIds: ['coordinator', 'requirements']
    })
  });
  const sessionId = created.data.session.id;
  await stopServer(first.server);
  first = undefined;

  second = await startServer();
  const detail = await api(second.apiBase, `/sessions/${sessionId}`);
  const events = await api(second.apiBase, `/sessions/${sessionId}/events`);

  if (detail.data.id !== sessionId) {
    throw new Error('Persisted session was not restored');
  }
  if (events.data.items.length < 2) {
    throw new Error('Persisted events were not restored');
  }

  console.log(`persistence smoke ok: ${sessionId}, events=${events.data.items.length}`);
} finally {
  if (first) {
    await stopServer(first.server);
  }
  if (second) {
    await stopServer(second.server);
  }
  rmSync(dataFile, { force: true });
}
