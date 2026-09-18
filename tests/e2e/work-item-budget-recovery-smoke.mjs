import assert from 'node:assert/strict';
import {
  api,
  buildServer,
  confirmBriefAndSelectWorkflow,
  createPublishedAgentWorkflow,
  createSessionAndWaitForBrief,
  listEvents,
  startSmokeServer,
  stopSmokeServer,
  waitForMatchingEvent,
  waitForStatus
} from './smoke-server.mjs';

await buildServer();

let server;

try {
  server = await startSmokeServer('work-item-budget-recovery-smoke', {
    DISCUSSION_MAX_ROUNDS: '0',
    GLOBAL_DEFAULT_RUNTIME_TYPE: 'mock'
  });

  const workflow = await createPublishedAgentWorkflow(
    server.apiBase,
    'WorkItem budget recovery smoke',
    ['product-manager']
  );
  const { sessionId, briefId } = await createSessionAndWaitForBrief(
    server.apiBase,
    '分析并记录 token 使用情况，仅输出说明。',
    {
      // The coordinator remains a system-only Agent. Omitting agentIds uses
      // the default chat-visible participants while the coordinator still
      // owns the internal brief and workflow orchestration.
      // Keep enough per-invocation headroom for the confirmed constraints and
      // acceptance summary. The scenario must exhaust the cumulative WorkItem
      // allowance, not trip the separate single-input preflight first.
      tokenBudget: 2_100,
      runtimePreference: {
        preferredRuntimeType: 'mock',
        allowedRuntimeTypes: ['mock']
      }
    }
  );

  await confirmBriefAndSelectWorkflow(server.apiBase, sessionId, briefId, workflow);
  const waitingSession = await waitForStatus(server.apiBase, sessionId, 'WAIT_USER_DECISION');
  const confirmation = await waitForMatchingEvent(
    server.apiBase,
    sessionId,
    'user_confirmation_requested',
    (event) => event.metadata.payload?.reason === 'work_item_budget_exhausted'
  );
  const confirmationPayload = confirmation.metadata.payload;
  assert.deepEqual(
    confirmationPayload.options?.map((option) => option.key),
    ['submit_narrowed_requirement', 'cancel'],
    'an exhausted WorkItem must not expose a retry/continue action'
  );

  const before = await api(server.apiBase, `/sessions/${sessionId}/work-items`);
  const exhaustedWorkItem = before.data.items.find((item) => item.id === waitingSession.activeWorkItemId);
  assert.ok(exhaustedWorkItem, 'the session must retain the exhausted WorkItem for audit');
  assert.equal(confirmation.workItemId, exhaustedWorkItem.id);
  const eventsBeforeReplacement = await listEvents(server.apiBase, sessionId);
  assert.ok(
    eventsBeforeReplacement.some(
      (event) =>
        event.type === 'session_status_changed' &&
        event.metadata.payload?.reason === 'work_item_budget_exhausted'
    ),
    'the exhausted requirement must enter a user-decision state instead of failing'
  );
  assert.equal(exhaustedWorkItem.status, 'WAITING_USER');
  assert.equal(
    eventsBeforeReplacement.some((event) => event.type === 'task_failed' && event.workItemId === exhaustedWorkItem.id),
    false,
    'budget exhaustion must not mark the completed task as failed during a terminal phase'
  );

  const replacement = await api(server.apiBase, `/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'idempotency-key': 'work-item-budget-recovery-narrowed-requirement' },
    body: JSON.stringify({
      content: '仅输出单个 token 使用规则的简短说明。'
    })
  });
  const resolved = await waitForMatchingEvent(
    server.apiBase,
    sessionId,
    'user_confirmation_resolved',
    (event) =>
      event.metadata.payload?.confirmationId === confirmationPayload.confirmationId &&
      event.metadata.payload?.selectedOptionKey === 'submit_narrowed_requirement'
  );
  assert.ok(resolved, 'the budget confirmation must resolve through the narrowed requirement');

  const after = await api(server.apiBase, `/sessions/${sessionId}/work-items`);
  const replacementWorkItem = after.data.items.find(
    (item) => item.parentWorkItemId === exhaustedWorkItem.id
  );
  assert.ok(replacementWorkItem, 'the replacement requirement must receive a new related WorkItem');
  assert.equal(replacementWorkItem.goal, '仅输出单个 token 使用规则的简短说明。');
  assert.deepEqual(replacementWorkItem.inheritedDecisionIds, []);
  assert.deepEqual(replacementWorkItem.inheritedArtifactIds, []);
  const priorWorkItem = after.data.items.find((item) => item.id === exhaustedWorkItem.id);
  assert.equal(priorWorkItem?.status, 'WAITING_USER');

  const detail = await api(server.apiBase, `/sessions/${sessionId}`);
  assert.equal(detail.data.activeWorkItemId, replacementWorkItem.id);
  const routing = await api(server.apiBase, `/sessions/${sessionId}/message-routings/${replacement.data.routingId}`);
  assert.equal(routing.data.forcedWorkItemId, replacementWorkItem.id);

  console.log('work-item budget recovery smoke ok');
} finally {
  if (server) {
    await stopSmokeServer(server);
  }
}
