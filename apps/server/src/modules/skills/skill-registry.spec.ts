import test from 'node:test';
import assert from 'node:assert/strict';
import type { Skill, SkillCategory } from '@agent-cluster/shared';
import { mergeAvailableSkills, type SkillActor } from './skill-registry.js';

const actor: SkillActor = { userId: 'user-1', role: 'user', groupId: 'group-1', groupIds: ['group-1'] };

function skill(overrides: Partial<Skill>): Skill {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    key: overrides.key ?? 'review',
    name: overrides.name ?? 'Review',
    content: overrides.content ?? 'review',
    files: [],
    status: overrides.status ?? 'active',
    revision: overrides.revision ?? 1,
    scope: overrides.scope ?? 'system',
    scopeId: overrides.scopeId ?? 'system',
    categoryId: overrides.categoryId ?? 'cat-general',
    createdAt: overrides.createdAt ?? '2026-09-22T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-09-22T00:00:00.000Z',
    ...overrides
  };
}

const categories: SkillCategory[] = [
  { id: 'cat-general', name: 'General', scope: 'system', scopeId: 'system', createdAt: '2026-09-22T00:00:00.000Z', updatedAt: '2026-09-22T00:00:00.000Z' },
  { id: 'cat-group', name: 'Group', scope: 'group', scopeId: 'group-1', createdAt: '2026-09-22T00:00:00.000Z', updatedAt: '2026-09-22T00:00:00.000Z' },
  { id: 'cat-personal', name: 'Personal', scope: 'personal', scopeId: 'user-1', createdAt: '2026-09-22T00:00:00.000Z', updatedAt: '2026-09-22T00:00:00.000Z' }
];

test('mergeAvailableSkills applies personal > group > system and removes disabled entries', () => {
  const available = mergeAvailableSkills([
    skill({ id: 'system-review', scope: 'system', scopeId: 'system', categoryId: 'cat-general' }),
    skill({ id: 'group-review', scope: 'group', scopeId: 'group-1', categoryId: 'cat-group' }),
    skill({ id: 'personal-review', scope: 'personal', scopeId: 'user-1', categoryId: 'cat-personal' }),
    skill({ id: 'disabled', key: 'disabled', status: 'disabled' }),
    skill({ id: 'other-group', key: 'other', scope: 'group', scopeId: 'group-2' })
  ], categories, actor);

  assert.deepEqual(available.map((item) => item.id), ['personal-review']);
});

test('mergeAvailableSkills keeps system and visible group Skills when no personal override exists', () => {
  const available = mergeAvailableSkills([
    skill({ id: 'system-review', scope: 'system', scopeId: 'system' }),
    skill({ id: 'group-build', key: 'build', name: 'Build', scope: 'group', scopeId: 'group-1', categoryId: 'cat-group' }),
    skill({ id: 'personal-hidden', key: 'private', scope: 'personal', scopeId: 'someone-else' })
  ], categories, actor);

  assert.deepEqual(available.map((item) => item.id), ['system-review', 'group-build']);
});
