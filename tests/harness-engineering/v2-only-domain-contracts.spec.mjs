import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..', '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');

test('shared contracts export AgentDefinition directly without an Agent alias', () => {
  assert.doesNotMatch(read('packages/shared/src/contracts.ts'), /export type Agent\s*=\s*AgentDefinition/);
});

test('AgentTask contract contains ActorRef fields only', () => {
  const source = read('packages/shared/src/contracts.ts');
  const block = source.slice(source.indexOf('export type AgentTask ='), source.indexOf('export type AgentMessageOutput'));
  assert.match(block, /assignedBy\?: ActorRef/);
  assert.match(block, /assignee\?: ActorRef/);
  assert.doesNotMatch(block, /assignedByAgentId|assigneeAgentId|双写|旧字段/);
});

test('TasksService does not read, write, or backfill legacy Agent id fields', () => {
  assert.doesNotMatch(read('apps/server/src/modules/tasks/tasks.service.ts'), /assignedByAgentId|assigneeAgentId|backfill/i);
});

test('SessionsService emits task actors without legacy Agent id payload fields', () => {
  assert.doesNotMatch(read('apps/server/src/modules/sessions/sessions.service.ts'), /assignedByAgentId|assigneeAgentId/);
});

test('Orchestrator routes tasks through ActorRef without legacy Agent id fields', () => {
  assert.doesNotMatch(read('apps/server/src/modules/orchestrator/orchestrator.service.ts'), /assignedByAgentId|assigneeAgentId/);
});

test('Agent service has no Skill bind or unbind compatibility methods', () => {
  assert.doesNotMatch(read('apps/server/src/modules/agents/agents.service.ts'), /bindSkill|unbindSkill|removeSkillReference/);
});

test('Skill HTTP controllers expose resource CRUD only', () => {
  const controllers = read('apps/server/src/modules/skills/skills.controller.ts');
  assert.doesNotMatch(controllers, /bind|unbind|agents\/:agentId/i);
});

test('SkillsService does not implement Agent binding helpers', () => {
  assert.doesNotMatch(read('apps/server/src/modules/skills/skills.service.ts'), /bindToAgent|unbindFromAgent|resolve\(skillIds|systemRules\(skillIds/);
});

test('Web actor helpers never fall back to legacy Agent id fields', () => {
  assert.doesNotMatch(read('apps/web/src/composables/useActor.ts'), /legacy|fromAgentId|assignedByAgentId|assigneeAgentId/);
});

test('Web task contracts and active views consume ActorRef only', () => {
  const sources = [
    read('apps/web/src/types/contracts.ts'),
    read('apps/web/src/stores/event.ts'),
    read('apps/web/src/components/ChatTimeline.vue'),
    read('apps/web/src/components/CollaborationTaskBoard.vue'),
    read('apps/web/src/components/CollaborationGraphView.vue'),
    read('apps/web/src/components/WorkflowRuntimeView.vue')
  ].join('\n');
  assert.doesNotMatch(sources, /assignedByAgentId|assigneeAgentId/);
});
