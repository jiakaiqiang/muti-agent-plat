import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type { ExecutionTermination } from '@agent-cluster/shared';
import { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import {
  bullMqEnabled,
  bullMqPrefix,
  executionQueueName,
  queueAttempts,
  redisConnectionOptions
} from '../../common/redis.js';
import { assertCurrentDataEpoch } from '../persistence/data-epoch-guard.js';
import { PersistenceService } from '../persistence/persistence.service.js';
import { abortWithTermination, createExecutionTermination } from '../../common/execution-termination.js';

export type ExecutionJobData = {
  sessionId: string;
  briefId: string;
  dataEpoch: string;
  sessionGeneration?: number;
};

@Injectable()
export class ExecutionQueue implements OnModuleDestroy {
  private readonly logger = new Logger(ExecutionQueue.name);
  private readonly queue?: Queue<ExecutionJobData>;
  /** Job-level abort controllers so cancel works while the worker runs in-process. */
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly idleWaiters = new Map<string, Set<() => void>>();

  constructor(private readonly persistence: PersistenceService) {
    if (bullMqEnabled()) {
      this.queue = new Queue<ExecutionJobData>(executionQueueName, {
        connection: redisConnectionOptions(),
        prefix: bullMqPrefix()
      });
    }
  }

  registerAbortController(sessionId: string) {
    const controller = new AbortController();
    this.abortControllers.set(sessionId, controller);
    return controller;
  }

  releaseAbortController(sessionId: string, controller: AbortController) {
    if (this.abortControllers.get(sessionId) === controller) {
      this.abortControllers.delete(sessionId);
      const waiters = this.idleWaiters.get(sessionId);
      this.idleWaiters.delete(sessionId);
      for (const resolve of waiters ?? []) resolve();
    }
  }

  cancel(sessionId: string, termination: ExecutionTermination) {
    const controller = this.abortControllers.get(sessionId);
    if (controller) abortWithTermination(controller, termination);
  }

  async cancelAndWait(sessionId: string, termination: ExecutionTermination, timeoutMs = 10_000) {
    const controller = this.abortControllers.get(sessionId);
    if (!controller) return { requested: false, completed: true, timedOut: false };

    let completed = false;
    let timer: NodeJS.Timeout | undefined;
    let idleResolve: (() => void) | undefined;
    const idle = new Promise<void>((resolve) => {
      idleResolve = resolve;
      const waiters = this.idleWaiters.get(sessionId) ?? new Set<() => void>();
      waiters.add(resolve);
      this.idleWaiters.set(sessionId, waiters);
    }).then(() => {
      completed = true;
    });
    this.cancel(sessionId, termination);
    await Promise.race([
      idle,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.max(0, timeoutMs));
      })
    ]);
    if (timer) clearTimeout(timer);
    if (!completed && idleResolve) {
      const waiters = this.idleWaiters.get(sessionId);
      waiters?.delete(idleResolve);
      if (waiters?.size === 0) this.idleWaiters.delete(sessionId);
    }
    return { requested: true, completed, timedOut: !completed };
  }

  async enqueue(data: ExecutionJobData) {
    this.persistence.assertWritable();
    assertCurrentDataEpoch(this.persistence.currentDataEpoch(), data.dataEpoch, `execution job ${data.sessionId}`);
    if (!this.queue) {
      throw new Error('Execution queue is disabled.');
    }

    const executionAttemptId = randomUUID();
    const job = await this.queue.add('execute', data, {
      // A session can be resumed after every user-approved workflow step.
      // BullMQ keeps completed job IDs, so every execution attempt needs a fresh ID.
      jobId: `execute-${data.sessionId}-${data.briefId}-${executionAttemptId}`,
      attempts: queueAttempts(),
      backoff: {
        type: 'exponential',
        delay: 1_000
      },
      removeOnComplete: 100,
      removeOnFail: 100
    });
    this.logger.log(`Enqueued execution job ${job.id} for session ${data.sessionId}`);
    return job;
  }

  cancelAll(termination: ExecutionTermination) {
    for (const controller of this.abortControllers.values()) {
      abortWithTermination(controller, termination);
    }
  }

  async pauseForMaintenance(
    termination: ExecutionTermination = createExecutionTermination({
      kind: 'maintenance',
      source: 'operator',
      scope: 'service'
    })
  ) {
    this.cancelAll(termination);
    await this.queue?.pause();
  }

  async onModuleDestroy() {
    await this.queue?.close().catch(() => undefined);
  }
}
