import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeRuntimeContextRequest } from './runtime-context-request-normalizer.js';

test('normalizes string requestedRefs into requestedPaths', () => {
  const result = normalizeRuntimeContextRequest({
    reason: 'Need source files',
    requestedRefs: ['src/main.ts', 'package.json'],
    requestedPaths: ['src/main.ts']
  });
  assert.deepEqual(result, {
    reason: 'Need source files',
    requestedRefs: [],
    requestedPaths: ['src/main.ts', 'package.json']
  });
});

test('keeps valid structured refs and removes duplicates', () => {
  const result = normalizeRuntimeContextRequest({
    reason: 'Need evidence',
    requestedRefs: [
      { type: 'workspace_file', label: 'main', ref: 'src/main.ts' },
      { type: 'workspace_file', label: 'different label', ref: 'src/main.ts' }
    ],
    requestedCommands: ['npm test', 'npm test']
  });
  assert.equal(result?.requestedRefs.length, 1);
  assert.deepEqual(result?.requestedCommands, ['npm test']);
});

test('rejects malformed requestedContext instead of blind-casting it', () => {
  assert.equal(normalizeRuntimeContextRequest({ requestedRefs: [] }), undefined);
  assert.equal(
    normalizeRuntimeContextRequest({
      reason: 'bad ref',
      requestedRefs: [{ type: 'not-a-source', label: 'x' }]
    }),
    undefined
  );
  assert.equal(
    normalizeRuntimeContextRequest({ reason: 'bad paths', requestedRefs: [], requestedPaths: [42] }),
    undefined
  );
});

test('requires concrete refs for workspace-backed evidence and promotes them to paths', () => {
  assert.equal(
    normalizeRuntimeContextRequest({
      reason: 'Need source',
      requestedRefs: [{ type: 'workspace_file', label: 'src/main.ts' }]
    }),
    undefined
  );
  assert.deepEqual(
    normalizeRuntimeContextRequest({
      reason: 'Need symbol source',
      requestedRefs: [{ type: 'workspace_symbol', label: 'main', ref: 'src/main.ts' }]
    })?.requestedPaths,
    ['src/main.ts']
  );
});

test('normalizes bounded directory and search requests', () => {
  const result = normalizeRuntimeContextRequest({
    reason: 'Need module boundaries and symbol usage',
    requestedRefs: [],
    requestedDirectories: [{ path: 'src', depth: 2 }],
    requestedSearches: [{ query: 'createSession', path: 'apps', include: ['**/*.ts'] }]
  });
  assert.deepEqual(result?.requestedDirectories, [{ path: 'src', depth: 2 }]);
  assert.deepEqual(result?.requestedSearches, [{ query: 'createSession', path: 'apps', include: ['**/*.ts'] }]);
});
