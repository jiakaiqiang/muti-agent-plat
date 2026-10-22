import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { AgentTask, CollaborationEvent, IntentEffectGrant, IntentEffectScope, IntentExecutionBinding, IntentPlanStepRecord, IntentRouteRevision, IntentSourceAuthorizationCandidate, IntentSourceAuthority,
  IntentSourceApplyClaim, IntentSourceCandidateBinding, IntentSourceCandidateRecord, IntentSourceProhibition,
  LogicalOperation, SessionDetail, WorkspaceChangeSet, WorkItem } from '@agent-cluster/shared';
import type { PersistenceService, PersistedState } from '../persistence/persistence.service.js';
import type { SessionLifecyclesBySession } from '../runtimes/session-lifecycle-store.js';
import { workspaceReadBindingHash } from './intent-workspace-read.js';
import { INTENT_SOURCE_WRITE_LIMITS } from '../workspaces/intent-source-write-guard.js';

export const INTENT_SOURCE_COLLECTIONS = ['sessions', 'sessionLifecyclesBySession', 'workItemsBySession', 'tasksBySession',
  'logicalOperationsBySession', 'intentRoutingRecordsBySession', 'intentRouteRevisionsBySession', 'intentPlanStepsBySession',
  'decisionRecordsBySession', 'intentReconciliationsBySession', 'runtimeInvocationsBySession', 'eventsBySession'] as const;
export const sourceHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (code: string): never => { throw new Error(`INTENT_SOURCE_${code}`); };
const rows = <T>(state: PersistedState, key: string, sessionId: string): T[] =>
  ((state[key] ?? {}) as Record<string, T[]>)[sessionId] ?? [];
const sessions = (state: PersistedState) => (state.sessions ?? []) as SessionDetail[];
export const sourceWriterInstanceId = randomUUID();
const activeSourceClaims = new Set<string>();
export function isSourceClaimLive(claim: IntentSourceApplyClaim) {
  if (claim.outcome) return false;
  if (claim.writerInstanceId === sourceWriterInstanceId) return activeSourceClaims.has(claim.id);
  if (!claim.writerPid) return false;
  try { process.kill(claim.writerPid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
export function unresolvedSourceClaim(session: SessionDetail, claim: IntentSourceApplyClaim) {
  return (!claim.outcome || claim.outcome === 'unknown') && !session.intentSourceApplyResolutions?.some(row => row.claimId === claim.id);
}

export function sourceAuthorityPayload(row: IntentSourceAuthority) {
  const { authorityHash: _hash, revokedAt: _revoked, revokedBy: _by, applyClaims: _claims, ...body } = row; return body;
}

/** Exact spelling only: no normalization that could turn untrusted aliases into authorized paths. */
export function assertSourcePath(path: string): string {
  if (typeof path !== 'string' || !path || path.length > 512 || isAbsolute(path) || /[\\:\0]/.test(path) ||
    path.split('/').some(part => !part || ['.', '..'].includes(part) || /[.\s]$/.test(part) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) fail('PATH_INVALID');
  return path;
}

/** Links/hard-link aliases are rejected even if they happen to point inside the root. */
export async function inspectSourceFile(rootPath: string, path: string) {
  assertSourcePath(path); let current = rootPath;
  const parts = path.split('/');
  for (let i = 0; i < parts.length; i++) {
    const names = await readdir(current);
    if (!names.includes(parts[i])) fail('PATH_CASE_OR_MISSING');
    current = join(current, parts[i]);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) fail('PATH_LINK');
    if (i < parts.length - 1 && !metadata.isDirectory()) fail('PATH_INVALID');
    if (i === parts.length - 1 && (!metadata.isFile() || metadata.nlink !== 1)) fail('FILE_REQUIRED');
  }
  const metadata = await lstat(current);
  if (metadata.size > INTENT_SOURCE_WRITE_LIMITS.fileBytes) fail('FILE_LIMIT');
  const handle = await open(current, 'r');
  let content: Buffer;
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.ino !== metadata.ino || before.dev !== metadata.dev ||
      before.size !== metadata.size || before.mtimeMs !== metadata.mtimeMs) fail('FILE_CHANGED');
    const buffer = Buffer.alloc(INTENT_SOURCE_WRITE_LIMITS.fileBytes + 1); let length = 0;
    while (length < buffer.length) {
      const next = await handle.read(buffer, length, buffer.length - length, length);
      if (!next.bytesRead) break; length += next.bytesRead;
    }
    const after = await handle.stat(), pathAfter = await lstat(current);
    if (length > INTENT_SOURCE_WRITE_LIMITS.fileBytes || length !== before.size || after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs || pathAfter.isSymbolicLink() || pathAfter.nlink !== 1 ||
      pathAfter.ino !== before.ino || pathAfter.dev !== before.dev || pathAfter.size !== before.size || pathAfter.mtimeMs !== before.mtimeMs) fail('FILE_CHANGED');
    content = buffer.subarray(0, length);
  } finally { await handle.close(); }
  if (content.includes(0)) fail('UTF8_REQUIRED');
  let decoded: string;
  try { decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content); }
  catch { return fail('UTF8_REQUIRED'); }
  return { path, content: decoded, hash: { algorithm: 'sha256' as const, value: createHash('sha256').update(content).digest('hex') },
    dev: String(metadata.dev), ino: String(metadata.ino) };
}

export async function inspectSourceRoot(rootPath: string) {
  for (let ancestor = resolve(rootPath); ;) {
    const metadata = await lstat(ancestor);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) fail('ROOT_LINK');
    const parent = dirname(ancestor); if (parent === ancestor) break; ancestor = parent;
  }
  const metadata = await lstat(rootPath);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail('ROOT_INVALID');
  const realPath = await realpath(rootPath);
  if (resolve(realPath) !== resolve(rootPath)) fail('ROOT_LINK');
  return { realPath, dev: String(metadata.dev), ino: String(metadata.ino) };
}

function assertSession(state: PersistedState, sessionId: string, actorId?: string) {
  const session = sessions(state).find(row => row.id === sessionId);
  const life = (state.sessionLifecyclesBySession as SessionLifecyclesBySession | undefined)?.[sessionId];
  if (!session || session.intentContractVersion !== 'intent-understanding-v1' || session.archivedAt ||
    session.status === 'CANCELLED' || !session.dataEpoch || !life || life.state !== 'active' || life.dataEpoch !== session.dataEpoch) fail('SESSION_UNAVAILABLE');
  if (actorId && session!.ownerId !== actorId) fail('AUTHORITY_OWNER');
  return { session: session!, generation: life!.generation };
}

function confirmedScope(state: PersistedState, input: { sessionId: string; actorId: string; sourceEventId: string;
  confirmationId: string; workItemId: string }) {
  const { session, generation } = assertSession(state, input.sessionId, input.actorId);
  if (session.workingDirectory?.kind !== 'server_local' || !workspaceReadBindingHash(session) ||
    !session.workspaceContext?.binding?.capabilities.write) fail('WORKSPACE_UNAVAILABLE');
  const source = rows<CollaborationEvent>(state, 'eventsBySession', session.id).find(row => row.id === input.sourceEventId &&
    row.type === 'user_message' && row.actor?.type === 'user' && row.actor.id === input.actorId);
  const confirmations = rows<CollaborationEvent>(state, 'eventsBySession', session.id).filter(row => row.type === 'user_confirmation_resolved' &&
    row.actor?.type === 'user' && row.actor.id === input.actorId && row.metadata.payload?.reason === 'intent_source_authorization' &&
    row.metadata.payload.status === 'approved' && row.metadata.payload.confirmationId === input.confirmationId);
  if (!source || confirmations.length !== 1) fail('CONFIRMATION_REQUIRED');
  const raw = confirmations[0].metadata.payload!.sourceAuthorization as Record<string, unknown> | undefined;
  const work = rows<WorkItem>(state, 'workItemsBySession', session.id).find(row => row.id === input.workItemId);
  const request = session.intentSourceAuthorizationRequests?.find(row => row.id === input.confirmationId && row.status === 'approved');
  const refs = raw && Array.isArray(raw.candidateRefs) ? raw.candidateRefs : undefined;
  if (!work || work.dispatchHold || ['CANCELLED', 'COMPLETED'].includes(work.status) || !raw || !request ||
    raw.sourceEventId !== source!.id || raw.workspaceId !== session.workspaceId || raw.workItemId !== work.id ||
    !Array.isArray(refs) || !refs.length || refs.length > INTENT_SOURCE_WRITE_LIMITS.files || refs.some(ref => typeof ref !== 'string') ||
    !Array.isArray(request.candidateRefs) || request.candidateRefs.length !== refs.length || request.candidateRefs.some((ref, index) => ref !== refs[index]) ||
    !Array.isArray(raw.prohibitions) || raw.prohibitions.some(item => item !== 'no_schema_change')) fail('CONFIRMATION_REQUIRED');
  const approvedRequest = request!;
  const candidateRecords = (refs as string[]).map((ref: string) => approvedRequest.candidateCatalog?.find((candidate) => candidate.ref === ref));
  if (candidateRecords.some((candidate): candidate is undefined => !candidate) || candidateRecords.some((candidate) => Date.parse(candidate!.expiresAt) <= Date.now())) fail('CANDIDATE_STALE');
  const paths = (candidateRecords as IntentSourceAuthorizationCandidate[]).map(candidate => assertSourcePath(candidate.path));
  if (new Set(paths.map(path => path.toLocaleLowerCase('en-US'))).size !== paths.length) fail('PATH_ALIAS');
  return { session, generation, work, confirmation: confirmations[0], candidateRecords: candidateRecords as IntentSourceAuthorizationCandidate[], paths: [...paths].sort(),
    prohibitions: [...new Set(raw!.prohibitions as IntentSourceProhibition[])].sort() };
}

export function currentSourceGrants(session: SessionDetail): IntentEffectGrant[] {
  const hash = workspaceReadBindingHash(session);
  return (session.intentSourceAuthorities ?? []).filter(row => !row.revokedAt && !row.grant.revokedAt && row.dataEpoch === session.dataEpoch &&
    row.workspaceBindingHash === hash && row.actorId === session.ownerId &&
    row.workspaceId === session.workspaceId && row.grant.effect === 'modify_source' && row.grant.revision === row.revision &&
    row.grant.sourceEventId === row.sourceEventId && row.grant.resource.kind === 'source' && row.grant.resource.refId === row.sourceResourceId &&
    row.authorityHash === sourceHash(sourceAuthorityPayload(row)) &&
    !(session.intentSourceAuthorities ?? []).some(next => next.workItemId === row.workItemId && next.dataEpoch === row.dataEpoch && next.revision > row.revision))
    .map(row => structuredClone(row.grant));
}

/** Pure locked-facts check, usable from every persistence transaction and execution fence. */
export function assertLiveSourceAuthorityInDraft(state: PersistedState, binding: IntentSourceCandidateBinding): IntentSourceAuthority {
  const { session, generation } = assertSession(state, binding.sessionId);
  const authority = session.intentSourceAuthorities?.find(row => row.id === binding.authorityId);
  if (!authority || authority.actorId !== session.ownerId || authority.sessionId !== session.id ||
    authority.dataEpoch !== session.dataEpoch || authority.sessionGeneration !== generation ||
    binding.dataEpoch !== session.dataEpoch || binding.sessionGeneration !== generation) fail('AUTHORITY_STALE');
  if (authority!.revokedAt) fail('AUTHORITY_REVOKED');
  if (authority!.authorityHash !== sourceHash(sourceAuthorityPayload(authority!)) || authority!.revision !== binding.authorityRevision ||
    authority!.authorityHash !== binding.authorityHash || authority!.grant.id !== binding.grantId ||
    authority!.sourceResourceId !== binding.sourceResourceId || authority!.grant.resource.kind !== 'source' ||
    authority!.grant.resource.refId !== binding.sourceResourceId || authority!.grant.effect !== 'modify_source' ||
    authority!.grant.revision !== binding.authorityRevision || binding.mode !== 'candidate_only' ||
    authority!.workspaceId !== session.workspaceId || binding.workspaceId !== session.workspaceId ||
    authority!.workItemId !== binding.workItemId || workspaceReadBindingHash(session) !== binding.workspaceBindingHash ||
    binding.workspaceBindingHash !== authority!.workspaceBindingHash || !currentSourceGrants(session).some(row => row.id === binding.grantId)) fail('AUTHORITY_BINDING_MISMATCH');
  const task = rows<AgentTask>(state, 'tasksBySession', session.id).find(row => row.id === binding.taskId);
  const operation = rows<LogicalOperation>(state, 'logicalOperationsBySession', session.id).find(row => row.id === binding.operationId);
  const work = rows<WorkItem>(state, 'workItemsBySession', session.id).find(row => row.id === binding.workItemId);
  if (!task || task.stale || task.status === 'cancelled' || task.workItemId !== binding.workItemId || task.executionOperationId !== binding.operationId ||
    !work || work.dispatchHold || ['CANCELLED', 'COMPLETED'].includes(work.status) || !operation ||
    operation.taskId !== binding.taskId || operation.workItemId !== binding.workItemId || operation.intentStepId !== binding.intentStepId ||
    operation.dataEpoch !== binding.dataEpoch || operation.sessionGeneration !== binding.sessionGeneration ||
    operation.executionBinding?.effectScopeHash !== binding.effectScopeHash || operation.executionBinding.sessionGeneration !== binding.sessionGeneration ||
    (!operation.invocationIds.includes(binding.invocationId) && operation.activeInvocationId !== binding.invocationId) ||
    (work.requirementRevision ?? 1) !== operation.executionBinding.requirementRevision ||
    (work.executionEpoch ?? 1) !== operation.executionBinding.executionEpoch) fail('EXECUTION_BINDING_MISMATCH');
  return authority!;
}

export function sourceState(persistence: PersistenceService): PersistedState {
  return Object.fromEntries(INTENT_SOURCE_COLLECTIONS.map(key => [key, persistence.getCollection(key, key === 'sessions' ? [] : {})]));
}

export class IntentSourceAuthorityStore {
  constructor(private readonly persistence: PersistenceService) {}
  assertLiveInDraft(state: PersistedState, binding: IntentSourceCandidateBinding) { return assertLiveSourceAuthorityInDraft(state, binding); }
  async loadLive(binding: IntentSourceCandidateBinding) {
    const authority = structuredClone(this.assertLiveInDraft(sourceState(this.persistence), binding));
    if (!isDeepStrictEqual(authority.rootIdentity, await inspectSourceRoot(authority.rootPath))) fail('ROOT_STALE');
    let bytes = 0;
    for (const file of authority.files) {
      const current = await inspectSourceFile(authority.rootPath, file.path);
      if (current.dev !== file.dev || current.ino !== file.ino) fail('FILE_IDENTITY_STALE');
      bytes += Buffer.byteLength(current.content);
      if (bytes > INTENT_SOURCE_WRITE_LIMITS.totalBytes) fail('FILE_LIMIT');
    }
    // Recheck every exact path after the complete read, including intermediate link checks.
    const finalFiles = await Promise.all(authority.files.map(file => inspectSourceFile(authority.rootPath, file.path)));
    if (finalFiles.some((file, index) => file.dev !== authority.files[index].dev || file.ino !== authority.files[index].ino)) fail('FILE_IDENTITY_STALE');
    if (finalFiles.reduce((total, file) => total + Buffer.byteLength(file.content), 0) > INTENT_SOURCE_WRITE_LIMITS.totalBytes) fail('FILE_LIMIT');
    if (!isDeepStrictEqual(authority.rootIdentity, await inspectSourceRoot(authority.rootPath))) fail('ROOT_STALE');
    this.assertLiveInDraft(sourceState(this.persistence), binding);
    return authority;
  }

  async issue(input: { sessionId: string; actorId: string; sourceEventId: string; confirmationId: string;
    workItemId: string; expectedRevision: number }): Promise<IntentSourceAuthority> {
    const snapshot = confirmedScope(sourceState(this.persistence), input);
    const rootPath = snapshot.session.workingDirectory?.path;
    if (!rootPath) return fail('WORKSPACE_UNAVAILABLE');
    const rootIdentity = await inspectSourceRoot(rootPath);
    const inspected = await Promise.all(snapshot.paths.map(path => inspectSourceFile(rootPath, path)));
    if (inspected.some((file, index) => file.dev !== snapshot.candidateRecords[index]?.dev || file.ino !== snapshot.candidateRecords[index]?.ino || file.hash.value !== snapshot.candidateRecords[index]?.hash)) fail('CANDIDATE_STALE');
    if (inspected.reduce((bytes, file) => bytes + Buffer.byteLength(file.content), 0) > INTENT_SOURCE_WRITE_LIMITS.totalBytes) fail('FILE_LIMIT');
    if (new Set(inspected.map(file => `${file.dev}:${file.ino}`)).size !== inspected.length) fail('PATH_ALIAS');
    if (!isDeepStrictEqual(rootIdentity, await inspectSourceRoot(rootPath))) fail('ROOT_STALE');
    const id = `intent-source-authority:${randomUUID()}`, now = new Date().toISOString();
    return this.persistence.mutateCollections([...INTENT_SOURCE_COLLECTIONS], draft => {
      const current = confirmedScope(draft, input);
      if (sourceHash(snapshot) !== sourceHash(current)) fail('CONFIRMATION_STALE');
      const authorities = current.session.intentSourceAuthorities ??= [];
      const replay = authorities.find(row => row.confirmationId === input.confirmationId);
      if (replay) return structuredClone(replay);
      const revision = Math.max(0, ...authorities.filter(row => row.workItemId === input.workItemId && row.dataEpoch === current.session.dataEpoch).map(row => row.revision));
      if (revision !== input.expectedRevision) fail('AUTHORITY_REVISION_CONFLICT');
      if (authorities.some(row => row.applyClaims.some(claim => unresolvedSourceClaim(current.session, claim)))) fail('APPLY_BUSY');
      const row: IntentSourceAuthority = { id, sessionId: current.session.id, dataEpoch: current.session.dataEpoch!,
        sessionGeneration: current.generation, workItemId: input.workItemId, workspaceId: current.session.workspaceId,
        workspaceBindingHash: workspaceReadBindingHash(current.session)!, actorId: input.actorId, sourceEventId: input.sourceEventId,
        confirmationId: input.confirmationId, confirmationEventId: current.confirmation.id, revision: revision + 1,
        authorityHash: '', sourceResourceId: `source:${id}`, rootPath, rootIdentity,
        files: inspected.map(({ path, dev, ino }) => ({ path, dev, ino })), prohibitions: current.prohibitions,
        grant: { id: `grant:${id}`, effect: 'modify_source', resource: { kind: 'source', refId: `source:${id}` },
          revision: revision + 1, sourceEventId: input.sourceEventId }, createdAt: now, applyClaims: [] };
      row.authorityHash = sourceHash(sourceAuthorityPayload(row)); authorities.push(row); return structuredClone(row);
    }, { sessionIds: [input.sessionId] });
  }

  async revoke(input: { sessionId: string; actorId: string; authorityId?: string; id?: string; expectedRevision: number }) {
    return this.persistence.mutateCollections(['sessions', 'sessionLifecyclesBySession'], draft => {
      const { session } = assertSession(draft, input.sessionId, input.actorId);
      const authority = session.intentSourceAuthorities?.find(row => row.id === (input.authorityId ?? input.id));
      if (!authority || authority.revision !== input.expectedRevision) fail('AUTHORITY_REVISION_CONFLICT');
      if (authority!.applyClaims.some(claim => unresolvedSourceClaim(session, claim))) fail('APPLY_BUSY');
      authority!.revokedAt ??= new Date().toISOString(); authority!.revokedBy ??= input.actorId;
      return structuredClone(authority!);
    }, { sessionIds: [input.sessionId] });
  }

  bindingForCandidate(input: { sessionId: string; taskId?: string; invocationId: string; changeSetId: string; changeSet?: WorkspaceChangeSet }) {
    const session = this.persistence.getCollection<SessionDetail[]>('sessions', []).find(row => row.id === input.sessionId);
    const matches = session?.intentSourceCandidates?.filter(row => row.binding.invocationId === input.invocationId) ?? [];
    if (!matches.length) {
      // Never let a lost/incomplete candidate projection downgrade a source invocation to legacy writeback.
      const state = sourceState(this.persistence);
      type InvocationEvidence = { invocationId: string; sourceCandidateBinding?: IntentSourceCandidateBinding;
        effectScope?: IntentEffectScope; executionBinding?: IntentExecutionBinding; expectedOutput?: { kind: string } };
      const logs = rows<InvocationEvidence>(state, 'runtimeInvocationsBySession', input.sessionId)
        .filter(row => row.invocationId === input.invocationId);
      const bindings = logs.map(row => row.executionBinding).filter((row): row is IntentExecutionBinding => !!row);
      bindings.push(...rows<LogicalOperation>(state, 'logicalOperationsBySession', input.sessionId)
        .filter(row => row.activeInvocationId === input.invocationId || row.invocationIds.includes(input.invocationId))
        .flatMap(row => row.executionBinding ? [row.executionBinding] : []));
      const sourceScope = (scope?: IntentEffectScope) => scope?.effects.some(effect => effect.kind === 'modify_source');
      const persistedSource = bindings.some(binding =>
        rows<IntentRouteRevision>(state, 'intentRouteRevisionsBySession', input.sessionId).some(revision =>
          revision.routingId === binding.routingId && revision.intentRevision === binding.intentRevision &&
          revision.validatedPlan?.steps.some(step => step.effectScope.scopeHash === binding.effectScopeHash && sourceScope(step.effectScope))) ||
        rows<IntentPlanStepRecord>(state, 'intentPlanStepsBySession', input.sessionId).some(record =>
          record.routingId === binding.routingId && record.intentRevision === binding.intentRevision &&
          record.step.effectScope.scopeHash === binding.effectScopeHash && sourceScope(record.step.effectScope)));
      if (persistedSource || logs.some(row => row.sourceCandidateBinding || row.expectedOutput?.kind === 'intent_source_candidate' || sourceScope(row.effectScope))) {
        fail('CANDIDATE_REQUIRED');
      }
      return undefined;
    }
    if (matches.length !== 1 || matches[0].binding.taskId !== input.taskId) fail('CANDIDATE_BINDING_MISMATCH');
    if (!matches[0].candidate) fail('CANDIDATE_REQUIRED');
    if (matches[0].candidate!.changeSet.id !== input.changeSetId ||
      (input.changeSet && !isDeepStrictEqual(input.changeSet, matches[0].candidate!.changeSet))) fail('CANDIDATE_BINDING_MISMATCH');
    return structuredClone(matches[0].binding);
  }

  async beginApply(binding: IntentSourceCandidateBinding, input: { writebackId: string; attemptId: string }): Promise<IntentSourceApplyClaim> {
    await this.loadLive(binding);
    const id = randomUUID(), now = new Date().toISOString();
    const saved = await this.persistence.mutateCollections([...INTENT_SOURCE_COLLECTIONS], draft => {
      const authority = this.assertLiveInDraft(draft, binding);
      const session = sessions(draft).find(row => row.id === binding.sessionId)!;
      const captured = session.intentSourceCandidates?.find(row => isDeepStrictEqual(row.binding, binding));
      if (!captured?.candidate) fail('CANDIDATE_REQUIRED');
      const claims = session.intentSourceAuthorities!.flatMap(row => row.applyClaims);
      if (claims.some(claim => unresolvedSourceClaim(session, claim))) fail('APPLY_BUSY');
      const resolutions = session.intentSourceApplyResolutions ?? [];
      if (claims.some(claim => claim.candidateId === captured!.candidate!.id && claim.outcome === 'applied') ||
        resolutions.some(row => row.candidateId === captured!.candidate!.id && row.action === 'confirm_completed')) fail('CANDIDATE_ALREADY_APPLIED');
      const redispatch = resolutions.find(row => row.candidateId === captured!.candidate!.id && row.action === 'redispatch');
      if (redispatch && claims.some(claim => claim.candidateId === captured!.candidate!.id && claim.createdAt > redispatch.createdAt)) fail('CANDIDATE_REDISPATCH_ALREADY_USED');
      if (resolutions.some(row => row.candidateId === captured!.candidate!.id && row.action === 'abandon')) fail('CANDIDATE_ABANDONED');
      const claim: IntentSourceApplyClaim = { id, sessionId: binding.sessionId, authorityId: binding.authorityId,
        invocationId: binding.invocationId, candidateId: captured!.candidate!.id, writebackId: input.writebackId,
        attemptId: input.attemptId, createdAt: now, writerPid: process.pid, writerInstanceId: sourceWriterInstanceId };
      authority.applyClaims.push(claim); return structuredClone(claim);
    }, { sessionIds: [binding.sessionId] });
    activeSourceClaims.add(saved.id); return saved;
  }

  async finishApply(claim: IntentSourceApplyClaim, outcome: 'applied' | 'not_applied' | 'unknown') {
    const saved = await this.persistence.mutateCollections(['sessions'], draft => {
      const authority = sessions(draft).find(row => row.id === claim.sessionId)?.intentSourceAuthorities?.find(row => row.id === claim.authorityId);
      const stored = authority?.applyClaims.find(row => row.id === claim.id);
      if (!stored || !isDeepStrictEqual({ ...stored, outcome: undefined, finishedAt: undefined },
        { ...claim, outcome: undefined, finishedAt: undefined })) fail('APPLY_CLAIM_INVALID');
      if (stored!.outcome && stored!.outcome !== outcome) fail('APPLY_CLAIM_INVALID');
      stored!.outcome = outcome; stored!.finishedAt ??= new Date().toISOString(); return structuredClone(stored!);
    }, { sessionIds: [claim.sessionId] });
    activeSourceClaims.delete(claim.id); return saved;
  }
}
