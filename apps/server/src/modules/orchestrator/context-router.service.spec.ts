import test from 'node:test';
import assert from 'node:assert/strict';
import type { ContextAssembly, SessionDetail, WorkspaceSnapshot } from '@agent-cluster/shared';
import { ContextRouterService } from './context-router.service.js';
import { buildEnvelopeFromContextAssembly } from '../context-v2/build-envelope-from-context-assembly.js';

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
    dataEpoch: 'epoch-test',
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
      assignee: { type: 'agent', id: 'architect' },
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

test('architecture routing selects file candidates from the Provider index without a Snapshot', () => {
  const indexedSession: SessionDetail = {
    ...session(),
    workspaceSnapshot: undefined,
    workspaceIndex: {
      workspaceId: 'workspace-1',
      revision: { id: 'revision-3', observedAt: '2026-07-28T00:00:00.000Z' },
      generation: 3,
      status: 'building',
      complete: false,
      entries: [
        { path: 'package.json', kind: 'file', size: 100, generated: false, sensitive: false },
        { path: 'src/main.ts', kind: 'file', size: 100, generated: false, sensitive: false },
        { path: 'src/services/user.service.ts', kind: 'file', size: 100, generated: false, sensitive: false }
      ],
      entrypoints: ['src/main.ts'],
      detectedStack: ['node'],
      indexedEntries: 3,
      truncated: false,
      updatedAt: '2026-07-28T00:00:00.000Z',
      coverage: {
        visitedEntries: 3, indexedEntries: 3, excludedGenerated: 0,
        sensitiveEntries: 0, skippedSymlinks: 0, failedEntries: 0
      }
    }
  };
  const taskContext = new ContextRouterService().route({
    session: indexedSession,
    phase: 'task_execution',
    relevantMemories: [], ragSnippets: [], artifacts: [], events: [],
    participatingAgentKeys: ['architect'],
    workspaceFocus: {
      relevantFiles: ['src/services/user.service.ts'], impactedFiles: [], testFiles: [],
      configFiles: ['package.json'], possibleEntryPoints: ['src/main.ts'], detectedStack: ['node'],
      validationCommands: [], rationale: 'metadata index'
    }
  });

  const refs = new Set(taskContext.evidenceRefs.map((ref) => ref.ref));
  assert.equal(refs.has('src/main.ts'), true);
  assert.equal(refs.has('src/services/user.service.ts'), true);
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
        dataEpoch: 'epoch-test',
        sessionId: nonCodingSession.id,
        type: 'markdown',
        title: 'Architect project analysis',
        contentSummary: 'Architecture overview covering entrypoints and boundaries.',
        metadata: { phase: 'task_execution' },
        runtimeProposals: [],
        platformProjections: [],
        systemEvidence: null,
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

test('runtime infrastructure diagnostics are excluded from Agent context evidence', () => {
  const router = new ContextRouterService();
  const taskContext = router.route({
    session: session(),
    phase: 'task_execution',
    relevantMemories: [],
    ragSnippets: [],
    artifacts: [],
    participatingAgentKeys: ['architect'],
    events: [
      {
        id: 'event-worktree-prepared',
        sessionId: session().id,
        type: 'runtime_progress',
        content: 'Prepared an isolated Git worktree for this Runtime.',
        toAgentIds: [],
        metadata: {
          schemaVersion: '0.1',
          renderAs: 'system_notice',
          payload: { code: 'WORKTREE_PREPARED' }
        },
        createdAt: '2026-07-16T01:52:23.000Z'
      },
      {
        id: 'event-user-message',
        sessionId: session().id,
        type: 'user_message',
        content: 'Analyze the current implementation.',
        toAgentIds: [],
        metadata: { schemaVersion: '0.1', renderAs: 'chat_message', payload: {} },
        createdAt: '2026-07-16T01:52:24.000Z'
      }
    ]
  });

  const refs = taskContext.evidenceRefs.map((ref) => ref.ref);
  assert.equal(refs.includes('event-worktree-prepared'), false);
  assert.equal(refs.includes('event-user-message'), true);
});

test('artifact diff evidence comes only from platform systemEvidence, never runtime proposals', () => {
  const router = new ContextRouterService();
  const taskContext = router.route({
    session: session(),
    phase: 'task_execution',
    relevantMemories: [],
    ragSnippets: [],
    events: [],
    participatingAgentKeys: ['architect'],
    artifacts: [{
      id: 'artifact-trust-boundary',
      dataEpoch: 'epoch-test',
      sessionId: session().id,
      type: 'json',
      title: 'Runtime proposal and observed change',
      metadata: { phase: 'task_execution' },
      runtimeProposals: [{
        type: 'markdown',
        title: 'Model proposal',
        content: 'proposal',
        uri: null,
        summary: null,
        metadata: {
          fileChanges: [{
            path: 'src/proposed-only.ts',
            operation: 'create',
            content: 'proposal',
            previousContent: null,
            encoding: 'utf-8',
            source: 'runtime_proposed_change'
          }],
          validationEvidence: null,
          summaryMemoryCheckpoint: null
        }
      }],
      platformProjections: [],
      systemEvidence: {
        invocationId: 'invocation-trust-boundary',
        capturedAt: '2026-07-15T00:00:00.000Z',
        verifiedTestResults: [],
        workspaceChangeSet: {
          id: 'change-set-trust-boundary',
          baseRevision: { id: 'revision-1', observedAt: '2026-07-15T00:00:00.000Z' },
          changes: [{ operation: 'create', path: 'src/observed.ts', content: 'observed', encoding: 'utf-8' }],
          createdAt: '2026-07-15T00:00:00.000Z'
        }
      },
      createdAt: '2026-07-15T00:00:00.000Z'
    }]
  });

  assert.equal(taskContext.evidenceRefs.some((ref) => ref.type === 'diff' && ref.ref === 'src/proposed-only.ts'), false);
  assert.equal(taskContext.evidenceRefs.some((ref) => ref.type === 'diff' && ref.ref === 'src/observed.ts'), true);
});

test('supplemental routing promotes only paths that were actually hydrated', () => {
  const router = new ContextRouterService();
  const activeSession = session();
  activeSession.supplementalContextRequests = [
    {
      id: 'request-1',
      taskId: 'task-architecture',
      agentId: 'architect',
      createdAt: '2026-07-13T00:00:00.000Z',
      requestedContext: {
        reason: 'Need two files',
        requestedRefs: [
          { type: 'artifact', label: 'Architecture', ref: 'artifact-1' },
          { type: 'historical_decision', label: 'Missing decision' }
        ],
        requestedPaths: ['src/main.ts', 'src/missing.ts']
      },
      resolution: {
        requestedFiles: [{ path: 'src/main.ts' }, { path: 'src/missing.ts' }],
        hydratedPaths: ['src/main.ts'],
        resolvedRefs: [{ type: 'artifact', label: 'Architecture', ref: 'artifact-1' }],
        failedRefs: [{ type: 'historical_decision', label: 'Missing decision', code: 'INVALID_REFERENCE', retryable: true }],
        failedPaths: [{ path: 'src/missing.ts', code: 'NOT_FOUND', retryable: false }],
        deferredPaths: [],
        contentBytes: 32,
        outcome: 'partial',
        attempt: 1,
        maxAttempts: 1
      }
    }
  ];
  const taskContext = router.route({
    session: activeSession,
    phase: 'task_execution',
    relevantMemories: [],
    ragSnippets: [],
    artifacts: [],
    events: [],
    participatingAgentKeys: ['architect'],
    task: {
      id: 'task-architecture',
      sessionId: activeSession.id,
      title: 'Analyze project architecture',
      description: 'Use hydrated evidence only.',
      status: 'assigned',
      assignee: { type: 'agent', id: 'architect' },
      dependsOnTaskIds: [],
      acceptanceCriteria: [],
      createdAt: '2026-07-13T00:00:00.000Z',
      updatedAt: '2026-07-13T00:00:00.000Z'
    }
  });

  const refs = taskContext.evidenceRefs.map((ref) => ref.ref);
  assert.ok(refs.includes('src/main.ts'));
  assert.ok(refs.includes('artifact-1'));
  assert.equal(refs.includes('src/missing.ts'), false);
  assert.equal(taskContext.evidenceRefs.some((ref) => ref.label === 'Missing decision'), false);
});

test('ai-langchain architecture routing keeps real data-flow source ahead of nested demo indexes', () => {
  const activeSession = session();
  const keyFiles = [
    'AGENTS.md',
    'package.json',
    'src/main.ts',
    'src/index.ts',
    'src/shared/model.ts',
    'src/prompts/assistantPrompt.ts',
    'src/chains/articleChain.ts',
    'src/rag/loader.ts',
    'src/rag/vectorStore.ts',
    'src/rag/retriever.ts',
    'src/demos/08-rag/pipeline.ts',
    'src/agents/assistantAgent.ts',
    'src/memory/chatMemory.ts',
    'src/tools/weatherTool.ts',
    'nuxtjs/langchain-nuxt-demo/package.json',
    'nuxtjs/langchain-nuxt-demo/app/app.vue'
  ];
  const demoIndexes = Array.from({ length: 40 }, (_, index) =>
    `src/demos/${String(index).padStart(2, '0')}/index.ts`
  );
  const paths = [...keyFiles, ...demoIndexes];
  activeSession.originalInput = '分析 D:/demo/ai-langchain 的架构、数据流转和问题定位';
  activeSession.workspaceSnapshot = {
    rootName: 'ai-langchain',
    scannedAt: '2026-07-13T00:00:00.000Z',
    fileCount: paths.length,
    totalBytes: paths.length * 100,
    tree: paths.map((path) => ({ path, kind: 'file' as const })),
    files: paths.map((path) => ({ path, size: 100, content: `// current source: ${path}` })),
    skipped: [],
    detectedStack: ['typescript', 'langchain', 'nuxt'],
    entrypoints: ['src/main.ts', 'nuxtjs/langchain-nuxt-demo/app/app.vue']
  };

  const taskContext = new ContextRouterService().route({
    session: activeSession,
    phase: 'task_execution',
    relevantMemories: [],
    ragSnippets: [],
    artifacts: [],
    events: [],
    participatingAgentKeys: ['receiver', 'requirements_analyst', 'system_architect'],
    workspaceFocus: {
      relevantFiles: [],
      impactedFiles: [],
      testFiles: [],
      configFiles: ['package.json', 'nuxtjs/langchain-nuxt-demo/package.json'],
      possibleEntryPoints: ['src/main.ts', 'nuxtjs/langchain-nuxt-demo/app/app.vue'],
      detectedStack: ['typescript', 'langchain', 'nuxt'],
      validationCommands: ['pnpm build'],
      rationale: 'ai-langchain architecture fixture'
    }
  });

  const selected = new Set(taskContext.evidenceRefs.map((ref) => ref.ref));
  for (const path of keyFiles.filter((path) => path !== 'AGENTS.md')) {
    assert.ok(selected.has(path), `expected data-flow evidence ${path}`);
  }
  assert.ok(
    taskContext.evidenceSelection.rules.some((rule) => rule.includes('cross-check')),
    'architecture routing must require source cross-checking for potentially stale docs'
  );

  const envelope = buildEnvelopeFromContextAssembly({
    session: activeSession,
    phase: 'task_execution',
    contextAssembly: {
      systemRules: taskContext.evidenceSelection.rules,
      sessionGoal: activeSession.originalInput,
      taskContext,
      selectedEvidenceContents: taskContext.evidenceRefs.flatMap((ref) => {
        const file = activeSession.workspaceSnapshot?.files.find((item) => item.path === ref.ref);
        return file?.content
          ? [{ type: ref.type, label: ref.label, ref: ref.ref, source: 'workspace_file' as const, content: file.content }]
          : [];
      }),
      summaryMemory: {
        currentState: 'analysis', confirmedFacts: [], completed: [], decisions: [], openQuestions: [], risks: [], nextSteps: []
      },
      relevantEvents: [],
      artifacts: [],
      budget: { maxInputTokens: 32_000 }
    } as unknown as ContextAssembly,
    identity: {
      agentId: 'system_architect', key: 'architect', name: 'Architect', role: 'architect', systemPrompt: 'Analyze.',
      profileHash: 'architect-profile', profileRevision: 1, skillBindings: [], requestedToolIds: [],
      requestedToolKeys: [], capabilityIds: [], knowledgeBaseIds: []
    },
    toolCatalogHash: 'read-only-catalog'
  });
  const l3Paths = new Set(envelope.L3.files.map((file) => file.path));
  for (const path of keyFiles.filter((path) => path.startsWith('src/') || path.endsWith('/app/app.vue'))) {
    assert.ok(l3Paths.has(path), `expected final L3 data-flow body ${path}`);
  }
});
