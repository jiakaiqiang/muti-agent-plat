import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Pool } from 'pg';
import { ContentReferenceCodec } from '../content-reference-codec.js';
import { LocalContentStore } from '../local-content-store.js';
import { PersistenceService } from '../persistence.service.js';
import { runPostgresMigrations } from './postgres-migration-runner.js';
import { RelationalStateStore } from './relational-state-store.js';

const databaseUrl = process.env.RELATIONAL_TEST_DATABASE_URL;

test('PostgreSQL migration creates a fully commented relational schema and is idempotent', { skip: !databaseUrl }, async () => {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await runPostgresMigrations(pool);
    await runPostgresMigrations(pool);

    const tables = await pool.query<{ table_name: string }>(`
      select c.relname as table_name
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'agent_cluster'
         and c.relkind = 'r'
       order by c.relname
    `);
    assert.ok(tables.rows.length >= 49);

    const missingComments = await pool.query<{ object_name: string }>(`
      select c.relname as object_name
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'agent_cluster'
         and c.relkind = 'r'
         and obj_description(c.oid, 'pg_class') is null
      union all
      select c.relname || '.' || a.attname as object_name
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        join pg_attribute a on a.attrelid = c.oid
       where n.nspname = 'agent_cluster'
         and c.relkind = 'r'
         and a.attnum > 0
         and not a.attisdropped
         and col_description(c.oid, a.attnum) is null
    `);
    assert.deepEqual(missingComments.rows, []);
  } finally {
    await pool.end();
  }
});


test('relational projections preserve catalog versions, bindings, session progress, context requests, and outbox', { skip: !databaseUrl }, async () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const competingPool = new Pool({ connectionString: databaseUrl });
  const contentRoot = mkdtempSync(join(tmpdir(), 'agent-cluster-relational-'));
  const suffix = `${process.pid}-${Date.now()}`;
  const agentId = `agent-${suffix}`;
  const skillId = `skill-${suffix}`;
  const capabilityId = `cap-${suffix}`;
  const knowledgeId = `knowledge-${suffix}`;
  const sessionId = `session-${suffix}`;
  const taskId = `task-${suffix}`;
  const contextRequestId = `context-${suffix}`;
  const eventId = `event-${suffix}`;
  const toolName = `tool_${suffix.replace(/-/g, '_')}`;
  const now = new Date().toISOString();
  try {
    await runPostgresMigrations(pool);
    const store = new RelationalStateStore(
      pool,
      new ContentReferenceCodec(new LocalContentStore({ rootDir: contentRoot }))
    );
    const competingStore = new RelationalStateStore(
      competingPool,
      new ContentReferenceCodec(new LocalContentStore({ rootDir: contentRoot }))
    );
    await store.writeCollection('agents', [{
      id: agentId, key: agentId, name: 'Projection Agent', role: 'worker', profileRevision: 1,
      profileMarkdown: `Use \${skill:${skillId}}`, capabilityIds: [capabilityId],
      defaultKnowledgeBaseIds: [knowledgeId], createdAt: now, updatedAt: now
    }]);
    await store.writeCollection('skills', [{
      id: skillId, key: skillId, name: 'Projection Skill', content: 'skill body', revision: 1,
      createdAt: now, updatedAt: now
    }]);
    await store.writeCollection('capabilities', {
      capabilities: [{ id: capabilityId, key: `tool.${suffix}`, kind: 'tool', name: 'Projection Tool', riskLevel: 'low' }],
      approvals: [], definitionExtensions: {}
    });
    await store.writeCollection('knowledge', {
      knowledgeBases: { [knowledgeId]: { name: 'Projection Knowledge', scope: 'global', ownerId: 'local-user', updatedAt: now } },
      documentsByBase: {}, chunksByBase: {}
    });
    const tool = {
      name: toolName, description: 'version one', category: 'custom', riskLevel: 'low',
      inputSchema: { type: 'object' }, provider: 'agent-cluster', toolType: 'builtin',
      capabilityExternalIds: [capabilityId]
    };
    await store.writeToolDefinitions([tool]);
    await store.writeToolDefinitions([tool]);
    await store.writeToolDefinitions([{ ...tool, description: 'version two' }]);

    const session = {
      id: sessionId, title: 'Projection Session', status: 'USER_INPUT', ownerId: 'local-user',
      createdAt: now, updatedAt: now,
      supplementalContextRequests: [{
        id: contextRequestId, taskId, agentId,
        requestedContext: { reason: 'Need source', requestedRefs: [], requestedPaths: ['src/a.ts'], requestedCommands: [] },
        resolution: { hydratedPaths: ['src/a.ts'], failedPaths: [], deferredPaths: [] },
        createdAt: now, updatedAt: now
      }]
    };
    await store.writeCollection('sessions', [session]);
    const revisionBaseline = {
      id: `baseline-${suffix}`,
      dataEpoch: `epoch-${suffix}`,
      sessionId,
      workspaceId: `workspace-${suffix}`,
      filePath: 'result.md',
      workspaceRevision: { id: `workspace-revision-${suffix}`, observedAt: now },
      contentRef: 'sha256:baseline-content',
      hash: { algorithm: 'sha256', value: 'baseline-hash' },
      sizeBytes: 12,
      source: 'user_selected',
      capturedAt: now
    };
    const revisionChain = {
      id: `chain-${suffix}`,
      dataEpoch: revisionBaseline.dataEpoch,
      sessionId,
      workspaceId: revisionBaseline.workspaceId,
      filePath: revisionBaseline.filePath,
      rootBaselineId: revisionBaseline.id,
      workspaceExpectedRevision: revisionBaseline.workspaceRevision,
      workspaceExpectedHash: { algorithm: 'sha256', value: 'revised-hash' },
      latestRevisionId: `revision-${suffix}`,
      latestIteration: 1,
      stateVersion: 2,
      status: 'active',
      createdAt: now,
      updatedAt: now
    };
    const revisionRun = {
      id: revisionChain.latestRevisionId,
      chainId: revisionChain.id,
      dataEpoch: revisionBaseline.dataEpoch,
      sessionId,
      baselineId: revisionBaseline.id,
      workspaceId: revisionBaseline.workspaceId,
      filePath: 'result.md',
      iteration: 1,
      status: 'awaiting_confirmation',
      baseKind: 'workspace_baseline',
      baseHash: revisionBaseline.hash,
      baseContentRef: revisionBaseline.contentRef,
      baseSizeBytes: revisionBaseline.sizeBytes,
      userDraftHash: revisionChain.workspaceExpectedHash,
      userDraftContentRef: 'sha256:revised-content',
      userDraftSizeBytes: 18,
      diffContentRef: 'sha256:revision-diff',
      diffHash: { algorithm: 'sha256', value: 'diff-hash' },
      diffSummary: { addedLines: 1, removedLines: 1, unchangedLines: 1, hunkCount: 1 },
      targetAgentIds: [agentId],
      contextSnapshotHash: `evidence-${suffix}`,
      agentResults: [],
      candidateContentRef: 'sha256:candidate-content',
      candidateHash: { algorithm: 'sha256', value: 'candidate-hash' },
      candidateSizeBytes: 20,
      confirmationId: `confirmation-${suffix}`,
      createdAt: now,
      updatedAt: now
    };
    const revisionDraft = {
      chainId: revisionChain.id,
      sourceRevisionId: revisionRun.id,
      sourceCandidateHash: revisionRun.candidateHash,
      contentRef: 'sha256:editor-draft',
      contentHash: { algorithm: 'sha256', value: 'draft-hash' },
      sizeBytes: 22,
      updatedBy: { type: 'user', id: 'local-user' },
      updatedAt: now
    };
    await store.writeCollection('fileRevisions', {
      schemaVersion: 2,
      baselines: [revisionBaseline],
      chains: [revisionChain],
      runs: [revisionRun],
      drafts: [revisionDraft]
    });
    await store.writeCollection('tasksBySession', {
      [sessionId]: [{ id: taskId, title: 'Projection Task', status: 'completed', assigneeId: agentId, createdAt: now, updatedAt: now }]
    });
    await store.writeCollection('sessions', [{ ...session, status: 'EXECUTING' }]);
    const writeback = {
      id: `writeback-${suffix}`,
      sessionId,
      taskId,
      invocationId: `invocation-${suffix}`,
      workspaceId: `workspace-${suffix}`,
      providerKind: 'server_local',
      changeSet: {
        id: `changes-${suffix}`,
        baseRevision: revisionBaseline.workspaceRevision,
        changes: [{ operation: 'create', path: 'result.txt', content: 'done', encoding: 'utf-8' }],
        createdAt: now
      },
      status: 'conflicted',
      conflicts: [],
      createdAt: now,
      updatedAt: now
    };
    await store.writeCollection('workspaceWritebacks', [writeback]);
    await store.writeCollection('eventsBySession', {
      [sessionId]: [{ id: eventId, sessionId, type: 'agent_message', content: 'persisted', actor: { type: 'agent', id: agentId }, createdAt: now }]
    });
    await store.markEventPublished(eventId);

    const projections = await pool.query<{
      skill_bindings: number; tool_bindings: number; knowledge_bindings: number;
      context_requests: number; status_history: number; progress: number; outbox_published: number; tool_versions: number;
      file_revision_records: number;
    }>(`
      select
        (select count(*)::int from agent_cluster.agent_skill_bindings b join agent_cluster.agent_versions av on av.id=b.agent_version_id join agent_cluster.agents a on a.id=av.agent_id where a.external_id=$1) skill_bindings,
        (select count(*)::int from agent_cluster.agent_tool_bindings b join agent_cluster.agent_versions av on av.id=b.agent_version_id join agent_cluster.agents a on a.id=av.agent_id where a.external_id=$1) tool_bindings,
        (select count(*)::int from agent_cluster.agent_knowledge_bindings b join agent_cluster.agent_versions av on av.id=b.agent_version_id join agent_cluster.agents a on a.id=av.agent_id where a.external_id=$1) knowledge_bindings,
        (select count(*)::int from agent_cluster.supplemental_context_requests where external_id=$2) context_requests,
        (select count(*)::int from agent_cluster.session_status_history h join agent_cluster.sessions s on s.id=h.session_id where s.external_id=$3) status_history,
        (select count(*)::int from agent_cluster.session_progress p join agent_cluster.sessions s on s.id=p.session_id where s.external_id=$3) progress,
        (select count(*)::int from agent_cluster.event_outbox where external_id=$4 and status='published') outbox_published,
        (select count(*)::int from agent_cluster.tool_versions tv join agent_cluster.tools t on t.id=tv.tool_id where t.tool_key=$5) tool_versions,
        (select count(*)::int from agent_cluster.file_revision_records f join agent_cluster.sessions s on s.id=f.session_id where s.external_id=$3 and f.deleted_at is null) file_revision_records
    `, [agentId, contextRequestId, sessionId, `outbox:${eventId}`, toolName]);
    assert.equal(projections.rows[0].skill_bindings, 1);
    assert.ok(projections.rows[0].tool_bindings >= 1);
    assert.equal(projections.rows[0].knowledge_bindings, 1);
    assert.equal(projections.rows[0].context_requests, 1);
    assert.equal(projections.rows[0].status_history, 2);
    assert.equal(projections.rows[0].progress, 1);
    assert.equal(projections.rows[0].outbox_published, 1);
    assert.equal(projections.rows[0].tool_versions, 2);
    assert.equal(projections.rows[0].file_revision_records, 4);

    const loaded = await store.loadState();
    const loadedFileRevisions = loaded.fileRevisions as {
      schemaVersion: number;
      baselines: typeof revisionBaseline[];
      chains: typeof revisionChain[];
      runs: typeof revisionRun[];
      drafts: typeof revisionDraft[];
    };
    assert.equal(loadedFileRevisions.schemaVersion, 2);
    assert.equal(loadedFileRevisions.baselines.find((item) => item.id === revisionBaseline.id)?.contentRef, revisionBaseline.contentRef);
    assert.equal(loadedFileRevisions.chains.find((item) => item.id === revisionChain.id)?.stateVersion, 2);
    assert.equal(loadedFileRevisions.runs.find((item) => item.id === revisionRun.id)?.status, 'awaiting_confirmation');
    assert.equal(loadedFileRevisions.drafts.find((item) => item.chainId === revisionChain.id)?.contentRef, revisionDraft.contentRef);
    const loadedWritebacks = loaded.workspaceWritebacks as typeof writeback[];
    assert.equal(loadedWritebacks.find((item) => item.id === writeback.id)?.status, 'conflicted');
    const loadedOutbox = loaded.eventOutbox as Array<{ id: string; status: string; attempts: number; publishedAt?: string }>;
    const publishedOutbox = loadedOutbox.find((item) => item.id === `outbox:${eventId}`);
    assert.equal(publishedOutbox?.status, 'published');
    assert.equal(publishedOutbox?.attempts, 1);
    assert.ok(publishedOutbox?.publishedAt);

    const applyingState = structuredClone(loadedFileRevisions);
    applyingState.chains[0] = { ...applyingState.chains[0], status: 'applying', stateVersion: 3 };
    applyingState.runs[0] = { ...applyingState.runs[0], status: 'applying' };
    const abandonedState = structuredClone(loadedFileRevisions);
    abandonedState.chains[0] = { ...abandonedState.chains[0], status: 'abandoned', stateVersion: 3 };
    abandonedState.runs[0] = { ...abandonedState.runs[0], status: 'abandoned' };
    const competingWrites = await Promise.allSettled([
      store.compareAndSetCollection('fileRevisions', loadedFileRevisions, applyingState),
      competingStore.compareAndSetCollection('fileRevisions', loadedFileRevisions, abandonedState)
    ]);
    assert.equal(competingWrites.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(competingWrites.filter((result) => result.status === 'rejected').length, 1);
    const afterCas = (await store.loadState()).fileRevisions as typeof loadedFileRevisions;
    assert.equal(afterCas.chains[0]?.stateVersion, 3);
    assert.ok(['applying', 'abandoned'].includes(afterCas.chains[0]?.status ?? ''));

    const unavailablePool = new Pool({ connectionString: databaseUrl });
    const unavailableStore = new RelationalStateStore(
      unavailablePool,
      new ContentReferenceCodec(new LocalContentStore({ rootDir: contentRoot }))
    );
    await unavailablePool.end();
    await assert.rejects(
      unavailableStore.compareAndSetCollection('fileRevisions', afterCas, loadedFileRevisions),
      /ended|closed|connect/i
    );
  } finally {
    await competingPool.end();
    await pool.end();
    rmSync(contentRoot, { recursive: true, force: true });
  }
});

test('empty relational startup imports a legacy collection state exactly once', { skip: !databaseUrl }, async () => {
  const isolatedDatabase = `agent_cluster_legacy_${process.pid}_${Date.now()}`;
  const isolatedUrl = new URL(databaseUrl!);
  isolatedUrl.pathname = `/${isolatedDatabase}`;
  const tableName = `legacy_import_${process.pid}_${Date.now()}`;
  const setupPool = new Pool({ connectionString: databaseUrl });
  const now = new Date().toISOString();
  const sessionId = `legacy-session-${process.pid}-${Date.now()}`;
  try {
    await setupPool.query(`create database ${isolatedDatabase}`);
    const isolatedPool = new Pool({ connectionString: isolatedUrl.toString() });
    await isolatedPool.query(`create table ${tableName} (key text primary key, value jsonb not null, updated_at timestamptz not null default now())`);
    await isolatedPool.query(`insert into ${tableName} (key,value) values ($1,$2),($3,$4),($5,$6)`, [
      'systemDataMetadata', JSON.stringify({ dataSchemaVersion: 3, dataEpoch: 'legacy-epoch', pipelineVersion: 'v2', cutoverAt: now, cutoverAuditId: 'legacy-cutover' }),
      'sessions', JSON.stringify([{ id: sessionId, title: 'Legacy session', status: 'USER_INPUT', ownerId: 'local-user', createdAt: now, updatedAt: now }]),
      'eventsBySession', JSON.stringify({ [sessionId]: [{ id: `legacy-event-${sessionId}`, sessionId, type: 'user_message', content: 'legacy', actor: { type: 'user', id: 'local-user' }, createdAt: now }] })
    ]);
    await isolatedPool.end();

    const persistence = new PersistenceService({ enabled: true, backend: 'postgres', databaseUrl: isolatedUrl.toString(), postgresCollectionTable: tableName });
    await persistence.initialize();
    persistence.assertCurrentDataReady();
    assert.equal(persistence.getCollection<{ id: string }[]>('sessions', [])[0]?.id, sessionId);
    await persistence.onModuleDestroy();

    const verifyPool = new Pool({ connectionString: isolatedUrl.toString() });
    try {
      const relation = await verifyPool.query(`select count(*)::int count from agent_cluster.sessions where external_id=$1`, [sessionId]);
      assert.equal(relation.rows[0].count, 1);
      const legacy = await verifyPool.query(`select count(*)::int count from ${tableName}`);
      assert.equal(legacy.rows[0].count, 3);
    } finally {
      await verifyPool.end();
    }
  } finally {
    await setupPool.query(`drop database if exists ${isolatedDatabase}`).catch(() => undefined);
    await setupPool.end().catch(() => undefined);
  }
});
