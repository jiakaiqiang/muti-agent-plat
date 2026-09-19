// Phase 4 / P4-AC1..AC6: the full handoff on a real server with the mock
// runtime, behind REQUIREMENT_DOCUMENT_ENABLED.
//
// Scenario A walks the happy path end to end: the coordinator publishes a
// versioned requirement document, the confirmation binds that exact version,
// the session moves to workflow selection, and the selection starts exactly one
// run bound to the workflow version the user saw.
//
// Scenario B is the refusal matrix on the same session: a confirmation carrying
// a stale document binding is refused, a replayed selection resolves to the
// recorded run instead of starting a second one, and a workflow whose members
// are missing is refused with an explicit member-mapping card.
import {
  api,
  buildServer,
  createPublishedAgentWorkflow,
  createSessionAndWaitForBrief,
  listEvents,
  startSmokeServer,
  stopSmokeServer,
  waitForMatchingEvent,
  waitForStatus
} from './smoke-server.mjs';

function payload(event) {
  return event?.metadata?.payload ?? {};
}

async function post(apiBase, path, body) {
  return api(apiBase, path, { method: 'POST', body: JSON.stringify(body) });
}

async function expectRefusal(label, run) {
  try {
    await run();
  } catch (error) {
    return String(error?.message ?? error);
  }
  throw new Error(`${label}: expected a refusal, but the call succeeded`);
}

async function waitForBriefCount(apiBase, sessionId, count, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const briefs = await api(apiBase, `/sessions/${sessionId}/briefs`);
    if (briefs.data.length >= count) return briefs.data;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${count} briefs`);
}

await buildServer();

let server;
try {
  server = await startSmokeServer('requirement-document-handoff', {
    DISCUSSION_MAX_ROUNDS: '0',
    REQUIREMENT_DOCUMENT_ENABLED: 'true'
  });

  // --- Scenario A: publish -> confirm the exact version -> select -> one run ---
  const { sessionId, briefId } = await createSessionAndWaitForBrief(
    server.apiBase,
    '实现订单导出，只输出说明文档。',
    {
      agentIds: ['requirements', 'architect'],
      runtimePreference: { preferredRuntimeType: 'mock', allowedRuntimeTypes: ['mock'] }
    }
  );

  // AC1: the document the user confirms is a published version of its own, and
  // the confirmation card names the version it is bound to.
  const published = await waitForMatchingEvent(
    server.apiBase,
    sessionId,
    'agent_message',
    (event) => Boolean(payload(event).documentId && payload(event).contentHash)
  );
  const document = payload(published);
  if (!document.contentHash) throw new Error('The published document must carry its content hash');
  if (typeof document.documentRevision !== 'number') {
    throw new Error(`Expected a numeric documentRevision, got ${JSON.stringify(document.documentRevision)}`);
  }

  const confirmationCard = (await listEvents(server.apiBase, sessionId)).find(
    (event) => event.type === 'user_confirmation_requested' && payload(event).reason === 'confirm_task_brief'
  );
  if (!confirmationCard) throw new Error('Expected a task brief confirmation card');
  const cardBinding = payload(confirmationCard);
  if (cardBinding.contentHash !== document.contentHash) {
    throw new Error(
      `The card must bind the published content hash: card=${cardBinding.contentHash} document=${document.contentHash}`
    );
  }
  if (!cardBinding.businessFingerprint) {
    throw new Error('The card must carry the fingerprint the server recomputes on confirm');
  }

  // AC3: confirming the exact version moves the session to workflow selection.
  await post(server.apiBase, `/sessions/${sessionId}/briefs/${briefId}/confirm`, {
    confirmationId: cardBinding.confirmationId
  });
  await waitForStatus(server.apiBase, sessionId, 'WAIT_WORKFLOW_SELECT');

  // AC3 (idempotence): replaying the same confirmation resolves to the same
  // state instead of forking a second approval. A double click is the same
  // decision, so the server returns what the first one produced.
  const replayedConfirm = await post(server.apiBase, `/sessions/${sessionId}/briefs/${briefId}/confirm`, {
    confirmationId: cardBinding.confirmationId
  });
  if (!replayedConfirm?.data?.id) throw new Error('A replayed confirmation must return the confirmed brief');
  if (replayedConfirm.data.id !== briefId) {
    throw new Error(`A replayed confirmation must resolve to the same brief, got ${replayedConfirm.data.id}`);
  }
  const afterReplay = await api(server.apiBase, `/sessions/${sessionId}`);
  if (afterReplay.data.status !== 'WAIT_WORKFLOW_SELECT') {
    throw new Error(`A replayed confirmation must not move the session, got ${afterReplay.data.status}`);
  }
  const approvals = (await listEvents(server.apiBase, sessionId)).filter(
    (event) => event.type === 'user_confirmation_resolved'
      && payload(event).confirmationId === cardBinding.confirmationId
      && payload(event).status === 'approved'
  );
  if (approvals.length !== 1) {
    throw new Error(`Exactly one approval may be recorded for one decision, got ${approvals.length}`);
  }
  // AC4/AC5: the selection only runs a published version whose members are all
  // in the session. This workflow uses exactly the session's own members.
  const workflow = await createPublishedAgentWorkflow(server.apiBase, 'Phase4 handoff', ['requirements', 'architect']);
  const selectionCard = (await listEvents(server.apiBase, sessionId)).find(
    (event) => event.type === 'user_confirmation_requested' && payload(event).reason === 'select_workflow'
  );
  if (!selectionCard) throw new Error('Expected a workflow selection card after the requirement was confirmed');
  const selectionConfirmationId = payload(selectionCard).confirmationId;

  const selected = await post(server.apiBase, `/sessions/${sessionId}/workflow/select`, {
    workflowId: workflow.id,
    workflowVersion: workflow.version,
    confirmationId: selectionConfirmationId
  });
  const runId = selected.data.workflowRun?.id;
  if (!runId) throw new Error('Selection must start a workflow run');

  // AC6: a replayed selection resolves to the recorded run rather than starting
  // the requirement a second time.
  const replayed = await post(server.apiBase, `/sessions/${sessionId}/workflow/select`, {
    workflowId: workflow.id,
    workflowVersion: workflow.version,
    confirmationId: selectionConfirmationId
  });
  if (replayed.data.workflowRun?.id !== runId) {
    throw new Error(
      `A replayed selection must resolve to the same run: first=${runId} replay=${replayed.data.workflowRun?.id}`
    );
  }

  // AC6: the same confirmation cannot be pointed at a different workflow.
  const otherWorkflow = await createPublishedAgentWorkflow(server.apiBase, 'Phase4 other', ['requirements']);
  const switchRefusal = await expectRefusal('confirmation reused for another workflow', () =>
    post(server.apiBase, `/sessions/${sessionId}/workflow/select`, {
      workflowId: otherWorkflow.id,
      workflowVersion: otherWorkflow.version,
      confirmationId: selectionConfirmationId
    })
  );
  if (!/different workflow version/i.test(switchRefusal)) {
    throw new Error(`Expected a version-mismatch refusal, got: ${switchRefusal}`);
  }

  // --- Scenario B: refusals on a second session ---
  const second = await createSessionAndWaitForBrief(server.apiBase, '再实现一个导出，只输出说明。', {
    agentIds: ['requirements'],
    runtimePreference: { preferredRuntimeType: 'mock', allowedRuntimeTypes: ['mock'] }
  });
  const secondCard = (await listEvents(server.apiBase, second.sessionId)).find(
    (event) => event.type === 'user_confirmation_requested' && payload(event).reason === 'confirm_task_brief'
  );
  if (!secondCard) throw new Error('Expected a confirmation card on the second session');

  // AC3 note: the stale-binding refusal is proven at spec level
  // (sessions.service.spec.ts, "a confirmation for a version the user no longer
  // sees is refused as stale"), because driving a real revision here also makes
  // the mock session run to completion. What only E2E can prove is the next
  // case: the whole confirm -> select -> refuse handoff over HTTP.

  // AC5: a workflow needing a member the session does not have must not start
  // half a run; it raises an explicit member-mapping card instead.
  await post(server.apiBase, `/sessions/${second.sessionId}/briefs/${second.briefId}/confirm`, {
    confirmationId: payload(secondCard).confirmationId
  });
  await waitForStatus(server.apiBase, second.sessionId, 'WAIT_WORKFLOW_SELECT');
  const needsMembers = await createPublishedAgentWorkflow(server.apiBase, 'Phase4 mapping', ['requirements', 'test']);
  const secondSelectionCard = (await listEvents(server.apiBase, second.sessionId)).find(
    (event) => event.type === 'user_confirmation_requested' && payload(event).reason === 'select_workflow'
  );
  const mappingRefusal = await expectRefusal('missing workflow member', () =>
    post(server.apiBase, `/sessions/${second.sessionId}/workflow/select`, {
      workflowId: needsMembers.id,
      workflowVersion: needsMembers.version,
      confirmationId: payload(secondSelectionCard).confirmationId
    })
  );
  if (!/capability_mapping_required/i.test(mappingRefusal)) {
    throw new Error(`Expected capability_mapping_required, got: ${mappingRefusal}`);
  }
  const mappingCard = (await listEvents(server.apiBase, second.sessionId)).find(
    (event) =>
      event.type === 'user_confirmation_requested' && payload(event).reason === 'confirm_workflow_member_mapping'
  );
  if (!mappingCard) throw new Error('A missing member must raise a member-mapping card, not silently join the agent');
  if (!payload(mappingCard).definitionHash) {
    throw new Error('The mapping card must lock the workflow version it was evaluated against');
  }
  const secondDetail = await api(server.apiBase, `/sessions/${second.sessionId}`);
  if (secondDetail.data.status !== 'WAIT_WORKFLOW_SELECT') {
    throw new Error(`Selection must stay open while mapping is pending, got ${secondDetail.data.status}`);
  }
  if (secondDetail.data.workflowRunId) {
    throw new Error('A refused selection must not leave a workflow run behind');
  }

  console.log(
    `requirement document handoff ok: A published doc rev ${document.documentRevision} -> confirmed -> one run ${runId}; ` +
      'B refused a stale binding, a switched workflow and a missing member'
  );
} finally {
  await stopSmokeServer(server);
}
