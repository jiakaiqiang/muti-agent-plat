import test from 'node:test';
import assert from 'node:assert/strict';
import { SkillsService } from './skills.service.js';
import { AgentSkillsController, SkillsController } from './skills.controller.js';

function setup() {
  const collections = new Map<string, unknown>();
  const persistence = {
    getCollection: (_key: string, fallback: unknown) => fallback,
    setCollection: (key: string, value: unknown) => collections.set(key, value)
  };
  const calls = { bind: [] as string[], unbind: [] as string[], removed: [] as string[] };
  const agents = {
    bindSkill: (agentId: string, skillId: string) => {
      calls.bind.push(`${agentId}:${skillId}`);
      return { id: agentId, skillIds: [skillId] };
    },
    unbindSkill: (agentId: string, skillId: string) => {
      calls.unbind.push(`${agentId}:${skillId}`);
      return { id: agentId, skillIds: [] };
    },
    removeSkillReferences: (skillId: string) => {
      calls.removed.push(skillId);
      return [{ id: 'agent-1' }];
    },
    list: () => []
  };
  const service = new SkillsService(persistence as never, agents as never);
  return { service, collections, calls };
}

test('SkillsService CRUD persists the skills JSONB collection', () => {
  const { service, collections } = setup();
  const created = service.create({ name: 'Review', content: 'Check contracts.', files: [{ path: 'refs/checklist.md', content: 'A' }] });
  assert.equal(service.get(created.id).name, 'Review');
  const updated = service.update(created.id, { content: 'Check contracts and tests.' });
  assert.match(updated.content, /tests/);
  assert.equal((collections.get('skills') as unknown[]).length, 1);
  const removed = service.remove(created.id);
  assert.equal(removed.removed, true);
  assert.equal(service.list().length, 0);
});

test('SkillsService validates file paths and duplicate names', () => {
  const { service } = setup();
  service.create({ name: 'Safe', content: 'safe' });
  assert.throws(() => service.create({ name: 'safe', content: 'duplicate' }), /already exists/);
  assert.throws(
    () => service.create({ name: 'Unsafe', content: 'unsafe', files: [{ path: '../secret.txt', content: 'x' }] }),
    /path is invalid/
  );
});

test('SkillsService renders bound skills in stable order and cleans dangling agent references', () => {
  const { service, calls } = setup();
  const zeta = service.create({ id: 'skill-z', name: 'Zeta', content: 'z' });
  const alpha = service.create({ id: 'skill-a', name: 'Alpha', content: 'a' });
  const rules = service.systemRules([zeta.id, alpha.id]);
  assert.match(rules[0], /^\[Skill:Alpha\]/);
  service.bind('agent-1', alpha.id);
  service.unbind('agent-1', alpha.id);
  service.remove(alpha.id);
  assert.deepEqual(calls.bind, ['agent-1:skill-a']);
  assert.deepEqual(calls.unbind, ['agent-1:skill-a']);
  assert.deepEqual(calls.removed, ['skill-a']);
});

test('Skills controllers expose CRUD and agent binding methods', () => {
  const { service } = setup();
  const controller = new SkillsController(service);
  const agentController = new AgentSkillsController(service);
  const response = controller.create({ name: 'Controller Skill', content: 'content' });
  const skillId = (response as { data: { id: string } }).data.id;
  assert.equal((controller.detail(skillId) as { data: { id: string } }).data.id, skillId);
  assert.equal((agentController.bind('agent-1', skillId) as { data: { skill: { id: string } } }).data.skill.id, skillId);
});

test('SkillsService prevents deletion of referenced skills', () => {
  const collections = new Map<string, unknown>();
  const persistence = {
    getCollection: (_key: string, fallback: unknown) => fallback,
    setCollection: (key: string, value: unknown) => collections.set(key, value)
  };
  const agents = {
    bindSkill: (agentId: string, skillId: string) => ({ id: agentId, skillIds: [skillId] }),
    unbindSkill: (agentId: string) => ({ id: agentId, skillIds: [] }),
    removeSkillReferences: () => [],
    list: () => [
      { id: 'agent-1', profileMarkdown: '${skill:test-skill}' }
    ]
  };
  const service = new SkillsService(persistence as never, agents as never);
  const skill = service.create({ id: 'skill-1', key: 'test-skill', name: 'Test', content: 'test' });

  assert.throws(
    () => service.remove(skill.id),
    /Cannot delete skill.*referenced by 1 agent/
  );
});
