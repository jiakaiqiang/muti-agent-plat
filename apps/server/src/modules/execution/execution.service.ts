import { Injectable, Logger, type BeforeApplicationShutdown } from '@nestjs/common';
import type { AgentTask, ExecutionTermination, SessionDetail, TaskBrief } from '@agent-cluster/shared';
import { bullMqEnabled } from '../../common/redis.js';
import {
  abortWithTermination,
  createExecutionTermination
} from '../../common/execution-termination.js';
import { ExecutionOutcome, OrchestratorService } from '../orchestrator/orchestrator.service.js';
import { ExecutionQueue } from '../queue/execution.queue.js';
import { extractRuntimeError } from '../../common/runtime-error.js';

/**
 * Drives the post-confirmation execution pipeline in the background so HTTP
 * requests return immediately. Holds an AbortController per session so the
 * pipeline can be cancelled (see session pause/cancel). Does not depend on
 * SessionsService: the caller passes an onOutcome callback to avoid a circular
 * dependency.
 */
@Injectable()
export class ExecutionService implements BeforeApplicationShutdown {
  private readonly logger = new Logger(ExecutionService.name);
  private readonly running = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private shuttingDown = false;

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
    if (this.shuttingDown) {
      onOutcome({
        kind: 'cancelled',
        reason: 'Service is shutting down; execution requires a future user wake-up.',
        termination: createExecutionTermination({
          kind: 'service_shutdown',
          source: 'system',
          scope: 'service',
          graceful: true
        })
      });
      return;
    }
    if (bullMqEnabled()) {
      void this.executionQueue.enqueue({ sessionId: session.id, briefId: brief.id, dataEpoch: session.dataEpoch }).catch((error) => {
        this.logger.error(`Failed to enqueue execution for session ${session.id}: ${String(error)}`);
        onOutcome({
          kind: 'failed',
          reason: error instanceof Error ? error.message : String(error),
          error: extractRuntimeError(error)
        });
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
        return {
          kind: 'failed',
          reason: error instanceof Error ? error.message : String(error),
          error: extractRuntimeError(error)
        };
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

  cancel(
    sessionId: string,
    termination: ExecutionTermination = createExecutionTermination({
      kind: 'user_cancelled',
      source: 'user',
      scope: 'session'
    })
  ) {
    const running = this.running.get(sessionId);
    if (running) abortWithTermination(running.controller, termination);
    if (bullMqEnabled()) {
      this.executionQueue.cancel(sessionId, termination);
    }
  }

  async cancelAndWait(
    sessionId: string,
    termination: ExecutionTermination = createExecutionTermination({
      kind: 'user_cancelled',
      source: 'user',
      scope: 'session'
    }),
    timeoutMs = 10_000
  ) {
    const running = this.running.get(sessionId);
    this.cancel(sessionId, termination);

    if (bullMqEnabled()) {
      const completed = await this.executionQueue.cancelAndWait(sessionId, termination, timeoutMs);
      return { requested: completed.requested, completed: completed.completed, timedOut: completed.timedOut };
    }

    if (!running) {
      return { requested: false, completed: true, timedOut: false };
    }

    let completed = false;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      running.done.finally(() => {
        completed = true;
      }),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.max(0, timeoutMs));
      })
    ]);
    if (timer) clearTimeout(timer);
    return { requested: true, completed, timedOut: !completed };
  }

  isRunning(sessionId: string) {
    return this.running.has(sessionId);
  }

  cancelAll(
    termination: ExecutionTermination = createExecutionTermination({
      kind: 'service_shutdown',
      source: 'system',
      scope: 'service',
      graceful: true
    })
  ) {
    for (const sessionId of this.running.keys()) {
      this.cancel(sessionId, termination);
    }
  }

  async cancelAllAndWait(
    termination: ExecutionTermination = createExecutionTermination({
      kind: 'service_shutdown',
      source: 'system',
      scope: 'service',
      graceful: true
    }),
    timeoutMs = 10_000
  ) {
    const pending = new Set(this.running.keys());
    const completions = [...this.running.entries()].map(([sessionId, execution]) => {
      abortWithTermination(execution.controller, termination);
      return execution.done.finally(() => pending.delete(sessionId));
    });
    if (bullMqEnabled()) {
      this.executionQueue.cancelAll(termination);
    }
    if (completions.length) {
      await Promise.race([
        Promise.allSettled(completions),
        new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
      ]);
    }
    return {
      requestedCount: completions.length,
      completedCount: completions.length - pending.size,
      timedOutSessionIds: [...pending]
    };
  }

  async beforeApplicationShutdown(signal?: string) {
    this.shuttingDown = true;
    const termination = createExecutionTermination({
      kind: 'service_shutdown',
      source: 'system',
      scope: 'service',
      graceful: true,
      ...(signal ? { diagnosticRef: signal } : {})
    });
    const timeoutMs = Number(process.env.SHUTDOWN_EXECUTION_GRACE_MS ?? 10_000);
    const result = await this.cancelAllAndWait(
      termination,
      Number.isFinite(timeoutMs) && timeoutMs >= 0 ? timeoutMs : 10_000
    );
    if (result.timedOutSessionIds.length) {
      this.logger.warn(`Shutdown grace period expired for sessions: ${result.timedOutSessionIds.join(', ')}`);
    }
  }
}
