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

  server = await startSmokeServer('server-local-project-analysis-smoke', {
    DISCUSSION_MAX_ROUNDS: '0'
  });

  const requirement = `分析一下当前的项目架构让我熟悉这个项目，目录地址是 ${fixtureRoot}`;
  const created = await api(server.apiBase, '/sessions', {
    method: 'POST',
    body: JSON.stringify({
      input: requirement,
      agentIds: ['coordinator', 'architect', 'review']
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

  const detail = await api(server.apiBase, `/sessions/${sessionId}`);
  if (detail.data.workingDirectory?.kind !== 'server_local') {
    throw new Error(`Expected server_local working directory: ${JSON.stringify(detail.data.workingDirectory)}`);
  }
  if (detail.data.workspaceSnapshot?.rootName !== 'server-local-project-analysis') {
    throw new Error(`Expected workspace snapshot from server local path: ${JSON.stringify(detail.data.workspaceSnapshot)}`);
  }

  const events = await listEvents(server.apiBase, sessionId);
  const fileChanges = events
    .filter((event) => event.type === 'artifact_created')
    .flatMap((event) => event.metadata.payload?.fileChanges ?? []);
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
    throw new Error('Expected a concrete Chinese project architecture analysis artifact file');
  }

  const generatedPath = join(fixtureRoot, 'agent-output', 'project-architecture-analysis.md');
  if (!existsSync(generatedPath)) {
    throw new Error(`Expected project architecture analysis file to be written locally: ${generatedPath}`);
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
    throw new Error(`Expected final delivery file to be written locally: ${finalDeliveryPath}`);
  }
  const finalDeliveryContent = readFileSync(finalDeliveryPath, 'utf8');
  if (!finalDeliveryContent.includes('项目架构分析报告正文') || !finalDeliveryContent.includes('agent-output/project-architecture-analysis.md')) {
    throw new Error('Expected final delivery to foreground the project architecture analysis report');
  }

  console.log('server local project analysis smoke ok');
} finally {
  if (server) {
    await stopSmokeServer(server);
  }
  rmSync(fixtureRoot, { recursive: true, force: true });
}

async function latestBriefId(apiBase, sessionId) {
  const events = await listEvents(apiBase, sessionId);
  const brief = events.find((event) => event.type === 'brief_created');
  if (!brief?.metadata?.payload?.briefId) {
    throw new Error('Expected brief_created before confirmation');
  }
  return brief.metadata.payload.briefId;
}
