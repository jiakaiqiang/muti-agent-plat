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
    @Optional() private readonly events?: EventsService
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
    for (const session of sessions) {
      this.interruptSessionFromPreviousProcess(session);
    }
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
