import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  SYSTEM_AGENT_REGISTRATIONS,
  type AgentCatalogSurface,
  type AgentDefinition,
  type AgentManagementPolicy,
  type SystemAgentRegistration,
  type SystemAgentRole
} from '@agent-cluster/shared';

const USER_AGENT_POLICY: AgentManagementPolicy = {
  owner: 'user',
  protected: false,
  allowedSurfaces: ['management', 'chat', 'workflow', 'mention'],
  editableFields: ['name', 'description', 'profileMarkdown']
};

@Injectable()
export class SystemAgentRegistryService {
  private readonly registrations = [...SYSTEM_AGENT_REGISTRATIONS];

  list(): readonly SystemAgentRegistration[] {
    return this.registrations;
  }

  findByAgent(agent: Pick<AgentDefinition, 'id' | 'key'>) {
    return this.registrations.find(
      (registration) => registration.agentId === agent.id || registration.key === agent.key
    );
  }

  findByKey(key: string) {
    return this.registrations.find((registration) => registration.key === key);
  }

  getByRole(role: SystemAgentRole) {
    const registration = this.registrations.find((item) => item.role === role);
    if (!registration) throw new NotFoundException(`System Agent role not registered: ${role}`);
    return registration;
  }

  isSystemAgent(agent: Pick<AgentDefinition, 'id' | 'key'>) {
    return Boolean(this.findByAgent(agent));
  }

  policyFor(agent: Pick<AgentDefinition, 'id' | 'key'>): AgentManagementPolicy {
    const registration = this.findByAgent(agent);
    if (!registration) return structuredClone(USER_AGENT_POLICY);
    return {
      owner: 'system',
      systemRole: registration.role,
      protected: true,
      allowedSurfaces: [...registration.allowedSurfaces],
      editableFields: [...registration.editableFields]
    };
  }

  isAllowedOnSurface(agent: AgentDefinition, surface: AgentCatalogSurface) {
    return this.policyFor(agent).allowedSurfaces.includes(surface);
  }

  assertPatchAllowed(current: AgentDefinition, patch: Partial<AgentDefinition>) {
    const registration = this.findByAgent(current);
    if (!registration) return;

    const allowed = new Set<string>(registration.editableFields);
    const serverManaged = new Set(['management', 'profileRevision', 'createdAt', 'updatedAt']);
    const changedProtectedFields = Object.entries(patch)
      .filter(([field]) => !allowed.has(field) && !serverManaged.has(field))
      .filter(([field, value]) => !this.equalValue(value, current[field as keyof AgentDefinition]))
      .map(([field]) => field);

    if (changedProtectedFields.length) {
      throw new BadRequestException({
        code: 'SYSTEM_AGENT_PROTECTED_FIELD',
        message: `Protected system Agent fields cannot be changed: ${changedProtectedFields.join(', ')}`,
        fields: changedProtectedFields
      });
    }
  }

  assertCreatable(input: Pick<Partial<AgentDefinition>, 'id' | 'key'>) {
    const reserved = this.registrations.find(
      (registration) => registration.agentId === input.id || registration.key === input.key
    );
    if (reserved) {
      throw new BadRequestException({
        code: 'SYSTEM_AGENT_IDENTITY_RESERVED',
        message: `System Agent identity is reserved: ${reserved.key}`
      });
    }
  }

  private equalValue(left: unknown, right: unknown) {
    if (Array.isArray(left) || Array.isArray(right)) {
      return JSON.stringify(left) === JSON.stringify(right);
    }
    return left === right;
  }
}
