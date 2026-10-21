import assert from 'node:assert/strict';
import test from 'node:test';
import { runtimeOutputExamples } from '@agent-cluster/shared';
import { GenericLlmRuntimeService } from './generic-llm-runtime.service.js';
import { makeInvocationPlan } from './invocation-plan.fixture.js';

test('scoped tool-free call stops before provider; unmarked callers retain their behavior', async t => {
  const originalFetch = globalThis.fetch;
  const originalFallback = process.env.LLM_MOCK_FALLBACK;
  process.env.LLM_MOCK_FALLBACK = 'false';
  t.after(() => { globalThis.fetch = originalFetch;
    if (originalFallback === undefined) delete process.env.LLM_MOCK_FALLBACK; else process.env.LLM_MOCK_FALLBACK = originalFallback; });
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ choices: [{ message: {
    content: JSON.stringify(runtimeOutputExamples.agent_message) } }] }), { status: 200 }); };
  const service = new GenericLlmRuntimeService({} as never, { connectionForModelId: () => ({
    id: 'remote:test', model: 'test', baseUrl: 'http://llm.test/v1', apiKey: 'test', kind: 'remote'
  }) } as never, {} as never, { resolveServerRoot: () => undefined } as never);
  const plan = makeInvocationPlan({ executionTarget: { runtimeType: 'generic_llm' },
    expectedOutput: { kind: 'agent_message', schemaVersion: '1.0' }, budget: { maxInputTokens: 1, maxOutputTokens: 100 } });
  (plan as any).inputBudgetPolicy = { actorId: 'user', dataEpoch: 'epoch', sessionGeneration: 1,
    slot: 'task:task:task_execution:operation', kind: 'agent_task', taskId: 'task' };
  const stopped = await service.start(plan).result;
  assert.equal(calls, 0, 'budget overflow must not send any provider request');
  assert.equal(stopped.status, 'blocked');
  assert.equal(stopped.error?.code, 'INPUT_BUDGET_EXCEEDED');
  assert.equal(stopped.events.some(event => event.type === 'runtime_failed'), false, 'waiting is not a provider failure');
  delete (plan as any).inputBudgetPolicy;
  assert.equal((await service.start(plan).result).status, 'completed');
  assert.equal(calls, 1, 'tool-free calls outside the explicit scope remain unchanged');
});

test('tool-loop callable tool set is exactly the three read-only tools', () => {
  assert.deepEqual([...(GenericLlmRuntimeService as any).TOOL_LOOP_READ_ONLY_TOOLS].sort(),
    ['read_attachment', 'read_file', 'search_code']);
});

test('schema repair is a separate guarded physical send and budget stops do not retry providers', async t => {
  const originalFetch = globalThis.fetch;
  const saved = { ...process.env };
  Object.assign(process.env, { LLM_MOCK_FALLBACK: 'false', LLM_SCHEMA_REPAIR_ATTEMPTS: '1', LLM_MAX_RETRIES: '2' });
  t.after(() => { globalThis.fetch = originalFetch; process.env = saved; });
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ choices: [{ message: {
    content: 'unparseable '.repeat(20000) } }] }), { status: 200 }); };
  const service = new GenericLlmRuntimeService({} as never, { connectionForModelId: () => ({ model: 'test',
    baseUrl: 'http://llm.test/v1', apiKey: 'test', kind: 'remote' }) } as never, {} as never,
    { resolveServerRoot: () => undefined } as never);
  const plan = makeInvocationPlan({ executionTarget: { runtimeType: 'generic_llm' },
    expectedOutput: { kind: 'agent_message', schemaVersion: '1.0' }, budget: { maxInputTokens: 15000, maxOutputTokens: 100 },
    inputBudgetPolicy: { kind: 'agent_task', taskId: 'task', slot: 'slot', actorId: 'user', dataEpoch: 'epoch', sessionGeneration: 1 } });
  const result = await service.start(plan).result;
  assert.equal(calls, 1);
  assert.equal(result.error?.code, 'INPUT_BUDGET_EXCEEDED');
  assert.equal(result.error?.retryable, false);
  assert.notEqual(result.error?.details?.providerFailure, true);
});

