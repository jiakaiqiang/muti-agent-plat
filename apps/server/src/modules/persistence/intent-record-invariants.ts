import { isDeepStrictEqual } from 'node:util';

export const INTENT_RECORD_TABLES = {
  intentRouteRevisionsBySession: 'intent_route_revisions',
  intentResolutionReceiptsBySession: 'intent_resolution_receipts',
  intentCorrectionsBySession: 'intent_corrections',
  intentPlanStepsBySession: 'intent_plan_steps'
} as const;
export type IntentRecordCollection = keyof typeof INTENT_RECORD_TABLES;

/** Stable uniqueness and immutable content, shared by both persistence backends. */
export function intentRecordIdentity(key: IntentRecordCollection, item: Record<string, unknown>) {
  const required = (value: unknown) => {
    if (typeof value !== 'string' || !value) throw new Error('INTENT_RECORD_IDENTITY_INVALID');
    return value;
  };
  const positive = (value: unknown) => {
    if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error('INTENT_RECORD_REVISION_INVALID');
    return value as number;
  };
  required(item.id); required(item.sessionId); required(item.dataEpoch); required(item.routingId);
  switch (key) {
    case 'intentRouteRevisionsBySession': return JSON.stringify([item.routingId, positive(item.intentRevision)]);
    case 'intentResolutionReceiptsBySession': return JSON.stringify([item.routingId,
      required((item.resolution as Record<string, unknown> | undefined)?.confirmationId)]);
    case 'intentCorrectionsBySession': return JSON.stringify([required(item.actorId), required(item.idempotencyKey)]);
    case 'intentPlanStepsBySession': return JSON.stringify([item.routingId, positive(item.intentRevision), required(item.localKey)]);
  }
}

export function immutableIntentPayload(key: IntentRecordCollection, item: Record<string, unknown>) {
  if (key === 'intentRouteRevisionsBySession' || key === 'intentResolutionReceiptsBySession') return item;
  if (key === 'intentPlanStepsBySession') {
    const { status: _status, updatedAt: _updated, processing: _processing, failureCode: _failure, failureDetail: _detail,
      responseEventId: _response, resultArtifactId: _artifact, resultBriefId: _brief,
      briefOperationId: _briefOperation, briefRetryReceipts: _briefRetries, resumeReceipts: _resumeReceipts, retryReceipts: _retryReceipts, ...payload } = item;
    return payload;
  }
  const { status: _status, updatedAt: _updated, reasonCodes: _reasons, routingRevision: _revision,
    processing: _processing, failureClass: _failure, validationErrors: _errors, supersededByCorrectionId: _superseded,
    effectReconciliation: _reconciliation, ...payload } = item;
  return payload;
}

export function assertIntentRecordMutation(before: Record<string, unknown>, after: Record<string, unknown>, allowed?: Set<string>) {
  for (const session of (after.sessions as Array<Record<string, unknown>> | undefined) ?? []) {
    const old = (before.sessions as Array<Record<string, unknown>> | undefined)?.find(row => row.id === session.id);
    const past = old?.activeRecoveryCheckpoint as Record<string, unknown> | undefined;
    const current = session.activeRecoveryCheckpoint as Record<string, unknown> | undefined;
    if (past?.retryBinding && past.confirmationId === current?.confirmationId && !isDeepStrictEqual(past.retryBinding, current?.retryBinding)) {
      throw new Error('INTENT_RETRY_BINDING_IMMUTABLE');
    }
  }
  if (after.intentRoutingRecordsBySession && typeof after.intentRoutingRecordsBySession === 'object') {
    const previous = (before.intentRoutingRecordsBySession ?? {}) as Record<string, Array<Record<string, unknown>>>;
    for (const [sessionId, routes] of Object.entries(after.intentRoutingRecordsBySession as typeof previous)) for (const route of routes) {
      const old = previous[sessionId]?.find(row => row.id === route.id);
      if (old?.briefRevision && !isDeepStrictEqual(old.briefRevision, route.briefRevision)) throw new Error('INTENT_BRIEF_REVISION_IMMUTABLE_CONFLICT');
    }
  }
  if (after.briefsBySession && typeof after.briefsBySession === 'object') {
    const previous = (before.briefsBySession ?? {}) as Record<string, Array<Record<string, unknown>>>;
    for (const [sessionId, briefs] of Object.entries(after.briefsBySession as typeof previous)) for (const brief of briefs) {
      const old = previous[sessionId]?.find(row => row.id === brief.id);
      if (!old?.intentBinding) continue;
      const body = (row: Record<string, unknown>) => {
        const { confirmedByUser: _confirmed, confirmedAt: _at, intentConfirmationReceipt: _receipt, ...rest } = row; return rest;
      };
      if (!isDeepStrictEqual(body(old), body(brief)) || (old.confirmedByUser === true && brief.confirmedByUser !== true) ||
        (old.confirmedAt && brief.confirmedAt !== old.confirmedAt) ||
        (old.intentConfirmationReceipt && !isDeepStrictEqual(old.intentConfirmationReceipt, brief.intentConfirmationReceipt))) throw new Error('INTENT_BRIEF_IMMUTABLE_CONFLICT');
    }
  }
  for (const key of Object.keys(INTENT_RECORD_TABLES) as IntentRecordCollection[]) {
    if (!(key in after)) continue;
    const oldGroups = (before[key] ?? {}) as Record<string, Array<Record<string, unknown>>>;
    const groups = after[key] as typeof oldGroups;
    if (!groups || typeof groups !== 'object' || Array.isArray(groups)) throw new Error('INTENT_RECORD_COLLECTION_INVALID');
    for (const sessionId of new Set([...Object.keys(oldGroups), ...Object.keys(groups)])) {
      const old = oldGroups[sessionId] ?? [];
      const items = groups[sessionId] ?? [];
      if (allowed && !allowed.has(sessionId) && !isDeepStrictEqual(old, items)) throw new Error(`COLLECTION_SCOPE_VIOLATION: ${key}:${sessionId}`);
      if (!Array.isArray(items)) throw new Error('INTENT_RECORD_COLLECTION_INVALID');
      const ids = new Set<string>();
      const identities = new Set<string>();
      for (const item of items) {
        if (item.sessionId !== sessionId) throw new Error('INTENT_RECORD_SESSION_MISMATCH');
        const identity = JSON.stringify([item.dataEpoch, intentRecordIdentity(key, item)]);
        if (ids.has(String(item.id)) || identities.has(identity)) throw new Error('INTENT_RECORD_UNIQUE_CONFLICT');
        ids.add(String(item.id)); identities.add(identity);
        const previous = old.find(record => record.id === item.id);
        if (key === 'intentPlanStepsBySession') {
          assertResumeReceipts(previous, item);
          assertRetryReceipts(previous, item);
          if ((previous?.step as Record<string, unknown> | undefined)?.action === 'review_brief' && previous?.status === 'completed') {
            const oldResult = (previous.processing as Record<string, unknown> | undefined)?.result;
            const newResult = (item.processing as Record<string, unknown> | undefined)?.result;
            if (!isDeepStrictEqual(oldResult, newResult) || previous.responseEventId !== item.responseEventId) {
              throw new Error('INTENT_BRIEF_REVIEW_RECEIPT_IMMUTABLE');
            }
          }
          const receipts = item.briefRetryReceipts as Array<Record<string, unknown>> | undefined;
          const past = (previous?.briefRetryReceipts ?? []) as Array<Record<string, unknown>>;
          if ((receipts !== undefined && !Array.isArray(receipts)) ||
            !isDeepStrictEqual(past, (receipts ?? []).slice(0, past.length)) ||
            new Set((receipts ?? []).map(row => row.id)).size !== (receipts ?? []).length ||
            (receipts?.length && item.briefOperationId !== receipts.at(-1)?.operationId) ||
            (previous?.briefOperationId !== item.briefOperationId && previous && (receipts?.length ?? 0) !== past.length + 1)) {
            throw new Error('INTENT_BRIEF_RETRY_RECEIPT_CONFLICT');
          }
        }
        if (!isDeepStrictEqual(previous, item) && Array.isArray(after.sessions)) {
          const session = (after.sessions as Array<Record<string, unknown>>).find(session => session.id === sessionId);
          const routes = (after.intentRoutingRecordsBySession as Record<string, Array<Record<string, unknown>>> | undefined)?.[sessionId];
          if (!session || session.dataEpoch !== item.dataEpoch ||
            (Object.hasOwn(after, 'intentRoutingRecordsBySession') && !routes?.some(route => route.id === item.routingId))) throw new Error('INTENT_RECORD_BINDING_MISMATCH');
          if (key === 'intentCorrectionsBySession' && (item.originRoutingId !== undefined || item.originFollowUpId !== undefined)) {
            const origin = routes?.find(route => route.id === item.originRoutingId);
            const follows = (after.followUpMessagesBySession as Record<string, Array<Record<string, unknown>>> | undefined)?.[sessionId];
            const directSemanticMessage = session.intentContractVersion === 'intent-understanding-v1' &&
              origin?.semanticContractVersion === 'intent-understanding-v1' && item.originFollowUpId === undefined;
            if (!item.originRoutingId || (!item.originFollowUpId && !directSemanticMessage) || item.originRoutingId === item.routingId ||
              (Object.hasOwn(after, 'intentRoutingRecordsBySession') && (!origin || origin.sourceEventId !== item.sourceEventId ||
                origin.correctionId !== item.id || origin.correctionTargetRoutingId !== item.routingId)) ||
              (!directSemanticMessage && Object.hasOwn(after, 'followUpMessagesBySession') && !follows?.some(follow => follow.id === item.originFollowUpId &&
                follow.routingId === item.originRoutingId && follow.sourceEventId === item.sourceEventId))) {
              throw new Error('INTENT_RECORD_CHAT_BINDING_MISMATCH');
            }
          }
        }
        if (previous && !isDeepStrictEqual(immutableIntentPayload(key, previous), immutableIntentPayload(key, item))) {
          throw new Error('INTENT_RECORD_IMMUTABLE');
        }
      }
      // Session erasure uses deleteSessionCascade, never an ordinary online mutation.
      if (old.some(record => !ids.has(String(record.id)))) throw new Error('INTENT_RECORD_DELETE_FORBIDDEN');
    }
  }
}

function assertRetryReceipts(previous: Record<string, unknown> | undefined, item: Record<string, unknown>) {
  const past = (previous?.retryReceipts ?? []) as Array<Record<string, unknown>>;
  const current = (item.retryReceipts ?? []) as Array<Record<string, unknown>>;
  const conflict = (): never => { throw new Error('INTENT_RETRY_RECEIPT_CONFLICT'); };
  if (!Array.isArray(current) || current.length < past.length) conflict();
  const identities = new Set<string>();
  for (let index = 0; index < current.length; index++) {
    const row = current[index], old = past[index], binding = row?.binding as Record<string, unknown> | undefined;
    const task = binding?.task as Record<string, unknown> | undefined;
    const failure = binding?.failure as Record<string, unknown> | undefined;
    if (!binding || binding.sessionId !== item.sessionId || binding.dataEpoch !== item.dataEpoch ||
      binding.routingId !== item.routingId || binding.intentRevision !== item.intentRevision || task?.stepId !== item.id ||
      typeof binding.checkpointId !== 'string' || !binding.checkpointId || typeof failure?.invocationId !== 'string' ||
      typeof row.processId !== 'string' || !row.processId || !['running', 'applied', 'reconciliation_required'].includes(String(row.status))) conflict();
    const identity = JSON.stringify([binding!.sessionId, binding!.dataEpoch, binding!.sessionGeneration, binding!.checkpointId, failure!.invocationId]);
    if (identities.has(identity)) conflict(); identities.add(identity);
    if (old) {
      const payload = (value: Record<string, unknown>) => { const { status: _status, failureCode: _failure, execution: _execution, ...rest } = value; return rest; };
      if (!isDeepStrictEqual(payload(old), payload(row)) || (old.status !== row.status && old.status !== 'running') ||
        (old.status !== 'running' && old.failureCode !== row.failureCode)) conflict();
    } else if (row.status !== 'running') conflict();
    const execution = row.execution as Record<string, unknown> | undefined;
    const previousExecution = old?.execution as Record<string, unknown> | undefined;
    if (execution) {
      if (typeof execution.processId !== 'string' || !execution.processId || typeof execution.claimId !== 'string' || !execution.claimId ||
        !['running', 'settled', 'reconciliation_required'].includes(String(execution.status))) conflict();
      if (previousExecution) {
        const payload = (value: Record<string, unknown>) => { const { status: _status, ...rest } = value; return rest; };
        if (!isDeepStrictEqual(payload(previousExecution), payload(execution)) ||
          (previousExecution.status !== execution.status && previousExecution.status !== 'running')) conflict();
      } else if (execution.status !== 'running') conflict();
    } else if (previousExecution) conflict();
  }
}

/** Resume binding stays immutable; only delivery status may advance on an append-only pause receipt. */
function assertResumeReceipts(previous: Record<string, unknown> | undefined, item: Record<string, unknown>) {
  const past = (previous?.resumeReceipts ?? []) as Array<Record<string, unknown>>;
  const current = (item.resumeReceipts ?? []) as Array<Record<string, unknown>>;
  const conflict = () => { throw new Error('INTENT_RESUME_RECEIPT_CONFLICT'); };
  if (!Array.isArray(current) || current.length < past.length) conflict();
  const identities = new Set<string>();
  for (let index = 0; index < current.length; index++) {
    const row = current[index], old = past[index], binding = row?.binding as Record<string, unknown> | undefined;
    if (!binding || binding.sessionId !== item.sessionId || binding.dataEpoch !== item.dataEpoch ||
      binding.routingId !== item.routingId || binding.intentRevision !== item.intentRevision ||
      typeof binding.pausedAt !== 'string' || !binding.pausedAt || !Number.isSafeInteger(row.pauseRevision) || Number(row.pauseRevision) < 1 ||
      typeof row.processId !== 'string' || !row.processId || !['running', 'applied', 'failed', 'reconciliation_required'].includes(String(row.status))) conflict();
    const identity = JSON.stringify([binding!.sessionId, binding!.dataEpoch, binding!.sessionGeneration, binding!.pausedAt]);
    if (identities.has(identity)) conflict(); identities.add(identity);
    if (old) {
      const payload = (receipt: Record<string, unknown>) => { const { status: _status, failureCode: _failure, ...body } = receipt; return body; };
      if (!isDeepStrictEqual(payload(old), payload(row)) || (old.status !== row.status && old.status !== 'running') ||
        (old.status !== 'running' && old.failureCode !== row.failureCode)) conflict();
    } else if (row.status !== 'running') conflict();
  }
}
