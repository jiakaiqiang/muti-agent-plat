import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AgentDefinition as Agent, SessionDetail, TaskBrief } from '@agent-cluster/shared';
import { requirementConfirmationFingerprint } from '@agent-cluster/shared';
import { PersistenceService } from '../persistence/persistence.service.js';
import { RequirementDocumentStore } from '../sessions/requirement-document-store.js';
import { DiscussionStore } from './discussion-store.js';
import { agent, makeService, session, type ServiceRecorder } from './orchestrator.test-fixtures.js';

// Phase 4 T1-3: the coordinator publishes a versioned requirement document
// built from the brief, the confirmed decisions and the discussion synthesis,
// and the confirmation card carries the exact version it asks the user to
// approve. Gated by REQUIREMENT_DOCUMENT_ENABLED.

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'requirement-document-'));
  const persistence = new PersistenceService({ enabled: true, backend: 'file', filePath: join(directory, 'state.json') });
  await persistence.initialize();
  await persistence.setCollection('sessions', [{ id: 'session-1', decisionLedgerRevision: 2 }]);
  await persistence.setCollection('workItemsBySession', { 'session-1': [{ id: 'wi-1', revision: 3 }] });
  const previous = process.env.REQUIREMENT_DOCUMENT_ENABLED;
  process.env.REQUIREMENT_DOCUMENT_ENABLED = 'true';
  const decisions = [
    { id: 'd-confirmed', sessionId: 'session-1', workItemId: 'wi-1', status: 'confirmed', kind: 'constraint', content: '只支持 Excel' },
    { id: 'd-old', sessionId: 'session-1', workItemId: 'wi-1', status: 'superseded', kind: 'constraint', content: '支持 CSV' },
    { id: 'd-other', sessionId: 'session-1', workItemId: 'wi-other', status: 'confirmed', kind: 'constraint', content: '无关需求' }
  ];
  return {
    persistence,
    contextManagement: {
      getWorkItem(_sessionId: string, workItemId: string) {
        return workItemId === 'wi-1' ? { id: 'wi-1', revision: 3 } : undefined;
      },
      listDecisions() {
        return decisions;
      }
    },
    session: (): SessionDetail => ({ ...session(), activeWorkItemId: 'wi-1' }),
    async cleanup() {
      if (previous === undefined) delete process.env.REQUIREMENT_DOCUMENT_ENABLED;
      else process.env.REQUIREMENT_DOCUMENT_ENABLED = previous;
      await persistence.onModuleDestroy();
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

function brief(overrides: Partial<TaskBrief> = {}): TaskBrief {
  return {
    id: 'brief-1',
    sessionId: 'session-1',
    workItemId: 'wi-1',
    version: 1,
    goal: '实现导出功能。',
    scope: ['导出 Excel'],
    outOfScope: ['导出 PDF'],
    constraints: ['只支持 Excel'],
    acceptanceCriteria: ['文件可打开'],
    risks: ['大文件超时'],
    openQuestions: ['保留期？'],
    confirmedByUser: false,
    createdAt: '2026-09-19T00:00:00.000Z',
    ...overrides
  };
}

type DocumentService = {
  publishRequirementDocument(session: SessionDetail, coordinator: Agent, brief: TaskBrief): Promise<
    { documentId: string; documentRevision: number; contentHash: string; workItemRevision: number; businessFingerprint: string } | undefined
  >;
};

test('the published document references brief, current decisions and the latest synthesis', async () => {
  const context = await fixture();
  try {
    // A prior discussion round left a synthesis citing one delegation.
    const discussions = new DiscussionStore(context.persistence, () => '2026-09-19T00:00:00.000Z');
    const opened = await discussions.open({
      sessionId: 'session-1', workItemId: 'wi-1', requirementRevision: 3, generation: 0,
      coordinatorAgentId: 'coordinator', objective: 'x', exitCondition: 'y', roundLimit: 3, budgetTokens: 1
    });
    if (opened.status !== 'opened') return;
    const reserved = await discussions.reserveDelegation(opened.run.id, {
      targetAgentId: 'backend', origin: 'coordinator', objective: 'a', expectedResult: 'b', budgetTokens: 1, requirementRevision: 3
    });
    if (reserved.status !== 'reserved') return;
    await discussions.transitionRun(opened.run.id, { status: 'consulting' });
    await discussions.transitionDelegation(opened.run.id, reserved.delegation.id, { status: 'running' });
    await discussions.transitionDelegation(opened.run.id, reserved.delegation.id, {
      status: 'completed', result: { conclusion: 'ok', evidenceRefs: [], risks: [], openQuestions: ['分页大小？'], suggestedActions: [] }
    });
    await discussions.transitionRun(opened.run.id, { status: 'synthesizing' });
    await discussions.recordSynthesis(opened.run.id, {
      summary: '【backend】ok', conflicts: [], unresolved: ['分页大小？'], sourceDelegationIds: [reserved.delegation.id], outcome: 'needs_user'
    });

    const recorder: ServiceRecorder = { events: [], taskUpdates: [], runtimeCalls: 0 };
    const service = makeService([], recorder, undefined, undefined, undefined, context) as unknown as DocumentService;

    const binding = await service.publishRequirementDocument(context.session(), agent('coordinator'), brief());

    assert.ok(binding, 'a document is published');
    assert.equal(binding!.documentRevision, 1);
    assert.equal(binding!.workItemRevision, 3);
    const stored = new RequirementDocumentStore(context.persistence).get('session-1', binding!.documentId)!;
    assert.equal(stored.sourceBriefId, 'brief-1');
    assert.deepEqual(stored.sourceDecisionIds, ['d-confirmed'], 'only confirmed decisions of this requirement');
    assert.deepEqual(stored.sourceDelegationIds, [reserved.delegation.id], 'the synthesis names what was read');
    assert.equal(stored.sections.goal, '实现导出功能。');
    assert.deepEqual(stored.sections.pendingItems, ['保留期？', '分页大小？'], 'open questions from brief and discussion are the pending items');
    assert.equal(stored.contentHash, binding!.contentHash);
    assert.equal(
      binding!.businessFingerprint,
      requirementConfirmationFingerprint({ workItemRevision: 3, documentRevision: 1, contentHash: stored.contentHash, decisionLedgerRevision: 0 }),
      'the card fingerprint is what confirmation recomputes from the same session state'
    );

    const published = recorder.events.find((event) => event.metadata.payload?.documentId === binding!.documentId);
    assert.ok(published, 'publication is announced with the version and hash');
    assert.equal(published!.metadata.payload?.contentHash, binding!.contentHash);
  } finally {
    await context.cleanup();
  }
});

test('republishing the same brief is the same version', async () => {
  const context = await fixture();
  try {
    const recorder: ServiceRecorder = { events: [], taskUpdates: [], runtimeCalls: 0 };
    const service = makeService([], recorder, undefined, undefined, undefined, context) as unknown as DocumentService;
    const first = await service.publishRequirementDocument(context.session(), agent('coordinator'), brief());
    const second = await service.publishRequirementDocument(context.session(), agent('coordinator'), brief());
    assert.deepEqual(second, first);
    assert.equal(new RequirementDocumentStore(context.persistence).list('session-1', 'wi-1').length, 1);
  } finally {
    await context.cleanup();
  }
});

test('with the flag off nothing is published and the caller gets no binding', async () => {
  const context = await fixture();
  try {
    delete process.env.REQUIREMENT_DOCUMENT_ENABLED;
    const recorder: ServiceRecorder = { events: [], taskUpdates: [], runtimeCalls: 0 };
    const service = makeService([], recorder, undefined, undefined, undefined, context) as unknown as DocumentService;
    const binding = await service.publishRequirementDocument(context.session(), agent('coordinator'), brief());
    assert.equal(binding, undefined);
    assert.equal(new RequirementDocumentStore(context.persistence).list('session-1').length, 0);
  } finally {
    await context.cleanup();
  }
});
