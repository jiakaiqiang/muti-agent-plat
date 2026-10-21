import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { api, createSessionAndWaitForBrief, startSmokeServer, stopSmokeServer } from '../e2e/smoke-server.mjs';
const directory = resolve('docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development');
const root = await mkdtemp(join(tmpdir(), 'intent-artifact-http-')), results = [];
const environment = { DISCUSSION_MAX_ROUNDS: '0', INTENT_ROUTING_MODE: 'disabled', INTENT_UNDERSTANDING_ENABLED: 'false',
  GLOBAL_DEFAULT_RUNTIME_TYPE: 'mock', AGENT_CLUSTER_GITHUB_SESSION_CREATE_ENABLED: 'false', ENABLE_BULLMQ: 'false' };
let server;
const record = (id, condition, actual) => { results.push({ id, passed: Boolean(condition), actual }); console.log(JSON.stringify(results.at(-1))); assert.ok(condition, id); };
try {
  server = await startSmokeServer('intent-artifact-storage', environment);
  const { sessionId } = await createSessionAndWaitForBrief(server.apiBase, '验证产物持久化和方案文档。', { agentIds: ['requirements'],
    workingDirectory: { kind: 'server_local', id: 'fixture', name: 'fixture', path: root, selectedAt: new Date().toISOString() },
    runtimePreference: { preferredRuntimeType: 'mock', allowedRuntimeTypes: ['mock'] } });
  const list = async () => (await api(server.apiBase, `/sessions/${sessionId}/artifacts`)).data.items;
  const original = await list();
  record('AS01', original.some(row => row.metadata.phase === 'task_brief'), { durableBriefArtifacts: original.length });
  const create = (key, content, parentDocumentId) => api(server.apiBase, `/sessions/${sessionId}/discussion-documents`, {
    method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify({ title: '事务方案', clientMessageId: key, content, parentDocumentId }) });
  const content = '# 方案一\n\n产物先持久化，再发布事件。';
  const [one, replay] = await Promise.all([create('artifact-doc-1', content), create('artifact-doc-1', content)]);
  const first = one.data, detail = (await api(server.apiBase, `/artifacts/${first.artifactId}`)).data;
  record('AS02', first.id === replay.data.id && detail.id === first.artifactId && await readFile(join(root, first.relativePath), 'utf8') === content,
    { duplicateDocumentId: first.id, readableArtifactId: detail.id });
  const second = (await create('artifact-doc-2', '# 方案二\n\n新版本保留历史产物。', first.id)).data;
  const after = await list();
  record('AS03', original.every(row => after.some(item => item.id === row.id)) && after.some(row => row.id === first.artifactId) && after.some(row => row.id === second.artifactId),
    { historicalArtifactsPreserved: true, artifactCount: after.length });
  const restartFile = join(root, 'restart.json'); await writeFile(restartFile, await readFile(server.dataFile));
  await stopSmokeServer(server); server = undefined;
  server = await startSmokeServer('intent-artifact-storage-restart', { ...environment, AGENT_CLUSTER_DATA_FILE: restartFile }); server.dataFile = restartFile;
  const restored = await list();
  record('AS04', after.every(row => restored.some(item => item.id === row.id)), { actualServerRestart: true, preservedArtifactCount: restored.length });
} finally {
  if (server) await stopSmokeServer(server);
  const child = relative(resolve(tmpdir()), resolve(root)); assert.ok(child.startsWith('intent-artifact-http-') && !child.includes('..') && !isAbsolute(child));
  await rm(root, { force: true, recursive: true });
  await writeFile(resolve(directory, 'artifact-transaction-http-results.json'), JSON.stringify({ executedAt: new Date().toISOString(),
    method: 'real localhost Nest/File, existing mock-runtime Brief and discussion document paths; no new write_artifact executor claim', results }, null, 2));
}
assert.equal(results.length, 4);
