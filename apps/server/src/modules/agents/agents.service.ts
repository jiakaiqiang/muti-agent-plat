import { Injectable, NotFoundException } from '@nestjs/common';
import { defaultAgents } from '@agent-cluster/shared';
import type { Agent } from '@agent-cluster/shared';
import { defaultCapabilityIdsByAgentKey } from '../capabilities/default-capabilities.js';
import { PersistenceService } from '../persistence/persistence.service.js';

@Injectable()
export class AgentsService {
  private readonly agents = new Map<string, Agent>();

  constructor(private readonly persistence: PersistenceService) {
    const persistedAgents = this.persistence.getCollection<Agent[]>('agents', []);
    for (const agent of [...defaultAgents, ...persistedAgents]) {
      const defaultCapabilityIds = defaultCapabilityIdsByAgentKey[agent.key] ?? [];
      this.agents.set(agent.id, {
        ...agent,
        capabilityIds: Array.from(new Set([...defaultCapabilityIds, ...agent.capabilityIds]))
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

  create(input: Partial<Agent> & Pick<Agent, 'key' | 'name' | 'role'>) {
    const now = new Date().toISOString();
    const agent: Agent = {
      id: input.id ?? crypto.randomUUID(),
      key: input.key,
      name: input.name,
      role: input.role,
      runtimeType: input.runtimeType ?? 'mock',
      status: input.status ?? 'active',
      capabilityIds: input.capabilityIds ?? [],
      defaultKnowledgeBaseIds: input.defaultKnowledgeBaseIds ?? [],
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
    this.persistence.setCollection('agents', this.list());
  }
}
