import { createHash } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  AgentWorkflowNode,
  HumanApprovalWorkflowNode,
  RobotApprovalWorkflowNode,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowNode,
  WorkflowStatus,
  WorkflowVersion
} from '@agent-cluster/shared';
import { AgentsService } from '../agents/agents.service.js';
import { PersistenceService } from '../persistence/persistence.service.js';

const MAX_NAME_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_NODES = 50;
const CATALOG_KEY = 'workflowCatalog';

type WorkflowCatalogState = {
  schemaVersion: 2;
  workflows: WorkflowDefinition[];
  versionsByWorkflowId: Record<string, WorkflowVersion[]>;
};

export type WorkflowInput = {
  name: string;
  description?: string;
  status?: WorkflowStatus;
  expectedDraftRevision?: number;
  nodes?: WorkflowNode[];
  edges?: WorkflowEdge[];
};

@Injectable()
export class WorkflowsService {
  private readonly workflows = new Map<string, WorkflowDefinition>();
  private readonly versionsByWorkflowId = new Map<string, WorkflowVersion[]>();

  constructor(
    private readonly persistence: PersistenceService,
    private readonly agents: AgentsService
  ) {
    const persistedCatalog = this.persistence.getCollection<WorkflowCatalogState | WorkflowDefinition[] | undefined>(CATALOG_KEY, undefined);
    const catalog = persistedCatalog && !Array.isArray(persistedCatalog) && persistedCatalog.schemaVersion === 2
      ? persistedCatalog
      : undefined;
    const legacyWorkflows = catalog
      ? catalog.workflows
      : Array.isArray(persistedCatalog)
        ? persistedCatalog
        : this.persistence.getCollection<WorkflowDefinition[]>('workflows', []);
    for (const workflow of legacyWorkflows) {
      const normalized = this.normalizeDefinition(this.normalizePersistedDefinition(workflow), false);
      this.workflows.set(normalized.id, normalized);
    }
    for (const [workflowId, versions] of Object.entries(catalog?.versionsByWorkflowId ?? {})) {
      this.versionsByWorkflowId.set(workflowId, versions.map((version) => this.cloneVersion(version)));
    }
    const migratedPublished = this.migrateLegacyPublishedWorkflows();
    if ((!catalog && legacyWorkflows.length) || migratedPublished) this.persist();
  }

  list() {
    return [...this.workflows.values()].sort(
      (left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.name.localeCompare(right.name)
    );
  }

  get(workflowId: string) {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) throw new NotFoundException(`Workflow not found: ${workflowId}`);
    return workflow;
  }

  listVersions(workflowId: string) {
    this.get(workflowId);
    return [...(this.versionsByWorkflowId.get(workflowId) ?? [])].sort((left, right) => right.version - left.version);
  }

  getVersion(workflowId: string, version?: number) {
    const workflow = this.get(workflowId);
    const targetVersion = version ?? workflow.currentPublishedVersion;
    if (!targetVersion) throw new NotFoundException(`Published workflow version not found: ${workflowId}`);
    const result = (this.versionsByWorkflowId.get(workflowId) ?? []).find((item) => item.version === targetVersion);
    if (!result) throw new NotFoundException(`Workflow version not found: ${workflowId}@${targetVersion}`);
    return result;
  }

  create(input: WorkflowInput) {
    const now = new Date().toISOString();
    const requestedStatus = input.status ?? 'draft';
    const workflow = this.normalizeDefinition({
      id: crypto.randomUUID(),
      name: input.name,
      description: input.description,
      status: 'draft',
      draftRevision: 1,
      version: 1,
      nodes: input.nodes ?? [],
      edges: input.edges ?? [],
      createdAt: now,
      updatedAt: now
    });
    this.assertUniqueName(workflow.name);
    this.workflows.set(workflow.id, workflow);
    this.persist();
    if (requestedStatus === 'published') return this.publish(workflow.id, { expectedDraftRevision: workflow.draftRevision });
    if (requestedStatus === 'archived') return this.archive(workflow.id);
    return workflow;
  }

  update(workflowId: string, patch: Partial<WorkflowInput>) {
    const current = this.get(workflowId);
    if (current.status === 'archived') throw new BadRequestException('Archived workflow cannot be edited.');
    if (patch.expectedDraftRevision !== undefined && patch.expectedDraftRevision !== current.draftRevision) {
      throw new ConflictException({
        code: 'WORKFLOW_DRAFT_CONFLICT',
        message: `Workflow draft revision changed: expected ${patch.expectedDraftRevision}, actual ${current.draftRevision}.`
      });
    }
    const updated = this.normalizeDefinition({
      ...current,
      name: patch.name ?? current.name,
      description: patch.description ?? current.description,
      status: current.status === 'published' ? 'published' : (patch.status ?? current.status),
      nodes: patch.nodes ?? current.nodes,
      edges: patch.edges ?? current.edges,
      id: current.id,
      draftRevision: current.draftRevision + 1,
      version: current.draftRevision + 1,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString()
    });
    this.assertUniqueName(updated.name, current.id);
    this.workflows.set(current.id, updated);
    this.persist();
    if (patch.status === 'published') return this.publish(current.id, { expectedDraftRevision: updated.draftRevision });
    if (patch.status === 'archived') return this.archive(current.id);
    return updated;
  }

  publish(workflowId: string, input: { expectedDraftRevision?: number; publishedBy?: string } = {}) {
    const current = this.get(workflowId);
    if (current.status === 'archived') throw new BadRequestException('Archived workflow cannot be published.');
    if (input.expectedDraftRevision !== undefined && input.expectedDraftRevision !== current.draftRevision) {
      throw new ConflictException({
        code: 'WORKFLOW_DRAFT_CONFLICT',
        message: `Workflow draft revision changed: expected ${input.expectedDraftRevision}, actual ${current.draftRevision}.`
      });
    }
    const compiled = this.normalizeDefinition(current);
    this.assertPublishable(compiled);
    const definitionHash = this.definitionHash(compiled);
    const existing = this.listVersions(workflowId).find(
      (version) => version.version === current.currentPublishedVersion && version.definitionHash === definitionHash
    );
    if (existing) {
      const unchanged = { ...current, status: 'published' as const, currentPublishedVersion: existing.version };
      this.workflows.set(workflowId, unchanged);
      this.persist();
      return unchanged;
    }

    const versionNumber = Math.max(0, ...(this.versionsByWorkflowId.get(workflowId) ?? []).map((item) => item.version)) + 1;
    const now = new Date().toISOString();
    const version: WorkflowVersion = {
      id: crypto.randomUUID(),
      workflowId,
      version: versionNumber,
      name: compiled.name,
      description: compiled.description,
      nodes: compiled.nodes.map((node) => this.cloneNode(node)),
      edges: compiled.edges.map((edge) => ({ ...edge })),
      involvedAgentIds: this.involvedAgentIds(compiled.nodes),
      definitionHash,
      publishedBy: input.publishedBy?.trim() || 'local-user',
      publishedAt: now
    };
    this.versionsByWorkflowId.set(workflowId, [...(this.versionsByWorkflowId.get(workflowId) ?? []), version]);
    const published: WorkflowDefinition = {
      ...compiled,
      status: 'published',
      currentPublishedVersion: versionNumber,
      updatedAt: now
    };
    this.workflows.set(workflowId, published);
    this.persist();
    return published;
  }

  archive(workflowId: string) {
    const current = this.get(workflowId);
    const now = new Date().toISOString();
    const archived: WorkflowDefinition = { ...current, status: 'archived', archivedAt: now, updatedAt: now };
    this.workflows.set(workflowId, archived);
    this.persist();
    return archived;
  }

  remove(workflowId: string) {
    const workflow = this.get(workflowId);
    if ((this.versionsByWorkflowId.get(workflowId) ?? []).length) {
      throw new BadRequestException('Published workflow cannot be deleted; archive it instead.');
    }
    this.workflows.delete(workflow.id);
    this.versionsByWorkflowId.delete(workflow.id);
    this.persist();
    return { workflow, removed: true };
  }

  private normalizePersistedDefinition(input: WorkflowDefinition): WorkflowDefinition {
    const draftRevision = Number.isInteger(input.draftRevision) && input.draftRevision > 0
      ? input.draftRevision
      : Math.max(1, input.version ?? 1);
    return {
      ...input,
      draftRevision,
      version: input.version ?? draftRevision,
      nodes: input.nodes ?? [],
      edges: input.edges ?? []
    };
  }

  private migrateLegacyPublishedWorkflows() {
    let migrated = false;
    for (const workflow of this.workflows.values()) {
      if (workflow.status !== 'published' || (this.versionsByWorkflowId.get(workflow.id) ?? []).length) continue;
      const needsExplicitGates = workflow.nodes.length > 0 && workflow.nodes.every((node) => node.type === 'agent');
      const nodes = needsExplicitGates
        ? workflow.nodes.flatMap((node) => [
            this.cloneNode(node),
            {
              id: `${node.id}:legacy-confirm`,
              type: 'human_approval' as const,
              name: '人工确认',
              title: `确认 ${node.name?.trim() || node.id} 输出`,
              instruction: '该确认节点由旧版逐阶段确认语义迁移生成。',
              assignee: 'session_owner' as const,
              allowedDecisions: ['approve', 'revise', 'cancel'] as Array<'approve' | 'revise' | 'cancel'>,
              order: 0
            }
          ])
        : workflow.nodes.map((node) => this.cloneNode(node));
      const normalizedNodes = nodes.map((node, order) => ({ ...node, order }));
      const migratedWorkflow = {
        ...workflow,
        nodes: normalizedNodes,
        edges: this.linearEdges(normalizedNodes),
        currentPublishedVersion: workflow.currentPublishedVersion ?? 1
      };
      const version: WorkflowVersion = {
        id: crypto.randomUUID(),
        workflowId: workflow.id,
        version: migratedWorkflow.currentPublishedVersion,
        name: migratedWorkflow.name,
        description: migratedWorkflow.description,
        nodes: normalizedNodes.map((node) => this.cloneNode(node)),
        edges: migratedWorkflow.edges.map((edge) => ({ ...edge })),
        involvedAgentIds: this.involvedAgentIds(normalizedNodes),
        definitionHash: this.definitionHash(migratedWorkflow),
        publishedBy: 'migration',
        publishedAt: workflow.updatedAt
      };
      this.workflows.set(workflow.id, migratedWorkflow);
      this.versionsByWorkflowId.set(workflow.id, [version]);
      migrated = true;
    }
    return migrated;
  }

  private normalizeDefinition(input: WorkflowDefinition, resolveAgents = true): WorkflowDefinition {
    const name = input.name?.trim();
    const description = input.description?.trim() || undefined;
    if (!name) throw new BadRequestException('Workflow name is required.');
    if (name.length > MAX_NAME_LENGTH) throw new BadRequestException(`Workflow name exceeds ${MAX_NAME_LENGTH} characters.`);
    if (description && description.length > MAX_DESCRIPTION_LENGTH) {
      throw new BadRequestException(`Workflow description exceeds ${MAX_DESCRIPTION_LENGTH} characters.`);
    }
    if (!['draft', 'published', 'archived'].includes(input.status)) {
      throw new BadRequestException(`Invalid workflow status: ${String(input.status)}`);
    }
    if (!Number.isInteger(input.draftRevision) || input.draftRevision < 1) {
      throw new BadRequestException('Workflow draft revision must be a positive integer.');
    }
    const nodes = this.normalizeNodes(input.nodes, resolveAgents);
    return {
      ...input,
      name,
      description,
      nodes,
      edges: this.linearEdges(nodes)
    };
  }

  private normalizeNodes(nodes: WorkflowNode[], resolveAgents: boolean): WorkflowNode[] {
    if (!Array.isArray(nodes)) throw new BadRequestException('Workflow nodes must be an array.');
    if (nodes.length > MAX_NODES) throw new BadRequestException(`Workflow nodes exceed ${MAX_NODES} entries.`);
    const ids = new Set<string>();
    return [...nodes]
      .sort((left, right) => left.order - right.order)
      .map((node, order) => {
        if (!node?.id?.trim()) throw new BadRequestException('Workflow node id is required.');
        if (ids.has(node.id)) throw new BadRequestException(`Duplicate workflow node id: ${node.id}`);
        ids.add(node.id);
        const normalizedName = node.name?.trim();
        const base = {
          id: node.id.trim(),
          order,
          ...(normalizedName ? { name: normalizedName } : {}),
          ...(node.ui ? { ui: { ...node.ui } } : {})
        };
        if (node.type === 'agent') {
          if (!node.agentId?.trim()) throw new BadRequestException('Workflow node agent id is required.');
          const agentId = resolveAgents ? this.agents.getByIdOrKey(node.agentId).id : node.agentId.trim();
          return {
            ...base,
            type: 'agent',
            agentId,
            ...(node.stageDescription?.trim() ? { stageDescription: node.stageDescription.trim() } : {}),
            inputContract: this.stringList(node.inputContract),
            outputContract: this.stringList(node.outputContract)
          } satisfies AgentWorkflowNode;
        }
        if (node.type === 'human_approval') {
          return {
            ...base,
            type: 'human_approval',
            title: node.title?.trim() || node.name?.trim() || '人工确认',
            ...(node.instruction?.trim() ? { instruction: node.instruction.trim() } : {}),
            assignee: 'session_owner',
            allowedDecisions: node.allowedDecisions?.length
              ? Array.from(new Set(node.allowedDecisions))
              : ['approve', 'revise', 'cancel']
          } satisfies HumanApprovalWorkflowNode;
        }
        if (node.type === 'robot_approval') {
          if (!node.reviewerAgentId?.trim()) throw new BadRequestException('Robot approval reviewer Agent is required.');
          const reviewerAgentId = resolveAgents
            ? this.agents.getByIdOrKey(node.reviewerAgentId).id
            : node.reviewerAgentId.trim();
          return {
            ...base,
            type: 'robot_approval',
            reviewerAgentId,
            reviewPrompt: node.reviewPrompt?.trim() || '',
            criteria: this.stringList(node.criteria),
            maxRevisionAttempts: Number.isInteger(node.maxRevisionAttempts) ? node.maxRevisionAttempts : 2,
            fallback: 'human_approval'
          } satisfies RobotApprovalWorkflowNode;
        }
        throw new BadRequestException(`Unsupported workflow node type: ${String((node as { type?: unknown }).type)}`);
      });
  }

  private assertPublishable(workflow: WorkflowDefinition) {
    if (!workflow.nodes.some((node) => node.type === 'agent')) {
      throw new BadRequestException({ code: 'WORKFLOW_VALIDATION_FAILED', message: 'Workflow must contain at least one Agent node.' });
    }
    workflow.nodes.forEach((node, index) => {
      if (node.type === 'agent') {
        if (!node.stageDescription?.trim() || !node.outputContract?.length) {
          throw new BadRequestException({
            code: 'WORKFLOW_VALIDATION_FAILED',
            message: `Agent stage requires a description and at least one output contract: ${node.id}`
          });
        }
        if (index > 0 && !node.inputContract?.length) {
          throw new BadRequestException({
            code: 'WORKFLOW_VALIDATION_FAILED',
            message: `Downstream Agent stage requires at least one input contract: ${node.id}`
          });
        }
      }
      if (node.type !== 'agent' && !workflow.nodes.slice(0, index).some((candidate) => candidate.type === 'agent')) {
        throw new BadRequestException({
          code: 'WORKFLOW_VALIDATION_FAILED',
          message: `Confirmation node requires an upstream Agent: ${node.id}`
        });
      }
      if (node.type === 'robot_approval') {
        if (!node.reviewPrompt || !node.criteria.length) {
          throw new BadRequestException({
            code: 'WORKFLOW_VALIDATION_FAILED',
            message: `Robot approval requires a prompt and criteria: ${node.id}`
          });
        }
        if (node.maxRevisionAttempts < 0 || node.maxRevisionAttempts > 10) {
          throw new BadRequestException({
            code: 'WORKFLOW_VALIDATION_FAILED',
            message: `Robot approval maxRevisionAttempts must be between 0 and 10: ${node.id}`
          });
        }
      }
    });
  }

  private linearEdges(nodes: WorkflowNode[]): WorkflowEdge[] {
    return nodes.slice(0, -1).map((node, index) => ({
      id: `edge:${node.id}:${nodes[index + 1].id}`,
      sourceNodeId: node.id,
      targetNodeId: nodes[index + 1].id
    }));
  }

  private involvedAgentIds(nodes: WorkflowNode[]) {
    return Array.from(new Set(nodes.flatMap((node) => {
      if (node.type === 'agent') return [node.agentId];
      if (node.type === 'robot_approval') return [node.reviewerAgentId];
      return [];
    })));
  }

  private definitionHash(workflow: WorkflowDefinition) {
    const canonical = JSON.stringify({
      name: workflow.name,
      description: workflow.description ?? null,
      nodes: workflow.nodes.map((node) => this.cloneNode(node)),
      edges: workflow.edges.map((edge) => ({ ...edge }))
    });
    return createHash('sha256').update(canonical).digest('hex');
  }

  private cloneNode(node: WorkflowNode): WorkflowNode {
    if (node.type === 'agent') {
      return { ...node, inputContract: [...(node.inputContract ?? [])], outputContract: [...(node.outputContract ?? [])], ui: node.ui ? { ...node.ui } : undefined };
    }
    if (node.type === 'human_approval') {
      return { ...node, allowedDecisions: [...node.allowedDecisions], ui: node.ui ? { ...node.ui } : undefined };
    }
    return { ...node, criteria: [...node.criteria], ui: node.ui ? { ...node.ui } : undefined };
  }

  private cloneVersion(version: WorkflowVersion): WorkflowVersion {
    return {
      ...version,
      nodes: version.nodes.map((node) => this.cloneNode(node)),
      edges: version.edges.map((edge) => ({ ...edge })),
      involvedAgentIds: [...version.involvedAgentIds]
    };
  }

  private assertUniqueName(name: string, exceptId?: string) {
    const normalized = name.toLocaleLowerCase();
    if (this.list().some((workflow) => workflow.id !== exceptId && workflow.name.toLocaleLowerCase() === normalized)) {
      throw new BadRequestException(`Workflow name already exists: ${name}`);
    }
  }

  private stringList(value?: string[]) {
    return Array.from(new Set((value ?? []).map((item) => item.trim()).filter(Boolean)));
  }

  private persist() {
    const state: WorkflowCatalogState = {
      schemaVersion: 2,
      workflows: this.list(),
      versionsByWorkflowId: Object.fromEntries(
        [...this.versionsByWorkflowId.entries()].map(([workflowId, versions]) => [workflowId, versions.map((item) => this.cloneVersion(item))])
      )
    };
    this.persistence.setCollection(CATALOG_KEY, state);
    // Keep the legacy collection readable during the v1/v2 transition.
    this.persistence.setCollection('workflows', state.workflows);
  }
}
