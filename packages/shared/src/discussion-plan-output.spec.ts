import assert from 'node:assert/strict';
import test from 'node:test';
import { RUNTIME_OUTPUT_KINDS } from './runtime-contracts/contract-types.js';
import { getRuntimeOutputContract } from './runtime-contracts/registry.js';
import { runtimeOutputExamples } from './runtime-contracts/output-contracts.js';

test('discussion_plan is a registered runtime output kind', () => {
  assert.ok((RUNTIME_OUTPUT_KINDS as readonly string[]).includes('discussion_plan'));
  const contract = getRuntimeOutputContract('discussion_plan' as never);
  assert.equal(contract.kind, 'discussion_plan');
});

test('a plan names its gaps, the experts it needs and how the round ends', () => {
  const contract = getRuntimeOutputContract('discussion_plan' as never);
  const plan = {
    schemaVersion: '1.0',
    kind: 'discussion_plan',
    objective: '决定存储方案。',
    gaps: ['迁移成本未知'],
    exitCondition: '每个未决问题都有负责人或用户决定。',
    consultations: [
      { targetAgentKey: 'architect', objective: '评估关系型与文档型存储的迁移成本。', expectedResult: '风险与建议。' }
    ],
    questionsForUser: [],
    readyToSummarize: false
  };
  assert.equal(contract.validate(plan).valid, true);
});

test('the registered example validates and is a plan that asks at least one expert', () => {
  const example = runtimeOutputExamples['discussion_plan' as keyof typeof runtimeOutputExamples] as {
    consultations: unknown[];
  };
  assert.ok(Array.isArray(example.consultations) && example.consultations.length >= 1);
});

test('a consultation without an objective is rejected — the model must say what it wants', () => {
  const contract = getRuntimeOutputContract('discussion_plan' as never);
  const result = contract.validate({
    schemaVersion: '1.0',
    kind: 'discussion_plan',
    objective: 'x',
    gaps: [],
    exitCondition: 'y',
    consultations: [{ targetAgentKey: 'architect', objective: '', expectedResult: 'z' }],
    questionsForUser: [],
    readyToSummarize: false
  });
  assert.equal(result.valid, false);
});

test('the model cannot smuggle a member addition or a decision through extra fields', () => {
  const contract = getRuntimeOutputContract('discussion_plan' as never);
  const result = contract.validate({
    schemaVersion: '1.0',
    kind: 'discussion_plan',
    objective: 'x',
    gaps: [],
    exitCondition: 'y',
    consultations: [],
    questionsForUser: [],
    readyToSummarize: true,
    addMembers: ['someone-new'],
    approvedByUser: true
  });
  assert.equal(result.valid, false, 'extra properties are refused; membership and approval are not the model\'s to declare');
});
