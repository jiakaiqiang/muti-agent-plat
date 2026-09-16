import { Injectable, Logger, Optional, type OnApplicationBootstrap } from '@nestjs/common';
import { createMetadata, type SessionDetail, type SessionStatus } from '@agent-cluster/shared';
import {
  createExecutionTermination,
  safeTerminationMessage,
  terminationErrorCode
} from '../../common/execution-termination.js';
import { EventsService } from '../events/events.service.js';
import { filterSessionsForDataEpoch } from '../persistence/data-epoch-guard.js';
import { PersistenceService } from '../persistence/persistence.service.js';
import { WorkdirBriefService } from '../runtimes/streaming/workdir-brief.service.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { ContextManagementService } from '../context-management/context-management.service.js';
import { LegacyWorkItemMigrationService } from './legacy-workitem-migration.service.js';

const INTERRUPT_ON_BOOT_STATUSES = new Set<SessionStatus>([
  'AGENT_DISCUSSING',
  'REVISING_BRIEF',
  'EXECUTING',
  'POST_REVIEW',
  'REWORKING'
]);

/**
 * Converts work owned by the previous backend process into a wakeable
 * interruption. Runtime invocations are never re-driven automatically because
 * doing so could repeat commands or file writes.
 */
@Injectable()
export class RecoveryService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RecoveryService.name);

  constructor(
    private readonly sessions: SessionsService,
    private readonly persistence: PersistenceService,
    @Optional() private readonly workdirBrief?: WorkdirBriefService,
    @Optional() private readonly events?: EventsService,
    @Optional() private readonly contextManagement?: ContextManagementService,
    @Optional() private readonly legacyMigration?: LegacyWorkItemMigrationService
  ) {}

  async onApplicationBootstrap() {
    if ((process.env.AGENT_CLUSTER_RECOVER_ON_BOOT ?? 'true').trim().toLowerCase() === 'false') {
      return;
    }
    const briefRecovery = this.workdirBrief?.recoverAll();
    if (briefRecovery?.restored || briefRecovery?.failed) {
      this.logger.log(
        `Workdir brief recovery: restored=${briefRecovery.restored}, failed=${briefRecovery.failed}, expiredRemoved=${briefRecovery.expiredRemoved}`
      );
    }

    const revisionRecoveries = await this.sessions.recoverFileRevisions();
    if (revisionRecoveries.length > 0) {
      this.logger.log(`File revision recovery reconciled ${revisionRecoveries.length} iteration(s).`);
    }

    const sessions = filterSessionsForDataEpoch(this.sessions.listRaw(), this.persistence.currentDataEpoch());
    if ((process.env.AGENT_CLUSTER_WORKITEM_BOOTSTRAP ?? 'true').trim().toLowerCase() !== 'false' && this.legacyMigration) {
      const migrationMode = workItemMigrationMode();
      if (migrationMode === 'apply' && this.contextManagement) {
        for (const session of sessions) {
          if (!this.contextManagement.activeWorkItem(session)) {
            await this.contextManagement.ensureInitialWorkItem(
              session,
              `legacy-bootstrap:${session.id}`,
              session.originalInput,
              workItemStatusForSession(session.status)
            );
          }
        }
        const report = await this.legacyMigration.apply(sessions);
        this.logger.log(`Applied legacy WorkItem ownership migration: sessions=${report.sessionCount}, migrated=${report.migratedRecordCount}, issues=${report.issues.length}.`);
      } else {
        const report = this.legacyMigration.report(sessions, migrationMode);
        this.logger.log(`Legacy WorkItem ownership ${migrationMode}: sessions=${report.sessionCount}, planned=${report.plannedRecordCount}, issues=${report.issues.length}, revision=${report.revision}.`);
      }
    }
    for (const session of sessions) {
      this.interruptSessionFromPreviousProcess(session);
      await this.sessions.reconcileRecoveryStateOnBoot?.(session.id);
    }

    const routingRecoveries = await this.sessions.recoverIntentRoutings?.(sessions.map((session) => session.id)) ?? [];
    if (routingRecoveries.length > 0) {
      this.logger.log(`Intent routing recovery reconciled ${routingRecoveries.length} record(s).`);
    }

    await this.reconcileWorkspaceLeases(sessions);
  }

  private async reconcileWorkspaceLeases(sessions: SessionDetail[]) {
    const terminalStatuses: SessionStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED'];
    const activeSessionsByWorkspace = new Map<string, string>();

    for (const session of sessions) {
      if (!terminalStatuses.includes(session.status)) {
        const existing = activeSessionsByWorkspace.get(session.workspaceId);
        if (existing) {
          this.logger.warn(
            `Workspace ${session.workspaceId} has multiple active sessions: ${existing}, ${session.id}. Releasing lease for older session.`
          );
          await this.persistence.releaseWorkspaceSessionLease(session.workspaceId, existing);
        }
        activeSessionsByWorkspace.set(session.workspaceId, session.id);
      }
    }

    await this.persistence.reconcileWorkspaceSessionLeases(
      [...activeSessionsByWorkspace].map(([workspaceId, sessionId]) => ({ workspaceId, sessionId }))
    );
  }

  private interruptSessionFromPreviousProcess(session: SessionDetail) {
    if (!INTERRUPT_ON_BOOT_STATUSES.has(session.status)) return;

    const previousStatus = session.status;
    const invocationId = this.recordInterruptedRuntime(session.id);
    const interrupted = this.sessions.interruptForServiceShutdown({
      sessionId: session.id,
      invocationId,
      occurredAt: new Date().toISOString(),
      graceful: false,
      diagnosticRef: 'recovered_on_boot'
    });
    if (interrupted) {
      this.logger.log(`Marked session ${session.id} (${previousStatus}) as wakeable after service shutdown`);
    }
  }

  private recordInterruptedRuntime(sessionId: string) {
    if (!this.events) return undefined;
    const events = this.events.list(sessionId);
    const terminalIds = new Set(
      events
        .filter((event) => event.type === 'runtime_completed' || event.type === 'runtime_failed')
        .map((event) => (event.metadata.payload as { runtimeInvocationId?: string } | undefined)?.runtimeInvocationId)
        .filter((value): value is string => Boolean(value))
    );
    const started = [...events]
      .reverse()
      .find((event) => {
        if (event.type !== 'runtime_started') return false;
        const invocationId = (event.metadata.payload as { runtimeInvocationId?: string } | undefined)?.runtimeInvocationId;
        return Boolean(invocationId && !terminalIds.has(invocationId));
      });
    if (!started) return undefined;

    const payload = started.metadata.payload as { runtimeInvocationId?: string; runtimeType?: string } | undefined;
    if (!payload?.runtimeInvocationId) return undefined;
    const termination = createExecutionTermination({
      kind: 'service_shutdown',
      source: 'system',
      scope: 'service',
      graceful: false
    });
    const message = safeTerminationMessage(termination);
    this.events.create({
      sessionId,
      workItemId: started.workItemId,
      type: 'runtime_failed',
      fromAgentId: started.fromAgentId,
      taskId: started.taskId,
      content: message,
      metadata: createMetadata('system_notice', {
        runtimeInvocationId: payload.runtimeInvocationId,
        runtimeType: payload.runtimeType,
        status: 'cancelled',
        code: terminationErrorCode(termination),
        message,
        error: {
          code: terminationErrorCode(termination),
          message,
          retryable: true,
          termination
        },
        termination
      })
    });
    return payload.runtimeInvocationId;
  }
}

function workItemStatusForSession(status: SessionStatus): 'OPEN' | 'WAITING_USER' | 'EXECUTING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' {
  if (status === 'COMPLETED') return 'COMPLETED';
  if (status === 'FAILED') return 'FAILED';
  if (status === 'CANCELLED') return 'CANCELLED';
  // INTERRUPTED 归 WAITING_USER 而非 FAILED：它等的是用户决定是否续接，与
  // sessions.service.ts 的 workItemStatusForSessionStatus 对齐，避免两侧对同一
  // 会话给出互斥的 WorkItem 状态。
  if (status === 'WAIT_USER_CONFIRM' || status === 'WAIT_WORKFLOW_SELECT' || status === 'WAIT_WORKFLOW_STEP_CONFIRM' ||
      status === 'WAIT_WORKSPACE_CONFLICT_RESOLUTION' || status === 'WAIT_USER_DECISION' || status === 'PAUSED' ||
      status === 'INTERRUPTED') return 'WAITING_USER';
  if (status === 'EXECUTING' || status === 'AGENT_DISCUSSING' || status === 'REVISING_BRIEF' || status === 'POST_REVIEW' || status === 'REWORKING') return 'EXECUTING';
  return 'OPEN';
}

function workItemMigrationMode(): 'report' | 'apply' {
  return (process.env.AGENT_CLUSTER_WORKITEM_MIGRATION_MODE ?? 'report').trim().toLowerCase() === 'apply'
    ? 'apply'
    : 'report';
}
