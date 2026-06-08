import {
  api,
  buildServer,
  createSessionAndWaitForBrief,
  listEvents,
  startSmokeServer,
  stopSmokeServer,
  waitForStatus
} from './smoke-server.mjs';

await buildServer();

let server;

try {
  server = await startSmokeServer('artifact-file-changes-smoke', {
    DISCUSSION_MAX_ROUNDS: '0'
  });

  const requirementText = 'Generate concrete files for the confirmed implementation task.';
  const { sessionId, briefId } = await createSessionAndWaitForBrief(
    server.apiBase,
    requirementText,
    {
      workingDirectory: {
        kind: 'browser_local',
        id: 'local-dir-smoke',
        name: 'smoke-workspace',
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
      }
    }
  );

  await api(server.apiBase, `/sessions/${sessionId}/briefs/${briefId}/confirm`, { method: 'POST' });
  await waitForStatus(server.apiBase, sessionId, 'COMPLETED');

  const events = await listEvents(server.apiBase, sessionId);
  const artifactEvents = events.filter((event) => event.type === 'artifact_created');
  const fileChanges = artifactEvents.flatMap((event) => event.metadata.payload?.fileChanges ?? []);
  const workspaceAnalysisEvent = events.find(
    (event) => event.type === 'agent_message' && event.metadata.payload?.phase === 'workspace_analysis'
  );
  const workspaceAnalysisArtifact = artifactEvents.find(
    (event) => event.metadata.payload?.title === '工作区架构分析'
  );
  const workspaceAnalysisChange = fileChanges.find(
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

  if (!fileChanges.length) {
    throw new Error('Expected artifact_created events to include fileChanges for browser local file writing');
  }

  const invalidChange = fileChanges.find((change) => !change.path || !['create', 'update', 'delete'].includes(change.operation));
  if (invalidChange) {
    throw new Error(`Invalid file change payload: ${JSON.stringify(invalidChange)}`);
  }

  const stageArtifactChanges = fileChanges.filter((change) => change.path?.startsWith('agent-output/'));
  if (!stageArtifactChanges.length) {
    throw new Error('Expected stage artifact file changes under agent-output/');
  }

  const unrelatedChange = fileChanges.find(
    (change) => typeof change.content === 'string' && change.content.length && !change.content.includes(requirementText)
  );
  if (unrelatedChange) {
    throw new Error(`Expected generated file content to reference the user requirement: ${unrelatedChange.path}`);
  }

  const workspacePaths = new Set(['AGENTS.md', 'apps/web/src/styles.css']);
  const workspaceFileUpdates = fileChanges.filter(
    (change) =>
      workspacePaths.has(change.path) &&
      change.operation === 'update' &&
      change.content?.includes(requirementText) &&
      change.content?.includes('Mock runtime note')
  );
  if (workspaceFileUpdates.length < workspacePaths.size) {
    throw new Error('Expected execution fileChanges to update every relevant real workspace file from the workspace snapshot');
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
}
