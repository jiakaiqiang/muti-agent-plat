import assert from 'node:assert/strict';
import test from 'node:test';
import { INTENT_ROUTING_GOLDEN_DATASET_V1 } from './intent-routing-golden.dataset.js';

test('intent routing golden dataset covers lifecycle, ambiguity, failure and safety classes', () => {
  const ids = INTENT_ROUTING_GOLDEN_DATASET_V1.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(INTENT_ROUTING_GOLDEN_DATASET_V1.length >= 15);
  const tags = new Set(INTENT_ROUTING_GOLDEN_DATASET_V1.flatMap((item) => item.tags));
  for (const required of [
    'exact_command', 'recovery', 'related', 'independent', 'ambiguous', 'multi_intent',
    'invalid_reference', 'stale_snapshot', 'runtime_failure', 'fail_closed', 'high_risk',
    'prompt_injection', 'cross_language', 'similar_candidates', 'replan'
  ]) {
    assert.ok(tags.has(required), `missing golden dataset coverage: ${required}`);
  }
  for (const item of INTENT_ROUTING_GOLDEN_DATASET_V1) {
    assert.ok(item.message.trim(), `${item.id} must have a message`);
    if (item.expected.relation === 'ambiguous') assert.equal(item.expected.autoApply, false);
    if (item.expected.contextPolicy === 'clean_task_context') {
      assert.equal(item.expected.action, 'create_independent_work_item');
    }
  }
});
