import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, forwardRef } from '@nestjs/common';
import { Worker } from 'bullmq';
import {
  bullMqEnabled,
  bullMqPrefix,
  executionQueueName,
  queueConcurrency,
  redisConnectionOptions
} from '../../common/redis.js';
import { OrchestratorService } from '../orchestrator/orchestrator.service.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { TasksService } from '../tasks/tasks.service.js';
import { ExecutionQueue } from './execution.queue.js';
import type { ExecutionJobData } from './execution.queue.js';

@Injectable()
export class ExecutionWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ExecutionWorker.name);
  private worker?: Worker<ExecutionJobData>;

  constructor(
    private readonly orchestrator: OrchestratorService,
    @Inject(forwardRef(() => SessionsService))
    private readonly sessions: SessionsService,
    private readonly tasks: TasksService,
    private readonly executionQueue: ExecutionQueue
  ) {}

  onModuleInit() {
    if (!bullMqEnabled()) {
      return;
    }

    this.worker = new Worker<ExecutionJobData>(
      executionQueueName,
      async (job) => {
        const { sessionId, briefId } = job.data;
        const session = this.sessions.get(sessionId);
        if (['CANCELLED', 'COMPLETED'].includes(session.status)) {
          this.logger.log(`Skipping execution job ${job.id}; session ${sessionId} is ${session.status}`);
          return;
        }

        const brief = this.orchestrator.getBrief(sessionId, briefId);
        if (!brief) {
          this.sessions.applyOutcome(sessionId, { kind: 'ask_user', reason: '队列执行失败：未找到任务契约。' });
          return;
        }

        this.tasks.resetStaleRunning(sessionId);
        const unfinishedTasks = this.tasks.unfinished(sessionId);
        const controller = this.executionQueue.registerAbortController(sessionId);
        try {
          const outcome = await this.orchestrator.runPipeline(session, brief, unfinishedTasks, controller.signal);
          this.sessions.applyOutcome(sessionId, outcome);
        } finally {
          this.executionQueue.releaseAbortController(sessionId, controller);
        }
      },
      {
        connection: redisConnectionOptions(),
        prefix: bullMqPrefix(),
        concurrency: queueConcurrency()
      }
    );

    this.worker.on('failed', (job, error) => {
      this.logger.error(`Execution job ${job?.id ?? 'unknown'} failed: ${error.message}`);
    });
    this.worker.on('completed', (job) => {
      this.logger.log(`Execution job ${job.id} completed`);
    });
  }

  async onModuleDestroy() {
    await this.worker?.close().catch(() => undefined);
  }
}
