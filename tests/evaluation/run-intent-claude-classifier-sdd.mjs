import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runtimeOutputExamples } from '@agent-cluster/shared';
import { createSmokeV2State } from '../e2e/smoke-server.mjs';
const base = '../../apps/server/dist/apps/server/src/modules/runtimes/';
const { ClaudeCodeRuntimeAdapterService } = await import(`${base}claude-code-runtime-adapter.service.js`);
const { resolveClaudeCommand } = await import(`${base}claude-cli-launcher.js`);
const { makeInvocationPlan } = await import(`${base}invocation-plan.fixture.js`);
const command = resolveClaudeCommand().executable;
const version = execFileSync(command, ['--version'], { encoding: 'utf8', windowsHide: true }).trim();
const directory = await mkdtemp(join(tmpdir(), 'intent-claude-evaluation-'));
const output = resolve('docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development');
const results = [], requests = [];
let scenario = 'valid';
let app;
let forbiddenCommand;
const text = '解释当前意图路由，不要修改代码。';
const provider = createServer(async (request, response) => {
  let raw = ''; for await (const chunk of request) raw += chunk;
  if (request.url?.includes('/count_tokens')) { response.writeHead(200, { 'content-type': 'application/json' }).end('{"input_tokens":100}'); return; }
  if (!request.url?.startsWith('/v1/messages')) { response.writeHead(404).end(); return; }
  const body = JSON.parse(raw), prompt = JSON.stringify(body.messages);
  requests.push({ scenario, tools: (body.tools ?? []).map(tool => tool.name), sourcePreserved: prompt.includes(text),
    sourceEventPreserved: prompt.includes('claude-fixture-source'), privateContextLoaded: prompt.includes('PRIVATE_CLAUDE_CONTEXT_CANARY'),
    maxTokens: body.max_tokens, model: body.model });
  if (['auth', 'rate'].includes(scenario)) {
    response.writeHead(scenario === 'auth' ? 401 : 429, { 'content-type': 'application/json', 'retry-after': '0' });
    response.end(JSON.stringify({ type: 'error', error: { type: scenario === 'auth' ? 'authentication_error' : 'rate_limit_error', message: 'fixture failure' } })); return;
  }
  const result = scenario === 'invalid' || (scenario === 'durable' && requests.filter(row => row.scenario === 'durable').length === 1)
    ? '{"invalid":true}' : JSON.stringify(runtimeOutputExamples.intent_understanding);
  const malicious = scenario === 'tool';
  const toolInput = { command: forbiddenCommand };
  if (!body.stream) {
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'msg_fixture', type: 'message', role: 'assistant',
      model: body.model, content: malicious ? [{ type: 'tool_use', id: 'tool_fixture', name: 'Bash', input: toolInput }]
        : [{ type: 'text', text: result }], stop_reason: malicious ? 'tool_use' : 'end_turn', usage: { input_tokens: 100, output_tokens: 50 } })); return;
  }
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (type, data) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  send('message_start', { message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: body.model, content: [],
    stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } });
  send('content_block_start', { index: 0, content_block: malicious ? { type: 'tool_use', id: 'tool_fixture', name: 'Bash', input: {} } : { type: 'text', text: '' } });
  send('content_block_delta', { index: 0, delta: malicious ? { type: 'input_json_delta', partial_json: JSON.stringify(toolInput) } : { type: 'text_delta', text: result } });
  send('content_block_stop', { index: 0 }); send('message_delta', { delta: { stop_reason: malicious ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 50 } });
  send('message_stop', {}); response.end();
});
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
const savedEnv = { ...process.env };
try {
  const config = join(directory, 'config'); await mkdir(config);
  await writeFile(join(config, 'CLAUDE.md'), 'PRIVATE_CLAUDE_CONTEXT_CANARY');
  const marker = join(directory, 'hook-ran.txt'), hook = join(directory, 'hook.cjs');
  await writeFile(hook, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected');`);
  forbiddenCommand = `node "${hook}"`;
  await writeFile(join(config, 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `node "${hook}"` }] }] } }));
  Object.assign(process.env, { CLAUDE_CODE_ENABLED: 'true', CLAUDE_CODE_COMMAND: command, CLAUDE_CONFIG_DIR: config,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${provider.address().port}`, ANTHROPIC_API_KEY: 'fixture-only', ANTHROPIC_AUTH_TOKEN: 'fixture-only',
    CLAUDE_CODE_OAUTH_TOKEN: '', CLAUDE_CODE_USE_BEDROCK: '', CLAUDE_CODE_USE_VERTEX: '', CLAUDE_CODE_USE_FOUNDRY: '',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', RUNTIME_STREAMING: 'all', MAX_THINKING_TOKENS: '0', ANTHROPIC_MODEL: 'claude-sonnet-4-20250514' });
  const adapter = new ClaudeCodeRuntimeAdapterService({ resolveServerRoot: () => { throw Error('classification touched workspace'); } });
  for (const kind of ['valid', 'invalid', 'auth', 'rate', 'tool']) {
    scenario = kind;
    const plan = makeInvocationPlan({ invocationId: `claude-${kind}`, admissionClass: 'routing', phase: 'user_message_routing', dataEpoch: 'epoch',
      executionTarget: { runtimeType: 'claude_code', modelId: 'claude-sonnet-4-20250514' }, expectedOutput: { kind: 'intent_understanding', schemaVersion: '1.0' },
      contextEnvelope: { L1: { currentUserMessage: text }, L5: { bullets: ['Current source event ID: claude-fixture-source'], turnCount: 1 } } });
    const result = await adapter.start(plan, AbortSignal.timeout(30_000)).result;
    const sent = requests.filter(request => request.scenario === kind);
    const expected = kind === 'valid' ? result.status === 'completed' && result.output.kind === 'intent_understanding'
      : kind === 'invalid' ? result.error?.details?.schemaRepairOwner === 'intent_classifier' : result.status === 'failed';
    const passed = expected && sent.length === 1 && sent.every(row => row.tools.length === 0 && row.sourcePreserved && row.sourceEventPreserved && !row.privateContextLoaded);
    results.push({ id: `CLI-${kind}`, passed, status: result.status, code: result.error?.code,
      message: result.error?.message, usage: result.usage, requests: sent });
    console.log(JSON.stringify(results.at(-1))); assert.ok(passed, `CLI-${kind}`);
  }
  const hookRan = await access(marker).then(() => true, () => false);
  results.push({ id: 'CLI-isolation', passed: !hookRan, hookRan }); assert.equal(hookRan, false);

  // Real Nest Runtime + persisted classifier, including its one permitted schema repair.
  scenario = 'durable';
  const stateFile = join(directory, 'state.json'); await writeFile(stateFile, JSON.stringify(createSmokeV2State()));
  Object.assign(process.env, { NODE_ENV: 'test', AGENT_CLUSTER_PERSISTENCE: 'true', AGENT_CLUSTER_PERSISTENCE_BACKEND: 'file',
    AGENT_CLUSTER_SECRET_KEY: randomBytes(32).toString('hex'),
    AGENT_CLUSTER_DATA_FILE: stateFile, AGENT_CLUSTER_SEED_DEFAULT_AGENTS: 'true', ENABLE_BULLMQ: 'false',
    PHASE_6_POLICY_ADMISSION_BYPASS: 'isolated_test_only', GLOBAL_DEFAULT_RUNTIME_TYPE: 'claude_code',
    ANTHROPIC_MODEL: 'claude-sonnet-4-20250514', MOCK_RUNTIME_ENABLED: 'true' });
  const modulePath = '../../apps/server/dist/apps/server/src/modules/';
  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('../../apps/server/dist/apps/server/src/app.module.js');
  const { PersistenceService } = await import(`${modulePath}persistence/persistence.service.js`);
  const { ContextManagementService } = await import(`${modulePath}context-management/context-management.service.js`);
  const { IntentUnderstandingRoutingService } = await import(`${modulePath}intent-recognition/intent-understanding-routing.service.js`);
  const { SystemAgentRuntimePolicyService } = await import(`${modulePath}agents/system-agent-runtime-policy.service.js`);
  const { RuntimeModelConfigService } = await import(`${modulePath}runtimes/runtime-model-config.service.js`);
  const { SessionLifecycleStore } = await import(`${modulePath}runtimes/session-lifecycle-store.js`);
  app = await NestFactory.createApplicationContext(AppModule, { logger: false, abortOnError: false });
  const persistence = app.get(PersistenceService), context = app.get(ContextManagementService);
  const configured = await app.get(RuntimeModelConfigService).addModel({ kind: 'remote', provider: 'anthropic-compatible',
    credentialLocation: 'server', model: 'claude-sonnet-4-20250514', label: 'isolated-cli-fixture',
    baseUrl: `http://127.0.0.1:${provider.address().port}`, apiKey: 'fixture-only' });
  const model = configured.availableModels.find(row => row.label === 'isolated-cli-fixture'); assert.ok(model);
  await app.get(SystemAgentRuntimePolicyService).update('intent_router', { preferredRuntimeType: 'claude_code',
    preferredModelId: model.id, allowedRuntimeTypes: ['claude_code'] });
  const session = { id: 'cli-session', dataEpoch: persistence.currentDataEpoch(), revision: 1, decisionLedgerRevision: 0,
    title: 'CLI 分类', originalInput: text, status: 'PAUSED', ownerId: 'fixture-user', workspaceId: 'fixture-workspace',
    participatingAgentIds: [], tokenUsed: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await persistence.setCollection('sessions', [session]);
  await persistence.setCollection('eventsBySession', { [session.id]: [{ id: 'claude-fixture-source', sessionId: session.id,
    type: 'user_message', content: text, toAgentIds: [], createdAt: session.createdAt, actor: { type: 'user', id: session.ownerId },
    metadata: { schemaVersion: '0.1', renderAs: 'chat_message', payload: { text } } }] });
  await new SessionLifecycleStore(persistence).initialize(session.id, session.dataEpoch);
  await persistence.mutateCollections(['sessionLifecyclesBySession'], draft => { draft.sessionLifecyclesBySession[session.id].admission = 'closed'; });
  const snapshot = await context.buildIntentSnapshot({ session, sourceEventId: 'claude-fixture-source', currentMessage: text, latestEventSeq: 1 });
  const route = await context.createRoutingRecord({ session, sourceEventId: 'claude-fixture-source', idempotencyKey: 'first', rolloutMode: 'enforce_all_current_epoch' });
  const classifier = app.get(IntentUnderstandingRoutingService), input = { sessionId: session.id, routingId: route.id, snapshotId: snapshot.id };
  const classified = await classifier.classify(input);
  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  const operation = state.logicalOperationsBySession[session.id].find(row => row.id === route.id);
  const sent = requests.filter(row => row.scenario === 'durable');
  const passed = classified.status === 'VALIDATING' && sent.length === 2 && sent.every(row => row.tools.length === 0 && row.sourcePreserved && row.sourceEventPreserved && row.model === 'claude-sonnet-4-20250514') &&
    operation.attemptsUsed === 2 && operation.deadlineAt === classified.classificationDeadlineAt && state.sessions[0].status === 'PAUSED' &&
    state.sessionLifecyclesBySession[session.id].admission === 'closed' && context.listWorkItems(session.id).length === 0;
  results.push({ id: 'CLI-durable-repair', passed, status: classified.status, attempts: operation?.attemptsUsed,
    errors: classified.reasonCodes, requests: sent,
    failures: (state.runtimeInvocationsBySession?.[session.id] ?? []).map(row => ({ status: row.status, error: row.error })) });
  console.log(JSON.stringify(results.at(-1))); assert.ok(passed, 'CLI-durable-repair');
  const replay = await classifier.classify(input);
  results.push({ id: 'CLI-replay', passed: replay.routingRevision === classified.routingRevision && requests.filter(row => row.scenario === 'durable').length === 2 });
  assert.equal(results.at(-1).passed, true);
} finally {
  if (app) await app.close();
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key]; Object.assign(process.env, savedEnv);
  provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
  await writeFile(join(output, 'claude-classifier-cli-results.json'), JSON.stringify({ version, results,
    scope: 'Installed native CLI + actual adapter and Nest Runtime/Worker/File classifier + deterministic local Anthropic fixture; not model accuracy or Sessions HTTP ingress' }, null, 2));
  // Only this freshly-created evaluation directory is removed.
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + '\\') || resolve(directory).startsWith(resolve(tmpdir()) + '/'));
  await rm(directory, { recursive: true, force: true });
}
