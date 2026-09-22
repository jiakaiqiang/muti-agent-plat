import assert from 'node:assert/strict';
import test from 'node:test';
import type { ContextAssembly, SessionDetail } from '@agent-cluster/shared';
import { workspaceMetrics } from '../../common/workspace-metrics.js';
import { buildEnvelopeFromContextAssembly } from './build-envelope-from-context-assembly.js';

test('buildEnvelopeFromContextAssembly creates the authoritative grounded v2 layers', () => {
  const contextAssembly = {
    systemRules: ['Stay grounded.'],
    sessionGoal: 'Inspect the repository',
    currentUserMessage: '继续',
    attachmentRefs: [{
      id: 'attachment-1', sessionId: 'session-v2', kind: 'file', fileName: 'notes.txt',
      mimeType: 'text/plain', sizeBytes: 12, uploadStatus: 'ready', createdAt: '2026-07-12T00:00:00.000Z'
    }],
    budget: { maxInputTokens: 10_000 },
    selectedEvidenceContents: [{
      type: 'workspace_file',
      label: 'src/main.ts',
      ref: 'src/main.ts',
      source: 'workspace_file',
      content: 'export const main = true;'
    }],
    summaryMemory: {
      goal: 'inspect', currentState: 'running', confirmedFacts: [], completed: [], decisions: [],
      openQuestions: [], risks: [], nextSteps: []
    },
    relevantEvents: [],
    artifacts: []
  } as unknown as ContextAssembly;
  const session = {
    id: 'session-v2', workspaceId: 'workspace-v2', tokenUsed: 0,
    participatingAgentIds: [],
    createdAt: '2026-07-12T00:00:00.000Z', updatedAt: '2026-07-12T00:00:00.000Z',
    workspaceSnapshot: {
      rootName: 'repo', scannedAt: '2026-07-12T00:00:00.000Z', fileCount: 1, totalBytes: 25,
      tree: [{ path: 'src/main.ts', kind: 'file' }],
      files: [{ path: 'src/main.ts', size: 25, content: 'export const main = true;' }], skipped: []
    }
  } as unknown as SessionDetail;

  const envelope = buildEnvelopeFromContextAssembly({
    session,
    phase: 'task_execution',
    contextAssembly,
    identity: {
      agentId: 'agent-v2', key: 'agent', name: 'Agent', role: 'worker', systemPrompt: 'Work.',
      profileHash: 'profile-hash', profileRevision: 1, skillBindings: [], requestedToolIds: [],
      requestedToolKeys: [], capabilityIds: [], knowledgeBaseIds: []
    },
    toolCatalogHash: 'catalog-hash'
  });
  assert.equal(envelope.version, 'v2');
  assert.equal(envelope.L1.currentUserMessage, undefined);
  assert.equal(envelope.L1.attachmentRefs?.[0]?.fileName, 'notes.txt');
  assert.equal('currentUserMessage' in envelope.L0, false);
  assert.equal(envelope.L3.files[0]?.path, 'src/main.ts');
  assert.equal(envelope.L3.totalByteLength > 0, true);
  assert.equal(envelope.budget.navigationTokens, 1500);
  assert.equal(envelope.budget.evidenceTokens, 4000);
  assert.deepEqual(envelope.contextScope, {
    inheritedDecisionIds: [],
    inheritedArtifactIds: []
  });

  const routingEnvelope = buildEnvelopeFromContextAssembly({
    session,
    phase: 'user_message_routing',
    contextAssembly,
    identity: {
      agentId: 'agent-v2', key: 'agent', name: 'Agent', role: 'worker', systemPrompt: 'Work.',
      profileHash: 'profile-hash', profileRevision: 1, skillBindings: [], requestedToolIds: [],
      requestedToolKeys: [], capabilityIds: [], knowledgeBaseIds: []
    },
    toolCatalogHash: 'catalog-hash'
  });
  assert.equal(routingEnvelope.L1.currentUserMessage, '继续');
  assert.equal('currentUserMessage' in routingEnvelope.L0, false);
});

test('buildEnvelopeFromContextAssembly preserves a local_bridge workspace authority binding', () => {
  const contextAssembly = {
    systemRules: [],
    sessionGoal: 'Modify an authorized local workspace',
    budget: { maxInputTokens: 1_000 },
    summaryMemory: {
      currentState: 'ready', confirmedFacts: [], completed: [], decisions: [],
      openQuestions: [], risks: [], nextSteps: []
    },
    relevantEvents: [],
    artifacts: []
  } as unknown as ContextAssembly;
  const session = {
    id: 'local-session',
    workspaceId: 'local-workspace',
    workingDirectory: {
      kind: 'local_bridge',
      id: 'local-workspace',
      name: 'local-project',
      selectedAt: '2026-07-24T00:00:00.000Z'
    },
    tokenUsed: 0,
    participatingAgentIds: [],
    createdAt: '2026-07-24T00:00:00.000Z',
    updatedAt: '2026-07-24T00:00:00.000Z'
  } as unknown as SessionDetail;

  const envelope = buildEnvelopeFromContextAssembly({
    session,
    phase: 'discussion',
    contextAssembly,
    identity: {
      agentId: 'backend', key: 'backend', name: 'Backend', role: 'worker', systemPrompt: 'Work.',
      profileHash: 'profile', profileRevision: 1, skillBindings: [], requestedToolIds: [],
      requestedToolKeys: [], capabilityIds: [], knowledgeBaseIds: []
    },
    toolCatalogHash: 'catalog'
  });

  assert.equal(envelope.L0.workspace.workspaceId, 'local-workspace');
  assert.equal(envelope.L0.workspace.rootName, 'local-project');
  assert.equal(envelope.L0.workspace.providerKind, 'local_bridge');
});

test('buildEnvelopeFromContextAssembly consumes a partial Provider index with generation diagnostics', () => {
  const revision = { id: 'index-revision-3', observedAt: '2026-07-28T00:00:00.000Z' };
  const session = {
    id: 'indexed-session',
    workspaceId: 'indexed-workspace',
    tokenUsed: 0,
    participatingAgentIds: [],
    createdAt: '2026-07-28T00:00:00.000Z',
    updatedAt: '2026-07-28T00:00:00.000Z',
    workspaceIndex: {
      workspaceId: 'indexed-workspace',
      revision,
      generation: 3,
      status: 'building',
      complete: false,
      entries: [
        { path: 'src', kind: 'directory', generated: false, sensitive: false },
        { path: 'src/main.ts', kind: 'file', size: 24, language: 'typescript', generated: false, sensitive: false }
      ],
      entrypoints: ['src/main.ts'],
      detectedStack: ['node'],
      indexedEntries: 2,
      truncated: false,
      updatedAt: '2026-07-28T00:00:00.000Z'
    }
  } as unknown as SessionDetail;
  const contextAssembly = {
    systemRules: [], sessionGoal: 'Inspect partial index', budget: { maxInputTokens: 1_000 },
    summaryMemory: { currentState: 'ready', confirmedFacts: [], completed: [], decisions: [], openQuestions: [], risks: [], nextSteps: [] },
    relevantEvents: [], artifacts: []
  } as unknown as ContextAssembly;

  const envelope = buildEnvelopeFromContextAssembly({
    session,
    phase: 'discussion',
    contextAssembly,
    identity: {
      agentId: 'architect', key: 'architect', name: 'Architect', role: 'worker', systemPrompt: 'Work.',
      profileHash: 'profile', profileRevision: 1, skillBindings: [], requestedToolIds: [],
      requestedToolKeys: [], capabilityIds: [], knowledgeBaseIds: []
    },
    toolCatalogHash: 'catalog'
  });

  assert.equal(envelope.L0.workspace.revision.id, revision.id);
  assert.equal(envelope.L1.navigation.indexGeneration, 3);
  assert.equal(envelope.L1.navigation.indexStatus, 'building');
  assert.equal(envelope.L1.navigation.indexComplete, false);
  assert.equal(envelope.L1.navigation.entries.some((entry) => entry.path === 'src/main.ts'), true);
  assert.equal(envelope.L2.detectedStack?.includes('node'), true);
});

test('Provider index excludes selected file bodies captured at an older revision', () => {
  const currentRevision = { id: 'revision-current', observedAt: '2026-07-28T00:00:00.000Z' };
  const staleRevision = { id: 'revision-stale', observedAt: '2026-07-27T00:00:00.000Z' };
  const session = {
    id: 'revision-session', workspaceId: 'revision-workspace', tokenUsed: 0, participatingAgentIds: [],
    createdAt: currentRevision.observedAt, updatedAt: currentRevision.observedAt,
    workspaceIndex: {
      workspaceId: 'revision-workspace', revision: currentRevision, generation: 2, status: 'ready', complete: true,
      entries: [{ path: 'src/main.ts', kind: 'file', size: 12, generated: false, sensitive: false }],
      entrypoints: ['src/main.ts'], detectedStack: ['node'], indexedEntries: 1, truncated: false,
      updatedAt: currentRevision.observedAt
    }
  } as unknown as SessionDetail;
  const contextAssembly = {
    systemRules: [], sessionGoal: 'Use current evidence', budget: { maxInputTokens: 1_000 },
    selectedEvidenceContents: [{
      type: 'workspace_file', label: 'src/main.ts', ref: 'src/main.ts', source: 'workspace_file',
      content: 'stale body', revision: staleRevision
    }],
    summaryMemory: { currentState: '', confirmedFacts: [], completed: [], decisions: [], openQuestions: [], risks: [], nextSteps: [] },
    relevantEvents: [], artifacts: []
  } as unknown as ContextAssembly;

  const envelope = buildEnvelopeFromContextAssembly({
    session, phase: 'task_execution', contextAssembly,
    identity: {
      agentId: 'agent', key: 'agent', name: 'Agent', role: 'worker', systemPrompt: 'Work.',
      profileHash: 'hash', profileRevision: 1, skillBindings: [], requestedToolIds: [], requestedToolKeys: [],
      capabilityIds: [], knowledgeBaseIds: []
    },
    toolCatalogHash: 'catalog'
  });

  assert.deepEqual(envelope.L3.files, []);
  assert.doesNotMatch(JSON.stringify(envelope), /stale body/);
});

test('buildEnvelopeFromContextAssembly enforces the L3 budget while preserving one grounded body', () => {
  const content = 'export const marker = true;\n'.repeat(500);
  const contextAssembly = {
    systemRules: ['Stay grounded.'],
    sessionGoal: 'Analyze architecture',
    budget: { maxInputTokens: 200 },
    selectedEvidenceContents: [
      {
        type: 'workspace_file', label: 'src/main.ts', ref: 'src/main.ts', source: 'workspace_file', content,
        selectionReason: 'Architecture analysis priority: entrypoint.'
      },
      {
        type: 'workspace_file', label: 'src/secondary.ts', ref: 'src/secondary.ts', source: 'workspace_file', content
      }
    ],
    summaryMemory: {
      goal: 'inspect', currentState: 'running', confirmedFacts: [], completed: [], decisions: [],
      openQuestions: [], risks: [], nextSteps: []
    },
    relevantEvents: [],
    artifacts: []
  } as unknown as ContextAssembly;
  const session = {
    id: 'session-budget', workspaceId: 'workspace-budget', tokenUsed: 0, participatingAgentIds: [],
    createdAt: '2026-07-13T00:00:00.000Z', updatedAt: '2026-07-13T00:00:00.000Z',
    workspaceSnapshot: {
      rootName: 'repo', scannedAt: '2026-07-13T00:00:00.000Z', fileCount: 2, totalBytes: content.length * 2,
      tree: [{ path: 'src/main.ts', kind: 'file' }, { path: 'src/secondary.ts', kind: 'file' }],
      files: [
        { path: 'src/main.ts', size: content.length, content },
        { path: 'src/secondary.ts', size: content.length, content }
      ],
      skipped: [], entrypoints: ['src/main.ts']
    }
  } as unknown as SessionDetail;

  const envelope = buildEnvelopeFromContextAssembly({
    session,
    phase: 'task_execution',
    contextAssembly,
    identity: {
      agentId: 'architect', key: 'architect', name: 'Architect', role: 'architect', systemPrompt: 'Work.',
      profileHash: 'profile', profileRevision: 1, skillBindings: [], requestedToolIds: [],
      requestedToolKeys: [], capabilityIds: [], knowledgeBaseIds: []
    },
    toolCatalogHash: 'catalog'
  });

  assert.equal(envelope.L3.files.length, 1);
  assert.equal(envelope.L3.files[0]?.path, 'src/main.ts');
  assert.ok(envelope.L3.totalByteLength > 0);
  assert.ok(envelope.L3.totalByteLength <= envelope.budget.evidenceTokens * 4);
  assert.equal(envelope.L3.truncated, true);
});

test('buildEnvelopeFromContextAssembly never admits sensitive or unknown Snapshot evidence into L3', () => {
  const contextAssembly = {
    systemRules: [],
    sessionGoal: 'Inspect source',
    budget: { maxInputTokens: 1_000 },
    selectedEvidenceContents: [
      { type: 'workspace_file', label: '.env', ref: '.env', source: 'workspace_file', content: 'TOKEN=topsecret' },
      { type: 'workspace_file', label: 'unknown.txt', ref: 'unknown.txt', source: 'workspace_file', content: 'unknown' },
      { type: 'workspace_file', label: 'src/main.ts', ref: 'src/main.ts', source: 'workspace_file', content: 'export {}' }
    ],
    summaryMemory: { currentState: '', confirmedFacts: [], completed: [], decisions: [], openQuestions: [], risks: [], nextSteps: [] },
    relevantEvents: [],
    artifacts: []
  } as unknown as ContextAssembly;
  const session = {
    id: 'sensitive-session', workspaceId: 'workspace', tokenUsed: 0, participatingAgentIds: [],
    createdAt: '2026-07-13T00:00:00.000Z', updatedAt: '2026-07-13T00:00:00.000Z',
    workspaceSnapshot: {
      rootName: 'repo', scannedAt: '2026-07-13T00:00:00.000Z', fileCount: 2, totalBytes: 30,
      tree: [{ path: '.env', kind: 'file' }, { path: 'src/main.ts', kind: 'file' }],
      files: [
        { path: '.env', size: 15, content: 'TOKEN=topsecret' },
        { path: 'src/main.ts', size: 9, content: 'export {}' }
      ],
      skipped: []
    }
  } as unknown as SessionDetail;
  const envelope = buildEnvelopeFromContextAssembly({
    session,
    phase: 'task_execution',
    contextAssembly,
    identity: {
      agentId: 'agent', key: 'agent', name: 'Agent', role: 'worker', systemPrompt: 'Work.',
      profileHash: 'hash', profileRevision: 1, skillBindings: [], requestedToolIds: [], requestedToolKeys: [],
      capabilityIds: [], knowledgeBaseIds: []
    },
    toolCatalogHash: 'catalog'
  });
  assert.deepEqual(envelope.L3.files.map((file) => file.path), ['src/main.ts']);
  assert.doesNotMatch(JSON.stringify(envelope), /topsecret/);
});

test('buildEnvelopeFromContextAssembly carries selected supplemental memory in L5 without forging L3 files', () => {
  const marker = 'SUPPLEMENTAL_MEMORY_MARKER_20260715';
  const contextAssembly = {
    systemRules: [],
    sessionGoal: 'Continue the current task with the user supplement',
    budget: { maxInputTokens: 1_000 },
    selectedEvidenceContents: [{
      type: 'memory',
      label: 'Executing supplement',
      ref: 'memory-1',
      source: 'memory',
      content: `User supplement: ${marker}`
    }],
    summaryMemory: {
      currentState: 'rescheduled', confirmedFacts: [], completed: [], decisions: [],
      openQuestions: [], risks: [], nextSteps: []
    },
    relevantMemories: [{ id: 'memory-1', scope: 'session', content: `User supplement: ${marker}`, confidence: 0.9 }],
    relevantEvents: [],
    artifacts: []
  } as unknown as ContextAssembly;
  const session = {
    id: 'memory-session', workspaceId: 'workspace', tokenUsed: 0, participatingAgentIds: [],
    createdAt: '2026-07-15T00:00:00.000Z', updatedAt: '2026-07-15T00:00:00.000Z'
  } as unknown as SessionDetail;

  const envelope = buildEnvelopeFromContextAssembly({
    session,
    phase: 'task_execution',
    contextAssembly,
    identity: {
      agentId: 'agent', key: 'agent', name: 'Agent', role: 'worker', systemPrompt: 'Work.',
      profileHash: 'hash', profileRevision: 1, skillBindings: [], requestedToolIds: [], requestedToolKeys: [],
      capabilityIds: [], knowledgeBaseIds: []
    },
    toolCatalogHash: 'catalog'
  });

  assert.equal(envelope.L3.files.length, 0);
  assert.equal(envelope.L5.bullets.filter((bullet) => bullet.includes(marker)).length, 1);
});

test('buildEnvelopeFromContextAssembly carries selected upstream artifact summaries in execution L5', () => {
  const marker = 'UPSTREAM_ARCHITECTURE_CONTRACT_20260731';
  const contextAssembly = {
    systemRules: [],
    sessionGoal: 'Implement the frontend from the approved architecture',
    budget: { maxInputTokens: 2_000 },
    selectedEvidenceContents: [{
      type: 'artifact',
      label: 'Architecture execution result',
      ref: 'artifact-architecture',
      source: 'artifact',
      content: `${marker}: Nuxt server API, PostgreSQL schema, and SDK contract.`
    }],
    summaryMemory: {
      currentState: 'frontend acceptance', confirmedFacts: [], completed: [], decisions: [],
      openQuestions: [], risks: [], nextSteps: []
    },
    relevantEvents: [],
    artifacts: [{ artifactId: 'artifact-architecture', type: 'json', title: 'Architecture execution result' }]
  } as unknown as ContextAssembly;
  const session = {
    id: 'artifact-session', workspaceId: 'empty-workspace', tokenUsed: 0, participatingAgentIds: [],
    createdAt: '2026-07-31T00:00:00.000Z', updatedAt: '2026-07-31T00:00:00.000Z'
  } as unknown as SessionDetail;

  const envelope = buildEnvelopeFromContextAssembly({
    session,
    phase: 'task_acceptance',
    contextAssembly,
    identity: {
      agentId: 'frontend', key: 'frontend', name: 'Frontend', role: 'worker', systemPrompt: 'Work.',
      profileHash: 'hash', profileRevision: 1, skillBindings: [], requestedToolIds: [], requestedToolKeys: [],
      capabilityIds: [], knowledgeBaseIds: []
    },
    toolCatalogHash: 'catalog'
  });

  assert.equal(envelope.L3.files.length, 0);
  assert.ok(envelope.L5.bullets.some((bullet) => bullet.includes(marker)));
  assert.deepEqual(envelope.L6.reportIds, []);
});

test('file revision evidence remains navigable without a cached workspace index after restart', () => {
  const contextAssembly = {
    systemRules: ['Use the frozen revision.'],
    sessionGoal: 'Process a user revision',
    budget: { maxInputTokens: 4_000 },
    fileRevisionEvidence: [{
      chainId: 'chain-1', revisionId: 'revision-2', iteration: 2, filePath: 'docs/result.md',
      baseKind: 'previous_candidate',
      base: {
        hash: { algorithm: 'sha256', value: 'a'.repeat(64) }, contentRef: 'content:base',
        content: 'G1', byteLength: 2
      },
      userDraft: {
        hash: { algorithm: 'sha256', value: 'b'.repeat(64) }, contentRef: 'content:draft',
        content: 'U2 user revised content', byteLength: 23
      },
      diff: {
        hash: { algorithm: 'sha256', value: 'c'.repeat(64) }, contentRef: 'content:diff', hunks: [],
        summary: { addedLines: 1, removedLines: 1, unchangedLines: 0, hunkCount: 0 }
      },
      evidenceHash: 'd'.repeat(64), complete: true, truncated: false
    }],
    summaryMemory: {
      currentState: 'processing', confirmedFacts: [], completed: [], decisions: [],
      openQuestions: [], risks: [], nextSteps: []
    },
    relevantEvents: [], artifacts: []
  } as unknown as ContextAssembly;
  const session = {
    id: 'revision-session', workspaceId: 'revision-workspace', tokenUsed: 0,
    participatingAgentIds: ['agent-1'], createdAt: '2026-07-28T00:00:00.000Z',
    updatedAt: '2026-07-28T00:00:00.000Z'
  } as unknown as SessionDetail;

  const envelope = buildEnvelopeFromContextAssembly({
    session,
    phase: 'task_execution',
    contextAssembly,
    identity: {
      agentId: 'agent-1', key: 'backend', name: 'Backend', role: 'worker', systemPrompt: 'Work.',
      profileHash: 'profile', profileRevision: 1, skillBindings: [], requestedToolIds: [],
      requestedToolKeys: [], capabilityIds: [], knowledgeBaseIds: []
    },
    toolCatalogHash: 'catalog'
  });

  assert.equal(envelope.L1.navigation.entries.some((entry) => entry.path === 'docs/result.md'), true);
  assert.equal(envelope.L3.fileRevisions?.[0]?.userDraft.content, 'U2 user revised content');
});

test('buildEnvelopeFromContextAssembly fails closed instead of truncating revision evidence', () => {
  workspaceMetrics.resetForTests();
  const repeated = 'user revised line\n'.repeat(100);
  const contextAssembly = {
    systemRules: ['Use the frozen revision.'],
    sessionGoal: 'Process a user revision',
    budget: { maxInputTokens: 200 },
    fileRevisionEvidence: [{
      chainId: 'chain-1',
      revisionId: 'revision-1',
      iteration: 1,
      filePath: 'result.md',
      baseKind: 'workspace_baseline',
      base: {
        hash: { algorithm: 'sha256', value: 'original-hash' },
        contentRef: 'content:original',
        content: 'original line\n'.repeat(100),
        byteLength: 1400
      },
      userDraft: {
        hash: { algorithm: 'sha256', value: 'revised-hash' },
        contentRef: 'content:revised',
        content: repeated,
        byteLength: Buffer.byteLength(repeated)
      },
      diff: {
        hash: { algorithm: 'sha256', value: 'diff-hash' },
        contentRef: 'content:diff',
        hunks: [{
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          lines: [
            { kind: 'remove', content: 'original line' },
            { kind: 'add', content: 'user revised line' }
          ]
        }],
        summary: { addedLines: 1, removedLines: 1, unchangedLines: 0, hunkCount: 1 }
      },
      agentResults: [{
        id: 'result-1',
        taskId: 'task-1', agentId: 'agent-1', status: 'completed', artifactIds: [], summary: 'proposal',
        proposedContentRef: 'content:proposal', proposedContent: 'agent proposal\n'.repeat(100),
        completedAt: '2026-07-28T00:00:00.000Z'
      }],
      evidenceHash: 'evidence-hash',
      complete: true,
      truncated: false
    }],
    summaryMemory: {
      currentState: 'processing', confirmedFacts: [], completed: [], decisions: [],
      openQuestions: [], risks: [], nextSteps: []
    },
    relevantEvents: [],
    artifacts: []
  } as unknown as ContextAssembly;
  const session = {
    id: 'revision-session', workspaceId: 'revision-workspace', tokenUsed: 0,
    participatingAgentIds: ['agent-1'], createdAt: '2026-07-28T00:00:00.000Z',
    updatedAt: '2026-07-28T00:00:00.000Z'
  } as unknown as SessionDetail;

  assert.throws(() => buildEnvelopeFromContextAssembly({
    session,
    phase: 'task_execution',
    contextAssembly,
    identity: {
      agentId: 'agent-1', key: 'backend', name: 'Backend', role: 'worker', systemPrompt: 'Work.',
      profileHash: 'profile', profileRevision: 1, skillBindings: [], requestedToolIds: [],
      requestedToolKeys: [], capabilityIds: [], knowledgeBaseIds: []
    },
    toolCatalogHash: 'catalog'
  }), /REVISION_MODEL_CAPACITY_INSUFFICIENT/);
  assert.equal(
    workspaceMetrics.snapshot().series.find((item) => item.name === 'file_revision_model_capacity_rejected_total')?.value,
    1
  );
});
