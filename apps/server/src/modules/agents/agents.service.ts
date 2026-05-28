import { Injectable, NotFoundException } from '@nestjs/common';
import { defaultAgents } from '@agent-cluster/shared';
import type { Agent } from '@agent-cluster/shared';

@Injectable()
export class AgentsService {
  private readonly agents = new Map<string, Agent>();

  constructor() {
    for (const agent of defaultAgents) {
      this.agents.set(agent.id, agent);
    }
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
}
