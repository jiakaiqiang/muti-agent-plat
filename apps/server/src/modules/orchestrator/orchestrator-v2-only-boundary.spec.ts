import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./orchestrator.service.ts', import.meta.url), 'utf8');

test('Orchestrator removes the legacy AgentRunInput boundary', () => {
  assert.doesNotMatch(source, /AgentRunInput/);
  assert.match(source, /InvocationPlan/);
});

test('Orchestrator removes EngineeringRuntimeSelection', () => {
  assert.doesNotMatch(source, /EngineeringRuntimeSelection/);
});

test('Orchestrator has no Agent or Session Runtime selector', () => {
  assert.doesNotMatch(source, /selectEngineeringRuntime|agentRuntimeOverrides|sessionDefaultRuntimeType/);
});

test('Agent identity compilation never reconstructs Runtime or model fields', () => {
  const start = source.indexOf('private compileAgentIdentity');
  assert.ok(start >= 0);
  const block = source.slice(start, source.indexOf('\n  private ', start + 20));
  assert.doesNotMatch(block, /runtimeType|modelId|runtimeSelection|configuredRuntimeType/);
});

test('internal ContextAssembly assembly has no Runtime selection or Tool descriptor lane', () => {
  const start = source.indexOf('private createContextAssembly');
  assert.ok(start >= 0);
  const block = source.slice(start, source.indexOf('\n  private ', start + 20));
  assert.doesNotMatch(block, /runtimeSelection|availableTools|resolvedExecutionTarget/);
});

test('runRuntimeAttempt resolves one InvocationPlan through InvocationResolverService', () => {
  const start = source.indexOf('private async runRuntimeAttempt');
  assert.ok(start >= 0);
  const block = source.slice(start, source.indexOf('\n  private ', start + 20));
  assert.match(block, /this\.invocationResolver\.resolve/);
  assert.match(block, /const plan/);
});

test('runtime_started is emitted only after Plan resolution and grounded gate', () => {
  const start = source.indexOf('private async runRuntimeAttempt');
  const block = source.slice(start, source.indexOf('\n  private ', start + 20));
  const resolveAt = block.indexOf('this.invocationResolver.resolve');
  const gateAt = block.indexOf('evaluateGroundedEvidenceGate');
  const eventAt = block.indexOf("type: 'runtime_started'");
  assert.ok(resolveAt >= 0 && gateAt > resolveAt && eventAt > gateAt);
});

test('RuntimeService receives the final InvocationPlan without Agent target mutation', () => {
  const start = source.indexOf('private async runRuntimeAttempt');
  const block = source.slice(start, source.indexOf('\n  private ', start + 20));
  assert.match(block, /this\.runtime\.start\(plan/);
  assert.doesNotMatch(block, /agent:\s*\{[^}]*runtimeType/s);
});
