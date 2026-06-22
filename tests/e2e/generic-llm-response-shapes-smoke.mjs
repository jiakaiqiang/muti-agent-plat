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

function runtimeOutput(summary) {
  return {
    kind: 'task_execution_result',
    schemaVersion: '0.1',
    status: 'completed',
    summary,
    completedItems: [summary],
    changedArtifacts: [],
    nextSuggestedActions: [],
    risks: []
  };
}

const responseShapes = [
  {
    name: 'message content parts',
    createBody: (model) => ({
      id: 'chatcmpl-content-parts-smoke',
      object: 'chat.completion',
      model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: JSON.stringify(runtimeOutput('Parsed message content parts.')) }]
          },
          finish_reason: 'stop'
        }
      ],
      usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 }
    })
  },
  {
    name: 'choice text',
    createBody: (model) => ({
      id: 'chatcmpl-choice-text-smoke',
      object: 'chat.completion',
      model,
      choices: [
        {
          index: 0,
          text: JSON.stringify(runtimeOutput('Parsed choice text.')),
          finish_reason: 'stop'
        }
      ],
      usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 }
    })
  },
  {
    name: 'responses output text',
    createBody: (model) => ({
      id: 'resp-output-text-smoke',
      object: 'response',
      model,
      output_text: JSON.stringify(runtimeOutput('Parsed output_text.')),
      usage: { input_tokens: 7, output_tokens: 11, total_tokens: 18 }
    })
  },
  {
    name: 'responses output array',
    createBody: (model) => ({
      id: 'resp-output-array-smoke',
      object: 'response',
      model,
      output: [
        {
          type: 'message',
          content: [{ type: 'output_text', text: JSON.stringify(runtimeOutput('Parsed output array.')) }]
        }
      ],
      usage: { input_tokens: 9, output_tokens: 13, total_tokens: 22 }
    })
  }
];

await buildServer();

const llmRequests = [];
let requestIndex = 0;
const llmPort = await findFreePort();
const llmServer = createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'not_found' }));
    return;
  }

  const body = await readJsonRequest(request);
  llmRequests.push(body);
  const shape = responseShapes[requestIndex] ?? responseShapes.at(-1);
  requestIndex += 1;

  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(shape.createBody(body.model)));
});
await new Promise((resolve) => llmServer.listen(llmPort, '127.0.0.1', resolve));

const serverHandle = await startSmokeServer('generic-llm-response-shapes', {
  DEFAULT_AGENT_RUNTIME_TYPE: 'generic_llm',
  LLM_PROVIDER: 'openai-compatible',
  LLM_MODEL: 'response-shapes-smoke-model',
  LLM_API_KEY: 'response-shapes-smoke-key',
  LLM_BASE_URL: `http://127.0.0.1:${llmPort}/v1`,
  LLM_DRY_RUN: 'false',
  LLM_MOCK_FALLBACK: 'false',
  MOCK_RUNTIME_ENABLED: 'false'
});

try {
  for (const shape of responseShapes) {
    const result = (await api(serverHandle.apiBase, '/runtimes/generic-llm/smoke')).data;
    if (result.status !== 'completed' || result.output?.kind !== 'task_execution_result') {
      throw new Error(`${shape.name} was not parsed: ${JSON.stringify(result)}`);
    }
    if (!result.output.summary.includes('Parsed')) {
      throw new Error(`${shape.name} returned the wrong output: ${JSON.stringify(result.output)}`);
    }
    if (result.usage?.model !== 'response-shapes-smoke-model') {
      throw new Error(`${shape.name} used the wrong model: ${JSON.stringify(result.usage)}`);
    }
  }

  if (llmRequests.length !== responseShapes.length) {
    throw new Error(`Expected ${responseShapes.length} LLM requests, got ${llmRequests.length}`);
  }

  console.log('generic llm response shapes smoke ok');
} finally {
  await stopSmokeServer(serverHandle);
  await new Promise((resolve) => llmServer.close(resolve));
}
