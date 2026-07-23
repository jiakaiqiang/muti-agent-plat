import assert from 'node:assert/strict';
import test from 'node:test';
import type { ContextAssembly, SessionDetail } from '@agent-cluster/shared';
import { buildEnvelopeFromContextAssembly } from './build-envelope-from-context-assembly.js';

test('buildEnvelopeFromContextAssembly creates the authoritative grounded v2 layers', () => {
  const contextAssembly = {
    systemRules: ['Stay grounded.'],
    sessionGoal: 'Inspect the repository',
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
  assert.equal(envelope.L3.files[0]?.path, 'src/main.ts');
  assert.equal(envelope.L3.totalByteLength > 0, true);
  assert.equal(envelope.budget.navigationTokens, 1500);
  assert.equal(envelope.budget.evidenceTokens, 4000);
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
