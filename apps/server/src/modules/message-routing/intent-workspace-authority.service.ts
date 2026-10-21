import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { BadRequestException, ConflictException, Injectable, Optional } from '@nestjs/common';
import type { CollaborationEvent, SessionDetail, ChangeIntentWorkspaceReadAuthorityInput, IntentWorkspaceReadAuthorityView } from '@agent-cluster/shared';
import { PersistenceService } from '../persistence/persistence.service.js';
import type { SessionLifecyclesBySession } from '../runtimes/session-lifecycle-store.js';
import { EventsService } from '../events/events.service.js';
import { appendCorrectionEvent, correctionRows } from './intent-correction-state.js';
import { currentWorkspaceReadGrant, issueWorkspaceReadAuthority, workspaceReadBindingHash } from './intent-workspace-read.js';

type Change = ChangeIntentWorkspaceReadAuthorityInput;

function parseChange(body: unknown): Change {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('INTENT_AUTHORITY_INPUT_INVALID');
  const row = body as Record<string, unknown>;
  if (Object.keys(row).some(key => !['action', 'dataEpoch', 'expectedBindingHash', 'expectedGrantRevision', 'idempotencyKey'].includes(key)) ||
    (row.action !== 'grant' && row.action !== 'revoke') || !Number.isSafeInteger(row.expectedGrantRevision) || Number(row.expectedGrantRevision) < 0 ||
    ['dataEpoch', 'expectedBindingHash', 'idempotencyKey'].some(key => typeof row[key] !== 'string' || !row[key] || (row[key] as string).length > 256)) {
    throw new BadRequestException('INTENT_AUTHORITY_INPUT_INVALID');
  }
  return row as Change;
}

@Injectable()
export class IntentWorkspaceAuthorityService {
  constructor(private readonly persistence: PersistenceService, @Optional() private readonly events?: EventsService) {}

  view(session: SessionDetail): IntentWorkspaceReadAuthorityView {
    return { sessionId: session.id, sessionRevision: session.revision ?? 1,
      dataEpoch: session.dataEpoch, bindingHash: workspaceReadBindingHash(session) ?? null,
      authority: structuredClone(session.intentWorkspaceReadAuthority ?? null), enabled: Boolean(currentWorkspaceReadGrant(session)) };
  }

  async change(sessionId: string, actorId: string, body: unknown) {
    const input = parseChange(body);
    const result = await this.persistence.mutateCollections(['sessions', 'sessionLifecyclesBySession', 'eventsBySession', 'eventOutbox'], draft => {
      const session = (draft.sessions as SessionDetail[] | undefined)?.find(row => row.id === sessionId);
      const lifecycle = (draft.sessionLifecyclesBySession as SessionLifecyclesBySession | undefined)?.[sessionId];
      if (!session || session.ownerId !== actorId || session.dataEpoch !== input.dataEpoch || session.archivedAt || session.status === 'CANCELLED' ||
        session.intentContractVersion !== 'intent-understanding-v1' || !lifecycle || lifecycle.state !== 'active' || lifecycle.dataEpoch !== input.dataEpoch) {
        throw new ConflictException('INTENT_SESSION_UNAVAILABLE');
      }
      const prior = correctionRows<CollaborationEvent>(draft, 'eventsBySession', sessionId).find(event =>
        event.type === 'intent_workspace_authority_changed' && event.metadata.idempotencyKey === input.idempotencyKey);
      if (prior) {
        if (prior.actor?.id !== actorId || !isDeepStrictEqual(prior.metadata.payload?.request, input)) throw new ConflictException('INTENT_AUTHORITY_IDEMPOTENCY_CONFLICT');
        // Return current authority, never the obsolete grant saved in the receipt.
        return { ...this.view(session), event: prior, idempotentReplay: true };
      }
      const authority = session.intentWorkspaceReadAuthority;
      const bindingHash = workspaceReadBindingHash(session);
      if ((authority?.grant.revision ?? 0) !== input.expectedGrantRevision ||
        input.expectedBindingHash !== (input.action === 'grant' ? bindingHash : authority?.bindingHash)) {
        throw new ConflictException('INTENT_AUTHORITY_REVISION_CONFLICT');
      }
      const now = new Date().toISOString(), eventId = randomUUID();
      if (input.action === 'grant') {
        const issued = issueWorkspaceReadAuthority(session, eventId, input.expectedGrantRevision + 1);
        if (!issued) throw new ConflictException('INTENT_WORKSPACE_READ_UNAVAILABLE');
        session.intentWorkspaceReadAuthority = issued;
      } else {
        if (!authority) throw new ConflictException('INTENT_WORKSPACE_READ_UNAVAILABLE');
        authority.grant = { ...authority.grant, revision: input.expectedGrantRevision + 1, revokedAt: now };
      }
      session.revision = (session.revision ?? 1) + 1; session.updatedAt = now;
      const event: CollaborationEvent = { id: eventId, sessionId, type: 'intent_workspace_authority_changed', createdAt: now,
        toAgentIds: [], actor: { type: 'user', id: actorId },
        content: input.action === 'grant' ? '已授权读取当前工作区。' : '已撤销工作区读取授权。',
        metadata: { schemaVersion: '0.1', renderAs: 'system_notice', idempotencyKey: input.idempotencyKey,
          payload: { request: structuredClone(input), grantRevision: session.intentWorkspaceReadAuthority!.grant.revision } } };
      appendCorrectionEvent(draft, event);
      return { ...this.view(session), event, idempotentReplay: false };
    }, { sessionIds: [sessionId] });
    this.events?.acceptCommitted(result.event);
    return result;
  }
}
