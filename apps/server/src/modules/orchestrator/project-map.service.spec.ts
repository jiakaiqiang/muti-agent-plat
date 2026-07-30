import assert from 'node:assert/strict';
import test from 'node:test';
import type { SessionDetail } from '@agent-cluster/shared';
import { ProjectMapService } from './project-map.service.js';

test('project map and focus use a metadata index without requiring a legacy Snapshot', () => {
  const revision = { id: 'revision-index', observedAt: '2026-07-28T00:00:00.000Z' };
  const session = {
    id: 'session-index',
    workspaceId: 'workspace-index',
    originalInput: 'Analyze the backend session flow',
    workingDirectory: {
      kind: 'server_local', id: 'workspace-index', name: 'indexed-project', path: 'D:/indexed-project',
      selectedAt: '2026-07-28T00:00:00.000Z'
    },
    workspaceIndex: {
      workspaceId: 'workspace-index', revision, generation: 4, status: 'building', complete: false,
      entries: [
        { path: 'package.json', kind: 'file', size: 100, language: 'json', generated: false, sensitive: false },
        { path: 'apps/server/src/main.ts', kind: 'file', size: 200, language: 'typescript', generated: false, sensitive: false },
        { path: 'apps/server/src/sessions/session.service.ts', kind: 'file', size: 300, language: 'typescript', generated: false, sensitive: false },
        { path: 'apps/server/src/sessions/session.service.spec.ts', kind: 'file', size: 300, language: 'typescript', generated: false, sensitive: false }
      ],
      entrypoints: ['apps/server/src/main.ts'], detectedStack: ['node'], indexedEntries: 4,
      truncated: false, updatedAt: '2026-07-28T00:00:00.000Z'
    }
  } as unknown as SessionDetail;

  const service = new ProjectMapService();
  const focus = service.workspaceFocus(session);
  const map = service.buildProjectMap(session, focus);

  assert.ok(map);
  assert.equal(map.modules.some((module) => module.path === 'apps'), true);
  assert.equal(focus?.possibleEntryPoints.includes('apps/server/src/main.ts'), true);
  assert.equal(focus?.relevantFiles.includes('apps/server/src/sessions/session.service.ts'), true);
  assert.deepEqual(focus?.detectedStack, ['node']);
});
