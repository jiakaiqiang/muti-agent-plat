import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readdirSync } from 'node:fs';
import { runtimeOutputExamples, type InvocationPlan } from '@agent-cluster/shared';
import { ClaudeCodeRuntimeAdapterService } from './claude-code-runtime-adapter.service.js';
import { makeInvocationPlan } from './invocation-plan.fixture.js';
import { claudeClassificationArgs, claudeClassificationEnv, claudeClassificationPrompt, parseClaudeClassification } from './claude-intent-classification.js';

function plan(): InvocationPlan {
  return makeInvocationPlan({ admissionClass: 'routing', phase: 'user_message_routing', dataEpoch: 'epoch',
    expectedOutput: { kind: 'intent_understanding', schemaVersion: '1.0' }, executionTarget: { runtimeType: 'claude_code' },
    contextEnvelope: { L1: { currentUserMessage: '只解释，不改代码。' }, L5: { bullets: ['Current source event ID: source-1'], turnCount: 1 } } });
}
const frame = (result: unknown = runtimeOutputExamples.intent_understanding, extra = {}) => JSON.stringify({
  type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(result), ...extra
});
async function isolated(body: () => Promise<void>) {
  const keys = ['CLAUDE_CODE_ENABLED', 'CLAUDE_CODE_COMMAND', 'RUNTIME_STREAMING', 'CLAUDE_CODE_PROMPT_MODE'];
  const before = keys.map(key => process.env[key]);
  Object.assign(process.env, { CLAUDE_CODE_ENABLED: 'true', CLAUDE_CODE_COMMAND: process.execPath,
    RUNTIME_STREAMING: 'all', CLAUDE_CODE_PROMPT_MODE: 'file' });
  try { await body(); } finally { keys.forEach((key, i) => { if (before[i] === undefined) delete process.env[key]; else process.env[key] = before[i]; }); }
}

test('classifier removes all native tools and customizations and owns exactly one turn', () => {
  const args = claudeClassificationArgs(plan());
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.equal(args[args.indexOf('--max-turns') + 1], '1');
  const selected = claudeClassificationArgs({ ...plan(), executionTarget: { ...plan().executionTarget, modelId: 'platform-connection-id' } }, 'actual-model');
  assert.equal(selected[selected.indexOf('--model') + 1], 'actual-model');
  for (const flag of ['--safe-mode', '--restricted', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence']) assert.ok(args.includes(flag));
  for (const flag of ['--json-schema', '--resume', '--add-dir', '--allowedTools']) assert.equal(args.includes(flag), false);
  const env = claudeClassificationEnv(plan(), { CLAUDE_CODE_MAX_RETRIES: '15', CLAUDE_CODE_RETRY_WATCHDOG: '1', CLAUDE_CODE_PLUGIN_DIRS: '/plugins' });
  assert.equal(env.CLAUDE_CODE_MAX_RETRIES, '0'); assert.equal(env.CLAUDE_CODE_RETRY_WATCHDOG, '0'); assert.equal(env.CLAUDE_CODE_PLUGIN_DIRS, '');
  const prompt = JSON.parse(claudeClassificationPrompt(plan()));
  assert.equal(prompt.contextEnvelope.L1.currentUserMessage, '只解释，不改代码。');
  assert.deepEqual(prompt.contextEnvelope.L5.bullets, ['Current source event ID: source-1']);
  assert.equal(prompt.outputSchema.properties.kind.const, 'intent_understanding');
});

test('classifier rejects bridge, resume, tools, wrong phase and unregistered version before launch', () => {
  const input = plan();
  for (const patch of [ { executionTarget: { ...input.executionTarget, workspaceProviderKind: 'local_bridge' } },
    { executionTarget: { ...input.executionTarget, executionLocation: 'client' } }, { resume: { cliSessionId: 'old' } },
    { phase: 'task_execution' }, { expectedOutput: { kind: 'intent_understanding', schemaVersion: '2.0' } },
    { toolCatalog: { ...input.toolCatalog, tools: [{ name: 'read_file' }] } } ]) {
    assert.throws(() => claudeClassificationArgs({ ...input, ...patch } as InvocationPlan), /CAPABILITY_UNAVAILABLE/);
  }
});

test('classification parses the new schema and distinguishes measured usage from unknown', () => {
  const parsed = parseClaudeClassification(frame(undefined, { usage: { input_tokens: 10, output_tokens: 20,
    cache_read_input_tokens: 30, cache_creation_input_tokens: 40 } }), plan());
  assert.equal(parsed.output.kind, 'intent_understanding');
  assert.equal(parsed.usage.measurement, 'actual'); assert.equal(parsed.usage.logicalInputTokens, 80);
  assert.equal(parseClaudeClassification(frame(), plan()).usage.measurement, 'unknown');
});

test('invalid schema produces bounded caller-owned repair feedback without another CLI turn', () => {
  assert.throws(() => parseClaudeClassification(frame({ invalid: 'x'.repeat(9000) }), plan()), (error: any) => {
    assert.equal(error.runtimeError.code, 'RUNTIME_OUTPUT_CONTRACT_VIOLATION');
    assert.equal(error.runtimeError.details.schemaRepairOwner, 'intent_classifier');
    assert.equal(error.runtimeError.details.previousOutput.length, 8000);
    assert.ok(error.runtimeError.details.validationErrors.length <= 20); return true;
  });
  for (const extra of [{ is_error: true }, { subtype: 'error_max_turns' }, { type: 'assistant' }]) {
    assert.throws(() => parseClaudeClassification(frame(undefined, extra), plan()), /did not finish/);
  }
});

test('actual adapter uses empty temporary cwd, bypasses brief/snapshots/streaming and cleans it', async () => isolated(async () => {
  let cwd = '', calls = 0;
  const adapter = new ClaudeCodeRuntimeAdapterService({ resolveServerRoot: () => { throw Error('workspace must not be accessed'); } } as never,
    { prepare: () => { throw Error('brief must not be created'); } } as never);
  Object.defineProperty(adapter, 'runBufferedCommand', { value: async (_: string, args: string[], prompt: string, options: any) => {
    calls++; cwd = options.cwd; assert.deepEqual(readdirSync(cwd), []);
    assert.ok(args.includes('--safe-mode')); assert.equal(options.env.CLAUDE_CODE_MAX_RETRIES, '0');
    assert.equal(JSON.parse(prompt).contextEnvelope.L1.currentUserMessage, '只解释，不改代码。');
    return { stdout: frame(), stderr: '' };
  } });
  const result = await adapter.start(plan()).result;
  assert.equal(result.status, 'completed'); assert.equal(calls, 1); assert.equal(existsSync(cwd), false);
  assert.deepEqual(result.artifacts, []); assert.equal(result.runtimeSession, undefined);
}));

test('adapter schema failure cleans its directory and preserves repair feedback', async () => isolated(async () => {
  let cwd = '', calls = 0;
  const adapter = new ClaudeCodeRuntimeAdapterService({} as never);
  Object.defineProperty(adapter, 'runBufferedCommand', { value: async (_: string, _args: string[], _prompt: string, options: any) => {
    calls++; cwd = options.cwd; return { stdout: frame({ wrong: true }), stderr: '' };
  } });
  const result = await adapter.start(plan()).result;
  assert.equal(result.error?.details?.schemaRepairOwner, 'intent_classifier');
  assert.equal(result.usage.measurement, 'unknown'); assert.equal(calls, 1); assert.equal(existsSync(cwd), false);
}));

test('explicit adapter cancellation aborts classification and waits for cleanup', async () => isolated(async () => {
  let ready!: () => void, cwd = '';
  const started = new Promise<void>(resolve => { ready = resolve; });
  const adapter = new ClaudeCodeRuntimeAdapterService({} as never);
  Object.defineProperty(adapter, 'runBufferedCommand', { value: async (_: string, _args: string[], _prompt: string, options: any) => {
    cwd = options.cwd; ready();
    return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  } });
  const input = plan(), handle = adapter.start(input); await started;
  await adapter.cancel(input.invocationId);
  assert.notEqual((await handle.result).status, 'completed'); assert.equal(existsSync(cwd), false);
}));
