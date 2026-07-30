import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  api,
  buildServer,
  confirmBriefAndSelectWorkflow,
  createPublishedAgentWorkflow,
  listEvents,
  startSmokeServer,
  stopSmokeServer,
  waitForEvent,
  waitForStatus
} from './smoke-server.mjs';

await buildServer();

let server;
let analysisWorkflow;
const fixtureRoot = join(tmpdir(), `agent-cluster-server-local-project-analysis-${process.pid}`);

try {
  resetFixture();

  server = await startSmokeServer('server-local-project-analysis-smoke', {
    DISCUSSION_MAX_ROUNDS: '0',
    GLOBAL_DEFAULT_RUNTIME_TYPE: 'mock'
  });
  analysisWorkflow = await createPublishedAgentWorkflow(
    server.apiBase,
    'Server-local project architecture analysis',
    ['architect']
  );

  await runReadOnlyProjectAnalysis();
  resetGeneratedOutput();
  await runExplicitWriteProjectAnalysis();

  console.log('server local project analysis smoke ok');
} finally {
  if (server) {
    await stopSmokeServer(server);
  }
  rmSync(fixtureRoot, { recursive: true, force: true });
}

async function runReadOnlyProjectAnalysis() {
  const requirement = `分析一下当前的项目架构让我熟悉这个项目，目录地址是 ${fixtureRoot}`;
  const sessionId = await runConfirmedSession(requirement);

  const detail = await api(server.apiBase, `/sessions/${sessionId}`);
  if (detail.data.status !== 'COMPLETED') {
    throw new Error(`Expected explicit write analysis to complete: ${JSON.stringify(detail.data)}`);
  }
  assertWorkspaceIndex(detail);

  const events = await listEvents(server.apiBase, sessionId);
  await assertArchitectLeadsProjectAnalysis(sessionId, events);
  const blockedWriteTask = events.find(
    (event) =>
      event.type === 'task_blocked' &&
      /文件|写入|保存|agent-output|docs\/|file|write|save/i.test(
        `${event.metadata.payload?.title ?? ''} ${event.metadata.payload?.description ?? ''} ${event.metadata.payload?.resultSummary ?? ''}`
      )
  );
  if (blockedWriteTask) {
    throw new Error(`Read-only project analysis should not block on generated file tasks: ${JSON.stringify(blockedWriteTask)}`);
  }

  const fileChanges = artifactFileChanges(events);
  const generatedFileChange = fileChanges.find((change) =>
    ['agent-output/workspace-analysis.md', 'agent-output/project-architecture-analysis.md', 'agent-output/final-delivery.md'].includes(
      change.path
    )
  );
  if (generatedFileChange) {
    throw new Error(`Read-only project analysis should not expose generated fileChanges: ${JSON.stringify(generatedFileChange)}`);
  }

  const reportArtifact = events
    .flatMap((event) => event.metadata.payload?.report ? [event.metadata.payload.report] : [])
    .find(
      (artifact) =>
        artifact.kind === 'project_architecture_analysis' &&
        artifact.content?.includes('# 项目架构分析报告') &&
        artifact.content?.includes('server-local-project-analysis') &&
        artifact.content?.includes('src/main.ts') &&
        artifact.content?.includes('src/App.vue')
    );
  if (!reportArtifact) {
    throw new Error('Read-only project analysis should still expose report content for UI display');
  }

  for (const relativePath of [
    'agent-output/workspace-analysis.md',
    'agent-output/project-architecture-analysis.md',
    'agent-output/final-delivery.md'
  ]) {
    const generatedPath = join(fixtureRoot, ...relativePath.split('/'));
    if (existsSync(generatedPath)) {
      throw new Error(`Read-only project analysis should not write local file: ${generatedPath}`);
    }
  }
}

async function runExplicitWriteProjectAnalysis() {
  const requirement = `请分析当前项目架构，并写入 agent-output/project-architecture-analysis.md，目录地址是 ${fixtureRoot}`;
  const sessionId = await runConfirmedSession(requirement);

  const detail = await api(server.apiBase, `/sessions/${sessionId}`);
  assertWorkspaceIndex(detail);

  const events = await listEvents(server.apiBase, sessionId);
  await assertArchitectLeadsProjectAnalysis(sessionId, events);
  const fileChanges = artifactFileChanges(events);
  const analysisFile = fileChanges.find(
    (change) =>
      change.path === 'agent-output/project-architecture-analysis.md' &&
      change.content?.includes('# 项目架构分析报告') &&
      change.content?.includes('server-local-project-analysis') &&
      change.content?.includes('技术栈') &&
      change.content?.includes('src/main.ts') &&
      change.content?.includes('src/App.vue') &&
      change.content?.includes('vue') &&
      change.content?.includes('vite')
  );
  if (!analysisFile) {
    throw new Error(
      `Expected explicit write request to expose a concrete Chinese project architecture analysis fileChange: ${JSON.stringify(fileChanges)}`
    );
  }

  const generatedPath = join(fixtureRoot, 'agent-output', 'project-architecture-analysis.md');
  if (!existsSync(generatedPath)) {
    throw new Error(`Expected explicit write request to create local analysis file: ${generatedPath}`);
  }
  const generatedContent = readFileSync(generatedPath, 'utf8');
  if (
    !generatedContent.includes('# 项目架构分析报告') ||
    !generatedContent.includes('server-local-project-analysis') ||
    !generatedContent.includes('src/main.ts') ||
    !generatedContent.includes('src/App.vue') ||
    !generatedContent.includes('vue') ||
    !generatedContent.includes('vite')
  ) {
    throw new Error(`Expected local analysis file to contain project analysis content: ${generatedPath}`);
  }

  const finalDeliveryPath = join(fixtureRoot, 'agent-output', 'final-delivery.md');
  if (existsSync(finalDeliveryPath)) {
    throw new Error(`New final_delivery report contract must not create a legacy compatibility copy: ${finalDeliveryPath}`);
  }

  const postReview = events.find(
    (event) => event.type === 'post_review_completed' && event.metadata.payload?.recommendation === 'deliver'
  );
  if (!postReview) {
    throw new Error('Expected a successful post_review_completed event before final delivery');
  }
  const finalDelivery = events.find((event) => event.type === 'final_delivery_created');
  const report = finalDelivery?.metadata.payload?.report;
  if (
    finalDelivery?.metadata.payload?.schemaVersion !== '1.0' ||
    finalDelivery.metadata.payload?.kind !== 'final_delivery' ||
    report?.suggestedPath !== 'agent-output/project-architecture-analysis.md' ||
    !report.content?.includes('# 项目架构分析报告') ||
    !report.content?.includes('agent-output/project-architecture-analysis.md')
  ) {
    throw new Error(`Expected canonical final_delivery report contract: ${JSON.stringify(finalDelivery)}`);
  }
}

async function runConfirmedSession(requirement) {
  const created = await api(server.apiBase, '/sessions', {
    method: 'POST',
    body: JSON.stringify({
      input: requirement,
      agentIds: ['coordinator', 'architect', 'requirements', 'review'],
      workingDirectory: {
        kind: 'server_local',
        id: 'client-placeholder',
        name: 'server-local-project-analysis',
        path: fixtureRoot,
        selectedAt: new Date().toISOString()
      },
      runtimePreference: { preferredRuntimeType: 'mock', allowedRuntimeTypes: ['mock'] }
    })
  });
  const sessionId = created.data.session.id;
  try {
    await waitForEvent(server.apiBase, sessionId, 'brief_created');
  } catch (error) {
    const [detail, events] = await Promise.all([
      api(server.apiBase, `/sessions/${sessionId}`),
      listEvents(server.apiBase, sessionId)
    ]);
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; ` +
      `session=${JSON.stringify(detail.data)}; events=${JSON.stringify(events.slice(-12))}`
    );
  }
  await confirmBriefAndSelectWorkflow(
    server.apiBase,
    sessionId,
    created.data.session.currentTaskBriefId ?? (await latestBriefId(server.apiBase, sessionId)),
    analysisWorkflow
  );
  await waitForStatus(server.apiBase, sessionId, 'COMPLETED');
  return sessionId;
}

function artifactFileChanges(events) {
  return events
    .filter((event) => event.type === 'artifact_created')
    .flatMap((event) => event.metadata.payload?.runtimeProposals ?? [])
    .flatMap((proposal) => proposal.metadata?.fileChanges ?? []);
}

async function assertArchitectLeadsProjectAnalysis(sessionId, events) {
  const tasks = await api(server.apiBase, `/sessions/${sessionId}/tasks`);
  const allTaskText = tasks.data
    .map((task) => `${task.title ?? ''} ${task.description ?? ''}`)
    .join('\n');
  if (/审查架构说明|审核架构说明/.test(allTaskText)) {
    throw new Error(`Project architecture analysis should not be converted into proposal review tasks: ${allTaskText}`);
  }
  if (tasks.data.some((task) => task.title === '复核项目架构分析完整性')) {
    throw new Error(`Project architecture analysis should create only one architect scenario task: ${allTaskText}`);
  }

  const analysisTask = tasks.data.find(
    (task) => task.assignee?.type === 'agent' && task.assignee.id === '00000000-0000-0000-0000-000000000003'
  );
  if (!analysisTask) {
    throw new Error(`Expected an architect-led first-line project analysis task: ${JSON.stringify(tasks.data)}`);
  }
  if (analysisTask.assignee?.type !== 'agent' || analysisTask.assignee.id !== '00000000-0000-0000-0000-000000000003') {
    throw new Error(`Expected architect to own first-line project analysis: ${JSON.stringify(analysisTask)}`);
  }

  const architectDecision = events.find(
    (event) =>
      event.type === 'agent_message' &&
      event.taskId === analysisTask.id &&
      event.actor?.type === 'agent' &&
      event.actor.id === '00000000-0000-0000-0000-000000000003' &&
      event.metadata.payload?.phase === 'task_acceptance_decision'
  );
  if (!architectDecision) {
    throw new Error(`Expected architect to accept the first-line project analysis task: ${JSON.stringify(events)}`);
  }

  const reassignedToRequirements = events.find(
    (event) =>
      event.type === 'task_reassigned' &&
      event.taskId === analysisTask.id &&
      event.metadata.payload?.previousAssignee?.id === '00000000-0000-0000-0000-000000000003' &&
      event.metadata.payload?.assignee?.id === '00000000-0000-0000-0000-000000000002'
  );
  if (reassignedToRequirements) {
    throw new Error(`Architecture analysis must not be auto-reassigned to requirements: ${JSON.stringify(reassignedToRequirements)}`);
  }

  const requirementsBlockedAnalysis = events.find(
    (event) =>
      event.type === 'task_blocked' &&
      event.taskId === analysisTask.id &&
      event.actor?.type === 'agent' &&
      event.actor.id === '00000000-0000-0000-0000-000000000002'
  );
  if (requirementsBlockedAnalysis) {
    throw new Error(`Requirements analyst must not block the architect-owned analysis task: ${JSON.stringify(requirementsBlockedAnalysis)}`);
  }
}

function assertWorkspaceIndex(detail) {
  if (detail.data.workingDirectory?.kind !== 'server_local') {
    throw new Error(`Expected server_local working directory: ${JSON.stringify(detail.data.workingDirectory)}`);
  }
  if (
    detail.data.workspaceIndex?.workspaceId !== detail.data.workspaceId ||
    !detail.data.workspaceIndex.entries?.some((entry) => entry.path === 'src/main.ts')
  ) {
    throw new Error(`Expected Provider metadata index from server local path: ${JSON.stringify(detail.data.workspaceIndex)}`);
  }
}

function resetFixture() {
  rmSync(fixtureRoot, { recursive: true, force: true });
  mkdirSync(join(fixtureRoot, 'src'), { recursive: true });
  writeFileSync(
    join(fixtureRoot, 'package.json'),
    JSON.stringify(
      {
        name: 'server-local-project-analysis',
        description: '用于验证本地目录项目架构分析的 Vue 示例项目',
        scripts: { dev: 'vite', build: 'vite build' },
        dependencies: { vue: '^3.0.0' },
        devDependencies: { vite: '^5.0.0', typescript: '^5.0.0' }
      },
      null,
      2
    )
  );
  writeFileSync(join(fixtureRoot, 'README.md'), '# 示例项目\n\n这是一个 Vue + Vite 示例项目。\n');
  writeFileSync(join(fixtureRoot, 'src', 'main.ts'), "import { createApp } from 'vue';\n");
  writeFileSync(join(fixtureRoot, 'src', 'App.vue'), '<template><main>demo</main></template>\n');
}

function resetGeneratedOutput() {
  rmSync(join(fixtureRoot, 'agent-output'), { recursive: true, force: true });
}

async function latestBriefId(apiBase, sessionId) {
  const events = await listEvents(apiBase, sessionId);
  const brief = events.find((event) => event.type === 'brief_created');
  if (!brief?.metadata?.payload?.briefId) {
    throw new Error('Expected brief_created before confirmation');
  }
  return brief.metadata.payload.briefId;
}
