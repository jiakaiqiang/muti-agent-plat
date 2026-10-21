import assert from 'node:assert/strict';
import test from 'node:test';
import { getVersionedRuntimeOutputContract, intentUnderstandingExample, validateRuntimeOutput } from './runtime-contracts/index.js';

test('intent understanding has its own strict 1.0 contract and leaves task submission 2.0 intact', () => {
  assert.equal(validateRuntimeOutput('intent_understanding', intentUnderstandingExample).valid, true);
  assert.equal(getVersionedRuntimeOutputContract('intent_understanding', '1.0').kind, 'intent_understanding');
  assert.equal(getVersionedRuntimeOutputContract('task_execution_result', '2.0').version, '2.0');
  assert.throws(() => getVersionedRuntimeOutputContract('intent_understanding', '2.0'), /NOT_FOUND/);
  for (const value of [
    { ...intentUnderstandingExample, safeToApply: true },
    { ...intentUnderstandingExample, segments: [] },
    { ...intentUnderstandingExample, segments: Array.from({ length: 9 }, (_, index) => ({ ...intentUnderstandingExample.segments[0], localKey: `s${index}` })) },
    { ...intentUnderstandingExample, segments: [{ ...intentUnderstandingExample.segments[0], goal: 'x'.repeat(4001) }] },
    { ...intentUnderstandingExample, segments: [{ ...intentUnderstandingExample.segments[0], suggestedAction: 'continue_active_work_item' }] }
  ]) assert.equal(validateRuntimeOutput('intent_understanding', value).valid, false);
});

test('all segments are retained and invalid dependency or evidence graphs are rejected', () => {
  const value = structuredClone(intentUnderstandingExample);
  value.segments.push({ ...structuredClone(value.segments[0]), localKey: 'second',
    dependencies: [{ segmentKey: 'question', condition: 'execution_completed' }] });
  const valid = validateRuntimeOutput('intent_understanding', value);
  assert.equal(valid.valid, true);
  if (valid.valid) assert.equal(valid.value.segments.length, 2);
  value.segments[0].dependencies.push({ segmentKey: 'second', condition: 'route_committed' });
  const assertError = (code: string) => {
    const result = validateRuntimeOutput('intent_understanding', value);
    assert.ok(!result.valid);
    assert.ok(result.errors.includes(code));
  };
  assertError('SEGMENT_DEPENDENCY_CYCLE');
  value.segments[0].dependencies.splice(0, 1, { segmentKey: 'missing', condition: 'route_committed' });
  assertError('SEGMENT_DEPENDENCY_UNKNOWN');
  value.segments[0].requestedEffects[0].evidenceRefs.splice(0, 1, 'invented');
  assertError('EFFECT_EVIDENCE_MISSING');
});
