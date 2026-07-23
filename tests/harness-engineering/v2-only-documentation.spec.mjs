import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..', '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');

test('product requirements record the confirmed v2-only decision', () => {
  const source = read('docs/product/context-pipeline-v2-only-session-requirements-v1.md');
  assert.match(source, /v2-only/);
  assert.match(source, /不保留旧字段兼容/);
});

test('system design makes Adapter metadata authoritative for routing', () => {
  const source = read('docs/design/context-pipeline-v2-only-agent-decoupling-system-design-v1.md');
  assert.match(source, /supportedWorkspaceCapabilities/);
  assert.match(source, /supportedToolNames/);
});

test('system design documents the single start handle Adapter boundary', () => {
  const source = read('docs/design/context-pipeline-v2-only-agent-decoupling-system-design-v1.md');
  assert.match(source, /start\(plan: InvocationPlan.*AgentRuntimeRunHandle/);
});

test('system design contains no Promise-returning Adapter run boundary', () => {
  const source = read('docs/design/context-pipeline-v2-only-agent-decoupling-system-design-v1.md');
  assert.doesNotMatch(source, /run\(plan: InvocationPlan.*Promise<AgentRunResult>/);
});

test('development document records implementation status and pending real cutover', () => {
  const source = read('docs/implementation/context-pipeline-v2-only-agent-decoupling-development-v1.md');
  assert.match(source, /实现与空 v2 全链路验收已完成/);
  assert.match(source, /真实数据.*待独立授权/);
});

test('API contract exposes context-envelopes only', () => {
  const source = read('docs/contracts/api-contract-v0.1.md');
  assert.match(source, /debug\/context-envelopes/);
  assert.doesNotMatch(source, /debug\/context-packs/);
});

test('Runtime contract documents InvocationPlan and the single start handle', () => {
  const source = read('docs/contracts/runtime-contract-v0.1.md');
  assert.match(source, /InvocationPlan/);
  assert.match(source, /start\(input.*AgentRuntimeRunHandle/);
  assert.doesNotMatch(source, /stream\(runId|contextPack/);
});

test('feature inventory describes Profile references instead of Agent Skill binding', () => {
  const source = read('docs/analysis/feature-inventory-and-status-v1.md');
  assert.match(source, /\$\{skill:key\}/);
  assert.doesNotMatch(source, /Agent `skillIds` 绑定/);
});

test('project map links all three v2-only delivery documents', () => {
  const source = read('docs/ai-agent-context/project-map.md');
  assert.match(source, /context-pipeline-v2-only-session-requirements-v1/);
  assert.match(source, /context-pipeline-v2-only-agent-decoupling-system-design-v1/);
  assert.match(source, /context-pipeline-v2-only-agent-decoupling-development-v1/);
});

test('local development documents v2 Runtime config and explicit cutover safety', () => {
  const source = read('docs/devops/local-development.md');
  assert.match(source, /GLOBAL_DEFAULT_RUNTIME_TYPE/);
  assert.match(source, /RUNTIME_STREAMING/);
  assert.match(source, /cutover:context-v2.*dry-run/s);
});
