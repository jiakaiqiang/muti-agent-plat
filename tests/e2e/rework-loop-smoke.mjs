import {
  api,
  buildServer,
  confirmBriefAndSelectWorkflow,
  createPublishedAgentWorkflow,
  createSessionAndWaitForBrief,
  listEvents,
  startSmokeServer,
  stopSmokeServer,
  waitForStatus
} from './smoke-server.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

await buildServer();

let server;
let platformRoot;

try {
  platformRoot = await mkdtemp(join(tmpdir(), 'agent-cluster-rework-workspace-'));
  server = await startSmokeServer('rework-loop-smoke', {
    DISCUSSION_MAX_ROUNDS: '0',
    GLOBAL_DEFAULT_RUNTIME_TYPE: 'mock',
    MOCK_REVIEW_RECOMMENDATION: 'rework',
    PROJECT_POLICY_RUNTIME_TYPE: '',
    REWORK_MAX_ROUNDS: '1',
    AGENT_CLUSTER_WORKDIR_BRIEF: 'false',
    AGENT_CLUSTER_PLATFORM_ROOT: platformRoot
  });

  const workflow = await createPublishedAgentWorkflow(server.apiBase, 'Rework loop workflow', ['product-manager']);

  const { sessionId, briefId } = await createSessionAndWaitForBrief(
    server.apiBase,
    '验证复盘返工自动重跑与上限保护链路',
    {
      tokenBudget: 1_000_000,
      runtimePreference: { preferredRuntimeType: 'mock', allowedRuntimeTypes: ['mock'] }
    }
  );
  await confirmBriefAndSelectWorkflow(server.apiBase, sessionId, briefId, workflow);

  // 第一次复盘 rework -> 自动返工一轮 -> 第二次复盘 rework -> 超上限 -> WAIT_USER_DECISION
  await waitForStatus(server.apiBase, sessionId, 'WAIT_USER_DECISION', 60_000);

  const events = await listEvents(server.apiBase, sessionId);


  const reworkOutcomes = events.filter(
    (event) => event.type === 'session_status_changed' && event.metadata?.payload?.outcome === 'rework'
  );
  if (reworkOutcomes.length !== 2) {
    throw new Error(
      `Expected 2 rework outcomes (initial + after auto-rework), got ${reworkOutcomes.length}: ${JSON.stringify(
        events.filter((event) =>
          ['session_status_changed', 'error_reported', 'user_confirmation_requested', 'runtime_failed'].includes(event.type)
        )
      )}`
    );
  }

  const reworkStarts = events.filter(
    (event) => event.type === 'session_status_changed' && event.metadata?.payload?.reworkRound !== undefined
  );
  if (reworkStarts.length !== 1) {
    throw new Error(`Expected exactly 1 automatic rework round, got ${reworkStarts.length}`);
  }

  const limitCard = events.find(
    (event) =>
      event.type === 'user_confirmation_requested' && event.metadata?.payload?.reason === 'rework_limit_reached'
  );
  if (!limitCard) {
    throw new Error('Expected a rework_limit_reached confirmation card after exceeding REWORK_MAX_ROUNDS');
  }

  const workflowRunStarts = events.filter((event) => event.type === 'workflow_run_started');
  if (workflowRunStarts.length !== 1) {
    throw new Error(`Rework must remain in one auditable workflow run, got ${workflowRunStarts.length}`);
  }
  const workflowRunId = workflowRunStarts[0]?.metadata.payload?.workflowRunId;
  const nodeStarts = events.filter(
    (event) => event.type === 'workflow_node_started' && event.metadata.payload?.workflowRunId === workflowRunId
  );
  const nodeRunIds = new Set(nodeStarts.map((event) => event.metadata.payload?.workflowNodeRunId).filter(Boolean));
  const attempts = new Set(nodeStarts.map((event) => event.metadata.payload?.attempt).filter(Number.isInteger));
  const taskStarts = events.filter(
    (event) =>
      event.type === 'task_started' &&
      (event.metadata.payload?.workflowRunId === workflowRunId || event.taskId?.startsWith(`wf-task:${workflowRunId}:`))
  );
  if (!workflowRunId || nodeRunIds.size < 2 || !attempts.has(1) || !attempts.has(2) || taskStarts.length < 2) {
    throw new Error(
      `Rework must append a new node attempt in the same run: ${JSON.stringify({ workflowRunId, nodeStarts, taskStarts })}`
    );
  }

  if (events.some((event) => event.type === 'final_delivery_created')) {
    throw new Error('final_delivery_created must not be emitted while review keeps requesting rework');
  }

  console.log('rework-loop smoke passed: auto rework ran once, then handed over to the user at the limit');
} finally {
  if (server) {
    await stopSmokeServer(server);
  }
  if (platformRoot) await rm(platformRoot, { recursive: true, force: true });
}
