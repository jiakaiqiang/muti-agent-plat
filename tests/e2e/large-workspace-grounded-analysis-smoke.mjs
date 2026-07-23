import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  api,
  buildServer,
  confirmBriefAndSelectWorkflow,
  createPublishedAgentWorkflow,
  listEvents,
  root,
  startSmokeServer,
  stopSmokeServer,
  waitForEvent,
  waitForStatus
} from './smoke-server.mjs';

await buildServer();

let server;
let analysisWorkflow;
const fixtureRoot = join(root, '.cache', 'fixtures', 'large-workspace-grounded-analysis');

try {
  resetFixture();

  server = await startSmokeServer('large-workspace-grounded-analysis-smoke', {
    DISCUSSION_MAX_ROUNDS: '0',
    GLOBAL_DEFAULT_RUNTIME_TYPE: 'mock',
    TOKEN_BUDGET_DEFAULT: '50000'
  });
  analysisWorkflow = await createPublishedAgentWorkflow(
    server.apiBase,
    'Large workspace grounded architecture analysis',
    ['architect']
  );

  const sessionId = await runConfirmedAnalysisSession();
  const detail = await api(server.apiBase, `/sessions/${sessionId}`);
  assertLargeWorkspaceSnapshot(detail.data.workspaceSnapshot);

  const envelopes = await api(server.apiBase, `/sessions/${sessionId}/debug/context-envelopes`);
  const groundedEnvelope = [...envelopes.data.items]
    .reverse()
    .find((item) => {
      const evidence = item.contextEnvelope?.L3.files ?? [];
      return item.phase === 'task_execution' && evidence.some((entry) => entry.content);
    })?.contextEnvelope;
  if (!groundedEnvelope) {
    throw new Error(`Expected a task_execution envelope with non-empty workspace evidence: ${JSON.stringify(envelopes.data.items)}`);
  }

  const selectedEvidence = groundedEnvelope.L3.files;
  const selectedRefs = selectedEvidence.map((entry) => entry.path);
  if (!selectedRefs.includes('src/main.ts')) {
    throw new Error(`Expected src/main.ts to be selected as real evidence: ${JSON.stringify(selectedEvidence)}`);
  }
  if (!selectedEvidence.some((entry) => entry.content?.includes('bootstrapLargeWorkspace'))) {
    throw new Error(`Expected selected evidence content from src/main.ts: ${JSON.stringify(selectedEvidence)}`);
  }

  const events = await listEvents(server.apiBase, sessionId);
  const reports = events.flatMap((event) => event.metadata.payload?.report ? [event.metadata.payload.report] : []);
  const reportArtifact = reports.find(
      (artifact) =>
        artifact.kind === 'project_architecture_analysis' &&
        artifact.content?.includes('# 项目架构分析报告') &&
        artifact.content?.includes('large-workspace-grounded-analysis') &&
        artifact.content?.includes('src/main.ts')
    );
  if (!reportArtifact) {
    throw new Error(
      `Expected completed architecture analysis report artifact: ${JSON.stringify(
        reports.map((artifact) => ({
          title: artifact.title,
          kind: artifact.kind,
          contentPreview: artifact.content?.slice(0, 500)
        }))
      )}`
    );
  }

  console.log('large workspace grounded analysis smoke ok');
} finally {
  if (server) {
    await stopSmokeServer(server);
  }
  rmSync(fixtureRoot, { recursive: true, force: true });
}

async function runConfirmedAnalysisSession() {
  const created = await api(server.apiBase, '/sessions', {
    method: 'POST',
    body: JSON.stringify({
      input: `请分析当前项目架构并给出主链路说明，目录地址是 ${fixtureRoot}`,
      agentIds: ['coordinator', 'architect', 'requirements', 'review'],
      runtimePreference: { preferredRuntimeType: 'mock', allowedRuntimeTypes: ['mock'] }
    })
  });
  const sessionId = created.data.session.id;
  try {
    await waitForEvent(server.apiBase, sessionId, 'brief_created');
  } catch (error) {
    const detail = await api(server.apiBase, `/sessions/${sessionId}`);
    const events = await listEvents(server.apiBase, sessionId);
    throw new Error(
      `Brief creation failed for status ${detail.data.status}: ${JSON.stringify(events.slice(-12))}`,
      { cause: error }
    );
  }
  const briefId = created.data.session.currentTaskBriefId ?? (await latestBriefId(sessionId));
  await confirmBriefAndSelectWorkflow(server.apiBase, sessionId, briefId, analysisWorkflow);
  await waitForStatus(server.apiBase, sessionId, 'COMPLETED', 120_000);
  return sessionId;
}

async function latestBriefId(sessionId) {
  const events = await listEvents(server.apiBase, sessionId);
  const brief = events.find((event) => event.type === 'brief_created');
  if (!brief?.metadata?.payload?.briefId) {
    throw new Error('Expected brief_created before confirmation');
  }
  return brief.metadata.payload.briefId;
}

function assertLargeWorkspaceSnapshot(snapshot) {
  if (snapshot?.rootName !== 'large-workspace-grounded-analysis') {
    throw new Error(`Expected large workspace snapshot, got: ${JSON.stringify(snapshot)}`);
  }
  if (!existsSync(fixtureRoot)) {
    throw new Error(`Expected fixture root to exist: ${fixtureRoot}`);
  }
  const entrypoints = snapshot.entrypoints ?? [];
  if (!entrypoints.includes('src/main.ts')) {
    throw new Error(`Expected src/main.ts entrypoint in snapshot: ${JSON.stringify(snapshot)}`);
  }
  const coverage = snapshot.coverage;
  if (!coverage || coverage.scannedEntries < 300 || coverage.readableFiles === 0) {
    throw new Error(`Expected non-trivial partial scan coverage: ${JSON.stringify(coverage)}`);
  }
}

function resetFixture() {
  rmSync(fixtureRoot, { recursive: true, force: true });
  mkdirSync(fixtureRoot, { recursive: true });
  writeFileSync(
    join(fixtureRoot, 'package.json'),
    JSON.stringify(
      {
        name: 'large-workspace-grounded-analysis',
        description: 'Large workspace fixture for grounded architecture analysis',
        scripts: { dev: 'vite', build: 'vite build', typecheck: 'tsc --noEmit' },
        dependencies: { vue: '^3.5.0', pinia: '^2.3.0' },
        devDependencies: { vite: '^6.0.0', typescript: '^5.7.0' }
      },
      null,
      2
    )
  );
  writeFileSync(join(fixtureRoot, 'README.md'), '# Large Workspace\n\nA Vue and Vite project used for grounded analysis.\n');
  writeGroup('generated', 250, (dir, i) => {
    writeFileSync(join(dir, `module-${i}.js`), `export const generated${i} = ${i};\n`);
    writeFileSync(join(dir, `module-${i}.d.ts`), `export declare const generated${i}: number;\n`);
  });
  writeGroup('memory', 150, (dir, i) => {
    writeFileSync(join(dir, `snapshot-${i}.jsonl`), `{"turn":${i},"summary":"memory ${i}"}\n`);
  });
  writeGroup('rag', 150, (dir, i) => {
    writeFileSync(join(dir, `doc-${i}.md`), `# RAG ${i}\n\nArchitecture note ${i}.\n`);
  });
  writeGroup('src', 300, (dir, i) => {
    if (i === 0) {
      writeFileSync(
        join(dir, 'main.ts'),
        "import { createApp } from 'vue';\nimport App from './App.vue';\n\nexport function bootstrapLargeWorkspace() { return createApp(App); }\n"
      );
      return;
    }
    if (i === 1) {
      writeFileSync(join(dir, 'App.vue'), '<template><main>large workspace</main></template>\n');
      return;
    }
    writeFileSync(join(dir, `unit-${i}.ts`), `export function unit${i}() { return ${i}; }\n`);
  });
  writeGroup('tools', 150, (dir, i) => {
    writeFileSync(join(dir, `tool-${i}.json`), `{"name":"tool-${i}","version":"1.0.0"}\n`);
  });
}

function writeGroup(name, count, write) {
  const dir = join(fixtureRoot, name);
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < count; i += 1) {
    write(dir, i);
  }
}
