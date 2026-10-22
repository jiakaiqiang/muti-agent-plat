import { ConflictException, Injectable, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { CollaborationEvent, IntentSourceApplyClaim, IntentSourceApplyResolution, SessionDetail } from '@agent-cluster/shared';
import { PersistenceService } from '../persistence/persistence.service.js';
import { EventsService } from '../events/events.service.js';
import { IntentSourceAuthorityStore, inspectSourceFile, sourceHash, unresolvedSourceClaim } from './intent-source-authority.js';
import { appendCorrectionEvent } from './intent-correction-state.js';

const collections = ['sessions', 'eventsBySession', 'eventOutbox', 'intentReconciliationsBySession', 'workspaceWritebacks'];
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const contentHash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const owner = (state: any, sessionId: string, actorId: string) => {
  const session = (state.sessions as SessionDetail[] | undefined)?.find(row => row.id === sessionId);
  if (!session || session.ownerId !== actorId || session.intentContractVersion !== 'intent-understanding-v1' || session.archivedAt) throw new ConflictException('INTENT_SOURCE_SESSION_UNAVAILABLE');
  return session;
};

@Injectable()
export class IntentSourceReconciliationService {
  constructor(private readonly persistence: PersistenceService, @Optional() private readonly events?: EventsService) {}
  async view(sessionId: string, actorId: string) {
    const session = owner({ sessions: this.persistence.getCollection('sessions', []) }, sessionId, actorId);
    const result: any[] = [];
    for (const authority of session.intentSourceAuthorities ?? []) for (const claim of authority.applyClaims) {
      if (!unresolvedSourceClaim(session, claim)) continue;
      const candidate = session.intentSourceCandidates?.find(row => row.candidate?.id === claim.candidateId);
      const files = candidate ? await Promise.all(candidate.files.map(async file => {
        const update = candidate.candidate?.changeSet.changes.find(change => change.operation === 'update' && change.path === file.path);
        const targetHash = update && update.operation === 'update' ? contentHash(update.content) : file.hash.value;
        return { path: file.path, baseHash: file.hash.value, targetHash,
          currentHash: (await inspectSourceFile(authority.rootPath, file.path)).hash.value };
      })) : [];
      result.push({ id: `source-writeback:${claim.id}`, source: 'source_writeback', claim: structuredClone(claim), authorityId: authority.id,
        candidateId: claim.candidateId, evidence: { files, evidenceHash: hash(files), note: 'hash 只展示当前事实，不推断写入结果' }, actions: [
          { action: 'redispatch', enabled: files.every(file => file.currentHash === file.baseHash) },
          { action: 'confirm_completed', enabled: files.every(file => file.currentHash === file.targetHash) }, { action: 'abandon', enabled: true }] });
    }
    return result;
  }
  async decide(sessionId: string, claimId: string, actorId: string, raw: unknown) {
    const input = raw as { action: 'redispatch' | 'confirm_completed' | 'abandon'; expectedEvidenceHash: string; idempotencyKey: string };
    if (!input || !['redispatch', 'confirm_completed', 'abandon'].includes(input.action) || typeof input.expectedEvidenceHash !== 'string' || typeof input.idempotencyKey !== 'string') throw new ConflictException('INTENT_SOURCE_RECONCILIATION_INPUT_INVALID');
    const currentSession = owner({ sessions: this.persistence.getCollection('sessions', []) }, sessionId, actorId);
    const existing = currentSession.intentSourceApplyResolutions?.find(row => row.claimId === claimId && row.actorId === actorId && row.idempotencyKey === input.idempotencyKey);
    if (existing) {
      if (existing.action !== input.action || existing.evidenceHash !== input.expectedEvidenceHash) throw new ConflictException('INTENT_SOURCE_RECONCILIATION_IDEMPOTENCY_CONFLICT');
      return existing;
    }
    const evidence = (await this.view(sessionId, actorId)).find(row => row.claim.id === claimId);
    if (!evidence || evidence.evidence.evidenceHash !== input.expectedEvidenceHash) throw new ConflictException('INTENT_SOURCE_RECONCILIATION_EVIDENCE_STALE');
    const result = await this.persistence.mutateCollections(collections, draft => {
      const session = owner(draft, sessionId, actorId);
      const authority = session.intentSourceAuthorities?.find(row => row.applyClaims.some(claim => claim.id === claimId));
      const claim = authority?.applyClaims.find(row => row.id === claimId);
      if (!authority || !claim) throw new ConflictException('INTENT_SOURCE_RECONCILIATION_ALREADY_RESOLVED');
      const resolutions = session.intentSourceApplyResolutions ??= [];
      const prior = resolutions.find(row => row.claimId === claimId && row.actorId === actorId);
      if (prior) throw new ConflictException('INTENT_SOURCE_RECONCILIATION_ALREADY_RESOLVED');
      if (!unresolvedSourceClaim(session, claim)) throw new ConflictException('INTENT_SOURCE_RECONCILIATION_ALREADY_RESOLVED');
      const row: IntentSourceApplyResolution = { claimId, candidateId: claim.candidateId, action: input.action, actorId, idempotencyKey: input.idempotencyKey,
        evidenceHash: input.expectedEvidenceHash, files: evidence.evidence.files, createdAt: new Date().toISOString() };
      resolutions.push(row);
      const event: CollaborationEvent = { id: `source-reconciliation:${claimId}:${input.idempotencyKey}`, sessionId, type: 'user_confirmation_resolved', toAgentIds: [], createdAt: row.createdAt,
        content: input.action === 'redispatch' ? '已确认未写入，允许重新应用；服务端会再次验证候选和授权。' : input.action === 'confirm_completed' ? '已确认文件达到候选目标，按已应用处理。' : '已放弃该源码候选。',
        actor: { type: 'user', id: actorId }, metadata: { schemaVersion: '0.1', renderAs: 'system_notice', payload: { reason: 'source_writeback_reconciliation', claimId, action: input.action, evidenceHash: input.expectedEvidenceHash } } };
      appendCorrectionEvent(draft, event); return { session: structuredClone(session), event };
    }, { sessionIds: [sessionId] });
    if (result.event) this.events?.acceptCommitted(result.event);
    return result.session.intentSourceApplyResolutions?.at(-1);
  }
}
