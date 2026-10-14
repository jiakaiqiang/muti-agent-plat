import assert from 'node:assert/strict';
import test from 'node:test';
import type { ContextAssembly, RuntimeContextRequest, SessionDetail } from '@agent-cluster/shared';
import { createAgentMessageOutput } from '@agent-cluster/shared';
import { buildEnvelopeFromContextAssembly } from '../context-v2/build-envelope-from-context-assembly.js';
import { evaluateGroundedEvidenceGate } from '../context-v2/grounded-evidence-gate.js';
import { makeInvocationPlan } from '../runtimes/invocation-plan.fixture.js';
import { agent, makeService, session } from './orchestrator.test-fixtures.js';
import { collectSeenContextSignatures, trimToNovelContext } from './supplemental-context-dedupe.js';
import { ContextRouterService } from './context-router.service.js';

const revision = { id: 'revision-handoff', observedAt: '2026-10-11T00:00:00Z' };
const request = (path = 'src/main.ts', startLine?: number, endLine?: number): RuntimeContextRequest => ({
  reason: 'Need source evidence', requestedRefs: [], requestedFiles: [{ path, startLine, endLine }]
});

function harness() {
  const reads: string[] = [];
  const recorder = { events: [] as any[], taskUpdates: [], runtimeCalls: 0 };
  const provider = {
    capabilities: () => ({ read: true, write: false, command: false, test: false }),
    getRevision: async () => revision,
    readFile: async ({ path, startLine, endLine }: any) => {
      reads.push(path);
      await new Promise(resolve => setTimeout(resolve, 5));
      const content = `export const source = '${path}:${startLine ?? 'full'}';`;
      return { path, content, startLine, endLine, truncated: false, byteLength: content.length,
        encoding: 'utf-8', revision };
    }
  };
  const service = makeService([], recorder, undefined, { resolve: () => provider }) as any;
  const active: SessionDetail = { ...session(), taskIntent: 'analysis', requiresCodeChanges: false,
    originalInput: '分析一下当前项目中的架构以及每个功能点之间的关联关系',
    participatingAgentIds: ['coordinator', 'requirements', 'architect', 'test', 'review'],
    workspaceIndex: { workspaceId: 'workspace-1', revision, generation: 1, status: 'ready', complete: true,
      entries: ['src/main.ts', 'src/other.ts'].map(path => ({ path, kind: 'file', size: 100, generated: false, sensitive: false })),
      entrypoints: ['src/main.ts'], detectedStack: ['node'], indexedEntries: 2, truncated: false,
      updatedAt: revision.observedAt, coverage: { visitedEntries: 2, indexedEntries: 2,
        excludedGenerated: 0, sensitiveEntries: 0, skippedSymlinks: 0, failedEntries: 0 } }
  };
  service.memories = { list: () => [], search: () => [] };
  service.recordSupplementalContextRequest = (s: SessionDetail, _task: unknown, agentId: string,
    requestedContext: RuntimeContextRequest, resolution: any, phase: any) => {
    s.supplementalContextRequests ??= [];
    s.supplementalContextRequests.push({ id: String(s.supplementalContextRequests.length), agentId,
      requestedContext, resolution, phase, createdAt: revision.observedAt });
  };
  const assemblies: Array<{ role: string; count: number }> = [];
  service.createContextAssembly = (s: SessionDetail, a: any) => {
    const taskContext = { intent: 'analysis', requiresCodeChanges: false,
      evidenceSelection: { strategy: 'architecture_analysis' },
      evidenceRefs: [{ type: 'workspace_file', label: 'src/main.ts', ref: 'src/main.ts' }], taskMap: { items: [] } };
    const selectedEvidenceContents = service.createSelectedEvidenceContents(s, taskContext);
    assemblies.push({ role: a.id, count: selectedEvidenceContents.length });
    return { systemRules: [`Role: ${a.id}`], constraints: [], sessionGoal: s.originalInput, taskContext,
      selectedEvidenceContents, relevantEvents: [], artifacts: [], budget: { maxInputTokens: 32000 },
      summaryMemory: { confirmedFacts: [], completed: [], decisions: [], openQuestions: [], risks: [], nextSteps: [] }
    } as unknown as ContextAssembly;
  };
  const delivered: Array<{ role: string; contents: string[]; rules: string[] }> = [];
  service.runRuntimeProviderAttempts = async (s: SessionDetail, input: any) => {
    const envelope = buildEnvelopeFromContextAssembly({ session: s, phase: input.phase,
      contextAssembly: input.contextAssembly, identity: makeInvocationPlan().agent, toolCatalogHash: 'test' });
    const decision = evaluateGroundedEvidenceGate({ envelope, requiresEvidence: true });
    if (!decision.ok) return { status: 'failed', error: { code: 'CONTEXT_INSUFFICIENT',
      requestedContext: request(), details: { groundedEvidenceReason: decision.reason } } };
    delivered.push({ role: input.agent.id, contents: envelope.L3.files.map(file => file.content),
      rules: [...input.contextAssembly.systemRules] });
    return { status: 'completed', output: createAgentMessageOutput({ messageKind: 'discussion', content: 'Grounded analysis.' }) };
  };
  const draft = (s = active, role = 'architect') => ({ invocationId: `invocation-${role}`, sessionId: s.id,
    phase: 'discussion', agent: agent(role), contextAssembly: service.createContextAssembly(s, agent(role)),
    budget: { maxInputTokens: 32000 }, expectedOutput: { kind: 'agent_message', schemaVersion: '1.0' } });
  return { service, active, provider, reads, delivered, assemblies, recorder, draft };
}

test('cold first Agent hydrates evidence and all later discussion Agents receive it before invocation', async () => {
  const h = harness();
  await h.service.runDiscussion(h.active, agent('coordinator'));
  assert.deepEqual(h.delivered.map(item => item.role), ['requirements', 'architect', 'test', 'review']);
  assert.equal(h.assemblies[0]!.count, 0);
  assert.ok(h.assemblies.slice(1).every(item => item.count === 1));
  assert.deepEqual(h.reads, ['src/main.ts']);
  assert.ok(h.delivered.every(item => item.rules.includes(`Role: ${item.role}`)));
});

test('follow-up discussions assemble evidence lazily and preserve follow-up instructions', async () => {
  const h = harness();
  await h.service.runFollowUpDiscussion(h.active, agent('coordinator'), [agent('requirements'), agent('architect')], '重点分析调用关系');
  assert.equal(h.delivered.length, 2);
  assert.equal(h.assemblies[1]!.count, 1);
  assert.ok(h.delivered.every(item => item.rules.some(rule => rule.includes('explicitly supplied follow-up'))));
});

test('two preassembled concurrent Agents both recover; one file read and no session-wide suppression', async () => {
  const h = harness();
  const a = h.draft(h.active, 'requirements');
  const b = h.draft(h.active, 'architect');
  await Promise.all([h.service.runRuntime(h.active, a), h.service.runRuntime(h.active, b)]);
  assert.equal(h.delivered.length, 2);
  assert.deepEqual(h.reads, ['src/main.ts']);
  assert.ok(h.active.supplementalContextRequests?.some(item => item.resolution.cachedPaths?.includes('src/main.ts')));
});

test('history from another Agent does not suppress cache reuse for a stale assembly with no selected refs', async () => {
  const h = harness();
  await h.service.runRuntime(h.active, h.draft(h.active, 'requirements'));
  const stale = h.draft();
  stale.contextAssembly.taskContext.evidenceRefs = [];
  stale.contextAssembly.selectedEvidenceContents = [];
  await h.service.runRuntime(h.active, stale);
  assert.equal(h.delivered.length, 2);
  assert.deepEqual(h.reads, ['src/main.ts']);
});

test('concurrent different reads merge into the cache; result bodies survive later range replacement', async () => {
  const h = harness();
  const [first] = await Promise.all([
    h.service.hydrateSupplementalContext(h.active, request('src/main.ts', 1, 5)),
    h.service.hydrateSupplementalContext(h.active, request('src/other.ts')),
    h.service.hydrateSupplementalContext(h.active, request('src/main.ts', 20, 25))
  ]);
  assert.deepEqual(h.active.workspaceSnapshot?.files.map(file => file.path).sort(), ['src/main.ts', 'src/other.ts']);
  assert.equal(h.service.supplementalFiles.get(first)[0].startLine, 1);
  assert.equal(h.active.workspaceSnapshot?.files.find(file => file.path === 'src/main.ts')?.startLine, 20);
});

test('a range cache cannot satisfy a full-file request; full reads clear old range metadata', async () => {
  const h = harness();
  await h.service.hydrateSupplementalContext(h.active, request('src/main.ts', 10, 20));
  await h.service.hydrateSupplementalContext(h.active, request());
  assert.equal(h.reads.length, 2);
  assert.equal(h.active.workspaceSnapshot?.files[0]?.startLine, undefined);
  assert.match(h.active.workspaceSnapshot?.files[0]?.content ?? '', /full/);
});

test('truncated cached bodies are re-read and repeated no-progress requests still stop', async () => {
  const h = harness();
  await h.service.hydrateSupplementalContext(h.active, request());
  h.active.workspaceSnapshot!.files[0]!.truncated = true;
  await h.service.hydrateSupplementalContext(h.active, request());
  assert.equal(h.reads.length, 2);
  let calls = 0;
  h.service.runRuntimeProviderAttempts = async () => {
    calls++;
    return { status: 'failed', error: { code: 'CONTEXT_INSUFFICIENT', requestedContext: request() } };
  };
  await h.service.runRuntime(h.active, h.draft());
  assert.equal(calls, 2);
  assert.equal(h.recorder.events.at(-1)?.metadata.payload.reason, 'no_new_request');
});

test('read history distinguishes new ranges and byte limits of the same file', async () => {
  const h = harness();
  const requestedContext = request('src/main.ts', 1, 5);
  const resolution = await h.service.hydrateSupplementalContext(h.active, requestedContext);
  const seen = collectSeenContextSignatures([{ id: 'prior', agentId: 'architect', requestedContext, resolution,
    createdAt: revision.observedAt }], revision.id);
  assert.equal(trimToNovelContext(requestedContext, seen), undefined);
  assert.ok(trimToNovelContext(request('src/main.ts', 6, 10), seen));
  assert.ok(trimToNovelContext(request(), seen));
  assert.ok(trimToNovelContext({ ...request(), requestedFiles: [{ path: 'src/main.ts', maxBytes: 100000 }] }, seen));
});

test('different sessions read independently and role selection does not inject unrelated cached files', async () => {
  const h = harness();
  const other: SessionDetail = { ...h.active, id: 'other-session' };
  await Promise.all([h.service.hydrateSupplementalContext(h.active, request('src/other.ts')),
    h.service.hydrateSupplementalContext(other, request())]);
  assert.deepEqual(h.active.workspaceSnapshot?.files.map(file => file.path), ['src/other.ts']);
  await h.service.runRuntime(h.active, h.draft());
  assert.equal(h.delivered.length, 1);
  assert.ok(h.delivered[0]!.contents.every(content => !content.includes('src/other.ts')));
  assert.equal(h.reads.filter(path => path === 'src/main.ts').length, 2);
});

test('multiple ranges requested together survive compilation into the next invocation', async () => {
  const h = harness();
  const original = h.service.runRuntimeProviderAttempts;
  let attempts = 0;
  h.service.runRuntimeProviderAttempts = async (s: SessionDetail, input: any) => {
    if (attempts++ === 0) return { status: 'failed', error: { code: 'CONTEXT_INSUFFICIENT', requestedContext: {
      ...request(), requestedFiles: [{ path: 'src/main.ts', startLine: 1, endLine: 5 },
        { path: 'src/main.ts', startLine: 20, endLine: 25 }]
    } } };
    return original(s, input);
  };
  await h.service.runRuntime(h.active, h.draft());
  assert.equal(h.delivered[0]!.contents.length, 2);
  assert.ok(h.delivered[0]!.contents.some(content => content.includes(':1')));
  assert.ok(h.delivered[0]!.contents.some(content => content.includes(':20')));
});

test('WorkItem supplemental history does not promote another WorkItem refs', async () => {
  const h = harness();
  const resolution = await h.service.hydrateSupplementalContext(h.active, request());
  h.active.supplementalContextRequests = [{ id: 'prior', agentId: 'architect', workItemId: 'work-a',
    requestedContext: request(), resolution, createdAt: revision.observedAt }];
  const router = new ContextRouterService() as any;
  assert.equal(router.supplementalEvidenceRefs(h.active, undefined, 'work-b').length, 0);
  assert.equal(router.supplementalEvidenceRefs(h.active, undefined, 'work-a').length, 1);
});

test('an aborted queued read does not execute or publish cache; the queue remains usable', async () => {
  const h = harness();
  const controller = new AbortController();
  const first = h.service.hydrateSupplementalContext(h.active, request());
  const queued = h.service.hydrateSupplementalContext(h.active, request('src/other.ts'), { signal: controller.signal });
  controller.abort();
  await first;
  await assert.rejects(queued);
  assert.deepEqual(h.reads, ['src/main.ts']);
  await h.service.hydrateSupplementalContext(h.active, request('src/other.ts'));
  assert.equal(h.active.workspaceSnapshot?.files.length, 2);
});

test('deferred ranges of an already-read path are not incorrectly deduped', async () => {
  const h = harness();
  const requestedContext = { ...request(), requestedFiles: Array.from({ length: 9 }, (_, i) => ({
    path: 'src/main.ts', startLine: i * 10 + 1, endLine: i * 10 + 5
  })) };
  const resolution = await h.service.hydrateSupplementalContext(h.active, requestedContext);
  const seen = collectSeenContextSignatures([{ id: 'prior', agentId: 'architect', requestedContext, resolution,
    createdAt: revision.observedAt }], revision.id);
  const remaining = trimToNovelContext(requestedContext, seen);
  assert.equal(resolution.hydratedFiles.length, 8);
  assert.deepEqual(remaining?.requestedFiles, [requestedContext.requestedFiles[8]]);
});
