import { BadRequestException, ConflictException, Injectable, Optional } from '@nestjs/common';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { CollaborationEvent, IntentRoutingRecord, IntentSourceAuthorizationCandidate, IntentSourceAuthorizationRequest, SessionDetail, WorkItem } from '@agent-cluster/shared';
import { PersistenceService, type PersistedState } from '../persistence/persistence.service.js';
import { EventsService } from '../events/events.service.js';
import { appendCorrectionEvent, correctionRows as rows } from './intent-correction-state.js';
import { assertSourcePath, inspectSourceFile, inspectSourceRoot, IntentSourceAuthorityStore, sourceHash } from './intent-source-authority.js';
import { workspaceReadBindingHash } from './intent-workspace-read.js';
import { INTENT_SOURCE_WRITE_LIMITS } from '../workspaces/intent-source-write-guard.js';
import { scanSourceAuthorizationCandidates, SOURCE_AUTH_CANDIDATE_PAGE_SIZE, SOURCE_AUTH_CANDIDATE_TOTAL_LIMIT } from './intent-source-authorization-candidates.js';

export const SOURCE_AUTH_COLLECTIONS = ['sessions', 'sessionLifecyclesBySession', 'workItemsBySession', 'intentRoutingRecordsBySession', 'eventsBySession', 'eventOutbox'];
export function sourceOwner(state: PersistedState, sessionId: string, actorId: string) {
  const session = (state.sessions as SessionDetail[] | undefined)?.find(row => row.id === sessionId);
  const life = (state.sessionLifecyclesBySession as Record<string, { state: string; dataEpoch: string; generation: number }> | undefined)?.[sessionId];
  if (!session || session.ownerId !== actorId || session.intentContractVersion !== 'intent-understanding-v1' || session.archivedAt ||
    session.status === 'CANCELLED' || !session.dataEpoch || life?.state !== 'active' || life.dataEpoch !== session.dataEpoch) throw new ConflictException('INTENT_SOURCE_SESSION_UNAVAILABLE');
  return { session, generation: life.generation };
}
export function isSourceFollowUp(route?: IntentRoutingRecord) {
  const parts = route?.semanticProposal?.understanding?.segments;
  return Boolean(parts?.length === 1 && parts[0].scopeRelation === 'same_requirement' && parts[0].suggestedAction === 'enqueue_follow_up' &&
    parts[0].requestedEffects.some(effect => effect.kind === 'modify_source'));
}
function key(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 && value.length <= 200; }

const cursorSecret = randomBytes(32);
function encodeCursor(value: { requestId: string; query: string; offset: number; rootIdentity: { realPath: string; dev: string; ino: string } }) {
  const body = Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  const signature = createHmac('sha256', cursorSecret).update(body).digest('base64url');
  return `${body}.${signature}`;
}
function decodeCursor(value: unknown) {
  if (typeof value !== 'string' || value.length > 2000) throw new BadRequestException('INTENT_SOURCE_CANDIDATE_CURSOR_INVALID');
  const [body, signature] = value.split('.');
  if (!body || !signature || createHmac('sha256', cursorSecret).update(body).digest('base64url') !== signature) {
    throw new BadRequestException('INTENT_SOURCE_CANDIDATE_CURSOR_INVALID');
  }
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { requestId?: unknown; query?: unknown; offset?: unknown; rootIdentity?: unknown };
    if (typeof parsed.requestId !== 'string' || typeof parsed.query !== 'string' || typeof parsed.offset !== 'number' || !Number.isSafeInteger(parsed.offset) || parsed.offset < 0 ||
      !parsed.rootIdentity || typeof parsed.rootIdentity !== 'object') throw new Error('invalid');
    return parsed as { requestId: string; query: string; offset: number; rootIdentity: { realPath: string; dev: string; ino: string } };
  } catch { throw new BadRequestException('INTENT_SOURCE_CANDIDATE_CURSOR_INVALID'); }
}

function suggestedPaths(session: SessionDetail, route?: IntentRoutingRecord): Set<string> {
  const paths = new Set<string>();
  for (const file of session.workspaceSnapshot?.files ?? []) paths.add(file.path);
  for (const request of session.supplementalContextRequests ?? []) {
    for (const path of request.resolution.hydratedPaths ?? []) paths.add(path);
    for (const path of request.resolution.readPaths ?? []) paths.add(path);
  }
  for (const segment of route?.semanticProposal?.understanding?.segments ?? []) {
    for (const evidence of segment.evidence) {
      if (evidence.refId.includes('/') || /\.[A-Za-z0-9]+$/.test(evidence.refId)) paths.add(evidence.refId.replace(/\\/g, '/'));
    }
  }
  return paths;
}

async function validateOwnerScope(persistence: PersistenceService, sessionId: string, actorId: string, paths: string[]) {
  const state = persistence.snapshotState();
  const { session } = sourceOwner(state, sessionId, actorId);
  const rootPath = session.workingDirectory?.path;
  if (!rootPath || session.workingDirectory?.kind !== 'server_local') throw new ConflictException('INTENT_SOURCE_WORKSPACE_UNAVAILABLE');
  paths.forEach(assertSourcePath);
  if (new Set(paths.map(path => path.toLowerCase())).size !== paths.length) throw new BadRequestException('INTENT_SOURCE_PATH_ALIAS');
  const rootIdentity = await inspectSourceRoot(rootPath);
  const files = await Promise.all(paths.map(path => inspectSourceFile(rootPath, path)));
  if (files.reduce((total, file) => total + Buffer.byteLength(file.content), 0) > INTENT_SOURCE_WRITE_LIMITS.totalBytes) {
    throw new ConflictException('INTENT_SOURCE_FILE_LIMIT');
  }
  return { paths: [...paths].sort(), rootIdentity, files };
}

/** Scope is entered explicitly by the owner, never extracted from a model path or Brief. */
@Injectable()
export class IntentSourceAuthorizationService {
  constructor(private readonly persistence: PersistenceService, @Optional() private readonly events?: EventsService) {}
  async request(sessionId: string, actorId: string, raw: unknown) {
    const input = raw as { routingId: string; expectedRoutingRevision: number; idempotencyKey: string };
    if (!input || Object.keys(input).some(k => !['routingId', 'expectedRoutingRevision', 'idempotencyKey'].includes(k)) ||
      !key(input.idempotencyKey) || !key(input.routingId) || !Number.isSafeInteger(input.expectedRoutingRevision)) {
      throw new BadRequestException('INTENT_SOURCE_AUTHORIZATION_INPUT_INVALID');
    }
    const payloadHash = sourceHash(input);
    const result = await this.persistence.mutateCollections(SOURCE_AUTH_COLLECTIONS, draft => {
      const { session, generation } = sourceOwner(draft, sessionId, actorId);
      const requests = session.intentSourceAuthorizationRequests ??= [];
      const replay = requests.find(row => row.idempotencyKey === input.idempotencyKey);
      if (replay) { if (replay.payloadHash !== payloadHash) throw new ConflictException('INTENT_SOURCE_IDEMPOTENCY_CONFLICT'); return { request: structuredClone(replay) }; }
      const route = rows<IntentRoutingRecord>(draft, 'intentRoutingRecordsBySession', sessionId).find(row => row.id === input.routingId);
      const workId = route?.semanticProposal?.understanding?.segments[0]?.target.workItemId;
      const work = rows<WorkItem>(draft, 'workItemsBySession', sessionId).find(row => row.id === workId);
      const source = rows<CollaborationEvent>(draft, 'eventsBySession', sessionId).find(row => row.id === route?.sourceEventId && row.type === 'user_message' && row.actor?.id === actorId && row.actor.type === 'user');
      const binding = workspaceReadBindingHash(session);
      if (!isSourceFollowUp(route) || !route || route.rolloutMode === 'shadow' || route.routingRevision !== input.expectedRoutingRevision || route.dispatchHold ||
        !work || work.id !== session.activeWorkItemId || work.dispatchHold || ['CANCELLED', 'COMPLETED'].includes(work.status) || !source || !binding ||
        session.workingDirectory?.kind !== 'server_local' || !session.workspaceContext?.binding.capabilities.write) throw new ConflictException('INTENT_SOURCE_AUTHORIZATION_TARGET_STALE');
      if (requests.some(row => row.routingId === route.id && row.status === 'approved')) throw new ConflictException('INTENT_SOURCE_AUTHORIZATION_ALREADY_APPROVED');
      const request: IntentSourceAuthorizationRequest = { id: `intent-source-confirm:${randomUUID()}`, routingId: route.id, sourceEventId: source.id, workItemId: work.id,
        actorId, dataEpoch: session.dataEpoch!, sessionGeneration: generation, workspaceBindingHash: binding, candidateRefs: [], candidateCatalog: [], prohibitions: [], revision: 1, status: 'pending', createdAt: new Date().toISOString(),
        expectedAuthorityRevision: Math.max(0, ...(session.intentSourceAuthorities ?? []).filter(row => row.workItemId === work.id && row.dataEpoch === session.dataEpoch).map(row => row.revision)),
        idempotencyKey: input.idempotencyKey, payloadHash };
      requests.push(request);
      const event: CollaborationEvent = { id: `card:${request.id}`, sessionId, workItemId: work.id, type: 'user_confirmation_requested', toAgentIds: [], createdAt: request.createdAt,
        content: '源码范围尚未确定，请从服务端候选文件中选择精确清单和禁止项；批准后这些文件可能被自动修改并写回。',
        metadata: { schemaVersion: '0.1', renderAs: 'confirmation_card', payload: { reason: 'intent_source_authorization', confirmationId: request.id,
          routingId: route.id, sourceEventId: source.id, requestRevision: request.revision, sessionRevision: session.revision ?? 1,
          sourceAuthorization: { sourceEventId: source.id, workspaceId: session.workspaceId, workItemId: work.id, candidateRefs: request.candidateRefs, prohibitions: request.prohibitions },
          scopeResolved: false, explanation: '仅 update 既有 UTF-8 文件；不允许创建、删除、移动、命令或绕过禁止项。读取许可与 Brief 确认均不授写权限。',
          options: [{ key: 'approve', label: '批准此清单' }, { key: 'reject', label: '拒绝授权' }] } } };
      appendCorrectionEvent(draft, event); return { request: structuredClone(request), event };
    }, { sessionIds: [sessionId] });
    if (result.event) this.events?.acceptCommitted(result.event);
    return result.request;
  }

  async candidates(sessionId: string, requestId: string, actorId: string, raw: unknown = {}) {
    const input = raw as { query?: unknown; cursor?: unknown; limit?: unknown };
    if (!input || Object.keys(input).some((key) => !['query', 'cursor', 'limit'].includes(key)) ||
      (input.query !== undefined && (typeof input.query !== 'string' || input.query.length > 200)) ||
      (input.limit !== undefined && (typeof input.limit !== 'number' || !Number.isSafeInteger(input.limit) || input.limit < 1))) {
      throw new BadRequestException('INTENT_SOURCE_CANDIDATE_QUERY_INVALID');
    }
    const state = this.persistence.snapshotState();
    const { session } = sourceOwner(state, sessionId, actorId);
    const request = session.intentSourceAuthorizationRequests?.find((row) => row.id === requestId && row.actorId === actorId);
    if (!request || request.status !== 'pending') throw new ConflictException('INTENT_SOURCE_AUTHORIZATION_TARGET_STALE');
    const rootPath = session.workingDirectory?.path;
    if (!rootPath || session.workingDirectory?.kind !== 'server_local') throw new ConflictException('INTENT_SOURCE_WORKSPACE_UNAVAILABLE');
    const route = rows<IntentRoutingRecord>(state, 'intentRoutingRecordsBySession', sessionId).find((row) => row.id === request.routingId);
    const cursor = input.cursor === undefined ? undefined : decodeCursor(input.cursor);
    const rootIdentity = await inspectSourceRoot(rootPath);
    if (cursor && (cursor.requestId !== requestId || cursor.query !== (input.query ?? '') || JSON.stringify(cursor.rootIdentity) !== JSON.stringify(rootIdentity))) {
      throw new ConflictException('INTENT_SOURCE_CANDIDATE_CURSOR_STALE');
    }
    const scanned = await scanSourceAuthorizationCandidates({ rootPath, query: input.query as string | undefined, suggestedPaths: suggestedPaths(session, route), prior: request.candidateCatalog });
    const offset = cursor?.offset ?? 0;
    const pageSize = Math.min((input.limit as number | undefined) ?? SOURCE_AUTH_CANDIDATE_PAGE_SIZE, SOURCE_AUTH_CANDIDATE_PAGE_SIZE);
    const page = scanned.filtered.slice(offset, offset + pageSize);
    const nextOffset = offset + page.length;
    const result = await this.persistence.mutateCollections(['sessions'], (draft) => {
      const currentSession = (draft.sessions as SessionDetail[]).find((row) => row.id === sessionId)!;
      const current = currentSession.intentSourceAuthorizationRequests?.find((row) => row.id === requestId && row.actorId === actorId);
      if (!current || current.status !== 'pending' || current.workspaceBindingHash !== workspaceReadBindingHash(currentSession)) throw new ConflictException('INTENT_SOURCE_AUTHORIZATION_TARGET_STALE');
      const byPath = new Map((current.candidateCatalog ?? []).map((candidate) => [candidate.path, candidate]));
      for (const candidate of scanned.catalog) byPath.set(candidate.path, candidate);
      current.candidateCatalog = [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path)).slice(0, SOURCE_AUTH_CANDIDATE_TOTAL_LIMIT);
      return { candidates: page.map((candidate) => ({ ref: candidate.ref, path: candidate.path, size: candidate.size, hash: candidate.hash, suggested: candidate.suggested, expiresAt: candidate.expiresAt })),
        nextCursor: nextOffset < scanned.total ? encodeCursor({ requestId, query: input.query as string ?? '', offset: nextOffset, rootIdentity }) : undefined,
        total: scanned.total, truncated: scanned.truncated || nextOffset < scanned.total, ...(scanned.truncatedReason ? { truncatedReason: scanned.truncatedReason } : {}) };
    }, { sessionIds: [sessionId] });
    return result;
  }

  async decide(sessionId: string, requestId: string, actorId: string, raw: unknown) {
    const input = raw as { action: 'approve' | 'reject'; expectedRequestRevision: number; expectedSessionRevision: number; idempotencyKey: string; candidateRefs: string[]; prohibitions: Array<'no_schema_change'> };
    if (!input || Object.keys(input).some(k => !['action', 'expectedRequestRevision', 'expectedSessionRevision', 'idempotencyKey', 'candidateRefs', 'prohibitions'].includes(k)) ||
      !['approve', 'reject'].includes(input.action) || !key(input.idempotencyKey) || !Number.isSafeInteger(input.expectedRequestRevision) || !Number.isSafeInteger(input.expectedSessionRevision) ||
      !Array.isArray(input.candidateRefs) || input.candidateRefs.length > INTENT_SOURCE_WRITE_LIMITS.files || input.candidateRefs.some(ref => !key(ref)) ||
      !Array.isArray(input.prohibitions) || input.prohibitions.some(item => item !== 'no_schema_change') ||
      (input.action === 'reject' && (input.candidateRefs.length !== 0 || input.prohibitions.length !== 0))) throw new BadRequestException('INTENT_SOURCE_AUTHORIZATION_DECISION_INVALID');
    const scope = input.action === 'approve' ? await this.resolveCandidateRefs(sessionId, requestId, actorId, input.candidateRefs) : undefined;
    const payloadHash = sourceHash(input);
    const result = await this.persistence.mutateCollections(SOURCE_AUTH_COLLECTIONS, draft => {
      const { session, generation } = sourceOwner(draft, sessionId, actorId);
      const request = session.intentSourceAuthorizationRequests?.find(row => row.id === requestId);
      if (!request || request.actorId !== actorId || request.dataEpoch !== session.dataEpoch || request.sessionGeneration !== generation ||
        request.workspaceBindingHash !== workspaceReadBindingHash(session) || request.workItemId !== session.activeWorkItemId) throw new ConflictException('INTENT_SOURCE_AUTHORIZATION_TARGET_STALE');
      const reused = session.intentSourceAuthorizationRequests?.find(row => row.decision?.idempotencyKey === input.idempotencyKey);
      if (reused && reused.id !== request.id) throw new ConflictException('INTENT_SOURCE_IDEMPOTENCY_CONFLICT');
      if (request.decision) {
        if (request.decision.payloadHash !== payloadHash || request.decision.idempotencyKey !== input.idempotencyKey) throw new ConflictException('INTENT_SOURCE_IDEMPOTENCY_CONFLICT');
        return { request: structuredClone(request) };
      }
      const route = rows<IntentRoutingRecord>(draft, 'intentRoutingRecordsBySession', sessionId).find(row => row.id === request.routingId);
      if (request.status !== 'pending' || request.revision !== input.expectedRequestRevision || (session.revision ?? 1) !== input.expectedSessionRevision ||
        !route || route.dispatchHold || session.intentSourceAuthorizationRequests?.filter(row => row.routingId === request.routingId).at(-1)?.id !== request.id) throw new ConflictException('INTENT_SOURCE_AUTHORIZATION_REVISION_CONFLICT');
      if (input.action === 'approve' && (!scope?.paths.length || !scope.rootIdentity)) throw new ConflictException('INTENT_SOURCE_EXACT_FILES_REQUIRED');
      if (input.action === 'approve') { request.candidateRefs = [...input.candidateRefs]; request.prohibitions = [...new Set(input.prohibitions)].sort(); }
      request.status = input.action === 'approve' ? 'approved' : 'rejected'; request.revision++;
      request.decision = { idempotencyKey: input.idempotencyKey, payloadHash, actorId, decidedAt: new Date().toISOString() };
      const event: CollaborationEvent = { id: `resolved:${request.id}`, sessionId, workItemId: request.workItemId, type: 'user_confirmation_resolved', actor: { type: 'user', id: actorId }, toAgentIds: [], createdAt: request.decision.decidedAt,
        content: input.action === 'approve' ? '已批准精确源码范围，服务端正在重新核验签发。' : '已拒绝这条消息的源码授权。',
        metadata: { schemaVersion: '0.1', renderAs: 'system_notice', payload: { reason: 'intent_source_authorization', confirmationId: request.id, status: request.status,
          sourceAuthorization: { sourceEventId: request.sourceEventId, workspaceId: session.workspaceId, workItemId: request.workItemId, candidateRefs: request.candidateRefs, prohibitions: request.prohibitions } } } };
      appendCorrectionEvent(draft, event); return { request: structuredClone(request), event };
    }, { sessionIds: [sessionId] });
    if (result.event) this.events?.acceptCommitted(result.event);
    const authority = result.request.status === 'approved' ? await new IntentSourceAuthorityStore(this.persistence).issue({ sessionId, actorId, sourceEventId: result.request.sourceEventId,
      confirmationId: result.request.id, workItemId: result.request.workItemId, expectedRevision: result.request.expectedAuthorityRevision }) : undefined;
    return { request: result.request, authority };
  }

  private async resolveCandidateRefs(sessionId: string, requestId: string, actorId: string, refs: string[]) {
    const state = this.persistence.snapshotState();
    const { session } = sourceOwner(state, sessionId, actorId);
    const request = session.intentSourceAuthorizationRequests?.find((row) => row.id === requestId && row.actorId === actorId);
    const rootPath = session.workingDirectory?.path;
    if (!request || !rootPath || session.workingDirectory?.kind !== 'server_local') throw new ConflictException('INTENT_SOURCE_CANDIDATE_REF_INVALID');
    const unique = new Set(refs);
    if (unique.size !== refs.length || refs.length === 0) throw new ConflictException('INTENT_SOURCE_EXACT_FILES_REQUIRED');
    const records = refs.map((ref) => request.candidateCatalog?.find((candidate) => candidate.ref === ref));
    if (records.some((record) => !record)) throw new ConflictException('INTENT_SOURCE_CANDIDATE_REF_INVALID');
    const rootIdentity = await import('./intent-source-authority.js').then(({ inspectSourceRoot }) => inspectSourceRoot(rootPath));
    const paths: string[] = [];
    let bytes = 0;
    for (const record of records as IntentSourceAuthorizationCandidate[]) {
      if (Date.parse(record.expiresAt) <= Date.now() || JSON.stringify(record.rootIdentity) !== JSON.stringify(rootIdentity)) throw new ConflictException('INTENT_SOURCE_CANDIDATE_STALE');
      const inspected = await import('./intent-source-authority.js').then(({ inspectSourceFile }) => inspectSourceFile(rootPath, record.path));
      if (inspected.dev !== record.dev || inspected.ino !== record.ino || inspected.hash.value !== record.hash) throw new ConflictException('INTENT_SOURCE_CANDIDATE_STALE');
      bytes += Buffer.byteLength(inspected.content, 'utf8'); paths.push(record.path);
    }
    if (bytes > INTENT_SOURCE_WRITE_LIMITS.totalBytes) throw new ConflictException('INTENT_SOURCE_FILE_LIMIT');
    return { paths: paths.sort(), rootIdentity };
  }
}
