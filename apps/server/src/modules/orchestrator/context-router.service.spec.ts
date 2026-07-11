import test from 'node:test';
import assert from 'node:assert/strict';
import type { SessionDetail, WorkspaceSnapshot } from '@agent-cluster/shared';
import { ContextRouterService } from './context-router.service.js';

function workspaceSnapshot(): WorkspaceSnapshot {
  const files = [
    { path: 'package.json', size: 120, language: 'json', content: '{"scripts":{"build":"vite build"}}' },
    { path: 'README.md', size: 80, language: 'markdown', content: '# Demo' },
    { path: 'src/main.ts', size: 90, language: 'typescript', content: 'import { createApp } from "vue";' },
    { path: 'src/router/index.ts', size: 90, language: 'typescript', content: 'export const routes = [];' },
    { path: 'src/services/user.service.ts', size: 120, language: 'typescript', content: 'export class UserService {}' },
    { path: 'src/contracts/user.ts', size: 70, language: 'typescript', content: 'export type User = { id: string };' },
    { path: 'src/components/Hello.vue', size: 90, language: 'vue', content: '<template>Hello</template>' },
    { path: 'tests/main.spec.ts', size: 80, language: 'typescript', content: 'test("demo", () => {});' }
  ];
  return {
    rootName: 'demo-project',
    scannedAt: '2026-07-03T00:00:00.000Z',
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
    tree: files.map((file) => ({ path: file.path, kind: 'file' as const })),
    files,
    skipped: [],
    detectedStack: ['vue', 'vite'],
    entrypoints: ['src/main.ts']
  };
}

function session(): SessionDetail {
  return {
    id: 'session-architecture',
    title: 'Architecture analysis',
    originalInput: 'Analyze this project architecture and main path',
    status: 'EXECUTING',
    ownerId: 'user-1',
    workspaceId: 'workspace-1',
    workingDirectory: {
      kind: 'server_local',
      id: 'wd-1',
      name: 'demo-project',
      path: 'D:/demo/project',
      selectedAt: '2026-07-03T00:00:00.000Z'
    },
    workspaceSnapshot: workspaceSnapshot(),
    tokenUsed: 0,
    taskDomain: 'mixed',
    taskIntent: 'analysis',
    participatingAgentIds: ['coordinator', 'architect', 'requirements'],
    createdAt: '2026-07-03T00:00:00.000Z',
    updatedAt: '2026-07-03T00:00:00.000Z'
  };
}

test('architecture analysis routing prioritizes entrypoint, config, service, and contract evidence', () => {
  const router = new ContextRouterService();
  const taskContext = router.route({
    session: session(),
    phase: 'task_execution',
    relevantMemories: [],
    ragSnippets: [],
    artifacts: [],
    events: [],
    participatingAgentKeys: ['coordinator', 'architect', 'requirements'],
    workspaceFocus: {
      relevantFiles: [],
      impactedFiles: [],
      testFiles: [],
      configFiles: ['package.json'],
      possibleEntryPoints: ['src/main.ts'],
      detectedStack: ['vue', 'vite'],
      validationCommands: ['npm run build'],
      rationale: 'fixture focus'
    },
    projectMap: {
      source: 'generated',
      modules: [],
      validationCommands: ['npm run build'],
      riskBoundaries: [],
      memoryLocations: [],
      sourceRefs: ['package.json'],
      generatedAt: '2026-07-03T00:00:00.000Z'
    },
    task: {
      id: 'task-architecture',
      sessionId: 'session-architecture',
      title: 'Analyze current project structure and main path from an architecture viewpoint',
      description: 'Use project evidence to explain structure and main path.',
      status: 'assigned',
      assigneeAgentId: 'architect',
      dependsOnTaskIds: [],
      acceptanceCriteria: [],
      createdAt: '2026-07-03T00:00:00.000Z',
      updatedAt: '2026-07-03T00:00:00.000Z'
    }
  });

  const selectedRefs = new Set(taskContext.evidenceRefs.map((ref) => ref.ref ?? ref.label));
  assert.equal(taskContext.evidenceSelection.strategy, 'architecture_analysis');
  assert.equal(taskContext.requiresCodeChanges, false);
  assert.equal(taskContext.agentResponsibilities[0]?.agentKey, 'architect');
  assert.ok(selectedRefs.has('package.json'));
  assert.ok(selectedRefs.has('src/main.ts'));
  assert.ok(selectedRefs.has('src/services/user.service.ts'));
  assert.ok(selectedRefs.has('src/contracts/user.ts'));
});

test('non_coding session preserves artifact type instead of remapping to document_fragment', () => {
  const router = new ContextRouterService();
  const baseSession = session();
  const nonCodingSession: SessionDetail = {
    ...baseSession,
    id: 'session-non-coding',
    taskDomain: 'non_coding',
    taskIntent: 'analysis',
    workspaceSnapshot: undefined
  };
  const architectArtifactId = '79b988b0-aaaa-bbbb-cccc-000000000001';
  const taskContext = router.route({
    session: nonCodingSession,
    phase: 'task_execution',
    relevantMemories: [],
    ragSnippets: [],
    events: [],
    participatingAgentKeys: ['coordinator', 'architect', 'requirements'],
    artifacts: [
      {
        id: architectArtifactId,
        sessionId: nonCodingSession.id,
        type: 'markdown',
        title: 'Architect project analysis',
        contentSummary: 'Architecture overview covering entrypoints and boundaries.',
        metadata: {},
        createdAt: '2026-07-07T00:00:00.000Z'
      }
    ]
  });

  const artifactRef = taskContext.evidenceRefs.find((ref) => ref.ref === architectArtifactId);
  assert.ok(artifactRef, 'artifact ref should be routed into evidenceRefs');
  assert.equal(
    artifactRef?.type,
    'artifact',
    'non_coding session must keep artifact type = artifact so orchestrator can inject its content'
  );
});
