import { createServer } from 'node:http';
import {
  buildServer,
  confirmBriefAndSelectWorkflow,
  createPublishedAgentWorkflow,
  createSessionAndWaitForBrief,
  findFreePort,
  listEvents,
  startSmokeServer,
  stopSmokeServer,
  waitForMatchingEvent,
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

function runtimeOutputFor(body) {
  const userMessage = body.messages?.find((message) => message.role === 'user');
  const request = JSON.parse(userMessage?.content ?? '{}');
  const kind = request.expectedOutput?.kind;
  if (kind === 'agent_message') {
    return {
      schemaVersion: '1.0', kind, messageKind: 'discussion', content: 'Runtime communication discussion completed.',
      targetAgentIds: [], targetAgentKeys: [], mentionedAgentIds: [], relatedTaskIds: []
    };
  }
  if (kind === 'task_brief') {
    return {
      schemaVersion: '1.0', kind, goal: 'Verify runtime Agent communication.', scope: [], outOfScope: [], constraints: [],
      acceptanceCriteria: ['Runtime message is visible before task completion'], risks: [], openQuestions: [], suggestedTasks: []
    };
  }
  if (kind === 'task_acceptance_decision') {
    return {
      schemaVersion: '1.0', kind, status: 'accepted', reason: 'The communication task has sufficient context.',
      missingContext: [], requestedContext: null, handoffSuggestion: null, confidence: 1,
      alternativeAgentKeys: [], alternativeAgentIds: [], agentMessages: []
    };
  }
  if (kind === 'task_execution_result') {
    return {
      schemaVersion: '1.0', kind, status: 'completed', summary: 'Runtime Agent coordinated with a peer reviewer.',
      completedItems: ['Sent a peer review request'], changedArtifacts: [], requestedContext: null,
      agentMessages: [{
        schemaVersion: '1.0', kind: 'agent_message', messageKind: 'progress',
        content: 'Please review the runtime execution result.', targetAgentIds: [], targetAgentKeys: ['review'],
        mentionedAgentIds: [], relatedTaskIds: []
      }],
      nextSuggestedActions: [], risks: []
    };
  }
  if (kind === 'post_review_report') {
    return {
      schemaVersion: '1.0', kind, isConsistentWithBrief: true, matchedItems: ['Runtime message was emitted'],
      mismatchedItems: [], missingItems: [], outOfScopeChanges: [], testResults: ['communication smoke passed'],
      recommendation: 'deliver', actions: []
    };
  }
  if (kind === 'final_delivery') {
    return {
      schemaVersion: '1.0', kind, summary: 'Runtime Agent communication verified.',
      completedItems: ['Peer message emitted'], incompleteItems: [], risks: [], artifactRefs: []
    };
  }
  throw new Error(`Unsupported runtime output kind: ${String(kind)}`);
}

await buildServer();

let server;
const llmPort = await findFreePort();
const llmServer = createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'not_found' }));
    return;
  }
  const body = await readJsonRequest(request);
  const output = runtimeOutputFor(body);
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({
    id: 'chatcmpl-runtime-agent-communication', object: 'chat.completion', model: body.model,
    choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(output) }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 }
  }));
});
await new Promise((resolve) => llmServer.listen(llmPort, '127.0.0.1', resolve));

try {
  server = await startSmokeServer('runtime-agent-communication-smoke', {
    DISCUSSION_MAX_ROUNDS: '0',
    GLOBAL_DEFAULT_RUNTIME_TYPE: 'generic_llm',
    LLM_PROVIDER: 'openai-compatible',
    LLM_MODEL: 'runtime-agent-communication-smoke',
    LLM_API_KEY: 'runtime-agent-communication-key',
    LLM_BASE_URL: `http://127.0.0.1:${llmPort}/v1`,
    LLM_DRY_RUN: 'false',
    LLM_MOCK_FALLBACK: 'false',
    MOCK_RUNTIME_ENABLED: 'false'
  });
  const workflow = await createPublishedAgentWorkflow(
    server.apiBase,
    'Runtime agent communication smoke',
    ['requirements']
  );

  const { sessionId, briefId } = await createSessionAndWaitForBrief(
    server.apiBase,
    'Analyze a collaboration plan and let the runtime Agent coordinate with peer reviewers during execution.',
    { runtimePreference: { preferredRuntimeType: 'generic_llm', allowedRuntimeTypes: ['generic_llm'] } }
  );

  await confirmBriefAndSelectWorkflow(server.apiBase, sessionId, briefId, workflow);

  const communication = await waitForMatchingEvent(
    server.apiBase,
    sessionId,
    'agent_message',
    (event) => event.metadata.payload?.phase === 'agent_runtime_communication',
    30_000
  );

  if (!communication.taskId) {
    throw new Error('Runtime agent communication must be associated with the executing task.');
  }
  if (communication.actor?.type !== 'agent') {
    throw new Error('Runtime agent communication must record the sending agent ActorRef.');
  }
  if (!Array.isArray(communication.toAgentIds) || communication.toAgentIds.length === 0) {
    throw new Error('Runtime agent communication must target at least one peer agent.');
  }
  if (!communication.metadata.payload?.runtimeInvocationId) {
    throw new Error('Runtime agent communication must reference the runtime invocation.');
  }
  if (!communication.metadata.payload?.relatedTaskIds?.includes(communication.taskId)) {
    throw new Error('Runtime agent communication must include the executing task in relatedTaskIds.');
  }

  const events = await listEvents(server.apiBase, sessionId);
  const communicationIndex = events.findIndex((event) => event.id === communication.id);
  const taskCompletionIndex = events.findIndex(
    (event) => event.type === 'task_completed' && event.taskId === communication.taskId
  );
  if (taskCompletionIndex !== -1 && taskCompletionIndex < communicationIndex) {
    throw new Error('Runtime agent communication should be visible no later than task completion.');
  }

  await waitForStatus(server.apiBase, sessionId, 'COMPLETED', 60_000);

  console.log('runtime agent communication smoke ok');
} finally {
  if (server) {
    await stopSmokeServer(server);
  }
  await new Promise((resolve) => llmServer.close(resolve));
}
