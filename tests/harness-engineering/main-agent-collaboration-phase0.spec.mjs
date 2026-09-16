import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..', '..');
const read = path => readFileSync(resolve(root, path), 'utf8');
const phases = ['0', '1', '2a', '2b', '2c', '3', '4', '5', '6'];
const kinds = [['product', 'spec'], ['design', 'plan'], ['implementation', 'tasks'], ['quality', 'checklist']];
const phasePath = (phase, folder, kind) => `docs/${folder}/main-agent-collaboration-phase-${phase}-${kind}-v1.md`;
const contractPath = 'docs/contracts/main-agent-collaboration-contract-v1.md';
const baselinePath = 'docs/implementation/main-agent-collaboration-phase-0-baseline-v1.md';
const roadmapPath = 'docs/roadmap/main-agent-collaboration-roadmap-v1.md';
const documents = [roadmapPath, contractPath, baselinePath, ...phases.flatMap(phase =>
  kinds.map(([folder, kind]) => phasePath(phase, folder, kind)))];

test('all nine SDD phases have four artifacts with resolvable local evidence links', () => {
  for (const path of documents) {
    const source = read(path);
    for (const match of source.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = match[1].split('#')[0];
      if (!target || /^[a-z]+:/i.test(target)) continue;
      assert.ok(existsSync(resolve(root, dirname(path), target)), `${path}: broken link ${target}`);
    }
  }
});

test('acceptance criteria trace to tasks and checklist without dangling task references', () => {
  for (const phase of phases) {
    const spec = read(phasePath(phase, 'product', 'spec'));
    const tasks = read(phasePath(phase, 'implementation', 'tasks'));
    const checklist = read(phasePath(phase, 'quality', 'checklist'));
    const criteria = [...spec.matchAll(/^- (P\w+-AC\d+)：/gm)].map(match => match[1]);
    const taskIds = [...tasks.matchAll(/^### (P\w+-T\d+) /gm)].map(match => match[1]);
    assert.ok(criteria.length > 0 && taskIds.length > 0, phase);
    assert.equal(new Set(criteria).size, criteria.length, `${phase}: duplicate AC`);
    assert.equal(new Set(taskIds).size, taskIds.length, `${phase}: duplicate task`);
    for (const id of criteria) {
      assert.ok(tasks.includes(id), `${phase}: unassigned ${id}`);
      assert.ok(checklist.includes(id), `${phase}: unverified ${id}`);
    }
    for (const [id] of checklist.matchAll(/P\w+-T\d+/g)) {
      assert.ok(taskIds.includes(id), `${phase}: unknown task ${id}`);
    }
    for (const [id] of tasks.matchAll(/P\w+-AC\d+/g)) {
      assert.ok(criteria.includes(id), `${phase}: unknown AC ${id}`);
    }
  }
});

test('shared export and documented ownership use the executable contract as the source of truth', () => {
  assert.match(read('packages/shared/src/index.ts'), /export \* from '\.\/collaboration-contracts\.js'/);
  const source = read('packages/shared/src/collaboration-contracts.ts');
  const matrix = source.match(/COLLABORATION_ACTION_OWNERS = Object\.freeze\(\{([\s\S]*?)\} as const\)/)?.[1];
  assert.ok(matrix);
  const contract = read(contractPath);
  for (const [, action, owner] of matrix.matchAll(/(\w+): '(\w+)'/g)) {
    assert.ok(contract.includes(action), `undocumented action: ${action}`);
    assert.ok(contract.includes(owner), `undocumented owner: ${owner}`);
  }
});

test('phase 0 explicitly separates pure helpers from deferred storage and business entrypoints', () => {
  const contract = read(contractPath);
  assert.match(contract, /数据与迁移登记（deferred）/);
  assert.match(contract, /HTTP 与事件登记（deferred）/);
  assert.match(contract, /当前 API 不变/);
  assert.match(contract, /当前后端尚未调用它/);
  assert.match(contract, /ContextEnvelopeV2/);
  assert.match(contract, /Tool Authority/);
  const baseline = read(baselinePath);
  assert.match(baseline, /仍是物理删除，不可恢复/);
  assert.match(baseline, /旧 writer\/worker/);
  assert.match(baseline, /独立 PostgreSQL/);
  assert.match(baseline, /真实模型/);
});

test('phase 1 handoff and main indexes resolve the frozen phase 0 contract', () => {
  for (const path of ['docs/contracts/README.md', 'docs/README.md', 'docs/ai-agent-context/project-map.md',
    phasePath('1', 'design', 'plan')]) {
    assert.ok(read(path).includes('main-agent-collaboration-contract-v1.md'), path);
  }
  assert.match(read(phasePath('1', 'design', 'plan')), /依赖：阶段 0 通过/);
});

test('baseline npm entrypoints exist and the phase 0 guard participates in the root harness', () => {
  const { scripts } = JSON.parse(read('package.json'));
  for (const [, name] of read(baselinePath).matchAll(/npm run ([\w:-]+)/g)) {
    assert.equal(typeof scripts[name], 'string', `missing script ${name}`);
  }
  assert.ok(scripts['test:harness'].includes('npm run test:harness:main-agent-phase0'));
  assert.ok(scripts['test:harness:main-agent-phase0'].includes('main-agent-collaboration-phase0.spec.mjs'));
});
