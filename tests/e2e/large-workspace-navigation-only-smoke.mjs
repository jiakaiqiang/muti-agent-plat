import {
  api,
  buildServer,
  listEvents,
  startSmokeServer,
  stopSmokeServer,
  waitForStatus
} from './smoke-server.mjs';

await buildServer();

let server;

try {
  server = await startSmokeServer('large-workspace-navigation-only-smoke', {
    DISCUSSION_MAX_ROUNDS: '0',
    TOKEN_BUDGET_DEFAULT: '4500',
    HTTP_JSON_BODY_LIMIT: '10mb'
  });

  // 1000 files without per-file content keeps the JSON wire size small but
  // still makes the manifest fat enough that the trimmer has to escalate
  // through emergency into navigation_only.
  const files = Array.from({ length: 1000 }, (_, i) => ({
    path: `src/module-${Math.floor(i / 20)}/file-${i}.ts`,
    size: 4_800,
    language: 'typescript',
    summary: `Fixture summary for file ${i}.`
  }));
  const tree = files.map((file) => ({ path: file.path, kind: 'file' }));

  const sessionRequest = {
    input: 'Drive the trimmer into navigation_only mode for a 1000-file workspace and verify the runtime still receives a usable context.',
    agentIds: ['coordinator', 'requirements', 'architect', 'backend', 'test', 'review', 'notification'],
    tokenBudget: 4_500,
    workspaceSnapshot: {
      rootName: 'large-workspace-fixture',
      scannedAt: new Date().toISOString(),
      fileCount: files.length,
      totalBytes: files.reduce((acc, file) => acc + file.size, 0),
      tree,
      files,
      skipped: [],
      detectedStack: ['typescript'],
      entrypoints: ['src/module-0/file-0.ts'],
      coverage: {
        totalEntriesSeen: files.length,
        scannedEntries: files.length,
        readableFiles: files.length,
        skippedByReason: {}
      }
    }
  };
  const created = await api(server.apiBase, '/sessions', {
    method: 'POST',
    body: JSON.stringify(sessionRequest)
  });
  const sessionId = created.data.session.id;

  let briefId;
  {
    const session = await waitForStatus(server.apiBase, sessionId, 'WAIT_USER_CONFIRM', 60_000);
    briefId = session.currentTaskBriefId;
  }

  await api(server.apiBase, `/sessions/${sessionId}/briefs/${briefId}/confirm`, { method: 'POST' });
  await waitForStatus(server.apiBase, sessionId, 'COMPLETED', 120_000);

  const events = await listEvents(server.apiBase, sessionId);

  const trimmedEvents = events.filter(
    (event) => event.type === 'runtime_progress' && event.metadata.payload?.code === 'TOKEN_CONTEXT_TRIMMED'
  );
  if (!trimmedEvents.length) {
    throw new Error('Expected at least one TOKEN_CONTEXT_TRIMMED runtime_progress event for a 1000-file workspace.');
  }

  const navigationOnlyTrims = trimmedEvents.filter(
    (event) => event.metadata.payload?.trimStage === 'navigation_only'
  );
  if (!navigationOnlyTrims.length) {
    const seenStages = [...new Set(trimmedEvents.map((event) => event.metadata.payload?.trimStage))];
    throw new Error(
      `Expected at least one trim event at navigation_only stage, saw stages: ${JSON.stringify(seenStages)}`
    );
  }

  const tokenBudgetExceededEvents = events.filter(
    (event) => event.type === 'error_reported' && event.metadata.payload?.code === 'TOKEN_BUDGET_EXCEEDED'
  );
  if (tokenBudgetExceededEvents.length > 0) {
    throw new Error(
      `Expected no TOKEN_BUDGET_EXCEEDED errors with navigation_only fallback, got ${tokenBudgetExceededEvents.length}: ${JSON.stringify(
        tokenBudgetExceededEvents[0]
      )}`
    );
  }

  const navEvent = navigationOnlyTrims.at(-1);
  if (navEvent.metadata.payload.diagnostics?.finalStage !== 'navigation_only') {
    throw new Error(
      `Expected diagnostics.finalStage === navigation_only, got ${navEvent.metadata.payload.diagnostics?.finalStage}`
    );
  }
  const stagesTried = navEvent.metadata.payload.diagnostics?.stagesTried ?? [];
  if (!Array.isArray(stagesTried) || !stagesTried.includes('emergency')) {
    throw new Error(
      `Expected stagesTried to include "emergency" before navigation_only, got ${JSON.stringify(stagesTried)}`
    );
  }

  const contextPacks = await api(server.apiBase, `/sessions/${sessionId}/debug/context-packs`);
  const lastPack = contextPacks.data.items
    .filter((item) => item.phase === 'task_execution')
    .at(-1)?.contextPack;
  if (!lastPack) {
    throw new Error('Expected at least one debug context-pack capture for task_execution.');
  }
  const systemRulesText = (lastPack.systemRules ?? []).join('\n');
  if (!systemRulesText.includes('contextDegraded=true')) {
    throw new Error(
      `Expected systemRules to carry contextDegraded=true after navigation_only, got: ${systemRulesText.slice(0, 500)}`
    );
  }
  if ((lastPack.selectedEvidenceContents ?? []).length > 0) {
    throw new Error(
      `Expected selectedEvidenceContents to be empty under navigation_only, got ${lastPack.selectedEvidenceContents.length} items.`
    );
  }
  if ((lastPack.workspaceManifest?.files?.length ?? 0) > 0) {
    throw new Error(
      `Expected workspaceManifest.files to be empty under navigation_only, got ${lastPack.workspaceManifest.files.length} files.`
    );
  }

  console.log('large workspace navigation_only smoke ok');
} finally {
  if (server) {
    await stopSmokeServer(server);
  }
}
