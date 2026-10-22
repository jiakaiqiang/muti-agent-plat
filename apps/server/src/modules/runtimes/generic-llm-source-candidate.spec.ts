import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GenericLlmRuntimeService } from './generic-llm-runtime.service.js';
import { makeInvocationPlan } from './invocation-plan.fixture.js';
import { sourceWriteFixture } from '../message-routing/intent-source.test-support.js';

const hash = 'a'.repeat(64);
const proposal = { schemaVersion: '1.0', kind: 'intent_source_candidate', summary: '补充校验', updates: [{ path: 'src/login.ts', content: 'export const ok = true;' }] };
function plan() {
  const input = makeInvocationPlan({ invocationId: 'invocation', sessionId: 'session', taskId: 'task', workItemId: 'work',
    intentStepId: 'step', admissionClass: 'business', dataEpoch: 'epoch',
    executionTarget: { runtimeType: 'generic_llm' }, expectedOutput: { kind: 'intent_source_candidate' as never, schemaVersion: '1.0' },
    executionBinding: { routingId: 'routing', intentRevision: 1, requirementRevision: 1, executionEpoch: 1,
      sessionGeneration: 1, decisionSetHash: hash, effectScopeHash: hash },
    operation: { id: 'operation', sessionGeneration: 1, policyVersion: 'execution-reliability-v1', maxAttempts: 1, deadlineAt: new Date(Date.now() + 60_000).toISOString() },
    inputBudgetPolicy: { kind: 'agent_task', actorId: 'owner', dataEpoch: 'epoch', sessionGeneration: 1,
      taskId: 'task', slot: 'task:task:task_execution:operation' },
    effectScope: { effects: [{ kind: 'modify_source', target: { kind: 'source', refId: 'source:authority' }, evidenceRefs: ['request'] }],
      prohibitions: [], grantIds: ['source-grant'], scopeHash: hash } });
  (input as any).sourceCandidateBinding = { mode: 'candidate_only', authorityId: 'authority', authorityRevision: 1, authorityHash: hash,
    sourceResourceId: 'source:authority', grantId: 'source-grant', workspaceId: 'workspace-test', workspaceBindingHash: hash,
    sessionId: 'session', dataEpoch: 'epoch', sessionGeneration: 1, workItemId: 'work', taskId: 'task', intentStepId: 'step',
    invocationId: 'invocation', operationId: 'operation', effectScopeHash: hash };
  return input;
}
function fixture(t: { after(callback: () => void): void }, candidateService?: any) {
  const savedFetch = globalThis.fetch, saved = { ...process.env };
  Object.assign(process.env, { LLM_MOCK_FALLBACK: 'false', LLM_MAX_RETRIES: '0', LLM_SCHEMA_REPAIR_ATTEMPTS: '0', LLM_REMOTE_STREAMING_ENABLED: 'false' });
  t.after(() => { globalThis.fetch = savedFetch; process.env = saved; });
  const bodies: any[] = [];
  globalThis.fetch = async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(proposal) } }] }), { status: 200 }); };
  const service = new (GenericLlmRuntimeService as any)({ start: () => { throw new Error('MOCK_MUST_NOT_START'); } },
    { connectionForModelId: () => ({ id: 'remote:test', model: 'test', baseUrl: 'http://llm.test/v1', apiKey: 'test', kind: 'remote' }) },
    { readFile: async () => ({ ok: true, output: 'export const ok = false;', truncated: false }) },
    { resolveServerRoot: () => '/fixture' }, undefined, undefined, undefined, undefined, undefined, candidateService) as GenericLlmRuntimeService;
  return { service, bodies };
}

test('candidate invocation without the server live-authority service rejects before any provider request', async t => {
  const { service, bodies } = fixture(t);
  const result = await service.start(plan()).result;
  assert.equal(bodies.length, 0);
  assert.equal(result.error?.code, 'CAPABILITY_BLOCKED');
});

test('candidate mode requires the exact server-owned Agent budget slot before preparation or provider sends', async t => {
  let prepares = 0;
  const { service, bodies } = fixture(t, {
    prepare: async () => { prepares++; return { files: [{ path: 'src/login.ts', content: 'baseline', hash }] }; },
    assertLive: async () => {}, capture: async () => ({ id: 'candidate' })
  });
  const mutations: Array<(input: ReturnType<typeof plan>) => void> = [
    input => { input.inputBudgetPolicy = undefined; },
    input => { input.inputBudgetPolicy!.kind = 'intent_understanding'; },
    input => { input.inputBudgetPolicy!.actorId = ''; },
    input => { input.inputBudgetPolicy!.dataEpoch = 'other-epoch'; },
    input => { input.inputBudgetPolicy!.sessionGeneration = 2; },
    input => { input.inputBudgetPolicy!.taskId = 'other-task'; },
    input => { input.inputBudgetPolicy!.slot = 'other-slot'; },
    input => { input.budget.maxInputTokens = undefined; },
    input => { input.budget.maxInputTokens = Number.NaN; },
    input => { input.budget.maxInputTokens = 0; }
  ];
  for (const mutate of mutations) {
    const input = plan(); mutate(input);
    const result = await service.start(input).result;
    assert.equal(result.error?.code, 'CAPABILITY_BLOCKED');
    assert.match(result.error?.message ?? '', /INTENT_SOURCE_CANDIDATE_BUDGET_SCOPE_REQUIRED/);
  }
  assert.equal(prepares, 0); assert.equal(bodies.length, 0);
});

test('prepared baseline is in the budgeted request and capture produces only a candidate, never a writeback', async t => {
  const calls: string[] = [];
  const captured = { id: 'candidate:invocation', manifestHash: hash };
  const { service, bodies } = fixture(t, { prepare: async () => { calls.push('prepare'); return { files: [{ path: 'src/login.ts', content: 'fixed baseline', hash }] }; },
    assertLive: async () => { calls.push('live'); }, capture: async (_input: unknown, output: unknown) => { assert.deepEqual(output, proposal); calls.push('capture'); return captured; } });
  const result = await service.start(plan()).result;
  assert.equal(result.status, 'completed');
  assert.equal(bodies.length, 1);
  assert.match(JSON.stringify(bodies[0].messages), /fixed baseline/);
  assert.deepEqual(result.executionCandidate, captured);
  assert.equal(result.workspaceExecution, undefined);
  assert.deepEqual(result.artifacts, []);
  assert.equal(calls[0], 'prepare');
  assert.ok(calls.includes('live'));
  assert.equal(calls.at(-1), 'capture');
});

test('candidate mode cannot fall back to mock and malformed bindings cannot reach the authority service', async t => {
  let prepares = 0;
  const { service, bodies } = fixture(t, { prepare: async () => { prepares++; return { files: [] }; } });
  process.env.LLM_MOCK_FALLBACK = 'true';
  assert.equal((await service.start(plan()).result).error?.code, 'CAPABILITY_BLOCKED');
  const input = plan(); input.taskId = 'other';
  assert.equal((await service.start(input).result).error?.code, 'CAPABILITY_BLOCKED');
  assert.equal(prepares, 0);
  assert.equal(bodies.length, 0);
});

test('authority invalidation immediately before physical send never calls provider or capture', async t => {
  let captures = 0;
  const { service, bodies } = fixture(t, { prepare: async () => ({ files: [{ path: 'src/login.ts', content: 'baseline', hash }] }),
    assertLive: async () => { throw new Error('INTENT_SOURCE_AUTHORITY_STALE'); }, capture: async () => { captures++; } });
  const result = await service.start(plan()).result;
  assert.equal(result.error?.code, 'CAPABILITY_BLOCKED');
  assert.equal(bodies.length, 0); assert.equal(captures, 0);
});

test('fixed baseline counts toward the R6 input budget and overflow makes zero model requests', async t => {
  let captures = 0;
  const { service, bodies } = fixture(t, { prepare: async () => ({ files: [{ path: 'src/login.ts', content: 'large baseline '.repeat(5000), hash }] }),
    assertLive: async () => {}, capture: async () => { captures++; } });
  const input = plan();
  input.budget = { maxInputTokens: 1000, maxOutputTokens: 100 };
  input.inputBudgetPolicy = { kind: 'agent_task', taskId: 'task', slot: 'task:task:task_execution:operation', actorId: 'owner', dataEpoch: 'epoch', sessionGeneration: 1 };
  const result = await service.start(input).result;
  assert.equal(result.status, 'blocked');
  assert.equal(result.error?.code, 'INPUT_BUDGET_EXCEEDED');
  assert.equal(bodies.length, 0); assert.equal(captures, 0);
});

test('model-supplied authority fields fail the candidate output contract without capture or automatic repair', async t => {
  let sends = 0, captures = 0;
  const { service } = fixture(t, { prepare: async () => ({ files: [{ path: 'src/login.ts', content: 'baseline', hash }] }),
    assertLive: async () => {}, capture: async () => { captures++; } });
  process.env.LLM_SCHEMA_REPAIR_ATTEMPTS = '1';
  globalThis.fetch = async () => { sends++; return new Response(JSON.stringify({ choices: [{ message: {
    content: JSON.stringify({ ...proposal, authorityId: 'forged' }) } }] }), { status: 200 }); };
  const result = await service.start(plan()).result;
  assert.equal(result.error?.code, 'RUNTIME_OUTPUT_CONTRACT_VIOLATION');
  assert.equal(sends, 1); assert.equal(captures, 0);
});

test('tool-loop candidate guard rechecks before every read and physical send, including revocation after one read', async t => {
  let checks = 0, reads = 0, captures = 0;
  const { service, bodies } = fixture(t, { prepare: async () => ({ files: [{ path: 'src/login.ts', content: 'baseline', hash }] }),
    assertLive: async () => { checks++; if (reads) throw new Error('INTENT_SOURCE_AUTHORITY_STALE'); }, capture: async () => { captures++; } });
  (service as any).workspaceTools.readFile = async () => { reads++; return { ok: true, output: 'old content', truncated: false }; };
  globalThis.fetch = async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return new Response(JSON.stringify({ choices: [{ message: {
    content: '<<TOOL_CALL>>\n{"name":"read_file","input":{"path":"src/login.ts"}}\n<<END_TOOL_CALL>>' } }] }), { status: 200 }); };
  const input = plan();
  input.effectScope!.effects.push({ kind: 'read_workspace', target: { kind: 'workspace', refId: 'workspace-test' }, evidenceRefs: ['read'] });
  input.effectScope!.grantIds.push('read-grant');
  input.toolCatalog.tools = [{ name: 'read_file', description: 'read', inputSchema: { type: 'object' } }];
  input.executionTarget.requiredCapabilities = ['read'];
  const result = await service.start(input).result;
  assert.equal(reads, 1); assert.equal(bodies.length, 1); assert.ok(checks >= 3);
  assert.equal(result.error?.code, 'CAPABILITY_BLOCKED'); assert.equal(captures, 0);
});

test('generic source proposals persist a server candidate and task checkpoint while actual source remains untouched', async t => {
  const source = await sourceWriteFixture(); t.after(() => source.cleanup());
  const { service, bodies } = fixture(t, source.candidates);
  const input = makeInvocationPlan({ ...source.plan, agent: { ...source.plan.agent, systemPrompt: '仅提出候选修改。' },
    contextEnvelope: { ...source.plan.contextEnvelope, sessionId: source.plan.sessionId }, budget: { maxInputTokens: 16000, maxOutputTokens: 2000 } });
  globalThis.fetch = async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return new Response(JSON.stringify({ choices: [{ message: {
    content: JSON.stringify(source.proposal) } }] }), { status: 200 }); };
  const before = await readFile(join(source.root, source.path), 'utf8');
  const result = await service.start(input).result;
  assert.equal(result.status, 'completed', result.error?.message);
  assert.equal(bodies.length, 1);
  assert.equal(result.executionCandidate?.changeSet.changes[0]?.operation, 'update');
  assert.equal(result.workspaceExecution, undefined);
  assert.equal(await readFile(join(source.root, source.path), 'utf8'), before);
  const session = source.persistence.getCollection<any[]>('sessions', [])[0];
  const tasks = source.persistence.getCollection<Record<string, any[]>>('tasksBySession', {});
  assert.equal(session.intentSourceCandidates[0].candidate.id, result.executionCandidate?.id);
  assert.equal(tasks.session[0].executionCheckpoint.candidateId, result.executionCandidate?.id);
});
