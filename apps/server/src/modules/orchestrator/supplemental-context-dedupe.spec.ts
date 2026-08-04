import test from 'node:test';
import assert from 'node:assert/strict';
import type { RuntimeContextRequest, SessionDetail, TaskEvidenceRef } from '@agent-cluster/shared';
import {
  collectSeenContextSignatures,
  diffRequestedContext,
  refSignature,
  trimToNovelContext
} from './supplemental-context-dedupe.js';

function ref(type: TaskEvidenceRef['type'], label: string, refValue?: string): TaskEvidenceRef {
  return { type, label, ref: refValue };
}

function record(
  refs: TaskEvidenceRef[],
  paths: string[] = [],
  commands: string[] = [],
  hydratedPaths?: string[]
): NonNullable<SessionDetail['supplementalContextRequests']>[number] {
  const workspaceRefPaths = refs
    .filter((item) => ['workspace_file', 'workspace_symbol', 'test'].includes(item.type))
    .map((item) => item.ref)
    .filter((item): item is string => Boolean(item));
  const requestedPaths = [...new Set([...paths, ...workspaceRefPaths])];
  const resolvedPaths = hydratedPaths ?? requestedPaths;
  return {
    id: 'rec-' + Math.random().toString(36).slice(2, 10),
    taskId: 'task-1',
    agentId: 'agent-1',
    createdAt: '2026-06-30T00:00:00.000Z',
    requestedContext: {
      reason: 'unit-test',
      requestedRefs: refs,
      requestedPaths: requestedPaths.length ? requestedPaths : undefined,
      requestedCommands: commands.length ? commands : undefined
    },
    resolution: {
      requestedFiles: requestedPaths.map((path) => ({ path })),
      hydratedPaths: resolvedPaths,
      failedPaths: requestedPaths
        .filter((path) => !resolvedPaths.includes(path))
        .map((path) => ({ path, code: 'READ_ERROR' as const, retryable: true })),
      deferredPaths: [],
      contentBytes: 1,
      outcome: resolvedPaths.length === requestedPaths.length ? 'resolved' : 'partial',
      attempt: 1,
      maxAttempts: 1
    }
  };
}

test('refSignature keeps ref+kind stable across labels', () => {
  assert.equal(
    refSignature(ref('workspace_file', 'src/main.ts', 'src/main.ts')),
    refSignature(ref('workspace_file', 'a totally different label', 'src/main.ts'))
  );
  assert.notEqual(
    refSignature(ref('workspace_file', 'src/main.ts', 'src/main.ts')),
    refSignature(ref('workspace_symbol', 'src/main.ts', 'src/main.ts'))
  );
});

test('collectSeenContextSignatures only dedupes successfully hydrated paths', () => {
  const seen = collectSeenContextSignatures([
    record([], ['src/a.ts', 'src/b.ts'], [], ['src/a.ts'])
  ]);
  assert.ok(seen.paths.has('src/a.ts'));
  assert.equal(seen.paths.has('src/b.ts'), false);
});

test('collectSeenContextSignatures aggregates hydrated refs and paths but not unexecuted commands', () => {
  const seen = collectSeenContextSignatures([
    record([ref('workspace_file', 'a.ts', 'src/a.ts')], ['docs/a.md'], ['npm test']),
    record([ref('workspace_symbol', 'foo', 'src/a.ts#foo')], ['docs/b.md'])
  ]);
  assert.equal(seen.refs.size, 2);
  assert.equal(seen.paths.size, 4);
  assert.equal(seen.commands.size, 0);
  assert.ok(seen.paths.has('docs/a.md'));
});

test('collectSeenContextSignatures handles undefined prior history', () => {
  const seen = collectSeenContextSignatures(undefined);
  assert.equal(seen.refs.size, 0);
  assert.equal(seen.paths.size, 0);
  assert.equal(seen.commands.size, 0);
});

test('collectSeenContextSignatures does not suppress an unresolved semantic ref retry', () => {
  const prior = record([ref('artifact', 'Architecture design')]);
  prior.resolution.resolvedRefs = [];
  prior.resolution.failedRefs = [{
    type: 'artifact',
    label: 'Architecture design',
    code: 'INVALID_REFERENCE',
    retryable: true
  }];
  prior.resolution.outcome = 'exhausted';

  const seen = collectSeenContextSignatures([prior]);
  assert.equal(seen.refs.has(refSignature(ref('artifact', 'Architecture design'))), false);
});

test('dedupe applies only to evidence captured at the current workspace revision', () => {
  const prior = record([], ['src/a.ts']);
  prior.resolution.evidenceRevisions = {
    'src/a.ts': { id: 'revision-1', observedAt: '2026-07-28T00:00:00.000Z' }
  };

  assert.equal(collectSeenContextSignatures([prior], 'revision-1').paths.has('src/a.ts'), true);
  assert.equal(collectSeenContextSignatures([prior], 'revision-2').paths.has('src/a.ts'), false);
});

test('diffRequestedContext flags all-duplicate candidate as hasNovelEntries=false', () => {
  const seen = collectSeenContextSignatures([
    record([ref('workspace_file', 'a.ts', 'src/a.ts')], ['docs/a.md'])
  ]);
  const candidate: RuntimeContextRequest = {
    reason: 'duplicate request',
    requestedRefs: [ref('workspace_file', 'a.ts', 'src/a.ts')],
    requestedPaths: ['docs/a.md']
  };
  const diff = diffRequestedContext(candidate, seen);
  assert.equal(diff.hasNovelEntries, false);
  assert.equal(diff.novelRefs.length, 0);
  assert.equal(diff.novelPaths.length, 0);
});

test('diffRequestedContext keeps only the novel subset', () => {
  const seen = collectSeenContextSignatures([
    record([ref('workspace_file', 'a.ts', 'src/a.ts')], ['docs/a.md'], ['npm test'])
  ]);
  const candidate: RuntimeContextRequest = {
    reason: 'need more',
    requestedRefs: [
      ref('workspace_file', 'a.ts', 'src/a.ts'), // dup
      ref('workspace_file', 'b.ts', 'src/b.ts') // new
    ],
    requestedPaths: ['docs/a.md', 'docs/b.md'],
    requestedCommands: ['npm test', 'npm run typecheck']
  };
  const diff = diffRequestedContext(candidate, seen);
  assert.equal(diff.hasNovelEntries, true);
  assert.deepEqual(
    diff.novelRefs.map((r) => r.ref),
    ['src/b.ts']
  );
  assert.deepEqual(diff.novelPaths, ['docs/b.md']);
  assert.deepEqual(diff.novelCommands, ['npm test', 'npm run typecheck']);
});

test('trimToNovelContext returns undefined when nothing new', () => {
  const seen = collectSeenContextSignatures([
    record([ref('workspace_file', 'a.ts', 'src/a.ts')])
  ]);
  const candidate: RuntimeContextRequest = {
    reason: 'duplicate',
    requestedRefs: [ref('workspace_file', 'a.ts', 'src/a.ts')]
  };
  assert.equal(trimToNovelContext(candidate, seen), undefined);
});

test('trimToNovelContext returns a candidate trimmed to net-new entries', () => {
  const seen = collectSeenContextSignatures([
    record([ref('workspace_file', 'a.ts', 'src/a.ts')], ['docs/a.md'], ['npm test'])
  ]);
  const candidate: RuntimeContextRequest = {
    reason: 'partial overlap',
    requestedRefs: [
      ref('workspace_file', 'a.ts', 'src/a.ts'),
      ref('workspace_file', 'b.ts', 'src/b.ts')
    ],
    requestedPaths: ['docs/a.md', 'docs/b.md'],
    requestedCommands: ['npm test'],
    followUpInstruction: 'pretty please'
  };
  const trimmed = trimToNovelContext(candidate, seen);
  assert.ok(trimmed);
  assert.equal(trimmed.reason, 'partial overlap');
  assert.equal(trimmed.followUpInstruction, 'pretty please');
  assert.deepEqual(trimmed.requestedRefs.map((r) => r.ref), ['src/b.ts']);
  assert.deepEqual(trimmed.requestedFiles, [{ path: 'docs/b.md' }]);
  assert.equal(trimmed.requestedPaths, undefined);
  assert.deepEqual(trimmed.requestedCommands, ['npm test'], 'unexecuted commands remain novel');
});
