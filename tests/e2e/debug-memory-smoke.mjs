import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const npmCli = process.env.npm_execpath;
const dataFile = join(root, '.cache', 'agent-cluster', `debug-memory-${Date.now()}.json`);

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

async function api(apiBase, path, init) {
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

async function listEvents(apiBase, sessionId) {
  const response = await api(apiBase, `/sessions/${sessionId}/events?limit=200`);
  return response.data.items;
}

async function waitForMatchingEvent(apiBase, sessionId, type, predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const event = (await listEvents(apiBase, sessionId)).find((item) => item.type === type && predicate(item));
    if (event) return event;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for matching event: ${type}`);
}

async function waitForBrief(apiBase, sessionId, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const briefs = await api(apiBase, `/sessions/${sessionId}/briefs`);
    const briefId = briefs.data[0]?.id;
    if (briefId) return briefId;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Expected a task brief');
}

await runNpm(['run', 'build', '-w', '@agent-cluster/shared']);
await runNpm(['run', 'build', '-w', '@agent-cluster/server']);

const port = await findFreePort();
const apiBase = `http://127.0.0.1:${port}/api`;
const server = spawn(process.execPath, ['apps/server/dist/apps/server/src/main.js'], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    SERVER_PORT: port,
    AGENT_CLUSTER_DATA_FILE: dataFile,
    AGENT_CLUSTER_SEED_DEFAULT_AGENTS: 'true',
    LLM_DRY_RUN: 'true',
    LLM_MOCK_FALLBACK: 'true',
    MOCK_RUNTIME_ENABLED: 'true'
  }
});

server.stdout.on('data', (chunk) => process.stdout.write(chunk));
server.stderr.on('data', (chunk) => process.stderr.write(chunk));

try {
  await waitForServer(apiBase);
  const created = await api(apiBase, '/sessions', {
    method: 'POST',
    body: JSON.stringify({
      input: '继续保持 dry-run 非破坏性执行，并输出可审计的 context pack。',
      agentIds: ['coordinator', 'backend', 'test', 'review', 'notification']
    })
  });
  const sessionId = created.data.session.id;

  const preferenceMarker = `PREF_MEMORY_MARKER_${Date.now()}`;
  await api(apiBase, `/sessions/${sessionId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content: `请记住：以后偏好标记为 ${preferenceMarker}。` })
  });
  const beforeConfirmMemories = await api(apiBase, `/sessions/${sessionId}/memories?q=${encodeURIComponent(preferenceMarker)}`);
  if (beforeConfirmMemories.data.items.length !== 0) {
    throw new Error('Preference memory must not be written before user confirmation');
  }
  const memoryConfirmation = await waitForMatchingEvent(
    apiBase,
    sessionId,
    'user_confirmation_requested',
    (event) => event.metadata.payload.reason === 'confirm_memory_write'
  );
  const candidate = memoryConfirmation.metadata.payload.candidate;
  const confirmedMemory = await api(apiBase, `/sessions/${sessionId}/memories/confirm`, {
    method: 'POST',
    body: JSON.stringify({
      confirmationId: memoryConfirmation.metadata.payload.confirmationId,
      content: candidate.content,
      sourceEventId: candidate.sourceEventId,
      confidence: candidate.confidence
    })
  });
  const afterConfirmMemories = await api(apiBase, `/sessions/${sessionId}/memories?q=${encodeURIComponent(preferenceMarker)}`);
  if (!afterConfirmMemories.data.items.some((memory) => memory.id === confirmedMemory.data.memory.id)) {
    throw new Error('Preference memory must be searchable after user confirmation');
  }

  const manualMemory = await api(apiBase, `/sessions/${sessionId}/memories`, {
    method: 'POST',
    body: JSON.stringify({ content: 'dry-run only 是当前会话的强约束。', scope: 'session' })
  });

  const memories = await api(apiBase, `/sessions/${sessionId}/memories?q=dry-run`);
  if (!memories.data.items.some((memory) => memory.id === manualMemory.data.id)) {
    throw new Error('Expected memory search to return the manually created memory');
  }

  const briefId = await waitForBrief(apiBase, sessionId);
  await api(apiBase, `/sessions/${sessionId}/briefs/${briefId}/confirm`, { method: 'POST' });

  const contextPacks = await api(apiBase, `/sessions/${sessionId}/debug/context-packs`);
  if (!contextPacks.data.items.some((item) => item.contextPack.relevantMemories.length > 0)) {
    throw new Error('Expected at least one debug context pack with relevant memories');
  }

  const invocations = await api(apiBase, `/sessions/${sessionId}/debug/runtime-invocations`);
  if (!invocations.data.items.some((item) => item.contextPackSummary.memoryCount > 0)) {
    throw new Error('Expected runtime invocation summary to include memory usage');
  }

  const ragRetrievals = await api(apiBase, `/sessions/${sessionId}/debug/rag-retrievals`);
  if (!ragRetrievals.data.items.length) {
    throw new Error('Expected debug RAG retrievals');
  }

  const tokenUsage = await api(apiBase, `/sessions/${sessionId}/debug/token-usage`);
  if (tokenUsage.data.invocationCount < 1) {
    throw new Error('Expected token usage debug output');
  }

  console.log('debug memory smoke ok');
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
