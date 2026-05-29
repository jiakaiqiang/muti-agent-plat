import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const npmCli = process.env.npm_execpath;
const dataFile = join(root, '.cache', 'agent-cluster', `generic-llm-real-${Date.now()}.json`);

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

await runNpm(['run', 'build', '-w', '@agent-cluster/shared']);
await runNpm(['run', 'build', '-w', '@agent-cluster/server']);

const llmRequests = [];
const llmPort = await findFreePort();
const llmServer = createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'not_found' }));
    return;
  }

  const body = await readJsonRequest(request);
  llmRequests.push(body);

  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(
    JSON.stringify({
      id: 'chatcmpl-real-smoke',
      object: 'chat.completion',
      model: body.model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: JSON.stringify({
              kind: 'task_execution_result',
              schemaVersion: '0.1',
              status: 'completed',
              summary: 'Real OpenAI-compatible runtime smoke completed.',
              completedItems: ['HTTP chat completions endpoint was called'],
              risks: []
            })
          },
          finish_reason: 'stop'
        }
      ],
      usage: {
        prompt_tokens: 11,
        completion_tokens: 13,
        total_tokens: 24
      }
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
    DEFAULT_AGENT_RUNTIME_TYPE: 'generic_llm',
    LLM_PROVIDER: 'openai-compatible',
    LLM_MODEL: 'real-smoke-model',
    LLM_API_KEY: 'real-smoke-key',
    LLM_BASE_URL: `http://127.0.0.1:${llmPort}/v1`,
    LLM_DRY_RUN: 'false',
    LLM_MOCK_FALLBACK: 'false',
    MOCK_RUNTIME_ENABLED: 'false'
  }
});

server.stdout.on('data', (chunk) => process.stdout.write(chunk));
server.stderr.on('data', (chunk) => process.stderr.write(chunk));

try {
  await waitForServer(apiBase);
  const response = await fetch(`${apiBase}/runtimes/generic-llm/smoke`);
  if (!response.ok) {
    throw new Error(`Generic LLM smoke failed: ${response.status} ${await response.text()}`);
  }
  const body = await response.json();
  const result = body.data;

  if (result.runtimeType !== 'generic_llm' || result.status !== 'completed') {
    throw new Error(`Unexpected runtime result: ${JSON.stringify(result)}`);
  }
  if (result.usage?.model !== 'real-smoke-model' || result.usage?.totalTokens !== 24) {
    throw new Error(`Runtime usage did not come from the real-compatible response: ${JSON.stringify(result.usage)}`);
  }
  if (llmRequests.length !== 1) {
    throw new Error(`Expected one LLM HTTP request, got ${llmRequests.length}`);
  }
  if (llmRequests[0].model !== 'real-smoke-model') {
    throw new Error(`LLM request used wrong model: ${JSON.stringify(llmRequests[0])}`);
  }

  console.log('generic llm real smoke ok');
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
