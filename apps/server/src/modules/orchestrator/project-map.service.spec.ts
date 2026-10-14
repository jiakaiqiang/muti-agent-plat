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

test('GitHub multi-project scope asks only when the task does not identify a project', () => {
  const revision = { id: 'revision-index', observedAt: '2026-09-28T00:00:00.000Z' };
  const base = {
    codeSource: { kind: 'remote_repository', provider: 'github', repositoryUrl: 'https://github.com/example/repo' },
    workspaceIndex: {
      workspaceId: 'workspace-index', revision, generation: 1, status: 'ready', complete: true,
      entries: [
        { path: 'apps/web/package.json', kind: 'file', size: 100, generated: false, sensitive: false },
        { path: 'apps/server/package.json', kind: 'file', size: 100, generated: false, sensitive: false }
      ],
      entrypoints: [], detectedStack: ['node'], indexedEntries: 2, truncated: false,
      updatedAt: '2026-09-28T00:00:00.000Z'
    }
  } as unknown as SessionDetail;
  const service = new ProjectMapService();
  assert.match(service.githubProjectScopeQuestion({ ...base, originalInput: '修复登录问题' }) ?? '',
    /apps\/server.*apps\/web.*哪个项目/);
  assert.equal(service.githubProjectScopeQuestion({ ...base, originalInput: '修复 apps/web 的登录问题' }), undefined);
  assert.equal(service.githubProjectScopeQuestion({ ...base, originalInput: '修复 web 的登录问题' }), undefined);
  assert.equal(service.githubProjectScopeQuestion({ ...base, codeSource: { kind: 'local_directory' },
    originalInput: '修复登录问题' }), undefined);
  assert.equal(service.githubProjectScopeQuestion({ ...base, originalInput: '修复登录问题',
    workspaceIndex: { ...base.workspaceIndex!, complete: false } }), undefined);
});
