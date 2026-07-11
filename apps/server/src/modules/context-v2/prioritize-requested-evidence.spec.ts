import assert from 'node:assert/strict';
import test from 'node:test';
import type { ContextL3EvidenceFile } from '@agent-cluster/shared';
import { prioritizeRequestedEvidence } from './prioritize-requested-evidence.js';
import { selectEvidenceWithinBudget } from './select-evidence-within-budget.js';
import type { ScoredEvidenceCandidate } from './score-evidence-candidates.js';

function candidate(path: string, score: number, reasons: string[] = []): ScoredEvidenceCandidate {
  return { path, score, reasons };
}

function file(path: string, size: number): ContextL3EvidenceFile {
  return { path, content: 'x'.repeat(size), byteLength: size };
}

test('prioritizeRequestedEvidence boosts requested paths above all scored candidates', () => {
  const candidates = [candidate('a', 500), candidate('b', 400)];
  const result = prioritizeRequestedEvidence(candidates, ['b']);
  assert.equal(result[0].path, 'b');
  assert.ok(result[0].reasons.includes('user-requested'));
});

test('prioritizeRequestedEvidence injects new candidates for paths not already scored', () => {
  const candidates = [candidate('a', 500)];
  const result = prioritizeRequestedEvidence(candidates, ['b']);
  const injected = result.find((r) => r.path === 'b');
  assert.ok(injected);
  assert.equal(injected!.reasons.length, 1);
});

test('requested paths always land in Selected Evidence via budget selector', () => {
  const scored = [candidate('big', 1000), candidate('small', 500)];
  const prioritized = prioritizeRequestedEvidence(scored, ['supplemental']);
  const contents = new Map([
    ['big', file('big', 400)],
    ['small', file('small', 200)],
    ['supplemental', file('supplemental', 100)]
  ]);
  const result = selectEvidenceWithinBudget({
    candidates: prioritized,
    contents,
    budgetBytes: 500
  });
  const paths = result.files.map((f) => f.path);
  assert.ok(paths.includes('supplemental'));
});
