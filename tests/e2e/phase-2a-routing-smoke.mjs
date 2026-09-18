import assert from 'node:assert/strict';
import {
  api,
  buildServer,
  createSessionAndWaitForBrief,
  listEvents,
  startSmokeServer,
  stopSmokeServer,
  waitForMatchingEvent
} from './smoke-server.mjs';

const TERMINAL_ROUTING_STATUSES = new Set(['ROUTED', 'CLARIFICATION_REQUIRED', 'FAILED']);

async function waitForRouting(apiBase, sessionId, routingId, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    const response = await api(apiBase, `/sessions/${sessionId}/message-routings/${routingId}`);
    const routing = response.routing ?? response.data?.routing ?? response.data ?? response;
    last = routing;
    if (TERMINAL_ROUTING_STATUSES.has(routing.status)) return routing;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for routing ${routingId}: ${JSON.stringify(last)}`);
}

await buildServer();

let server;

try {
  server = await startSmokeServer('phase-2a-routing-smoke', {
    DISCUSSION_MAX_ROUNDS: '0',
    GLOBAL_DEFAULT_RUNTIME_TYPE: 'mock',
    INTENT_ROUTING_MODE: 'enforce_new_sessions'
  });

  const { sessionId } = await createSessionAndWaitForBrief(
    server.apiBase,
    '修复登录流程，并保留现有的审批边界。',
    {
      runtimePreference: { preferredRuntimeType: 'mock', allowedRuntimeTypes: ['mock'] }
    }
  );

  const content = '先继续修复登录问题，再新增导出功能。';
  const idempotencyKey = 'phase-2a-web-desktop-shared-message';
  const submitFromClient = () => api(server.apiBase, `/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'idempotency-key': idempotencyKey },
    body: JSON.stringify({ content })
  });

  // Model the Web and desktop clients reaching the same server concurrently.
  const [webSubmission, desktopSubmission] = await Promise.all([submitFromClient(), submitFromClient()]);
  assert.equal(webSubmission.data.event.id, desktopSubmission.data.event.id);
  assert.equal(webSubmission.data.followUpMessageId, desktopSubmission.data.followUpMessageId);
  assert.equal(webSubmission.data.routingId, desktopSubmission.data.routingId);
  assert.equal(
    [webSubmission.data.idempotentReplay, desktopSubmission.data.idempotentReplay].filter(Boolean).length,
    1,
    'one concurrent submission must be the idempotent replay'
  );

  const routing = await waitForRouting(server.apiBase, sessionId, webSubmission.data.routingId);
  assert.equal(routing.status, 'CLARIFICATION_REQUIRED');
  assert.equal(routing.decision.scopeRelation, 'ambiguous');
  assert.equal(routing.decision.requestedAction, 'clarify');
  assert.ok(
    routing.reasonCodes.includes('MOCK_INTENT_ROUTING_SAFE_CLARIFY'),
    `the valid router decision must travel through the real HTTP chain: ${JSON.stringify(routing)}`
  );

  const clarification = await waitForMatchingEvent(
    server.apiBase,
    sessionId,
    'intent_clarification_required',
    (event) => event.metadata.payload?.routingId === webSubmission.data.routingId
  );
  assert.equal(clarification.metadata.payload?.description, content);
  const events = await listEvents(server.apiBase, sessionId);
  assert.equal(
    events.filter((event) => event.type === 'user_message' && event.content === content).length,
    1,
    'two client submissions with one idempotency key must create one business message'
  );

  console.log('phase 2A routing smoke ok: concurrent idempotency and multi-intent clarification used the real HTTP chain');
} finally {
  if (server) await stopSmokeServer(server);
}
