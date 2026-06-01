import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const npmCli = process.env.npm_execpath;
const dataFile = join(root, '.cache', 'agent-cluster', `artifact-write-${Date.now()}.json`);
const workspaceDir = mkdtempSync(join(tmpdir(), 'agent-cluster-write-'));
writeFileSync(join(workspaceDir, 'README.md'), '# before\n', 'utf8');

function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => {
        if (typeof address === 'object' && address?.port) {
          resolve(String(address.port));
        } else {
          reject(new Error('Could not allocate a free port'));
        }
      });
    });
  });
}

function readJsonRequest(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: options.stdio ?? 'inherit',
      env: { ...process.env, ...(options.env ?? {}) }
    });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} exited with ${code}`))));
    child.on('error', reject);
  });
}

function runNpm(args) {
  if (!npmCli) throw new Error('npm_execpath is required; run this script through npm.');
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
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw lastError ?? new Error('Server did not become ready');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function api(apiBase, path, init) {
  const response = await fetch(`${apiBase}${path}`, init);
  const text = await response.text();
  const json = text ? JSON.parse(text) : undefined;
  if (!response.ok) throw new Error(`${path} -> HTTP ${response.status}: ${text}`);
  return json;
}

function payloadForExpected(expected) {
  const kind = expected?.kind;
  if (kind === 'task_brief') {
    return {
      kind: 'task_brief',
      goal: '修改 README 并验证交付链路',
      scope: ['写入 README', '验证产物完整性'],
      outOfScope: [],
      constraints: [],
      acceptanceCriteria: ['README 被更新', '能看到简报/写入预览/文件/复盘/交付产物'],
      risks: [],
      openQuestions: [],
      suggestedTasks: [{ title: '更新 README', description: '写入新的 README 内容', suggestedAgentKey: 'backend', acceptanceCriteria: ['README.md 已更新'] }]
    };
  }
  if (kind === 'task_execution_result') {
    return {
      kind: 'task_execution_result',
      status: 'completed',
      summary: '已准备好 README 改动并等待写入确认',
      completedItems: ['生成 README 新内容'],
      changedArtifacts: [],
      nextSuggestedActions: [],
      risks: [],
      toolRequests: [
        {
          tool: 'file_write',
          path: 'README.md',
          content: '# after\n\nupdated by runtime\n',
          summary: '更新 README 内容'
        }
      ]
    };
  }
  if (kind === 'post_review_report') {
    return {
      kind: 'post_review_report',
      isConsistentWithBrief: true,
      matchedItems: ['README 已更新'],
      mismatchedItems: [],
      missingItems: [],
      outOfScopeChanges: [],
      testResults: ['人工验证文件已写入'],
      recommendation: 'deliver'
    };
  }
  if (kind === 'final_delivery') {
    return {
      kind: 'final_delivery',
      summary: 'README 改动已完成并可交付',
      completedItems: ['README 已写入工作目录'],
      incompleteItems: [],
      risks: [],
      artifactRefs: []
    };
  }
  if (kind === 'agent_message') {
    return { kind: 'agent_message', messageKind: 'discussion', content: '收到。' };
  }
  return { kind, schemaVersion: '0.1' };
}

await runNpm(['run', 'build', '-w', '@agent-cluster/shared']);
await runNpm(['run', 'build', '-w', '@agent-cluster/server']);

const llmPort = await findFreePort();
const llmServer = createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'not_found' }));
    return;
  }
  const body = await readJsonRequest(request);
  const userMessage = (body.messages ?? []).find((message) => message.role === 'user');
  let expected;
  try {
    const parsed = JSON.parse(userMessage?.content ?? '{}');
    expected = parsed.expectedOutput;
  } catch {
    expected = undefined;
  }
  const payload = payloadForExpected(expected);
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(
    JSON.stringify({
      id: 'chatcmpl-artifact-write',
      object: 'chat.completion',
      model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(payload) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 12, total_tokens: 22 }
    })
  );
});
await new Promise((resolve) => llmServer.listen(llmPort, '127.0.0.1', resolve));

const serverPort = await findFreePort();
const apiBase = `http://127.0.0.1:${serverPort}/api`;
const server = spawn(process.execPath, ['apps/server/dist/apps/server/src/main.js'], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    SERVER_PORT: serverPort,
    AGENT_CLUSTER_DATA_FILE: dataFile,
    AGENT_CLUSTER_SEED_DEFAULT_AGENTS: 'true',
    ENABLE_HIGH_RISK_TOOLS: 'true',
    REQUIRE_USER_CONFIRMATION: 'true',
    ALLOW_FILE_WRITE_RUNTIME: 'false',
    DEFAULT_AGENT_RUNTIME_TYPE: 'generic_llm',
    LLM_PROVIDER: 'openai-compatible',
    LLM_MODEL: 'artifact-write-model',
    LLM_API_KEY: 'artifact-write-key',
    LLM_BASE_URL: `http://127.0.0.1:${llmPort}/v1`,
    LLM_DRY_RUN: 'false',
    LLM_MOCK_FALLBACK: 'false',
    MOCK_RUNTIME_ENABLED: 'false'
  }
});
let serverLogs = '';
server.stdout.on('data', (chunk) => (serverLogs += chunk));
server.stderr.on('data', (chunk) => (serverLogs += chunk));

try {
  await waitForServer(apiBase);
  const agents = (await api(apiBase, '/agents')).data;
  const sessionCreated = await api(apiBase, '/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      input: '请修改 README 并输出完整交付产物',
      agentIds: agents.map((agent) => agent.id),
      workspaceDir,
      tokenBudget: 50000
    })
  });
  const sessionId = sessionCreated.data.session.id;

  const waitForStatus = async (status, timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const session = (await api(apiBase, `/sessions/${sessionId}`)).data;
      if (session.status === status) return session;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`session ${sessionId} did not reach ${status}`);
  };

  await waitForStatus('WAIT_USER_CONFIRM');
  const eventsBeforeConfirm = (await api(apiBase, `/sessions/${sessionId}/events?limit=200`)).data.items;
  const briefEvent = eventsBeforeConfirm.find((event) => event.type === 'brief_created');
  assert(briefEvent, 'expected brief_created event');
  const briefId = briefEvent.metadata.payload.briefId;

  const artifactsAfterBrief = (await api(apiBase, `/sessions/${sessionId}/artifacts`)).data.items;
  assert(artifactsAfterBrief.some((artifact) => String(artifact.title).startsWith('任务简报 v')), 'brief artifact should exist');

  await api(apiBase, `/sessions/${sessionId}/briefs/${briefId}/confirm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({})
  });

  await waitForStatus('WAIT_USER_DECISION');
  const artifactsWaiting = (await api(apiBase, `/sessions/${sessionId}/artifacts`)).data.items;
  assert(artifactsWaiting.some((artifact) => artifact.type === 'code_diff'), 'code_diff preview artifact should exist before approval');
  assert(!artifactsWaiting.some((artifact) => artifact.type === 'file'), 'file artifact should not exist before approval');

  const pendingConfirmation = ((await api(apiBase, `/sessions/${sessionId}/events?limit=200`)).data.items)
    .filter((event) => event.type === 'user_confirmation_requested' && event.metadata?.payload?.reason === 'apply_file_writes')
    .at(-1);
  assert(pendingConfirmation, 'expected apply_file_writes confirmation');
  const confirmationId = pendingConfirmation.metadata.payload.confirmationId;

  await api(apiBase, `/sessions/${sessionId}/writes/${confirmationId}/apply`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ approved: true })
  });

  await waitForStatus('COMPLETED');
  const artifactsFinal = (await api(apiBase, `/sessions/${sessionId}/artifacts`)).data.items;
  const types = new Set(artifactsFinal.map((artifact) => artifact.type));
  assert(types.has('markdown'), 'markdown artifacts should exist');
  assert(types.has('code_diff'), 'code_diff artifact should remain visible');
  assert(types.has('file'), 'file artifact should exist after approval');
  assert(types.has('test_report'), 'review artifact should exist');
  assert(types.has('feishu_draft'), 'feishu draft should exist');
  assert(artifactsFinal.some((artifact) => artifact.title === '最终交付摘要'), 'final delivery artifact should exist');

  const readme = readFileSync(join(workspaceDir, 'README.md'), 'utf8');
  assert(readme.includes('updated by runtime'), 'README should be written to workspace after approval');
  console.log('artifact/write smoke ok');
} catch (error) {
  process.stderr.write(serverLogs);
  throw error;
} finally {
  if (!server.killed) server.kill();
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 2_000);
    server.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  await new Promise((resolve) => llmServer.close(resolve));
  rmSync(dataFile, { force: true });
  rmSync(workspaceDir, { recursive: true, force: true });
}
