import type { Skill, SkillCategory, SkillScope } from '@agent-cluster/shared';

export type SkillActorRole = 'user' | 'group_admin' | 'system_admin';

export type SkillActor = {
  userId: string;
  role: SkillActorRole;
  /** Groups in which the actor can manage/read group-scoped Skills. */
  groupIds?: string[];
  /** Currently selected group used by the available-list query. */
  groupId?: string;
};

export const DEFAULT_SKILL_ACTOR: SkillActor = {
  userId: 'local-user',
  role: 'system_admin',
  groupIds: []
};

export const SYSTEM_SKILL_SCOPE_ID = 'system';
export const DEFAULT_SKILL_CATEGORY_ID = 'skill-category-general';

export type NormalizedSkill = Skill & {
  scope: SkillScope;
  scopeId: string;
  categoryId: string;
};

export type NormalizedSkillCategory = SkillCategory;

export function normalizeSkillScope(scope: SkillScope | undefined, scopeId: string | undefined, actor: SkillActor) {
  const resolvedScope = scope ?? 'system';
  if (resolvedScope === 'system') return { scope: resolvedScope, scopeId: SYSTEM_SKILL_SCOPE_ID } as const;
  if (resolvedScope === 'personal') return { scope: resolvedScope, scopeId: scopeId?.trim() || actor.userId } as const;
  if (!scopeId?.trim()) throw new Error('Group-scoped Skill requires a groupId.');
  return { scope: resolvedScope, scopeId: scopeId.trim() } as const;
}

export function scopeRank(scope: SkillScope) {
  return scope === 'personal' ? 3 : scope === 'group' ? 2 : 1;
}

export function isSkillVisible(skill: Skill, actor: SkillActor) {
  const scope = skill.scope ?? 'system';
  const scopeId = skill.scopeId ?? SYSTEM_SKILL_SCOPE_ID;
  if (scope === 'system') return true;
  if (scope === 'personal') return scopeId === actor.userId;
  return scopeId === actor.groupId || actor.groupIds?.includes(scopeId) === true;
}

export function canManageSkillScope(scope: SkillScope, scopeId: string, actor: SkillActor) {
  if (actor.role === 'system_admin') return true;
  if (scope === 'personal') return scopeId === actor.userId;
  return scope === 'group' && actor.role === 'group_admin' && actor.groupIds?.includes(scopeId) === true;
}

export function mergeAvailableSkills(
  skills: readonly Skill[],
  categories: readonly SkillCategory[],
  actor: SkillActor
): NormalizedSkill[] {
  const categoryNames = new Map(categories.map((category) => [category.id, category.name]));
  const selected = new Map<string, Skill>();
  for (const skill of skills) {
    if ((skill.status ?? 'active') !== 'active' || !isSkillVisible(skill, actor)) continue;
    const current = selected.get(skill.key);
    if (!current || scopeRank(skill.scope ?? 'system') > scopeRank(current.scope ?? 'system')) {
      selected.set(skill.key, skill);
    }
  }
  return [...selected.values()]
    .map((skill) => normalizeSkillRecord(skill))
    .sort((left, right) =>
      (categoryNames.get(left.categoryId) ?? '').localeCompare(categoryNames.get(right.categoryId) ?? '') ||
      left.name.localeCompare(right.name) ||
      left.key.localeCompare(right.key)
    );
}

export function normalizeSkillRecord(skill: Skill): NormalizedSkill {
  return {
    ...skill,
    status: skill.status ?? 'active',
    revision: skill.revision ?? 1,
    scope: skill.scope ?? 'system',
    scopeId: skill.scopeId ?? SYSTEM_SKILL_SCOPE_ID,
    categoryId: skill.categoryId ?? DEFAULT_SKILL_CATEGORY_ID
  };
}

export function normalizeCategoryName(name: string) {
  const normalized = name.trim();
  if (!normalized) throw new Error('Skill category name is required.');
  if (normalized.length > 80) throw new Error('Skill category name exceeds 80 characters.');
  return normalized;
}
