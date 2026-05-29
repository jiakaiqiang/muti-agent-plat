import { Injectable, NotFoundException } from '@nestjs/common';
import type { RuntimeCapabilityDefinition } from '@agent-cluster/shared';
import { PersistenceService } from '../persistence/persistence.service.js';
import { defaultCapabilities } from './default-capabilities.js';

type CapabilityInvocationCheck = {
  sessionId?: string;
  agentId?: string;
  reason?: string;
};

@Injectable()
export class CapabilitiesService {
  private readonly capabilities = new Map<string, RuntimeCapabilityDefinition>();
  private readonly approvals = new Set<string>();

  constructor(private readonly persistence: PersistenceService) {
    const persisted = this.persistence.getCollection<{
      capabilities: RuntimeCapabilityDefinition[];
      approvals: string[];
    }>('capabilities', { capabilities: [], approvals: [] });

    for (const capability of [...persisted.capabilities, ...defaultCapabilities]) {
      this.capabilities.set(capability.id, capability);
    }
    for (const approval of persisted.approvals) {
      this.approvals.add(approval);
    }
    this.persist();
  }

  list() {
    return [...this.capabilities.values()];
  }

  resolve(capabilityIds: string[]) {
    const byId = capabilityIds
      .map((capabilityId) => this.capabilities.get(capabilityId))
      .filter((capability): capability is RuntimeCapabilityDefinition => capability !== undefined);
    return byId.filter((capability) => capability.riskLevel !== 'high' || this.highRiskToolsEnabled());
  }

  get(capabilityId: string) {
    const capability = this.capabilities.get(capabilityId);
    if (!capability) {
      throw new NotFoundException(`Capability not found: ${capabilityId}`);
    }
    return capability;
  }

  approve(capabilityId: string, input: CapabilityInvocationCheck) {
    const capability = this.get(capabilityId);
    const approvalKey = this.approvalKey(capability.id, input.sessionId, input.agentId);
    this.approvals.add(approvalKey);
    this.persist();
    return {
      capability,
      approved: true,
      approvalKey
    };
  }

  checkInvocation(capabilityId: string, input: CapabilityInvocationCheck) {
    const capability = this.get(capabilityId);
    const approvalKey = this.approvalKey(capability.id, input.sessionId, input.agentId);
    const requiresUserConfirmation =
      capability.riskLevel === 'high' &&
      process.env.REQUIRE_USER_CONFIRMATION !== 'false' &&
      !this.approvals.has(approvalKey);

    if (requiresUserConfirmation) {
      return {
        allowed: false,
        code: 'CAPABILITY_REQUIRES_CONFIRMATION',
        capability,
        approvalKey,
        requiresUserConfirmation: true
      };
    }

    return {
      allowed: true,
      capability,
      approvalKey,
      requiresUserConfirmation: false
    };
  }

  private approvalKey(capabilityId: string, sessionId = 'global', agentId = 'any') {
    return `${sessionId}:${agentId}:${capabilityId}`;
  }

  private highRiskToolsEnabled() {
    return process.env.ENABLE_HIGH_RISK_TOOLS === 'true';
  }

  private persist() {
    this.persistence.setCollection('capabilities', {
      capabilities: this.list(),
      approvals: [...this.approvals]
    });
  }
}
