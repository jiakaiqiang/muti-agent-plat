import { createServer } from 'node:http';
import { rmSync } from 'node:fs';
import { buildServer, findFreePort, root, waitForEvent, waitForServer, waitForStatus } from './smoke-server.mjs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

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

function runtimeOutputFor(body) {
  const userMessage = body.messages?.find((message) => message.role === 'user');
  const request = JSON.parse(userMessage?.content ?? '{}');
  const kind = request.expectedOutput?.kind;

  if (kind === 'agent_message') {
    return {
      kind,
      messageKind: 'discussion',
      content: 'Runtime model switch session discussion completed.'
    };
  }

  if (kind === 'task_brief') {
    return {
      kind,
      goal: 'Verify switched model across the session execution path.',
      scope: ['Session-level runtime invocation uses selected model'],
      outOfScope: [],
      constraints: ['Use the configured OpenAI-compatible runtime'],
      acceptanceCriteria: ['Every runtime request uses the switched model id'],
      risks: [],
      openQuestions: [],
      suggestedTasks: [
        {
          title: 'Verify session runtime model',
          description: 'Run a task after switching the active model.',
          suggestedAgentKey: 'backend',
          acceptanceCriteria: ['The LLM request body contains the switched model id']
        }
      ]
    };
  }

  if (kind === 'task_execution_result') {
    return {
      kind,
      schemaVersion: '0.1',
      status: 'completed',
      summary: 'Runtime model switch session task completed.',
      completedItems: ['The selected model was used by a session task runtime request'],
      changedArtifacts: [],
      nextSuggestedActions: [],
      risks: []
    };
  }

  if (kind === 'post_review_report') {
    return {
      kind,
      isConsistentWithBrief: true,
      matchedItems: ['Selected model was used for runtime requests'],
      mismatchedItems: [],
      missingItems: [],
      outOfScopeChanges: [],
      testResults: ['session runtime model switch passed'],
      recommendation: 'deliver'
    };
  }

  if (kind === 'final_delivery') {
    return {
      kind,
      summary: 'Session-level runtime model switch verified.',
      completedItems: ['All session runtime calls used the switched model'],
      incompleteItems: [],
      risks: [],
      artifactRefs: []
    };
  }

  throw new Error(`Unsupported runtime output kind: ${String(kind)}`);
}

await buildServer();

const llmRequests = [];
const remoteRequests = [];
const llmPort = await findFreePort();
const remotePort = await findFreePort();
const dataFile = join(root, '.cache', 'agent-cluster', `runtime-model-switch-${Date.now()}.json`);
function createLlmServer(targetRequests) {
  return createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'not_found' }));
    return;
  }

  const body = await readJsonRequest(request);
  targetRequests.push({ ...body, authorization: request.headers.authorization });
  const output = runtimeOutputFor(body);
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(
    JSON.stringify({
      id: 'chatcmpl-model-switch-smoke',
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
        prompt_tokens: 5,
        completion_tokens: 7,
        total_tokens: 12
      }
    })
  );
  });
}
const llmServer = createLlmServer(llmRequests);
const remoteServer = createLlmServer(remoteRequests);
await new Promise((resolve) => llmServer.listen(llmPort, '127.0.0.1', resolve));
await new Promise((resolve) => remoteServer.listen(remotePort, '127.0.0.1', resolve));

const serverPort = await findFreePort();
const apiBase = `http://127.0.0.1:${serverPort}/api`;
const server = spawn(process.execPath, ['apps/server/dist/apps/server/src/main.js'], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    SERVER_PORT: serverPort,
    AGENT_CLUSTER_DATA_FILE: dataFile,
    DEFAULT_AGENT_RUNTIME_TYPE: 'generic_llm',
    LLM_PROVIDER: 'openai-compatible',
    LLM_MODEL: 'initial-smoke-model',
    LLM_MODEL_OPTIONS: 'initial-smoke-model,switched-smoke-model',
    LLM_API_KEY: 'model-switch-smoke-key',
    LLM_BASE_URL: `http://127.0.0.1:${llmPort}/v1`,
    DISCUSSION_MAX_ROUNDS: '0',
    AGENT_CLUSTER_SEED_DEFAULT_AGENTS: 'true',
    LLM_DRY_RUN: 'false',
    LLM_MOCK_FALLBACK: 'false',
    MOCK_RUNTIME_ENABLED: 'false'
  }
});

server.stdout.on('data', (chunk) => process.stdout.write(chunk));
server.stderr.on('data', (chunk) => process.stderr.write(chunk));

try {
  await waitForServer(apiBase);

  const initial = await api(apiBase, '/runtimes/model-config');
  if (initial.data.currentModel !== 'initial-smoke-model') {
    throw new Error(`Unexpected initial model config: ${JSON.stringify(initial.data)}`);
  }
  if (!initial.data.availableModels.some((model) => model.model === 'switched-smoke-model')) {
    throw new Error(`Configured model option was not exposed: ${JSON.stringify(initial.data.availableModels)}`);
  }

  const remoteConfig = await api(apiBase, '/runtimes/model-config/models', {
    method: 'POST',
    body: JSON.stringify({
      kind: 'remote',
      label: 'Remote Smoke Model',
      model: 'remote-smoke-model',
      baseUrl: `http://127.0.0.1:${remotePort}/v1`,
      apiKey: 'remote-smoke-key'
    })
  });
  if (
    remoteConfig.data.currentModel !== 'remote-smoke-model' ||
    remoteConfig.data.currentModelOption?.kind !== 'remote' ||
    !remoteConfig.data.currentModelOption?.hasApiKey
  ) {
    throw new Error(`Remote model was not added as the active model: ${JSON.stringify(remoteConfig.data)}`);
  }

  const remoteSmoke = await api(apiBase, '/runtimes/generic-llm/smoke');
  if (remoteSmoke.data.usage?.model !== 'remote-smoke-model') {
    throw new Error(`Remote runtime usage did not report remote model: ${JSON.stringify(remoteSmoke.data.usage)}`);
  }
  if (remoteRequests.length !== 1 || remoteRequests[0].model !== 'remote-smoke-model') {
    throw new Error(`Remote LLM endpoint was not used: ${JSON.stringify({ llmRequests, remoteRequests })}`);
  }
  if (remoteRequests[0].authorization !== 'Bearer remote-smoke-key') {
    throw new Error(`Remote LLM request used wrong key: ${JSON.stringify(remoteRequests[0])}`);
  }

  const switched = await api(apiBase, '/runtimes/model-config/switch', {
    method: 'POST',
    body: JSON.stringify({ model: 'switched-smoke-model' })
  });
  if (switched.data.currentModel !== 'switched-smoke-model') {
    throw new Error(`Model switch was not persisted in response: ${JSON.stringify(switched.data)}`);
  }

  const smoke = await api(apiBase, '/runtimes/generic-llm/smoke');
  if (smoke.data.status !== 'completed') {
    throw new Error(`Generic LLM smoke did not complete: ${JSON.stringify(smoke.data)}`);
  }
  if (smoke.data.usage?.model !== 'switched-smoke-model') {
    throw new Error(`Runtime usage did not report switched model: ${JSON.stringify(smoke.data.usage)}`);
  }
  if (llmRequests.length !== 1 || llmRequests[0].model !== 'switched-smoke-model') {
    throw new Error(`LLM request did not use switched model: ${JSON.stringify(llmRequests)}`);
  }

  const created = await api(apiBase, '/sessions', {
    method: 'POST',
    body: JSON.stringify({
      input: 'Verify runtime model switch through a real session.',
      agentIds: ['coordinator', 'backend', 'test', 'review', 'notification'],
      tokenBudget: 50_000
    })
  });
  const sessionId = created.data.session.id;
  const briefEvent = await waitForEvent(apiBase, sessionId, 'brief_created');
  const briefId = briefEvent.metadata.payload.briefId;
  await api(apiBase, `/sessions/${sessionId}/briefs/${briefId}/confirm`, { method: 'POST' });
  await waitForStatus(apiBase, sessionId, 'COMPLETED');

  const invocations = await api(apiBase, `/sessions/${sessionId}/debug/runtime-invocations`);
  const wrongInvocation = invocations.data.items.find((item) => item.usage?.model !== 'switched-smoke-model');
  if (wrongInvocation) {
    throw new Error(`Session runtime invocation reported wrong model: ${JSON.stringify(wrongInvocation)}`);
  }
  const wrongRequest = llmRequests.find((request) => request.model !== 'switched-smoke-model');
  if (wrongRequest) {
    throw new Error(`Session LLM request used wrong model: ${JSON.stringify(llmRequests)}`);
  }

  console.log('runtime model switch smoke ok');
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
  await new Promise((resolve) => remoteServer.close(resolve));
  rmSync(dataFile, { force: true });
}
