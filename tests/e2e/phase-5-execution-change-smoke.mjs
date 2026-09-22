import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  api,
  buildServer,
  createPublishedAgentWorkflow,
  createSessionAndWaitForBrief,
  listEvents,
  selectPublishedWorkflow,
  startSmokeServer,
  stopSmokeServer,
  waitForMatchingEvent,
  waitForStatus
} from './smoke-server.mjs';

await buildServer();

let server;
const workspacePaths = [];
try {
  server = await startSmokeServer('phase-5-execution-change-smoke', {
    DISCUSSION_MAX_ROUNDS: '0',
    MAIN_AGENT_DISCUSSION_ENABLED: 'true',
    GLOBAL_DEFAULT_RUNTIME_TYPE: 'mock',
    MOCK_RUNTIME_DELAY_MS: '5000'
  });

  const workflow = await createPublishedAgentWorkflow(
    server.apiBase,
    'Phase 5 execution change smoke',
    ['requirements']
  );
  async function createCodeSession(input) {
    // Task execution requires a real workspace capability binding. Keep each
    // session on its own temporary directory so the lease also proves that
    // cross-session isolation is exercised by this E2E.
    const workspacePath = await mkdtemp(join(tmpdir(), 'agent-cluster-phase5-'));
    await writeFile(join(workspacePath, 'README.md'), '# Phase 5 execution fixture\n', 'utf8');
    workspacePaths.push(workspacePath);
    return createSessionAndWaitForBrief(
      server.apiBase,
      input,
      {
        workingDirectory: {
          kind: 'server_local',
          id: `phase-5-${workspacePaths.length}`,
          name: `phase-5-${workspacePaths.length}`,
          path: workspacePath,
          selectedAt: new Date().toISOString()
        },
        runtimePreference: { preferredRuntimeType: 'mock', allowedRuntimeTypes: ['mock'] }
      }
    );
  }

  const { sessionId, briefId } = await createCodeSession('实现订单导出功能。');
  await api(server.apiBase, `/sessions/${sessionId}/briefs/${briefId}/confirm`, { method: 'POST' });
  await selectPublishedWorkflow(server.apiBase, sessionId, workflow);
  await waitForStatus(server.apiBase, sessionId, 'EXECUTING');

  const content = '先停下来，另外把接口改成分页';
  const submit = () => api(server.apiBase, `/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'idempotency-key': 'phase-5-shared-stop-and-change' },
    body: JSON.stringify({ content })
  });
  const [web, desktop] = await Promise.all([submit(), submit()]);
  assert.equal(web.data.event.id, desktop.data.event.id, 'Web and desktop replay one user message');
  assert.equal(
    [web.data.idempotentReplay, desktop.data.idempotentReplay].filter(Boolean).length,
    1,
    'only one client submission performs the mutation'
  );

  await waitForStatus(server.apiBase, sessionId, 'PAUSED');
  const events = await listEvents(server.apiBase, sessionId);
  const confirmation = await waitForMatchingEvent(
    server.apiBase,
    sessionId,
    'user_confirmation_requested',
    (event) => event.metadata.payload?.reason === 'execution_scope_change'
  );
  assert.ok(confirmation.metadata.payload?.changeRequestId);
  assert.match(confirmation.content, /分页/);
  assert.equal(
    confirmation.metadata.payload?.options?.map((option) => option.key).sort().join(','),
    'defer,pause_and_revise,reject',
    'the persisted card exposes the complete user choice set'
  );
  assert.equal(
    events.filter((event) => event.type === 'user_confirmation_requested'
      && event.metadata.payload?.reason === 'execution_scope_change').length,
    1,
    'the compound message raises one scope-change card'
  );
  assert.equal(
    events.filter((event) => event.type === 'user_message'
      && event.metadata.payload?.text === content).length,
    1,
    'the complete compound message is persisted once'
  );

  const pauseCardId = confirmation.metadata.payload.confirmationId;
  await api(server.apiBase, `/sessions/${sessionId}/change-requests/decision`, {
    method: 'POST',
    body: JSON.stringify({ confirmationId: pauseCardId, choice: 'pause_and_revise' })
  });
  await waitForStatus(server.apiBase, sessionId, 'PAUSED');
  const pausedEvents = await listEvents(server.apiBase, sessionId);
  assert.ok(
    pausedEvents.some((event) => event.type === 'user_confirmation_resolved'
      && event.metadata.payload?.selectedOptionKey === 'pause_and_revise'),
    'pause-and-revise records the user decision after the stop barrier'
  );

  async function startExecution(input) {
    const created = await createCodeSession(input);
    await api(server.apiBase, `/sessions/${created.sessionId}/briefs/${created.briefId}/confirm`, { method: 'POST' });
    await selectPublishedWorkflow(server.apiBase, created.sessionId, workflow);
    await waitForStatus(server.apiBase, created.sessionId, 'EXECUTING');
    return created.sessionId;
  }

  const queuedSessionId = await startExecution('实现订单列表查询。');
  const queuedChanges = [
    { content: '顺便增加 CSV 导出', key: 'phase-5-queue-1' },
    { content: '另外增加分页接口', key: 'phase-5-queue-2' }
  ];
  const queuedCards = [];
  for (const change of queuedChanges) {
    await api(server.apiBase, `/sessions/${queuedSessionId}/messages`, {
      method: 'POST',
      headers: { 'idempotency-key': change.key },
      body: JSON.stringify({ content: change.content })
    });
    const card = await waitForMatchingEvent(
      server.apiBase,
      queuedSessionId,
      'user_confirmation_requested',
      (event) => event.metadata.payload?.reason === 'execution_scope_change'
        && event.metadata.payload?.description?.includes(change.content)
    );
    queuedCards.push(card);
    await api(server.apiBase, `/sessions/${queuedSessionId}/change-requests/decision`, {
      method: 'POST',
      body: JSON.stringify({
        confirmationId: card.metadata.payload.confirmationId,
        choice: 'defer'
      })
    });
  }
  try {
    await waitForStatus(server.apiBase, queuedSessionId, 'COMPLETED', 60_000);
  } catch (error) {
    const diagnostics = {
      session: (await api(server.apiBase, `/sessions/${queuedSessionId}`)).data,
      runs: (await api(server.apiBase, `/workflow-runs/session/${queuedSessionId}`)).data,
      events: (await listEvents(server.apiBase, queuedSessionId)).slice(-20)
    };
    console.error(`queued session diagnostics: ${JSON.stringify(diagnostics)}`);
    throw error;
  }
  const queueCard = await waitForMatchingEvent(
    server.apiBase,
    queuedSessionId,
    'user_confirmation_requested',
    (event) => event.metadata.payload?.reason === 'next_requirement_pending'
  );
  assert.deepEqual(
    queueCard.metadata.payload?.summaries,
    queuedChanges.map((change) => change.content),
    'same-session queued changes keep their raised order'
  );
  assert.equal(
    (await api(server.apiBase, `/workflow-runs/session/${queuedSessionId}`)).data.items.length,
    1,
    'a queued change does not start a second workflow automatically'
  );

  const parallelSessionA = await startExecution('实现订单详情页。');
  const parallelSessionB = await startExecution('实现订单退款接口。');
  await api(server.apiBase, `/sessions/${parallelSessionA}/pause`, {
    method: 'POST',
    body: JSON.stringify({ reason: '隔离验证：只停止 A 会话' })
  });
  await waitForStatus(server.apiBase, parallelSessionA, 'PAUSED');
  const sibling = await api(server.apiBase, `/sessions/${parallelSessionB}`);
  assert.equal(sibling.data.status, 'EXECUTING', '停止一个会话不影响另一个会话');

  const agents = (await api(server.apiBase, '/agents')).data;
  const consultedAgent = agents.find((agent) => agent.key === 'requirements');
  assert.ok(consultedAgent, 'the selected workflow Agent is available for @ consultation');
  const consultationSession = await startExecution('实现订单筛选功能。');
  const consultation = await api(server.apiBase, `/sessions/${consultationSession}/messages`, {
    method: 'POST',
    headers: { 'idempotency-key': 'phase-5-mention-consultation' },
    body: JSON.stringify({
      content: '这个改动对当前实现影响大吗？',
      mentionedAgentIds: [consultedAgent.id]
    })
  });
  assert.equal(consultation.data.handlingPlan.intent, 'question');
  const consultationReply = await waitForMatchingEvent(
    server.apiBase,
    consultationSession,
    'agent_message',
    (event) => event.metadata.payload?.discussionId !== undefined
      && event.fromAgentId === consultedAgent.id
  );
  assert.equal(consultationReply.toAgentIds?.length, 1, 'the @ reply targets the coordinator only');
  assert.equal((await api(server.apiBase, `/sessions/${consultationSession}`)).data.status, 'EXECUTING');

  console.log('phase 5 execution-change smoke passed: multi-intent, idempotency, pause/revise, ordered queue, cross-session isolation and bounded @ consultation');
} finally {
  if (server) await stopSmokeServer(server);
  await Promise.all(workspacePaths.map((workspacePath) => rm(workspacePath, { recursive: true, force: true })));
}
