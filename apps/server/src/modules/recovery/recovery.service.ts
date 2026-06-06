import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import type { SessionStatus } from '@agent-cluster/shared';
import { ExecutionService } from '../execution/execution.service.js';
import { OrchestratorService } from '../orchestrator/orchestrator.service.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { TasksService } from '../tasks/tasks.service.js';

const RESUMABLE_STATUSES: SessionStatus[] = ['EXECUTING', 'POST_REVIEW', 'REWORKING'];

/**
 * On startup, re-drives sessions that were mid-execution when the process
 * stopped. Persisted data is already restored by each service; this restores
 * the *execution* that was attached to a now-dead in-process promise.
 *
 * Disabled when ENABLE_BULLMQ=true (the queue's retry/attempts handles
 * cross-restart recovery instead) or AGENT_CLUSTER_RECOVER_ON_BOOT=false.
 */
@Injectable()
export class RecoveryService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RecoveryService.name);

  constructor(
    private readonly sessions: SessionsService,
    private readonly tasks: TasksService,
    private readonly orchestrator: OrchestratorService,
    private readonly execution: ExecutionService
  ) {}

  onApplicationBootstrap() {
    if ((process.env.AGENT_CLUSTER_RECOVER_ON_BOOT ?? 'true').trim().toLowerCase() === 'false') {
      return;
    }
    if (process.env.ENABLE_BULLMQ === 'true') {
      return;
    }

    for (const session of this.sessions.listRaw()) {
      if (!RESUMABLE_STATUSES.includes(session.status)) {
        continue;
      }

      const briefs = this.orchestrator.listBriefs(session.id);
      const brief = session.currentTaskBriefId
        ? briefs.find((item) => item.id === session.currentTaskBriefId)
        : briefs.at(-1);
      if (!brief) {
        this.sessions.applyOutcome(session.id, { kind: 'ask_user', reason: '恢复失败：未找到任务契约。' });
        continue;
      }

      this.tasks.resetStaleRunning(session.id);
      const tasks = this.tasks.unfinished(session.id);
      this.logger.log(`Recovering session ${session.id} (${session.status}): ${tasks.length} unfinished tasks`);
      this.execution.start(session, brief, tasks, (outcome) => this.sessions.applyOutcome(session.id, outcome));
    }
  }
}
