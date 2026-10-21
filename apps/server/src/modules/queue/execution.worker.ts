import { ConflictException, Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, forwardRef } from '@nestjs/common';
import { Worker, type Job } from 'bullmq';
import {
  bullMqEnabled,
  bullMqPrefix,
  executionQueueName,
  queueConcurrency,
  queueLockDuration,
  queueStalledInterval,
  redisConnectionOptions
} from '../../common/redis.js';
import { OrchestratorService } from '../orchestrator/orchestrator.service.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { TasksService } from '../tasks/tasks.service.js';
import { ExecutionQueue } from './execution.queue.js';
import type { ExecutionJobData } from './execution.queue.js';
import { assertCurrentDataEpoch } from '../persistence/data-epoch-guard.js';
import { PersistenceService } from '../persistence/persistence.service.js';
import { IntentExecutionSupersededError } from '../message-routing/intent-execution-guard.js';
import { bindIntentResume, readIntentResumeState } from '../message-routing/intent-resume-guard.js';
import { bindIntentRetry, readIntentRetryState } from '../message-routing/intent-retry-guard.js';

@Injectable()
export class ExecutionWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ExecutionWorker.name);
  private worker?: Worker<ExecutionJobData>;

  constructor(
    private readonly orchestrator: OrchestratorService,
    @Inject(forwardRef(() => SessionsService))
    private readonly sessions: SessionsService,
    private readonly tasks: TasksService,
    private readonly executionQueue: ExecutionQueue,
    private readonly persistence: PersistenceService
  ) {}

  onModuleInit() {
    if (!bullMqEnabled()) {
      return;
    }

    this.worker = new Worker<ExecutionJobData>(
      executionQueueName,
      (job) => this.processJob(job),
      {
        connection: redisConnectionOptions(),
        prefix: bullMqPrefix(),
        concurrency: queueConcurrency(),
        lockDuration: queueLockDuration(),
        stalledInterval: queueStalledInterval()
      }
    );

    this.worker.on('failed', (job, error) => {
      this.logger.error(`Execution job ${job?.id ?? 'unknown'} failed: ${error.message}`);
    });
    this.worker.on('completed', (job) => {
      this.logger.log(`Execution job ${job.id} completed`);
    });
    this.worker.on('stalled', (jobId) => {
      this.logger.warn(`Execution job ${jobId} stalled and will be retried`);
    });
  }

  private async processJob(job: Pick<Job<ExecutionJobData>, 'id' | 'data'>) {
    const { sessionId, briefId, dataEpoch, sessionGeneration } = job.data;
    assertCurrentDataEpoch(this.persistence.currentDataEpoch(), dataEpoch, `execution job ${job.id}`);
    if (!this.sessions.matchesActiveGeneration(sessionId, sessionGeneration)) {
      this.logger.log(`Skipping execution job ${job.id}; session ${sessionId} generation is stale or closed`);
      return;
    }
    const session = this.sessions.get(sessionId);
    const resumeBinding = session.intentContractVersion === 'intent-understanding-v1' ? job.data.intentResumeBinding : undefined;
    const retryBinding = session.intentContractVersion === 'intent-understanding-v1' ? job.data.intentRetryBinding : undefined;
    if (retryBinding) bindIntentRetry(readIntentRetryState(this.persistence), sessionId, session.ownerId, retryBinding, true);
    if (resumeBinding) bindIntentResume(readIntentResumeState(this.persistence), sessionId, session.ownerId, resumeBinding, true);
    if (['PAUSED', 'INTERRUPTED', 'CANCELLED', 'COMPLETED'].includes(session.status)) {
      this.logger.log(`Skipping execution job ${job.id}; session ${sessionId} is ${session.status}`);
      return;
    }

    const brief = this.orchestrator.getBrief(sessionId, briefId);
    if (!brief) {
      this.sessions.applyOutcome(
        sessionId,
        { kind: 'ask_user', reason: '队列执行失败：未找到任务契约。' },
        sessionGeneration
      );
      return;
    }

    let unfinishedTasks;
    if (retryBinding) {
      unfinishedTasks = this.tasks.list(sessionId).filter(task => task.id === retryBinding.task.taskId);
      if (unfinishedTasks.length !== 1 || !['pending', 'assigned'].includes(unfinishedTasks[0].status)) throw new ConflictException('INTENT_RETRY_TARGET_OBSOLETE');
    } else if (resumeBinding) {
      const ids = new Set(resumeBinding.tasks.map(task => task.taskId));
      unfinishedTasks = this.tasks.list(sessionId).filter(task => ids.has(task.id));
      if (unfinishedTasks.length !== ids.size || unfinishedTasks.some(task => task.workItemId !== resumeBinding.workItemId ||
        task.stale || ['cancelled', 'completed', 'failed'].includes(task.status))) throw new ConflictException('INTENT_RESUME_TARGET_OBSOLETE');
      for (const task of unfinishedTasks) if (task.status === 'running') this.tasks.update(task, { status: 'pending' });
    } else {
      this.tasks.resetStaleRunning(sessionId);
      unfinishedTasks = this.tasks.unfinished(sessionId);
    }
    const controller = this.executionQueue.registerAbortController(sessionId);
    try {
      const outcome = await this.orchestrator.runPipeline(session, brief, unfinishedTasks, controller.signal, retryBinding);
      await this.sessions.applyQueuedExecutionOutcome(sessionId, outcome, sessionGeneration);
    } catch (error) {
      if (!(error instanceof IntentExecutionSupersededError)) throw error;
    } finally {
      this.executionQueue.releaseAbortController(sessionId, controller);
    }
  }

  async onModuleDestroy() {
    await this.worker?.close().catch(() => undefined);
  }
}
