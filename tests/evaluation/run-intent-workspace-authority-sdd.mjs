import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { api, findFreePort, startSmokeServer, stopSmokeServer } from '../e2e/smoke-server.mjs';
const directory = resolve('docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development');
const evidencePrefix = process.env.INTENT_AUTHORITY_EVIDENCE_PREFIX ?? 'workspace-authority';
if (!/^[a-z0-9-]+$/.test(evidencePrefix)) throw new Error('Invalid evidence prefix');
const fixture = await mkdtemp(join(tmpdir(), 'intent-read-http-')), root = join(fixture, 'workspace');
await mkdir(root); await writeFile(join(root, 'README.md'), 'Only actual workspace evidence: ROUTING_READ_MARKER_712\n');
await writeFile(join(root, '.env'), 'FIXTURE_SECRET_NOT_READ=hidden\n');
await mkdir(join(fixture, 'outside')); await writeFile(join(fixture, 'outside', 'outside.txt'), 'OUTSIDE_CONTENT_MUST_NOT_APPEAR');
await symlink(join(fixture, 'outside'), join(root, 'linked-outside'), process.platform === 'win32' ? 'junction' : 'dir');
const digest = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const before = await Promise.all(['README.md', '.env'].map(path => digest(join(root, path))));
const results = [], requests = [];
let server, workspaceId, mode = 'read', message = '读取 README.md 并搜索路由说明，只回答，不要修改文件。', responseRound = 0, release;
const gate = new Promise(done => { release = done; });
let holdRound = -1, atHold, releaseHold, holdPromise;
const provider = createServer(async (request, response) => {
  try {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
    let raw = ''; for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw), prompt = JSON.stringify(input.messages), semantic = prompt.includes('Return only intent_understanding@1.0');
    requests.push({ semantic, mode, nativeToolCount: input.tools?.length ?? 0 });
    if (requests.length === 1) await gate;
    if (!semantic && responseRound === holdRound) { atHold(); await holdPromise; }
    const sourceEventId = prompt.match(/Current source event ID: ([^\s"\\]+)/)?.[1];
    let content;
    if (semantic) content = JSON.stringify({ schemaVersion: '1.0', kind: 'intent_understanding', semanticContractVersion: 'intent-understanding-v1',
      segments: [{ localKey: 'read', dialogueAct: 'question', goal: message, scopeRelation: 'session_context', suggestedAction: 'answer_in_chat',
        target: { workItemId: null, decisionIds: [], artifactIds: [], agentIds: [], confirmationId: null, correctionOfRoutingId: null },
        correction: null, contextPolicy: 'clean_task_context', requestedEffects: [
          { kind: 'answer', target: { kind: 'unresolved', refId: null }, evidenceRefs: ['request'] },
          { kind: 'read_workspace', target: { kind: 'workspace', refId: workspaceId }, evidenceRefs: ['request'] }],
        prohibitions: [{ effectKind: 'modify_source', object: { kind: 'workspace', refId: workspaceId }, scope: 'message', evidenceRefs: ['request'] }],
        evidence: [{ refId: 'request', sourceEventId, start: 0, end: message.length, quote: message }], dependencies: [] }],
      missingFields: [], ambiguityReasons: [], modelConfidence: null });
    else if (responseRound++ === 0) {
      const calls = mode === 'read' ? [{ name: 'search_code', input: { pattern: 'ROUTING_READ_MARKER', maxResults: 5 } },
        { name: 'read_file', input: { path: 'README.md' } }] : mode === 'write' ? [{ name: 'write_file', input: { path: 'README.md', content: 'unauthorized' } }] :
        [{ name: 'read_file', input: { path: '../outside/outside.txt' } }, { name: 'read_file', input: { path: '.env' } },
          { name: 'read_file', input: { path: 'linked-outside/outside.txt' } }];
      content = calls.map(call => `<<TOOL_CALL>>\n${JSON.stringify(call)}\n<<END_TOOL_CALL>>`).join('\n');
    } else {
      if (mode === 'read') {
        assert.ok(prompt.includes('ROUTING_READ_MARKER_712'), 'actual file evidence returned to provider');
        assert.ok(prompt.includes('search_code') && prompt.includes('README.md'));
      } else {
        assert.ok(prompt.includes('PATH_TRAVERSAL') && prompt.includes('SENSITIVE_PATH'));
        assert.ok(!prompt.includes('OUTSIDE_CONTENT_MUST_NOT_APPEAR') && !prompt.includes('FIXTURE_SECRET_NOT_READ'));
      }
      content = JSON.stringify({ schemaVersion: '1.0', kind: 'agent_message', messageKind: 'answer',
        content: mode === 'read' ? 'README.md 的实际读取结果包含 ROUTING_READ_MARKER_712。' : '越界路径和敏感文件的读取均被拒绝。',
        targetAgentIds: [], targetAgentKeys: [], mentionedAgentIds: [], relatedTaskIds: [] });
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: randomUUID(), object: 'chat.completion',
      choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } }));
  } catch (error) { response.writeHead(500).end(JSON.stringify({ error: String(error) })); }
});
const port = await findFreePort(); await new Promise(done => provider.listen(port, '127.0.0.1', done));
async function state() { return JSON.parse(await readFile(server.dataFile, 'utf8')); }
async function until(predicate) {
  const deadline = Date.now() + 30_000; let value;
  do { value = await state(); if (predicate(value)) return value; await new Promise(done => setTimeout(done, 100)); } while (Date.now() < deadline);
  throw new Error(JSON.stringify({ routes: value.intentRoutingRecordsBySession, steps: value.intentPlanStepsBySession }));
}
async function record(id, condition, actual) { results.push({ id, passed: Boolean(condition), actual }); console.log(JSON.stringify(results.at(-1))); assert.ok(condition, id); }
try {
  server = await startSmokeServer('intent-workspace-read', { GLOBAL_DEFAULT_RUNTIME_TYPE: 'generic_llm', INTENT_UNDERSTANDING_ENABLED: 'true',
    INTENT_ROUTING_MODE: 'enforce_all_current_epoch', AGENT_CLUSTER_GITHUB_SESSION_CREATE_ENABLED: 'false', ENABLE_BULLMQ: 'false', LLM_PROVIDER: 'openai-compatible', LLM_MODEL: 'read-fixture',
    LLM_API_KEY: 'fixture-only', LLM_BASE_URL: `http://127.0.0.1:${port}/v1`, LLM_DRY_RUN: 'false', LLM_MOCK_FALLBACK: 'false', LLM_REMOTE_STREAMING: 'false' });
  for (const role of ['intent_router', 'coordinator']) await api(server.apiBase, `/system-agent-runtime-policies/${role}`, { method: 'PATCH', body: JSON.stringify({ preferredRuntimeType: 'generic_llm', allowedRuntimeTypes: ['generic_llm'] }) });
  const created = (await api(server.apiBase, '/sessions', { method: 'POST', body: JSON.stringify({ input: message,
    workingDirectory: { kind: 'server_local', id: 'fixture', name: 'fixture', path: root, selectedAt: new Date().toISOString() } }) })).data;
  workspaceId = created.session.workspaceId; const sessionId = created.session.id; release();
  const completed = await until(value => value.intentPlanStepsBySession?.[sessionId]?.[0]?.status === 'completed');
  const readStep = completed.intentPlanStepsBySession[sessionId][0];
  await record('WR01', readStep.step.effectScope.effects.some(effect => effect.kind === 'read_workspace') &&
    completed.eventsBySession[sessionId].some(event => event.id === `intent-answer:${readStep.id}` && event.content.includes('ROUTING_READ_MARKER_712')) &&
    requests.length === 3, { status: readStep.status, providerRequests: requests.length, scope: readStep.step.effectScope });
  const invocation = completed.runtimeInvocationsBySession[sessionId].find(row => row.phase === 'user_message_response');
  await record('WR02', !(completed.workItemsBySession?.[sessionId]?.length) && !completed.briefsBySession?.[sessionId] &&
    completed.logicalOperationsBySession[sessionId].every(row => ['routing', 'response'].includes(row.admissionClass)) && invocation?.status === 'completed',
    { workItems: completed.workItemsBySession?.[sessionId]?.length ?? 0, invocationStatus: invocation?.status });
  mode = 'traversal'; responseRound = 0; message = '分析工作区文件内容，不要修改文件。';
  const traversal = (await api(server.apiBase, `/sessions/${sessionId}/messages`, { method: 'POST', body: JSON.stringify({ content: message }) })).data;
  const denied = await until(value => value.intentPlanStepsBySession[sessionId].some(row => row.routingId === traversal.routingId && row.status === 'completed'));
  await record('WR03', denied.eventsBySession[sessionId].some(event => event.content === '越界路径和敏感文件的读取均被拒绝。'),
    { traversalRejected: true, sensitiveRejected: true, junctionEscapeRejected: true });
  mode = 'write'; responseRound = 0; message = '继续分析工作区，不要修改文件。'; const beforeWrite = requests.length;
  const write = (await api(server.apiBase, `/sessions/${sessionId}/messages`, { method: 'POST', body: JSON.stringify({ content: message }) })).data;
  const blocked = await until(value => value.intentPlanStepsBySession[sessionId].some(row => row.routingId === write.routingId && row.status === 'failed'));
  const failed = blocked.intentPlanStepsBySession[sessionId].find(row => row.routingId === write.routingId);
  await record('WR04', failed.failureCode === 'CAPABILITY_BLOCKED' && requests.length === beforeWrite + 2 &&
    !blocked.eventsBySession[sessionId].some(event => event.id === `intent-answer:${failed.id}`), { failureCode: failed.failureCode, requestDelta: requests.length - beforeWrite });
  const authorityPath = `/sessions/${sessionId}/intent-workspace-read-authority`;
  const view = async () => (await api(server.apiBase, authorityPath)).data;
  const change = async (action, idempotencyKey) => {
    const current = await view();
    const body = { action, idempotencyKey, dataEpoch: current.dataEpoch,
      expectedBindingHash: action === 'grant' ? current.bindingHash : current.authority.bindingHash,
      expectedGrantRevision: current.authority?.grant.revision ?? 0 };
    return { body, result: (await api(server.apiBase, authorityPath, { method: 'POST', body: JSON.stringify(body) })).data };
  };
  const initial = await view(); assert.equal(initial.authority.grant.revision, 1);
  for (const stage of [0, 1]) {
    mode = 'read'; responseRound = 0; holdRound = stage;
    message = stage === 0 ? '读取 README 并回答读取结果。' : '再次读取 README 并回答。';
    const held = new Promise(done => { atHold = done; }); holdPromise = new Promise(done => { releaseHold = done; });
    const requestCount = requests.length;
    const created = (await api(server.apiBase, `/sessions/${sessionId}/messages`, { method: 'POST', body: JSON.stringify({ content: message }) })).data;
    await Promise.race([held, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('provider did not reach hold')), 15000); timer.unref(); })]);
    const revoked = await change('revoke', `revoke-stage-${stage}`);
    const replay = (await api(server.apiBase, authorityPath, { method: 'POST', body: JSON.stringify(revoked.body) })).data;
    assert.equal(replay.idempotentReplay, true); assert.equal(replay.enabled, false);
    const detail = (await api(server.apiBase, `/sessions/${sessionId}`)).data;
    assert.ok(detail.intentWorkspaceReadAuthority.grant.revokedAt, 'Session cache sees durable revocation');
    const conflict = await fetch(`${server.apiBase}${authorityPath}`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...revoked.body, idempotencyKey: `stale-${stage}` }) });
    assert.equal(conflict.status, 409);
    releaseHold(); holdRound = -1;
    const stopped = await until(value => value.intentPlanStepsBySession[sessionId].some(row => row.routingId === created.routingId && row.status === 'invalidated'));
    const old = stopped.intentPlanStepsBySession[sessionId].find(row => row.routingId === created.routingId);
    await record(stage === 0 ? 'WA01' : 'WA02', !stopped.eventsBySession[sessionId].some(event => event.id === `intent-answer:${old.id}`) &&
      requests.length === requestCount + (stage === 0 ? 2 : 3),
      { invalidatedBefore: stage === 0 ? 'tool-read' : 'answer-publication', attemptsUsed: old.processing.attemptsUsed, providerRequestDelta: requests.length - requestCount });
    const renewed = await change('grant', `grant-stage-${stage}`); assert.equal(renewed.result.enabled, true);
    assert.equal((await state()).intentPlanStepsBySession[sessionId].find(row => row.id === old.id).status, 'invalidated');
  }
  mode = 'read'; responseRound = 0; message = '重新授权后读取 README 并回答。';
  const fresh = (await api(server.apiBase, `/sessions/${sessionId}/messages`, { method: 'POST', body: JSON.stringify({ content: message }) })).data;
  const freshState = await until(value => value.intentPlanStepsBySession[sessionId].some(row => row.routingId === fresh.routingId && row.status === 'completed'));
  await record('WA03', (await view()).authority.grant.revision === 5 && freshState.intentRouteRevisionsBySession[sessionId]
    .find(row => row.routingId === fresh.routingId).authorityGrants[0].revision === 5, { freshGrantRevision: 5, priorPlansStayInvalidated: true });
  const after = await Promise.all(['README.md', '.env'].map(path => digest(join(root, path))));
  await record('WR05', JSON.stringify(before) === JSON.stringify(after), { before, after });
} finally {
  release(); releaseHold?.(); if (server) await stopSmokeServer(server); provider.closeAllConnections(); await new Promise(done => provider.close(done));
  await writeFile(resolve(directory, `${evidencePrefix}-http-results.json`), JSON.stringify({ executedAt: new Date().toISOString(),
    method: 'actual Sessions API + Generic LLM text tool protocol + real temporary files; deterministic provider; no model accuracy claim', results }, null, 2));
  // Both paths are fixed children of the temporary directory created above.
  const tempRelative = relative(resolve(tmpdir()), resolve(fixture));
  if (!tempRelative.startsWith('intent-read-http-') || tempRelative.includes('..') || isAbsolute(tempRelative) || relative(fixture, root) !== 'workspace') throw new Error('Unexpected cleanup path');
  await rm(join(root, 'linked-outside'), { force: true, recursive: false });
  await rm(fixture, { force: true, recursive: true });
}
if (results.length !== 8 || results.some(row => !row.passed)) process.exitCode = 1;
