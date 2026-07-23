import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  api,
  buildServer,
  createSessionAndWaitForBrief,
  listEvents,
  startSmokeServer,
  stopSmokeServer,
  waitForMatchingEvent,
  waitForStatus
} from './smoke-server.mjs';

await buildServer();

let server;
let workspaceRoot;

try {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'agent-cluster-artifact-domains-'));
  await mkdir(join(workspaceRoot, 'apps', 'web', 'src'), { recursive: true });
  await writeFile(join(workspaceRoot, 'AGENTS.md'), '# Workspace Rules\nUse Harness Engineering.\n');
  await writeFile(join(workspaceRoot, 'apps', 'web', 'src', 'styles.css'), '.workspace-main { display: grid; }\n');
  server = await startSmokeServer('artifact-file-changes-smoke', {
    DISCUSSION_MAX_ROUNDS: '0',
    GLOBAL_DEFAULT_RUNTIME_TYPE: 'mock',
    MOCK_RUNTIME_ENABLED: 'true'
  });

  const agents = (await api(server.apiBase, '/agents')).data;
  const requirementsAgent = agents.find((agent) => agent.key === 'requirements');
  if (!requirementsAgent) throw new Error('Artifact file changes smoke requires the requirements Agent.');
  const draft = (await api(server.apiBase, '/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Artifact file changes smoke workflow',
      nodes: [{ id: 'artifact-file-changes-node', type: 'agent', agentId: requirementsAgent.id, order: 0 }]
    })
  })).data;
  const workflow = (await api(server.apiBase, `/workflows/${draft.id}/publish`, {
    method: 'POST',
    body: JSON.stringify({ expectedDraftRevision: draft.draftRevision })
  })).data;

  const requirementText = 'Generate concrete files for the confirmed implementation task.';
  const { sessionId, briefId } = await createSessionAndWaitForBrief(
    server.apiBase,
    requirementText,
    {
      workingDirectory: {
        kind: 'server_local',
        id: 'local-dir-smoke',
        name: 'smoke-workspace',
        path: workspaceRoot,
        selectedAt: new Date().toISOString()
      },
      workspaceSnapshot: {
        rootName: 'smoke-workspace',
        scannedAt: new Date().toISOString(),
        fileCount: 3,
        totalBytes: 240,
        tree: [
          { path: 'AGENTS.md', kind: 'file' },
          { path: 'apps/web/src/styles.css', kind: 'file' },
          { path: '.env', kind: 'file' }
        ],
        files: [
          {
            path: 'AGENTS.md',
            size: 80,
            language: 'markdown',
            content: '# Workspace Rules\nUse Harness Engineering.\n'
          },
          {
            path: 'apps/web/src/styles.css',
            size: 160,
            language: 'css',
            content: '.workspace-main { display: grid; }\n'
          }
        ],
        skipped: [{ path: '.env', reason: 'sensitive' }],
        detectedStack: ['vue', 'typescript'],
        entrypoints: ['AGENTS.md', 'apps/web/src/styles.css']
      },
      runtimePreference: { preferredRuntimeType: 'mock', allowedRuntimeTypes: ['mock'] }
    }
  );

  await api(server.apiBase, `/sessions/${sessionId}/briefs/${briefId}/confirm`, { method: 'POST' });
  await waitForStatus(server.apiBase, sessionId, 'WAIT_WORKFLOW_SELECT');
  const workflowSelection = await waitForMatchingEvent(
    server.apiBase,
    sessionId,
    'user_confirmation_requested',
    (event) => event.metadata.payload.reason === 'select_workflow'
  );
  await api(server.apiBase, `/sessions/${sessionId}/workflow/select`, {
    method: 'POST',
    body: JSON.stringify({
      workflowId: workflow.id,
      workflowVersion: workflow.currentPublishedVersion,
      confirmationId: workflowSelection.metadata.payload.confirmationId
    })
  });
  await waitForStatus(server.apiBase, sessionId, 'COMPLETED');

  const events = await listEvents(server.apiBase, sessionId);
  const artifactEvents = events.filter((event) => event.type === 'artifact_created');
  const platformProjections = artifactEvents.flatMap(
    (event) => event.metadata.payload?.platformProjections ?? []
  );
  const runtimeProposals = artifactEvents.flatMap(
    (event) => event.metadata.payload?.runtimeProposals ?? []
  );
  const observedChanges = artifactEvents.flatMap(
    (event) => event.metadata.payload?.systemEvidence?.workspaceChangeSet?.changes ?? []
  );
  const workspaceAnalysisEvent = events.find(
    (event) => event.type === 'agent_message' && event.metadata.payload?.phase === 'workspace_analysis'
  );
  const workspaceAnalysisArtifact = artifactEvents.find(
    (event) => event.metadata.payload?.title === '工作区架构分析'
  );
  const workspaceAnalysisChange = platformProjections.find(
    (change) =>
      change.path === 'agent-output/workspace-analysis.md' &&
      change.operation === 'create' &&
      change.content?.includes('# 工作区架构分析') &&
      change.content?.includes(requirementText)
  );

  if (!workspaceAnalysisEvent) {
    throw new Error('Expected Coordinator to publish a workspace analysis message before requirement analysis');
  }

  if (!workspaceAnalysisArtifact || !workspaceAnalysisChange) {
    throw new Error('Expected workspace analysis to create a Chinese stage artifact file');
  }
  if ((workspaceAnalysisArtifact.metadata.payload?.runtimeProposals ?? []).length) {
    throw new Error('Platform stage projection must not be duplicated into runtimeProposals');
  }

  if (artifactEvents.some((event) => Object.prototype.hasOwnProperty.call(event.metadata.payload ?? {}, 'fileChanges'))) {
    throw new Error('Artifact events must not expose the removed ambiguous fileChanges field');
  }

  const invalidChange = [...platformProjections, ...observedChanges].find(
    (change) => !change.path || !['create', 'update', 'delete'].includes(change.operation)
  );
  if (invalidChange) {
    throw new Error(`Invalid file change payload: ${JSON.stringify(invalidChange)}`);
  }

  const stageArtifactChanges = platformProjections.filter((change) => change.path?.startsWith('agent-output/'));
  if (!stageArtifactChanges.length) {
    throw new Error('Expected stage artifact file changes under agent-output/');
  }

  const proposedChanges = runtimeProposals.flatMap((proposal) => proposal.metadata?.fileChanges ?? []);
  if (!proposedChanges.length) {
    throw new Error('Expected the mock Runtime execution Artifact to retain model file proposals');
  }
  const executionArtifact = artifactEvents.find(
    (event) => (event.metadata.payload?.runtimeProposals ?? []).length > 0
  );
  const executionPayload = executionArtifact?.metadata.payload;
  if (!executionPayload || !Object.prototype.hasOwnProperty.call(executionPayload, 'systemEvidence')) {
    throw new Error('Execution Artifact must explicitly expose the systemEvidence trust domain');
  }
  if (!executionPayload.systemEvidence?.invocationId) {
    throw new Error('Execution Artifact systemEvidence must retain its Runtime invocation identity');
  }
  if ((executionPayload.platformProjections ?? []).length) {
    throw new Error('Runtime execution proposals must not be duplicated into platformProjections');
  }
  const executionObserved = executionPayload.systemEvidence.workspaceChangeSet?.changes ?? [];
  if (JSON.stringify(observedChanges) !== JSON.stringify(executionObserved)) {
    throw new Error('Observed changes must come exactly from execution systemEvidence.workspaceChangeSet');
  }
  const proposedPaths = new Set(proposedChanges.map((change) => change.path));
  const promotedProposal = [...platformProjections, ...observedChanges].find((change) => proposedPaths.has(change.path));
  if (promotedProposal) {
    throw new Error(`Runtime proposal was promoted into a platform/observed domain: ${promotedProposal.path}`);
  }

  const feishuConfirmation = events.find(
    (event) =>
      event.type === 'user_confirmation_requested' &&
      event.metadata.payload?.reason === 'confirm_feishu_notification'
  );
  if (!feishuConfirmation) {
    throw new Error('Expected final delivery to request user confirmation for Feishu notification');
  }

  const feishuOptions = feishuConfirmation.metadata.payload?.options ?? [];
  if (
    !feishuOptions.some((option) => option.key === 'send_notification') ||
    !feishuOptions.some((option) => option.key === 'skip_notification')
  ) {
    throw new Error('Expected Feishu confirmation options for sending or skipping notification');
  }

  await api(server.apiBase, `/sessions/${sessionId}/notifications/feishu/decision`, {
    method: 'POST',
    body: JSON.stringify({
      confirmationId: feishuConfirmation.metadata.payload.confirmationId,
      notificationDraftArtifactId: feishuConfirmation.metadata.payload.relatedArtifactId,
      decision: 'skip_notification'
    })
  });

  const eventsAfterDecision = await listEvents(server.apiBase, sessionId);
  const resolved = eventsAfterDecision.find(
    (event) =>
      event.type === 'user_confirmation_resolved' &&
      event.metadata.payload?.reason === 'confirm_feishu_notification' &&
      event.metadata.payload?.selectedOptionKey === 'skip_notification'
  );
  if (!resolved) {
    throw new Error('Expected Feishu notification decision to be recorded');
  }

  console.log('artifact file changes smoke ok');
} finally {
  if (server) {
    await stopSmokeServer(server);
  }
  if (workspaceRoot) {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}
