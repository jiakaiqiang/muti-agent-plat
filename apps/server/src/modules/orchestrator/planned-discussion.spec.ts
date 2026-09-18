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
