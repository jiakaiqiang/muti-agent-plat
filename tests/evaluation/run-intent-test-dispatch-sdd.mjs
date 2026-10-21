import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { api, findFreePort, startSmokeServer, stopSmokeServer } from '../e2e/smoke-server.mjs';
const out = resolve('docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development');
const evidencePrefix = process.env.INTENT_DISPATCH_EVIDENCE_PREFIX ?? 'test-dispatch';
const executeCorrections = process.env.INTENT_DISPATCH_CORRECTION_EXECUTION === 'true';
const testCorrections = executeCorrections || process.env.INTENT_DISPATCH_CORRECTION === 'true';
const testReports = process.env.INTENT_DISPATCH_REPORT === 'true';
const testReportCorrections = testReports && process.env.INTENT_DISPATCH_REPORT_CORRECTION === 'true';
assert.ok(!(testReports && testCorrections), 'Report and correction suites have separate evidence boundaries');
let requestReport = testReports;
const fixture = await mkdtemp(join(tmpdir(), 'intent-test-dispatch-http-')), workspace = join(fixture, 'workspace'), restartFile = join(fixture, 'restart.json');
await mkdir(workspace); await writeFile(join(workspace, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }));
const results = []; let server, sessionId, workItemId, resourceId, workspaceId;
let message = '为当前目录建立测试任务上下文', mode = 'initial', modelCalls = 0;
let correctionRoutingId;
const provider = createServer(async (request, response) => {
  try {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
    let raw = ''; for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw), prompt = JSON.stringify(input.messages); modelCalls++;
    assert.ok(prompt.includes('Return only intent_understanding@1.0'));
    const sourceEventId = prompt.match(/Current source event ID: ([^\s"\\]+)/)?.[1];
    if (mode === 'test') { assert.ok(prompt.includes(resourceId)); assert.ok(prompt.includes('run_tests')); }
    const content = { schemaVersion: '1.0', kind: 'intent_understanding', semanticContractVersion: 'intent-understanding-v1',
      segments: [{ localKey: 'test-request', dialogueAct: 'command', goal: message,
        scopeRelation: mode === 'initial' ? 'initial_requirement' : 'same_requirement', suggestedAction: mode === 'initial' ? 'create_initial_work_item' : 'enqueue_follow_up',
        target: { workItemId: mode === 'initial' ? null : workItemId, decisionIds: [], artifactIds: [], agentIds: [], confirmationId: null, correctionOfRoutingId: null },
        correction: null, contextPolicy: mode === 'initial' ? 'clean_task_context' : 'inherit_confirmed',
        requestedEffects: mode === 'initial' ? [] : [{ kind: 'run_tests', target: { kind: 'test_runner', refId: resourceId }, evidenceRefs: ['request'] },
          ...(requestReport ? [{ kind: 'write_artifact', target: { kind: 'artifact', refId: resourceId.replace('test-runner:', 'test-report:') }, evidenceRefs: ['request'] }] : [])],
        prohibitions: mode === 'initial' ? [] : [{ effectKind: 'modify_source', object: { kind: 'workspace', refId: workspaceId }, scope: 'message', evidenceRefs: ['request'] }],
        evidence: [{ refId: 'request', sourceEventId, start: 0, end: message.length, quote: message }], dependencies: [] }],
      missingFields: [], ambiguityReasons: [], modelConfidence: null };
    if (mode === 'correction') Object.assign(content.segments[0], { dialogueAct: 'correction', suggestedAction: 'correct_route',
      target: { ...content.segments[0].target, correctionOfRoutingId: correctionRoutingId },
      requestedEffects: executeCorrections || testReportCorrections ? content.segments[0].requestedEffects : [],
      prohibitions: executeCorrections || testReportCorrections ? content.segments[0].prohibitions : [] });
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: randomUUID(), object: 'chat.completion',
      choices: [{ message: { role: 'assistant', content: JSON.stringify(content) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } }));
  } catch (error) { response.writeHead(500).end(JSON.stringify({ error: String(error) })); }
});
const port = await findFreePort(); await new Promise(done => provider.listen(port, '127.0.0.1', done));
const environment = { GLOBAL_DEFAULT_RUNTIME_TYPE: 'generic_llm', INTENT_UNDERSTANDING_ENABLED: 'true', INTENT_ROUTING_MODE: 'enforce_all_current_epoch',
  AGENT_CLUSTER_GITHUB_SESSION_CREATE_ENABLED: 'false', ENABLE_BULLMQ: 'false', LLM_PROVIDER: 'openai-compatible', LLM_MODEL: 'test-authority-fixture',
  LLM_API_KEY: 'fixture-only', LLM_BASE_URL: `http://127.0.0.1:${port}/v1`, LLM_DRY_RUN: 'false', LLM_MOCK_FALLBACK: 'false', LLM_REMOTE_STREAMING: 'false',
  INTENT_ISOLATED_TEST_IMAGE: process.env.INTENT_TEST_DOCKER_IMAGE };
const state = () => readFile(server.dataFile, 'utf8').then(JSON.parse);
async function until(predicate) { const deadline = Date.now() + 45_000; let value;
  do { value = await state(); if (predicate(value)) return value; await new Promise(done => setTimeout(done, 100)); } while (Date.now() < deadline);
  throw new Error(JSON.stringify({ routes: value.intentRoutingRecordsBySession, corrections: value.intentCorrectionsBySession, modelCalls })); }
const path = () => `/sessions/${sessionId}/intent-test-authority`;
const view = async () => (await api(server.apiBase, path())).data;
async function post(body) { const response = await fetch(`${server.apiBase}${path()}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() }; }
const input = (current, action, key, script = 'test') => ({ action, script, dataEpoch: current.dataEpoch, idempotencyKey: key,
  ...(testReports && action === 'grant' ? { writeReport: true } : {}),
  expectedGrantRevision: current.authority?.grant.revision ?? 0,
  expectedBindingHash: action === 'revoke' ? current.authority.binding.bindingHash : current.availableBindings.find(row => row.script === script).bindingHash });
async function record(id, condition, actual) { results.push({ id, passed: Boolean(condition), actual }); console.log(JSON.stringify(results.at(-1))); assert.ok(condition, id); }

assert.match(environment.INTENT_ISOLATED_TEST_IMAGE ?? '', /^sha256:[a-f0-9]{64}$/);
const send = async () => (await api(server.apiBase, `/sessions/${sessionId}/messages`, { method: 'POST', body: JSON.stringify({ content: message }) })).data;
const stepFor = (value, routingId) => value.intentPlanStepsBySession?.[sessionId]?.find(row => row.routingId === routingId);
const operationFor = (value, routingId) => value.logicalOperationsBySession?.[sessionId]?.find(row => row.id === `intent-test:${stepFor(value, routingId)?.id}`);
const setScript = async script => writeFile(join(workspace, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(77)"', 'test:unit': script } }));
try {
  server = await startSmokeServer('intent-test-dispatch', environment);
  for (const role of ['intent_router', 'coordinator']) await api(server.apiBase, `/system-agent-runtime-policies/${role}`,
    { method: 'PATCH', body: JSON.stringify({ preferredRuntimeType: 'generic_llm', allowedRuntimeTypes: ['generic_llm'] }) });
  const created = (await api(server.apiBase, '/sessions', { method: 'POST', body: JSON.stringify({ input: message,
    workingDirectory: { kind: 'server_local', id: 'fixture', name: 'fixture', path: workspace, selectedAt: new Date().toISOString() } }) })).data;
  sessionId = created.session.id; workspaceId = created.session.workspaceId;
  const initial = await until(value => value.workItemsBySession?.[sessionId]?.length === 1); workItemId = initial.workItemsBySession[sessionId][0].id;
  const first = await view(); resourceId = first.availableBindings.find(row => row.script === 'test:unit').resourceId;
  mode = 'test'; message = testReports ? '只运行 test:unit 测试并保存报告，不修改源码' : '只运行 test:unit 测试，不修改源码';
  const denied = await send();
  const blocked = await until(value => value.intentRoutingRecordsBySession?.[sessionId]?.some(row => row.id === denied.routingId && ['BLOCKED','CLARIFICATION_REQUIRED'].includes(row.status)));
  await record('TD01', !operationFor(blocked, denied.routingId), { noGrantNoInvocation: true });
  await post(input(first, 'grant', 'grant', 'test:unit')); resourceId = (await view()).authority.binding.resourceId;
  await setScript('node --test proof.cjs');
  await writeFile(join(workspace, 'source.txt'), 'original');
  await writeFile(join(workspace, 'proof.cjs'), 'const {test}=require("node:test"),fs=require("node:fs"),assert=require("node:assert/strict");test("HTTP isolated test",()=>{assert.throws(()=>fs.writeFileSync("/input/source.txt","changed"));fs.writeFileSync("scratch.txt","allowed");});');
  const sent = await send();
  const done = await until(value => ['completed','failed','invalidated','reconciliation_required'].includes(stepFor(value, sent.routingId)?.status));
  const completed = stepFor(done, sent.routingId), operation = operationFor(done, sent.routingId), attempt = operation?.isolatedTestAttempts?.[0];
  await record('TD02', completed.status === 'completed' && attempt?.phase === 'finished' && attempt.result.exitCode === 0 &&
    attempt.script === 'test:unit' && attempt.stopConfirmed && !attempt.cleanupRequired && await readFile(join(workspace, 'source.txt'), 'utf8') === 'original',
    { step: completed, operation, runtime: done.runtimeInvocationsBySession?.[sessionId]?.filter(row => row.phase === 'task_execution') });
  const published = done.eventsBySession[sessionId].filter(row => row.id === `intent-test-result:${completed.id}`);
  const artifacts = done.artifacts?.artifactIdsBySession?.[sessionId] ?? [];
  await record('TD03', published.length === 1 && done.eventOutbox.filter(row => row.id === `outbox:${published[0].id}`).length === 1 &&
    artifacts.length === (testReports ? 1 : 0) && (done.tasksBySession?.[sessionId]?.length ?? 0) === 0 && (done.briefsBySession?.[sessionId]?.length ?? 0) === 0 &&
    !done.sessions.find(row => row.id === sessionId).currentTaskBriefId && operation.attemptsUsed === 1,
    { events: published.length, artifacts: artifacts.length, noTaskOrBriefDispatch: true, attempts: operation.attemptsUsed });
  if (testReports) {
    const report = done.artifacts.artifactsById[completed.resultArtifactId];
    const listed = (await api(server.apiBase, `/sessions/${sessionId}/artifacts`)).data;
    await record('TR01', report?.metadata.intentTestReport.snapshotHash === attempt.snapshotHash &&
      report.metadata.intentTestReport.content.includes('HTTP isolated test') && report.metadata.intentTestReport.exitCode === 0 &&
      listed.items.some(row => row.id === report.id) && report.platformProjections.length === 0 &&
      done.eventOutbox.filter(row => row.id === `outbox:intent-test-artifact:${completed.id}`).length === 1,
      { artifact: report, actualArtifactApi: true, atomicOutbox: true });
  }
  await writeFile(restartFile, JSON.stringify(done)); await stopSmokeServer(server); server = undefined;
  server = await startSmokeServer('intent-test-dispatch-restart', { ...environment, AGENT_CLUSTER_DATA_FILE: restartFile }); server.dataFile = restartFile;
  const restored = await state();
  await record('TD04', operationFor(restored, sent.routingId).isolatedTestAttempts.length === 1 && stepFor(restored, sent.routingId).status === 'completed' &&
    (!testReports || restored.artifacts.artifactIdsBySession[sessionId].length === 1),
    { actualServerRestart: true, noRepeatedCompletedInvocation: true });
  await setScript('node -e "console.log(\'running\');setInterval(()=>{},1000)"');
  const long = await send();
  const launched = await until(value => operationFor(value, long.routingId)?.isolatedTestAttempts?.[0]?.phase === 'running');
  const containerName = operationFor(launched, long.routingId).isolatedTestAttempts[0].containerName;
  const inspectDeadline = Date.now() + 15000; let actuallyRunning = false;
  while (Date.now() < inspectDeadline) {
    const inspected = await promisify(execFile)('docker', ['inspect', containerName, '--format', '{{.State.Running}}'], { windowsHide: true }).catch(() => undefined);
    if (inspected?.stdout.trim() === 'true') { actuallyRunning = true; break; }
    await new Promise(done => setTimeout(done, 100));
  }
  assert.ok(actuallyRunning, 'Docker confirms the test is running before authority is revoked');
  const revokedAt = Date.now(); const revoked = await post(input(await view(), 'revoke', 'revoke-running', 'test:unit'));
  const stopped = await until(value => ['invalidated','failed'].includes(stepFor(value, long.routingId)?.status));
  const stoppedAttempt = operationFor(stopped, long.routingId)?.isolatedTestAttempts?.[0];
  await record('TD05', revoked.status === 201 && stoppedAttempt?.stopConfirmed && !stoppedAttempt.cleanupRequired &&
    !stepFor(stopped, long.routingId).resultArtifactId &&
    !stopped.eventsBySession[sessionId].some(row => row.id === `intent-test-result:${stepFor(stopped, long.routingId).id}`),
    { elapsedMs: Date.now() - revokedAt, actuallyRunningBeforeRevoke: actuallyRunning, step: stepFor(stopped, long.routingId), attempt: stoppedAttempt });
  await post(input(await view(), 'grant', 'regrant', 'test:unit'));
  const afterGrant = await state();
  await record('TD06', operationFor(afterGrant, long.routingId).isolatedTestAttempts.length === 1 && stepFor(afterGrant, long.routingId).status === 'invalidated',
    { noOldPlanReplay: true, attempts: operationFor(afterGrant, long.routingId).attemptsUsed });
  await setScript('node -e "process.exit(3)"');
  const failing = await send();
  const failed = await until(value => stepFor(value, failing.routingId)?.status === 'failed');
  await record('TD07', operationFor(failed, failing.routingId)?.isolatedTestAttempts?.[0]?.result.exitCode === 3 &&
    !failed.eventsBySession[sessionId].some(row => row.id === `intent-test-result:${stepFor(failed, failing.routingId).id}`),
    { failedStep: stepFor(failed, failing.routingId), attempts: operationFor(failed, failing.routingId).attemptsUsed });
  if (testReports) {
    const report = failed.artifacts.artifactsById[stepFor(failed, failing.routingId).resultArtifactId];
    await record('TR02', report?.metadata.intentTestReport.exitCode === 3 && report.metadata.status === 'failed' &&
      failed.artifacts.artifactIdsBySession[sessionId].length === 2,
      { failedTestEvidenceSaved: true, failedTestNotReportedAsSuccess: true, artifactId: report?.id });
    await post({ ...input(await view(), 'grant', 'remove-report', 'test:unit'), writeReport: false });
    const reportDenied = await send();
    const rejected = await until(value => value.intentRoutingRecordsBySession?.[sessionId]?.some(row => row.id === reportDenied.routingId && ['BLOCKED', 'CLARIFICATION_REQUIRED'].includes(row.status)));
    assert.ok(!operationFor(rejected, reportDenied.routingId));
    requestReport = false; message = '只运行 test:unit 测试，不修改源码'; await setScript('node -e "process.exit(0)"');
    const plain = await send();
    const plainDone = await until(value => stepFor(value, plain.routingId)?.status === 'completed');
    await record('TR03', !stepFor(plainDone, plain.routingId).resultArtifactId && plainDone.artifacts.artifactIdsBySession[sessionId].length === 2 &&
      await readFile(join(workspace, 'source.txt'), 'utf8') === 'original' && !(plainDone.workspaceWritebacks ?? []).length,
      { testOnlyStillWorks: true, noUnauthorizedReport: true, sourceUnchanged: true, noWriteback: true });
  }
  if (testReportCorrections) {
    await post(input(await view(), 'grant', 'restore-report', 'test:unit'));
    requestReport = true; mode = 'correction'; correctionRoutingId = sent.routingId;
    message = '纠正前面的测试请求：重新运行 test:unit 并保存报告，不修改源码';
    await setScript('node -e "console.log(\'replacement-report-evidence\')"');
    const before = await state(), oldArtifact = before.artifacts.artifactsById[completed.resultArtifactId];
    const route = before.intentRoutingRecordsBySession[sessionId].find(row => row.id === sent.routingId);
    const correctionPath = `/sessions/${sessionId}/message-routings/${sent.routingId}/corrections`;
    const request = { contractVersion: 'intent-correction-v1', expectedRoutingRevision: route.routingRevision, idempotencyKey: 'replace-report',
      instruction: message, targetWorkItemId: workItemId, supersedesDecisionId: null, expectedDecisionRevision: null };
    await api(server.apiBase, correctionPath, { method: 'POST', body: JSON.stringify(request) });
    const applied = await until(value => value.intentCorrectionsBySession?.[sessionId]?.some(row => row.routingId === sent.routingId && row.status === 'applied'));
    const correction = applied.intentCorrectionsBySession[sessionId].find(row => row.routingId === sent.routingId);
    await record('RC01', correction.affectedExecutionIds.includes(attempt.invocationId) &&
      correction.effectReconciliation?.executions.some(row => row.disposition === 'published_report_retained' && row.artifactId === oldArtifact.id),
      { correction, oldCompletedExecutionReconciled: true });
    const replaced = await until(value => value.intentPlanStepsBySession[sessionId].some(row => row.routingId === sent.routingId && row.intentRevision === 2 && row.status === 'completed'));
    const newStep = replaced.intentPlanStepsBySession[sessionId].find(row => row.routingId === sent.routingId && row.intentRevision === 2);
    const newArtifact = replaced.artifacts.artifactsById[newStep.resultArtifactId];
    assert.deepEqual(replaced.artifacts.artifactsById[oldArtifact.id], oldArtifact);
    await record('RC02', newArtifact.metadata.intentTestReport.supersedesArtifactIds?.length === 1 &&
      newArtifact.metadata.intentTestReport.supersedesArtifactIds[0] === oldArtifact.id && newArtifact.metadata.intentTestReport.content.includes('replacement-report-evidence') &&
      newArtifact.metadata.intentTestReport.snapshotHash !== oldArtifact.metadata.intentTestReport.snapshotHash &&
      replaced.artifacts.artifactIdsBySession[sessionId].length === 3 && await readFile(join(workspace, 'source.txt'), 'utf8') === 'original',
      { oldArtifactUnchanged: true, replacement: newArtifact, sourceUnchanged: true });
    const calls = modelCalls;
    await api(server.apiBase, correctionPath, { method: 'POST', body: JSON.stringify(request) });
    const restart = join(fixture, 'report-correction-restart.json'); await writeFile(restart, JSON.stringify(await state()));
    await stopSmokeServer(server); server = undefined;
    server = await startSmokeServer('intent-report-correction-restart', { ...environment, AGENT_CLUSTER_DATA_FILE: restart }); server.dataFile = restart;
    const recovered = await state();
    await record('RC03', modelCalls === calls && recovered.artifacts.artifactIdsBySession[sessionId].length === 3 &&
      recovered.logicalOperationsBySession[sessionId].find(row => row.id === `intent-test:${newStep.id}`).isolatedTestAttempts.length === 1 &&
      recovered.eventsBySession[sessionId].filter(row => row.id === `intent-test-artifact:${newStep.id}`).length === 1,
      { actualRestart: true, noRepeatedTestOrReport: true });
    await post({ ...input(await view(), 'grant', 'remove-report-again', 'test:unit'), writeReport: false });
    const latest = await state(), latestRoute = latest.intentRoutingRecordsBySession[sessionId].find(row => row.id === sent.routingId);
    await api(server.apiBase, correctionPath, { method: 'POST', body: JSON.stringify({ ...request,
      expectedRoutingRevision: latestRoute.routingRevision, idempotencyKey: 'rejected-report-correction' }) });
    const rejected = await until(value => value.intentCorrectionsBySession?.[sessionId]?.some(row => row.idempotencyKey === 'rejected-report-correction' && ['rejected', 'clarification_required'].includes(row.status)));
    const deniedCorrection = rejected.intentCorrectionsBySession[sessionId].find(row => row.idempotencyKey === 'rejected-report-correction');
    await record('RC04', deniedCorrection.reasonCodes.includes('EFFECT_NOT_AUTHORIZED') && rejected.artifacts.artifactIdsBySession[sessionId].length === 3 &&
      rejected.intentRoutingRecordsBySession[sessionId].find(row => row.id === sent.routingId).currentIntentRevision === 2 &&
      rejected.intentRoutingRecordsBySession[sessionId].find(row => row.id === sent.routingId).dispatchHold?.correctionId === deniedCorrection.id &&
      !rejected.intentPlanStepsBySession[sessionId].some(row => row.routingId === sent.routingId && row.intentRevision === 3),
      { deniedCorrection, revokedReportGrantBlocksReplacement: true, historicalReportsRetained: true });
  }
  if (testCorrections) {
    await setScript('node -e "console.log(\'correction-running\');setInterval(()=>{},1000)"');
    const running = await send();
    const started = await until(value => operationFor(value, running.routingId)?.isolatedTestAttempts?.[0]?.phase === 'running');
    const name = operationFor(started, running.routingId).isolatedTestAttempts[0].containerName;
    const deadline = Date.now() + 15_000; let confirmedRunning = false;
    while (Date.now() < deadline) {
      const inspected = await promisify(execFile)('docker', ['inspect', name, '--format', '{{.State.Running}}'], { windowsHide: true }).catch(() => undefined);
      if (inspected?.stdout.trim() === 'true') { confirmedRunning = true; break; }
      await new Promise(done => setTimeout(done, 100));
    }
    assert.ok(confirmedRunning, 'Docker confirms a running container before correction');
    mode = 'correction'; correctionRoutingId = running.routingId;
    message = executeCorrections ? '纠正前面的测试请求：重新运行 test:unit，不修改源码' : '改为只记录测试要求，暂不运行';
    // The old container already has its own snapshot. The replacement reads a new immutable snapshot.
    if (executeCorrections) await setScript('node -e "console.log(\'corrected-test\')"');
    const before = await state(), originalRoute = before.intentRoutingRecordsBySession[sessionId].find(row => row.id === running.routingId);
    const request = { contractVersion: 'intent-correction-v1', expectedRoutingRevision: originalRoute.routingRevision,
      idempotencyKey: 'correct-running-test', instruction: message, targetWorkItemId: workItemId, supersedesDecisionId: null, expectedDecisionRevision: null };
    const correctionPath = `/sessions/${sessionId}/message-routings/${running.routingId}/corrections`;
    const accepted = await api(server.apiBase, correctionPath, { method: 'POST', body: JSON.stringify(request) });
    const applied = await until(value => value.intentCorrectionsBySession?.[sessionId]?.some(row => row.routingId === running.routingId && row.status === 'applied'));
    const correction = applied.intentCorrectionsBySession[sessionId].find(row => row.routingId === running.routingId);
    const correctedRoute = applied.intentRoutingRecordsBySession[sessionId].find(row => row.id === running.routingId);
    const oldOperation = operationFor(applied, running.routingId), oldAttempt = oldOperation.isolatedTestAttempts[0];
    const gone = await promisify(execFile)('docker', ['inspect', name], { windowsHide: true }).then(() => false, () => true);
    await record('TC01', gone && oldAttempt.stopConfirmed && !oldAttempt.cleanupRequired && correctedRoute.currentIntentRevision === 2 &&
      !correctedRoute.dispatchHold && correction.effectReconciliation?.executions.length === 1 &&
      !applied.eventsBySession[sessionId].some(row => row.id === `intent-test-result:${stepFor(applied, running.routingId).id}`),
      { confirmedRunning, accepted, correction, correctedRoute, oldAttempt, containerRemoved: gone });
    let replacementStepId;
    if (executeCorrections) {
      const finished = await until(value => value.intentPlanStepsBySession[sessionId].some(row =>
        row.routingId === running.routingId && row.intentRevision === 2 && row.status === 'completed'));
      const replacement = finished.intentPlanStepsBySession[sessionId].find(row => row.routingId === running.routingId && row.intentRevision === 2);
      replacementStepId = replacement.id;
      const newOperation = finished.logicalOperationsBySession[sessionId].find(row => row.id === `intent-test:${replacement.id}`);
      const newAttempt = newOperation?.isolatedTestAttempts?.[0];
      await record('TX01', replacement.step.action === 'correct_route' && replacement.step.executionBinding.executionEpoch === 2 &&
        newOperation.executionBinding.intentRevision === 2 && newOperation.attemptsUsed === 1 && newAttempt?.result.exitCode === 0 &&
        newAttempt.result.stdout.includes('corrected-test') && newAttempt.stopConfirmed && !newAttempt.cleanupRequired &&
        newAttempt.snapshotHash !== oldAttempt.snapshotHash && await readFile(join(workspace, 'source.txt'), 'utf8') === 'original' &&
        finished.eventsBySession[sessionId].filter(row => row.id === `intent-test-result:${replacement.id}`).length === 1 &&
        (finished.tasksBySession?.[sessionId]?.length ?? 0) === 0 && (finished.artifacts?.artifactIdsBySession?.[sessionId]?.length ?? 0) === 0,
        { replacement, newOperation, separateSnapshots: true, sourceUnchanged: true, noTasksOrArtifacts: true });
    }
    const callsBeforeReplay = modelCalls;
    await api(server.apiBase, correctionPath, { method: 'POST', body: JSON.stringify(request) });
    const correctionRestartFile = join(fixture, 'correction-restart.json');
    await writeFile(correctionRestartFile, JSON.stringify(await state())); await stopSmokeServer(server); server = undefined;
    server = await startSmokeServer('intent-correction-reconciliation-restart', { ...environment, AGENT_CLUSTER_DATA_FILE: correctionRestartFile }); server.dataFile = correctionRestartFile;
    const recovered = await state();
    await record('TC02', modelCalls === callsBeforeReplay && operationFor(recovered, running.routingId).isolatedTestAttempts.length === 1 &&
      recovered.eventsBySession[sessionId].filter(row => row.type === 'intent_correction_applied' && row.metadata?.payload?.correctionId === correction.id).length === 1 &&
      recovered.intentRouteRevisionsBySession[sessionId].filter(row => row.routingId === running.routingId).length === 2 &&
      (!executeCorrections || (recovered.logicalOperationsBySession[sessionId].find(row => row.id === `intent-test:${replacementStepId}`).isolatedTestAttempts.length === 1 &&
        recovered.eventsBySession[sessionId].filter(row => row.id === `intent-test-result:${replacementStepId}`).length === 1)),
      { sameKeyReplayAndActualRestart: true, modelCalls, noRepeatedInvocation: true, noRepeatedActivation: true });
    if (executeCorrections) {
      message = '再次纠正前面的测试请求：重新运行 test:unit，不修改源码';
      const chat = (await api(server.apiBase, `/sessions/${sessionId}/messages`, { method: 'POST',
        body: JSON.stringify({ content: message, replyToEventId: originalRoute.sourceEventId }) })).data;
      const chatFinished = await until(value => value.intentPlanStepsBySession[sessionId].some(row =>
        row.routingId === running.routingId && row.intentRevision === 3 && row.status === 'completed'));
      const third = chatFinished.intentPlanStepsBySession[sessionId].find(row => row.routingId === running.routingId && row.intentRevision === 3);
      const chatCorrection = chatFinished.intentCorrectionsBySession[sessionId].find(row => row.originRoutingId === chat.routingId);
      const thirdOperation = chatFinished.logicalOperationsBySession[sessionId].find(row => row.id === `intent-test:${third.id}`);
      await record('TX02', chatCorrection?.status === 'applied' && chatCorrection.processing.attemptsUsed === 2 &&
        chatFinished.eventsBySession[sessionId].filter(row => row.id === chatCorrection.sourceEventId && row.type === 'user_message').length === 1 &&
        thirdOperation.attemptsUsed === 1 && thirdOperation.executionBinding.executionEpoch === 3 &&
        thirdOperation.isolatedTestAttempts[0].result.exitCode === 0 &&
        !chatFinished.followUpMessagesBySession?.[sessionId]?.some(row => row.routingId === chat.routingId),
        { chatCorrection, third, thirdOperation, sourceEventReused: true, classificationBudgetShared: true });
    }
  }
} finally {
  await writeFile(resolve(out, `${evidencePrefix}-http-results.json`), JSON.stringify({ executedAt: new Date().toISOString(),
    method: 'real localhost Nest HTTP, File persistence, deterministic classifier, actual Docker tests and server restart; no model accuracy claim', results }, null, 2));
  if (server) await stopSmokeServer(server); provider.closeAllConnections(); await new Promise(done => provider.close(done));
  const child = relative(resolve(tmpdir()), resolve(fixture)); assert.ok(child.startsWith('intent-test-dispatch-http-') && !child.includes('..') && !isAbsolute(child));
  await rm(fixture, { recursive: true, force: true });
}
if (results.length !== (testReportCorrections ? 14 : testReports ? 10 : executeCorrections ? 11 : testCorrections ? 9 : 7) || results.some(row => !row.passed)) process.exitCode = 1;
