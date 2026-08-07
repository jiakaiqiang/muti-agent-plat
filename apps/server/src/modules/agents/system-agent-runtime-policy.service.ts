import { BadRequestException, Injectable } from '@nestjs/common';
import type { RuntimeType, SystemAgentRole, SystemAgentRuntimePolicy } from '@agent-cluster/shared';
import { PersistenceService } from '../persistence/persistence.service.js';
import { SystemAgentRegistryService } from './system-agent-registry.service.js';

const runtimeTypes = new Set<RuntimeType>([
  'mock', 'generic_llm', 'code_reader', 'test_runner', 'codex', 'claude_code', 'mcp_tool', 'human'
]);

export type SystemAgentRuntimePolicyPatch = {
  preferredRuntimeType?: RuntimeType | null;
  preferredModelId?: string | null;
  allowedRuntimeTypes?: RuntimeType[];
};

@Injectable()
export class SystemAgentRuntimePolicyService {
  constructor(
    private readonly persistence: PersistenceService,
    private readonly registry: SystemAgentRegistryService
  ) {}

  list() {
    const stored = this.persistence.getCollection<Record<string, SystemAgentRuntimePolicy>>(
      'systemAgentRuntimePolicies',
      {}
    );
    return this.registry.list().map((registration) => stored[registration.role] ?? { role: registration.role });
  }

  get(role: SystemAgentRole) {
    this.registry.getByRole(role);
    return this.list().find((item) => item.role === role)!;
  }

  async update(role: SystemAgentRole, patch: SystemAgentRuntimePolicyPatch) {
    this.registry.getByRole(role);
    const current = this.get(role);
    const allowedRuntimeTypes = patch.allowedRuntimeTypes
      ? [...new Set(patch.allowedRuntimeTypes)]
      : current.allowedRuntimeTypes;
    const preferredRuntimeType = patch.preferredRuntimeType === null
      ? undefined
      : patch.preferredRuntimeType ?? current.preferredRuntimeType;
    const preferredModelId = patch.preferredModelId === null
      ? undefined
      : patch.preferredModelId ?? current.preferredModelId;
    const candidates = [preferredRuntimeType, ...(allowedRuntimeTypes ?? [])].filter(Boolean);
    if (candidates.some((value) => !runtimeTypes.has(value as RuntimeType))) {
      throw new BadRequestException('System Agent Runtime policy contains an unsupported Runtime type.');
    }
    if (preferredRuntimeType && allowedRuntimeTypes?.length && !allowedRuntimeTypes.includes(preferredRuntimeType)) {
      throw new BadRequestException('Preferred Runtime must be present in allowedRuntimeTypes.');
    }
    const updated: SystemAgentRuntimePolicy = {
      ...current,
      preferredRuntimeType,
      preferredModelId,
      role,
      allowedRuntimeTypes,
      updatedAt: new Date().toISOString()
    };
    const stored = Object.fromEntries(this.list().map((item) => [item.role, item]));
    stored[role] = updated;
    await this.persistence.setCollection('systemAgentRuntimePolicies', stored);
    return updated;
  }
}
