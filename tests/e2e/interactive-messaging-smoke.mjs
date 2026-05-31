// Regression for interactive user-message routing (question / constraint / new-task).
//
// These handlers ask the runtime for `kind: 'agent_message'` but with a *custom* jsonSchema
// (answer / relevant+response / taskTitle...). GenericLlmRuntime.normalizeRuntimeOutput must
// preserve those caller-requested fields; an earlier version rebuilt a fixed agent_message shape
// and dropped them, so answers came back empty, constraints were never acknowledged, and
// new-task requests created title-less tasks. We drive the real runtime path with a fake
// OpenAI-compatible server (deterministic, no Ollama dependency) and assert the fields survive.

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const npmCli = process.env.npm_execpath;
const dataFile = join(root, '.cache', 'agent-cluster', `interactive-msg-${Date.now()}.json`);

const ANSWER_TEXT = '预计需要约 2 小时完成。';
const CONSTRAINT_ACK_TEXT = '收到约束，我会避免引入第三方依赖。';
const NEW_TASK_TITLE = '健康检查接口';

// Filled in once the server is up and we know a real agent id to assign new tasks to.
let assigneeAgentId = 'coordinator';

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
      if (response.ok) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw lastError ?? new Error('Server did not become ready');
}

// Canned, contract-shaped payloads keyed off the expectedOutput the orchestrator asks for.
function payloadForExpected(expected) {
  const kind = expected?.kind;
  if (kind === 'task_brief') {
    return {
      kind: 'task_brief',
      goal: '交付一个简单的 HTTP 服务',
      scope: ['实现基础路由'],
      outOfScope: [],
      constraints: [],
      acceptanceCriteria: ['服务可启动'],
      risks: [],
      openQuestions: [],
      suggestedTasks: [{ title: '搭建 HTTP 服务骨架', description: '初始化项目并提供根路由', acceptanceCriteria: ['返回 200'] }]
    };
  }
  if (kind === 'task_execution_result') {
    return {
      kind: 'task_execution_result',
      status: 'completed',
      summary: '任务已完成',
      completedItems: ['实现了接口'],
      changedArtifacts: [],
      nextSuggestedActions: [],
      risks: []
    };
  }
  if (kind === 'post_review_report') {
    return {
      kind: 'post_review_report',
      isConsistentWithBrief: true,
      matchedItems: [],
      mismatchedItems: [],
      missingItems: [],
      outOfScopeChanges: [],
      testResults: [],
      recommendation: 'deliver'
    };
  }
  if (kind === 'final_delivery') {
    return { kind: 'final_delivery', summary: '交付完成', completedItems: [], incompleteItems: [], risks: [], artifactRefs: [] };
  }
  if (kind === 'agent_message') {
    const props = expected?.jsonSchema?.properties ?? {};
    // handleQuestion
    if ('answer' in props) {
      return { kind: 'agent_message', answer: ANSWER_TEXT, references: [] };
    }
    // handleClarificationOrConstraint (per-agent relevance)
    if ('relevant' in props) {
      return { kind: 'agent_message', relevant: true, reason: '与我负责的任务相关', response: CONSTRAINT_ACK_TEXT };
    }
    // handleNewTaskRequest
    if ('taskTitle' in props) {
      return {
        kind: 'agent_message',
        taskTitle: NEW_TASK_TITLE,
        taskDescription: '新增 /health 健康检查端点',
        assigneeAgentId,
        acceptanceCriteria: ['GET /health 返回 200']
      };
    }
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
    expected = JSON.parse(userMessage?.content ?? '{}').expectedOutput;
  } catch {
    expected = undefined;
  }
  const payload = payloadForExpected(expected);
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(
    JSON.stringify({
      id: 'chatcmpl-interactive-smoke',
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
    DEFAULT_AGENT_RUNTIME_TYPE: 'generic_llm',
    LLM_PROVIDER: 'openai-compatible',
    LLM_MODEL: 'interactive-smoke-model',
    LLM_API_KEY: 'interactive-smoke-key',
    LLM_BASE_URL: `http://127.0.0.1:${llmPort}/v1`,
    LLM_DRY_RUN: 'false',
    LLM_MOCK_FALLBACK: 'false',
    MOCK_RUNTIME_ENABLED: 'false'
  }
});
let serverLogs = '';
server.stdout.on('data', (chunk) => (serverLogs += chunk));
server.stderr.on('data', (chunk) => (serverLogs += chunk));

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function api(path, init) {
  const response = await fetch(`${apiBase}${path}`, init);
  const text = await response.text();
  const json = text ? JSON.parse(text) : undefined;
  if (!response.ok) {
    throw new Error(`${path} -> HTTP ${response.status}: ${text}`);
  }
  return json;
}

async function postMessage(sessionId, content) {
  return api(`/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content })
  });
}

async function events(sessionId) {
  return (await api(`/sessions/${sessionId}/events?limit=200`)).data.items;
}

try {
  await waitForServer(apiBase);

  const agents = (await api('/agents')).data;
  assert(Array.isArray(agents) && agents.length > 0, 'expected seeded agents');
  const coordinator = agents.find((agent) => agent.role === 'coordinator') ?? agents[0];
  assigneeAgentId = coordinator.id;

  // Create a session (blocks until the brief is generated -> WAIT_USER_CONFIRM).
  const created = await api('/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input: '帮我写一个简单的 HTTP 服务', agentIds: agents.map((agent) => agent.id), tokenBudget: 50_000 })
  });
  const sessionId = created.data.session.id;
  assert(created.data.session.status === 'WAIT_USER_CONFIRM', `expected WAIT_USER_CONFIRM, got ${created.data.session.status}`);

  // Scenario 1: question -> coordinator answers, answer text must survive normalization.
  await postMessage(sessionId, '这个任务大概需要多久？');
  const afterQuestion = await events(sessionId);
  const answer = afterQuestion.filter((event) => event.metadata?.payload?.messageKind === 'answer').at(-1);
  assert(answer, 'expected an answer event for the question');
  assert(answer.content === ANSWER_TEXT, `answer content was dropped/normalized away: ${JSON.stringify(answer.content)}`);
  console.log('scenario 1 ok: question answered with preserved answer field');

  // Scenario 2: constraint -> at least one agent acknowledges, response text must survive.
  await postMessage(sessionId, '不要使用任何第三方库');
  const afterConstraint = await events(sessionId);
  const ack = afterConstraint.filter((event) => event.metadata?.payload?.messageKind === 'constraint_ack').at(-1);
  assert(ack, 'expected a constraint_ack event (relevant field was dropped if missing)');
  assert(ack.content === CONSTRAINT_ACK_TEXT, `constraint_ack content was dropped: ${JSON.stringify(ack.content)}`);
  console.log('scenario 2 ok: constraint acknowledged with preserved response field');

  // Scenario 3: new-task request -> task created from preserved taskTitle/assigneeAgentId.
  await postMessage(sessionId, '重新加一个健康检查接口');
  const tasks = (await api(`/sessions/${sessionId}/tasks`)).data;
  const newTask = tasks.find((task) => task.title === NEW_TASK_TITLE);
  assert(newTask, `expected a task titled "${NEW_TASK_TITLE}" (taskTitle/assignee fields were dropped if missing)`);
  assert(newTask.assigneeAgentId === assigneeAgentId, `new task assignee mismatch: ${newTask.assigneeAgentId}`);
  console.log('scenario 3 ok: new task created from preserved structured fields');

  console.log('interactive messaging smoke ok');
} catch (error) {
  process.stderr.write(serverLogs);
  throw error;
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
