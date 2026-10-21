import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { api, startSmokeServer, stopSmokeServer } from '../e2e/smoke-server.mjs';

const out = resolve('docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development');
await mkdir(out, { recursive: true });
const results = [];
let server;
try {
  server = await startSmokeServer('intent-restricted-routing-sdd', {
    DISCUSSION_MAX_ROUNDS: '0', MOCK_RUNTIME_DELAY_MS: '1000', GLOBAL_DEFAULT_RUNTIME_TYPE: 'mock',
    INTENT_ROUTING_MODE: 'enforce_new_sessions', ENABLE_BULLMQ: 'false'
  });
  const created = await api(server.apiBase, '/sessions', { method: 'POST', body: JSON.stringify({
    input: '分析当前系统的登录流程', runtimePreference: { preferredRuntimeType: 'mock', allowedRuntimeTypes: ['mock'] }
  }) });
  const sessionId = created.data.session.id;
  await api(server.apiBase, `/sessions/${sessionId}/pause`, { method: 'POST', body: JSON.stringify({ reason: '评测暂停' }) });
  const before = JSON.parse(await readFile(server.dataFile, 'utf8'));
  const previousLifecycle = before.sessionLifecyclesBySession[sessionId];
  const previousBusinessIds = (before.logicalOperationsBySession?.[sessionId] ?? [])
    .filter(item => item.admissionClass !== 'routing').map(item => item.id);
  const message = await api(server.apiBase, `/sessions/${sessionId}/messages`, { method: 'POST',
    headers: { 'idempotency-key': randomUUID() }, body: JSON.stringify({ content: '请解释刚才采用了什么判断标准。' }) });
  const routingId = message.data.routingId;
  assert.ok(routingId, 'paused message must enter routing');
  let routing;
  const deadline = Date.now() + 20_000;
  do {
    routing = (await api(server.apiBase, `/sessions/${sessionId}/message-routings/${routingId}`)).data;
    if (['CLARIFICATION_REQUIRED', 'BLOCKED', 'ROUTED'].includes(routing.status)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  const after = JSON.parse(await readFile(server.dataFile, 'utf8'));
  const lifecycle = after.sessionLifecyclesBySession[sessionId];
  const session = after.sessions.find(item => item.id === sessionId);
  const operation = after.logicalOperationsBySession?.[sessionId]?.find(item => item.id === routingId);
  const businessIds = (after.logicalOperationsBySession?.[sessionId] ?? [])
    .filter(item => item.admissionClass !== 'routing').map(item => item.id);
  const actual = { routingStatus: routing.status, sessionStatus: session.status,
    beforeAdmission: previousLifecycle.admission, afterAdmission: lifecycle.admission,
    beforeGeneration: previousLifecycle.generation, afterGeneration: lifecycle.generation,
    operation: operation && { admissionClass: operation.admissionClass, phase: operation.phase,
      attemptsUsed: operation.attemptsUsed, maxAttempts: operation.maxAttempts, stopState: operation.stopState },
    newBusinessOperations: businessIds.filter(id => !previousBusinessIds.includes(id)) };
  const passed = routing.status === 'CLARIFICATION_REQUIRED' && session.status === 'PAUSED' &&
    lifecycle.admission === 'closed' && lifecycle.generation === previousLifecycle.generation &&
    operation?.admissionClass === 'routing' && operation.attemptsUsed === 1 && operation.stopState === 'confirmed' &&
    actual.newBusinessOperations.length === 0;
  results.push({ caseId: 'IA23-routing', taskIds: ['IR06.2'], status: passed ? 'passed' : 'failed',
    expected: '暂停后允许空工具分类；业务准入保持关闭、generation 不变，无新增业务调用', actual });
  assert.ok(passed, JSON.stringify(actual));
} finally {
  await writeFile(resolve(out, 'restricted-routing-http-results.json'), JSON.stringify({
    executedAt: new Date().toISOString(), method: 'real localhost HTTP; isolated File backend; mock classifier; no external execution', results
  }, null, 2));
  if (server) await stopSmokeServer(server);
}
