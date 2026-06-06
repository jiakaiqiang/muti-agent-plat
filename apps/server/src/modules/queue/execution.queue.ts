import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import {
  bullMqEnabled,
  bullMqPrefix,
  executionQueueName,
  queueAttempts,
  redisConnectionOptions
} from '../../common/redis.js';

export type ExecutionJobData = {
  sessionId: string;
  briefId: string;
};

@Injectable()
export class ExecutionQueue implements OnModuleDestroy {
  private readonly logger = new Logger(ExecutionQueue.name);
  private readonly queue?: Queue<ExecutionJobData>;

  constructor() {
    if (bullMqEnabled()) {
      this.queue = new Queue<ExecutionJobData>(executionQueueName, {
        connection: redisConnectionOptions(),
        prefix: bullMqPrefix()
      });
    }
  }

  async enqueue(data: ExecutionJobData) {
    if (!this.queue) {
      throw new Error('Execution queue is disabled.');
    }

    const job = await this.queue.add('execute', data, {
      jobId: `execute:${data.sessionId}:${data.briefId}`,
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

  async onModuleDestroy() {
    await this.queue?.close().catch(() => undefined);
  }
}
