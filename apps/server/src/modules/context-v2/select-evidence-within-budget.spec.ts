import assert from 'node:assert/strict';
import test from 'node:test';
import type { ContextL3EvidenceFile } from '@agent-cluster/shared';
import { selectEvidenceWithinBudget } from './select-evidence-within-budget.js';
import type { ScoredEvidenceCandidate } from './score-evidence-candidates.js';

function file(path: string, size: number): ContextL3EvidenceFile {
  return {
    path,
    content: 'x'.repeat(size),
    byteLength: size
  };
}

function candidate(path: string, score: number): ScoredEvidenceCandidate {
  return { path, score, reasons: [] };
}

test('selectEvidenceWithinBudget keeps highest-score files that fit', () => {
  const candidates = [candidate('a', 100), candidate('b', 80), candidate('c', 60)];
  const contents = new Map([
    ['a', file('a', 400)],
    ['b', file('b', 300)],
    ['c', file('c', 200)]
  ]);
  const result = selectEvidenceWithinBudget({ candidates, contents, budgetBytes: 800 });
  assert.deepEqual(result.files.map((f) => f.path), ['a', 'b']);
  assert.equal(result.totalByteLength, 700);
  assert.equal(result.truncated, true);
});

test('selectEvidenceWithinBudget skips files that overflow but continues with smaller ones', () => {
  const candidates = [candidate('big', 100), candidate('small', 90)];
  const contents = new Map([
    ['big', file('big', 5000)],
    ['small', file('small', 200)]
  ]);
  const result = selectEvidenceWithinBudget({ candidates, contents, budgetBytes: 1000 });
  assert.deepEqual(result.files.map((f) => f.path), ['small']);
  assert.equal(result.totalByteLength, 200);
  assert.equal(result.truncated, true);
});

test('selectEvidenceWithinBudget reports truncated=false when all candidates fit', () => {
  const candidates = [candidate('a', 100), candidate('b', 90)];
  const contents = new Map([
    ['a', file('a', 100)],
    ['b', file('b', 100)]
  ]);
  const result = selectEvidenceWithinBudget({ candidates, contents, budgetBytes: 1000 });
  assert.equal(result.files.length, 2);
  assert.equal(result.truncated, false);
});

test('selectEvidenceWithinBudget honors score order when equal-size files compete', () => {
  const candidates = [candidate('low', 10), candidate('high', 100)];
  const contents = new Map([
    ['low', file('low', 100)],
    ['high', file('high', 100)]
  ]);
  const result = selectEvidenceWithinBudget({ candidates, contents, budgetBytes: 100 });
  assert.deepEqual(result.files.map((f) => f.path), ['high']);
});
