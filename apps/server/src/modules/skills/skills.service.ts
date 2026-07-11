import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Skill, SkillFile } from '@agent-cluster/shared';
import { AgentsService } from '../agents/agents.service.js';
import { PersistenceService } from '../persistence/persistence.service.js';

const MAX_NAME_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_CONTENT_LENGTH = 100_000;
const MAX_FILES = 20;
const MAX_FILE_CONTENT_LENGTH = 100_000;
const MAX_TOTAL_FILE_CONTENT_LENGTH = 500_000;

export type SkillInput = Pick<Skill, 'name' | 'content'> &
  Partial<Pick<Skill, 'description' | 'files' | 'id' | 'key' | 'status' | 'revision' | 'createdAt' | 'updatedAt'>>;

function slugifyKey(source: string) {
  return (
    source
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || `skill-${crypto.randomUUID().slice(0, 8)}`
  );
}

@Injectable()
export class SkillsService {
  private readonly skills = new Map<string, Skill>();

  constructor(
    private readonly persistence: PersistenceService,
    private readonly agents: AgentsService
  ) {
    for (const skill of this.persistence.getCollection<Skill[]>('skills', [])) {
      const normalized = this.normalize(this.backfill(skill));
      this.skills.set(normalized.id, normalized);
    }
  }

  list() {
    return [...this.skills.values()].sort((left, right) =>
      left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
    );
  }

  get(skillId: string) {
    const skill = this.skills.get(skillId);
    if (!skill) throw new NotFoundException(`Skill not found: ${skillId}`);
    return skill;
  }

  findByKey(key: string) {
    return this.list().find((skill) => skill.key === key);
  }

  create(input: SkillInput) {
    const now = new Date().toISOString();
    const skill = this.normalize({
      id: input.id ?? crypto.randomUUID(),
      key: this.uniqueKey(input.key ?? input.name),
      name: input.name,
      description: input.description,
      content: input.content,
      files: input.files ?? [],
      status: input.status ?? 'active',
      revision: input.revision ?? 1,
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? now
    });
    this.assertUniqueName(skill.name);
    this.skills.set(skill.id, skill);
    this.persist();
    return skill;
  }

  update(skillId: string, patch: Partial<SkillInput>) {
    const current = this.get(skillId);
    // key 创建后不可修改;内容变化时递增 revision。
    const contentChanged =
      (patch.content !== undefined && patch.content.trim() !== current.content) ||
      (patch.files !== undefined && JSON.stringify(patch.files) !== JSON.stringify(current.files));
    const updated = this.normalize({
      ...current,
      ...patch,
      id: current.id,
      key: current.key,
      status: patch.status ?? current.status,
      revision: contentChanged ? (current.revision ?? 1) + 1 : current.revision ?? 1,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString()
    });
    this.assertUniqueName(updated.name, current.id);
    this.skills.set(current.id, updated);
    this.persist();
    return updated;
  }

  remove(skillId: string) {
    const skill = this.get(skillId);
    const referencingAgents = this.referencingAgents(skillId);
    if (referencingAgents.length > 0) {
      throw new Error(
        `Cannot delete skill "${skill.name}": referenced by ${referencingAgents.length} agent(s). ` +
        `Remove references first: ${referencingAgents.map((a) => a.key).join(', ')}`
      );
    }
    this.skills.delete(skill.id);
    const updatedAgents = this.agents.removeSkillReferences(skill.id);
    this.persist();
    return { skill, removed: true, cleanedAgentIds: updatedAgents.map((agent) => agent.id) };
  }

  /** 删除前影响分析：引用该 Skill 的 Agent 列表（skillIds 绑定或 Markdown 占位符）。 */
  referencingAgents(skillId: string) {
    const skill = this.get(skillId);
    const placeholder = `\${skill:${skill.key}}`;
    return this.agents
      .list()
      .filter(
        (agent) =>
          (agent.skillIds ?? []).includes(skill.id) ||
          (skill.key ? (agent.profileMarkdown ?? '').includes(placeholder) : false)
      )
      .map((agent) => ({ id: agent.id, key: agent.key, name: agent.name }));
  }

  bind(agentId: string, skillId: string) {
    const skill = this.get(skillId);
    return { agent: this.agents.bindSkill(agentId, skill.id), skill };
  }

  unbind(agentId: string, skillId: string) {
    const skill = this.get(skillId);
    return { agent: this.agents.unbindSkill(agentId, skill.id), skill, removed: true };
  }

  resolve(skillIds: string[] = []) {
    return Array.from(new Set(skillIds))
      .map((skillId) => this.skills.get(skillId))
      .filter((skill): skill is Skill => Boolean(skill))
      .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  }

  systemRules(skillIds: string[] = []) {
    return this.resolve(skillIds).map((skill) => {
      const files = skill.files.length
        ? ['Files:', ...skill.files.map((file) => `--- ${file.path} ---\n${file.content}`)].join('\n')
        : '';
      return [
        `[Skill:${skill.name}]`,
        skill.description ? `Description: ${skill.description}` : '',
        skill.content,
        files
      ]
        .filter(Boolean)
        .join('\n');
    });
  }

  private normalize(input: Skill): Skill {
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
    return {
      ...input,
      name,
      description,
      content,
      files,
      key: input.key ?? slugifyKey(name),
      status: input.status ?? 'active',
      revision: input.revision ?? 1
    };
  }

  /** 为旧数据补齐 key/status/revision（迁移 11.2）。 */
  private backfill(skill: Skill): Skill {
    return {
      ...skill,
      key: skill.key ?? slugifyKey(skill.name),
      status: skill.status ?? 'active',
      revision: skill.revision ?? 1
    };
  }

  private uniqueKey(source: string) {
    const base = slugifyKey(source);
    const used = new Set(this.list().map((skill) => skill.key));
    if (!used.has(base)) return base;
    let index = 2;
    while (used.has(`${base}-${index}`)) index += 1;
    return `${base}-${index}`;
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

  private assertUniqueName(name: string, exceptId?: string) {
    const normalized = name.toLocaleLowerCase();
    if (this.list().some((skill) => skill.id !== exceptId && skill.name.toLocaleLowerCase() === normalized)) {
      throw new BadRequestException(`Skill name already exists: ${name}`);
    }
  }

  private persist() {
    this.persistence.setCollection('skills', this.list());
  }
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
