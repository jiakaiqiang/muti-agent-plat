import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeOutputExamples } from '@agent-cluster/shared';
import { PersistenceService } from '../persistence/persistence.service.js';
import { GenericLlmRuntimeService } from './generic-llm-runtime.service.js';
import { InputBudgetStore } from './input-budget-store.js';
import { LogicalOperationStore } from './logical-operation-store.js';
import { SessionLifecycleStore } from './session-lifecycle-store.js';
import { makeInvocationPlan } from './invocation-plan.fixture.js';

test('continue reruns read-only tools with different call count and zero workspace writebacks', async t => {
  const originalFetch = globalThis.fetch, savedEnv = { ...process.env };
  Object.assign(process.env, { LLM_MOCK_FALLBACK: 'false', LLM_MAX_RETRIES: '0', LLM_REMOTE_STREAMING: 'false', LLM_INPUT_SAFETY_MARGIN_RATIO: '0' });
  const directory = mkdtempSync(join(tmpdir(), 'input-budget-tools-'));
  const persistence = new PersistenceService({ backend: 'file', filePath: join(directory, 'state.json') }); await persistence.initialize();
  t.after(async () => { globalThis.fetch = originalFetch; process.env = savedEnv;
    await persistence.onModuleDestroy(); rmSync(directory, { recursive: true, force: true }); });
  await persistence.setCollection('sessions', [{ id: 'session', ownerId: 'user', dataEpoch: 'epoch', status: 'EXECUTING' }]);
  await persistence.setCollection('tasksBySession', { session: [{ id: 'task', sessionId: 'session', status: 'running' }] });
  const { lifecycle } = await new SessionLifecycleStore(persistence).initialize('session', 'epoch');
  const operation = await new LogicalOperationStore(persistence).begin({ id: 'op', sessionId: 'session', taskId: 'task', phase: 'task_execution' });
  const policy = { kind: 'agent_task' as const, actorId: 'user', dataEpoch: 'epoch', sessionGeneration: lifecycle.generation,
    taskId: 'task', slot: 'task:task:task_execution:op' };
  let providerCalls = 0, reads = 0, replay = false;
  const service = new GenericLlmRuntimeService({} as never, { connectionForModelId: () => ({
    model: 'test', baseUrl: 'http://llm.test/v1', apiKey: 'test', kind: 'remote' }) } as never,
    { readFile: async () => { reads++; return { ok: true, output: 'x'.repeat(!replay && reads === 1 ? 100 : 16000),
      resolvedPath: 'D:/workspace/file.ts', truncated: false, byteLength: 16000 }; } } as never,
    { resolveServerRoot: () => 'D:/workspace' } as never, undefined, undefined, undefined, undefined, persistence);
  globalThis.fetch = async () => {
    providerCalls++;
    const content = replay && providerCalls === 2 ? JSON.stringify(runtimeOutputExamples.task_execution_result) :
      '<<TOOL_CALL>>\n{"name":"read_file","input":{"path":"file.ts"}}\n<<END_TOOL_CALL>>';
    return new Response(JSON.stringify({ choices: [{ message: { content } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
  };
  const plan = makeInvocationPlan({ sessionId: 'session', taskId: 'task', operation, invocationId: 'probe',
    inputBudgetPolicy: policy, executionTarget: { runtimeType: 'generic_llm' },
    expectedOutput: { kind: 'task_execution_result', schemaVersion: '1.0' },
    toolCatalog: { tools: [{ name: 'read_file', description: 'read', inputSchema: { type: 'object' } }] },
    budget: { maxInputTokens: 1, maxOutputTokens: 500, maxTotalTokens: 50000 } });
  const probe = await service.start({ ...plan, inputBudgetPolicy: undefined }).result;
  assert.equal(providerCalls, 0);
  // Probe uses legacy round-0 estimator to derive a stable cap without hardcoding prompt size.
  plan.budget.maxInputTokens = Number(probe.error?.details?.estimatedInputTokens) + 1000;
  plan.invocationId = 'original';
  const stopped = await service.start(plan).result;
  assert.equal(stopped.status, 'blocked'); assert.equal(providerCalls, 2); assert.equal(reads, 2);
  assert.equal(stopped.usage.inputTokens, 20, 'already sent legs remain accounted');
  const hold: any = stopped.error?.details?.inputBudgetDecision;
  await new InputBudgetStore(persistence).decide('session', 'user', { operationId: 'op', decisionId: hold.id, decision: 'continue' });
  replay = true; reads = 0; providerCalls = 0; plan.invocationId = 'rerun';
  const result = await service.start(plan).result;
  assert.equal(result.status, 'completed', JSON.stringify(result.error)); assert.equal(reads, 1); assert.equal(providerCalls, 2);
  assert.deepEqual(persistence.getCollection('workspaceWritebacks', []), []);
  assert.equal(plan.budget.maxTotalTokens, 50000);
  plan.invocationId = 'next-call'; reads = 0; providerCalls = 0;
  const next = await service.start(plan).result;
  assert.equal(next.error?.code, 'INPUT_BUDGET_EXCEEDED', 'a new over-budget call must ask again');
  assert.notEqual((next.error?.details?.inputBudgetDecision as any)?.id, hold.id);
});
