import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { BadRequestException, ConflictException, Injectable, Optional } from '@nestjs/common';
import { INTENT_TEST_SCRIPTS, type ChangeIntentTestAuthorityInput, type CollaborationEvent,
  type IntentTestAuthorityView, type IntentTestScript, type SessionDetail } from '@agent-cluster/shared';
import { PersistenceService } from '../persistence/persistence.service.js';
import type { SessionLifecyclesBySession } from '../runtimes/session-lifecycle-store.js';
import { EventsService } from '../events/events.service.js';
import { appendCorrectionEvent, correctionRows } from './intent-correction-state.js';
import { availableTestRunnerBindings, currentTestGrant, issueTestAuthority, testRunnerBinding } from './intent-test-authority.js';
import { IntentTestExecutorService } from './intent-test-executor.service.js';

function parseChange(body: unknown): ChangeIntentTestAuthorityInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('INTENT_TEST_AUTHORITY_INPUT_INVALID');
  const row = body as Record<string, unknown>;
  if (Object.keys(row).some(key => !['action', 'script', 'writeReport', 'dataEpoch', 'expectedBindingHash', 'expectedGrantRevision', 'idempotencyKey'].includes(key)) ||
    (row.writeReport !== undefined && (typeof row.writeReport !== 'boolean' || row.action !== 'grant')) ||
    (row.action !== 'grant' && row.action !== 'revoke') || !INTENT_TEST_SCRIPTS.includes(row.script as IntentTestScript) ||
    !Number.isSafeInteger(row.expectedGrantRevision) || Number(row.expectedGrantRevision) < 0 ||
    ['dataEpoch', 'expectedBindingHash', 'idempotencyKey'].some(key => typeof row[key] !== 'string' || !row[key] || (row[key] as string).length > 256)) {
    throw new BadRequestException('INTENT_TEST_AUTHORITY_INPUT_INVALID');
  }
  return row as ChangeIntentTestAuthorityInput;
}

@Injectable()
export class IntentTestAuthorityService {
  constructor(private readonly persistence: PersistenceService, @Optional() private readonly events?: EventsService,
    @Optional() private readonly tests?: IntentTestExecutorService) {}

  view(session: SessionDetail): IntentTestAuthorityView {
    return { sessionId: session.id, dataEpoch: session.dataEpoch, sessionRevision: session.revision ?? 1,
      availableBindings: availableTestRunnerBindings(session), authority: structuredClone(session.intentTestAuthority ?? null),
      enabled: Boolean(currentTestGrant(session)) };
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
        event.type === 'intent_test_authority_changed' && event.metadata.idempotencyKey === input.idempotencyKey);
      if (prior) {
        if (prior.actor?.id !== actorId || !isDeepStrictEqual(prior.metadata.payload?.request, input)) throw new ConflictException('INTENT_AUTHORITY_IDEMPOTENCY_CONFLICT');
        return { ...this.view(session), event: prior, idempotentReplay: true };
      }
      const old = session.intentTestAuthority;
      const binding = input.action === 'grant' ? testRunnerBinding(session, input.script) : old?.binding;
      if ((old?.grant.revision ?? 0) !== input.expectedGrantRevision || !binding || binding.script !== input.script ||
        input.expectedBindingHash !== binding.bindingHash) throw new ConflictException('INTENT_AUTHORITY_REVISION_CONFLICT');
      const now = new Date().toISOString(), eventId = randomUUID();
      if (input.action === 'grant') {
        const issued = issueTestAuthority(session, input.script, eventId, input.expectedGrantRevision + 1, input.writeReport === true);
        if (!issued) throw new ConflictException('INTENT_TEST_RUNNER_UNAVAILABLE');
        session.intentTestAuthority = issued;
      } else {
        if (!old) throw new ConflictException('INTENT_TEST_AUTHORITY_UNAVAILABLE');
        old.grant = { ...old.grant, revision: input.expectedGrantRevision + 1, revokedAt: now };
        if (old.reportGrant) old.reportGrant = { ...old.reportGrant, revision: input.expectedGrantRevision + 1, revokedAt: now };
      }
      session.revision = (session.revision ?? 1) + 1; session.updatedAt = now;
      const event: CollaborationEvent = { id: eventId, sessionId, type: 'intent_test_authority_changed', createdAt: now,
        toAgentIds: [], actor: { type: 'user', id: actorId },
        content: input.action === 'grant' ? `已授权在隔离环境运行 ${input.script} 测试${input.writeReport ? '并保存会话测试报告' : ''}。` : '已撤销隔离测试及其报告保存授权。',
        metadata: { schemaVersion: '0.1', renderAs: 'system_notice', idempotencyKey: input.idempotencyKey,
          payload: { request: structuredClone(input), grantRevision: session.intentTestAuthority!.grant.revision } } };
      appendCorrectionEvent(draft, event);
      return { ...this.view(session), event, idempotentReplay: false };
    }, { sessionIds: [sessionId] });
    // Replays also repair a lost post-commit notification; current grants protect newer invocations.
    this.tests?.authorityChanged(sessionId);
    this.events?.acceptCommitted(result.event);
    return result;
  }
}
