import test from 'node:test';
import assert from 'node:assert/strict';
import { SkillsService } from './skills.service.js';
import { SkillsController } from './skills.controller.js';

function setup() {
  const collections = new Map<string, unknown>();
  const persistence = {
    getCollection: (_key: string, fallback: unknown) => fallback,
    setCollection: (key: string, value: unknown) => collections.set(key, value)
  };
  const agents = {
    list: () => []
  };
  const service = new SkillsService(persistence as never, agents as never);
  return { service, collections };
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

test('Skills controller exposes resource CRUD', () => {
  const { service } = setup();
  const controller = new SkillsController(service);
  const response = controller.create({ name: 'Controller Skill', content: 'content' });
  const skillId = (response as { data: { id: string } }).data.id;
  assert.equal((controller.detail(skillId) as { data: { id: string } }).data.id, skillId);
});

test('SkillsService prevents deletion of referenced skills', () => {
  const collections = new Map<string, unknown>();
  const persistence = {
    getCollection: (_key: string, fallback: unknown) => fallback,
    setCollection: (key: string, value: unknown) => collections.set(key, value)
  };
  const agents = {
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
