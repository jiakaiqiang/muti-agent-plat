import { createServer } from 'node:http';
import { api, buildServer, findFreePort, startSmokeServer, stopSmokeServer } from './smoke-server.mjs';

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

await buildServer();

const requests = [];
const llmPort = await findFreePort();
const llmServer = createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/api/tags') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        models: [{ name: 'ollama-local-smoke-model', model: 'ollama-local-smoke-model' }]
      })
    );
    return;
  }

  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'not_found' }));
    return;
  }

  const body = await readJsonRequest(request);
  requests.push(body);
  if (Object.hasOwn(body, 'response_format')) {
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'local ollama smoke should not receive response_format' }));
    return;
  }

  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(
    JSON.stringify({
      id: 'chatcmpl-ollama-local-smoke',
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
              summary: 'Ollama local runtime completed without response_format.',
              completedItems: ['Local runtime request omitted response_format'],
              changedArtifacts: [],
              nextSuggestedActions: [],
              risks: []
            }),
            reasoning: 'Local Ollama-compatible models may include reasoning separately.'
          },
          finish_reason: 'stop'
        }
      ],
      usage: { prompt_tokens: 6, completion_tokens: 8, total_tokens: 14 }
    })
  );
});
await new Promise((resolve) => llmServer.listen(llmPort, '127.0.0.1', resolve));

const serverHandle = await startSmokeServer('generic-llm-ollama-local', {
  DEFAULT_AGENT_RUNTIME_TYPE: 'generic_llm',
  LLM_PROVIDER: 'ollama',
  LLM_MODEL: 'ollama-local-smoke-model',
  LLM_BASE_URL: `http://127.0.0.1:${llmPort}/v1`,
  LLM_DRY_RUN: 'false',
  LLM_MOCK_FALLBACK: 'false',
  MOCK_RUNTIME_ENABLED: 'false'
});

try {
  const result = (await api(serverHandle.apiBase, '/runtimes/generic-llm/smoke')).data;
  if (result.status !== 'completed') {
    throw new Error(`Ollama local smoke did not complete: ${JSON.stringify(result)}`);
  }
  if (requests.length !== 1) {
    throw new Error(`Expected one LLM request, got ${requests.length}`);
  }
  if (Object.hasOwn(requests[0], 'response_format')) {
    throw new Error(`Local Ollama request included response_format: ${JSON.stringify(requests[0])}`);
  }
  if (requests[0].stream !== false || requests[0].max_tokens !== 1024 || requests[0].options?.num_ctx !== 8192) {
    throw new Error(`Local Ollama request missed local runtime guards: ${JSON.stringify(requests[0])}`);
  }

  console.log('generic llm ollama local smoke ok');
} finally {
  await stopSmokeServer(serverHandle);
  await new Promise((resolve) => llmServer.close(resolve));
}
