import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AgentDefinition as Agent, AgentRunResult, ContextAssembly, RuntimeOutput, SessionDetail } from '@agent-cluster/shared';
import { createAgentMessageOutput, createRuntimeArtifactSystemEvidence } from '@agent-cluster/shared';
import { PersistenceService } from '../persistence/persistence.service.js';
import { DiscussionStore } from './discussion-store.js';
import { agent, makeService, session, type ServiceRecorder } from './orchestrator.test-fixtures.js';

// Phase 3 T2-3: the coordinator plans the round; only the named experts run.
// Gated by MAIN_AGENT_DISCUSSION_ENABLED so every other spec keeps the legacy
// loop.

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'planned-discussion-'));
  const persistence = new PersistenceService({ enabled: true, backend: 'file', filePath: join(directory, 'state.json') });
  await persistence.initialize();
  await persistence.setCollection('sessions', [{ id: 'session-1', decisionLedgerRevision: 0 }]);
  await persistence.setCollection('workItemsBySession', { 'session-1': [{ id: 'wi-1', revision: 1 }] });
  const previous = process.env.MAIN_AGENT_DISCUSSION_ENABLED;
  process.env.MAIN_AGENT_DISCUSSION_ENABLED = 'true';
  return {
    persistence,
    contextManagement: {
      getWorkItem(_sessionId: string, workItemId: string) {
        return workItemId === 'wi-1' ? { id: 'wi-1', revision: 1 } : undefined;
      }
    },
    session: (): SessionDetail => ({ ...session(), activeWorkItemId: 'wi-1' }),
    async cleanup() {
      if (previous === undefined) delete process.env.MAIN_AGENT_DISCUSSION_ENABLED;
      else process.env.MAIN_AGENT_DISCUSSION_ENABLED = previous;
      await persistence.onModuleDestroy();
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

function discussionPlan(consultations: Array<{ targetAgentKey: string }>): RuntimeOutput {
  return {
    schemaVersion: '1.0',
    kind: 'discussion_plan',
    objective: 'Decide the backend fix.',
    gaps: ['root cause unconfirmed'],
    exitCondition: 'root cause has a conclusion',
    consultations: consultations.map((item) => ({
      targetAgentKey: item.targetAgentKey,
      objective: `Assess from the ${item.targetAgentKey} angle.`,
      expectedResult: 'Conclusion and risks.'
    })),
    questionsForUser: [],
    readyToSummarize: false
  } as RuntimeOutput;
}

function completedRun(invocationId: string, output: RuntimeOutput): AgentRunResult {
  return {
    invocationId,
    runtimeType: 'generic_llm',
    status: 'completed',
    output,
    events: [],
    artifacts: [],
    systemEvidence: createRuntimeArtifactSystemEvidence(invocationId),
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, model: 'test' }
  };
}

type PlannedService = {
  runDiscussion(session: SessionDetail, coordinator: Agent): Promise<void>;
  createContextAssembly(): ContextAssembly;
  runRuntime(session: SessionDetail, input: { agent: Agent; expectedOutput: { kind: string } }): Promise<AgentRunResult>;
  runDiscussionRuntime(session: SessionDetail, agent: Agent, invocationId: string): Promise<AgentRunResult>;
};

test('planned discussion consults only the experts the coordinator named and persists the run', async () => {
  const context = await fixture();
  try {
    const recorder: ServiceRecorder = { events: [], taskUpdates: [], runtimeCalls: 0 };
    const service = makeService([], recorder, undefined, undefined, undefined, context) as unknown as PlannedService;
    service.createContextAssembly = () => ({ budget: {}, systemRules: [] } as unknown as ContextAssembly);
    // One participant (backend), one catalogued non-participant (architect),
    // one nobody. AC1 and AC3 in a single plan.
    service.runRuntime = async (_session, input) =>
      completedRun(
        'plan-1',
        input.expectedOutput.kind === 'discussion_plan'
          ? discussionPlan([{ targetAgentKey: 'backend' }, { targetAgentKey: 'architect' }, { targetAgentKey: 'ghost' }])
          : createAgentMessageOutput({ messageKind: 'answer', content: 'unexpected' })
      );
    const consulted: string[] = [];
    service.runDiscussionRuntime = async (_session, expert, invocationId) => {
      consulted.push(expert.key);
      return completedRun(invocationId, createAgentMessageOutput({ messageKind: 'answer', content: `${expert.key} conclusion` }));
    };

    await service.runDiscussion(context.session(), agent('coordinator'));

    assert.deepEqual(consulted, ['backend'], 'test is a participant but was not named, so it is not consulted');

    const confirmation = recorder.events.find((event) => event.type === 'user_confirmation_requested');
    assert.equal(confirmation?.metadata.payload?.reason, 'confirm_member_addition');
    assert.match(String(confirmation?.metadata.payload?.description ?? ''), /architect/);

    const runs = new DiscussionStore(context.persistence).list('session-1');
    assert.equal(runs.length, 1);
    const run = runs[0]!;
    assert.equal(run.status, 'synthesizing', 'after the round the run waits for synthesis, not a restart');
    assert.equal(run.roundsStarted, 1);
    assert.equal(run.delegations.length, 1);
    assert.equal(run.delegations[0]?.targetAgentId, 'backend');
    assert.equal(run.delegations[0]?.status, 'completed');
    assert.equal(run.delegations[0]?.result?.conclusion, 'backend conclusion');
  } finally {
    await context.cleanup();
  }
});

test('an expert failure marks only its delegation failed and the round still completes', async () => {
  const context = await fixture();
  try {
    const recorder: ServiceRecorder = { events: [], taskUpdates: [], runtimeCalls: 0 };
    const service = makeService([], recorder, undefined, undefined, undefined, context) as unknown as PlannedService;
    service.createContextAssembly = () => ({ budget: {}, systemRules: [] } as unknown as ContextAssembly);
    service.runRuntime = async () => completedRun('plan-1', discussionPlan([{ targetAgentKey: 'backend' }, { targetAgentKey: 'test' }]));
    service.runDiscussionRuntime = async (_session, expert, invocationId) =>
      expert.key === 'backend'
        ? {
            ...completedRun(invocationId, createAgentMessageOutput({ messageKind: 'risk', content: 'down' })),
            status: 'failed',
            error: { code: 'RUNTIME_INVOCATION_ERROR', message: 'provider down', retryable: true }
          }
        : completedRun(invocationId, createAgentMessageOutput({ messageKind: 'answer', content: 'test conclusion' }));

    // The legacy loop throws here and aborts the whole discussion (AC6).
    await service.runDiscussion(context.session(), agent('coordinator'));

    const run = new DiscussionStore(context.persistence).list('session-1')[0];
    const byAgent = Object.fromEntries((run?.delegations ?? []).map((item) => [item.targetAgentId, item]));
    assert.equal(byAgent.backend?.status, 'failed');
    assert.equal(byAgent.backend?.failure?.code, 'RUNTIME_INVOCATION_ERROR');
    assert.equal(byAgent.test?.status, 'completed');
    assert.equal(run?.status, 'synthesizing');
  } finally {
    await context.cleanup();
  }
});

test('with the flag off the legacy loop is untouched', async () => {
  const recorder: ServiceRecorder = { events: [], taskUpdates: [], runtimeCalls: 0 };
  const service = makeService([], recorder) as unknown as PlannedService;
  service.createContextAssembly = () => ({ budget: {} } as ContextAssembly);
  const consulted: string[] = [];
  service.runDiscussionRuntime = async (_session, expert, invocationId) => {
    consulted.push(expert.key);
    return completedRun(invocationId, createAgentMessageOutput({ messageKind: 'answer', content: 'ok' }));
  };

  await service.runDiscussion(session(), agent('coordinator'));

  // Legacy behaviour: every participant except the coordinator answers.
  assert.deepEqual([...consulted].sort(), ['backend', 'test']);
});

test('a restart resumes the unfinished delegations without re-planning or re-consulting finished ones', async () => {
  const context = await fixture();
  try {
    // Seed what a crash mid-round leaves behind: one delegation done, one still
    // reserved, the run in `consulting`.
    const seed = new DiscussionStore(context.persistence, () => '2026-09-19T00:00:00.000Z');
    const opened = await seed.open({
      sessionId: 'session-1', workItemId: 'wi-1', requirementRevision: 1, generation: 0,
      coordinatorAgentId: 'coordinator', objective: 'seeded', exitCondition: 'seeded', roundLimit: 3, budgetTokens: 8_000
    });
    assert.equal(opened.status, 'opened');
    if (opened.status !== 'opened') return;
    const done = await seed.reserveDelegation(opened.run.id, {
      targetAgentId: 'backend', origin: 'coordinator', objective: 'a', expectedResult: 'b', budgetTokens: 4_000, requirementRevision: 1
    });
    const pending = await seed.reserveDelegation(opened.run.id, {
      targetAgentId: 'test', origin: 'coordinator', objective: 'c', expectedResult: 'd', budgetTokens: 4_000, requirementRevision: 1
    });
    if (done.status !== 'reserved' || pending.status !== 'reserved') return;
    await seed.transitionRun(opened.run.id, { status: 'consulting' });
    await seed.transitionDelegation(opened.run.id, done.delegation.id, { status: 'running', invocationId: 'inv-old' });
    await seed.transitionDelegation(opened.run.id, done.delegation.id, {
      status: 'completed', result: { conclusion: 'already answered', evidenceRefs: [], risks: [], openQuestions: [], suggestedActions: [] }
    });

    const recorder: ServiceRecorder = { events: [], taskUpdates: [], runtimeCalls: 0 };
    const service = makeService([], recorder, undefined, undefined, undefined, context) as unknown as PlannedService;
    service.createContextAssembly = () => ({ budget: {}, systemRules: [] } as unknown as ContextAssembly);
    let planCalls = 0;
    service.runRuntime = async (_session, input) => {
      if (input.expectedOutput.kind === 'discussion_plan') planCalls += 1;
      return completedRun('plan-again', discussionPlan([{ targetAgentKey: 'backend' }, { targetAgentKey: 'test' }]));
    };
    const consulted: string[] = [];
    service.runDiscussionRuntime = async (_session, expert, invocationId) => {
      consulted.push(expert.key);
      return completedRun(invocationId, createAgentMessageOutput({ messageKind: 'answer', content: `${expert.key} conclusion` }));
    };

    await service.runDiscussion(context.session(), agent('coordinator'));

    assert.equal(planCalls, 0, 'the persisted plan is the truth; the coordinator is not asked again');
    assert.deepEqual(consulted, ['test'], 'only the unfinished delegation runs');

    const runs = new DiscussionStore(context.persistence).list('session-1');
    assert.equal(runs.length, 1, 'no second run was opened');
    const byAgent = Object.fromEntries(runs[0]!.delegations.map((item) => [item.targetAgentId, item]));
    assert.equal(byAgent.backend?.result?.conclusion, 'already answered', 'the finished result is untouched');
    assert.equal(byAgent.test?.status, 'completed');
    assert.equal(runs[0]!.status, 'synthesizing');
    assert.equal(runs[0]!.roundsStarted, 1, 'resuming a round does not count as a new round');
  } finally {
    await context.cleanup();
  }
});

test('a stop mid-round pauses the run and leaves the interrupted delegation resumable', async () => {
  const context = await fixture();
  try {
    const recorder: ServiceRecorder = { events: [], taskUpdates: [], runtimeCalls: 0 };
    const service = makeService([], recorder, undefined, undefined, undefined, context) as unknown as PlannedService & {
      runDiscussion(session: SessionDetail, coordinator: Agent, signal?: AbortSignal): Promise<void>;
    };
    service.createContextAssembly = () => ({ budget: {}, systemRules: [] } as unknown as ContextAssembly);
    service.runRuntime = async () => completedRun('plan-1', discussionPlan([{ targetAgentKey: 'backend' }]));
    const controller = new AbortController();
    service.runDiscussionRuntime = async () => {
      // The user stops while the expert is running.
      controller.abort();
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    };

    await assert.rejects(() => service.runDiscussion(context.session(), agent('coordinator'), controller.signal));

    const run = new DiscussionStore(context.persistence).list('session-1')[0];
    assert.equal(run?.status, 'paused');
    assert.equal(run?.delegations[0]?.status, 'running', 'the reservation stands so a resume can pick it up');
    const runnable = new DiscussionStore(context.persistence).runnableDelegations('session-1', run!.id, { generation: 0 });
    assert.equal(runnable.length, 1);
  } finally {
    await context.cleanup();
  }
});
