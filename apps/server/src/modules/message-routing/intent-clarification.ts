import { createHash } from 'node:crypto';
import { BadRequestException, ConflictException } from '@nestjs/common';
import type { ClarifyIntentRoutingInput, CollaborationEvent, IntentRoutingRecord } from '@agent-cluster/shared';

const choices = ['continue_current', 'related_new', 'independent_new'];

export function assertClarifyIntentRoutingInput(input: unknown): asserts input is ClarifyIntentRoutingInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BadRequestException('Invalid clarification payload.');
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => !['contractVersion', 'confirmationId', 'expectedRoutingRevision', 'choice', 'idempotencyKey'].includes(key)) ||
    !choices.includes(String(value.choice))) throw new BadRequestException('Invalid clarification payload.');
  for (const key of ['confirmationId', 'idempotencyKey']) {
    if (value[key] !== undefined && (typeof value[key] !== 'string' || !(value[key] as string).trim() || (value[key] as string).length > 200)) {
      throw new BadRequestException(`Invalid ${key}.`);
    }
  }
  if (value.expectedRoutingRevision !== undefined && (!Number.isSafeInteger(value.expectedRoutingRevision) || Number(value.expectedRoutingRevision) < 1)) {
    throw new BadRequestException('Invalid expectedRoutingRevision.');
  }
  if (value.contractVersion !== undefined && value.contractVersion !== 'intent-clarify-v1') throw new BadRequestException('Unsupported clarification contract.');
  if (value.contractVersion && (!value.confirmationId || !value.idempotencyKey || value.expectedRoutingRevision === undefined)) {
    throw new BadRequestException('Versioned clarification requires confirmationId, expectedRoutingRevision and idempotencyKey.');
  }
}

/** Call inside the same transaction that commits the route and the receipt. */
export function bindIntentClarification(routing: IntentRoutingRecord, events: CollaborationEvent[], input: ClarifyIntentRoutingInput) {
  assertClarifyIntentRoutingInput(input);
  const receipt = routing.resolution;
  const cards = events.filter(event => event.sessionId === routing.sessionId && event.type === 'intent_clarification_required' &&
    event.metadata?.renderAs === 'confirmation_card' && event.metadata.payload?.routingId === routing.id);
  const confirmationId = input.confirmationId ?? receipt?.confirmationId ??
    (cards.length === 1 ? String(cards[0].metadata.payload?.confirmationId ?? '') : '');
  const card = cards.find(event => event.metadata.payload?.confirmationId === confirmationId);
  if (!confirmationId || !card) throw new ConflictException('CLARIFICATION_CONFIRMATION_MISMATCH');
  const canonicalChoiceHash = createHash('sha256').update(JSON.stringify({ sessionId: routing.sessionId,
    routingId: routing.id, confirmationId, choice: input.choice })).digest('hex');
  const idempotencyKey = input.idempotencyKey ?? `legacy:${canonicalChoiceHash}`;
  if (receipt) {
    if (receipt.supersededAt) throw new ConflictException('CLARIFICATION_SUPERSEDED');
    if (receipt.confirmationId !== confirmationId) throw new ConflictException('CLARIFICATION_CONFIRMATION_MISMATCH');
    if (receipt.canonicalChoiceHash !== canonicalChoiceHash) {
      throw new ConflictException(receipt.idempotencyKey === idempotencyKey ? 'IDEMPOTENCY_PAYLOAD_CONFLICT' : 'CLARIFICATION_CHOICE_CONFLICT');
    }
    return { confirmationId, canonicalChoiceHash, idempotencyKey, replay: true, card };
  }
  if (routing.status !== 'CLARIFICATION_REQUIRED') throw new ConflictException('CLARIFICATION_NOT_PENDING');
  if (input.expectedRoutingRevision !== undefined && input.expectedRoutingRevision !== (routing.routingRevision ?? 1)) {
    throw new ConflictException('CLARIFICATION_REVISION_CONFLICT');
  }
  const payload = card.metadata.payload as Record<string, unknown>;
  if (typeof payload.routingRevision === 'number' && payload.routingRevision !== (routing.routingRevision ?? 1)) {
    throw new ConflictException('CLARIFICATION_REVISION_CONFLICT');
  }
  if (typeof payload.expiresAt === 'string' && (!Number.isFinite(Date.parse(payload.expiresAt)) || Date.parse(payload.expiresAt) <= Date.now())) {
    throw new ConflictException('CLARIFICATION_EXPIRED');
  }
  if (events.some(event => event.type === 'user_confirmation_resolved' && event.metadata?.payload?.confirmationId === confirmationId)) {
    throw new ConflictException('CLARIFICATION_ALREADY_RESOLVED');
  }
  if (!Array.isArray(payload.options) || !payload.options.some(option => option && typeof option === 'object' && (option as {key?: string}).key === input.choice)) {
    throw new ConflictException('CLARIFICATION_CHOICE_NOT_ALLOWED');
  }
  return { confirmationId, canonicalChoiceHash, idempotencyKey, replay: false, card };
}
