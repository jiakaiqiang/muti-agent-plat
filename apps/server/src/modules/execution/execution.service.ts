import { Injectable, Logger } from '@nestjs/common';
import type { AgentTask, SessionDetail, TaskBrief } from '@agent-cluster/shared';
import { bullMqEnabled } from '../../common/redis.js';
import { ExecutionOutcome, OrchestratorService } from '../orchestrator/orchestrator.service.js';
import { ExecutionQueue } from '../queue/execution.queue.js';

/**
 * Drives the post-confirmation execution pipeline in the background so HTTP
 * requests return immediately. Holds an AbortController per session so the
 * pipeline can be cancelled (see session pause/cancel). Does not depend on
 * SessionsService: the caller passes an onOutcome callback to avoid a circular
 * dependency.
 */
@Injectable()
export class ExecutionService {
  private readonly logger = new Logger(ExecutionService.name);
  private readonly running = new Map<string, { controller: AbortController; done: Promise<void> }>();

  constructor(
    private readonly orchestrator: OrchestratorService,
    private readonly executionQueue: ExecutionQueue
  ) {}

  start(
    session: SessionDetail,
    brief: TaskBrief,
    tasks: AgentTask[],
    onOutcome: (outcome: ExecutionOutcome) => void
  ) {
    if (bullMqEnabled()) {
      void this.executionQueue.enqueue({ sessionId: session.id, briefId: brief.id }).catch((error) => {
        this.logger.error(`Failed to enqueue execution for session ${session.id}: ${String(error)}`);
        onOutcome({ kind: 'failed', reason: error instanceof Error ? error.message : String(error) });
      });
      return;
    }

    const existing = this.running.get(session.id);
    if (existing) {
      if (existing.controller.signal.aborted) {
        void existing.done.finally(() => this.start(session, brief, tasks, onOutcome));
      }
      return;
    }

    const controller = new AbortController();
    const done = this.orchestrator
      .runPipeline(session, brief, tasks, controller.signal)
      .catch((error): ExecutionOutcome => {
        this.logger.error(`Execution pipeline crashed for session ${session.id}: ${String(error)}`);
        return { kind: 'failed', reason: error instanceof Error ? error.message : String(error) };
      })
      .then((outcome) => {
        // Release the slot before onOutcome so the callback can immediately
        // start a follow-up run (e.g. automatic rework) without being blocked
        // by the "already running" guard.
        const current = this.running.get(session.id);
        if (current?.controller === controller) {
          this.running.delete(session.id);
        }
        onOutcome(outcome);
      })
      .catch((error) => {
        this.logger.error(`Execution outcome handling failed for session ${session.id}: ${String(error)}`);
      });
    this.running.set(session.id, { controller, done });
    void done;
  }

  cancel(sessionId: string) {
    this.running.get(sessionId)?.controller.abort();
    if (bullMqEnabled()) {
      this.executionQueue.cancel(sessionId);
    }
  }

  isRunning(sessionId: string) {
    return this.running.has(sessionId);
  }
}
