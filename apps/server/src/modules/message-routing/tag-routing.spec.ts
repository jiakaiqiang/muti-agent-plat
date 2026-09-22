import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveTagRouting } from './tag-routing.js';

const main = { id: 'main', key: 'coordinator', name: '主 Agent', role: 'coordinator', tags: [], capabilityIds: [] };
const frontend = { id: 'front', key: 'frontend', name: 'Frontend Agent', role: 'frontend engineer', tags: ['ui'], capabilityIds: ['web'] };
const qa = { id: 'qa', key: 'qa', name: 'QA Agent', role: 'quality engineer', tags: ['test'], capabilityIds: ['testing'] };
const skill = { id: 'skill-1', key: 'frontend', name: 'Frontend implementation', revision: 3 };

test('no skill and no @ falls back to main', () => {
  const result = resolveTagRouting({ candidates: [], mainAgent: main });
  assert.equal(result.mode, 'main');
  assert.equal(result.resolvedAgentId, 'main');
  assert.equal(result.reason, 'no_explicit_routing');
});

test('skill without @ falls back to main', () => {
  const result = resolveTagRouting({ skill, candidates: [], mainAgent: main });
  assert.equal(result.mode, 'main');
  assert.equal(result.reason, 'skill_without_agent_candidate');
});

test('skill plus matching candidate selects one agent', () => {
  const result = resolveTagRouting({ skill, candidates: [qa, frontend], mainAgent: main });
  assert.equal(result.mode, 'single');
  assert.equal(result.resolvedAgentId, 'front');
  assert.deepEqual(result.candidateAgentIds, ['front', 'qa']);
});

test('skill plus mismatched candidate falls back to main', () => {
  const result = resolveTagRouting({ skill, candidates: [qa], mainAgent: main });
  assert.equal(result.mode, 'main');
  assert.equal(result.reason, 'skill_agent_semantic_mismatch');
  assert.equal(result.resolvedAgentId, 'main');
});

test('multiple @ candidates without skill are distributed', () => {
  const result = resolveTagRouting({ candidates: [qa, frontend], mainAgent: main });
  assert.equal(result.mode, 'distributed');
  assert.deepEqual(result.distributionAgentIds, ['front', 'qa']);
});

test('candidate order does not change the resolved route', () => {
  const left = resolveTagRouting({ skill, candidates: [qa, frontend], mainAgent: main });
  const right = resolveTagRouting({ skill, candidates: [frontend, qa], mainAgent: main });
  assert.deepEqual(right, left);
});
