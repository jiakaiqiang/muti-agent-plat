import assert from 'node:assert/strict';
import test from 'node:test';
import type { ContextEnvelopeV2 } from '@agent-cluster/shared';
import { slimContextForCodex } from './slim-context-for-codex.js';

function envelope(): ContextEnvelopeV2 {
  const revision = { id: 'rev-87', observedAt: '2026-07-11T00:00:00.000Z' };
  return {
    version: 'v2',
    createdAt: '2026-07-11T00:00:00.000Z',
    workspaceId: 'ws-87',
    sessionId: '00000000-0000-4000-8000-000000000087',
    L0: { workspaceId: 'ws-87', rootName: 'demo', providerKind: 'server_local', revision },
    L1: {
      entries: [
        { path: 'src', kind: 'directory', generated: false, sensitive: false },
        { path: 'src/index.ts', kind: 'file', generated: false, sensitive: false, size: 100 }
      ],
      truncated: false
    },
    L2: {
      source: 'generated',
      modules: [{ name: 'src', path: 'src', responsibility: 'source' }]
    },
    L3: {
      files: [{ path: 'src/index.ts', content: 'const secret = 1;\nconst massiveSnapshot = "...".repeat(500);', byteLength: 5000 }],
      totalByteLength: 5000,
      truncated: false
    },
    L4: { calls: [] },
    L5: { bullets: [], turnCount: 0 },
    L6: { changeSetIds: [], reportIds: [] },
    budget: { inputTokens: 8000, navigationTokens: 800, projectMapTokens: 500, evidenceTokens: 3600 }
  };
}

test('slimContextForCodex retains identity, navigation and rules but drops L3 evidence', () => {
  const slim = slimContextForCodex(envelope(), ['use TDD', 'no globals']);
  assert.equal(slim.workspaceId, 'ws-87');
  assert.equal(slim.identity.providerKind, 'server_local');
  assert.deepEqual(slim.navigation.map((entry) => entry.path), ['src', 'src/index.ts']);
  assert.equal(slim.navigationTruncated, false);
  assert.deepEqual(slim.rulesSummary, ['use TDD', 'no globals']);
});

test('slimContextForCodex never leaks Evidence content or ProjectMap module bodies', () => {
  const slim = slimContextForCodex(envelope());
  const serialized = JSON.stringify(slim);
  assert.equal(serialized.includes('const secret = 1;'), false);
  assert.equal(serialized.includes('massiveSnapshot'), false);
});

test('slimContextForCodex propagates navigationTruncated from L1', () => {
  const env = envelope();
  env.L1.truncated = true;
  const slim = slimContextForCodex(env);
  assert.equal(slim.navigationTruncated, true);
});
