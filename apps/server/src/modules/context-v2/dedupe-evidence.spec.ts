import assert from 'node:assert/strict';
import test from 'node:test';
import type { ContextL3EvidenceFile } from '@agent-cluster/shared';
import { dedupeEvidence } from './dedupe-evidence.js';

function evidence(path: string, content: string, hashValue?: string): ContextL3EvidenceFile {
  return {
    path,
    content,
    byteLength: Buffer.byteLength(content, 'utf8'),
    ...(hashValue ? { hash: { algorithm: 'sha256', value: hashValue } } : {})
  };
}

test('dedupeEvidence removes duplicates keyed by path', () => {
  const files = [
    evidence('src/a.ts', 'v1'),
    evidence('src/a.ts', 'v2'),
    evidence('src/b.ts', 'other')
  ];
  const result = dedupeEvidence(files);
  const paths = result.map((f) => f.path);
  assert.deepEqual(paths, ['src/a.ts', 'src/b.ts']);
});

test('dedupeEvidence collapses artifacts sharing the same hash', () => {
  const files = [
    evidence('src/a.ts', 'x', 'hash-1'),
    evidence('src/copy-of-a.ts', 'x', 'hash-1'),
    evidence('src/b.ts', 'y', 'hash-2')
  ];
  const result = dedupeEvidence(files);
  assert.equal(result.length, 2);
  assert.equal(result.find((f) => f.path === 'src/b.ts')?.byteLength, 1);
});

test('dedupeEvidence preserves entries without hash and different paths', () => {
  const files = [
    evidence('src/a.ts', 'x'),
    evidence('src/b.ts', 'y')
  ];
  const result = dedupeEvidence(files);
  assert.equal(result.length, 2);
});

test('dedupeEvidence keeps the first occurrence order when duplicates appear later', () => {
  const files = [
    evidence('a.ts', 'x', 'h1'),
    evidence('b.ts', 'y', 'h2'),
    evidence('a.ts', 'x-again')
  ];
  const result = dedupeEvidence(files);
  assert.deepEqual(result.map((f) => f.path), ['a.ts', 'b.ts']);
});
