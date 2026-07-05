import test from 'node:test';
import assert from 'node:assert/strict';
import type { Agent, SessionDetail, TaskBriefOutput } from '@agent-cluster/shared';
import { OrchestratorService } from './orchestrator.service.js';

function agent(key: string): Agent {
  return {
    id: key,
    key,
    name: `${key} agent`,
    role: key,
    runtimeType: 'mock',
    status: 'active',
    capabilityIds: [],
    defaultKnowledgeBaseIds: [],
    createdAt: '2026-07-03T00:00:00.000Z',
    updatedAt: '2026-07-03T00:00:00.000Z'
  };
}

function makeService() {
  const agents = new Map(['coordinator', 'backend', 'test', 'review'].map((key) => [key, agent(key)]));
  return new OrchestratorService(
    {
      findByIdOrKey(key: string) {
        return agents.get(key);
      }
    } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {
      getCollection() {
        return {};
      }
    } as never,
    {} as never,
    {} as never,
    {} as never
  );
}

function session(): SessionDetail {
  return {
    id: 'session-1',
    title: 'Fix malformed suggested tasks',
    originalInput: 'Fix a backend bug',
    status: 'AGENT_DISCUSSING',
    ownerId: 'user-1',
    workspaceId: 'workspace-1',
    tokenUsed: 0,
    taskDomain: 'coding',
    taskIntent: 'implementation',
    participatingAgentIds: ['coordinator', 'backend', 'test'],
    createdAt: '2026-07-03T00:00:00.000Z',
    updatedAt: '2026-07-03T00:00:00.000Z'
  };
}

test('normalizes malformed runtime suggested tasks before selection', () => {
  const service = makeService() as unknown as {
    normalizeTaskBriefOutput(output: TaskBriefOutput): TaskBriefOutput;
    selectSuggestedTasks(session: SessionDetail, runtimeSuggestedTasks: TaskBriefOutput['suggestedTasks']): TaskBriefOutput['suggestedTasks'];
  };
  const output = service.normalizeTaskBriefOutput({
    kind: 'task_brief',
    goal: 'Fix the orchestration crash',
    scope: [],
    outOfScope: [],
    constraints: [],
    acceptanceCriteria: [],
    risks: [],
    openQuestions: [],
    suggestedTasks: [
      {
        title: 'Implement crash fix',
        suggestedAgentKey: 'backend'
      },
      {
        title: 'Validate fix',
        description: undefined,
        suggestedAgentKey: 'test',
        acceptanceCriteria: undefined
      },
      null
    ]
  } as unknown as TaskBriefOutput);

  assert.equal(output.suggestedTasks.length, 2);
  assert.equal(output.suggestedTasks[0].description, 'Implement crash fix');
  assert.deepEqual(output.suggestedTasks[1].acceptanceCriteria, []);
  assert.doesNotThrow(() => service.selectSuggestedTasks(session(), output.suggestedTasks));
});
