import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  api,
  buildServer,
  findFreePort,
  listEvents,
  root,
  waitForEvent,
  waitForServer,
  waitForStatus
} from './smoke-server.mjs';

function readJsonRequest(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
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

function runtimeRequest(body) {
  const userMessage = body.messages?.find((message) => message.role === 'user');
  return JSON.parse(userMessage?.content ?? '{}');
}

function outputFor(request) {
  const kind = request.expectedOutput?.kind;
  if (kind === 'agent_message') {
    return {
      kind,
      messageKind: 'discussion',
      content: 'This slow discussion response should arrive after the orchestrator timeout.'
    };
  }

  if (kind === 'task_brief') {
    return {
      kind,
      goal: 'Verify brief generation survives a slow discussion runtime.',
      scope: ['Create a task brief after discussion timeout degradation'],
      outOfScope: [],
      constraints: ['Do not fail the session solely because discussion timed out'],
      acceptanceCriteria: ['A brief_created event is emitted'],
      risks: ['Discussion quality may be reduced when an agent times out'],
      openQuestions: [],
      suggestedTasks: [
        {
          title: 'Validate discussion timeout handling',
          description: 'Confirm the session reaches the brief confirmation stage.',
          suggestedAgentKey: 'backend',
          acceptanceCriteria: ['The timed-out discussion invocation is recorded as RUNTIME_TIMEOUT']
        }
      ]
    };
  }

  throw new Error(`Unsupported runtime output kind in timeout smoke: ${String(kind)}`);
}

await buildServer();

const llmRequests = [];
const llmPort = await findFreePort();
const llmServer = createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'not_found' }));
    return;
  }

  const body = await readJsonRequest(request);
  const runtime = runtimeRequest(body);
  llmRequests.push({ model: body.model, phase: runtime.phase, kind: runtime.expectedOutput?.kind });

  if (runtime.phase === 'discussion') {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const output = outputFor(runtime);
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(
    JSON.stringify({
      id: 'chatcmpl-discussion-timeout-smoke',
      object: 'chat.completion',
      model: body.model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: JSON.stringify(output)
          },
          finish_reason: 'stop'
        }
      ],
      usage: {
        prompt_tokens: 7,
        completion_tokens: 9,
        total_tokens: 16
      }
    })
  );
});

await new Promise((resolve) => llmServer.listen(llmPort, '127.0.0.1', resolve));

const serverPort = await findFreePort();
const apiBase = `http://127.0.0.1:${serverPort}/api`;
const dataFile = join(root, '.cache', 'agent-cluster', `discussion-timeout-brief-${Date.now()}.json`);
const server = spawn(process.execPath, ['apps/server/dist/apps/server/src/main.js'], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    SERVER_PORT: serverPort,
    AGENT_CLUSTER_PERSISTENCE: 'true',
    AGENT_CLUSTER_PERSISTENCE_BACKEND: 'file',
    AGENT_CLUSTER_DATA_FILE: dataFile,
    AGENT_CLUSTER_SEED_DEFAULT_AGENTS: 'true',
    DEFAULT_AGENT_RUNTIME_TYPE: 'generic_llm',
    LLM_PROVIDER: 'openai-compatible',
    LLM_MODEL: 'discussion-timeout-smoke-model',
    LLM_API_KEY: 'discussion-timeout-smoke-key',
    LLM_BASE_URL: `http://127.0.0.1:${llmPort}/v1`,
    LLM_TIMEOUT_MS: '5000',
    LLM_MAX_RETRIES: '0',
    LLM_DRY_RUN: 'false',
    LLM_MOCK_FALLBACK: 'false',
    MOCK_RUNTIME_ENABLED: 'false',
    DISCUSSION_AGENT_KEYS: 'requirements',
    DISCUSSION_MAX_ROUNDS: '1',
    DISCUSSION_TIMEOUT_MS: '50'
  }
});

server.stdout.on('data', (chunk) => process.stdout.write(chunk));
server.stderr.on('data', (chunk) => process.stderr.write(chunk));

try {
  await waitForServer(apiBase);
  const created = await api(apiBase, '/sessions', {
    method: 'POST',
    body: JSON.stringify({
      input: 'Trigger a slow discussion and still generate a task brief.',
      agentIds: ['coordinator', 'requirements', 'backend'],
      tokenBudget: 50_000
    })
  });
  const sessionId = created.data.session.id;
  await waitForEvent(apiBase, sessionId, 'brief_created', 20_000);
  await waitForStatus(apiBase, sessionId, 'WAIT_USER_CONFIRM', 20_000);

  const invocations = await api(apiBase, `/sessions/${sessionId}/debug/runtime-invocations`);
  const discussionInvocation = invocations.data.items.find((item) => item.phase === 'discussion');
  if (!discussionInvocation) {
    throw new Error(`Expected a discussion runtime invocation: ${JSON.stringify(invocations.data.items)}`);
  }
  if (discussionInvocation.status !== 'failed' || discussionInvocation.error?.code !== 'RUNTIME_TIMEOUT') {
    throw new Error(`Expected discussion invocation to time out: ${JSON.stringify(discussionInvocation)}`);
  }
  const briefInvocation = invocations.data.items.find((item) => item.phase === 'brief_generation');
  if (!briefInvocation || briefInvocation.status !== 'completed') {
    throw new Error(`Expected brief generation to complete: ${JSON.stringify(invocations.data.items)}`);
  }

  const discussionMessages = (await listEvents(apiBase, sessionId)).filter(
    (event) => event.type === 'agent_message' && event.metadata.payload?.round === 1
  );
  if (!discussionMessages.some((event) => event.metadata.payload?.messageKind === 'risk')) {
    throw new Error(`Expected a risk discussion message after timeout: ${JSON.stringify(discussionMessages)}`);
  }
  const agentStatusEvents = (await listEvents(apiBase, sessionId)).filter((event) => event.type === 'agent_status_changed');
  if (!agentStatusEvents.some((event) => event.metadata.payload?.status === 'discussing')) {
    throw new Error(`Expected a visible discussing agent status: ${JSON.stringify(agentStatusEvents)}`);
  }
  if (!agentStatusEvents.some((event) => event.metadata.payload?.status === 'waiting')) {
    throw new Error(`Expected a visible waiting status after discussion timeout: ${JSON.stringify(agentStatusEvents)}`);
  }
  if (!llmRequests.some((item) => item.phase === 'discussion') || !llmRequests.some((item) => item.phase === 'brief_generation')) {
    throw new Error(`Expected both discussion and brief LLM calls: ${JSON.stringify(llmRequests)}`);
  }

  console.log('discussion timeout brief smoke ok');
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
  await new Promise((resolve) => llmServer.close(resolve));
  rmSync(dataFile, { force: true });
}
