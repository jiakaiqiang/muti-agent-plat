import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { assertIntentInvocationScope, type AgentTask, type IntentRouteRevision, type IntentSourceCandidateBinding, type IntentSourceCandidateOutput, type IntentSourceCandidateRecord,
  type InvocationPlan, type LogicalOperation, type RuntimeExecutionCandidate, type SessionDetail } from '@agent-cluster/shared';
import type { PersistenceService, PersistedState } from '../persistence/persistence.service.js';
import { assertIntentExecutionCurrent } from './intent-execution-guard.js';
import { assertNoPendingInputBudget } from './intent-resume-guard.js';
import { IntentSourceAuthorityStore, INTENT_SOURCE_COLLECTIONS, assertSourcePath, inspectSourceFile, sourceHash, sourceState } from './intent-source-authority.js';
import { currentWorkspaceReadGrant } from './intent-workspace-read.js';
import type { SessionLifecyclesBySession } from '../runtimes/session-lifecycle-store.js';
import { INTENT_SOURCE_WRITE_LIMITS } from '../workspaces/intent-source-write-guard.js';

const fail = (code: string): never => { throw new Error(`INTENT_SOURCE_${code}`); };
function bindingForPlan(plan: InvocationPlan): IntentSourceCandidateBinding {
  assertIntentInvocationScope(plan);
  const binding = plan.sourceCandidateBinding;
  if (!binding || plan.phase !== 'task_execution' || plan.admissionClass !== 'business' ||
    plan.expectedOutput.kind !== 'intent_source_candidate' || plan.expectedOutput.schemaVersion !== '1.0' ||
    binding.sessionId !== plan.sessionId || binding.dataEpoch !== plan.dataEpoch || binding.workItemId !== plan.workItemId ||
    binding.taskId !== plan.taskId || binding.intentStepId !== plan.intentStepId || binding.invocationId !== plan.invocationId ||
    binding.operationId !== plan.operation?.id || binding.sessionGeneration !== plan.operation?.sessionGeneration ||
    binding.effectScopeHash !== plan.effectScope?.scopeHash || binding.effectScopeHash !== plan.executionBinding?.effectScopeHash ||
    plan.executionTarget.writeMode !== 'none' || plan.executionTarget.requiredCapabilities.some(item => item !== 'read')) fail('CANDIDATE_PLAN_INVALID');
  return binding!;
}

function assertCurrent(state: PersistedState, plan: InvocationPlan) {
  const binding = bindingForPlan(plan), session = (state.sessions as SessionDetail[] | undefined)?.find(row => row.id === plan.sessionId);
  if (!session) fail('SESSION_UNAVAILABLE');
  assertNoPendingInputBudget(state, session!);
  const policy = plan.inputBudgetPolicy;
  if (!policy || policy.kind !== 'agent_task' || policy.actorId !== session!.ownerId || policy.dataEpoch !== binding.dataEpoch ||
    policy.sessionGeneration !== binding.sessionGeneration || policy.taskId !== binding.taskId ||
    policy.slot !== `task:${binding.taskId}:task_execution:${binding.operationId}`) fail('BUDGET_BINDING_INVALID');
  assertIntentExecutionCurrent(state, { ...plan, sessionGeneration: binding.sessionGeneration });
  const operation = ((state.logicalOperationsBySession ?? {}) as Record<string, LogicalOperation[]>)[plan.sessionId]?.find(row => row.id === binding.operationId);
  const lifecycle = (state.sessionLifecyclesBySession as SessionLifecyclesBySession | undefined)?.[plan.sessionId];
  const task = ((state.tasksBySession ?? {}) as Record<string, AgentTask[]>)[plan.sessionId]?.find(row => row.id === binding.taskId);
  if (session!.status !== 'EXECUTING' || lifecycle?.admission !== 'open' || !operation || operation.status !== 'running' ||
    operation.activeInvocationId !== binding.invocationId || !operation.invocationIds.includes(binding.invocationId) ||
    !operation.ownerId || operation.stopState !== 'none' || operation.pauseRequested || operation.phase !== plan.phase ||
    operation.admissionClass !== plan.admissionClass || !Number.isFinite(Date.parse(operation.deadlineAt)) ||
    Date.parse(operation.deadlineAt) <= Date.now() || operation.remainingActiveMs <= 0 ||
    !isDeepStrictEqual(operation.executionBinding, plan.executionBinding) || task?.status !== 'running') fail('OPERATION_STALE');
  if (plan.effectScope!.effects.some(effect => effect.kind === 'read_workspace')) {
    const grant = currentWorkspaceReadGrant(session!);
    const revision = ((state.intentRouteRevisionsBySession ?? {}) as Record<string, IntentRouteRevision[]>)[plan.sessionId]?.find(row =>
      row.routingId === plan.executionBinding?.routingId && row.intentRevision === plan.executionBinding?.intentRevision);
    if (!grant || !plan.effectScope!.grantIds.includes(grant.id) || !revision?.authorityGrants?.some(saved => isDeepStrictEqual(saved, grant)) ||
      plan.effectScope!.effects.some(effect => effect.kind === 'read_workspace' && !isDeepStrictEqual(effect.target, grant.resource))) {
      fail('WORKSPACE_READ_AUTHORITY_STALE');
    }
  }
  return session!;
}

function parseProposal(value: unknown): IntentSourceCandidateOutput {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item);
  const exact = (item: Record<string, unknown>, keys: string[]) => Object.keys(item).length === keys.length && keys.every(key => Object.hasOwn(item, key));
  if (!object(value) || !exact(value, ['schemaVersion', 'kind', 'summary', 'updates']) || value.schemaVersion !== '1.0' ||
    value.kind !== 'intent_source_candidate' || typeof value.summary !== 'string' || !value.summary || value.summary.length > 4000 ||
    !Array.isArray(value.updates) || !value.updates.length || value.updates.length > 16 || value.updates.some(update =>
      !object(update) || !exact(update, ['path', 'content']) || typeof update.path !== 'string' || typeof update.content !== 'string' ||
      Buffer.byteLength(update.content) > 262144 || update.content.includes('\0') || Buffer.from(update.content).toString('utf8') !== update.content)) fail('PROPOSAL_INVALID');
  return value as unknown as IntentSourceCandidateOutput;
}

export class IntentSourceCandidateService {
  private readonly authorities: IntentSourceAuthorityStore;
  constructor(private readonly persistence: PersistenceService) { this.authorities = new IntentSourceAuthorityStore(persistence); }

  async assertLive(plan: InvocationPlan) {
    const binding = bindingForPlan(plan);
    await this.authorities.loadLive(binding); assertCurrent(sourceState(this.persistence), plan);
  }

  /** Persist the exact pre-call content before passing these files to the model. */
  async prepare(plan: InvocationPlan) {
    const binding = bindingForPlan(plan), authority = await this.authorities.loadLive(binding);
    const before = assertCurrent(sourceState(this.persistence), plan);
    const existing = before.intentSourceCandidates?.find(row => row.binding.invocationId === plan.invocationId);
    if (existing) {
      if (!isDeepStrictEqual(existing.binding, binding)) fail('CANDIDATE_BINDING_MISMATCH');
      if (existing.candidate) fail('CANDIDATE_ALREADY_CAPTURED');
      return { files: structuredClone(existing.files) };
    }
    const inspected = await Promise.all(authority.files.map(file => inspectSourceFile(authority.rootPath, file.path)));
    if (inspected.some((file, index) => file.dev !== authority.files[index].dev || file.ino !== authority.files[index].ino)) fail('FILE_IDENTITY_STALE');
    if (inspected.reduce((bytes, file) => bytes + Buffer.byteLength(file.content), 0) > INTENT_SOURCE_WRITE_LIMITS.totalBytes) fail('FILE_LIMIT');
    await this.authorities.loadLive(binding);
    const files = inspected.map(({ path, content, hash }) => ({ path, content, hash }));
    const now = new Date().toISOString();
    const snapshot: IntentSourceCandidateRecord = { id: `source-snapshot:${randomUUID()}`, binding: structuredClone(binding), files,
      baseRevision: structuredClone(plan.contextEnvelope.L0.workspace.revision), createdAt: now,
      snapshotHash: sourceHash({ binding, files, baseRevision: plan.contextEnvelope.L0.workspace.revision }) };
    return this.persistence.mutateCollections([...INTENT_SOURCE_COLLECTIONS], draft => {
      const session = assertCurrent(draft, plan); this.authorities.assertLiveInDraft(draft, binding);
      const records = session.intentSourceCandidates ??= [], replay = records.find(row => row.binding.invocationId === plan.invocationId);
      if (replay) {
        if (!isDeepStrictEqual(replay.binding, binding) || replay.candidate) fail('CANDIDATE_BINDING_MISMATCH');
        return { files: structuredClone(replay.files) };
      }
      records.push(snapshot); return { files: structuredClone(files) };
    }, { sessionIds: [plan.sessionId] });
  }

  async capture(plan: InvocationPlan, raw: unknown): Promise<RuntimeExecutionCandidate> {
    const proposal = parseProposal(raw), binding = bindingForPlan(plan);
    await this.assertLive(plan);
    const id = `source-candidate:${randomUUID()}`, changeSetId = `source-changeset:${randomUUID()}`, now = new Date().toISOString();
    return this.persistence.mutateCollections([...INTENT_SOURCE_COLLECTIONS], draft => {
      const session = assertCurrent(draft, plan), authority = this.authorities.assertLiveInDraft(draft, binding);
      const snapshot = session.intentSourceCandidates?.find(row => row.binding.invocationId === plan.invocationId);
      if (!snapshot || !isDeepStrictEqual(snapshot.binding, binding)) fail('CANDIDATE_PREPARE_REQUIRED');
      const proposalHash = sourceHash(proposal);
      if (snapshot!.candidate) {
        if (snapshot!.proposalHash !== proposalHash) fail('CANDIDATE_PAYLOAD_CONFLICT');
        return structuredClone(snapshot!.candidate!);
      }
      const paths = proposal.updates.map(update => assertSourcePath(update.path));
      if (new Set(paths).size !== paths.length || paths.some(path => !authority.files.some(file => file.path === path))) fail('FILE_OUTSIDE_MANIFEST');
      const changes = proposal.updates.map(update => {
        const original = snapshot!.files.find(file => file.path === update.path);
        if (!original) return fail('FILE_OUTSIDE_READSET');
        return { operation: 'update' as const, path: update.path, content: update.content, encoding: 'utf-8' as const,
          expectedHash: structuredClone(original.hash), baseContent: original.content };
      });
      const changeSet = { id: changeSetId, baseRevision: structuredClone(snapshot!.baseRevision), changes, createdAt: now };
      const candidate: RuntimeExecutionCandidate = { id, invocationId: plan.invocationId, sessionId: plan.sessionId,
        taskId: plan.taskId, workItemId: plan.workItemId, workspaceId: authority.workspaceId, baseRevision: snapshot!.baseRevision,
        changeSet, manifestHash: sourceHash({ changeSet, binding, readSet: snapshot!.files.map(({ path, hash }) => ({ path, hash })) }),
        permissionHash: createHash('sha256').update(JSON.stringify({ authorityHash: authority.authorityHash, scopeHash: binding.effectScopeHash })).digest('hex'),
        outputVersion: '1.0', createdAt: now, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), stage: 'candidate_captured' };
      const tasks = ((draft.tasksBySession ?? {}) as Record<string, AgentTask[]>)[plan.sessionId] ?? [];
      const task = tasks.find(row => row.id === binding.taskId);
      if (!task || task.executionCheckpoint) fail('CANDIDATE_TASK_CHECKPOINT_CONFLICT');
      snapshot!.candidate = candidate; snapshot!.proposalHash = proposalHash;
      task!.executionCheckpoint = { operationId: binding.operationId, invocationId: binding.invocationId,
        candidateId: candidate.id, candidateHash: candidate.manifestHash, stage: 'candidate_captured' };
      return structuredClone(candidate);
    }, { sessionIds: [plan.sessionId] });
  }
}
