import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONTEXT_PIPELINE_VERSION, type SessionDetail } from '@agent-cluster/shared';
import { SessionsService } from './sessions.service.js';

function makeService() {
  const persistedSessions: SessionDetail[] = [];
  const events: Array<Record<string, unknown>> = [];
  const executionStarts: Array<{ sessionId: string; taskCount: number }> = [];
  const executionCancels: string[] = [];
  const service = new SessionsService(
    {
      resolveIds(agentIds?: string[]) {
        return agentIds ?? ['coordinator'];
      },
      findByIdOrKey(id: string) {
        return {
          id,
          key: id,
          name: id,
          role: id,
          status: 'active',
          capabilityIds: [],
          defaultKnowledgeBaseIds: [],
          createdAt: '2026-07-11T00:00:00.000Z',
          updatedAt: '2026-07-11T00:00:00.000Z'
        };
      },
      list() {
        return [];
      }
    } as never,
    {
      create(input: Record<string, unknown>) {
        const event = {
          id: `event-${events.length + 1}`,
          createdAt: '2026-07-11T00:00:00.000Z',
          ...input
        };
        events.push(event);
        return event;
      },
      list() {
        return events;
      }
    } as never,
    {} as never,
    {
      recognizeTask() {
        return { domain: 'coding', intent: 'implementation', requiresCodeChanges: true };
      },
      recognizeUserMessage() {
        return {
          intent: 'command',
          priority: 'normal',
          shouldPause: false,
          affectedTaskIds: [],
          affectedAgentIds: [],
          requiresBriefRevision: false,
          requiresUserConfirmation: false,
          coordinatorInstruction: 'ok'
        };
      }
    } as never,
    {
      discussAndCreateBrief() {
        return new Promise(() => undefined);
      },
      getBrief(sessionId: string, briefId: string) {
        return {
          id: briefId,
          sessionId,
          version: 1,
          goal: 'Review with explicit user action routing.',
          scope: [],
          outOfScope: [],
          constraints: [],
          acceptanceCriteria: [],
          risks: [],
          openQuestions: [],
          confirmedByUser: true,
          createdAt: '2026-07-11T00:00:00.000Z'
        };
      },
      deleteSession() {}
    } as never,
    {
      start(session: SessionDetail, _brief: unknown, tasks: unknown[]) {
        executionStarts.push({ sessionId: session.id, taskCount: tasks.length });
      },
      cancel(sessionId: string) {
        executionCancels.push(sessionId);
      }
    } as never,
    {
      resetStaleRunning() {},
      unfinished() {
        return [];
      },
      cancelUnfinished() {
        return undefined;
      }
    } as never,
    {
      getCollection() {
        return persistedSessions;
      },
      setCollection(_key: string, value: SessionDetail[]) {
        persistedSessions.splice(0, persistedSessions.length, ...value);
      }
    } as never
  );
  return { service, persistedSessions, events, executionStarts, executionCancels };
}

function withContextPipelineV2Flag(value: string | undefined, fn: () => Promise<void> | void) {
  const previous = process.env.CONTEXT_PIPELINE_V2_ENABLED;
  if (value === undefined) delete process.env.CONTEXT_PIPELINE_V2_ENABLED;
  else process.env.CONTEXT_PIPELINE_V2_ENABLED = value;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (previous === undefined) delete process.env.CONTEXT_PIPELINE_V2_ENABLED;
      else process.env.CONTEXT_PIPELINE_V2_ENABLED = previous;
    });
}

test('new SessionDetail records the default Context Pipeline version', async () => {
  await withContextPipelineV2Flag(undefined, async () => {
    const { service, persistedSessions } = makeService();
    const { session } = await service.create({ input: 'Implement context pipeline version' });

    assert.equal(session.contextPipelineVersion, DEFAULT_CONTEXT_PIPELINE_VERSION);
    assert.equal(session.requiresCodeChanges, true);
    assert.equal(persistedSessions[0]?.contextPipelineVersion, DEFAULT_CONTEXT_PIPELINE_VERSION);
    assert.equal(persistedSessions[0]?.requiresCodeChanges, true);
  });
});

test('new SessionDetail records v2 when the Context Pipeline v2 flag is enabled', async () => {
  await withContextPipelineV2Flag('true', async () => {
    const { service, persistedSessions } = makeService();
    const { session } = await service.create({ input: 'Implement context pipeline v2' });

    assert.equal(session.contextPipelineVersion, 'v2');
    assert.equal(persistedSessions[0]?.contextPipelineVersion, 'v2');
  });
});

test('existing SessionDetail keeps its fixed Context Pipeline version after flag changes', async () => {
  await withContextPipelineV2Flag(undefined, async () => {
    const { service } = makeService();
    const { session } = await service.create({ input: 'Keep pipeline version stable' });
    assert.equal(session.contextPipelineVersion, 'v1');

    await withContextPipelineV2Flag('true', () => {
      assert.equal(service.get(session.id).contextPipelineVersion, 'v1');
    });
  });
});

test('ask_user confirmation payload preserves structured Post Review actions', async () => {
  const { service, events } = makeService();
  const { session } = await service.create({ input: 'Review an implementation with incomplete evidence' });
  const actions = [
    {
      action: 'request_workspace_context' as const,
      reason: 'Review needs the implementation source before it can verify completion.',
      missingPaths: ['src/feature.ts']
    },
    {
      action: 'deliver_with_limitations' as const,
      limitations: ['src/feature.ts was not reviewed.']
    },
    { action: 'save_progress' as const },
    { action: 'cancel' as const, reason: 'Stop without sufficient evidence.' }
  ];

  service.applyOutcome(session.id, {
    kind: 'ask_user',
    reason: 'Post Review needs more workspace evidence.',
    actions
  });

  const confirmation = events.find((event) => event.type === 'user_confirmation_requested');
  assert.ok(confirmation);
  const metadata = confirmation.metadata as { payload?: { actions?: unknown } };
  assert.deepEqual(metadata.payload?.actions, actions);
});

async function postReviewActionFixture(action: {
  action: 'request_workspace_context' | 'deliver_with_limitations' | 'save_progress' | 'cancel';
  reason?: string;
  missingPaths?: string[];
  limitations?: string[];
}) {
  const fixture = makeService();
  const { session } = await fixture.service.create({ input: 'Resolve a Post Review action' });
  session.currentTaskBriefId = 'brief-post-review-action';
  fixture.service.applyOutcome(session.id, {
    kind: 'ask_user',
    reason: 'Post Review requires a user decision.',
    actions: [action] as never
  });
  const confirmation = fixture.events.find((event) => event.type === 'user_confirmation_requested');
  const confirmationId = (confirmation?.metadata as { payload?: { confirmationId?: string } })?.payload?.confirmationId;
  assert.ok(confirmationId);
  return { ...fixture, session, confirmationId };
}

test('Post Review actions select distinct Session recovery flows', async () => {
  const context = await postReviewActionFixture({
    action: 'request_workspace_context',
    reason: 'Read missing source.',
    missingPaths: ['src/feature.ts']
  });
  context.service.resolvePostReviewAction(context.session.id, {
    confirmationId: context.confirmationId,
    action: 'request_workspace_context'
  });
  assert.equal(context.session.status, 'EXECUTING');
  assert.deepEqual(
    context.session.supplementalContextRequests?.at(-1)?.requestedContext.requestedPaths,
    ['src/feature.ts']
  );
  assert.equal(context.executionStarts.length, 1);

  const limited = await postReviewActionFixture({
    action: 'deliver_with_limitations',
    limitations: ['src/feature.ts was not reviewed.']
  });
  limited.service.resolvePostReviewAction(limited.session.id, {
    confirmationId: limited.confirmationId,
    action: 'deliver_with_limitations'
  });
  assert.equal(limited.session.status, 'EXECUTING');
  assert.equal(limited.executionStarts.length, 1);

  const saved = await postReviewActionFixture({ action: 'save_progress' });
  saved.service.resolvePostReviewAction(saved.session.id, {
    confirmationId: saved.confirmationId,
    action: 'save_progress'
  });
  assert.equal(saved.session.status, 'WAIT_USER_DECISION');
  assert.equal(saved.executionStarts.length, 0);
  assert.equal(saved.executionCancels.length, 0);

  const cancelled = await postReviewActionFixture({ action: 'cancel', reason: 'Stop.' });
  cancelled.service.resolvePostReviewAction(cancelled.session.id, {
    confirmationId: cancelled.confirmationId,
    action: 'cancel'
  });
  assert.equal(cancelled.session.status, 'CANCELLED');
  assert.deepEqual(cancelled.executionCancels, [cancelled.session.id]);
});
