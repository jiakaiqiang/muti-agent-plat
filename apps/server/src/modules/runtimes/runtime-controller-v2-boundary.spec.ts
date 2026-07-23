import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./runtime.controller.ts', import.meta.url), 'utf8');

test('Runtime controller removes AgentRunInput', () => {
  assert.doesNotMatch(source, /AgentRunInput/);
});

test('smoke input is declared as InvocationPlan', () => {
  assert.match(source, /createSmokePlan[\s\S]*InvocationPlan/);
});

test('smoke Agent identity contains no Runtime or model selection', () => {
  const start = source.indexOf('agent: {');
  const block = source.slice(start, source.indexOf('\n      },', start) + 9);
  assert.doesNotMatch(block, /runtimeType|modelId|runtimeSelection/);
});

test('smoke execution target owns Runtime selection', () => {
  assert.match(source, /executionTarget:\s*\{[\s\S]*runtimeType/);
});

test('smoke plan includes a resolved Tool catalog snapshot', () => {
  assert.match(source, /toolCatalog:\s*\{[\s\S]*catalogHash/);
});

test('smoke plan includes a v2 ContextEnvelope with L0 through L6', () => {
  for (const layer of ['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6']) {
    assert.match(source, new RegExp(`${layer}:\\s*\\{`), layer);
  }
});

test('smoke plan has no legacy ContextAssembly or options lane', () => {
  const start = source.indexOf('private createSmokePlan');
  const block = source.slice(start);
  assert.doesNotMatch(block, /contextAssembly|options\s*:/);
});

test('RuntimeService receives the constructed InvocationPlan directly', () => {
  assert.match(source, /this\.runtime\.run\(this\.createSmokePlan\(/);
});
