import test from 'node:test';
import assert from 'node:assert/strict';
import { SkillsService } from './skills.service.js';
import { SkillsController } from './skills.controller.js';
import type { SkillActor } from './skill-registry.js';

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
  const response = controller.create(
    { name: 'Controller Skill', content: 'content', scope: 'system' },
    'admin',
    undefined,
    'system_admin'
  );
  const skillId = (response as { data: { id: string } }).data.id;
  assert.equal((controller.detail(skillId) as { data: { id: string } }).data.id, skillId);
});

test('Skills controller does not grant system or group write access without an explicit role', () => {
  const { service } = setup();
  const controller = new SkillsController(service);

  assert.throws(
    () => controller.create({ name: 'Implicit Admin', content: 'content' }),
    /cannot modify system-scoped Skills/
  );
  assert.throws(
    () => controller.create({ name: 'Implicit Group Admin', content: 'content', scope: 'group', scopeId: 'group-1' }, 'user-1', 'group-1'),
    /cannot modify group-scoped Skills/
  );
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

test('SkillsService supports system, group and personal scopes with precedence', () => {
  const { service } = setup();
  const systemAdmin: SkillActor = { userId: 'admin', role: 'system_admin' };
  const groupAdmin: SkillActor = { userId: 'group-admin', role: 'group_admin', groupIds: ['group-1'], groupId: 'group-1' };
  const user: SkillActor = { userId: 'user-1', role: 'user', groupIds: ['group-1'], groupId: 'group-1' };

  service.create({ key: 'review', name: 'System Review', content: 'system' }, systemAdmin);
  service.create({ key: 'review', name: 'Group Review', content: 'group', scope: 'group', scopeId: 'group-1' }, groupAdmin);
  service.create({ key: 'review', name: 'Personal Review', content: 'personal', scope: 'personal' }, user);

  const available = service.listAvailable(user);
  assert.deepEqual(available.map((skill) => skill.name), ['Personal Review']);
  assert.equal(service.list().length, 3);
  assert.throws(
    () => service.create({ name: 'Forbidden', content: 'x' }, user),
    /cannot modify system-scoped Skills/
  );
});

test('SkillsService enforces category migration before deletion and preserves disabled history', () => {
  const { service } = setup();
  const admin: SkillActor = { userId: 'admin', role: 'system_admin' };
  const first = service.createCategory({ id: 'cat-a', name: 'A' }, admin);
  const second = service.createCategory({ id: 'cat-b', name: 'B' }, admin);
  const skill = service.create({ name: 'Categorized', content: 'x', categoryId: first.id }, admin);

  assert.throws(() => service.removeCategory(first.id, admin), /Migrate 1 Skill/);
  assert.equal(service.migrateCategory(first.id, second.id, admin).migrated, 1);
  assert.equal(service.removeCategory(first.id, admin).removed, true);

  const disabled = service.update(skill.id, { status: 'disabled' }, admin);
  assert.equal(disabled.status, 'disabled');
  assert.equal(service.listAvailable(admin).some((item) => item.id === skill.id), false);
  assert.equal(service.get(skill.id).status, 'disabled');
});

test('SkillsService promotes an owned personal Skill to a group without approval', () => {
  const { service } = setup();
  const user: SkillActor = { userId: 'user-1', role: 'user', groupIds: ['group-1'], groupId: 'group-1' };
  const personal = service.create({ key: 'promote', name: 'Promote Me', content: 'x', scope: 'personal' }, user);
  const promoted = service.promoteToGroup(personal.id, 'group-1', user);
  assert.equal(promoted.scope, 'group');
  assert.equal(promoted.scopeId, 'group-1');
  assert.equal(service.listAvailable(user).find((item) => item.key === 'promote')?.scope, 'group');
});
