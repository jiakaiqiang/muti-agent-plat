import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  api,
  buildServer,
  listEvents,
  root,
  startSmokeServer,
  stopSmokeServer,
  waitForEvent,
  waitForStatus
} from './smoke-server.mjs';

await buildServer();

let server;
const fixtureRoot = join(root, '.cache', 'fixtures', 'server-local-project-analysis');

try {
  resetFixture();

  server = await startSmokeServer('server-local-project-analysis-smoke', {
    DISCUSSION_MAX_ROUNDS: '0'
  });

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
  assertWorkspaceSnapshot(detail);

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
    .filter((event) => event.type === 'artifact_created')
    .flatMap((event) => event.metadata.payload?.runtimeArtifacts ?? [])
    .find(
      (artifact) =>
        artifact.metadata?.reportKind === 'project_architecture_analysis' &&
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
  assertWorkspaceSnapshot(detail);

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
    throw new Error('Expected explicit write request to expose a concrete Chinese project architecture analysis fileChange');
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
  if (!existsSync(finalDeliveryPath)) {
    throw new Error(`Expected explicit write request to create final delivery file: ${finalDeliveryPath}`);
  }
  const finalDeliveryContent = readFileSync(finalDeliveryPath, 'utf8');
  if (!finalDeliveryContent.includes('项目架构分析报告正文') || !finalDeliveryContent.includes('agent-output/project-architecture-analysis.md')) {
    throw new Error('Expected explicit write final delivery to foreground the project architecture analysis report');
  }
}

async function runConfirmedSession(requirement) {
  const created = await api(server.apiBase, '/sessions', {
    method: 'POST',
    body: JSON.stringify({
      input: requirement,
      agentIds: ['coordinator', 'architect', 'requirements', 'review']
    })
  });
  const sessionId = created.data.session.id;
  await waitForEvent(server.apiBase, sessionId, 'brief_created');
  await api(
    server.apiBase,
    `/sessions/${sessionId}/briefs/${created.data.session.currentTaskBriefId ?? (await latestBriefId(server.apiBase, sessionId))}/confirm`,
    {
      method: 'POST'
    }
  );
  await waitForStatus(server.apiBase, sessionId, 'COMPLETED');
  return sessionId;
}

function artifactFileChanges(events) {
  return events
    .filter((event) => event.type === 'artifact_created')
    .flatMap((event) => event.metadata.payload?.fileChanges ?? []);
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

  const analysisTask = tasks.data.find((task) => task.title === '从架构视角分析当前项目结构与主链路');
  if (!analysisTask) {
    throw new Error(`Expected an architect-led first-line project analysis task: ${JSON.stringify(tasks.data)}`);
  }
  if (analysisTask.assigneeAgentId !== '00000000-0000-0000-0000-000000000003') {
    throw new Error(`Expected architect to own first-line project analysis: ${JSON.stringify(analysisTask)}`);
  }

  const architectDecision = events.find(
    (event) =>
      event.type === 'agent_message' &&
      event.taskId === analysisTask.id &&
      event.fromAgentId === '00000000-0000-0000-0000-000000000003' &&
      event.metadata.payload?.phase === 'task_acceptance_decision'
  );
  if (!architectDecision) {
    throw new Error(`Expected architect to accept the first-line project analysis task: ${JSON.stringify(events)}`);
  }

  const reassignedToRequirements = events.find(
    (event) =>
      event.type === 'task_reassigned' &&
      event.taskId === analysisTask.id &&
      event.metadata.payload?.previousAssigneeAgentId === '00000000-0000-0000-0000-000000000003' &&
      event.metadata.payload?.assigneeAgentId === '00000000-0000-0000-0000-000000000002'
  );
  if (reassignedToRequirements) {
    throw new Error(`Architecture analysis must not be auto-reassigned to requirements: ${JSON.stringify(reassignedToRequirements)}`);
  }

  const requirementsBlockedAnalysis = events.find(
    (event) =>
      event.type === 'task_blocked' &&
      event.taskId === analysisTask.id &&
      event.fromAgentId === '00000000-0000-0000-0000-000000000002'
  );
  if (requirementsBlockedAnalysis) {
    throw new Error(`Requirements analyst must not block the architect-owned analysis task: ${JSON.stringify(requirementsBlockedAnalysis)}`);
  }
}

function assertWorkspaceSnapshot(detail) {
  if (detail.data.workingDirectory?.kind !== 'server_local') {
    throw new Error(`Expected server_local working directory: ${JSON.stringify(detail.data.workingDirectory)}`);
  }
  if (detail.data.workspaceSnapshot?.rootName !== 'server-local-project-analysis') {
    throw new Error(`Expected workspace snapshot from server local path: ${JSON.stringify(detail.data.workspaceSnapshot)}`);
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
