import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { ContentReferenceCodec } from '../content-reference-codec.js';
import type { StoredContent } from '../local-content-store.js';

export type PersistedState = Record<string, unknown>;
export type ToolInvocationAuditRecord = {
  externalId: string;
  runtimeInvocationExternalId?: string;
  sessionExternalId?: string;
  toolName: string;
  providerCallId?: string;
  provider?: string;
  mcpServerExternalId?: string;
  arguments: unknown;
  result?: unknown;
  status: 'running' | 'completed' | 'failed';
  errorCode?: string;
  errorMessage?: string;
  agentExternalId?: string;
  authoritySnapshot?: Record<string, unknown>;
  startedAt: string;
  completedAt?: string;
};

export type ToolDefinitionRecord = {
  name: string;
  description: string;
  category: string;
  riskLevel: string;
  inputSchema: Record<string, unknown>;
  provider?: string;
  toolType?: string;
  approvalPolicy?: string;
  capabilityExternalIds?: string[];
};

export type McpObservationRecord = {
  serverExternalId: string;
  serverName?: string;
  toolName: string;
  providerCallId: string;
  runtimeInvocationExternalId?: string;
  sessionExternalId?: string;
  agentExternalId?: string;
  arguments: unknown;
  result?: unknown;
  success: boolean;
  startedAt: string;
  completedAt?: string;
  errorMessage?: string;
};

const KNOWN_COLLECTIONS = new Set([
  'systemDataMetadata',
  'agents',
  'skills',
  'capabilities',
  'workflowCatalog',
  'workflows',
  'sessions',
  'eventsBySession',
  'briefsBySession',
  'suggestedTasksByBriefId',
  'tasksBySession',
  'memoriesBySession',
  'knowledge',
  'artifacts',
  'runtimeInvocationsBySession',
  'runtimeModelConfig',
  'workflowRuntime',
  'autopilots',
  'autopilotRuns',
  'cutoverAudits'
]);

export function assertRelationalCollectionsMapped(state: PersistedState): void {
  const unknown = Object.keys(state).filter((key) => !KNOWN_COLLECTIONS.has(key));
  if (unknown.length) throw new Error(`RELATIONAL_COLLECTIONS_UNMAPPED: ${unknown.join(', ')}`);
}

export function relationalCollectionKeys(): string[] {
  return [...KNOWN_COLLECTIONS].sort();
}

export class RelationalStateStore {
  constructor(
    private readonly pool: Pool,
    private readonly codec: ContentReferenceCodec
  ) {}

  async hasBusinessData(): Promise<boolean> {
    const result = await this.pool.query<{ has_data: boolean }>(`
      select exists (
        select 1 from agent_cluster.agents
        union all select 1 from agent_cluster.skills
        union all select 1 from agent_cluster.capabilities
        union all select 1 from agent_cluster.workflows
        union all select 1 from agent_cluster.sessions
        union all select 1 from agent_cluster.collaboration_events
        union all select 1 from agent_cluster.tasks
        union all select 1 from agent_cluster.memories
        union all select 1 from agent_cluster.knowledge_bases
        union all select 1 from agent_cluster.runtime_invocations
        union all select 1 from agent_cluster.artifacts
        union all select 1 from agent_cluster.workflow_runs
        union all select 1 from agent_cluster.autopilots
        union all select 1 from agent_cluster.cutover_audits
      ) as has_data
    `);
    return result.rows[0]?.has_data === true;
  }

  async loadState(): Promise<PersistedState> {
    const client = await this.pool.connect();
    try {
      return await this.loadStateWithClient(client);
    } finally {
      client.release();
    }
  }

  async writeCollection(key: string, value: unknown): Promise<void> {
    if (!KNOWN_COLLECTIONS.has(key)) throw new Error(`RELATIONAL_COLLECTION_UNMAPPED: ${key}`);
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const externalized = this.codec.externalize(value);
      await this.registerContents(client, externalized.contents);
      await this.writeCollectionWithClient(client, key, externalized.value);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async replaceState(
    state: PersistedState,
    verify?: (loaded: PersistedState) => void | Promise<void>
  ): Promise<void> {
    assertRelationalCollectionsMapped(state);
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const externalized = this.codec.externalize(state);
      await this.registerContents(client, externalized.contents);
      for (const key of collectionWriteOrder(externalized.value)) {
        await this.writeCollectionWithClient(client, key, externalized.value[key]);
      }
      if (verify) await verify(await this.loadStateWithClient(client));
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  private async loadStateWithClient(client: PoolClient): Promise<PersistedState> {
    const state: PersistedState = {};
    await this.loadMetadata(client, state);
    await this.loadCatalogs(client, state);
    await this.loadSessions(client, state);
    await this.loadSessionOwnedData(client, state);
    await this.loadKnowledgeAndArtifacts(client, state);
    await this.loadRuntime(client, state);
    await this.loadWorkflowRuntime(client, state);
    await this.loadAutopilotAndAudits(client, state);
    return this.codec.hydrate(state);
  }

  async writeToolInvocation(input: ToolInvocationAuditRecord): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const externalized = this.codec.externalize({ arguments: input.arguments, result: input.result });
      await this.registerContents(client, externalized.contents);
      const { toolVersionId } = await resolveInvocationTool(client, input);
      const runtimeInvocationId = input.runtimeInvocationExternalId ? await idByExternal(client, 'runtime_invocations', input.runtimeInvocationExternalId) : null;
      const sessionId = input.sessionExternalId ? await idByExternal(client, 'sessions', input.sessionExternalId) : null;
      const mcpServerId = input.mcpServerExternalId ? await idByExternal(client, 'mcp_servers', input.mcpServerExternalId) : null;
      await client.query(
        `insert into agent_cluster.tool_invocations
         (external_id,runtime_invocation_id,session_id,legacy_session_external_id,tool_version_id,unknown_tool_name,mcp_server_id,
          provider_call_id,status,arguments_redacted,result_redacted,result_content_object_id,error_code,error_message,
          started_at,completed_at,duration_ms)
         values ($1,$2,$3,$4,$5,null,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         on conflict (external_id) do update set status=excluded.status,result_redacted=excluded.result_redacted,
           result_content_object_id=excluded.result_content_object_id,error_code=excluded.error_code,
           error_message=excluded.error_message,completed_at=excluded.completed_at,duration_ms=excluded.duration_ms`,
        [input.externalId, runtimeInvocationId, sessionId, sessionId ? null : input.sessionExternalId ?? null,
          toolVersionId, mcpServerId, input.providerCallId ?? input.externalId, input.status,
          json(record(externalized.value).arguments), json(record(externalized.value).result),
          await firstContentId(client, record(externalized.value).result), input.errorCode ?? null, input.errorMessage ?? null,
          input.startedAt, input.completedAt ?? null, duration(input.startedAt, input.completedAt)]
      );
      const invocationId = await idByExternal(client, 'tool_invocations', input.externalId);
      if (invocationId) {
        const authority = input.authoritySnapshot ?? {};
        await client.query(
          `insert into agent_cluster.tool_invocation_authority_snapshots
           (tool_invocation_id,agent_external_id,capability_external_ids,risk_level,approval_required,
            approval_external_id,decision,reason,snapshot)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           on conflict (tool_invocation_id) do update set decision=excluded.decision,reason=excluded.reason,snapshot=excluded.snapshot`,
          [invocationId, input.agentExternalId ?? null, json(authority.capabilityExternalIds ?? []), authority.riskLevel ?? null,
            authority.approvalRequired ?? false, authority.approvalExternalId ?? null,
            authority.decision ?? 'observed', authority.reason ?? null, json(authority)]
        );
      }
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally { client.release(); }
  }

  async writeToolDefinitions(definitions: ToolDefinitionRecord[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      for (const definition of definitions) {
        const externalId = `tool:${definition.provider ?? 'agent-cluster'}:${definition.name}`;
        const toolId = await upsertId(client, 'tools', externalId, {
          tool_key: definition.name,
          name: definition.name,
          description: definition.description,
          tool_type: definition.toolType ?? 'builtin',
          provider: definition.provider ?? 'agent-cluster',
          scope_type: 'system',
          scope_id: null,
          risk_level: definition.riskLevel,
          approval_policy: definition.approvalPolicy ?? (definition.riskLevel === 'high' ? 'user_confirmation' : 'none'),
          status: 'enabled',
          updated_at: new Date().toISOString(),
          deleted_at: null
        });
        const definitionPayload = {
          name: definition.name,
          description: definition.description,
          category: definition.category,
          riskLevel: definition.riskLevel,
          inputSchema: definition.inputSchema,
          provider: definition.provider ?? 'agent-cluster'
        };
        const definitionHash = hash(definitionPayload);
        const versionId = await ensureToolVersion(client, toolId, {
          status: 'published', inputSchema: definition.inputSchema, outputSchema: {},
          executionConfig: { category: definition.category, provider: definition.provider ?? 'agent-cluster' },
          definitionHash, createdAt: new Date().toISOString(), publishedAt: new Date().toISOString()
        });
        await client.query('update agent_cluster.tools set current_version_id=$2,updated_at=now() where id=$1', [toolId, versionId]);
        for (const capabilityExternalId of definition.capabilityExternalIds ?? []) {
          const capabilityId = await idByExternal(client, 'capabilities', capabilityExternalId);
          if (!capabilityId) continue;
          await client.query(
            `insert into agent_cluster.capability_tool_bindings
             (capability_id,tool_version_id,priority,configuration)
             values ($1,$2,0,$3) on conflict (capability_id,tool_version_id) do nothing`,
            [capabilityId, versionId, json({ source: 'runtime-tool-registry' })]
          );
        }
      }
      await this.refreshAgentBindings(client);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async writeMcpObservation(input: McpObservationRecord): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const serverId = await upsertId(client, 'mcp_servers', input.serverExternalId, {
        server_key: input.serverExternalId,
        name: input.serverName ?? input.serverExternalId,
        transport_type: 'runtime_observed',
        endpoint: null,
        command: null,
        arguments: json([]),
        secret_ref: null,
        status: 'enabled',
        updated_at: input.completedAt ?? input.startedAt,
        deleted_at: null
      });
      const toolExternalId = `tool:mcp:${input.serverExternalId}:${input.toolName}`;
      const toolId = await upsertId(client, 'tools', toolExternalId, {
        tool_key: input.toolName,
        name: input.toolName,
        description: null,
        tool_type: 'mcp',
        provider: 'mcp',
        scope_type: 'mcp_server',
        scope_id: input.serverExternalId,
        risk_level: 'medium',
        approval_policy: 'provider_defined',
        status: 'enabled',
        updated_at: input.completedAt ?? input.startedAt,
        deleted_at: null
      });
      const definitionHash = hash({ toolExternalId });
      const versionId = await ensureToolVersion(client, toolId, {
        status: 'observed', inputSchema: {}, outputSchema: {},
        executionConfig: { serverExternalId: input.serverExternalId, observed: true },
        definitionHash, createdAt: input.startedAt, publishedAt: input.startedAt
      });
      await client.query('update agent_cluster.tools set current_version_id=$2 where id=$1', [toolId, versionId]);
      await client.query(
        `insert into agent_cluster.mcp_server_tools
         (mcp_server_id,tool_version_id,provider_tool_name,discovered_at,status)
         values ($1,$2,$3,$4,'active')
         on conflict (mcp_server_id,provider_tool_name) do update set tool_version_id=excluded.tool_version_id,
           discovered_at=excluded.discovered_at,status='active'`,
        [serverId, versionId, input.toolName, input.startedAt]
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
    await this.writeToolInvocation({
      externalId: `mcp:${input.serverExternalId}:${input.providerCallId}`,
      runtimeInvocationExternalId: input.runtimeInvocationExternalId,
      sessionExternalId: input.sessionExternalId,
      toolName: input.toolName,
      providerCallId: input.providerCallId,
      provider: 'mcp',
      mcpServerExternalId: input.serverExternalId,
      arguments: input.arguments,
      result: input.result,
      status: input.success ? 'completed' : 'failed',
      errorMessage: input.errorMessage,
      agentExternalId: input.agentExternalId,
      startedAt: input.startedAt,
      completedAt: input.completedAt
    });
  }

  async markEventPublished(eventExternalId: string): Promise<void> {
    await this.pool.query(
      `update agent_cluster.event_outbox
          set status='published',published_at=now(),attempt_count=attempt_count+1,
              lease_owner=null,lease_expires_at=null,last_error=null
        where external_id=$1 and status<>'published'`,
      [`outbox:${eventExternalId}`]
    );
  }

  private async writeCollectionWithClient(client: PoolClient, key: string, value: unknown): Promise<void> {
    switch (key) {
      case 'systemDataMetadata': return this.writeMetadata(client, record(value));
      case 'agents': return this.writeAgents(client, array(value));
      case 'skills': return this.writeSkills(client, array(value));
      case 'capabilities': return this.writeCapabilities(client, record(value));
      case 'workflowCatalog': return this.writeWorkflowCatalog(client, record(value));
      case 'workflows': return this.writeWorkflowDrafts(client, array(value));
      case 'sessions': return this.writeSessions(client, array(value));
      case 'eventsBySession': return this.writeEvents(client, record(value));
      case 'briefsBySession': return this.writeBriefs(client, record(value));
      case 'suggestedTasksByBriefId': return this.writeSuggestedTasks(client, record(value));
      case 'tasksBySession': return this.writeTasks(client, record(value));
      case 'memoriesBySession': return this.writeMemories(client, record(value));
      case 'knowledge': return this.writeKnowledge(client, record(value));
      case 'artifacts': return this.writeArtifacts(client, record(value));
      case 'runtimeInvocationsBySession': return this.writeRuntimeInvocations(client, record(value));
      case 'runtimeModelConfig': return this.writeRuntimeModelConfig(client, record(value));
      case 'workflowRuntime': return this.writeWorkflowRuntime(client, record(value));
      case 'autopilots': return this.writeAutopilots(client, array(value));
      case 'autopilotRuns': return this.writeAutopilotRuns(client, array(value));
      case 'cutoverAudits': return this.writeCutoverAudits(client, array(value));
      default: throw new Error(`RELATIONAL_COLLECTION_UNMAPPED: ${key}`);
    }
  }

  private async writeMetadata(client: PoolClient, value: Record<string, unknown>) {
    await client.query(
      `insert into agent_cluster.system_data_metadata
       (singleton_key, data_schema_version, pipeline_version, data_epoch, cutover_at, cutover_audit_id, updated_at)
       values ('current', $1, $2, $3, $4, $5, now())
       on conflict (singleton_key) do update set
         data_schema_version=excluded.data_schema_version, pipeline_version=excluded.pipeline_version,
         data_epoch=excluded.data_epoch, cutover_at=excluded.cutover_at,
         cutover_audit_id=excluded.cutover_audit_id, updated_at=now()`,
      [integer(value.dataSchemaVersion, 3), text(value.pipelineVersion, 'v2'), text(value.dataEpoch), date(value.cutoverAt), text(value.cutoverAuditId)]
    );
  }

  private async writeAgents(client: PoolClient, values: unknown[]) {
    const active = new Set<string>();
    for (const item of values.map(record)) {
      const externalId = text(item.id);
      active.add(externalId);
      const agentId = await upsertId(client, 'agents', externalId, {
        agent_key: text(item.key, externalId), name: text(item.name, externalId), description: nullableText(item.description),
        agent_type: text(item.role, 'agent'), scope_type: 'system', scope_id: null, status: text(item.status, 'enabled'),
        updated_at: date(item.updatedAt), deleted_at: null
      });
      const version = integer(item.profileRevision, 1);
      const result = await client.query<{ id: string }>(
        `insert into agent_cluster.agent_versions
         (agent_id, version, status, profile_markdown, system_prompt, runtime_preference, configuration, definition_hash, created_at, published_at)
         values ($1,$2,'published',$3,null,$4,$5,$6,$7,$8)
         on conflict (agent_id, version) do update set profile_markdown=excluded.profile_markdown,
           runtime_preference=excluded.runtime_preference, configuration=excluded.configuration,
           definition_hash=excluded.definition_hash
         returning id::text`,
        [agentId, version, nullableText(item.profileMarkdown), json(item.runtimePreference), json({ sourceRecord: item }), hash(item), date(item.createdAt), date(item.updatedAt)]
      );
      await client.query('update agent_cluster.agents set current_version_id=$2 where id=$1', [agentId, result.rows[0].id]);
    }
    await softDeleteMissing(client, 'agents', active);
    await this.refreshAgentBindings(client);
  }

  private async writeSkills(client: PoolClient, values: unknown[]) {
    const active = new Set<string>();
    for (const item of values.map(record)) {
      const externalId = text(item.id);
      active.add(externalId);
      const skillId = await upsertId(client, 'skills', externalId, {
        skill_key: text(item.key, externalId), name: text(item.name, externalId), description: nullableText(item.description),
        source_type: text(item.sourceType, 'local'), source_uri: nullableText(item.sourceUri), scope_type: 'system', scope_id: null,
        status: text(item.status, 'enabled'), updated_at: date(item.updatedAt), deleted_at: null
      });
      const version = integer(item.revision ?? item.version, 1);
      const result = await client.query<{ id: string }>(
        `insert into agent_cluster.skill_versions
         (skill_id, version, status, content, files_manifest, configuration, definition_hash, created_at, published_at)
         values ($1,$2,'published',$3,$4,$5,$6,$7,$8)
         on conflict (skill_id, version) do update set content=excluded.content, files_manifest=excluded.files_manifest,
           configuration=excluded.configuration, definition_hash=excluded.definition_hash returning id::text`,
        [skillId, version, text(item.content), json(item.files, []), json({ sourceRecord: item }), hash(item), date(item.createdAt), date(item.updatedAt)]
      );
      await client.query('update agent_cluster.skills set current_version_id=$2 where id=$1', [skillId, result.rows[0].id]);
    }
    await softDeleteMissing(client, 'skills', active);
    await this.refreshAgentBindings(client);
  }

  private async writeCapabilities(client: PoolClient, value: Record<string, unknown>) {
    const extensions = record(value.definitionExtensions);
    for (const item of array(value.capabilities).map(record)) {
      const extension = record(extensions[text(item.id)]);
      const capabilityId = await upsertId(client, 'capabilities', text(item.id), {
        capability_key: text(item.key, text(item.id)), kind: text(extension.kind, text(item.kind, 'internal')),
        name: text(item.name, text(item.id)), description_markdown: nullableText(extension.descriptionMarkdown ?? item.description),
        usage_markdown: nullableText(extension.usageMarkdown), input_schema: json(extension.inputSchema), output_schema: json(extension.outputSchema),
        risk_level: text(item.riskLevel, 'low'), status: text(extension.status, 'active'),
        system_owned: boolean(extension.systemOwned, !text(item.id).startsWith('cap-custom-')),
        source_snapshot: json({ sourceRecord: item, definitionExtension: extension }),
        updated_at: date(extension.updatedAt ?? item.updatedAt), deleted_at: null
      });
      const kind = text(extension.kind, text(item.kind, 'internal'));
      if (kind === 'tool' || kind === 'mcp' || text(item.key).startsWith('tool.')) {
        const toolId = await upsertId(client, 'tools', `tool:${text(item.key)}`, {
          tool_key: text(item.key), name: text(item.name, text(item.key)), description: nullableText(item.description),
          tool_type: kind === 'mcp' ? 'mcp' : 'builtin', provider: 'capability', scope_type: 'system', scope_id: null,
          risk_level: text(item.riskLevel, 'low'), approval_policy: text(item.riskLevel) === 'high' ? 'user_confirmation' : 'none',
          status: text(extension.status, 'enabled'), updated_at: date(extension.updatedAt ?? item.updatedAt), deleted_at: null
        });
        const definitionHash = hash(item);
        const toolVersionId = await ensureToolVersion(client, toolId, {
          status: 'published', inputSchema: extension.inputSchema, outputSchema: extension.outputSchema,
          executionConfig: { capabilityExternalId: item.id }, definitionHash,
          createdAt: date(extension.createdAt ?? item.createdAt), publishedAt: date(extension.createdAt ?? item.createdAt)
        });
        await client.query('update agent_cluster.tools set current_version_id=$2 where id=$1', [toolId, toolVersionId]);
        await client.query(
          `insert into agent_cluster.capability_tool_bindings (capability_id,tool_version_id,priority,configuration)
           values ($1,$2,0,'{}'::jsonb) on conflict (capability_id,tool_version_id) do nothing`,
          [capabilityId, toolVersionId]
        );
      }
    }
    for (const approval of array(value.approvals)) {
      const approvalKey = text(approval);
      const capabilityExternalId = approvalKey.split(':').at(-1) ?? approvalKey;
      const capabilityId = await idByExternal(client, 'capabilities', capabilityExternalId);
      if (!capabilityId) continue;
      await client.query(
        `insert into agent_cluster.capability_approvals
         (external_id,capability_id,session_id,agent_external_id,decision,reason,approved_by)
         values ($1,$2,null,null,'approved',$3,'legacy-migration') on conflict (external_id) do nothing`,
        [approvalKey, capabilityId, approvalKey]
      );
    }
    await this.refreshAgentBindings(client);
  }

  private async writeWorkflowCatalog(client: PoolClient, value: Record<string, unknown>) {
    await this.writeWorkflowDrafts(client, array(value.workflows));
    const versionsByWorkflow = record(value.versionsByWorkflowId);
    for (const [workflowExternalId, versions] of Object.entries(versionsByWorkflow)) {
      const workflowId = await idByExternal(client, 'workflows', workflowExternalId);
      if (!workflowId) continue;
      let latestVersionId: string | undefined;
      for (const item of array(versions).map(record)) latestVersionId = await this.writeWorkflowVersion(client, workflowId, item);
      if (latestVersionId) await client.query('update agent_cluster.workflows set current_version_id=$2 where id=$1', [workflowId, latestVersionId]);
    }
  }

  private async writeWorkflowDrafts(client: PoolClient, values: unknown[]) {
    for (const item of values.map(record)) {
      const externalId = text(item.id);
      const workflowId = await upsertId(client, 'workflows', externalId, {
        workflow_key: text(item.key, externalId), name: text(item.name, externalId), description: nullableText(item.description),
        scope_type: 'system', scope_id: null, status: text(item.status, 'draft'), draft_revision: integer(item.draftRevision, 1),
        draft_snapshot: json({ sourceRecord: item }), updated_at: date(item.updatedAt), deleted_at: null
      });
      void workflowId;
    }
  }

  private async writeWorkflowVersion(client: PoolClient, workflowId: string, item: Record<string, unknown>): Promise<string> {
    const result = await client.query<{ id: string }>(
      `insert into agent_cluster.workflow_versions
       (workflow_id,version,status,change_summary,definition_hash,definition_snapshot,created_at,published_at,created_by)
       values ($1,$2,'published',$3,$4,$5,$6,$7,$8)
       on conflict (workflow_id,version) do update set definition_hash=excluded.definition_hash,
         definition_snapshot=excluded.definition_snapshot, published_at=excluded.published_at returning id::text`,
      [workflowId, integer(item.version, 1), nullableText(item.changeSummary), text(item.definitionHash, hash(item)),
        json({ sourceRecord: item }), date(item.createdAt ?? item.publishedAt), date(item.publishedAt), nullableText(item.publishedBy)]
    );
    const workflowVersionId = result.rows[0].id;
    const nodeIds = new Map<string, string>();
    for (const node of array(item.nodes).map(record)) {
      const agentVersionId = node.agentId ? await currentVersionId(client, 'agents', text(node.agentId)) :
        node.reviewerAgentId ? await currentVersionId(client, 'agents', text(node.reviewerAgentId)) : null;
      const nodeResult = await client.query<{ id: string }>(
        `insert into agent_cluster.workflow_nodes
         (workflow_version_id,node_key,name,node_type,agent_version_id,position,execution_config,timeout_ms)
         values ($1,$2,$3,$4,$5,$6,$7,$8)
         on conflict (workflow_version_id,node_key) do update set name=excluded.name,node_type=excluded.node_type,
           agent_version_id=excluded.agent_version_id,position=excluded.position,execution_config=excluded.execution_config,
           timeout_ms=excluded.timeout_ms returning id::text`,
        [workflowVersionId, text(node.id), text(node.name, text(node.title, text(node.id))), text(node.type), agentVersionId,
          integer(node.order, 0), json({ sourceRecord: node }), nullableInteger(node.timeoutMs)]
      );
      nodeIds.set(text(node.id), nodeResult.rows[0].id);
    }
    for (const edge of array(item.edges).map(record)) {
      const from = nodeIds.get(text(edge.sourceNodeId ?? edge.fromNodeId));
      const to = nodeIds.get(text(edge.targetNodeId ?? edge.toNodeId));
      if (!from || !to) continue;
      await client.query(
        `insert into agent_cluster.workflow_edges
         (workflow_version_id,edge_key,from_node_id,to_node_id,transition_type,condition_expression,priority)
         values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (workflow_version_id,edge_key) do update set from_node_id=excluded.from_node_id,
           to_node_id=excluded.to_node_id,transition_type=excluded.transition_type,
           condition_expression=excluded.condition_expression,priority=excluded.priority`,
        [workflowVersionId, text(edge.id), from, to, text(edge.transitionType, 'success'), nullableText(edge.condition), integer(edge.priority, 0)]
      );
    }
    return workflowVersionId;
  }

  private async writeSessions(client: PoolClient, values: unknown[]) {
    const active = new Set<string>();
    for (const item of values.map(record)) {
      const externalId = text(item.id);
      active.add(externalId);
      const previousStatus = await client.query<{ status: string }>(
        'select status from agent_cluster.sessions where external_id=$1',
        [externalId]
      );
      const currentStatus = text(item.status, 'USER_INPUT');
      const sessionId = await upsertId(client, 'sessions', externalId, {
        title: text(item.title, externalId), status: currentStatus, owner_id: text(item.ownerId, 'local-user'),
        project_id: nullableText(item.projectId), context_pipeline_version: text(item.contextPipelineVersion, 'v2'),
        data_epoch: text(item.dataEpoch), revision: integer(item.revision, 1),
        working_directory: item.workingDirectory ? JSON.stringify(item.workingDirectory) : null,
        metadata: json({ sourceRecord: item }), created_at: date(item.createdAt), updated_at: date(item.updatedAt), deleted_at: null
      });
      for (const agentExternalId of array(item.participatingAgentIds).map((value) => text(value))) {
        await client.query(
          `insert into agent_cluster.session_participants
           (session_id,actor_type,actor_external_id,display_name_snapshot,agent_version_id,role)
           values ($1,'agent',$2,$2,$3,'participant')
           on conflict (session_id,actor_type,actor_external_id) do update set agent_version_id=excluded.agent_version_id,left_at=null`,
          [sessionId, agentExternalId, await currentVersionId(client, 'agents', agentExternalId)]
        );
      }
      const fromStatus = previousStatus.rows[0]?.status ?? null;
      if (fromStatus !== currentStatus) {
        await client.query(
          `insert into agent_cluster.session_status_history
           (session_id,from_status,to_status,reason,actor_type,actor_external_id,created_at)
           values ($1,$2,$3,$4,'system','persistence-projection',$5)`,
          [sessionId, fromStatus, currentStatus, nullableText(item.statusReason ?? item.failureReason), date(item.updatedAt ?? item.createdAt)]
        );
      }
      const progress = sessionProgress(currentStatus);
      await client.query(
        `insert into agent_cluster.session_progress
         (session_id,phase,progress_percent,current_task_external_id,blocked_reason,details,updated_at)
         values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (session_id) do update set phase=excluded.phase,progress_percent=excluded.progress_percent,
           current_task_external_id=excluded.current_task_external_id,blocked_reason=excluded.blocked_reason,
           details=excluded.details,updated_at=excluded.updated_at`,
        [sessionId, progress.phase, progress.percent, nullableText(item.currentTaskId),
          nullableText(item.blockedReason ?? item.failureReason),
          json({ status: currentStatus, currentTaskBriefId: item.currentTaskBriefId ?? null, tokenUsed: item.tokenUsed ?? 0 }),
          date(item.updatedAt ?? item.createdAt)]
      );
      await this.writeSupplementalContextRequests(client, sessionId, item);
    }
    await softDeleteMissing(client, 'sessions', active);
  }

  private async writeSupplementalContextRequests(client: PoolClient, sessionId: string, session: Record<string, unknown>) {
    for (const raw of array(session.supplementalContextRequests)) {
      const request = record(raw);
      const requested = record(request.requestedContext);
      const resolution = record(request.resolution);
      const externalId = text(request.id);
      if (!externalId) continue;
      const requestedRefs = array(requested.requestedRefs);
      const requestedPaths = array(requested.requestedPaths);
      const requestedCommands = array(requested.requestedCommands);
      const requestType = requestedPaths.length && requestedCommands.length
        ? 'mixed'
        : requestedCommands.length
          ? 'commands'
          : requestedPaths.length
            ? 'files'
            : requestedRefs.length
              ? 'references'
              : 'general';
      const hydratedPaths = array(resolution.hydratedPaths);
      const failedPaths = array(resolution.failedPaths);
      const deferredPaths = array(resolution.deferredPaths);
      const status = failedPaths.length && !hydratedPaths.length
        ? 'failed'
        : hydratedPaths.length
          ? 'resolved'
          : deferredPaths.length
            ? 'deferred'
            : 'pending';
      const taskExternalId = nullableText(request.taskId);
      const taskId = taskExternalId ? await idByExternal(client, 'tasks', taskExternalId) : null;
      const resolvedAt = status === 'resolved' || status === 'failed' ? date(request.updatedAt ?? request.createdAt) : null;
      await client.query(
        `insert into agent_cluster.supplemental_context_requests
         (external_id,session_id,task_id,runtime_invocation_external_id,request_type,request_payload,status,attempt_count,resolved_at,created_at,updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         on conflict (external_id) do update set task_id=excluded.task_id,
           runtime_invocation_external_id=excluded.runtime_invocation_external_id,request_type=excluded.request_type,
           request_payload=excluded.request_payload,status=excluded.status,attempt_count=excluded.attempt_count,
           resolved_at=excluded.resolved_at,updated_at=excluded.updated_at`,
        [externalId, sessionId, taskId, nullableText(request.runtimeInvocationId ?? request.runtimeInvocationExternalId), requestType,
          json({ requestedContext: requested, resolution, agentId: request.agentId }), status,
          integer(request.attemptCount ?? request.attempt, 1), resolvedAt, date(request.createdAt), date(request.updatedAt ?? request.createdAt)]
      );
    }
  }

  private async writeEvents(client: PoolClient, value: Record<string, unknown>) {
    for (const [sessionExternalId, events] of Object.entries(value)) {
      const sessionId = await idByExternal(client, 'sessions', sessionExternalId);
      if (!sessionId) continue;
      let sequence = 0;
      for (const item of array(events).map(record)) {
        sequence += 1;
        const actor = record(item.actor);
        const eventExternalId = text(item.id);
        await client.query(
          `insert into agent_cluster.collaboration_events
           (external_id,session_id,session_seq,event_type,actor_type,actor_external_id,actor_display_name,
            content,payload,correlation_id,causation_id,created_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           on conflict (external_id) do update set content=excluded.content,payload=excluded.payload`,
          [eventExternalId, sessionId, sequence, text(item.type), text(actor.type, item.fromAgentId ? 'agent' : 'system'),
            nullableText(actor.id ?? item.fromAgentId), nullableText(actor.displayName), nullableText(item.content),
            json({ sourceRecord: item }), nullableText(item.correlationId), nullableText(item.causationId), date(item.createdAt)]
        );
        await client.query(
          `insert into agent_cluster.event_outbox
           (external_id,aggregate_type,aggregate_external_id,event_type,payload,idempotency_key,status,created_at)
           values ($1,'session',$2,$3,$4,$5,'pending',$6)
           on conflict (idempotency_key) do nothing`,
          [`outbox:${eventExternalId}`, sessionExternalId, text(item.type), json({ event: item }), `session:${sessionExternalId}:event:${eventExternalId}`, date(item.createdAt)]
        );
      }
    }
  }

  private async writeBriefs(client: PoolClient, value: Record<string, unknown>) {
    for (const [sessionExternalId, briefs] of Object.entries(value)) {
      const sessionId = await idByExternal(client, 'sessions', sessionExternalId);
      if (!sessionId) continue;
      for (const item of array(briefs).map(record)) {
        await client.query(
          `insert into agent_cluster.briefs
           (external_id,session_id,title,goal,scope,constraints,acceptance_criteria,source_snapshot,
            confirmed_by_user,confirmed_at,created_at,updated_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           on conflict (external_id) do update set title=excluded.title,goal=excluded.goal,scope=excluded.scope,
             constraints=excluded.constraints,acceptance_criteria=excluded.acceptance_criteria,
             source_snapshot=excluded.source_snapshot,confirmed_by_user=excluded.confirmed_by_user,
             confirmed_at=excluded.confirmed_at,updated_at=excluded.updated_at`,
          [text(item.id), sessionId, text(item.title, 'Task Brief'), text(item.goal), json(item.scope), json(item.constraints),
            json(item.acceptanceCriteria), json({ sourceRecord: item }), boolean(item.confirmedByUser),
            nullableDate(item.confirmedAt), date(item.createdAt), date(item.updatedAt ?? item.createdAt)]
        );
      }
    }
  }

  private async writeSuggestedTasks(client: PoolClient, value: Record<string, unknown>) {
    for (const [briefExternalId, tasks] of Object.entries(value)) {
      const briefId = await idByExternal(client, 'briefs', briefExternalId);
      let position = 0;
      for (const item of array(tasks).map(record)) {
        position += 1;
        const suggestedExternalId = text(item.id, `suggested:${briefExternalId}:${position}`);
        await client.query(
          `insert into agent_cluster.suggested_tasks
           (external_id,brief_id,legacy_brief_external_id,title,description,suggested_agent_external_id,priority,dependencies,source_snapshot,created_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           on conflict (external_id) do update set title=excluded.title,description=excluded.description,
             suggested_agent_external_id=excluded.suggested_agent_external_id,priority=excluded.priority,
             dependencies=excluded.dependencies,source_snapshot=excluded.source_snapshot`,
          [suggestedExternalId, briefId, briefId ? null : briefExternalId, text(item.title), nullableText(item.description), nullableText(item.agentId ?? item.suggestedAgentId),
            integer(item.priority, 0), json(item.dependencies), json({ sourceRecord: item }), date(item.createdAt)]
        );
      }
    }
  }

  private async writeTasks(client: PoolClient, value: Record<string, unknown>) {
    for (const [sessionExternalId, tasks] of Object.entries(value)) {
      const sessionId = await idByExternal(client, 'sessions', sessionExternalId);
      if (!sessionId) continue;
      for (const item of array(tasks).map(record)) {
        const assignee = record(item.assignee);
        await client.query(
          `insert into agent_cluster.tasks
           (external_id,session_id,brief_id,title,description,status,assignee_type,assignee_external_id,
            agent_version_id,priority,dependencies,acceptance_criteria,result_summary,source_snapshot,revision,
            created_at,updated_at,completed_at,deleted_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,null)
           on conflict (external_id) do update set title=excluded.title,description=excluded.description,status=excluded.status,
             assignee_type=excluded.assignee_type,assignee_external_id=excluded.assignee_external_id,
             agent_version_id=excluded.agent_version_id,priority=excluded.priority,dependencies=excluded.dependencies,
             acceptance_criteria=excluded.acceptance_criteria,result_summary=excluded.result_summary,
             source_snapshot=excluded.source_snapshot,revision=excluded.revision,updated_at=excluded.updated_at,
             completed_at=excluded.completed_at,deleted_at=null`,
          [text(item.id), sessionId, item.briefId ? await idByExternal(client, 'briefs', text(item.briefId)) : null,
            text(item.title), nullableText(item.description), text(item.status), nullableText(assignee.type),
            nullableText(assignee.id ?? item.assigneeId), await currentVersionId(client, 'agents', text(assignee.id ?? item.assigneeId)),
            integer(item.priority, 0), json(item.dependencies), json(item.acceptanceCriteria), nullableText(item.resultSummary),
            json({ sourceRecord: item }), integer(item.revision, 1), date(item.createdAt), date(item.updatedAt), nullableDate(item.completedAt)]
        );
      }
    }
  }

  private async writeMemories(client: PoolClient, value: Record<string, unknown>) {
    for (const [sessionExternalId, memories] of Object.entries(value)) {
      const sessionId = await idByExternal(client, 'sessions', sessionExternalId);
      for (const item of array(memories).map(record)) {
        await client.query(
          `insert into agent_cluster.memories
           (external_id,session_id,scope,content,status,source_event_external_id,confirmed_by,confirmed_at,
            metadata,created_at,updated_at,deleted_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,null)
           on conflict (external_id) do update set scope=excluded.scope,content=excluded.content,status=excluded.status,
             confirmed_by=excluded.confirmed_by,confirmed_at=excluded.confirmed_at,metadata=excluded.metadata,
             updated_at=excluded.updated_at,deleted_at=null`,
          [text(item.id), sessionId, text(item.scope, 'session'), text(item.content), text(item.status, 'active'),
            nullableText(item.sourceEventId), nullableText(item.confirmedBy), nullableDate(item.confirmedAt),
            json({ sourceRecord: item }), date(item.createdAt), date(item.updatedAt)]
        );
      }
    }
  }

  private async registerContents(client: PoolClient, contents: StoredContent[]) {
    for (const content of contents) {
      const [storagePath, originalName] = content.storagePath.split('#', 2);
      await client.query(
        `insert into agent_cluster.content_objects
         (external_id,sha256,size_bytes,media_type,storage_type,storage_path,original_name,integrity_status,last_verified_at)
         values ($1,$2,$3,$4,'local_content',$5,$6,'verified',now())
         on conflict (sha256,storage_type) do update set last_verified_at=now(),integrity_status='verified'`,
        [content.contentRef, content.sha256, content.sizeBytes, content.mediaType, storagePath, originalName ? decodeURIComponent(originalName) : null]
      );
    }
  }

  private async refreshAgentBindings(client: PoolClient): Promise<void> {
    const agents = await client.query<{ agent_version_id: string; source: unknown }>(`
      select av.id::text agent_version_id, av.configuration->'sourceRecord' source
        from agent_cluster.agents a
        join agent_cluster.agent_versions av on av.id=a.current_version_id
       where a.deleted_at is null
    `);
    for (const row of agents.rows) {
      const source = record(row.source);
      await client.query('delete from agent_cluster.agent_skill_bindings where agent_version_id=$1', [row.agent_version_id]);
      await client.query('delete from agent_cluster.agent_tool_bindings where agent_version_id=$1', [row.agent_version_id]);
      await client.query('delete from agent_cluster.agent_knowledge_bindings where agent_version_id=$1', [row.agent_version_id]);

      let injectionOrder = 0;
      const profileMarkdown = text(source.profileMarkdown);
      for (const match of profileMarkdown.matchAll(/\$\{skill:([^}]+)\}/g)) {
        const skill = await client.query<{ id: string }>(
          `select current_version_id::text id from agent_cluster.skills
            where skill_key=$1 and deleted_at is null and current_version_id is not null`,
          [match[1]]
        );
        if (!skill.rows[0]?.id) continue;
        await client.query(
          `insert into agent_cluster.agent_skill_bindings
           (agent_version_id,skill_version_id,injection_order,required,configuration)
           values ($1,$2,$3,true,$4) on conflict (agent_version_id,skill_version_id) do update set injection_order=excluded.injection_order`,
          [row.agent_version_id, skill.rows[0].id, injectionOrder, json({ source: 'profile-placeholder' })]
        );
        injectionOrder += 1;
      }

      const capabilityIds = array(source.capabilityIds).map((value) => text(value)).filter(Boolean);
      if (capabilityIds.length > 0) {
        const tools = await client.query<{ tool_version_id: string; capability_external_id: string }>(
          `select distinct ctb.tool_version_id::text,c.external_id capability_external_id
             from agent_cluster.capabilities c
             join agent_cluster.capability_tool_bindings ctb on ctb.capability_id=c.id
            where c.external_id=any($1::text[]) and c.deleted_at is null`,
          [capabilityIds]
        );
        for (const tool of tools.rows) {
          await client.query(
            `insert into agent_cluster.agent_tool_bindings
             (agent_version_id,tool_version_id,authority_policy)
             values ($1,$2,$3) on conflict (agent_version_id,tool_version_id) do update set authority_policy=excluded.authority_policy`,
            [row.agent_version_id, tool.tool_version_id, json({ capabilityExternalId: tool.capability_external_id })]
          );
        }
      }

      let priority = 0;
      for (const knowledgeExternalId of array(source.defaultKnowledgeBaseIds).map((value) => text(value)).filter(Boolean)) {
        const knowledgeBaseId = await idByExternal(client, 'knowledge_bases', knowledgeExternalId);
        if (!knowledgeBaseId) continue;
        await client.query(
          `insert into agent_cluster.agent_knowledge_bindings
           (agent_version_id,knowledge_base_id,priority)
           values ($1,$2,$3) on conflict (agent_version_id,knowledge_base_id) do update set priority=excluded.priority`,
          [row.agent_version_id, knowledgeBaseId, priority]
        );
        priority -= 1;
      }
    }
  }

  private async writeKnowledge(client: PoolClient, value: Record<string, unknown>) {
    const bases = record(value.knowledgeBases);
    const documentsByBase = record(value.documentsByBase);
    const chunksByBase = record(value.chunksByBase);
    for (const [baseExternalId, rawBase] of Object.entries(bases)) {
      const base = record(rawBase);
      const baseId = await upsertId(client, 'knowledge_bases', baseExternalId, {
        name: text(base.name, baseExternalId), description: nullableText(base.description), scope_type: text(base.scope, 'global'),
        scope_id: nullableText(base.projectId ?? base.sessionId ?? base.agentId ?? base.roleType), owner_id: text(base.ownerId, 'local-user'),
        visibility: text(base.visibility, 'private'), embedding_model: text(base.embeddingModel, 'local-keyword-search'),
        source_snapshot: json({ sourceRecord: base }), updated_at: date(base.updatedAt), deleted_at: null
      });
      for (const rawDocument of array(documentsByBase[baseExternalId])) {
        const item = record(rawDocument);
        await client.query(
          `insert into agent_cluster.knowledge_documents
           (external_id,knowledge_base_id,title,source_type,source_uri,content_object_id,status,source_snapshot,created_at,updated_at,deleted_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,null)
           on conflict (external_id) do update set title=excluded.title,source_type=excluded.source_type,
             source_uri=excluded.source_uri,content_object_id=excluded.content_object_id,status=excluded.status,
             source_snapshot=excluded.source_snapshot,updated_at=excluded.updated_at,deleted_at=null`,
          [text(item.id), baseId, text(item.title), text(item.sourceType), nullableText(item.sourceUri),
            await firstContentId(client, item), text(item.status, 'ready'), json({ sourceRecord: item }), date(item.createdAt), date(item.updatedAt)]
        );
      }
      let position = 0;
      for (const rawChunk of array(chunksByBase[baseExternalId])) {
        const item = record(rawChunk);
        position += 1;
        const documentId = await idByExternal(client, 'knowledge_documents', text(item.documentId));
        if (!documentId) continue;
        await client.query(
          `insert into agent_cluster.knowledge_chunks
           (external_id,knowledge_document_id,position,snippet,normalized_text,embedding_ref,metadata,source_snapshot)
           values ($1,$2,$3,$4,$5,$6,$7,$8)
           on conflict (external_id) do update set position=excluded.position,snippet=excluded.snippet,
             normalized_text=excluded.normalized_text,embedding_ref=excluded.embedding_ref,
             metadata=excluded.metadata,source_snapshot=excluded.source_snapshot`,
          [text(item.chunkId ?? item.id), documentId, integer(item.position, position), text(item.snippet),
            text(item.normalizedText, text(item.snippet).toLowerCase()), nullableText(item.embeddingRef), json(item.metadata), json({ sourceRecord: item })]
        );
      }
    }
    await this.refreshAgentBindings(client);
  }

  private async writeArtifacts(client: PoolClient, value: Record<string, unknown>) {
    for (const rawArtifact of Object.values(record(value.artifactsById))) {
      const item = record(rawArtifact);
      await client.query(
        `insert into agent_cluster.artifacts
         (external_id,session_id,legacy_session_external_id,task_id,runtime_invocation_id,artifact_type,title,summary,content_object_id,
          metadata,status,created_at,updated_at,deleted_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active',$11,$12,null)
         on conflict (external_id) do update set title=excluded.title,summary=excluded.summary,
           content_object_id=excluded.content_object_id,metadata=excluded.metadata,updated_at=excluded.updated_at,deleted_at=null`,
        [text(item.id), await idByExternal(client, 'sessions', text(item.sessionId)), text(item.sessionId),
          item.taskId ? await idByExternal(client, 'tasks', text(item.taskId)) : null,
          item.invocationId ? await idByExternal(client, 'runtime_invocations', text(item.invocationId)) : null,
          text(item.type), text(item.title), nullableText(item.contentSummary), await firstContentId(client, item),
          json({ sourceRecord: item }), date(item.createdAt), date(item.updatedAt ?? item.createdAt)]
      );
      const artifactId = await idByExternal(client, 'artifacts', text(item.id));
      if (!artifactId) continue;
      const changes = collectFileChanges(item);
      let position = 0;
      for (const change of changes) {
        position += 1;
        await client.query(
          `insert into agent_cluster.artifact_file_changes
           (artifact_id,position,operation,path,previous_path,before_sha256,after_sha256,content_object_id,applied_status)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           on conflict (artifact_id,position) do update set operation=excluded.operation,path=excluded.path,
             previous_path=excluded.previous_path,before_sha256=excluded.before_sha256,after_sha256=excluded.after_sha256,
             content_object_id=excluded.content_object_id,applied_status=excluded.applied_status`,
          [artifactId, position, text(change.operation, 'update'), text(change.path ?? change.toPath), nullableText(change.previousPath ?? change.fromPath),
            hashValue(change.expectedHash ?? change.beforeHash), hashValue(change.afterHash), await firstContentId(client, change),
            text(change.appliedStatus, 'proposed')]
        );
      }
    }
  }

  private async writeRuntimeModelConfig(client: PoolClient, value: Record<string, unknown>) {
    if (!Object.keys(value).length) return;
    const externalId = text(value.id, 'runtime-model:default');
    await upsertId(client, 'runtime_model_configs', externalId, {
      name: text(value.name, 'Default Runtime Model'), provider: text(value.provider, 'unknown'), model: text(value.model, 'unknown'),
      model_kind: text(value.kind ?? value.modelKind, 'remote'), base_url: nullableText(value.baseUrl),
      secret_ref: nullableText(value.secretRef ?? value.apiKeyEncrypted), configuration: json({ sourceRecord: value }),
      status: text(value.status, 'enabled'), updated_at: date(value.updatedAt), deleted_at: null
    });
  }

  private async writeRuntimeInvocations(client: PoolClient, value: Record<string, unknown>) {
    for (const [sessionExternalId, invocations] of Object.entries(value)) {
      const sessionId = await idByExternal(client, 'sessions', sessionExternalId);
      for (const rawInvocation of array(invocations)) {
        const item = record(rawInvocation);
        const profile = record(item.profileSnapshot);
        await client.query(
          `insert into agent_cluster.runtime_invocations
           (external_id,session_id,legacy_session_external_id,task_id,agent_version_id,runtime_type,
            runtime_model_config_id,status,context_envelope,profile_snapshot,result_summary,system_evidence,usage,
            error_code,error_message,started_at,completed_at,updated_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
           on conflict (external_id) do update set status=excluded.status,context_envelope=excluded.context_envelope,
             profile_snapshot=excluded.profile_snapshot,result_summary=excluded.result_summary,
             system_evidence=excluded.system_evidence,usage=excluded.usage,error_code=excluded.error_code,
             error_message=excluded.error_message,completed_at=excluded.completed_at,updated_at=excluded.updated_at`,
          [text(item.invocationId ?? item.id), sessionId, sessionId ? null : sessionExternalId,
            item.taskId ? await idByExternal(client, 'tasks', text(item.taskId)) : null,
            await currentVersionId(client, 'agents', text(item.agentId ?? profile.agentId)), text(item.runtimeType, 'unknown'),
            null, text(item.status), json(item.contextEnvelope ?? record(item.plan).contextEnvelope),
            json({ ...profile, sourceRecord: item }), nullableText(item.resultSummary ?? record(item.output).summary),
            json(item.systemEvidence), json(item.usage), nullableText(record(item.error).code), nullableText(record(item.error).message),
            date(item.startedAt), nullableDate(item.completedAt), date(item.updatedAt ?? item.completedAt ?? item.startedAt)]
        );
      }
    }
  }

  private async writeWorkflowRuntime(client: PoolClient, value: Record<string, unknown>) {
    for (const rawRun of array(value.runs)) {
      const item = record(rawRun);
      const workflowId = await idByExternal(client, 'workflows', text(item.workflowId));
      const sessionId = await idByExternal(client, 'sessions', text(item.sessionId));
      if (!workflowId) continue;
      const workflowVersion = await workflowVersionId(client, workflowId, integer(item.workflowVersion, 1));
      if (!workflowVersion) continue;
      await client.query(
        `insert into agent_cluster.workflow_runs
         (external_id,session_id,legacy_session_external_id,workflow_version_id,status,current_node_key,definition_snapshot,revision,started_at,completed_at,updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         on conflict (external_id) do update set status=excluded.status,current_node_key=excluded.current_node_key,
           definition_snapshot=excluded.definition_snapshot,revision=excluded.revision,
           completed_at=excluded.completed_at,updated_at=excluded.updated_at`,
        [text(item.id), sessionId, sessionId ? null : text(item.sessionId), workflowVersion, text(item.status), nullableText(item.currentNodeId),
          json({ sourceRecord: item }), integer(item.revision, 1), date(item.createdAt), nullableDate(item.completedAt), date(item.updatedAt)]
      );
    }
    for (const [runExternalId, rawNodeRuns] of Object.entries(record(value.nodeRunsByRunId))) {
      const runId = await idByExternal(client, 'workflow_runs', runExternalId);
      if (!runId) continue;
      for (const rawNodeRun of array(rawNodeRuns)) {
        const item = record(rawNodeRun);
        const nodeId = await workflowNodeId(client, runId, text(item.nodeId));
        if (!nodeId) continue;
        await client.query(
          `insert into agent_cluster.workflow_node_runs
           (external_id,workflow_run_id,workflow_node_id,attempt,status,runtime_invocation_id,input_snapshot,
            result_snapshot,error_code,error_message,started_at,completed_at,updated_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           on conflict (external_id) do update set status=excluded.status,result_snapshot=excluded.result_snapshot,
             error_code=excluded.error_code,error_message=excluded.error_message,completed_at=excluded.completed_at,updated_at=excluded.updated_at`,
          [text(item.id), runId, nodeId, integer(item.attempt, 1), text(item.status),
            item.invocationId ? await idByExternal(client, 'runtime_invocations', text(item.invocationId)) : null,
            json({ sourceRecord: item, inputRefs: item.inputRefs }), json({ outputRefs: item.outputRefs }),
            nullableText(record(item.error).code), nullableText(record(item.error).message), date(item.startedAt),
            nullableDate(item.completedAt), date(item.updatedAt ?? item.completedAt ?? item.startedAt)]
        );
      }
    }
    for (const [runExternalId, rawApprovals] of Object.entries(record(value.approvalsByRunId))) {
      for (const rawApproval of array(rawApprovals)) {
        const item = record(rawApproval);
        const nodeRunId = await idByExternal(client, 'workflow_node_runs', text(item.nodeRunId ?? item.workflowNodeRunId));
        if (!nodeRunId) continue;
        await client.query(
          `insert into agent_cluster.workflow_approvals
           (external_id,workflow_node_run_id,approval_type,decision,decided_by_type,decided_by_external_id,reason,evidence,created_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict (external_id) do update set decision=excluded.decision,
             reason=excluded.reason,evidence=excluded.evidence`,
          [text(item.id), nodeRunId, text(item.type, 'human'), text(item.decision), text(item.decidedByType, 'user'),
            nullableText(item.decidedBy ?? item.decidedByExternalId), nullableText(item.reason),
            json({ sourceRecord: item, runExternalId }), date(item.createdAt)]
        );
      }
    }
    for (const [runExternalId, rawEffects] of Object.entries(record(value.effectsByRunId))) {
      const runId = await idByExternal(client, 'workflow_runs', runExternalId);
      if (!runId) continue;
      for (const rawEffect of array(rawEffects)) {
        const item = record(rawEffect);
        await client.query(
          `insert into agent_cluster.workflow_effects
           (external_id,workflow_run_id,workflow_node_run_id,effect_type,idempotency_key,payload,status,attempt_count,
            available_at,last_error,created_at,completed_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           on conflict (external_id) do update set payload=excluded.payload,status=excluded.status,
             attempt_count=excluded.attempt_count,last_error=excluded.last_error,completed_at=excluded.completed_at`,
          [text(item.id), runId, item.nodeRunId ? await idByExternal(client, 'workflow_node_runs', text(item.nodeRunId)) : null,
            text(item.type), text(item.idempotencyKey, text(item.id)), json({ sourceRecord: item }), text(item.status, 'pending'),
            integer(item.attempts, 0), date(item.availableAt), nullableText(item.lastError), date(item.createdAt), nullableDate(item.completedAt)]
        );
      }
    }
  }

  private async writeAutopilots(client: PoolClient, values: unknown[]) {
    for (const rawValue of values) {
      const item = record(rawValue);
      await upsertId(client, 'autopilots', text(item.id), {
        name: text(item.name), prompt: text(item.prompt), workflow_version_id: null, schedule: nullableText(item.schedule),
        status: text(item.status), configuration: json({ sourceRecord: item }), updated_at: date(item.updatedAt), deleted_at: null
      });
    }
  }

  private async writeAutopilotRuns(client: PoolClient, values: unknown[]) {
    for (const rawValue of values) {
      const item = record(rawValue);
      const autopilotId = await idByExternal(client, 'autopilots', text(item.autopilotId));
      if (!autopilotId) continue;
      await client.query(
        `insert into agent_cluster.autopilot_runs
         (external_id,autopilot_id,session_id,status,trigger_type,result_summary,source_snapshot,started_at,completed_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         on conflict (external_id) do update set status=excluded.status,result_summary=excluded.result_summary,
           source_snapshot=excluded.source_snapshot,completed_at=excluded.completed_at`,
        [text(item.id), autopilotId, item.sessionId ? await idByExternal(client, 'sessions', text(item.sessionId)) : null,
          text(item.status), text(item.triggerType, 'manual'), nullableText(item.resultSummary), json({ sourceRecord: item }),
          date(item.startedAt ?? item.createdAt), nullableDate(item.completedAt)]
      );
    }
  }

  private async writeCutoverAudits(client: PoolClient, values: unknown[]) {
    for (const rawValue of values) {
      const item = record(rawValue);
      await client.query(
        `insert into agent_cluster.cutover_audits
         (external_id,environment,operator_id,source_epoch,target_epoch,source_revision,status,result,summary,archive_path,created_at,completed_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         on conflict (external_id) do update set status=excluded.status,result=excluded.result,summary=excluded.summary,
           archive_path=excluded.archive_path,completed_at=excluded.completed_at`,
        [text(item.auditId ?? item.id), text(item.environment, 'unknown'), nullableText(item.operator), nullableText(item.sourceEpoch),
          nullableText(item.dataEpoch ?? item.targetEpoch), nullableText(item.sourceRevision), text(item.status, text(item.result, 'completed')),
          nullableText(item.result), json({ sourceRecord: item }), nullableText(item.archivePath), date(item.occurredAt ?? item.createdAt), nullableDate(item.completedAt ?? item.occurredAt)]
      );
    }
  }

  private async loadMetadata(client: PoolClient, state: PersistedState) {
    const result = await client.query<Record<string, unknown>>('select * from agent_cluster.system_data_metadata where singleton_key=\'current\'');
    const row = result.rows[0];
    if (row) state.systemDataMetadata = { dataSchemaVersion: row.data_schema_version, pipelineVersion: row.pipeline_version,
      dataEpoch: row.data_epoch, cutoverAt: iso(row.cutover_at), cutoverAuditId: row.cutover_audit_id };
  }

  private async loadCatalogs(client: PoolClient, state: PersistedState) {
    state.agents = await sourceRecords(client, `select av.configuration->'sourceRecord' value from agent_cluster.agents a join agent_cluster.agent_versions av on av.id=a.current_version_id where a.deleted_at is null order by a.id`);
    state.skills = await sourceRecords(client, `select sv.configuration->'sourceRecord' value from agent_cluster.skills s join agent_cluster.skill_versions sv on sv.id=s.current_version_id where s.deleted_at is null order by s.id`);
    const capabilityRows = await client.query<{ external_id:string; value:unknown; extension:unknown }>(`select external_id,source_snapshot->'sourceRecord' value,source_snapshot->'definitionExtension' extension from agent_cluster.capabilities where deleted_at is null order by id`);
    const capabilities = capabilityRows.rows.map((row) => row.value);
    const approvals = (await client.query<{ reason: string }>('select reason from agent_cluster.capability_approvals where revoked_at is null order by id')).rows.map((row) => row.reason);
    const definitionExtensions = Object.fromEntries(capabilityRows.rows.filter((row) => row.extension && Object.keys(record(row.extension)).length).map((row) => [row.external_id,row.extension]));
    state.capabilities = { capabilities, approvals, definitionExtensions };
    const workflows = await sourceRecords(client, `select draft_snapshot->'sourceRecord' value from agent_cluster.workflows where deleted_at is null order by id`);
    const versionRows = await client.query<{ workflow_id: string; value: unknown }>(`select w.external_id workflow_id,wv.definition_snapshot->'sourceRecord' value from agent_cluster.workflow_versions wv join agent_cluster.workflows w on w.id=wv.workflow_id order by w.id,wv.version`);
    const versionsByWorkflowId = groupRows(versionRows.rows, 'workflow_id');
    state.workflowCatalog = { schemaVersion: 2, workflows, versionsByWorkflowId };
    state.workflows = workflows;
  }

  private async loadSessions(client: PoolClient, state: PersistedState) {
    state.sessions = await sourceRecords(client, `select metadata->'sourceRecord' value from agent_cluster.sessions where deleted_at is null order by created_at`);
  }

  private async loadSessionOwnedData(client: PoolClient, state: PersistedState) {
    state.eventsBySession = await groupedSources(client, `select s.external_id group_id,e.payload->'sourceRecord' value from agent_cluster.collaboration_events e join agent_cluster.sessions s on s.id=e.session_id where s.deleted_at is null order by s.id,e.session_seq`);
    state.briefsBySession = await groupedSources(client, `select s.external_id group_id,b.source_snapshot->'sourceRecord' value from agent_cluster.briefs b join agent_cluster.sessions s on s.id=b.session_id where s.deleted_at is null order by s.id,b.created_at`);
    state.suggestedTasksByBriefId = await groupedSources(client, `select coalesce(b.external_id,t.legacy_brief_external_id) group_id,t.source_snapshot->'sourceRecord' value from agent_cluster.suggested_tasks t left join agent_cluster.briefs b on b.id=t.brief_id order by coalesce(b.external_id,t.legacy_brief_external_id),t.id`);
    state.tasksBySession = await groupedSources(client, `select s.external_id group_id,t.source_snapshot->'sourceRecord' value from agent_cluster.tasks t join agent_cluster.sessions s on s.id=t.session_id where s.deleted_at is null and t.deleted_at is null order by s.id,t.created_at`);
    state.memoriesBySession = await groupedSources(client, `select s.external_id group_id,m.metadata->'sourceRecord' value from agent_cluster.memories m join agent_cluster.sessions s on s.id=m.session_id where s.deleted_at is null and m.deleted_at is null order by s.id,m.created_at`);
  }

  private async loadKnowledgeAndArtifacts(client: PoolClient, state: PersistedState) {
    const bases = await keyedSources(client, `select external_id,source_snapshot->'sourceRecord' value from agent_cluster.knowledge_bases where deleted_at is null`);
    const documents = await groupedSources(client, `select kb.external_id group_id,kd.source_snapshot->'sourceRecord' value from agent_cluster.knowledge_documents kd join agent_cluster.knowledge_bases kb on kb.id=kd.knowledge_base_id where kd.deleted_at is null order by kd.id`);
    const chunks = await groupedSources(client, `select kb.external_id group_id,kc.source_snapshot->'sourceRecord' value from agent_cluster.knowledge_chunks kc join agent_cluster.knowledge_documents kd on kd.id=kc.knowledge_document_id join agent_cluster.knowledge_bases kb on kb.id=kd.knowledge_base_id order by kc.id`);
    state.knowledge = { knowledgeBases: bases, documentsByBase: documents, chunksByBase: chunks };
    const artifactRows = await client.query<{ external_id: string; session_id: string | null; value: unknown }>(`select a.external_id,coalesce(s.external_id,a.legacy_session_external_id) session_id,a.metadata->'sourceRecord' value from agent_cluster.artifacts a left join agent_cluster.sessions s on s.id=a.session_id where a.deleted_at is null order by a.created_at`);
    state.artifacts = { artifactsById: Object.fromEntries(artifactRows.rows.map((row) => [row.external_id, row.value])), artifactIdsBySession: artifactRows.rows.reduce<Record<string,string[]>>((acc,row) => { if(row.session_id)(acc[row.session_id]??=[]).push(row.external_id); return acc; },{}) };
  }

  private async loadRuntime(client: PoolClient, state: PersistedState) {
    state.runtimeInvocationsBySession = await groupedSources(client, `select coalesce(s.external_id,r.legacy_session_external_id) group_id,r.profile_snapshot->'sourceRecord' value from agent_cluster.runtime_invocations r left join agent_cluster.sessions s on s.id=r.session_id order by r.started_at`);
    const model = await client.query<{ value: unknown }>(`select configuration->'sourceRecord' value from agent_cluster.runtime_model_configs where deleted_at is null order by id limit 1`);
    state.runtimeModelConfig = model.rows[0]?.value ?? {};
  }

  private async loadWorkflowRuntime(client: PoolClient, state: PersistedState) {
    const runs = await sourceRecords(client, `select definition_snapshot->'sourceRecord' value from agent_cluster.workflow_runs order by started_at`);
    const nodeRuns = await groupedSources(client, `select wr.external_id group_id,nr.input_snapshot->'sourceRecord' value from agent_cluster.workflow_node_runs nr join agent_cluster.workflow_runs wr on wr.id=nr.workflow_run_id order by nr.id`);
    const approvals = await groupedSources(client, `select wr.external_id group_id,wa.evidence->'sourceRecord' value from agent_cluster.workflow_approvals wa join agent_cluster.workflow_node_runs nr on nr.id=wa.workflow_node_run_id join agent_cluster.workflow_runs wr on wr.id=nr.workflow_run_id order by wa.id`);
    const effects = await groupedSources(client, `select wr.external_id group_id,we.payload->'sourceRecord' value from agent_cluster.workflow_effects we join agent_cluster.workflow_runs wr on wr.id=we.workflow_run_id order by we.id`);
    for (const run of runs.map(record)) {
      const runId = text(run.id);
      if (runId) {
        nodeRuns[runId] ??= [];
        approvals[runId] ??= [];
        effects[runId] ??= [];
      }
    }
    state.workflowRuntime = { schemaVersion: 2, runs, nodeRunsByRunId: nodeRuns, approvalsByRunId: approvals, effectsByRunId: effects };
  }

  private async loadAutopilotAndAudits(client: PoolClient, state: PersistedState) {
    state.autopilots = await sourceRecords(client, `select configuration->'sourceRecord' value from agent_cluster.autopilots where deleted_at is null order by id`);
    state.autopilotRuns = await sourceRecords(client, `select source_snapshot->'sourceRecord' value from agent_cluster.autopilot_runs order by id`);
    state.cutoverAudits = await sourceRecords(client, `select summary->'sourceRecord' value from agent_cluster.cutover_audits order by id`);
  }
}

function collectionWriteOrder(state: PersistedState): string[] {
  const order = ['systemDataMetadata','agents','skills','capabilities','workflowCatalog','workflows','sessions','eventsBySession','briefsBySession','suggestedTasksByBriefId','tasksBySession','memoriesBySession','knowledge','runtimeModelConfig','runtimeInvocationsBySession','artifacts','workflowRuntime','autopilots','autopilotRuns','cutoverAudits'];
  return order.filter((key) => Object.prototype.hasOwnProperty.call(state, key));
}

async function upsertId(client: PoolClient, table: string, externalId: string, values: Record<string, unknown>): Promise<string> {
  const columns = Object.keys(values); const parameters = [externalId, ...Object.values(values)];
  const assignments = columns.map((name) => `${name}=excluded.${name}`).join(',');
  const result = await client.query<{ id: string }>(`insert into agent_cluster.${table} (external_id,${columns.join(',')}) values ($1,${columns.map((_,i)=>`$${i+2}`).join(',')}) on conflict (external_id) do update set ${assignments} returning id::text`, parameters);
  return result.rows[0].id;
}

async function idByExternal(client: PoolClient, table: string, externalId: string): Promise<string | null> { if(!externalId)return null; const result=await client.query<{id:string}>(`select id::text from agent_cluster.${table} where external_id=$1`,[externalId]); return result.rows[0]?.id??null; }
async function currentVersionId(client: PoolClient, table: string, externalId: string): Promise<string | null> { if(!externalId)return null; const result=await client.query<{id:string}>(`select current_version_id::text id from agent_cluster.${table} where external_id=$1`,[externalId]); return result.rows[0]?.id??null; }
async function resolveInvocationTool(
  client: PoolClient,
  input: ToolInvocationAuditRecord
): Promise<{ toolId: string; toolVersionId: string }> {
  const existing = input.mcpServerExternalId
    ? await client.query<{ id: string; current_version_id: string | null }>(
        `select id::text,current_version_id::text from agent_cluster.tools
          where external_id=$1 and deleted_at is null limit 1`,
        [`tool:mcp:${input.mcpServerExternalId}:${input.toolName}`]
      )
    : await client.query<{ id: string; current_version_id: string | null }>(
        `select id::text,current_version_id::text from agent_cluster.tools
          where tool_key=$1 and deleted_at is null
          order by (provider='agent-cluster') desc,(provider='capability') desc,id limit 1`,
        [input.toolName]
      );
  const found = existing.rows[0];
  if (found?.current_version_id) return { toolId: found.id, toolVersionId: found.current_version_id };

  const toolExternalId = input.mcpServerExternalId
    ? `tool:mcp:${input.mcpServerExternalId}:${input.toolName}`
    : `tool:${input.provider ?? 'runtime'}:default:${input.toolName}`;
  const toolId = found?.id ?? await upsertId(client, 'tools', toolExternalId, {
    tool_key: input.toolName, name: input.toolName, description: null,
    tool_type: input.mcpServerExternalId ? 'mcp' : 'runtime_native', provider: input.provider ?? 'runtime',
    scope_type: input.mcpServerExternalId ? 'mcp_server' : 'system', scope_id: input.mcpServerExternalId ?? null,
    risk_level: input.mcpServerExternalId ? 'medium' : 'low', approval_policy: input.mcpServerExternalId ? 'provider_defined' : 'none',
    status: 'enabled', updated_at: input.completedAt ?? input.startedAt, deleted_at: null
  });
  const definitionHash = hash({ name: input.toolName, provider: input.provider, mcpServerExternalId: input.mcpServerExternalId });
  const toolVersionId = await ensureToolVersion(client, toolId, {
    status: input.mcpServerExternalId ? 'observed' : 'published', inputSchema: {}, outputSchema: {},
    executionConfig: { provider: input.provider ?? 'runtime', mcpServerExternalId: input.mcpServerExternalId },
    definitionHash, createdAt: input.startedAt, publishedAt: input.startedAt
  });
  await client.query('update agent_cluster.tools set current_version_id=$2 where id=$1', [toolId, toolVersionId]);
  return { toolId, toolVersionId };
}
type ToolVersionInput = {
  status: 'draft' | 'published' | 'deprecated' | 'observed';
  inputSchema: unknown;
  outputSchema: unknown;
  executionConfig: unknown;
  definitionHash: string;
  createdAt: string;
  publishedAt?: string;
};
async function ensureToolVersion(client: PoolClient, toolId: string, input: ToolVersionInput): Promise<string> {
  await client.query('select pg_advisory_xact_lock(hashtext($1))', [`agent_cluster:tool-version:${toolId}`]);
  const existing = await client.query<{ id: string }>(
    `select id::text from agent_cluster.tool_versions where tool_id=$1 and definition_hash=$2 order by version desc limit 1`,
    [toolId, input.definitionHash]
  );
  if (existing.rows[0]?.id) return existing.rows[0].id;
  const next = await client.query<{ version: number }>(
    `select coalesce(max(version),0)::int + 1 version from agent_cluster.tool_versions where tool_id=$1`,
    [toolId]
  );
  const result = await client.query<{ id: string }>(
    `insert into agent_cluster.tool_versions
     (tool_id,version,status,input_schema,output_schema,execution_config,definition_hash,created_at,published_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id::text`,
    [toolId, next.rows[0]?.version ?? 1, input.status, json(input.inputSchema), json(input.outputSchema),
      json(input.executionConfig), input.definitionHash, input.createdAt, input.publishedAt ?? null]
  );
  return result.rows[0].id;
}
async function workflowVersionId(client: PoolClient, workflowId: string, version: number) { const r=await client.query<{id:string}>('select id::text from agent_cluster.workflow_versions where workflow_id=$1 and version=$2',[workflowId,version]); return r.rows[0]?.id??null; }
async function workflowNodeId(client: PoolClient, runId: string, nodeKey: string) { const r=await client.query<{id:string}>(`select n.id::text from agent_cluster.workflow_runs r join agent_cluster.workflow_nodes n on n.workflow_version_id=r.workflow_version_id where r.id=$1 and n.node_key=$2`,[runId,nodeKey]); return r.rows[0]?.id??null; }
async function softDeleteMissing(client: PoolClient, table: string, active: Set<string>) { if(!active.size){await client.query(`update agent_cluster.${table} set deleted_at=now() where deleted_at is null`);return;} await client.query(`update agent_cluster.${table} set deleted_at=now() where deleted_at is null and not (external_id = any($1::text[]))`,[[...active]]); }
async function firstContentId(client: PoolClient, value: unknown): Promise<string|null> { const ref=findContentRef(value); return ref ? idByExternal(client,'content_objects',ref) : null; }
function findContentRef(value: unknown): string|null { if(Array.isArray(value)){for(const item of value){const found=findContentRef(item);if(found)return found;}return null;} if(!value||typeof value!=='object')return null; const r=value as Record<string,unknown>; if(typeof r.$contentRef==='string')return r.$contentRef; for(const item of Object.values(r)){const found=findContentRef(item);if(found)return found;} return null; }
function collectFileChanges(value: Record<string,unknown>): Record<string,unknown>[] { const found:Record<string,unknown>[]=[]; const visit=(item:unknown,key?:string)=>{if(Array.isArray(item)){if(key==='fileChanges'||key==='changes'||key==='platformProjections') found.push(...item.filter((v):v is Record<string,unknown>=>!!v&&typeof v==='object')); else item.forEach((v)=>visit(v,key));} else if(item&&typeof item==='object') Object.entries(item as Record<string,unknown>).forEach(([k,v])=>visit(v,k));}; visit(value); return found; }
function hashValue(value: unknown): string|null { const r=record(value); return nullableText(r.value ?? value); }
function record(value: unknown): Record<string,unknown> { return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{}; }
function array(value: unknown): unknown[] { return Array.isArray(value)?value:[]; }
function text(value: unknown, fallback=''): string { return typeof value==='string'&&value.length?value:fallback; }
function nullableText(value: unknown): string|null { return typeof value==='string'&&value.length?value:null; }
function integer(value: unknown, fallback=0): number { const n=Number(value); return Number.isInteger(n)?n:fallback; }
function nullableInteger(value: unknown): number|null { const n=Number(value); return Number.isInteger(n)?n:null; }
function boolean(value: unknown, fallback=false): boolean { return typeof value==='boolean'?value:fallback; }
function date(value: unknown): string { return typeof value==='string'&&value?value:new Date().toISOString(); }
function nullableDate(value: unknown): string|null { return typeof value==='string'&&value?value:null; }
function json(value: unknown, fallback: unknown={}): string { return JSON.stringify(value===undefined?fallback:value); }
function sessionProgress(status: string): { phase: string; percent: number } {
  const normalized = status.toUpperCase();
  if (['COMPLETED', 'DELIVERED', 'DONE'].includes(normalized)) return { phase: 'completed', percent: 100 };
  if (['FAILED', 'CANCELLED', 'CANCELED'].includes(normalized)) return { phase: 'terminal', percent: 100 };
  if (normalized.includes('EXECUT')) return { phase: 'execution', percent: 70 };
  if (normalized.includes('REVIEW')) return { phase: 'review', percent: 85 };
  if (normalized.includes('BRIEF') || normalized.includes('DISCUSS')) return { phase: 'planning', percent: 35 };
  if (normalized.includes('WAIT')) return { phase: 'waiting', percent: 50 };
  return { phase: 'intake', percent: 10 };
}
function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function iso(value: unknown): unknown { return value instanceof Date?value.toISOString():value; }
function duration(startedAt:string,completedAt?:string):number|null { if(!completedAt)return null; const value=Date.parse(completedAt)-Date.parse(startedAt); return Number.isFinite(value)&&value>=0?value:null; }
async function sourceRecords(client:PoolClient,sql:string):Promise<unknown[]>{const r=await client.query<{value:unknown}>(sql);return r.rows.map(x=>x.value).filter(v=>v!==null);}
async function groupedSources(client:PoolClient,sql:string):Promise<Record<string,unknown[]>>{const r=await client.query<{group_id:string|null;value:unknown}>(sql);return r.rows.reduce<Record<string,unknown[]>>((a,x)=>{if(x.group_id&&x.value!==null)(a[x.group_id]??=[]).push(x.value);return a;},{});}
async function keyedSources(client:PoolClient,sql:string):Promise<Record<string,unknown>>{const r=await client.query<{external_id:string;value:unknown}>(sql);return Object.fromEntries(r.rows.filter(x=>x.value!==null).map(x=>[x.external_id,x.value]));}
function groupRows(rows:Array<{workflow_id:string;value:unknown}>,key:'workflow_id'):Record<string,unknown[]>{return rows.reduce<Record<string,unknown[]>>((a,x)=>{(a[x[key]]??=[]).push(x.value);return a;},{});}
