import { BadRequestException, ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { DecideIntentReconciliationInput, IntentReconciliationAttemptRef, IntentReconciliationCase, IntentReconciliationView,
  IntentResumeBinding, IntentRetryBinding, SessionDetail, WorkflowNodeRun, WorkflowRun } from '@agent-cluster/shared';
import { PersistenceService, type PersistedState } from '../persistence/persistence.service.js';
import { EventsService } from '../events/events.service.js';
import { appendCorrectionEvent } from './intent-correction-state.js';
import { bindIntentResume, INTENT_RESUME_COLLECTIONS } from './intent-resume-guard.js';
import { bindIntentRetry } from './intent-retry-guard.js';
import { CLI_RISK_VERSION, RECONCILIATIONS, reconciliationHash, reconciliationProcessId, reconciliationRows, reconciliationTasks } from './intent-reconciliation-state.js';
import { reconciliationEvidence, reconciliationSources } from './intent-reconciliation-evidence.js';

export const RECONCILIATION_COLLECTIONS = [...new Set([...INTENT_RESUME_COLLECTIONS, RECONCILIATIONS,
  'runtimeInvocationsBySession', 'workspaceWritebacks', 'artifacts', 'intentCorrectionsBySession', 'eventOutbox'])];
const fail = (code: string): never => { throw new ConflictException(code); };
function parseDecision(raw: unknown): DecideIntentReconciliationInput {
  const value = raw as DecideIntentReconciliationInput;
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).some(key => !['expectedCaseRevision', 'expectedSessionRevision', 'idempotencyKey', 'action', 'acceptWorkspaceResponsibility', 'riskVersion'].includes(key)) ||
    !Number.isSafeInteger(value.expectedCaseRevision) || value.expectedCaseRevision < 1 ||
    !Number.isSafeInteger(value.expectedSessionRevision) || value.expectedSessionRevision < 1 ||
    typeof value.idempotencyKey !== 'string' || !value.idempotencyKey.trim() || value.idempotencyKey.length > 200 ||
    !['redispatch', 'confirm_completed', 'abandon'].includes(value.action) ||
    (value.acceptWorkspaceResponsibility !== undefined && value.acceptWorkspaceResponsibility !== true) ||
    (value.riskVersion !== undefined && typeof value.riskVersion !== 'string') ||
    (value.action !== 'redispatch' && (value.riskVersion !== undefined || value.acceptWorkspaceResponsibility !== undefined))) {
    throw new BadRequestException('INVALID_INTENT_RECONCILIATION_DECISION');
  }
  return structuredClone(value);
}

@Injectable()
export class IntentReconciliationService {
  private port?: (sessionId: string, ref: IntentReconciliationAttemptRef) => Promise<unknown>;
  private hooks?: { committed: (sessionId: string) => void; stop?: (sessionId: string, invocationIds: string[]) => Promise<{ stopConfirmed: boolean }> };
  constructor(private readonly persistence: PersistenceService, @Optional() private readonly events?: EventsService) {}
  bind(port: NonNullable<IntentReconciliationService['port']>, hooks?: IntentReconciliationService['hooks']) { this.port = port; this.hooks = hooks; }

  private session(state: PersistedState, sessionId: string, actorId: string) {
    const rows = (state.sessions as SessionDetail[] | undefined)?.filter(row => row.id === sessionId) ?? [];
    const session = rows[0];
    const lifecycle = (state.sessionLifecyclesBySession as any)?.[sessionId];
    if (rows.length !== 1 || !session || session.ownerId !== actorId || session.archivedAt ||
      session.intentContractVersion !== 'intent-understanding-v1' || !session.dataEpoch || lifecycle?.state !== 'active' ||
      lifecycle.dataEpoch !== session.dataEpoch) fail('INTENT_RECONCILIATION_SESSION_UNAVAILABLE');
    return { session, generation: lifecycle.generation as number };
  }

  async list(sessionId: string, actorId: string): Promise<IntentReconciliationView[]> {
    const result = await this.persistence.mutateCollections(RECONCILIATION_COLLECTIONS, draft => {
      const { session, generation } = this.session(draft, sessionId, actorId);
      const map = (draft[RECONCILIATIONS] ??= {}) as Record<string, IntentReconciliationCase[]>;
      const rows = map[sessionId] ??= [];
      const events: import('@agent-cluster/shared').CollaborationEvent[] = [];
      for (const source of reconciliationSources(draft, session)) {
        const { evidenceHash } = reconciliationEvidence(draft, session, source);
        const id = `intent-reconciliation:${reconciliationHash([sessionId, session.dataEpoch, generation, source.sourceId])}`;
        let row = rows.find(item => item.id === id);
        const now = new Date().toISOString();
        if (!row) {
          row = { ...source, id, sessionId, dataEpoch: session.dataEpoch!, sessionGeneration: generation, revision: 1,
            evidenceHash, status: 'open', decisions: [], attempts: [], createdAt: now, updatedAt: now };
          rows.push(row);
          const event = this.event(row, 'user_confirmation_requested', '执行结果需要人工核对，请查看服务端证据并作结构化决定。');
          appendCorrectionEvent(draft, event); events.push(event);
        }
      }
      // The source recovery card may already have been consumed before a process died.
      for (const row of rows.filter(item => item.dataEpoch === session.dataEpoch && item.sessionGeneration === generation)) {
        const attempt = row.attempts.at(-1), now = new Date().toISOString();
        if (row.status === 'dispatching' && attempt?.processId !== reconciliationProcessId) {
          if (attempt) attempt.status = 'reconciliation_required'; row.status = 'open'; row.revision++; row.updatedAt = now;
          const event = this.event(row, 'user_confirmation_requested', '上次派发的执行结果未知，请重新核对证据。');
          appendCorrectionEvent(draft, event); events.push(event);
        }
        const { evidenceHash } = reconciliationEvidence(draft, session, row);
        if (row.status === 'open' && row.evidenceHash !== evidenceHash) { row.evidenceHash = evidenceHash; row.revision++; row.updatedAt = now; }
      }
      return { views: rows.filter(row => row.dataEpoch === session.dataEpoch && row.sessionGeneration === generation)
        .map(row => this.view(draft, session, row)), events };
    }, { sessionIds: [sessionId] });
    for (const event of result.events) this.events?.acceptCommitted(event);
    return result.views;
  }

  private view(state: PersistedState, session: SessionDetail, row: IntentReconciliationCase): IntentReconciliationView {
    const readOnly = !row.binding || !['resume', 'retry', 'runtime_safety'].includes(row.source);
    return { record: structuredClone(row), sessionRevision: session.revision ?? 1, readOnly,
      evidence: reconciliationEvidence(state, session, row).evidence,
      actions: readOnly ? [] : (['redispatch', 'confirm_completed', 'abandon'] as const).map(action => {
        try {
          if (row.status !== 'open') fail('INTENT_RECONCILIATION_NOT_OPEN');
          this.assertTargets(state, session, row);
          if (action !== 'abandon') this.assertStopped(state, session, row);
          if (action === 'redispatch') {
            // Preview all guards on a disposable draft; no proof or attempt is persisted by GET.
            const preview = structuredClone(state), candidate = reconciliationRows(preview, session.id).find(item => item.id === row.id)!;
            const ref = { caseId: row.id, attemptId: 'guard-preview' };
            const runtime = 'task' in row.binding! ? (row.binding as IntentRetryBinding).failure.runtimeType : undefined;
            candidate.status = 'dispatching'; candidate.attempts.push({ id: ref.attemptId, processId: reconciliationProcessId,
              status: 'claimed', invocationIds: [], createdAt: row.updatedAt,
              ...((runtime === 'codex' || runtime === 'claude_code') ? { cliConfirmation: { actorId: session.ownerId,
                confirmedAt: row.updatedAt, evidenceHash: row.evidenceHash, riskVersion: CLI_RISK_VERSION, runtimeType: runtime } } : {}) });
            const binding = { ...candidate.binding!, reconciliationAttempt: ref };
            if ('task' in binding) bindIntentRetry(preview, session.id, session.ownerId, binding, true);
            else bindIntentResume(preview, session.id, session.ownerId, binding, true);
          }
          return { action, enabled: true };
        } catch (error) { return { action, enabled: false, reason: error instanceof Error ? error.message : String(error) }; }
      }), ...(readOnly ? { handler: row.source === 'correction' ? 'intent-corrections' : row.source === 'isolated_test' ? 'isolated-test recovery' : 'intent plan-step handler' } : {}) };
  }

  private assertTargets(state: PersistedState, session: SessionDetail, row: IntentReconciliationCase) {
    const binding = row.binding;
    if (!binding || binding.sessionId !== session.id || binding.dataEpoch !== session.dataEpoch ||
      binding.sessionGeneration !== row.sessionGeneration || binding.workItemId !== session.activeWorkItemId ||
      binding.briefId !== session.currentTaskBriefId) fail('INTENT_RECONCILIATION_TARGET_OBSOLETE');
    const works = (state.workItemsBySession as any)?.[session.id]?.filter((item: any) => item.id === binding!.workItemId) ?? [];
    const briefs = (state.briefsBySession as any)?.[session.id] ?? [];
    const brief = briefs.filter((item: any) => item.id === binding!.briefId);
    if (works.length !== 1 || ['CANCELLED', 'COMPLETED'].includes(works[0].status) || brief.length !== 1 ||
      brief[0].version !== binding!.briefVersion || brief[0].intentConfirmationReceipt?.id !== binding!.confirmationReceiptId ||
      briefs.some((item: any) => item.supersedesBriefId === binding!.briefId)) fail('INTENT_RECONCILIATION_TARGET_OBSOLETE');
    for (const target of reconciliationTasks(binding!)) {
      const tasks = ((state.tasksBySession as any)?.[session.id] ?? []).filter((item: any) => item.id === target.taskId);
      const operations = ((state.logicalOperationsBySession as any)?.[session.id] ?? []).filter((item: any) => item.id === target.operationId);
      const routes = ((state.intentRoutingRecordsBySession as any)?.[session.id] ?? []).filter((item: any) => item.id === target.executionBinding.routingId);
      if (tasks.length !== 1 || operations.length !== 1 || routes.length !== 1 || tasks[0].stale ||
        ['completed', 'cancelled'].includes(tasks[0].status) || tasks[0].workItemId !== binding!.workItemId ||
        tasks[0].executionOperationId !== target.operationId || operations[0].taskId !== target.taskId ||
        !isDeepStrictEqual(operations[0].executionBinding, target.executionBinding) ||
        routes[0].effectiveIntentRevision !== target.executionBinding.intentRevision ||
        (works[0].requirementRevision ?? 1) !== target.executionBinding.requirementRevision ||
        (works[0].executionEpoch ?? 1) !== target.executionBinding.executionEpoch) fail('INTENT_RECONCILIATION_TARGET_OBSOLETE');
    }
    if (binding!.workflow) {
      const saved = binding!.workflow;
      const runtime = state.workflowRuntime as { runs?: WorkflowRun[]; nodeRunsByRunId?: Record<string, WorkflowNodeRun[]> };
      const runs = runtime?.runs?.filter(item => item.id === saved.id) ?? [];
      const nodes = runtime?.nodeRunsByRunId?.[saved.id]?.filter(item => item.id === saved.nodeRunId) ?? [];
      const retry = 'task' in binding! ? binding as IntentRetryBinding : undefined;
      if (runs.length !== 1 || nodes.length !== 1 || session.workflowRunId !== saved.id || runs[0].sessionId !== session.id ||
        ['completed', 'cancelled'].includes(runs[0].status) || ['completed', 'cancelled'].includes(nodes[0].status) ||
        reconciliationHash(runs[0].definitionSnapshot) !== saved.definitionHash ||
        !reconciliationTasks(binding!).some(target => target.taskId === nodes[0].relatedTaskId) ||
        (retry && (nodes[0].attempt !== retry.workflow!.attempt ||
          ![retry.workflow!.revision, retry.workflow!.revision! + 1].includes(runs[0].revision)))) fail('INTENT_RECONCILIATION_TARGET_OBSOLETE');
    }
  }

  private assertStopped(state: PersistedState, session: SessionDetail, row: IntentReconciliationCase) {
    const proof = reconciliationEvidence(state, session, row), targets = row.binding && reconciliationTasks(row.binding);
    if (!targets?.length || proof.tasks.length !== targets.length || proof.operations.length !== targets.length ||
      proof.tasks.some(task => task.stale || ['completed', 'cancelled'].includes(task.status)) ||
      proof.operations.some(operation => operation.activeInvocationId || !['none', 'confirmed'].includes(operation.stopState) ||
        operation.isolatedTestAttempts?.some(attempt => !attempt.stopConfirmed || attempt.cleanupRequired))) fail('INTENT_RECONCILIATION_STOP_UNCONFIRMED');
    const lifecycle = (state.sessionLifecyclesBySession as any)?.[session.id];
    const stop = (state.sessionStopRequestsBySession as any)?.[session.id]?.at(-1);
    if (!['idle', 'confirmed'].includes(lifecycle?.stopStatus) || (stop && (stop.status !== 'confirmed' || stop.targets.some((target: any) => target.state !== 'confirmed')))) fail('INTENT_RECONCILIATION_STOP_UNCONFIRMED');
    return proof;
  }

  async decide(sessionId: string, caseId: string, actorId: string, raw: unknown) {
    const input = parseDecision(raw), payloadHash = reconciliationHash(input);
    const accepted = await this.persistence.mutateCollections(RECONCILIATION_COLLECTIONS, draft => {
      const { session, generation } = this.session(draft, sessionId, actorId);
      const row = reconciliationRows(draft, sessionId).find(item => item.id === caseId);
      if (!row) throw new NotFoundException('INTENT_RECONCILIATION_NOT_FOUND');
      if (row.dataEpoch !== session.dataEpoch || row.sessionGeneration !== generation) fail('INTENT_RECONCILIATION_VERSION_STALE');
      const existing = row.decisions.find(item => item.actorId === actorId && item.idempotencyKey === input.idempotencyKey);
      if (existing) {
        if (existing.payloadHash !== payloadHash) fail('INTENT_RECONCILIATION_IDEMPOTENCY_CONFLICT');
        return { row: structuredClone(row), replay: true as const };
      }
      if (row.source === 'source_writeback') fail('INTENT_RECONCILIATION_READ_ONLY');
      if (!row.binding || !['resume', 'retry', 'runtime_safety'].includes(row.source)) fail('INTENT_RECONCILIATION_READ_ONLY');
      const originalBinding = row.binding!;
      if (row.status !== 'open' || row.revision !== input.expectedCaseRevision || (session.revision ?? 1) !== input.expectedSessionRevision ||
        row.evidenceHash !== reconciliationEvidence(draft, session, row).evidenceHash) fail('INTENT_RECONCILIATION_VERSION_STALE');
      if (['CANCELLED', 'COMPLETED'].includes(session.status)) fail('INTENT_RECONCILIATION_TARGET_OBSOLETE');
      this.assertTargets(draft, session, row);
      const targets = reconciliationTasks(originalBinding);
      const tasks = ((draft.tasksBySession as any)?.[sessionId] ?? []).filter((task: any) => targets.some(target => target.taskId === task.id));
      if (tasks.length !== targets.length || tasks.some((task: any) => task.stale || ['cancelled', 'completed'].includes(task.status))) fail('INTENT_RECONCILIATION_TARGET_OBSOLETE');
      const now = new Date().toISOString();
      const extraEvents: import('@agent-cluster/shared').CollaborationEvent[] = [];
      let ref: IntentReconciliationAttemptRef | undefined;
      if (input.action === 'redispatch') {
        if (!this.port) fail('INTENT_RECONCILIATION_DISPATCH_UNAVAILABLE');
        this.assertStopped(draft, session, row);
        ref = { caseId, attemptId: randomUUID() };
        const retry = 'task' in originalBinding ? originalBinding : undefined;
        const runtimeType = retry?.failure.runtimeType;
        const cli = runtimeType === 'codex' || runtimeType === 'claude_code';
        if (cli && (input.acceptWorkspaceResponsibility !== true || input.riskVersion !== CLI_RISK_VERSION)) fail('INTENT_RECONCILIATION_CLI_CONFIRMATION_REQUIRED');
        if (!cli && (input.acceptWorkspaceResponsibility !== undefined || input.riskVersion !== undefined)) fail('INTENT_RECONCILIATION_CLI_CONFIRMATION_INVALID');
        row.attempts.push({ id: ref.attemptId, status: 'claimed', processId: reconciliationProcessId, invocationIds: [], createdAt: now,
          ...(cli ? { cliConfirmation: { actorId, confirmedAt: now, evidenceHash: row.evidenceHash, riskVersion: CLI_RISK_VERSION, runtimeType: runtimeType! } } : {}) });
        row.status = 'dispatching';
        // The persisted attempt replaces only unknown delivery ownership, never execution authority or budgets.
        const binding = { ...originalBinding, reconciliationAttempt: ref };
        if ('task' in binding) bindIntentRetry(draft, sessionId, actorId, binding, true);
        else bindIntentResume(draft, sessionId, actorId, binding, true);
      } else {
        if (input.action === 'confirm_completed') {
          const proof = this.assertStopped(draft, session, row);
          if (proof.writebacks.some(writeback => !['applied', 'abandoned'].includes(writeback.status))) fail('INTENT_RECONCILIATION_WRITEBACK_UNRESOLVED');
        }
        for (const task of tasks) Object.assign(task, { status: input.action === 'abandon' ? 'cancelled' : 'completed',
          resultSummary: input.action === 'abandon' ? '用户人工对账：放弃该任务。' : '用户人工对账：确认已经执行，未核验执行结果。', updatedAt: now });
        const workflow = originalBinding.workflow;
        if (workflow) {
          const runtime = draft.workflowRuntime as { runs?: WorkflowRun[]; nodeRunsByRunId?: Record<string, WorkflowNodeRun[]> };
          const node = runtime?.nodeRunsByRunId?.[workflow.id]?.find(item => item.id === workflow.nodeRunId);
          if (!node || !targets.some(target => target.taskId === node.relatedTaskId)) fail('INTENT_RECONCILIATION_TARGET_OBSOLETE');
          Object.assign(node!, { status: input.action === 'abandon' ? 'cancelled' : 'completed', updatedAt: now });
          const run = runtime.runs!.find(item => item.id === workflow.id)!;
          run.status = 'waiting_human'; run.revision++; run.updatedAt = now;
        }
        const recoveryId = session.activeRecoveryCheckpoint?.confirmationId;
        if (recoveryId) {
          const resolved = { ...this.event(row, 'user_confirmation_resolved', '原恢复卡已由人工对账决定替代。'),
            id: `intent-reconciliation:${caseId}:${row.revision}:recovery`,
            metadata: { schemaVersion: '0.1' as const, renderAs: 'system_notice' as const, payload: { confirmationId: recoveryId, status: 'reconciled', caseId } } };
          appendCorrectionEvent(draft, resolved);
          extraEvents.push(resolved);
        }
        delete session.activeRecoveryCheckpoint;
        session.status = 'WAIT_USER_DECISION'; session.revision = (session.revision ?? 1) + 1; session.updatedAt = now;
        row.status = 'resolved';
      }
      row.revision++; row.updatedAt = now;
      row.decisions.push({ actorId, idempotencyKey: input.idempotencyKey, payloadHash, action: input.action,
        decidedAt: now, evidenceHash: row.evidenceHash, expectedCaseRevision: input.expectedCaseRevision,
        resultRevision: row.revision, ...(ref ? { attemptId: ref.attemptId } : {}) });
      const event = this.event(row, 'user_confirmation_resolved', input.action === 'redispatch' ? '人工对账已确认，正在重新核验后派发一次。' :
        input.action === 'abandon' ? '已放弃卡片所列任务，会话保留。' : '已按人工确认记录任务完成，等待用户决定下一步。');
      appendCorrectionEvent(draft, event);
      const notification = input.action !== 'redispatch' ? { ...event, id: `${event.id}:result`, type: 'session_status_changed' as const,
        metadata: { ...event.metadata, payload: { ...event.metadata.payload, status: 'WAIT_USER_DECISION', outcome: 'intent_reconciliation_completed', humanConfirmed: input.action === 'confirm_completed' } } } : undefined;
      if (notification) appendCorrectionEvent(draft, notification);
      const stopIds = input.action === 'abandon' ? reconciliationEvidence(draft, session, row).operations
        .map(operation => operation.activeInvocationId).filter((id): id is string => Boolean(id)) : [];
      return { row: structuredClone(row), ref, event, notification, stopIds, extraEvents, replay: false as const };
    }, { sessionIds: [sessionId] });
    if (!accepted.replay) {
      this.hooks?.committed(sessionId);
      this.events?.acceptCommitted(accepted.event!);
      for (const event of accepted.extraEvents ?? []) this.events?.acceptCommitted(event);
      if (accepted.notification) this.events?.acceptCommitted(accepted.notification);
      if (accepted.stopIds?.length) await this.hooks?.stop?.(sessionId, accepted.stopIds);
      if (accepted.ref) {
        try { await this.port!(sessionId, accepted.ref); }
        catch (error) {
          const event = await this.persistence.mutateCollections([RECONCILIATIONS, 'eventsBySession', 'eventOutbox'], draft => {
            const row = reconciliationRows(draft, sessionId).find(item => item.id === caseId)!;
            const attempt = row.attempts.find(item => item.id === accepted.ref!.attemptId);
            if (row.status === 'dispatching' && attempt && ['claimed', 'running'].includes(attempt.status)) {
              attempt.status = 'reconciliation_required'; row.status = 'open'; row.revision++; row.updatedAt = new Date().toISOString();
              const event = this.event(row, 'user_confirmation_requested', '派发结果未知，请重新核对证据。');
              appendCorrectionEvent(draft, event); return event;
            }
          }, { sessionIds: [sessionId] });
          if (event) this.events?.acceptCommitted(event);
          throw error;
        }
      }
    }
    return { record: accepted.row, idempotentReplay: accepted.replay };
  }

  private event(row: IntentReconciliationCase, type: 'user_confirmation_requested' | 'user_confirmation_resolved', content: string): import('@agent-cluster/shared').CollaborationEvent {
    return { id: `intent-reconciliation:${row.id}:${row.revision}:${type}`, sessionId: row.sessionId, type,
      actor: { type: 'system', id: 'intent-reconciliation' }, toAgentIds: [], createdAt: new Date().toISOString(), content,
      metadata: { schemaVersion: '0.1', renderAs: 'system_notice', payload: { reason: 'intent_reconciliation_required', confirmationId: row.id,
        caseId: row.id, caseRevision: row.revision, status: type === 'user_confirmation_resolved' ? 'approved' : 'pending' } } };
  }
}
