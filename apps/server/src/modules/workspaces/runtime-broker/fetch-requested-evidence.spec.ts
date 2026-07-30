import assert from 'node:assert/strict';
import test from 'node:test';
import type { ReadFileResult } from '@agent-cluster/shared';
import { fetchRequestedEvidence, type EvidenceFetchProvider } from './fetch-requested-evidence.js';
import { selectEvidenceWithinBudget } from '../../context-v2/select-evidence-within-budget.js';
import { prioritizeRequestedEvidence } from '../../context-v2/prioritize-requested-evidence.js';

function makeReadFileResult(path: string, content: string): ReadFileResult {
  return {
    path,
    content,
    encoding: 'utf-8',
    byteLength: Buffer.byteLength(content, 'utf8'),
    truncated: false,
    revision: { id: 'rev-105', observedAt: '2026-07-11T00:00:00.000Z' },
    hash: { algorithm: 'sha256', value: 'a'.repeat(64) }
  };
}

test('fetchRequestedEvidence collects file bodies through the provider', async () => {
  const provider: EvidenceFetchProvider = {
    readFile: async ({ path }) => makeReadFileResult(path, `content of ${path}`)
  };
  const result = await fetchRequestedEvidence({
    provider,
    requestedPaths: ['src/a.ts', 'src/b.ts']
  });
  assert.equal(result.files.length, 2);
  assert.equal(result.files[0].path, 'src/a.ts');
  assert.equal(result.files[0].content, 'content of src/a.ts');
  assert.equal(result.errors.length, 0);
});

test('fetchRequestedEvidence captures errors per path without aborting the batch', async () => {
  const provider: EvidenceFetchProvider = {
    readFile: async ({ path }) => {
      if (path === 'broken.ts') throw new Error('BROKEN');
      return makeReadFileResult(path, `body of ${path}`);
    }
  };
  const result = await fetchRequestedEvidence({
    provider,
    requestedPaths: ['ok.ts', 'broken.ts', 'still-ok.ts']
  });
  assert.equal(result.files.length, 2);
  assert.deepEqual(result.errors, [{ path: 'broken.ts', message: 'BROKEN' }]);
});

test('fetched evidence lands in Selected Evidence when combined with prioritized candidates', async () => {
  const provider: EvidenceFetchProvider = {
    readFile: async ({ path }) => makeReadFileResult(path, `text-${path}`)
  };
  const fetched = await fetchRequestedEvidence({
    provider,
    requestedPaths: ['requested.ts']
  });
  const prioritized = prioritizeRequestedEvidence([], ['requested.ts']);
  const contents = new Map(fetched.files.map((file) => [file.path, file]));
  const selected = selectEvidenceWithinBudget({
    candidates: prioritized,
    contents,
    budgetBytes: 4_000
  });
  assert.deepEqual(
    selected.files.map((file) => file.path),
    ['requested.ts']
  );
});
