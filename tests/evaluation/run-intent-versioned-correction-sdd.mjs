import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { api, createSessionAndWaitForBrief, startSmokeServer, stopSmokeServer } from '../e2e/smoke-server.mjs';

const out = resolve('docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development');
const restartFile = resolve('.cache/agent-cluster', `intent-correction-restart-${randomUUID()}.json`);
const environment = { DISCUSSION_MAX_ROUNDS: '0', GLOBAL_DEFAULT_RUNTIME_TYPE: 'mock', INTENT_ROUTING_MODE: 'enforce_new_sessions', ENABLE_BULLMQ: 'false' };
const results = [];
let server;
async function record(id, feature, actual, passed) {
  results.push({ id, feature, actual, passed });
  console.log(JSON.stringify({ id, passed, actual }));
}
async function post(path, body) {
  const response = await fetch(`${server.apiBase}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
await mkdir(out, { recursive: true });
try {
  server = await startSmokeServer('intent-versioned-correction-sdd', environment);
  const { sessionId } = await createSessionAndWaitForBrief(server.apiBase, '实现登录，并保留当前审批边界。', {
    runtimePreference: { preferredRuntimeType: 'mock', allowedRuntimeTypes: ['mock'] }
  });
  const message = await api(server.apiBase, `/sessions/${sessionId}/messages`, { method: 'POST', headers: { 'idempotency-key': randomUUID() },
    body: JSON.stringify({ content: '先继续修复登录问题，再新增导出功能。' }) });
  const routingId = message.data.routingId;
  const routePath = `/sessions/${sessionId}/message-routings/${routingId}`;
  let route;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    route = (await api(server.apiBase, routePath)).data;
    if (route.status === 'CLARIFICATION_REQUIRED') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (route.status !== 'CLARIFICATION_REQUIRED') throw new Error(`Expected clarification fixture, got ${route.status}`);
  const works = (await api(server.apiBase, `/sessions/${sessionId}/work-items`)).data.items;
  const work = works[0];
  const input = { contractVersion: 'intent-correction-v1', expectedRoutingRevision: route.routingRevision,
    idempotencyKey: randomUUID(), instruction: '不是新需求，只是补充当前登录任务的超时约束。', targetWorkItemId: work.id,
    supersedesDecisionId: null, expectedDecisionRevision: null };
  const malformed = await post(`${routePath}/corrections`, { ...input, safeToApply: true });
  await record('VC01', '拒绝客户端授权字段', { status: malformed.status }, malformed.status === 400);
  const stale = await post(`${routePath}/corrections`, { ...input, expectedRoutingRevision: 999999 });
  await record('VC02', '过期版本拒绝', { status: stale.status }, stale.status === 409);
  const concurrent = await Promise.all([post(`${routePath}/corrections`, input), post(`${routePath}/corrections`, input)]);
  const correctionId = concurrent[0].body.data?.correctionId;
  await record('VC03', '并发重复接收一次纠错', { statuses: concurrent.map(item => item.status), ids: concurrent.map(item => item.body.data?.correctionId) },
    concurrent.every(item => item.status === 202) && Boolean(correctionId) && concurrent.every(item => item.body.data?.correctionId === correctionId));
  const held = (await api(server.apiBase, routePath)).data;
  const heldWork = (await api(server.apiBase, `/sessions/${sessionId}/work-items`)).data.items.find(item => item.id === work.id);
  await record('VC04', '纠错接收后路由与任务屏障同时持久化', { routeHold: held.dispatchHold, workHold: heldWork.dispatchHold,
    executionEpoch: heldWork.executionEpoch, requirementRevision: heldWork.requirementRevision },
    held.dispatchHold?.correctionId === correctionId && heldWork.dispatchHold?.correctionId === correctionId && heldWork.executionEpoch === 2 && heldWork.requirementRevision === 1);
  const changed = await post(`${routePath}/corrections`, { ...input, instruction: '同键不同请求' });
  await record('VC05', '重复幂等键不能覆盖纠错', { status: changed.status }, changed.status === 409);
  const oldChoice = await post(`${routePath}/clarify`, { choice: 'independent_new' });
  await record('VC06', '旧确认卡不能绕过纠错屏障', { status: oldChoice.status }, oldChoice.status === 409);
  const history = (await api(server.apiBase, `${routePath}/corrections`)).data;
  await record('VC07', '202不代表生效且历史权限未知', { count: history.corrections.length,
    status: history.corrections[0]?.status, revisions: history.revisions.map(item => ({ revision: item.intentRevision, authorization: item.authorizationState })) },
    history.corrections.length === 1 && history.corrections[0].status !== 'applied' && history.revisions.length === 1 && history.revisions[0].authorizationState === 'unknown');
  await writeFile(restartFile, await readFile(server.dataFile));
  await stopSmokeServer(server); server = undefined;
  server = await startSmokeServer('intent-versioned-correction-restart', { ...environment, AGENT_CLUSTER_DATA_FILE: restartFile });
  const replay = await post(`${routePath}/corrections`, input);
  const restored = (await api(server.apiBase, routePath)).data;
  await record('VC08', '进程重启保持纠错身份和屏障', { status: replay.status, id: replay.body.data?.correctionId, hold: restored.dispatchHold },
    replay.status === 202 && replay.body.data?.correctionId === correctionId && restored.dispatchHold?.correctionId === correctionId);
} finally {
  await writeFile(resolve(out, 'versioned-correction-http-results.json'), JSON.stringify({ executedAt: new Date().toISOString(),
    method: 'real localhost HTTP; isolated File backend; mock classifier; server process restart; no real model or PostgreSQL', results }, null, 2));
  if (server) await stopSmokeServer(server);
  await rm(restartFile, { force: true });
}
if (results.length !== 8 || results.some(item => !item.passed)) process.exitCode = 1;
