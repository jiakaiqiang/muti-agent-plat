import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..', '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');

const requirements = 'docs/product/workflow-view-agent-chain-requirements-v1.md';
const design = 'docs/design/workflow-view-agent-chain-system-design-v1.md';
const development = 'docs/implementation/workflow-view-agent-chain-development-v1.md';

test('requirements carry the confirmed harness frontmatter', () => {
  const source = read(requirements);
  assert.match(source, /artifact: intent_contract/);
  assert.match(source, /stage: requirement/);
  assert.match(source, /status: confirmed/);
});

test('requirements record the confirmed three-state colour semantics', () => {
  const source = read(requirements);
  assert.match(source, /灰[^\n]*未执行/);
  assert.match(source, /橙[^\n]*当前/);
  assert.match(source, /绿[^\n]*已执行/);
});

test('requirements keep the chat surface out of scope', () => {
  const source = read(requirements);
  assert.match(source, /## 非目标/);
  assert.match(source, /ChatTimeline/);
  assert.match(source, /AgentStatusPanel/);
  assert.match(source, /群聊/);
});

test('requirements state every acceptance criterion as machine checkable', () => {
  const source = read(requirements);
  assert.match(source, /## 验收标准/);
  for (const index of ['AC1', 'AC2', 'AC3', 'AC4', 'AC5', 'AC6', 'AC7', 'AC8', 'AC9', 'AC10', 'AC11']) {
    assert.match(source, new RegExp(index), `missing acceptance criterion ${index}`);
  }
});

test('design carries harness frontmatter and traces the requirement', () => {
  const source = read(design);
  assert.match(source, /artifact: design_plan/);
  assert.match(source, /stage: design/);
  assert.match(source, /status: ready/);
  assert.match(source, /workflow-view-agent-chain-requirements-v1/);
});

test('design fills all seven Architecture Constraints', () => {
  const source = read(design);
  for (const key of [
    'module_boundaries',
    'ownership_boundaries',
    'dependency_direction',
    'contract_stability',
    'allowed_change_scope',
    'forbidden_change_scope',
    'invariants'
  ]) {
    assert.match(source, new RegExp(key), `missing Architecture Constraint ${key}`);
  }
});

test('design forbids touching chat-surface files', () => {
  const source = read(design);
  assert.match(source, /ChatTimeline\.vue/);
  assert.match(source, /AgentStatusPanel\.vue/);
  assert.match(source, /stores\/event\.ts/);
  assert.match(source, /agent-tone-\*/);
});

test('design declares the contracts stay untouched', () => {
  const source = read(design);
  assert.match(source, /## 契约影响/);
  assert.match(source, /packages\/shared\/src\/contracts\.ts/);
});

test('design records the rejected agentCards alternative', () => {
  const source = read(design);
  assert.match(source, /## 备选方案/);
  assert.match(source, /agentCards/);
});

test('design excludes fallback edges from the pulse animation', () => {
  const source = read(design);
  assert.match(source, /fallback/);
  assert.match(source, /prefers-reduced-motion/);
});

test('design plans every task with allowedPaths, forbiddenPaths and toolPolicy', () => {
  const source = read(design);
  assert.match(source, /## 任务拆解/);
  for (const task of ['T0', 'T1', 'T2', 'T3', 'T4']) {
    assert.match(source, new RegExp(task), `missing task ${task}`);
  }
  assert.match(source, /allowedPaths/);
  assert.match(source, /forbiddenPaths/);
  assert.match(source, /toolPolicy/);
});

test('design keeps the chain model free of store and component dependencies', () => {
  const source = read(design);
  assert.match(source, /workflowChainModel\.ts/);
  assert.match(source, /纯函数/);
});

test('development document traces both upstream artifacts', () => {
  const source = read(development);
  assert.match(source, /artifact: implementation_summary/);
  assert.match(source, /stage: implementation/);
  assert.match(source, /workflow-view-agent-chain-requirements-v1/);
  assert.match(source, /workflow-view-agent-chain-system-design-v1/);
});

test('development document lists the verification commands', () => {
  const source = read(development);
  assert.match(source, /npm run typecheck/);
  assert.match(source, /npm run test -w @project\/web/);
  assert.match(source, /npm run test:e2e:chinese-copy/);
  assert.match(source, /npm run test:harness/);
});

test('project map links all three workflow-view delivery documents', () => {
  const source = read('docs/ai-agent-context/project-map.md');
  assert.match(source, /workflow-view-agent-chain-requirements-v1/);
  assert.match(source, /workflow-view-agent-chain-system-design-v1/);
  assert.match(source, /workflow-view-agent-chain-development-v1/);
});

test('project map points the workflow view at its chain model', () => {
  const source = read('docs/ai-agent-context/project-map.md');
  assert.match(source, /workflowChainModel\.ts/);
});
