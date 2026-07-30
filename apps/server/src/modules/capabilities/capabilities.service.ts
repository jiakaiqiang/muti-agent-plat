import { BadRequestException, Inject, Injectable, NotFoundException, forwardRef } from '@nestjs/common';
import type { CapabilityDefinition, CapabilityKind, RuntimeCapabilityDefinition } from '@agent-cluster/shared';
import { PersistenceService } from '../persistence/persistence.service.js';
import { AgentsService } from '../agents/agents.service.js';
import { defaultCapabilities } from './default-capabilities.js';

type CapabilityInvocationCheck = {
  sessionId?: string;
  agentId?: string;
  reason?: string;
};

export type CapabilityUpsertInput = {
  key: string;
  kind?: CapabilityKind;
  name: string;
  descriptionMarkdown?: string;
  usageMarkdown?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  riskLevel?: CapabilityDefinition['riskLevel'];
  status?: CapabilityDefinition['status'];
};

/** 审批后触发上层动作的回调（例如：唤醒等待该能力的 Session 任务）。 */
export type CapabilityApprovalListener = (context: {
  sessionId: string;
  capabilityId: string;
  agentId?: string;
}) => Promise<void> | void;

/** 内置能力中可作为 Tool 插入的 key 集合，其余内置能力视为 internal。 */
const defaultToolKeys = new Set(['tool.file_write', 'tool.command_run']);
const defaultCapabilityIds = new Set(defaultCapabilities.map((capability) => capability.id));

@Injectable()
export class CapabilitiesService {
  private readonly capabilities = new Map<string, RuntimeCapabilityDefinition>();
  private readonly definitionExtensions = new Map<string, Partial<CapabilityDefinition>>();
  private readonly approvals = new Set<string>();
  private readonly approvalListeners = new Set<CapabilityApprovalListener>();

  constructor(
    private readonly persistence: PersistenceService,
    @Inject(forwardRef(() => AgentsService)) private readonly agents: AgentsService
  ) {
    const persisted = this.persistence.getCollection<{
      capabilities: RuntimeCapabilityDefinition[];
      approvals: string[];
      definitionExtensions?: Record<string, Partial<CapabilityDefinition>>;
    }>('capabilities', { capabilities: [], approvals: [] });

    for (const capability of [...persisted.capabilities, ...defaultCapabilities]) {
      this.capabilities.set(capability.id, capability);
    }
    for (const approval of persisted.approvals) {
      this.approvals.add(approval);
    }
    for (const [id, extension] of Object.entries(persisted.definitionExtensions ?? {})) {
      this.definitionExtensions.set(id, extension);
    }
    this.persist();
  }

  list() {
    return [...this.capabilities.values()];
  }

  /** 完整能力定义视图：kind/status/systemOwned + 管理扩展字段。 */
  listDefinitions(): CapabilityDefinition[] {
    return this.list().map((capability) => this.toDefinition(capability));
  }

  getDefinition(capabilityId: string): CapabilityDefinition {
    return this.toDefinition(this.get(capabilityId));
  }

  findDefinitionByKey(key: string): CapabilityDefinition | undefined {
    const found = this.list().find((capability) => capability.key === key);
    return found ? this.toDefinition(found) : undefined;
  }

  findDefinitionById(id: string): CapabilityDefinition | undefined {
    const found = this.capabilities.get(id);
    return found ? this.toDefinition(found) : undefined;
  }

  createDefinition(input: CapabilityUpsertInput): CapabilityDefinition {
    const key = input.key?.trim();
    const name = input.name?.trim();
    if (!key) throw new BadRequestException('Capability key is required.');
    if (!name) throw new BadRequestException('Capability name is required.');
    if (this.list().some((capability) => capability.key === key)) {
      throw new BadRequestException(`Capability key already exists: ${key}`);
    }
    const now = new Date().toISOString();
    const id = `cap-custom-${crypto.randomUUID().slice(0, 8)}`;
    const runtimeDefinition: RuntimeCapabilityDefinition = {
      id,
      key,
      name,
      riskLevel: input.riskLevel ?? 'medium',
      description: input.descriptionMarkdown
    };
    this.capabilities.set(id, runtimeDefinition);
    this.definitionExtensions.set(id, {
      kind: input.kind ?? 'tool',
      descriptionMarkdown: input.descriptionMarkdown,
      usageMarkdown: input.usageMarkdown,
      inputSchema: input.inputSchema,
      outputSchema: input.outputSchema,
      // 自定义 Tool 没有执行适配器时只能处于 unconfigured。
      status: input.status === 'disabled' ? 'disabled' : 'unconfigured',
      systemOwned: false,
      createdAt: now,
      updatedAt: now
    });
    this.persist();
    return this.getDefinition(id);
  }

  updateDefinition(capabilityId: string, patch: Partial<CapabilityUpsertInput>): CapabilityDefinition {
    const current = this.get(capabilityId);
    const currentDefinition = this.toDefinition(current);
    if (currentDefinition.systemOwned) {
      const protectedFields: Array<keyof CapabilityUpsertInput> = ['key', 'kind', 'riskLevel'];
      for (const field of protectedFields) {
        if (patch[field] !== undefined) {
          throw new BadRequestException(`System capability field is protected: ${String(field)}`);
        }
      }
    }
    if (patch.key && patch.key !== current.key) {
      throw new BadRequestException('Capability key is immutable.');
    }
    const extension = this.definitionExtensions.get(current.id) ?? {};
    const updatedRuntime: RuntimeCapabilityDefinition = {
      ...current,
      name: patch.name?.trim() || current.name,
      riskLevel: currentDefinition.systemOwned ? current.riskLevel : patch.riskLevel ?? current.riskLevel,
      description: patch.descriptionMarkdown ?? current.description
    };
    this.capabilities.set(current.id, updatedRuntime);
    this.definitionExtensions.set(current.id, {
      ...extension,
      ...(patch.kind !== undefined && !currentDefinition.systemOwned ? { kind: patch.kind } : {}),
      ...(patch.descriptionMarkdown !== undefined ? { descriptionMarkdown: patch.descriptionMarkdown } : {}),
      ...(patch.usageMarkdown !== undefined ? { usageMarkdown: patch.usageMarkdown } : {}),
      ...(patch.inputSchema !== undefined ? { inputSchema: patch.inputSchema } : {}),
      ...(patch.outputSchema !== undefined ? { outputSchema: patch.outputSchema } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      updatedAt: new Date().toISOString()
    });
    this.persist();
    return this.getDefinition(current.id);
  }

  removeDefinition(capabilityId: string) {
    const definition = this.getDefinition(capabilityId);
    if (definition.systemOwned) {
      throw new BadRequestException(`System capability cannot be deleted: ${definition.key}`);
    }
    const referencingAgents = this.referencingAgents(capabilityId);
    if (referencingAgents.length > 0) {
      throw new BadRequestException(
        `Cannot delete capability "${definition.name}": referenced by ${referencingAgents.length} agent(s). ` +
        `Remove references first: ${referencingAgents.map((a) => a.key).join(', ')}`
      );
    }
    this.capabilities.delete(capabilityId);
    this.definitionExtensions.delete(capabilityId);
    this.persist();
    return { removed: true, capability: definition };
  }

  /** 删除前影响分析：引用该 Capability 的 Agent 列表（capabilityIds 绑定或 Markdown 占位符）。 */
  referencingAgents(capabilityId: string) {
    const definition = this.getDefinition(capabilityId);
    const placeholder = `\${tool:${definition.key}}`;
    return this.agents
      .list()
      .filter(
        (agent) =>
          (agent.capabilityIds ?? []).includes(capabilityId) ||
          (agent.profileMarkdown ?? '').includes(placeholder)
      )
      .map((agent) => ({ id: agent.id, key: agent.key, name: agent.name }));
  }

  private toDefinition(capability: RuntimeCapabilityDefinition): CapabilityDefinition {
    const extension = this.definitionExtensions.get(capability.id) ?? {};
    const systemOwned = extension.systemOwned ?? defaultCapabilityIds.has(capability.id);
    const kind: CapabilityKind =
      extension.kind ?? (defaultToolKeys.has(capability.key) ? 'tool' : systemOwned ? 'internal' : 'tool');
    return {
      id: capability.id,
      key: capability.key,
      kind,
      name: capability.name,
      descriptionMarkdown: extension.descriptionMarkdown ?? capability.description,
      usageMarkdown: extension.usageMarkdown,
      inputSchema: extension.inputSchema,
      outputSchema: extension.outputSchema,
      riskLevel: capability.riskLevel,
      status: extension.status ?? 'active',
      systemOwned,
      createdAt: extension.createdAt,
      updatedAt: extension.updatedAt
    };
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

  /** 注册审批完成后的回调（例如 SessionsService 恢复 pending 任务）。 */
  registerApprovalListener(listener: CapabilityApprovalListener) {
    this.approvalListeners.add(listener);
    return () => this.approvalListeners.delete(listener);
  }

  async approve(capabilityId: string, input: CapabilityInvocationCheck) {
    const capability = this.get(capabilityId);
    const approvalKey = this.approvalKey(capability.id, input.sessionId, input.agentId);
    this.approvals.add(approvalKey);
    this.persist();

    if (input.sessionId) {
      for (const listener of this.approvalListeners) {
        try {
          await listener({
            sessionId: input.sessionId,
            capabilityId: capability.id,
            ...(input.agentId ? { agentId: input.agentId } : {})
          });
        } catch (error) {
          // 单个监听器失败不影响审批结果本身；日志由监听器自行处理。
          console.error('[CapabilitiesService] approval listener failed', error);
        }
      }
    }

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
      approvals: [...this.approvals],
      definitionExtensions: Object.fromEntries(this.definitionExtensions)
    });
  }
}
