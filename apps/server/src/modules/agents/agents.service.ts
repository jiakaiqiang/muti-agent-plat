import { Injectable, NotFoundException } from '@nestjs/common';
import { defaultAgents } from '@agent-cluster/shared';
import type { Agent } from '@agent-cluster/shared';
import { defaultAgentRuntimeType } from '../../common/runtime-config.js';
import { defaultCapabilityIdsByAgentKey } from '../capabilities/default-capabilities.js';
import { PersistenceService } from '../persistence/persistence.service.js';

const truthyValues = new Set(['1', 'true', 'yes', 'on']);

@Injectable()
export class AgentsService {
  private readonly agents = new Map<string, Agent>();
  private readonly defaultAgentIds = new Set(defaultAgents.map((agent) => agent.id));

  constructor(private readonly persistence: PersistenceService) {
    const persistedAgents = this.persistence.getCollection<Agent[]>('agents', []);
    const defaultRuntimeType = defaultAgentRuntimeType();
    const defaultAgentKeys = new Set(defaultAgents.map((agent) => agent.key));

    // Default agents are seed-only: injected in memory when seeding is enabled, and never written
    // to the persisted store (see persist()). The store keeps only user-created agents, so turning
    // seeding off makes the defaults disappear on the next start instead of lingering forever.
    const seedAgents = this.defaultAgentSeedEnabled() ? defaultAgents : [];
    const customAgents = persistedAgents.filter((agent) => !this.defaultAgentIds.has(agent.id));

    for (const agent of [...seedAgents, ...customAgents]) {
      const defaultCapabilityIds = defaultCapabilityIdsByAgentKey[agent.key] ?? [];
      const runtimeType = defaultAgentKeys.has(agent.key) ? defaultRuntimeType : agent.runtimeType;
      this.agents.set(agent.id, {
        ...agent,
        runtimeType,
        modelId: agent.modelId?.trim() || undefined,
        capabilityIds: Array.from(new Set([...defaultCapabilityIds, ...agent.capabilityIds]))
      });
    }

    // Rewrite the store without default agents so legacy seeds persisted by older builds are pruned.
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
    const agent: Agent = {
      id: input.id ?? crypto.randomUUID(),
      key: this.uniqueAgentKey(input.key ?? input.name),
      name: input.name.trim(),
      role: input.role.trim(),
      description: input.description?.trim() || undefined,
      tags: this.normalizeStringList(input.tags),
      runtimeType: input.runtimeType ?? defaultAgentRuntimeType(),
      modelId: input.modelId?.trim() || undefined,
      status: input.status ?? 'active',
      capabilityIds: this.normalizeStringList(input.capabilityIds),
      defaultKnowledgeBaseIds: this.normalizeStringList(input.defaultKnowledgeBaseIds),
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? now
    };
    this.agents.set(agent.id, agent);
    this.persist();
    return agent;
  }

  update(agentId: string, patch: Partial<Agent>) {
    const current = this.getByIdOrKey(agentId);
    const updated: Agent = {
      ...current,
      ...patch,
      id: current.id,
      updatedAt: new Date().toISOString()
    };
    this.agents.set(updated.id, updated);
    this.persist();
    return updated;
  }

  remove(agentId: string) {
    const agent = this.getByIdOrKey(agentId);
    this.agents.delete(agent.id);
    this.persist();
    return { id: agent.id, removed: true };
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
    this.persistence.setCollection(
      'agents',
      this.list().filter((agent) => !this.defaultAgentIds.has(agent.id))
    );
  }

  private normalizeStringList(values?: string[]) {
    if (!Array.isArray(values)) {
      return [];
    }
    return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
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

  private defaultAgentSeedEnabled() {
    return truthyValues.has((process.env.AGENT_CLUSTER_SEED_DEFAULT_AGENTS ?? '').trim().toLowerCase());
  }
}
