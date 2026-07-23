import {
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

async function assertNoSubAgentReassignment(apiBase, sessionId) {
  const events = await listEvents(apiBase, sessionId);
  const invalid = events.find(
    (event) =>
      event.type === 'task_reassigned' &&
      event.actor?.type === 'agent' &&
      event.metadata.payload?.assignedBy?.type === 'agent' &&
      event.actor.id !== event.metadata.payload.assignedBy.id
  );
  if (invalid) {
    throw new Error(`task_reassigned must be emitted by Coordinator only: ${JSON.stringify(invalid)}`);
  }
}

async function waitForMatchingEventWithDebug(apiBase, sessionId, type, predicate, timeoutMs = 20_000) {
  try {
    return await waitForMatchingEvent(apiBase, sessionId, type, predicate, timeoutMs);
  } catch (error) {
    const events = await listEvents(apiBase, sessionId);
    const summary = events
      .map((event) =>
        [
          event.type,
          event.taskId ?? '-',
          event.actor?.id ?? '-',
          event.metadata.payload?.phase ?? '-',
          event.metadata.payload?.status ?? '-',
          event.metadata.payload?.assignee?.id ?? '-',
          event.metadata.payload?.autoResolutionAttempted ?? '-',
          event.content
        ].join(' | ')
      )
      .join('\n');
    console.error(`Event summary before ${type} timeout:\n${summary}`);
    throw error;
  }
}

async function runAcceptAndReassignScenario() {
  let server;
  try {
    server = await startSmokeServer('coordinator-controlled-routing-reassign-smoke', {
      DISCUSSION_MAX_ROUNDS: '0',
      GLOBAL_DEFAULT_RUNTIME_TYPE: 'mock',
      MOCK_PARALLEL_TASKS: 'true',
      MOCK_REJECT_ACCEPTANCE_AGENT_KEYS: 'requirements'
    });
    const workflow = await createPublishedAgentWorkflow(
      server.apiBase,
      'Coordinator controlled reassignment smoke',
      ['requirements']
    );

    const { sessionId, briefId } = await createSessionAndWaitForBrief(
      server.apiBase,
      '分析并记录前后端协作路由流程，仅输出说明，不修改代码。',
      {
        agentIds: ['coordinator', 'requirements', 'architect', 'frontend', 'backend', 'test', 'review', 'notification'],
        runtimePreference: { preferredRuntimeType: 'mock', allowedRuntimeTypes: ['mock'] }
      }
    );

    await confirmBriefAndSelectWorkflow(server.apiBase, sessionId, briefId, workflow);

    const assigned = await waitForMatchingEvent(
      server.apiBase,
      sessionId,
      'task_assigned',
      (event) =>
        event.actor?.type === 'agent' &&
        event.metadata.payload?.assignedBy?.type === 'agent' &&
        event.actor.id === event.metadata.payload.assignedBy.id &&
        event.metadata.payload?.routingMode === 'coordinator_controlled',
      30_000
    );
    if (assigned.metadata.payload?.assignee?.type !== 'agent') {
      throw new Error('task_assigned must include an agent assignee ActorRef.');
    }

    const blocked = await waitForMatchingEventWithDebug(
      server.apiBase,
      sessionId,
      'task_blocked',
      (event) =>
        event.metadata.payload?.autoResolutionAttempted === true,
      30_000
    );

    const reassigned = await waitForMatchingEvent(
      server.apiBase,
      sessionId,
      'task_reassigned',
      (event) =>
        event.taskId === blocked.taskId &&
        event.actor?.type === 'agent' &&
        event.metadata.payload?.assignedBy?.type === 'agent' &&
        event.actor.id === event.metadata.payload.assignedBy.id &&
        event.metadata.payload?.previousAssignee?.type === 'agent' &&
        event.metadata.payload.previousAssignee.id === blocked.actor?.id &&
        event.metadata.payload?.assignee?.type === 'agent',
      30_000
    );

    const accepted = await waitForMatchingEvent(
      server.apiBase,
      sessionId,
      'task_accepted',
      (event) =>
        event.taskId === reassigned.taskId &&
        event.actor?.type === 'agent' &&
        event.actor.id === reassigned.metadata.payload.assignee.id &&
        event.metadata.payload?.status === 'accepted',
      30_000
    );
    if (!accepted.metadata.payload?.autoResolutionAttempted) {
      throw new Error('Accepted reassigned task should preserve autoResolutionAttempted=true.');
    }

    await assertNoSubAgentReassignment(server.apiBase, sessionId);
  } finally {
    if (server) {
      await stopSmokeServer(server);
    }
  }
}

async function runSecondFailureUserDecisionScenario() {
  let server;
  try {
    server = await startSmokeServer('coordinator-controlled-routing-user-decision-smoke', {
      DISCUSSION_MAX_ROUNDS: '0',
      GLOBAL_DEFAULT_RUNTIME_TYPE: 'mock',
      MOCK_REJECT_ACCEPTANCE_AGENT_KEYS: 'coordinator,requirements,architect,frontend,backend,test,review,notification'
    });
    const workflow = await createPublishedAgentWorkflow(
      server.apiBase,
      'Coordinator controlled user decision smoke',
      ['requirements']
    );

    const { sessionId, briefId } = await createSessionAndWaitForBrief(
      server.apiBase,
      '分析并记录后端接口协作方案，让每个可用 Agent 拒绝接收任务；仅输出说明，不修改代码。',
      {
        agentIds: ['coordinator', 'requirements', 'architect', 'frontend', 'backend', 'test', 'review', 'notification'],
        runtimePreference: { preferredRuntimeType: 'mock', allowedRuntimeTypes: ['mock'] }
      }
    );

    await confirmBriefAndSelectWorkflow(server.apiBase, sessionId, briefId, workflow);

    await waitForMatchingEventWithDebug(
      server.apiBase,
      sessionId,
      'task_reassigned',
      (event) => event.metadata.payload?.autoResolutionAttempted === true,
      30_000
    );

    await waitForStatus(server.apiBase, sessionId, 'WAIT_USER_DECISION', 60_000);

    await waitForMatchingEvent(
      server.apiBase,
      sessionId,
      'user_confirmation_requested',
      (event) => event.metadata.payload?.reason === 'coordinator_routing_needs_user_decision',
      30_000
    );

    const blockedEvents = (await listEvents(server.apiBase, sessionId)).filter((event) => event.type === 'task_blocked');
    if (blockedEvents.length < 2) {
      throw new Error('Expected at least two task_blocked events before user decision.');
    }

    await assertNoSubAgentReassignment(server.apiBase, sessionId);
  } finally {
    if (server) {
      await stopSmokeServer(server);
    }
  }
}

await runAcceptAndReassignScenario();
await runSecondFailureUserDecisionScenario();

console.log('coordinator controlled routing smoke ok');
