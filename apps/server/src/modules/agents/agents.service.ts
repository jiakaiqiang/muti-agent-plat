import { BadRequestException, Inject, Injectable, NotFoundException, Optional, forwardRef } from '@nestjs/common';
import { defaultAgents } from '@agent-cluster/shared';
import type { AgentDefinition as Agent, CompiledAgentProfile } from '@agent-cluster/shared';
import { defaultCapabilityIdsByAgentKey } from '../capabilities/default-capabilities.js';
import { PersistenceService } from '../persistence/persistence.service.js';
import { AgentProfileCompilerService } from '../agent-profile/agent-profile-compiler.service.js';

const truthyValues = new Set(['1', 'true', 'yes', 'on']);
const defaultAgentsByKey = new Map(defaultAgents.map((agent) => [agent.key, agent]));
const defaultAgentIds = new Set(defaultAgents.map((agent) => agent.id));
const defaultAgentKeys = new Set(defaultAgentsByKey.keys());

@Injectable()
export class AgentsService {
  private readonly agents = new Map<string, Agent>();
  private readonly persistedDefaultAgentIds = new Set<string>();
  private readonly seedDefaultAgents: boolean;

  constructor(
    private readonly persistence: PersistenceService,
    @Optional()
    @Inject(forwardRef(() => AgentProfileCompilerService))
    private readonly profileCompiler?: AgentProfileCompilerService
  ) {
    const persistedAgents = this.persistence.getCollection<Agent[]>('agents', []);
    this.seedDefaultAgents = this.defaultAgentSeedEnabled();
    const persistedDefaultAgents = persistedAgents.filter((agent) => this.isDefaultAgent(agent));
    persistedDefaultAgents.forEach((agent) => {
      this.persistedDefaultAgentIds.add(agent.id);
      const canonicalDefaultAgent = defaultAgentsByKey.get(agent.key);
      if (canonicalDefaultAgent) {
        this.persistedDefaultAgentIds.add(canonicalDefaultAgent.id);
      }
    });

    const visibleDefaultAgents = defaultAgents.map((agent) =>
      this.mergeSeedAgent(agent, persistedDefaultAgents.find((item) => item.id === agent.id || item.key === agent.key))
    );
    const persistedCustomAgents = persistedAgents.filter((agent) => !this.isDefaultAgent(agent));
    for (const agent of [...visibleDefaultAgents, ...persistedCustomAgents]) {
      const defaultCapabilityIds = defaultCapabilityIdsByAgentKey[agent.key] ?? [];
      this.agents.set(agent.id, {
        ...agent,
        profileMarkdown: agent.profileMarkdown.trim() || this.defaultProfileMarkdown(agent),
        tags: this.normalizeStringList(agent.tags),
        capabilityIds: Array.from(new Set([...defaultCapabilityIds, ...agent.capabilityIds])),
        profileRevision: agent.profileRevision
      });
    }
    this.persist();
  }

  list() {
    return [...this.agents.values()];
  }

  findByIdOrKey(idOrKey: string) {
    const byId = this.agents.get(idOrKey);
    if (byId) {
      return byId;
    }
    return this.list().find((agent) => agent.key === idOrKey);
  }

  getByIdOrKey(idOrKey: string) {
    const agent = this.findByIdOrKey(idOrKey);
    if (!agent) {
      throw new NotFoundException(`Agent not found: ${idOrKey}`);
    }
    return agent;
  }

  resolveIds(ids?: string[]) {
    const selected = ids?.length ? ids.map((id) => this.getByIdOrKey(id)) : this.list();
    return selected.map((agent) => agent.id);
  }

  create(input: Partial<Agent> & Pick<Agent, 'name' | 'role'>) {
    const now = new Date().toISOString();
    const profileMarkdown = input.profileMarkdown?.trim() || this.defaultProfileMarkdown(input);
    const capabilityIds = this.normalizeStringList(input.capabilityIds);
    this.compileOrThrow(profileMarkdown, capabilityIds);
    const agent: Agent = {
      id: input.id ?? crypto.randomUUID(),
      key: this.uniqueAgentKey(input.key ?? input.name),
      name: input.name.trim(),
      role: input.role.trim(),
      description: input.description?.trim() || undefined,
      profileMarkdown,
      tags: this.normalizeStringList(input.tags),
      status: input.status ?? 'active',
      capabilityIds,
      defaultKnowledgeBaseIds: this.normalizeStringList(input.defaultKnowledgeBaseIds),
      profileRevision: 1,
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? now
    };
    this.agents.set(agent.id, agent);
    this.persist();
    return agent;
  }

  update(agentId: string, patch: Partial<Agent>) {
    const current = this.getByIdOrKey(agentId);
    const profileMarkdown = patch.profileMarkdown?.trim() || current.profileMarkdown;
    const capabilityIds = patch.capabilityIds
      ? this.normalizeStringList(patch.capabilityIds)
      : current.capabilityIds;
    // Markdown references are the source of truth for profile resources.
    if (
      patch.profileMarkdown !== undefined || patch.capabilityIds !== undefined
    ) {
      this.compileOrThrow(profileMarkdown, capabilityIds);
    }
    const updated: Agent = {
      ...current,
      ...patch,
      id: current.id,
      profileMarkdown,
      tags: patch.tags ? this.normalizeStringList(patch.tags) : current.tags,
      capabilityIds,
      defaultKnowledgeBaseIds: patch.defaultKnowledgeBaseIds
        ? this.normalizeStringList(patch.defaultKnowledgeBaseIds)
        : current.defaultKnowledgeBaseIds,
      profileRevision: current.profileRevision + 1,
      updatedAt: new Date().toISOString()
    };
    if (this.isDefaultAgent(updated)) {
      this.persistedDefaultAgentIds.add(updated.id);
    }
    this.agents.set(updated.id, updated);
    this.persist();
    return updated;
  }

  /**
   * 校验并编译 Agent Profile（POST /api/agents/profile/validate）。
   * 不修改数据，仅返回编译结果与诊断。
   */
  validateProfile(input: { profileMarkdown: string; capabilityIds?: string[] }): CompiledAgentProfile {
    if (!this.profileCompiler) {
      throw new BadRequestException('Agent profile compiler is unavailable.');
    }
    return this.profileCompiler.compile({
      profileMarkdown: input.profileMarkdown ?? '',
      agentCapabilityIds: this.normalizeStringList(input.capabilityIds)
    });
  }

  /** 保存路径的编译入口：诊断错误时抛出，阻止保存。编译器缺席（部分单测环境）时返回 undefined。 */
  private compileOrThrow(profileMarkdown: string, capabilityIds: string[]): CompiledAgentProfile | undefined {
    if (!this.profileCompiler) {
      return undefined;
    }
    const compiled = this.profileCompiler.compile({
      profileMarkdown,
      agentCapabilityIds: capabilityIds
    });
    const errors = compiled.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
    if (errors.length > 0) {
      throw new BadRequestException({
        message: 'Agent profile has invalid references.',
        diagnostics: errors
      });
    }
    return compiled;
  }

  bindKnowledge(agentId: string, knowledgeBaseId: string) {
    const agent = this.getByIdOrKey(agentId);
    const defaultKnowledgeBaseIds = Array.from(new Set([...agent.defaultKnowledgeBaseIds, knowledgeBaseId]));
    return this.update(agent.id, { defaultKnowledgeBaseIds });
  }

  unbindKnowledge(agentId: string, knowledgeBaseId: string) {
    const agent = this.getByIdOrKey(agentId);
    return this.update(agent.id, {
      defaultKnowledgeBaseIds: agent.defaultKnowledgeBaseIds.filter((id) => id !== knowledgeBaseId)
    });
  }

  private persist() {
    this.persistence.setCollection('agents', this.persistableAgents());
  }

  private persistableAgents() {
    if (this.seedDefaultAgents) {
      return this.list();
    }
    return this.list().filter((agent) => !this.isDefaultAgent(agent) || this.persistedDefaultAgentIds.has(agent.id));
  }

  private normalizeStringList(values?: string[]) {
    if (!Array.isArray(values)) {
      return [];
    }
    return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
  }

  private mergeSeedAgent(seed: Agent, persisted?: Agent): Agent {
    if (!persisted) {
      return seed;
    }

    return {
      ...seed,
      status: persisted.status ?? seed.status,
      profileMarkdown: persisted.profileMarkdown,
      tags: this.normalizeStringList(persisted.tags),
      capabilityIds: this.normalizeStringList(persisted.capabilityIds),
      defaultKnowledgeBaseIds: this.normalizeStringList(persisted.defaultKnowledgeBaseIds),
      profileRevision: persisted.profileRevision,
      createdAt: persisted.createdAt ?? seed.createdAt,
      updatedAt: seed.updatedAt
    };
  }

  private isDefaultAgent(agent: Pick<Agent, 'id' | 'key'>) {
    return defaultAgentIds.has(agent.id) || defaultAgentKeys.has(agent.key);
  }

  private uniqueAgentKey(source: string) {
    const base =
      source
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || `agent-${crypto.randomUUID().slice(0, 8)}`;
    const usedKeys = new Set(this.list().map((agent) => agent.key));
    if (!usedKeys.has(base)) {
      return base;
    }

    let index = 2;
    let candidate = `${base}-${index}`;
    while (usedKeys.has(candidate)) {
      index += 1;
      candidate = `${base}-${index}`;
    }
    return candidate;
  }

  private defaultProfileMarkdown(agent: Pick<Agent, 'name' | 'role'> & Partial<Agent>) {
    const tags = this.normalizeStringList(agent.tags);
    const capabilityIds = this.normalizeStringList(agent.capabilityIds);
    return [
      `# ${agent.name}`,
      '',
      '## Role',
      agent.role,
      '',
      '## Working Rules',
      '- Follow the user request and current task contract.',
      '- Keep changes scoped and explain risks clearly.',
      '- Ask for confirmation before high-risk or destructive actions.',
      '',
      '## Tags',
      tags.length ? tags.map((tag) => `- ${tag}`).join('\n') : '- none',
      '',
      '## Capabilities',
      capabilityIds.length ? capabilityIds.map((capabilityId) => `- ${capabilityId}`).join('\n') : '- none'
    ].join('\n');
  }

  private defaultAgentSeedEnabled() {
    return truthyValues.has((process.env.AGENT_CLUSTER_SEED_DEFAULT_AGENTS ?? '').trim().toLowerCase());
  }
}
