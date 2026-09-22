import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Skill, SkillCategory, SkillFile, SkillScope } from '@agent-cluster/shared';
import { AgentsService } from '../agents/agents.service.js';
import { PersistenceService } from '../persistence/persistence.service.js';
import {
  DEFAULT_SKILL_ACTOR,
  DEFAULT_SKILL_CATEGORY_ID,
  SYSTEM_SKILL_SCOPE_ID,
  canManageSkillScope,
  mergeAvailableSkills,
  normalizeCategoryName,
  normalizeSkillRecord,
  normalizeSkillScope,
  type NormalizedSkill,
  type SkillActor
} from './skill-registry.js';

const MAX_NAME_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_CONTENT_LENGTH = 100_000;
const MAX_FILES = 20;
const MAX_FILE_CONTENT_LENGTH = 100_000;
const MAX_TOTAL_FILE_CONTENT_LENGTH = 500_000;

export type SkillInput = Pick<Skill, 'name' | 'content'> &
  Partial<Pick<Skill, 'description' | 'files' | 'id' | 'key' | 'status' | 'revision' | 'createdAt' | 'updatedAt' | 'scope' | 'scopeId' | 'categoryId'>>;

export type SkillCategoryInput = {
  id?: string;
  name: string;
  scope?: SkillScope;
  scopeId?: string;
};

@Injectable()
export class SkillsService {
  private readonly skills = new Map<string, NormalizedSkill>();
  private readonly categories = new Map<string, SkillCategory>();

  constructor(
    private readonly persistence: PersistenceService,
    private readonly agents: AgentsService
  ) {
    for (const category of this.persistence.getCollection<SkillCategory[]>('skillCategories', [])) {
      this.categories.set(category.id, this.normalizeCategory(category));
    }
    for (const skill of this.persistence.getCollection<Skill[]>('skills', [])) {
      this.assertCurrentSchema(skill);
      const normalized = this.normalize(skill);
      const categoryId = this.ensureCategory(normalized.scope, normalized.scopeId, normalized.categoryId);
      const withCategory = this.normalize({ ...normalized, categoryId });
      this.skills.set(withCategory.id, withCategory);
    }
  }

  /** Management view: includes disabled Skills and all scopes. */
  list() {
    return [...this.skills.values()].sort(sortSkills);
  }

  /** `/` and other execution surfaces use this merged, active view. */
  listAvailable(actor: SkillActor = DEFAULT_SKILL_ACTOR) {
    return mergeAvailableSkills(this.list(), this.listCategories(), actor);
  }

  get(skillId: string) {
    const skill = this.skills.get(skillId);
    if (!skill) throw new NotFoundException(`Skill not found: ${skillId}`);
    return skill;
  }

  findByKey(key: string) {
    return this.list().find((skill) => skill.key === key);
  }

  findAvailableByKey(key: string, actor: SkillActor = DEFAULT_SKILL_ACTOR) {
    return this.listAvailable(actor).find((skill) => skill.key === key);
  }

  create(input: SkillInput, actor?: SkillActor) {
    const resolvedActor = actor ?? DEFAULT_SKILL_ACTOR;
    const scope = normalizeSkillScope(input.scope, input.scopeId, resolvedActor);
    this.assertScopeMutation(scope.scope, scope.scopeId, resolvedActor);
    const categoryId = this.resolveCategoryId(input.categoryId, scope.scope, scope.scopeId);
    const now = new Date().toISOString();
    const skill = this.normalize({
      id: input.id ?? crypto.randomUUID(),
      key: this.uniqueKey(input.key ?? input.name, scope.scope, scope.scopeId),
      name: input.name,
      description: input.description,
      content: input.content,
      files: input.files ?? [],
      status: input.status ?? 'active',
      revision: input.revision ?? 1,
      scope: scope.scope,
      scopeId: scope.scopeId,
      categoryId,
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? now
    });
    this.assertUniqueName(skill.name, skill.scope, skill.scopeId);
    this.skills.set(skill.id, skill);
    this.persist();
    return skill;
  }

  update(skillId: string, patch: Partial<SkillInput>, actor?: SkillActor) {
    const resolvedActor = actor ?? DEFAULT_SKILL_ACTOR;
    const current = this.get(skillId);
    this.assertScopeMutation(current.scope, current.scopeId, resolvedActor);
    if (patch.scope !== undefined || patch.scopeId !== undefined) {
      const requestedScope = normalizeSkillScope(patch.scope ?? current.scope, patch.scopeId ?? current.scopeId, resolvedActor);
      if (requestedScope.scope !== current.scope || requestedScope.scopeId !== current.scopeId) {
        throw new BadRequestException('Change Skill scope through the promote endpoint.');
      }
    }
    const contentChanged =
      (patch.content !== undefined && patch.content.trim() !== current.content) ||
      (patch.files !== undefined && JSON.stringify(patch.files) !== JSON.stringify(current.files));
    const categoryId = patch.categoryId ?? current.categoryId;
    this.assertCategory(categoryId, current.scope, current.scopeId);
    const updated = this.normalize({
      ...current,
      ...patch,
      id: current.id,
      key: current.key,
      scope: current.scope,
      scopeId: current.scopeId,
      categoryId,
      status: patch.status ?? current.status,
      revision: contentChanged ? current.revision + 1 : current.revision,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString()
    });
    this.assertUniqueName(updated.name, updated.scope, updated.scopeId, current.id);
    this.skills.set(current.id, updated);
    this.persist();
    return updated;
  }

  remove(skillId: string, actor?: SkillActor) {
    const resolvedActor = actor ?? DEFAULT_SKILL_ACTOR;
    const skill = this.get(skillId);
    this.assertScopeMutation(skill.scope, skill.scopeId, resolvedActor);
    const referencingAgents = this.referencingAgents(skillId);
    if (referencingAgents.length > 0) {
      throw new BadRequestException(
        `Cannot delete skill "${skill.name}": referenced by ${referencingAgents.length} agent(s). ` +
        `Remove references first: ${referencingAgents.map((a) => a.key).join(', ')}`
      );
    }
    this.skills.delete(skill.id);
    this.persist();
    return { skill, removed: true };
  }

  /** 删除前影响分析：引用该 Skill 的 Agent Profile 列表。 */
  referencingAgents(skillId: string) {
    const skill = this.get(skillId);
    const placeholder = `\${skill:${skill.key}}`;
    return this.agents
      .list()
      .filter((agent) => agent.profileMarkdown.includes(placeholder))
      .map((agent) => ({ id: agent.id, key: agent.key, name: agent.name }));
  }

  listCategories() {
    return [...this.categories.values()].sort(
      (left, right) => left.name.localeCompare(right.name) || left.scope.localeCompare(right.scope) || left.id.localeCompare(right.id)
    );
  }

  listAvailableCategories(actor: SkillActor = DEFAULT_SKILL_ACTOR) {
    const visibleIds = new Set(this.listAvailable(actor).map((skill) => skill.categoryId));
    return this.listCategories().filter((category) => visibleIds.has(category.id));
  }

  createCategory(input: SkillCategoryInput, actor?: SkillActor) {
    const resolvedActor = actor ?? DEFAULT_SKILL_ACTOR;
    const scope = normalizeSkillScope(input.scope, input.scopeId, resolvedActor);
    this.assertScopeMutation(scope.scope, scope.scopeId, resolvedActor);
    const name = this.safeCategoryName(input.name);
    if (this.listCategories().some((category) => category.scope === scope.scope && category.scopeId === scope.scopeId && category.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      throw new BadRequestException(`Skill category already exists: ${name}`);
    }
    const now = new Date().toISOString();
    const category: SkillCategory = {
      id: input.id?.trim() || crypto.randomUUID(),
      name,
      scope: scope.scope,
      scopeId: scope.scopeId,
      createdAt: now,
      updatedAt: now
    };
    if (this.categories.has(category.id)) throw new BadRequestException(`Skill category id already exists: ${category.id}`);
    this.categories.set(category.id, category);
    this.persist();
    return category;
  }

  renameCategory(categoryId: string, name: string, actor?: SkillActor) {
    const resolvedActor = actor ?? DEFAULT_SKILL_ACTOR;
    const category = this.getCategory(categoryId);
    this.assertScopeMutation(category.scope, category.scopeId, resolvedActor);
    const nextName = this.safeCategoryName(name);
    if (this.listCategories().some((item) => item.id !== categoryId && item.scope === category.scope && item.scopeId === category.scopeId && item.name.toLocaleLowerCase() === nextName.toLocaleLowerCase())) {
      throw new BadRequestException(`Skill category already exists: ${nextName}`);
    }
    const updated = { ...category, name: nextName, updatedAt: new Date().toISOString() };
    this.categories.set(categoryId, updated);
    this.persist();
    return updated;
  }

  removeCategory(categoryId: string, actor?: SkillActor) {
    const resolvedActor = actor ?? DEFAULT_SKILL_ACTOR;
    const category = this.getCategory(categoryId);
    this.assertScopeMutation(category.scope, category.scopeId, resolvedActor);
    const references = this.list().filter((skill) => skill.categoryId === categoryId);
    if (references.length > 0) {
      throw new BadRequestException({
        code: 'SKILL_CATEGORY_MIGRATION_REQUIRED',
        message: `Migrate ${references.length} Skill(s) before deleting category ${category.name}.`
      });
    }
    this.categories.delete(categoryId);
    this.persist();
    return { category, removed: true };
  }

  migrateCategory(fromCategoryId: string, toCategoryId: string, actor?: SkillActor) {
    const resolvedActor = actor ?? DEFAULT_SKILL_ACTOR;
    const from = this.getCategory(fromCategoryId);
    const to = this.getCategory(toCategoryId);
    this.assertScopeMutation(from.scope, from.scopeId, resolvedActor);
    this.assertCategory(to.id, from.scope, from.scopeId);
    const affected = this.list().filter((skill) => skill.categoryId === fromCategoryId);
    for (const skill of affected) this.skills.set(skill.id, this.normalize({ ...skill, categoryId: toCategoryId, updatedAt: new Date().toISOString() }));
    this.persist();
    return { from, to, migrated: affected.length };
  }

  promoteToGroup(skillId: string, groupId: string, actor?: SkillActor) {
    const resolvedActor = actor ?? DEFAULT_SKILL_ACTOR;
    const current = this.get(skillId);
    if (current.scope !== 'personal') throw new BadRequestException('Only personal Skills can be promoted to a group.');
    if (!canManageSkillScope('personal', current.scopeId, resolvedActor)) {
      throw new ForbiddenException('Only the owner can promote a personal Skill.');
    }
    const targetGroupId = groupId.trim();
    if (!targetGroupId) throw new BadRequestException('groupId is required.');
    if (resolvedActor.role !== 'system_admin' && !resolvedActor.groupIds?.includes(targetGroupId) && resolvedActor.groupId !== targetGroupId) {
      throw new ForbiddenException('Actor is not a member of the target group.');
    }
    if (this.list().some((skill) => skill.scope === 'group' && skill.scopeId === targetGroupId && skill.key === current.key)) {
      throw new BadRequestException(`Skill key already exists in group: ${current.key}`);
    }
    const category = this.findCategoryForScope(current.categoryId, 'group', targetGroupId);
    const promoted = this.normalize({
      ...current,
      scope: 'group',
      scopeId: targetGroupId,
      categoryId: category.id,
      updatedAt: new Date().toISOString()
    });
    this.skills.set(current.id, promoted);
    this.persist();
    return promoted;
  }

  private getCategory(categoryId: string) {
    const category = this.categories.get(categoryId);
    if (!category) throw new NotFoundException(`Skill category not found: ${categoryId}`);
    return category;
  }

  private resolveCategoryId(categoryId: string | undefined, scope: SkillScope, scopeId: string) {
    if (categoryId) {
      this.assertCategory(categoryId, scope, scopeId);
      return categoryId;
    }
    return this.ensureCategory(scope, scopeId);
  }

  private ensureCategory(scope: SkillScope, scopeId: string, requestedId?: string) {
    if (requestedId && this.categories.has(requestedId)) {
      this.assertCategory(requestedId, scope, scopeId);
      return requestedId;
    }
    const id = defaultCategoryId(scope, scopeId);
    if (!this.categories.has(id)) {
      const now = new Date().toISOString();
      this.categories.set(id, { id, name: 'General', scope, scopeId, createdAt: now, updatedAt: now });
    }
    return id;
  }

  private findCategoryForScope(categoryId: string, scope: SkillScope, scopeId: string) {
    const category = this.categories.get(categoryId);
    if (category && category.scope === scope && category.scopeId === scopeId) return category;
    return this.getCategory(this.ensureCategory(scope, scopeId));
  }

  private assertCategory(categoryId: string, scope: SkillScope, scopeId: string) {
    const category = this.getCategory(categoryId);
    if (category.scope !== scope || category.scopeId !== scopeId) {
      throw new BadRequestException('Skill category must belong to the same scope.');
    }
  }

  private assertScopeMutation(scope: SkillScope, scopeId: string, actor: SkillActor) {
    if (!canManageSkillScope(scope, scopeId, actor)) {
      throw new ForbiddenException(`Actor cannot modify ${scope}-scoped Skills.`);
    }
  }

  private safeCategoryName(name: string) {
    try {
      return normalizeCategoryName(name);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : 'Invalid Skill category name.');
    }
  }

  private normalize(input: Skill): NormalizedSkill {
    const name = input.name?.trim();
    const content = input.content?.trim();
    const description = input.description?.trim() || undefined;
    if (!name) throw new BadRequestException('Skill name is required.');
    if (name.length > MAX_NAME_LENGTH) throw new BadRequestException(`Skill name exceeds ${MAX_NAME_LENGTH} characters.`);
    if (!content) throw new BadRequestException('Skill content is required.');
    if (content.length > MAX_CONTENT_LENGTH) throw new BadRequestException(`Skill content exceeds ${MAX_CONTENT_LENGTH} characters.`);
    if (description && description.length > MAX_DESCRIPTION_LENGTH) {
      throw new BadRequestException(`Skill description exceeds ${MAX_DESCRIPTION_LENGTH} characters.`);
    }
    const files = this.normalizeFiles(input.files ?? []);
    return normalizeSkillRecord({
      ...input,
      key: input.key?.trim() || slugifyKey(name),
      name,
      description,
      content,
      files
    });
  }

  /** 为旧数据补齐 key/status/revision；scope/category 缺失会安全归入系统默认分类。 */
  private assertCurrentSchema(skill: Skill) {
    if (!skill.key?.trim() || !skill.status || !Number.isInteger(skill.revision) || skill.revision < 1) {
      throw new Error(`CUTOVER_REQUIRED: persisted Skill is not v2-only: ${skill.id ?? 'unknown'}`);
    }
  }

  private uniqueKey(source: string, scope: SkillScope, scopeId: string) {
    const base = slugifyKey(source);
    const used = new Set(this.list().filter((skill) => skill.scope === scope && skill.scopeId === scopeId).map((skill) => skill.key));
    if (!used.has(base)) return base;
    let index = 2;
    while (used.has(`${base}-${index}`)) index += 1;
    return `${base}-${index}`;
  }

  private assertUniqueName(name: string, scope: SkillScope, scopeId: string, exceptId?: string) {
    const normalized = name.toLocaleLowerCase();
    if (this.list().some((skill) => skill.id !== exceptId && skill.scope === scope && skill.scopeId === scopeId && skill.name.toLocaleLowerCase() === normalized)) {
      throw new BadRequestException(`Skill name already exists: ${name}`);
    }
  }

  private normalizeCategory(category: SkillCategory): SkillCategory {
    const scope = category.scope ?? 'system';
    const scopeId = category.scopeId?.trim() || (scope === 'system' ? SYSTEM_SKILL_SCOPE_ID : 'unknown');
    return { ...category, name: this.safeCategoryName(category.name), scope, scopeId };
  }

  private normalizeFiles(files: SkillFile[]) {
    if (!Array.isArray(files)) throw new BadRequestException('Skill files must be an array.');
    if (files.length > MAX_FILES) throw new BadRequestException(`Skill files exceed ${MAX_FILES} entries.`);
    let totalLength = 0;
    const paths = new Set<string>();
    return files.map((file) => {
      const path = normalizeRelativePath(file.path);
      if (paths.has(path)) throw new BadRequestException(`Duplicate skill file path: ${path}`);
      paths.add(path);
      if (typeof file.content !== 'string') throw new BadRequestException(`Skill file content must be a string: ${path}`);
      if (file.content.length > MAX_FILE_CONTENT_LENGTH) {
        throw new BadRequestException(`Skill file exceeds ${MAX_FILE_CONTENT_LENGTH} characters: ${path}`);
      }
      totalLength += file.content.length;
      if (totalLength > MAX_TOTAL_FILE_CONTENT_LENGTH) {
        throw new BadRequestException(`Skill file content exceeds ${MAX_TOTAL_FILE_CONTENT_LENGTH} total characters.`);
      }
      return { path, content: file.content };
    });
  }

  private persist() {
    this.persistence.setCollection('skills', this.list());
    this.persistence.setCollection('skillCategories', this.listCategories());
  }
}

function sortSkills(left: Skill, right: Skill) {
  return (left.scope ?? 'system').localeCompare(right.scope ?? 'system') ||
    (left.scopeId ?? SYSTEM_SKILL_SCOPE_ID).localeCompare(right.scopeId ?? SYSTEM_SKILL_SCOPE_ID) ||
    left.name.localeCompare(right.name) ||
    left.id.localeCompare(right.id);
}

function defaultCategoryId(scope: SkillScope, scopeId: string) {
  if (scope === 'system') return DEFAULT_SKILL_CATEGORY_ID;
  return `${DEFAULT_SKILL_CATEGORY_ID}-${scope}-${slugifyKey(scopeId)}`;
}

function slugifyKey(source: string) {
  return (
    source
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || `skill-${crypto.randomUUID().slice(0, 8)}`
  );
}

function normalizeRelativePath(value: string) {
  if (typeof value !== 'string') throw new BadRequestException('Skill file path must be a string.');
  const path = value.trim().replace(/\\/g, '/');
  if (!path || path.startsWith('/') || /^[a-zA-Z]:\//.test(path)) {
    throw new BadRequestException(`Skill file path must be relative: ${value}`);
  }
  const segments = path.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new BadRequestException(`Skill file path is invalid: ${value}`);
  }
  return segments.join('/');
}
