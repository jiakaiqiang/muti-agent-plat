import assert from 'node:assert/strict';
import test from 'node:test';
import type { ContextEnvelopeV2 } from '@agent-cluster/shared';
import { slimContextForClaude } from './slim-context-for-claude.js';

function envelope(): ContextEnvelopeV2 {
  const revision = { id: 'rev-88', observedAt: '2026-07-11T00:00:00.000Z' };
  return {
    version: 'v2',
    createdAt: '2026-07-11T00:00:00.000Z',
    workspaceId: 'ws-88',
    sessionId: '00000000-0000-4000-8000-000000000088',
    L0: { workspaceId: 'ws-88', rootName: 'demo', providerKind: 'server_local', revision },
    L1: {
      entries: [
        { path: 'src/index.ts', kind: 'file', generated: false, sensitive: false, size: 100, language: 'typescript' }
      ],
      truncated: false
    },
    L2: {
      source: 'generated',
      modules: [{ name: 'src', path: 'src', responsibility: 'source', entrypoints: ['src/index.ts'] }]
    },
    L3: {
      files: [{ path: 'src/index.ts', content: 'secret content', byteLength: 14 }],
      totalByteLength: 14,
      truncated: false
    },
    L4: { calls: [] },
    L5: { bullets: [], turnCount: 0 },
    L6: { changeSetIds: [], reportIds: [] },
    budget: { inputTokens: 8000, navigationTokens: 800, projectMapTokens: 500, evidenceTokens: 3600 }
  };
}

test('slimContextForClaude aligns fields with ContextEnvelopeV2 layers', () => {
  const slim = slimContextForClaude(envelope(), ['no destructive commands']);
  assert.equal(slim.version, 'v2');
  assert.equal(slim.identity.providerKind, 'server_local');
  assert.deepEqual(slim.navigation, [
    { path: 'src/index.ts', kind: 'file', language: 'typescript' }
  ]);
  assert.deepEqual(slim.projectMap.modules[0].entrypoints, ['src/index.ts']);
  assert.deepEqual(slim.evidenceSummary, {
    fileCount: 1,
    totalByteLength: 14,
    truncated: false,
    paths: ['src/index.ts']
  });
  assert.deepEqual(slim.rulesSummary, ['no destructive commands']);
});

test('slimContextForClaude does not leak Evidence content bodies', () => {
  const slim = slimContextForClaude(envelope());
  const serialized = JSON.stringify(slim);
  assert.equal(serialized.includes('secret content'), false);
});
