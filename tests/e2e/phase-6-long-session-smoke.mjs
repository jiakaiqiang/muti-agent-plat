import assert from 'node:assert/strict';
import { buildLongSessionFixture, evaluateLongSession, LONG_SESSION_MESSAGE_COUNT, LONG_SESSION_WORK_ITEM_COUNT } from '../../scripts/phase-6-long-session-fixture.mjs';

const fixture = buildLongSessionFixture();
const result = evaluateLongSession(fixture);

assert.equal(result.workItemCount, LONG_SESSION_WORK_ITEM_COUNT);
assert.equal(result.messageCount, LONG_SESSION_MESSAGE_COUNT);
assert.equal(result.withinGrowthLimit, true, `controlled context grew too much: ${JSON.stringify(result)}`);
assert.equal(result.recall.earlyReference, true);
assert.equal(result.ambiguity.sameNameRequiresClarification, true);
assert.equal(result.constraints.supersededConstraintExcluded, true);
assert.equal(result.longToolOutputPreservedInFixture, true);
assert.equal(result.modelQuality, 'not measured: deterministic fixture evaluator only');

console.log(`phase 6 long-session smoke passed: ${result.workItemCount} WorkItems, ${result.messageCount} messages, token growth ${(result.growthRatio * 100).toFixed(1)}%, model quality=not measured`);
