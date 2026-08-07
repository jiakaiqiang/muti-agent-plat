import { Injectable } from '@nestjs/common';
import type { AgentCatalogSurface, SystemAgentRole } from '@agent-cluster/shared';
import { AgentsService } from './agents.service.js';

@Injectable()
export class AgentCatalogService {
  constructor(private readonly agents: AgentsService) {}

  listForManagement() {
    return this.agents.listForSurface('management');
  }

  listForChat() {
    return this.agents.listForSurface('chat');
  }

  listForWorkflow() {
    return this.agents.listForSurface('workflow');
  }

  listForMention() {
    return this.agents.listForSurface('mention');
  }

  listForSurface(surface: AgentCatalogSurface) {
    return this.agents.listForSurface(surface);
  }

  resolveSystemRole(role: SystemAgentRole) {
    return this.agents.resolveSystemRole(role);
  }
}
