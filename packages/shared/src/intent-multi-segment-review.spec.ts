import assert from 'node:assert/strict';
import test from 'node:test';
import { intentUnderstandingExample } from './runtime-contracts/intent-understanding.js';
import { parseIntentMultiSegmentReview, type IntentMultiSegmentReview } from './intent-multi-segment-review.js';

function review(count = 8): IntentMultiSegmentReview {
  const understanding = structuredClone(intentUnderstandingExample);
  understanding.segments.splice(0, understanding.segments.length, ...Array.from({ length: count }, (_, index) => ({ ...structuredClone(understanding.segments[0]), localKey: `segment-${index}` })));
  return { contractVersion: 'intent-multi-segment-review-v1', mode: 'clarify_only', sessionId: 'session', dataEpoch: 'epoch', routingId: 'route',
    sourceEventId: 'message-1', routingRevision: 2, understanding };
}
test('multi-segment review retains all eight segments and rejects truncation, cycles, invalid identity and execution flags', () => {
  const valid = review(); assert.deepEqual(parseIntentMultiSegmentReview(valid), valid);
  for (const invalid of [review(1), review(9), { ...valid, mode: 'execute' }, { ...valid, safeToApply: true },
    { ...valid, routingRevision: 0 }, { ...valid, dataEpoch: '' }, { ...valid, referenceLabels: [{ id: 'x', label: {} }] }]) {
    assert.equal(parseIntentMultiSegmentReview(invalid), undefined);
  }
  valid.understanding.segments[0].dependencies.push({ segmentKey: 'segment-0', condition: 'execution_completed' });
  assert.equal(parseIntentMultiSegmentReview(valid), undefined);
});
