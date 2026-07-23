import { Injectable, Logger, Optional, type OnApplicationBootstrap } from '@nestjs/common';
import type { SessionDetail, SessionStatus } from '@agent-cluster/shared';
import { ExecutionService } from '../execution/execution.service.js';
import { OrchestratorService } from '../orchestrator/orchestrator.service.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { TasksService } from '../tasks/tasks.service.js';
import { WorkdirBriefService } from '../runtimes/streaming/workdir-brief.service.js';
import { filterSessionsForDataEpoch } from '../persistence/data-epoch-guard.js';
import { PersistenceService } from '../persistence/persistence.service.js';
import { EventsService } from '../events/events.service.js';
import { WorkflowRuntimeService } from '../workflows/workflow-runtime.service.js';
import { createMetadata } from '@agent-cluster/shared';
import {
  createExecutionTermination,
  safeTerminationMessage,
  terminationErrorCode
} from '../../common/execution-termination.js';
import { BrokerGateway } from '../workspaces/browser-broker/broker-gateway.js';

const RESUMABLE_STATUSES: SessionStatus[] = ['EXECUTING', 'POST_REVIEW', 'REWORKING'];

/**
 * On startup, re-drives sessions whose background work was attached to a
 * now-dead in-process promise: mid-execution sessions (EXECUTING/POST_REVIEW/
 * REWORKING) and mid-discussion sessions (AGENT_DISCUSSING, whose brief
 * generation runs in-memory via SessionsService). Persisted data is already
 * restored by each service.
 *
 * Execution-state recovery is delegated to BullMQ when ENABLE_BULLMQ=true.
 * Brief generation is always recovered because AGENT_DISCUSSING is an
 * in-process promise and has not reached the execution queue yet.
 */
@Injectable()
export class RecoveryService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RecoveryService.name);
  private readonly pendingBrowserRecoveries = new Set<string>();

  constructor(
    private readonly sessions: SessionsService,
    private readonly tasks: TasksService,
    private readonly orchestrator: OrchestratorService,
    private readonly execution: ExecutionService,
    private readonly persistence: PersistenceService,
    @Optional() private readonly workdirBrief?: WorkdirBriefService,
    @Optional() private readonly events?: EventsService,
    @Optional() private readonly workflowRuntime?: WorkflowRuntimeService,
    @Optional() private readonly brokerGateway?: BrokerGateway
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
    const queueEnabled = process.env.ENABLE_BULLMQ === 'true';

    const sessions = filterSessionsForDataEpoch(this.sessions.listRaw(), this.persistence.currentDataEpoch());
    for (const session of sessions) {
      await this.recoverSession(session.id, queueEnabled);
    }
  }

  private async recoverSession(sessionId: string, queueEnabled: boolean) {
    let session: SessionDetail;
    try {
      session = this.sessions.get(sessionId);
    } catch {
      return;
    }

    if (session.status === 'AGENT_DISCUSSING') {
      this.recordInterruptedRuntime(session.id);
      if (this.deferUntilBrowserWorkspaceReady(session, queueEnabled)) return;
      this.logger.log(`Recovering session ${session.id} (AGENT_DISCUSSING): re-driving brief generation`);
      this.sessions.resumeBriefGeneration(session.id);
      return;
    }

    const workflowRuntime = this.workflowRuntime;
    const workflowRun = workflowRuntime?.findBySession(session.id);
    if (workflowRuntime && workflowRun?.runtimeVersion === 'v2' && !['completed', 'failed', 'cancelled'].includes(workflowRun.status)) {
      if (this.deferUntilBrowserWorkspaceReady(session, queueEnabled)) return;
      const briefs = this.orchestrator.listBriefs(session.id);
      const brief = session.currentTaskBriefId
        ? briefs.find((item) => item.id === session.currentTaskBriefId)
        : briefs.at(-1);
      if (!brief) {
        this.sessions.applyOutcome(session.id, { kind: 'ask_user', reason: '工作流恢复失败：未找到任务契约。' });
        return;
      }
      await workflowRuntime.recover(session, brief, session.participatingAgentIds[0] ?? 'coordinator');
      return;
    }

    if (queueEnabled) return;

    if (!RESUMABLE_STATUSES.includes(session.status)) return;

    this.recordInterruptedRuntime(session.id);
    if (this.deferUntilBrowserWorkspaceReady(session, queueEnabled)) return;

    const briefs = this.orchestrator.listBriefs(session.id);
    const brief = session.currentTaskBriefId
      ? briefs.find((item) => item.id === session.currentTaskBriefId)
      : briefs.at(-1);
    if (!brief) {
      this.sessions.applyOutcome(session.id, { kind: 'ask_user', reason: '恢复失败：未找到任务契约。' });
      return;
    }

    this.tasks.resetStaleRunning(session.id);
    const tasks = this.tasks.unfinished(session.id);
    this.logger.log(`Recovering session ${session.id} (${session.status}): ${tasks.length} unfinished tasks`);
    this.execution.start(session, brief, tasks, (outcome) => this.sessions.applyOutcome(session.id, outcome));
  }

  private deferUntilBrowserWorkspaceReady(session: SessionDetail, queueEnabled: boolean) {
    const workspaceId = session.workingDirectory?.kind === 'browser_local'
      ? session.workspaceId || session.workingDirectory.id
      : undefined;
    const gateway = this.brokerGateway;
    if (!workspaceId || !gateway || gateway.getRegistration(workspaceId)) return false;
    if (this.pendingBrowserRecoveries.has(session.id)) return true;

    this.pendingBrowserRecoveries.add(session.id);
    this.logger.log(`Deferring recovery for session ${session.id}: waiting for browser workspace ${workspaceId}`);
    void gateway.waitForRegistration(workspaceId)
      .then(() => {
        this.pendingBrowserRecoveries.delete(session.id);
        this.logger.log(`Browser workspace ${workspaceId} reconnected; recovering session ${session.id}`);
        return this.recoverSession(session.id, queueEnabled);
      })
      .catch((error) => {
        this.pendingBrowserRecoveries.delete(session.id);
        this.logger.error(`Browser workspace recovery failed for session ${session.id}: ${String(error)}`);
      });
    return true;
  }

  private recordInterruptedRuntime(sessionId: string) {
    if (!this.events) return;
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
    if (!started) return;

    const payload = started.metadata.payload as { runtimeInvocationId?: string; runtimeType?: string } | undefined;
    if (!payload?.runtimeInvocationId) return;
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
  }
}
