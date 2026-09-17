import { createHash } from 'node:crypto';
import type { CollaborationEvent } from '@agent-cluster/shared';
import type { Pool, PoolClient } from 'pg';
import { computePersistenceRevision } from '../postgres-cutover-transaction.js';
import { ContentReferenceCodec } from '../content-reference-codec.js';
import type { StoredContent } from '../local-content-store.js';
import {
  RELATIONAL_SCHEMA_NAME,
  RELATIONAL_SCHEMA_V2_TABLES,
  RELATIONAL_SCHEMA_V3_TABLES,
  RELATIONAL_SCHEMA_V4_TABLES,
  RELATIONAL_SCHEMA_V5_TABLES,
  RELATIONAL_SCHEMA_V8_TABLES,
  RELATIONAL_SCHEMA_V9_TABLES,
  RELATIONAL_SCHEMA_V10_TABLES,
  RELATIONAL_TABLES
} from './relational-schema.js';

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

/**
 * Exported so the non-relational projection in `PersistenceService` can drop
 * session-owned collections with exactly the same key set the relational store
 * persists. Keeping one source of truth prevents the two from drifting apart:
 * a key missing here is a session remnant that cannot be forgotten locally.
 */
export const SESSION_KEYED_COLLECTIONS = [
  'sessionLifecyclesBySession',
  'logicalOperationsBySession',
  'sessionStopRequestsBySession',
  'eventsBySession',
  'briefsBySession',
  'tasksBySession',
  'memoriesBySession',
  'runtimeInvocationsBySession',
  'workItemsBySession',
  'decisionRecordsBySession',
  'contextSnapshotsBySession',
  'intentRoutingRecordsBySession',
  'followUpMessagesBySession'
] as const;

const KNOWN_COLLECTIONS = new Set([
  'sessionLifecyclesBySession',
  'logicalOperationsBySession',
  'sessionStopRequestsBySession',
  'systemDataMetadata',
  'agents',
  'skills',
  'capabilities',
  'workflowCatalog',
  'workflows',
  'sessions',
  'fileRevisions',
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
  'localRuntimeDevices',
  'localRuntimeOperationAudits',
  'cutoverAudits',
  'workspaceSessionLeases',
  'workspaceWritebacks',
  'workItemsBySession',
  'decisionRecordsBySession',
  'contextSnapshotsBySession',
  'intentRoutingRecordsBySession',
  'followUpMessagesBySession',
  'eventOutbox',
  'systemAgentRuntimePolicies'
]);

const RETAINED_OPERATIONAL_TABLES = new Set(['migration_runs', 'migration_errors']);
const REPLACEABLE_RELATIONAL_TABLES = [
  ...RELATIONAL_TABLES,
  ...RELATIONAL_SCHEMA_V2_TABLES,
  ...RELATIONAL_SCHEMA_V3_TABLES,
  ...RELATIONAL_SCHEMA_V4_TABLES,
  ...RELATIONAL_SCHEMA_V5_TABLES,
  ...RELATIONAL_SCHEMA_V8_TABLES,
  ...RELATIONAL_SCHEMA_V9_TABLES,
  ...RELATIONAL_SCHEMA_V10_TABLES
]
  .map((definition) => definition.name)
  .filter((name) => !RETAINED_OPERATIONAL_TABLES.has(name))
  .map((name) => {
    if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Unsafe relational table name: ${name}`);
    return `${RELATIONAL_SCHEMA_NAME}.${name}`;
  });
const REPLACE_RELATIONAL_STATE_SQL =
  `truncate table ${REPLACEABLE_RELATIONAL_TABLES.join(', ')} restart identity cascade`;

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

  private async lockCollections(client: PoolClient, keys: string[]) {
    await client.query('select pg_advisory_xact_lock_shared(hashtext($1))', ['agent_cluster:state-mutation']);
    // Event projection writes also insert outbox rows.
    for (const key of [...new Set([...keys, ...(keys.includes('eventsBySession') ? ['eventOutbox'] : [])])].sort()) {
      if (!KNOWN_COLLECTIONS.has(key)) throw new Error(`RELATIONAL_COLLECTION_UNMAPPED: ${key}`);
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [`agent_cluster:collection:${key}`]);
    }
  }

  async mutateCollections<T>(keys: string[], mutator: (draft: PersistedState) => T): Promise<{ result: T; state: PersistedState }> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await this.lockCollections(client, keys);
      const loaded = await this.loadCollectionsWithClient(client, keys);
      const state = Object.fromEntries(keys.filter(key => loaded[key] !== undefined).map(key => [key, loaded[key]]));
      const draft = structuredClone(state);
      const result = mutator(draft);
      if (result && typeof (result as { then?: unknown }).then === 'function') throw new Error('ATOMIC_MUTATOR_MUST_BE_SYNCHRONOUS');
      const changes = Object.fromEntries(Object.entries(draft).filter(([key, value]) => {
        if (!keys.includes(key)) throw new Error(`ATOMIC_MUTATION_OUTSIDE_SCOPE: ${key}`);
        return JSON.stringify(value) !== JSON.stringify(state[key]);
      }));
      for (const key of Object.keys(state)) if (!(key in draft)) throw new Error(`ATOMIC_COLLECTION_DELETE_UNSUPPORTED: ${key}`);
      const externalized = this.codec.externalize(changes);
      await this.registerContents(client, externalized.contents);
      for (const key of collectionWriteOrder(externalized.value)) await this.writeCollectionWithClient(client, key, externalized.value[key]);
      await client.query('commit');
      return { result, state: draft };
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  private async withCollectionLocks<T>(keys: string[], operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await this.lockCollections(client, keys);
      const result = await operation(client);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async writeCollection(key: string, value: unknown): Promise<void> {
    if (!KNOWN_COLLECTIONS.has(key)) throw new Error(`RELATIONAL_COLLECTION_UNMAPPED: ${key}`);
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await this.lockCollections(client, [key]);
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

  async appendEvent(event: CollaborationEvent): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await this.lockCollections(client, ['eventsBySession', 'eventOutbox']);
      const externalized = this.codec.externalize(event);
      await this.registerContents(client, externalized.contents);
      const item = record(externalized.value);
      const sessionExternalId = text(item.sessionId);
      const session = await client.query<{ id: string }>(
        `select id::text id
           from agent_cluster.sessions
          where external_id=$1 and deleted_at is null
          for update`,
        [sessionExternalId]
      );
      const sessionId = session.rows[0]?.id;
      if (!sessionId) {
        throw new Error(`RELATIONAL_EVENT_SESSION_NOT_FOUND: ${sessionExternalId}`);
      }
      const sequence = await client.query<{ next_sequence: string }>(
        `select (coalesce(max(session_seq),0)+1)::text next_sequence
           from agent_cluster.collaboration_events
          where session_id=$1`,
        [sessionId]
      );
      const eventExternalId = text(item.id);
      const actor = record(item.actor);
      await client.query(
        `insert into agent_cluster.collaboration_events
         (external_id,session_id,session_seq,event_type,actor_type,actor_external_id,actor_display_name,
          content,payload,correlation_id,causation_id,created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         on conflict (external_id) do nothing`,
        [eventExternalId, sessionId, sequence.rows[0]?.next_sequence ?? '1', text(item.type),
          text(actor.type, item.fromAgentId ? 'agent' : 'system'), nullableText(actor.id ?? item.fromAgentId),
          nullableText(actor.displayName), nullableText(item.content), json({ sourceRecord: item }),
          nullableText(item.correlationId), nullableText(item.causationId), date(item.createdAt)]
      );
      await client.query(
        `insert into agent_cluster.event_outbox
         (external_id,aggregate_type,aggregate_external_id,event_type,payload,idempotency_key,status,created_at)
         values ($1,'session',$2,$3,$4,$5,'pending',$6)
         on conflict (idempotency_key) do nothing`,
        [`outbox:${eventExternalId}`, sessionExternalId, text(item.type), json({ event: item }),
          `session:${sessionExternalId}:event:${eventExternalId}`, date(item.createdAt)]
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async compareAndSetCollection(key: string, expected: unknown, value: unknown): Promise<void> {
    if (key !== 'fileRevisions') {
      throw new Error(`RELATIONAL_COLLECTION_CAS_UNSUPPORTED: ${key}`);
    }
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await this.lockCollections(client, [key]);
      await client.query('select pg_advisory_xact_lock(hashtext($1))', ['agent_cluster:file-revisions']);
      const current = await this.loadFileRevisionsWithClient(client);
      if (collectionRevision(current) !== collectionRevision(expected)) {
        throw new Error('REVISION_PERSISTENCE_CONFLICT: PostgreSQL file revision state changed in another process.');
      }
      const externalized = this.codec.externalize(value);
      await this.registerContents(client, externalized.contents);
      await this.writeFileRevisions(client, record(externalized.value));
      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async writeCollectionsAtomically(expectedRevision: string, changes: PersistedState, lockKey?: string): Promise<void> {
    assertRelationalCollectionsMapped(changes);
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query('select pg_advisory_xact_lock(hashtext($1))', ['agent_cluster:state-mutation']);
      if (lockKey) await client.query('select pg_advisory_xact_lock(hashtext($1))', [`agent_cluster:${lockKey}`]);
      const current = await this.loadStateWithClient(client);
      if (computePersistenceRevision(current) !== expectedRevision) {
        throw new Error('PERSISTENCE_REVISION_CONFLICT: PostgreSQL state changed before atomic mutation.');
      }
      const externalized = this.codec.externalize(changes);
      await this.registerContents(client, externalized.contents);
      for (const key of collectionWriteOrder(externalized.value)) {
        await this.writeCollectionWithClient(client, key, externalized.value[key]);
      }
      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
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
      await client.query('select pg_advisory_xact_lock(hashtext($1))', ['agent_cluster:state-mutation']);
      await client.query(REPLACE_RELATIONAL_STATE_SQL);
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

  private async loadCollectionsWithClient(client: PoolClient, keys: string[]): Promise<PersistedState> {
    const state: PersistedState = {};
    for (const key of keys) {
      switch (key) {
        case 'agents':
          state.agents = await sourceRecords(client, `select av.configuration->'sourceRecord' value from agent_cluster.agents a join agent_cluster.agent_versions av on av.id=a.current_version_id where a.deleted_at is null order by a.id`);
          break;
        case 'skills':
          state.skills = await sourceRecords(client, `select sv.configuration->'sourceRecord' value from agent_cluster.skills s join agent_cluster.skill_versions sv on sv.id=s.current_version_id where s.deleted_at is null order by s.id`);
          break;
        case 'sessions':
          state.sessions = await sourceRecords(client, `select metadata->'sourceRecord' value from agent_cluster.sessions where deleted_at is null order by created_at`);
          break;
        case 'sessionLifecyclesBySession':
          state.sessionLifecyclesBySession = await keyedSources(client, `select s.external_id,l.source_snapshot->'sourceRecord' value from agent_cluster.session_lifecycles l join agent_cluster.sessions s on s.id=l.session_id order by s.external_id`);
          break;
        case 'eventsBySession':
          state.eventsBySession = await groupedSources(client, `select s.external_id group_id,e.payload->'sourceRecord' value from agent_cluster.collaboration_events e join agent_cluster.sessions s on s.id=e.session_id where s.deleted_at is null order by s.id,e.session_seq`);
          break;
        case 'briefsBySession':
          state.briefsBySession = await groupedSources(client, `select s.external_id group_id,b.source_snapshot->'sourceRecord' value from agent_cluster.briefs b join agent_cluster.sessions s on s.id=b.session_id where s.deleted_at is null order by s.id,b.created_at`);
          break;
        case 'suggestedTasksByBriefId':
          state.suggestedTasksByBriefId = await groupedSources(client, `select b.external_id group_id,t.source_snapshot->'sourceRecord' value from agent_cluster.suggested_tasks t join agent_cluster.briefs b on b.id=t.brief_id join agent_cluster.sessions s on s.id=b.session_id where s.deleted_at is null order by b.external_id,t.id`);
          break;
        case 'tasksBySession':
          state.tasksBySession = await groupedSources(client, `select s.external_id group_id,t.source_snapshot->'sourceRecord' value from agent_cluster.tasks t join agent_cluster.sessions s on s.id=t.session_id where s.deleted_at is null and t.deleted_at is null order by s.id,t.created_at`);
          break;
        case 'memoriesBySession':
          state.memoriesBySession = await groupedSources(client, `select s.external_id group_id,m.metadata->'sourceRecord' value from agent_cluster.memories m join agent_cluster.sessions s on s.id=m.session_id where s.deleted_at is null and m.deleted_at is null order by s.id,m.created_at`);
          break;
        case 'workItemsBySession':
          state.workItemsBySession = await groupedSources(client, `select s.external_id group_id,w.source_snapshot->'sourceRecord' value from agent_cluster.work_items w join agent_cluster.sessions s on s.id=w.session_id where s.deleted_at is null and w.deleted_at is null order by s.id,w.created_at`);
          break;
        case 'decisionRecordsBySession':
          state.decisionRecordsBySession = await groupedSources(client, `select s.external_id group_id,d.source_snapshot->'sourceRecord' value from agent_cluster.decision_records d join agent_cluster.sessions s on s.id=d.session_id where s.deleted_at is null order by s.id,d.created_at`);
          break;
        case 'contextSnapshotsBySession':
          state.contextSnapshotsBySession = await groupedSources(client, `select s.external_id group_id,c.payload->'sourceRecord' value from agent_cluster.context_snapshots c join agent_cluster.sessions s on s.id=c.session_id where s.deleted_at is null order by s.id,c.created_at`);
          break;
        case 'intentRoutingRecordsBySession':
          state.intentRoutingRecordsBySession = await groupedSources(client, `select s.external_id group_id,r.source_snapshot->'sourceRecord' value from agent_cluster.intent_routing_records r join agent_cluster.sessions s on s.id=r.session_id where s.deleted_at is null order by s.id,r.session_seq`);
          break;
        case 'followUpMessagesBySession':
          state.followUpMessagesBySession = await groupedSources(client, `select s.external_id group_id,f.handling_payload->'sourceRecord' value from agent_cluster.session_follow_up_messages f join agent_cluster.sessions s on s.id=f.session_id where s.deleted_at is null order by s.id,f.queued_at`);
          break;
        case 'runtimeInvocationsBySession':
          state.runtimeInvocationsBySession = await groupedSources(client, `select s.external_id group_id,r.profile_snapshot->'sourceRecord' value from agent_cluster.runtime_invocations r join agent_cluster.sessions s on s.id=r.session_id where s.deleted_at is null order by r.started_at`);
          break;
        case 'logicalOperationsBySession':
          state.logicalOperationsBySession = await groupedSources(client, `select s.external_id group_id,o.source_snapshot->'sourceRecord' value from agent_cluster.logical_operations o join agent_cluster.sessions s on s.id=o.session_id where s.deleted_at is null order by o.external_id`);
          break;
        case 'sessionStopRequestsBySession':
          state.sessionStopRequestsBySession = await groupedSources(client, `select s.external_id group_id,r.source_snapshot->'sourceRecord' value from agent_cluster.session_stop_requests r join agent_cluster.sessions s on s.id=r.session_id where s.deleted_at is null order by r.created_at,r.external_id`);
          break;
        case 'localRuntimeDevices':
          state.localRuntimeDevices = await sourceRecords(client, `select source_snapshot->'sourceRecord' value from agent_cluster.local_runtime_devices order by id`);
          break;
        case 'localRuntimeOperationAudits':
          state.localRuntimeOperationAudits = await sourceRecords(client, `select source_snapshot->'sourceRecord' value from agent_cluster.local_runtime_operation_audits order by requested_at,id`);
          break;
        case 'autopilots':
          state.autopilots = await sourceRecords(client, `select configuration->'sourceRecord' value from agent_cluster.autopilots where deleted_at is null order by id`);
          break;
        case 'autopilotRuns':
          state.autopilotRuns = await sourceRecords(client, `select source_snapshot->'sourceRecord' value from agent_cluster.autopilot_runs order by id`);
          break;
        case 'cutoverAudits':
          state.cutoverAudits = await sourceRecords(client, `select summary->'sourceRecord' value from agent_cluster.cutover_audits order by id`);
          break;
        case 'eventOutbox':
          state.eventOutbox = await sourceRecords(client, `select ${eventOutboxRecordSql('outbox')} value from agent_cluster.event_outbox outbox order by id`);
          break;
        default: {
          // Composite catalog projections retain their established loader.
          const full = await this.loadStateWithClient(client);
          for (const requested of keys) if (full[requested] !== undefined) state[requested] = full[requested];
          return state;
        }
      }
    }
    return this.codec.hydrate(state);
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
      await this.lockCollections(client, []);
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
      await this.lockCollections(client, []);
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
      await this.lockCollections(client, []);
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
    await this.withCollectionLocks(['eventOutbox'], client => client.query(
      `update agent_cluster.event_outbox
          set status='published',published_at=now(),
              attempt_count=attempt_count+case when status='publishing' then 0 else 1 end,
              lease_owner=null,lease_expires_at=null,last_error=null
        where external_id=$1 and status<>'published'`,
      [`outbox:${eventExternalId}`]
    ));
  }

  async discardEventOutbox(eventExternalId: string, reason: string): Promise<void> {
    await this.withCollectionLocks(['eventOutbox'], client => client.query(
      `update agent_cluster.event_outbox
          set status='discarded',lease_owner=null,lease_expires_at=null,last_error=$2
        where external_id=$1 and status<>'published'`,
      [`outbox:${eventExternalId}`, reason]
    ));
  }

  async claimPendingEventOutbox(
    workerId: string,
    limit: number,
    leaseMs: number
  ): Promise<Array<Record<string, unknown>>> {
    const result = await this.withCollectionLocks(['eventOutbox'], client => client.query<{ value: Record<string, unknown> }>(
      `with candidates as (
         select id
           from agent_cluster.event_outbox
          where available_at<=now()
            and (status='pending' or (status='publishing' and lease_expires_at<=now()))
          order by id
          for update skip locked
          limit $2
       )
       update agent_cluster.event_outbox as outbox
          set status='publishing',
              attempt_count=outbox.attempt_count+1,
              lease_owner=$1,
              lease_expires_at=now()+($3*interval '1 millisecond'),
              last_error=null
         from candidates
        where outbox.id=candidates.id
       returning ${eventOutboxRecordSql('outbox')} value`,
      [workerId, Math.max(0, limit), Math.max(1, leaseMs)]
    ));
    return result.rows.map((row) => row.value);
  }

  async acquireWorkspaceSessionLease(workspaceId: string, sessionId: string): Promise<{ acquired: boolean; conflictSessionId?: string }> {
    return this.withCollectionLocks(['workspaceSessionLeases'], async client => {
      const result = await client.query<{ session_id: string }>(
        `insert into agent_cluster.workspace_session_leases (workspace_id, session_id, acquired_at)
         values ($1, $2, now())
         on conflict (workspace_id) do nothing
         returning session_id`,
        [workspaceId, sessionId]
      );
      if (result.rows.length > 0) return { acquired: true };
      const existing = await client.query<{ session_id: string }>(
        `select session_id from agent_cluster.workspace_session_leases where workspace_id=$1`,
        [workspaceId]
      );
      return { acquired: false, conflictSessionId: existing.rows[0]?.session_id };
    });
  }

  async releaseWorkspaceSessionLease(workspaceId: string, sessionId: string): Promise<void> {
    await this.withCollectionLocks(['workspaceSessionLeases'], client => client.query(
      `delete from agent_cluster.workspace_session_leases where workspace_id=$1 and session_id=$2`,
      [workspaceId, sessionId]
    ));
  }

  async reconcileWorkspaceSessionLeases(activeSessions: Array<{ workspaceId: string; sessionId: string }>): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await this.lockCollections(client, ['workspaceSessionLeases']);
      const activeMap = new Map(activeSessions.map(s => [s.workspaceId, s.sessionId]));
      const leases = await client.query<{ workspace_id: string; session_id: string }>(
        `select workspace_id, session_id from agent_cluster.workspace_session_leases`
      );
      for (const lease of leases.rows) {
        if (!activeMap.has(lease.workspace_id) || activeMap.get(lease.workspace_id) !== lease.session_id) {
          await client.query(`delete from agent_cluster.workspace_session_leases where workspace_id=$1`, [lease.workspace_id]);
        }
      }
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Physically removes one session and everything it owns.
   *
   * Tables whose session_id is declared `on delete set null` must be deleted
   * explicitly first, otherwise the rows survive as untraceable orphans with a
   * null session_id. `capability_approvals` is the sharpest case: an approval
   * scoped to one session would otherwise read as an unscoped grant.
   * Everything declared `on delete cascade` is left to the foreign key.
   */
  async deleteSessionCascade(sessionExternalId: string): Promise<{ deleted: boolean }> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query('select pg_advisory_xact_lock(hashtext($1))', ['agent_cluster:state-mutation']);
      const found = await client.query<{ id: string }>(
        'select id::text from agent_cluster.sessions where external_id=$1',
        [sessionExternalId]
      );
      const sessionId = found.rows[0]?.id;
      if (!sessionId) {
        await client.query('commit');
        return { deleted: false };
      }
      // Ordered child-before-parent so each delete keeps its own cascade intact.
      await client.query(
        `delete from agent_cluster.tool_invocations
          where session_id=$1
             or runtime_invocation_id in (
                  select id from agent_cluster.runtime_invocations where session_id=$1
                )`,
        [sessionId]
      );
      await client.query('delete from agent_cluster.capability_approvals where session_id=$1', [sessionId]);
      await client.query('delete from agent_cluster.artifacts where session_id=$1', [sessionId]);
      await client.query('delete from agent_cluster.workflow_runs where session_id=$1', [sessionId]);
      await client.query('delete from agent_cluster.autopilot_runs where session_id=$1', [sessionId]);
      await client.query('delete from agent_cluster.runtime_invocations where session_id=$1', [sessionId]);
      // sessions.active_work_item_id references work_items; clear it before the
      // cascade so the parent row can be removed.
      await client.query('update agent_cluster.sessions set active_work_item_id=null where id=$1', [sessionId]);
      await client.query('delete from agent_cluster.sessions where id=$1', [sessionId]);
      await client.query(
        'delete from agent_cluster.workspace_session_leases where session_id=$1',
        [sessionExternalId]
      );
      await client.query(
        'delete from agent_cluster.workspace_writebacks where session_external_id=$1',
        [sessionExternalId]
      );
      await client.query('commit');
      return { deleted: true };
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async writeCollectionWithClient(client: PoolClient, key: string, value: unknown): Promise<void> {
    switch (key) {
      case 'logicalOperationsBySession': return this.writeLogicalOperations(client, record(value));
      case 'sessionLifecyclesBySession': return this.writeSessionLifecycles(client, record(value));
      case 'sessionStopRequestsBySession': return this.writeSessionStopRequests(client, record(value));
      case 'systemDataMetadata': return this.writeMetadata(client, record(value));
      case 'agents': return this.writeAgents(client, array(value));
      case 'skills': return this.writeSkills(client, array(value));
      case 'capabilities': return this.writeCapabilities(client, record(value));
      case 'workflowCatalog': return this.writeWorkflowCatalog(client, record(value));
      case 'workflows': return this.writeWorkflowDrafts(client, array(value));
      case 'sessions': return this.writeSessions(client, array(value));
      case 'fileRevisions': return this.writeFileRevisions(client, record(value));
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
      case 'localRuntimeDevices': return this.writeLocalRuntimeDevices(client, array(value));
      case 'localRuntimeOperationAudits': return this.writeLocalRuntimeOperationAudits(client, array(value));
      case 'cutoverAudits': return this.writeCutoverAudits(client, array(value));
      case 'workspaceSessionLeases': return this.writeWorkspaceSessionLeases(client, record(value));
      case 'workspaceWritebacks': return this.writeWorkspaceWritebacks(client, array(value));
      case 'workItemsBySession': return this.writeWorkItems(client, record(value));
      case 'decisionRecordsBySession': return this.writeDecisionRecords(client, record(value));
      case 'contextSnapshotsBySession': return this.writeContextSnapshots(client, record(value));
      case 'intentRoutingRecordsBySession': return this.writeIntentRoutingRecords(client, record(value));
      case 'followUpMessagesBySession': return this.writeFollowUpMessages(client, record(value));
      case 'eventOutbox': return this.writeEventOutbox(client, array(value));
      case 'systemAgentRuntimePolicies': return this.writeSystemAgentRuntimePolicies(client, record(value));
      default: throw new Error(`RELATIONAL_COLLECTION_UNMAPPED: ${key}`);
    }
  }

  private async writeLogicalOperations(client: PoolClient, value: Record<string, unknown>) {
    for (const [sessionExternalId, operations] of Object.entries(value)) {
      const sessionId = await idByExternal(client, 'sessions', sessionExternalId);
      if (!sessionId) throw new Error('OPERATION_SESSION_NOT_FOUND');
      for (const operation of array(operations).map(record)) {
        await client.query(`insert into agent_cluster.logical_operations (external_id,session_id,source_snapshot)
          values ($1,$2,$3) on conflict (external_id) do update set source_snapshot=excluded.source_snapshot
          where logical_operations.session_id=excluded.session_id`,
        [text(operation.id), sessionId, json({ sourceRecord: operation })]);
      }
    }
  }

  private async writeSessionLifecycles(client: PoolClient, value: Record<string, unknown>) {
    for (const [sessionExternalId, rawLifecycle] of Object.entries(value)) {
      const sessionId = await idByExternal(client, 'sessions', sessionExternalId);
      if (!sessionId) throw new Error('SESSION_LIFECYCLE_SESSION_NOT_FOUND');
      const lifecycle = record(rawLifecycle);
      await client.query(
        `insert into agent_cluster.session_lifecycles
           (session_id,generation,revision,state,admission,stop_status,source_snapshot,updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8)
         on conflict (session_id) do update set
           generation=excluded.generation,revision=excluded.revision,state=excluded.state,
           admission=excluded.admission,stop_status=excluded.stop_status,
           source_snapshot=excluded.source_snapshot,updated_at=excluded.updated_at
         where session_lifecycles.revision <= excluded.revision`,
        [sessionId, integer(lifecycle.generation, 1), integer(lifecycle.revision, 1), text(lifecycle.state),
          text(lifecycle.admission), text(lifecycle.stopStatus), json({ sourceRecord: lifecycle }),
          date(lifecycle.restoredAt ?? lifecycle.deletedAt ?? new Date().toISOString())]
      );
    }
  }

  private async writeSessionStopRequests(client: PoolClient, value: Record<string, unknown>) {
    for (const [sessionExternalId, requests] of Object.entries(value)) {
      const sessionId = await idByExternal(client, 'sessions', sessionExternalId);
      if (!sessionId) throw new Error('STOP_REQUEST_SESSION_NOT_FOUND');
      for (const request of array(requests).map(record)) {
        await client.query(
          `insert into agent_cluster.session_stop_requests
             (external_id,session_id,version,status,source_snapshot,created_at,updated_at)
           values ($1,$2,$3,$4,$5,$6,$7)
           on conflict (external_id) do update set
             version=excluded.version,status=excluded.status,source_snapshot=excluded.source_snapshot,
             updated_at=excluded.updated_at
           where session_stop_requests.session_id=excluded.session_id
             and session_stop_requests.version <= excluded.version`,
          [text(request.id), sessionId, integer(request.version, 1), text(request.status),
            json({ sourceRecord: request }), date(request.createdAt), date(request.updatedAt)]
        );
      }
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
      const activeWorkItemId = item.activeWorkItemId
        ? await idByExternal(client, 'work_items', text(item.activeWorkItemId))
        : null;
      const sessionId = await upsertId(client, 'sessions', externalId, {
        title: text(item.title, externalId), status: currentStatus, owner_id: text(item.ownerId, 'local-user'),
        project_id: nullableText(item.projectId), context_pipeline_version: text(item.contextPipelineVersion, 'v2'),
        data_epoch: text(item.dataEpoch), revision: integer(item.revision, 1),
        active_work_item_id: activeWorkItemId,
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
      const requestedPaths = [
        ...array(requested.requestedFiles).map((item) => text(record(item).path)).filter(Boolean),
        ...array(requested.requestedPaths)
      ];
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
           (external_id,session_id,work_item_id,title,goal,scope,constraints,acceptance_criteria,source_snapshot,
            confirmed_by_user,confirmed_at,created_at,updated_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           on conflict (external_id) do update set title=excluded.title,goal=excluded.goal,scope=excluded.scope,
             constraints=excluded.constraints,acceptance_criteria=excluded.acceptance_criteria,
             source_snapshot=excluded.source_snapshot,confirmed_by_user=excluded.confirmed_by_user,
             confirmed_at=excluded.confirmed_at,work_item_id=excluded.work_item_id,updated_at=excluded.updated_at`,
          [text(item.id), sessionId, item.workItemId ? await idByExternal(client, 'work_items', text(item.workItemId)) : null,
            text(item.title, 'Task Brief'), text(item.goal), json(item.scope), json(item.constraints),
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
           (external_id,session_id,work_item_id,brief_id,title,description,status,assignee_type,assignee_external_id,
            agent_version_id,priority,dependencies,acceptance_criteria,result_summary,source_snapshot,revision,
            created_at,updated_at,completed_at,deleted_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,null)
           on conflict (external_id) do update set title=excluded.title,description=excluded.description,status=excluded.status,
             assignee_type=excluded.assignee_type,assignee_external_id=excluded.assignee_external_id,
             agent_version_id=excluded.agent_version_id,priority=excluded.priority,dependencies=excluded.dependencies,
             acceptance_criteria=excluded.acceptance_criteria,result_summary=excluded.result_summary,
             source_snapshot=excluded.source_snapshot,revision=excluded.revision,updated_at=excluded.updated_at,
             completed_at=excluded.completed_at,work_item_id=excluded.work_item_id,deleted_at=null`,
          [text(item.id), sessionId, item.workItemId ? await idByExternal(client, 'work_items', text(item.workItemId)) : null,
            item.briefId ? await idByExternal(client, 'briefs', text(item.briefId)) : null,
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
           (external_id,session_id,work_item_id,scope,content,status,source_event_external_id,confirmed_by,confirmed_at,
            metadata,created_at,updated_at,deleted_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,null)
           on conflict (external_id) do update set scope=excluded.scope,content=excluded.content,status=excluded.status,
             confirmed_by=excluded.confirmed_by,confirmed_at=excluded.confirmed_at,metadata=excluded.metadata,
             updated_at=excluded.updated_at,work_item_id=excluded.work_item_id,deleted_at=null`,
          [text(item.id), sessionId, item.workItemId ? await idByExternal(client, 'work_items', text(item.workItemId)) : null,
            text(item.scope, 'session'), text(item.content), text(item.status, 'active'),
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
         (external_id,session_id,legacy_session_external_id,work_item_id,task_id,runtime_invocation_id,artifact_type,title,summary,content_object_id,
          metadata,status,created_at,updated_at,deleted_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'active',$12,$13,null)
         on conflict (external_id) do update set title=excluded.title,summary=excluded.summary,
           content_object_id=excluded.content_object_id,metadata=excluded.metadata,work_item_id=excluded.work_item_id,
           updated_at=excluded.updated_at,deleted_at=null`,
        [text(item.id), await idByExternal(client, 'sessions', text(item.sessionId)), text(item.sessionId),
          item.workItemId ? await idByExternal(client, 'work_items', text(item.workItemId)) : null,
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
    await this.refreshWorkItemInheritances(client);
  }

  private async writeFileRevisions(client: PoolClient, value: Record<string, unknown>) {
    const active = new Set<string>();
    const chains = array(value.chains).map(record);
    const chainById = new Map(chains.map((item) => [text(item.id), item]));
    const records = [
      ...array(value.baselines).map((item) => ({ type: 'baseline' as const, externalId: text(record(item).id), item: record(item) })),
      ...chains.map((item) => ({ type: 'chain' as const, externalId: text(item.id), item })),
      ...array(value.runs).map((item) => ({ type: 'run' as const, externalId: text(record(item).id), item: record(item) })),
      ...array(value.drafts).map((item) => ({
        type: 'draft' as const,
        externalId: `draft:${text(record(item).chainId)}`,
        item: record(item)
      }))
    ];
    for (const { type, externalId, item } of records) {
      active.add(externalId);
      const chain = type === 'draft' ? chainById.get(text(item.chainId)) : undefined;
      const sessionExternalId = text(item.sessionId ?? chain?.sessionId);
      const createdAt = date(item.capturedAt ?? item.createdAt ?? item.updatedAt);
      const updatedAt = date(item.updatedAt ?? item.capturedAt ?? item.createdAt);
      await client.query(
        `insert into agent_cluster.file_revision_records
         (external_id,session_id,legacy_session_external_id,record_type,status,file_path,source_snapshot,created_at,updated_at,deleted_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,null)
         on conflict (external_id) do update set session_id=excluded.session_id,
           legacy_session_external_id=excluded.legacy_session_external_id,record_type=excluded.record_type,
           status=excluded.status,file_path=excluded.file_path,source_snapshot=excluded.source_snapshot,
           updated_at=excluded.updated_at,deleted_at=null`,
        [
          externalId,
          await idByExternal(client, 'sessions', sessionExternalId),
          sessionExternalId,
          type === 'baseline' ? 'baseline' : 'run',
          type === 'baseline' || type === 'draft' ? null : nullableText(item.status),
          text(item.filePath ?? chain?.filePath),
          json({ sourceRecord: item, projectionKind: type }),
          createdAt,
          updatedAt
        ]
      );
    }
    await softDeleteMissing(client, 'file_revision_records', active);
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

  private async writeLocalRuntimeDevices(client: PoolClient, values: unknown[]) {
    const deviceIds: string[] = [];
    for (const rawValue of values) {
      const item = record(rawValue);
      const deviceId = text(item.deviceId);
      deviceIds.push(deviceId);
      await client.query(
        `insert into agent_cluster.local_runtime_devices
         (device_id,owner_id,display_name,status,cli_version,protocol_version,runtimes,
          access_token_hash,access_token_expires_at,refresh_token_hash,refresh_token_expires_at,
          created_at,last_seen_at,revoked_at,source_snapshot,updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now())
         on conflict (device_id) do update set owner_id=excluded.owner_id,display_name=excluded.display_name,
           status=excluded.status,cli_version=excluded.cli_version,protocol_version=excluded.protocol_version,
           runtimes=excluded.runtimes,access_token_hash=excluded.access_token_hash,
           access_token_expires_at=excluded.access_token_expires_at,refresh_token_hash=excluded.refresh_token_hash,
           refresh_token_expires_at=excluded.refresh_token_expires_at,last_seen_at=excluded.last_seen_at,
           revoked_at=excluded.revoked_at,source_snapshot=excluded.source_snapshot,updated_at=now()`,
        [deviceId, text(item.ownerId), text(item.displayName), text(item.status), text(item.cliVersion),
          integer(item.protocolVersion), json(item.runtimes), nullableText(item.accessTokenHash),
          nullableDate(item.accessTokenExpiresAt), nullableText(item.refreshTokenHash),
          nullableDate(item.refreshTokenExpiresAt), date(item.createdAt), nullableDate(item.lastSeenAt),
          nullableDate(item.revokedAt), json({ sourceRecord: item })]
      );
    }
    if (deviceIds.length) {
      await client.query('delete from agent_cluster.local_runtime_devices where not (device_id = any($1::text[]))', [deviceIds]);
    } else {
      await client.query('delete from agent_cluster.local_runtime_devices');
    }
  }

  private async writeLocalRuntimeOperationAudits(client: PoolClient, values: unknown[]) {
    const requestIds: string[] = [];
    for (const rawValue of values) {
      const item = record(rawValue);
      const requestId = text(item.requestId);
      requestIds.push(requestId);
      await client.query(
        `insert into agent_cluster.local_runtime_operation_audits
         (request_id,invocation_id,owner_id,workspace_id,operation,revision_id,status,error_code,
          requested_at,completed_at,source_snapshot)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         on conflict (request_id) do update set status=excluded.status,error_code=excluded.error_code,
           completed_at=excluded.completed_at,source_snapshot=excluded.source_snapshot`,
        [requestId, text(item.invocationId), text(item.ownerId), text(item.workspaceId), text(item.operation),
          text(item.revisionId), text(item.status), nullableText(item.errorCode), date(item.requestedAt),
          nullableDate(item.completedAt), json({ sourceRecord: item })]
      );
    }
    if (requestIds.length) {
      await client.query(
        'delete from agent_cluster.local_runtime_operation_audits where not (request_id = any($1::text[]))',
        [requestIds]
      );
    } else {
      await client.query('delete from agent_cluster.local_runtime_operation_audits');
    }
  }

  private async writeRuntimeInvocations(client: PoolClient, value: Record<string, unknown>) {
    for (const [sessionExternalId, invocations] of Object.entries(value)) {
      const sessionId = await idByExternal(client, 'sessions', sessionExternalId);
      for (const rawInvocation of array(invocations)) {
        const item = record(rawInvocation);
        const profile = record(item.profileSnapshot);
        await client.query(
          `insert into agent_cluster.runtime_invocations
           (external_id,session_id,legacy_session_external_id,work_item_id,task_id,agent_version_id,runtime_type,
            runtime_model_config_id,status,context_envelope,profile_snapshot,result_summary,system_evidence,usage,
            error_code,error_message,started_at,completed_at,updated_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
           on conflict (external_id) do update set status=excluded.status,context_envelope=excluded.context_envelope,
             profile_snapshot=excluded.profile_snapshot,result_summary=excluded.result_summary,
             system_evidence=excluded.system_evidence,usage=excluded.usage,error_code=excluded.error_code,
             error_message=excluded.error_message,completed_at=excluded.completed_at,
             work_item_id=excluded.work_item_id,updated_at=excluded.updated_at`,
          [text(item.invocationId ?? item.id), sessionId, sessionId ? null : sessionExternalId,
            item.workItemId ? await idByExternal(client, 'work_items', text(item.workItemId)) : null,
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
         (external_id,session_id,legacy_session_external_id,work_item_id,workflow_version_id,status,current_node_key,definition_snapshot,revision,started_at,completed_at,updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         on conflict (external_id) do update set status=excluded.status,current_node_key=excluded.current_node_key,
           definition_snapshot=excluded.definition_snapshot,revision=excluded.revision,
           completed_at=excluded.completed_at,work_item_id=excluded.work_item_id,updated_at=excluded.updated_at`,
        [text(item.id), sessionId, sessionId ? null : text(item.sessionId),
          item.workItemId ? await idByExternal(client, 'work_items', text(item.workItemId)) : null,
          workflowVersion, text(item.status), nullableText(item.currentNodeId),
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

  private async writeWorkspaceSessionLeases(client: PoolClient, value: Record<string, unknown>) {
    for (const [workspaceId, sessionId] of Object.entries(value)) {
      await client.query(
        `insert into agent_cluster.workspace_session_leases (workspace_id, session_id, acquired_at)
         values ($1, $2, now())
         on conflict (workspace_id) do update set session_id=excluded.session_id, acquired_at=excluded.acquired_at`,
        [workspaceId, text(sessionId)]
      );
    }
  }

  private async writeWorkspaceWritebacks(client: PoolClient, values: unknown[]) {
    await client.query('delete from agent_cluster.workspace_writebacks');
    for (const rawValue of values) {
      const item = record(rawValue);
      await client.query(
        `insert into agent_cluster.workspace_writebacks
         (external_id, session_external_id, workspace_id, status, source_snapshot, created_at, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [text(item.id), text(item.sessionId), text(item.workspaceId), text(item.status),
          json({ sourceRecord: item }), date(item.createdAt), date(item.updatedAt)]
      );
    }
  }

  private async writeWorkItems(client: PoolClient, value: Record<string, unknown>) {
    const active = new Set<string>();
    const parentIds = new Map<string, string>();
    const inheritances = new Map<string, { decisionIds: string[]; artifactIds: string[] }>();
    for (const [sessionExternalId, values] of Object.entries(value)) {
      const sessionId = await idByExternal(client, 'sessions', sessionExternalId);
      if (!sessionId) continue;
      for (const item of array(values).map(record)) {
        const externalId = text(item.id);
        active.add(externalId);
        const workItemId = await upsertId(client, 'work_items', externalId, {
          session_id: sessionId,
          parent_work_item_id: null,
          title: text(item.title, externalId),
          goal: text(item.goal),
          status: text(item.status, 'OPEN'),
          revision: integer(item.revision, 1),
          created_from_event_external_id: text(item.createdFromEventId),
          source_snapshot: json({ sourceRecord: item }),
          created_at: date(item.createdAt),
          updated_at: date(item.updatedAt),
          deleted_at: null
        });
        if (item.parentWorkItemId) parentIds.set(workItemId, text(item.parentWorkItemId));
        inheritances.set(workItemId, {
          decisionIds: array(item.inheritedDecisionIds).map((id) => text(id)).filter(Boolean),
          artifactIds: array(item.inheritedArtifactIds).map((id) => text(id)).filter(Boolean)
        });
      }
    }
    for (const [workItemId, parentExternalId] of parentIds) {
      const parentId = await idByExternal(client, 'work_items', parentExternalId);
      if (parentId) await client.query('update agent_cluster.work_items set parent_work_item_id=$2 where id=$1', [workItemId, parentId]);
    }
    for (const [workItemId, inherited] of inheritances) {
      await client.query('delete from agent_cluster.work_item_decision_inheritances where work_item_id=$1', [workItemId]);
      for (const externalId of inherited.decisionIds) {
        await client.query(
          `insert into agent_cluster.work_item_decision_inheritances (work_item_id,decision_id,source_work_item_id)
           select $1,d.id,d.work_item_id
             from agent_cluster.decision_records d
             join agent_cluster.work_items target on target.id=$1
            where d.external_id=$2 and d.session_id=target.session_id
           on conflict (work_item_id,decision_id) do nothing`,
          [workItemId, externalId]
        );
      }
      await client.query('delete from agent_cluster.work_item_artifact_inheritances where work_item_id=$1', [workItemId]);
      for (const externalId of inherited.artifactIds) {
        await client.query(
          `insert into agent_cluster.work_item_artifact_inheritances (work_item_id,artifact_id,source_work_item_id)
           select $1,a.id,a.work_item_id
             from agent_cluster.artifacts a
             join agent_cluster.work_items target on target.id=$1
            where a.external_id=$2 and a.session_id=target.session_id and a.work_item_id is not null
           on conflict (work_item_id,artifact_id) do nothing`,
          [workItemId, externalId]
        );
      }
    }
    await client.query(`
      update agent_cluster.sessions s
         set active_work_item_id = w.id
        from agent_cluster.work_items w
       where nullif(s.metadata->'sourceRecord'->>'activeWorkItemId', '') = w.external_id
         and w.session_id = s.id
    `);
    await softDeleteMissing(client, 'work_items', active);
  }

  private async writeSystemAgentRuntimePolicies(client: PoolClient, value: Record<string, unknown>) {
    for (const [role, raw] of Object.entries(value)) {
      const item = record(raw);
      await client.query(
        `insert into agent_cluster.system_agent_runtime_policies
         (system_role,preferred_runtime_type,preferred_model_id,allowed_runtime_types,source_snapshot,updated_at)
         values ($1,$2,$3,$4,$5,$6)
         on conflict (system_role) do update set preferred_runtime_type=excluded.preferred_runtime_type,
           preferred_model_id=excluded.preferred_model_id,allowed_runtime_types=excluded.allowed_runtime_types,
           source_snapshot=excluded.source_snapshot,updated_at=excluded.updated_at`,
        [role, nullableText(item.preferredRuntimeType), nullableText(item.preferredModelId),
          json(item.allowedRuntimeTypes, []), json({ sourceRecord: item }), date(item.updatedAt)]
      );
    }
  }

  private async writeDecisionRecords(client: PoolClient, value: Record<string, unknown>) {
    const supersedes = new Map<string, string>();
    for (const [sessionExternalId, values] of Object.entries(value)) {
      const sessionId = await idByExternal(client, 'sessions', sessionExternalId);
      if (!sessionId) continue;
      for (const item of array(values).map(record)) {
        const workItemId = await idByExternal(client, 'work_items', text(item.workItemId));
        if (!workItemId) continue;
        const decisionId = await upsertId(client, 'decision_records', text(item.id), {
          session_id: sessionId,
          work_item_id: workItemId,
          decision_kind: text(item.kind, 'requirement'),
          status: text(item.status, 'proposed'),
          content: text(item.content),
          source_event_external_id: text(item.sourceEventId),
          supersedes_decision_id: null,
          revision: integer(item.revision, 1),
          confirmation: json(item.confirmedBy),
          source_snapshot: json({ sourceRecord: item }),
          created_at: date(item.createdAt),
          updated_at: date(item.updatedAt)
        });
        if (item.supersedesDecisionId) supersedes.set(decisionId, text(item.supersedesDecisionId));
      }
    }
    for (const [decisionId, supersededExternalId] of supersedes) {
      const supersededId = await idByExternal(client, 'decision_records', supersededExternalId);
      if (supersededId) await client.query('update agent_cluster.decision_records set supersedes_decision_id=$2 where id=$1', [decisionId, supersededId]);
    }
    await this.refreshWorkItemInheritances(client);
  }

  private async refreshWorkItemInheritances(client: PoolClient) {
    const workItems = await client.query<{ id: string; source: unknown }>(
      `select id::text, source_snapshot->'sourceRecord' source
         from agent_cluster.work_items
        where deleted_at is null`
    );
    for (const row of workItems.rows) {
      const item = record(row.source);
      await client.query('delete from agent_cluster.work_item_decision_inheritances where work_item_id=$1', [row.id]);
      for (const externalId of array(item.inheritedDecisionIds).map((id) => text(id)).filter(Boolean)) {
        await client.query(
          `insert into agent_cluster.work_item_decision_inheritances (work_item_id,decision_id,source_work_item_id)
           select $1,d.id,d.work_item_id
             from agent_cluster.decision_records d
             join agent_cluster.work_items target on target.id=$1
            where d.external_id=$2 and d.session_id=target.session_id
           on conflict (work_item_id,decision_id) do nothing`,
          [row.id, externalId]
        );
      }
      await client.query('delete from agent_cluster.work_item_artifact_inheritances where work_item_id=$1', [row.id]);
      for (const externalId of array(item.inheritedArtifactIds).map((id) => text(id)).filter(Boolean)) {
        await client.query(
          `insert into agent_cluster.work_item_artifact_inheritances (work_item_id,artifact_id,source_work_item_id)
           select $1,a.id,a.work_item_id
             from agent_cluster.artifacts a
             join agent_cluster.work_items target on target.id=$1
            where a.external_id=$2 and a.session_id=target.session_id and a.work_item_id is not null
           on conflict (work_item_id,artifact_id) do nothing`,
          [row.id, externalId]
        );
      }
    }
  }

  private async writeContextSnapshots(client: PoolClient, value: Record<string, unknown>) {
    for (const [sessionExternalId, values] of Object.entries(value)) {
      const sessionId = await idByExternal(client, 'sessions', sessionExternalId);
      if (!sessionId) continue;
      for (const item of array(values).map(record)) {
        const workItemId = item.activeWorkItemId
          ? await idByExternal(client, 'work_items', text(item.activeWorkItemId))
          : null;
        await client.query(
          `insert into agent_cluster.context_snapshots
           (external_id,session_id,work_item_id,source_event_external_id,purpose,revision_vector,snapshot_hash,payload,created_at)
           values ($1,$2,$3,$4,'intent_routing',$5,$6,$7,$8)
           on conflict (external_id) do nothing`,
          [text(item.id), sessionId, workItemId, text(item.sourceEventId), json(item.revision), text(item.snapshotHash),
            json({ sourceRecord: item }), date(item.createdAt)]
        );
      }
    }
  }

  private async writeIntentRoutingRecords(client: PoolClient, value: Record<string, unknown>) {
    for (const [sessionExternalId, values] of Object.entries(value)) {
      const sessionId = await idByExternal(client, 'sessions', sessionExternalId);
      if (!sessionId) continue;
      for (const item of array(values).map(record)) {
        const snapshotId = item.snapshotId
          ? await idByExternal(client, 'context_snapshots', text(item.snapshotId))
          : null;
        await client.query(
          `insert into agent_cluster.intent_routing_records
           (external_id,session_id,source_event_external_id,session_seq,status,policy_version,rollout_mode,
            context_snapshot_id,runtime_invocation_external_id,decision_payload,validation_payload,final_action,
             action_status,lease_owner,lease_expires_at,reason_codes,retry_count,idempotency_key,source_snapshot,created_at,updated_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
           on conflict (external_id) do update set status=excluded.status,context_snapshot_id=excluded.context_snapshot_id,
             runtime_invocation_external_id=excluded.runtime_invocation_external_id,decision_payload=excluded.decision_payload,
              validation_payload=excluded.validation_payload,final_action=excluded.final_action,action_status=excluded.action_status,
              lease_owner=excluded.lease_owner,lease_expires_at=excluded.lease_expires_at,reason_codes=excluded.reason_codes,
              retry_count=excluded.retry_count,source_snapshot=excluded.source_snapshot,updated_at=excluded.updated_at`,
          [text(item.id), sessionId, text(item.sourceEventId), integer(item.sessionSeq), text(item.status),
            text(item.policyVersion), text(item.rolloutMode), snapshotId, nullableText(item.invocationId), json(item.decision),
             json(item.validation), nullableText(item.finalAction), nullableText(item.actionStatus), nullableText(item.leaseOwner),
             nullableDate(item.leaseExpiresAt), json(item.reasonCodes, []), integer(item.retryCount),
            text(item.idempotencyKey), json({ sourceRecord: item }), date(item.createdAt), date(item.updatedAt)]
        );
      }
    }
  }

  private async writeFollowUpMessages(client: PoolClient, value: Record<string, unknown>) {
    for (const [sessionExternalId, values] of Object.entries(value)) {
      const sessionId = await idByExternal(client, 'sessions', sessionExternalId);
      if (!sessionId) continue;
      for (const item of array(values).map(record)) {
        const workItemId = item.workItemId ? await idByExternal(client, 'work_items', text(item.workItemId)) : null;
        const routingId = item.routingId ? await idByExternal(client, 'intent_routing_records', text(item.routingId)) : null;
        await client.query(
          `insert into agent_cluster.session_follow_up_messages
           (external_id,session_id,work_item_id,routing_record_id,source_event_external_id,status,handling_payload,queued_at,started_at,completed_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           on conflict (external_id) do update set work_item_id=excluded.work_item_id,routing_record_id=excluded.routing_record_id,
             status=excluded.status,handling_payload=excluded.handling_payload,started_at=excluded.started_at,completed_at=excluded.completed_at`,
          [text(item.id), sessionId, workItemId, routingId, text(item.sourceEventId), text(item.status),
            json({ sourceRecord: item }), date(item.queuedAt), nullableDate(item.startedAt), nullableDate(item.completedAt)]
        );
      }
    }
  }

  private async writeEventOutbox(client: PoolClient, values: unknown[]) {
    for (const item of values.map(record)) {
      await client.query(
        `insert into agent_cluster.event_outbox as outbox
         (external_id,aggregate_type,aggregate_external_id,event_type,payload,idempotency_key,status,attempt_count,available_at,created_at,published_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,coalesce($9,now()),$10,$11)
         on conflict (idempotency_key) do update set
           status=case when outbox.status='published' then 'published' else excluded.status end,
           attempt_count=greatest(outbox.attempt_count,excluded.attempt_count),
           available_at=excluded.available_at,
           published_at=coalesce(outbox.published_at,excluded.published_at),
           payload=excluded.payload`,
        [text(item.id), text(item.aggregateType), text(item.aggregateId), text(item.eventType), json({ sourceRecord: item }),
          text(item.idempotencyKey), text(item.status, 'pending'), integer(item.attempts), nullableDate(item.availableAt),
          date(item.createdAt), nullableDate(item.publishedAt)]
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
    state.systemAgentRuntimePolicies = await keyedSources(
      client,
      `select system_role external_id,source_snapshot->'sourceRecord' value from agent_cluster.system_agent_runtime_policies order by system_role`
    );
  }

  private async loadSessions(client: PoolClient, state: PersistedState) {
    state.sessions = await sourceRecords(client, `select metadata->'sourceRecord' value from agent_cluster.sessions where deleted_at is null order by created_at`);
  }

  private async loadSessionOwnedData(client: PoolClient, state: PersistedState) {
    state.eventsBySession = await groupedSources(client, `select s.external_id group_id,e.payload->'sourceRecord' value from agent_cluster.collaboration_events e join agent_cluster.sessions s on s.id=e.session_id where s.deleted_at is null order by s.id,e.session_seq`);
    state.briefsBySession = await groupedSources(client, `select s.external_id group_id,b.source_snapshot->'sourceRecord' value from agent_cluster.briefs b join agent_cluster.sessions s on s.id=b.session_id where s.deleted_at is null order by s.id,b.created_at`);
    state.suggestedTasksByBriefId = await groupedSources(client, `select b.external_id group_id,t.source_snapshot->'sourceRecord' value from agent_cluster.suggested_tasks t join agent_cluster.briefs b on b.id=t.brief_id join agent_cluster.sessions s on s.id=b.session_id where s.deleted_at is null order by b.external_id,t.id`);
    state.tasksBySession = await groupedSources(client, `select s.external_id group_id,t.source_snapshot->'sourceRecord' value from agent_cluster.tasks t join agent_cluster.sessions s on s.id=t.session_id where s.deleted_at is null and t.deleted_at is null order by s.id,t.created_at`);
    state.memoriesBySession = await groupedSources(client, `select s.external_id group_id,m.metadata->'sourceRecord' value from agent_cluster.memories m join agent_cluster.sessions s on s.id=m.session_id where s.deleted_at is null and m.deleted_at is null order by s.id,m.created_at`);
    state.fileRevisions = await this.loadFileRevisionsWithClient(client);
    state.workspaceWritebacks = await sourceRecords(
      client,
      `select w.source_snapshot->'sourceRecord' value from agent_cluster.workspace_writebacks w join agent_cluster.sessions s on s.external_id=w.session_external_id where s.deleted_at is null order by w.created_at,w.external_id`
    );
    state.workItemsBySession = await groupedSources(client, `select s.external_id group_id,w.source_snapshot->'sourceRecord' value from agent_cluster.work_items w join agent_cluster.sessions s on s.id=w.session_id where s.deleted_at is null and w.deleted_at is null order by s.id,w.created_at`);
    state.decisionRecordsBySession = await groupedSources(client, `select s.external_id group_id,d.source_snapshot->'sourceRecord' value from agent_cluster.decision_records d join agent_cluster.sessions s on s.id=d.session_id where s.deleted_at is null order by s.id,d.created_at`);
    state.contextSnapshotsBySession = await groupedSources(client, `select s.external_id group_id,c.payload->'sourceRecord' value from agent_cluster.context_snapshots c join agent_cluster.sessions s on s.id=c.session_id where s.deleted_at is null order by s.id,c.created_at`);
    state.intentRoutingRecordsBySession = await groupedSources(client, `select s.external_id group_id,r.source_snapshot->'sourceRecord' value from agent_cluster.intent_routing_records r join agent_cluster.sessions s on s.id=r.session_id where s.deleted_at is null order by s.id,r.session_seq`);
    state.followUpMessagesBySession = await groupedSources(client, `select s.external_id group_id,f.handling_payload->'sourceRecord' value from agent_cluster.session_follow_up_messages f join agent_cluster.sessions s on s.id=f.session_id where s.deleted_at is null order by s.id,f.queued_at`);
    state.eventOutbox = await sourceRecords(
      client,
      `select ${eventOutboxRecordSql('outbox')} value
         from agent_cluster.event_outbox outbox
        order by id`
    );
  }

  private async loadFileRevisionsWithClient(client: PoolClient) {
    const revisionRows = await client.query<{ record_type: string; projection_kind: string | null; value: unknown }>(
      `select f.record_type,f.source_snapshot->>'projectionKind' projection_kind,f.source_snapshot->'sourceRecord' value
         from agent_cluster.file_revision_records f
         join agent_cluster.sessions s on s.id=f.session_id
        where f.deleted_at is null and s.deleted_at is null
        order by f.created_at,f.id`
    );
    const value = {
      schemaVersion: 2,
      baselines: revisionRows.rows.filter((row) => row.record_type === 'baseline').map((row) => row.value),
      chains: revisionRows.rows.filter((row) => row.projection_kind === 'chain').map((row) => row.value),
      runs: revisionRows.rows.filter((row) => row.record_type === 'run' && (!row.projection_kind || row.projection_kind === 'run')).map((row) => row.value),
      drafts: revisionRows.rows.filter((row) => row.projection_kind === 'draft').map((row) => row.value)
    };
    return record(this.codec.hydrate(value));
  }

  private async loadKnowledgeAndArtifacts(client: PoolClient, state: PersistedState) {
    const bases = await keyedSources(client, `select external_id,source_snapshot->'sourceRecord' value from agent_cluster.knowledge_bases where deleted_at is null`);
    const documents = await groupedSources(client, `select kb.external_id group_id,kd.source_snapshot->'sourceRecord' value from agent_cluster.knowledge_documents kd join agent_cluster.knowledge_bases kb on kb.id=kd.knowledge_base_id where kd.deleted_at is null order by kd.id`);
    const chunks = await groupedSources(client, `select kb.external_id group_id,kc.source_snapshot->'sourceRecord' value from agent_cluster.knowledge_chunks kc join agent_cluster.knowledge_documents kd on kd.id=kc.knowledge_document_id join agent_cluster.knowledge_bases kb on kb.id=kd.knowledge_base_id order by kc.id`);
    state.knowledge = { knowledgeBases: bases, documentsByBase: documents, chunksByBase: chunks };
    const artifactRows = await client.query<{ external_id: string; session_id: string | null; value: unknown }>(`select a.external_id,s.external_id session_id,a.metadata->'sourceRecord' value from agent_cluster.artifacts a join agent_cluster.sessions s on s.id=a.session_id where a.deleted_at is null and s.deleted_at is null order by a.created_at`);
    state.artifacts = { artifactsById: Object.fromEntries(artifactRows.rows.map((row) => [row.external_id, row.value])), artifactIdsBySession: artifactRows.rows.reduce<Record<string,string[]>>((acc,row) => { if(row.session_id)(acc[row.session_id]??=[]).push(row.external_id); return acc; },{}) };
  }

  private async loadRuntime(client: PoolClient, state: PersistedState) {
    state.sessionLifecyclesBySession = await keyedSources(client, `select s.external_id,l.source_snapshot->'sourceRecord' value from agent_cluster.session_lifecycles l join agent_cluster.sessions s on s.id=l.session_id order by s.external_id`);
    state.runtimeInvocationsBySession = await groupedSources(client, `select s.external_id group_id,r.profile_snapshot->'sourceRecord' value from agent_cluster.runtime_invocations r join agent_cluster.sessions s on s.id=r.session_id where s.deleted_at is null order by r.started_at`);
    state.logicalOperationsBySession = await groupedSources(client, `select s.external_id group_id,o.source_snapshot->'sourceRecord' value from agent_cluster.logical_operations o join agent_cluster.sessions s on s.id=o.session_id where s.deleted_at is null order by o.external_id`);
    state.sessionStopRequestsBySession = await groupedSources(client, `select s.external_id group_id,r.source_snapshot->'sourceRecord' value from agent_cluster.session_stop_requests r join agent_cluster.sessions s on s.id=r.session_id where s.deleted_at is null order by r.created_at,r.external_id`);
    const model = await client.query<{ value: unknown }>(`select configuration->'sourceRecord' value from agent_cluster.runtime_model_configs where deleted_at is null order by id limit 1`);
    state.runtimeModelConfig = model.rows[0]?.value ?? {};
    state.localRuntimeDevices = await sourceRecords(client, `select source_snapshot->'sourceRecord' value from agent_cluster.local_runtime_devices order by id`);
    state.localRuntimeOperationAudits = await sourceRecords(client, `select source_snapshot->'sourceRecord' value from agent_cluster.local_runtime_operation_audits order by requested_at,id`);
  }

  private async loadWorkflowRuntime(client: PoolClient, state: PersistedState) {
    const runs = await sourceRecords(client, `select wr.definition_snapshot->'sourceRecord' value from agent_cluster.workflow_runs wr join agent_cluster.sessions s on s.id=wr.session_id where s.deleted_at is null order by wr.started_at`);
    const nodeRuns = await groupedSources(client, `select wr.external_id group_id,nr.input_snapshot->'sourceRecord' value from agent_cluster.workflow_node_runs nr join agent_cluster.workflow_runs wr on wr.id=nr.workflow_run_id join agent_cluster.sessions s on s.id=wr.session_id where s.deleted_at is null order by nr.id`);
    const approvals = await groupedSources(client, `select wr.external_id group_id,wa.evidence->'sourceRecord' value from agent_cluster.workflow_approvals wa join agent_cluster.workflow_node_runs nr on nr.id=wa.workflow_node_run_id join agent_cluster.workflow_runs wr on wr.id=nr.workflow_run_id join agent_cluster.sessions s on s.id=wr.session_id where s.deleted_at is null order by wa.id`);
    const effects = await groupedSources(client, `select wr.external_id group_id,we.payload->'sourceRecord' value from agent_cluster.workflow_effects we join agent_cluster.workflow_runs wr on wr.id=we.workflow_run_id join agent_cluster.sessions s on s.id=wr.session_id where s.deleted_at is null order by we.id`);
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
    const leases = await client.query<{ workspace_id: string; session_id: string }>(
      `select workspace_id, session_id from agent_cluster.workspace_session_leases order by workspace_id`
    );
    state.workspaceSessionLeases = Object.fromEntries(leases.rows.map(row => [row.workspace_id, row.session_id]));
  }
}

function collectionWriteOrder(state: PersistedState): string[] {
  const order = ['systemDataMetadata','agents','systemAgentRuntimePolicies','skills','capabilities','workflowCatalog','workflows','sessions','sessionLifecyclesBySession','workItemsBySession','decisionRecordsBySession','contextSnapshotsBySession','intentRoutingRecordsBySession','followUpMessagesBySession','fileRevisions','workspaceWritebacks','eventsBySession','briefsBySession','suggestedTasksByBriefId','tasksBySession','memoriesBySession','knowledge','runtimeModelConfig','runtimeInvocationsBySession','artifacts','workflowRuntime','autopilots','autopilotRuns','localRuntimeDevices','localRuntimeOperationAudits','eventOutbox','cutoverAudits'];
  order.push('logicalOperationsBySession', 'sessionStopRequestsBySession');
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
function collectionRevision(value: unknown): string {
  return computePersistenceRevision({ value: normalizeFileRevisionCollection(value) });
}
function normalizeFileRevisionCollection(value: unknown): Record<string, unknown> {
  const source = record(value);
  const byIdentity = (items: unknown[], kind: 'baseline' | 'chain' | 'run' | 'draft') => [...items].sort((left, right) => {
    const leftRecord = record(left);
    const rightRecord = record(right);
    const identity = (item: Record<string, unknown>) => kind === 'draft'
      ? `${text(item.chainId)}:${text(item.sourceRevisionId)}`
      : text(item.id);
    return identity(leftRecord).localeCompare(identity(rightRecord));
  });
  return {
    schemaVersion: 2,
    baselines: byIdentity(array(source.baselines), 'baseline'),
    chains: byIdentity(array(source.chains), 'chain'),
    runs: byIdentity(array(source.runs), 'run'),
    drafts: byIdentity(array(source.drafts), 'draft')
  };
}
function iso(value: unknown): unknown { return value instanceof Date?value.toISOString():value; }
function duration(startedAt:string,completedAt?:string):number|null { if(!completedAt)return null; const value=Date.parse(completedAt)-Date.parse(startedAt); return Number.isFinite(value)&&value>=0?value:null; }
function eventOutboxRecordSql(alias: string): string {
  return `coalesce(
    ${alias}.payload->'sourceRecord',
    jsonb_build_object(
      'id',${alias}.external_id,
      'idempotencyKey',${alias}.idempotency_key,
      'aggregateType',${alias}.aggregate_type,
      'aggregateId',${alias}.aggregate_external_id,
      'eventType',${alias}.event_type,
      'payload',${alias}.payload,
      'createdAt',to_jsonb(${alias}.created_at)
    )
  ) || jsonb_build_object(
    'status',${alias}.status,
    'attempts',${alias}.attempt_count,
    'availableAt',to_jsonb(${alias}.available_at),
    'leaseOwner',${alias}.lease_owner,
    'leaseExpiresAt',to_jsonb(${alias}.lease_expires_at),
    'publishedAt',to_jsonb(${alias}.published_at)
  )`;
}
async function sourceRecords(client:PoolClient,sql:string):Promise<unknown[]>{const r=await client.query<{value:unknown}>(sql);return r.rows.map(x=>x.value).filter(v=>v!==null);}
async function groupedSources(client:PoolClient,sql:string):Promise<Record<string,unknown[]>>{const r=await client.query<{group_id:string|null;value:unknown}>(sql);return r.rows.reduce<Record<string,unknown[]>>((a,x)=>{if(x.group_id&&x.value!==null)(a[x.group_id]??=[]).push(x.value);return a;},{});}
async function keyedSources(client:PoolClient,sql:string):Promise<Record<string,unknown>>{const r=await client.query<{external_id:string;value:unknown}>(sql);return Object.fromEntries(r.rows.filter(x=>x.value!==null).map(x=>[x.external_id,x.value]));}
function groupRows(rows:Array<{workflow_id:string;value:unknown}>,key:'workflow_id'):Record<string,unknown[]>{return rows.reduce<Record<string,unknown[]>>((a,x)=>{(a[x[key]]??=[]).push(x.value);return a;},{});}
