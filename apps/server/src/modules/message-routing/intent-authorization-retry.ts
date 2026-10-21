import { BadRequestException, ConflictException } from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
import { canRetryIntentAuthorization, type IntentRoutingRecord, type RetryIntentAuthorizationInput } from '@agent-cluster/shared';

export function assertAuthorizationRetryInput(value: unknown): asserts value is RetryIntentAuthorizationInput {
  const input = value as RetryIntentAuthorizationInput;
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
    Object.keys(input).some(key => !['contractVersion', 'dataEpoch', 'expectedRoutingRevision', 'idempotencyKey'].includes(key)) ||
    input.contractVersion !== 'intent-authorization-retry-v1' || !Number.isSafeInteger(input.expectedRoutingRevision) || input.expectedRoutingRevision < 1 ||
    ![input.dataEpoch, input.idempotencyKey].every(text => typeof text === 'string' && text.trim().length > 0 && text.length <= 256)) {
    throw new BadRequestException('INTENT_AUTHORIZATION_RETRY_INPUT_INVALID');
  }
}

export function bindAuthorizationRetry(route: IntentRoutingRecord, actorId: string, input: RetryIntentAuthorizationInput) {
  assertAuthorizationRetryInput(input);
  if (route.semanticProposal?.dataEpoch !== input.dataEpoch) throw new ConflictException('INTENT_DATA_EPOCH_CONFLICT');
  const receipt = route.authorizationRetryReceipts?.find(row => row.request.idempotencyKey === input.idempotencyKey);
  if (receipt) {
    if (receipt.actorId !== actorId || !isDeepStrictEqual(receipt.request, input)) throw new ConflictException('IDEMPOTENCY_PAYLOAD_CONFLICT');
    return receipt;
  }
  if (route.routingRevision !== input.expectedRoutingRevision) throw new ConflictException('INTENT_PLAN_REVISION_CONFLICT');
  if (!canRetryIntentAuthorization(route) || route.leaseOwner) throw new ConflictException('INTENT_AUTHORIZATION_RETRY_UNAVAILABLE');
}
