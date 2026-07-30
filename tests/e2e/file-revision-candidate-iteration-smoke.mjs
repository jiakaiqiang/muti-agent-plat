import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  api,
  buildServer,
  createSessionAndWaitForBrief,
  startSmokeServer,
  stopSmokeServer
} from './smoke-server.mjs';

await buildServer();

const fixtureRoot = join(tmpdir(), `agent-cluster-file-revision-${process.pid}`);
const relativePath = 'docs/result.md';
const absolutePath = join(fixtureRoot, 'docs', 'result.md');
let server;

try {
  rmSync(fixtureRoot, { recursive: true, force: true });
  mkdirSync(join(fixtureRoot, 'docs'), { recursive: true });
  writeFileSync(absolutePath, 'W0\n', 'utf8');

  server = await startSmokeServer('file-revision-candidate-iteration-smoke', {
    DISCUSSION_MAX_ROUNDS: '0',
    GLOBAL_DEFAULT_RUNTIME_TYPE: 'mock'
  });
  const workingDirectory = {
    kind: 'server_local',
    id: 'client-placeholder',
    name: 'file-revision-candidate-iteration',
    path: fixtureRoot,
    selectedAt: new Date().toISOString()
  };
  const { sessionId } = await createSessionAndWaitForBrief(
    server.apiBase,
    'Process confirmed edits to docs/result.md.',
    {
      agentIds: ['coordinator', 'backend', 'architect'],
      workingDirectory,
      runtimePreference: { preferredRuntimeType: 'mock', allowedRuntimeTypes: ['mock'] }
    }
  );
  const agents = (await api(server.apiBase, '/agents')).data;
  const backend = agents.find((agent) => agent.key === 'backend');
  const architect = agents.find((agent) => agent.key === 'architect');
  if (!backend || !architect) throw new Error('Expected default backend and architect Agents.');

  const baseline = (await api(server.apiBase, `/sessions/${sessionId}/file-revisions/baselines`, {
    method: 'POST',
    body: JSON.stringify({ filePath: relativePath, source: 'user_selected' })
  })).data;
  writeFileSync(absolutePath, 'U1\n', 'utf8');

  const first = (await api(server.apiBase, `/sessions/${sessionId}/file-revisions`, {
    method: 'POST',
    body: JSON.stringify({
      baselineId: baseline.id,
      targetAgentIds: [backend.id, architect.id],
      instruction: 'Preserve the complete user draft.'
    })
  })).data;
  const firstReady = await waitForRevisionStatus(sessionId, first.id, 'awaiting_confirmation');
  const firstCandidate = (await api(
    server.apiBase,
    `/sessions/${sessionId}/file-revisions/${first.id}/candidate`
  )).data;
  assertEqual(firstCandidate.content, 'U1\n', 'first candidate');
  const emptyDraftResponse = await api(
    server.apiBase,
    `/sessions/${sessionId}/file-revisions/${first.id}/draft`
  );
  if (emptyDraftResponse.data !== null) {
    throw new Error(`Expected an HTTP 200 response with a null draft: ${JSON.stringify(emptyDraftResponse)}`);
  }
  assertEqual(readFileSync(absolutePath, 'utf8'), 'U1\n', 'Workspace before second round');

  const draft = (await api(server.apiBase, `/sessions/${sessionId}/file-revisions/${first.id}/draft`, {
    method: 'PUT',
    body: JSON.stringify({ expectedCandidateHash: firstCandidate.candidateHash, content: 'U2\n' })
  })).data;
  const second = (await api(server.apiBase, `/sessions/${sessionId}/file-revisions/${first.id}/reprocess`, {
    method: 'POST',
    body: JSON.stringify({
      draftHash: draft.contentHash,
      expectedCandidateHash: firstCandidate.candidateHash,
      expectedStateVersion: firstReady.chain.stateVersion,
      targetAgentIds: [backend.id, architect.id],
      instruction: 'Use the current user draft as authority.'
    })
  })).data;
  if (second.parentRevisionId !== first.id || second.iteration !== 2 || second.baseKind !== 'previous_candidate') {
    throw new Error(`Second revision is not linked to the first candidate: ${JSON.stringify(second)}`);
  }
  const secondReady = await waitForRevisionStatus(sessionId, second.id, 'awaiting_confirmation');
  const secondCandidate = (await api(
    server.apiBase,
    `/sessions/${sessionId}/file-revisions/${second.id}/candidate`
  )).data;
  assertEqual(secondCandidate.content, 'U2\n', 'second candidate');
  assertEqual(readFileSync(absolutePath, 'utf8'), 'U1\n', 'Workspace before explicit confirmation');

  const applied = (await api(server.apiBase, `/sessions/${sessionId}/file-revisions/${second.id}/decision`, {
    method: 'POST',
    body: JSON.stringify({
      confirmationId: secondReady.run.confirmationId,
      candidateHash: secondCandidate.candidateHash,
      expectedStateVersion: secondReady.chain.stateVersion,
      decision: 'apply_candidate'
    })
  })).data;
  if (!applied.applied || applied.run.status !== 'applied') {
    throw new Error(`Expected second candidate to be applied: ${JSON.stringify(applied)}`);
  }
  assertEqual(readFileSync(absolutePath, 'utf8'), 'U2\n', 'Workspace after explicit confirmation');

  const staleBaseline = (await api(server.apiBase, `/sessions/${sessionId}/file-revisions/baselines`, {
    method: 'POST',
    body: JSON.stringify({ filePath: relativePath, source: 'user_selected' })
  })).data;
  writeFileSync(absolutePath, 'U3\n', 'utf8');
  const staleRun = (await api(server.apiBase, `/sessions/${sessionId}/file-revisions`, {
    method: 'POST',
    body: JSON.stringify({ baselineId: staleBaseline.id, targetAgentIds: [backend.id] })
  })).data;
  const staleReady = await waitForRevisionStatus(sessionId, staleRun.id, 'awaiting_confirmation');
  const staleCandidate = (await api(
    server.apiBase,
    `/sessions/${sessionId}/file-revisions/${staleRun.id}/candidate`
  )).data;
  writeFileSync(absolutePath, 'external edit\n', 'utf8');
  const staleDecision = (await api(
    server.apiBase,
    `/sessions/${sessionId}/file-revisions/${staleRun.id}/decision`,
    {
      method: 'POST',
      body: JSON.stringify({
        confirmationId: staleReady.run.confirmationId,
        candidateHash: staleCandidate.candidateHash,
        expectedStateVersion: staleReady.chain.stateVersion,
        decision: 'apply_candidate'
      })
    }
  )).data;
  if (staleDecision.applied || staleDecision.run.status !== 'stale') {
    throw new Error(`Expected an explicit stale result: ${JSON.stringify(staleDecision)}`);
  }
  assertEqual(readFileSync(absolutePath, 'utf8'), 'external edit\n', 'Workspace after stale rejection');

  console.log('file revision candidate iteration smoke ok');
} finally {
  if (server) await stopSmokeServer(server);
  rmSync(fixtureRoot, { recursive: true, force: true });
}

async function waitForRevisionStatus(sessionId, revisionId, expectedStatus, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    const state = (await api(server.apiBase, `/sessions/${sessionId}/file-revisions`)).data;
    const run = state.runs.find((item) => item.id === revisionId);
    const chain = run ? state.chains.find((item) => item.id === run.chainId) : undefined;
    last = run;
    if (run?.status === expectedStatus && chain) return { run, chain };
    if (run?.status === 'failed') {
      throw new Error(`File revision failed: ${JSON.stringify(run)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for revision ${revisionId} status ${expectedStatus}: ${JSON.stringify(last)}`);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
