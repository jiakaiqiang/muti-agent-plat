import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CollaborationEvent, InvocationPlan, SessionDetail } from '@agent-cluster/shared';
import { PersistenceService } from '../persistence/persistence.service.js';
import { ServerLocalWorkspaceProvider } from '../workspaces/server-local-workspace-provider.js';
import { approvedResumeState } from './intent-resume.fixture.js';
import { issueWorkspaceReadAuthority } from './intent-workspace-read.js';
import { inspectSourceFile, inspectSourceRoot, IntentSourceAuthorityStore } from './intent-source-authority.js';
import { IntentSourceCandidateService } from './intent-source-candidate.service.js';

export const sourcePath = 'src/login.ts';
export const sourceBase = 'export function login(password: string) { return authenticate(password); }\n';
export const sourceUpdated = 'export function login(password: string) { if (!password) return false; return authenticate(password); }\n';

/** Test-only trusted owner confirmation; no production authorization endpoint is added. */
export async function sourceWriteFixture(options: {
  files?: Record<string, string>; prohibitions?: Array<'no_schema_change'>;
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'intent-source-r10a-'));
  const root = join(directory, 'workspace'); await mkdir(root);
  const files = options.files ?? { [sourcePath]: sourceBase };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), content);
  }
  const persistence = new PersistenceService({ enabled: true, backend: 'file', filePath: join(directory, 'state.json') });
  await persistence.initialize();
  const state: any = approvedResumeState(), session: SessionDetail = state.sessions[0];
  session.status = 'EXECUTING'; session.pauseState = undefined;
  session.workingDirectory!.path = root;
  session.workspaceContext!.binding!.capabilities = { read: true, write: true, command: false, test: false };
  session.intentWorkspaceReadAuthority = issueWorkspaceReadAuthority(session, 'workspace-selection');
  state.sessionLifecyclesBySession.session.admission = 'open';
  state.sessionLifecyclesBySession.session.stopStatus = 'idle';
  state.tasksBySession.session[0].status = 'running';
  const operation = state.logicalOperationsBySession.session[0];
  operation.status = 'running'; operation.stopState = 'none'; operation.activeInvocationId = 'source-invocation';
  operation.invocationIds = ['source-invocation']; operation.ownerId = 'source-test-owner';
  const now = new Date().toISOString();
  const rootIdentity = await inspectSourceRoot(root);
  const inspected = await Promise.all(Object.keys(files).map((path) => inspectSourceFile(root, path)));
  const candidateCatalog = inspected.map((file) => ({ ref: `fixture-source-candidate:${randomUUID()}`, path: file.path,
    size: Buffer.byteLength(file.content, 'utf8'), hash: file.hash.value, dev: file.dev, ino: file.ino, rootIdentity,
    expiresAt: new Date(Date.now() + 600_000).toISOString(), suggested: false }));
  session.intentSourceAuthorizationRequests = [{ id: 'source-confirmation', routingId: 'source-route', sourceEventId: 'source-request', workItemId: 'work',
    actorId: 'user', dataEpoch: session.dataEpoch, sessionGeneration: 1, workspaceBindingHash: 'fixture-binding',
    candidateRefs: candidateCatalog.map((candidate) => candidate.ref), candidateCatalog, prohibitions: options.prohibitions ?? [], revision: 1,
    expectedAuthorityRevision: 0, status: 'approved', createdAt: now, idempotencyKey: 'fixture-authorization', payloadHash: 'fixture-payload',
    decision: { idempotencyKey: 'fixture-authorization', payloadHash: 'fixture-payload', actorId: 'user', decidedAt: now } } as any];
  const scope = { sourceEventId: 'source-request', workspaceId: session.workspaceId, workItemId: 'work',
    candidateRefs: candidateCatalog.map((candidate) => candidate.ref), prohibitions: options.prohibitions ?? [] };
  state.eventsBySession = { session: [
    { id: 'source-request', sessionId: 'session', type: 'user_message', content: '请修改清单中的登录实现。',
      actor: { type: 'user', id: 'user' }, createdAt: now, toAgentIds: [],
      metadata: { schemaVersion: '0.1', renderAs: 'message', payload: {} } },
    { id: 'source-confirmed', sessionId: 'session', type: 'user_confirmation_resolved', content: '已确认源码授权范围。',
      actor: { type: 'user', id: 'user' }, createdAt: now, toAgentIds: [],
      metadata: { schemaVersion: '0.1', renderAs: 'system_notice', payload: { reason: 'intent_source_authorization',
        status: 'approved', confirmationId: 'source-confirmation', sourceAuthorization: scope } } }
  ] as CollaborationEvent[] };
  const initial = Object.fromEntries(Object.entries(state).filter(([key]) => !['intentRouteRevisionsBySession', 'intentPlanStepsBySession'].includes(key)));
  await persistence.mutateCollections(Object.keys(initial), draft => Object.assign(draft, initial));
  const store = new IntentSourceAuthorityStore(persistence);
  const authority = await store.issue({ sessionId: 'session', actorId: 'user', sourceEventId: 'source-request',
    confirmationId: 'source-confirmation', workItemId: 'work', expectedRevision: 0 });
  const readGrant = session.intentWorkspaceReadAuthority!.grant;
  const body = { effects: [
    { kind: 'modify_source', target: authority.grant.resource, evidenceRefs: ['source-request'] },
    { kind: 'read_workspace', target: readGrant.resource, evidenceRefs: ['source-request'] }
  ], prohibitions: [], grantIds: [authority.grant.id, readGrant.id] };
  const effectScope = { ...body, scopeHash: createHash('sha256').update(JSON.stringify(body)).digest('hex') };
  const binding: any = { mode: 'candidate_only', authorityId: authority.id, authorityRevision: authority.revision,
    authorityHash: authority.authorityHash, sourceResourceId: authority.sourceResourceId, grantId: authority.grant.id,
    workspaceId: authority.workspaceId, workspaceBindingHash: authority.workspaceBindingHash,
    sessionId: 'session', dataEpoch: session.dataEpoch, sessionGeneration: 1, workItemId: 'work', taskId: 'original-task',
    intentStepId: 'original-step', invocationId: 'source-invocation', operationId: 'original-operation', effectScopeHash: effectScope.scopeHash };
  await persistence.mutateCollections(['sessions', 'intentRouteRevisionsBySession', 'intentRoutingRecordsBySession',
    'intentPlanStepsBySession', 'logicalOperationsBySession'], draft => {
    const revisions: any = draft.intentRouteRevisionsBySession = structuredClone(state.intentRouteRevisionsBySession);
    const revision = revisions.session[0]; revision.authorityGrants = [authority.grant, readGrant];
    revision.validatedPlan.steps[0].effectScope = effectScope;
    revision.validatedPlan.steps[0].executionBinding.effectScopeHash = effectScope.scopeHash;
    const records: any = draft.intentPlanStepsBySession = structuredClone(state.intentPlanStepsBySession);
    records.session[0].step = structuredClone(revision.validatedPlan.steps[0]);
    const operations: any = draft.logicalOperationsBySession;
    operations.session[0].executionBinding = structuredClone(revision.validatedPlan.steps[0].executionBinding);
  });
  const saved: any = persistence.getCollection('intentPlanStepsBySession', {});
  const plan = { invocationId: binding.invocationId, sessionId: 'session', dataEpoch: session.dataEpoch,
    workItemId: 'work', taskId: 'original-task', phase: 'task_execution', admissionClass: 'business', intentStepId: 'original-step',
    sourceCandidateBinding: binding, effectScope, executionBinding: saved.session[0].step.executionBinding,
    operation: { id: operation.id, sessionGeneration: 1 }, agent: { agentId: 'backend', allowedRuntimeTypes: ['generic_llm'] },
    executionTarget: { runtimeType: 'generic_llm', workspaceProviderKind: 'server_local', executionLocation: 'server',
      writeMode: 'none', requiredCapabilities: ['read'], requiredToolIds: [], source: 'agent_default', reason: 'fixture' },
    expectedOutput: { kind: 'intent_source_candidate', schemaVersion: '1.0' },
    inputBudgetPolicy: { kind: 'agent_task', actorId: 'user', dataEpoch: session.dataEpoch, sessionGeneration: 1,
      taskId: 'original-task', slot: 'task:original-task:task_execution:original-operation' },
    contextEnvelope: { sessionId: session.id, workspaceId: session.workspaceId, L0: { workspace: { workspaceId: session.workspaceId, revision: { id: 'base', observedAt: now } } },
      L1: {}, L2: {}, L3: { files: [] } }, toolCatalog: { tools: [], decisions: [] },
    budget: { maxInputTokens: 16_000, maxOutputTokens: 2_000 } } as unknown as InvocationPlan;
  const provider = new ServerLocalWorkspaceProvider(root, { id: 'base', observedAt: now });
  const candidates = new IntentSourceCandidateService(persistence);
  return { directory, root, provider, plan, session, persistence, store, authority, binding, candidates,
    path: sourcePath, base: sourceBase, updated: sourceUpdated,
    proposal: { schemaVersion: '1.0', kind: 'intent_source_candidate', summary: '增加空密码校验',
      updates: Object.keys(files).map(path => ({ path, content: path === sourcePath ? sourceUpdated : files[path] + '\n// validated\n' })) } as any,
    async cleanup() { await persistence.onModuleDestroy(); await rm(directory, { recursive: true, force: true }); } };
}
