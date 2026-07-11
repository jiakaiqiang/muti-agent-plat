import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit
} from '@nestjs/common';
import type { Autopilot, AutopilotRun } from '@agent-cluster/shared';
import { Queue, Worker, type Job } from 'bullmq';
import {
  bullMqEnabled,
  bullMqPrefix,
  queueLockDuration,
  queueStalledInterval,
  redisConnectionOptions
} from '../../common/redis.js';
import { PersistenceService } from '../persistence/persistence.service.js';
import { SessionsService } from '../sessions/sessions.service.js';

const AUTOPILOT_QUEUE_NAME = 'agent-autopilot-queue';
const activeStatuses = new Set<AutopilotRun['status']>(['queued', 'running']);

type AutopilotJobData = {
  autopilotId: string;
  runId?: string;
  trigger: AutopilotRun['trigger'];
};

export type AutopilotInput = Pick<Autopilot, 'name' | 'prompt'> &
  Partial<Pick<Autopilot, 'id' | 'schedule' | 'enabled' | 'agentIds' | 'tokenBudget'>>;

@Injectable()
export class AutopilotService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AutopilotService.name);
  private readonly autopilots = new Map<string, Autopilot>();
  private readonly runs = new Map<string, AutopilotRun>();
  private queue?: Queue<AutopilotJobData>;
  private worker?: Worker<AutopilotJobData>;

  constructor(
    private readonly persistence: PersistenceService,
    private readonly sessions: SessionsService
  ) {
    for (const autopilot of this.persistence.getCollection<Autopilot[]>('autopilots', [])) {
      this.autopilots.set(autopilot.id, this.normalize(autopilot));
    }
    for (const run of this.persistence.getCollection<AutopilotRun[]>('autopilotRuns', [])) {
      this.runs.set(run.id, run);
    }
  }

  async onModuleInit() {
    if (!this.schedulerEnabled()) return;
    this.queue = new Queue<AutopilotJobData>(AUTOPILOT_QUEUE_NAME, {
      connection: redisConnectionOptions(),
      prefix: bullMqPrefix()
    });
    this.worker = new Worker<AutopilotJobData>(
      AUTOPILOT_QUEUE_NAME,
      (job) => this.processJob(job),
      {
        connection: redisConnectionOptions(),
        prefix: bullMqPrefix(),
        concurrency: 1,
        lockDuration: queueLockDuration(),
        stalledInterval: queueStalledInterval()
      }
    );
    this.worker.on('failed', (job, error) =>
      this.logger.error(`Autopilot job ${job?.id ?? 'unknown'} failed: ${error.message}`)
    );
    this.worker.on('stalled', (jobId) =>
      this.logger.warn(`Autopilot job ${jobId} stalled and will be retried`)
    );
    for (const autopilot of this.list()) await this.syncScheduler(autopilot);
  }

  async onModuleDestroy() {
    await this.worker?.close().catch(() => undefined);
    await this.queue?.close().catch(() => undefined);
  }

  list() {
    return [...this.autopilots.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  get(autopilotId: string) {
    const autopilot = this.autopilots.get(autopilotId);
    if (!autopilot) throw new NotFoundException(`Autopilot not found: ${autopilotId}`);
    return autopilot;
  }

  listRuns(autopilotId?: string) {
    return [...this.runs.values()]
      .filter((run) => !autopilotId || run.autopilotId === autopilotId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async create(input: AutopilotInput) {
    const now = new Date().toISOString();
    const autopilot = this.normalize({
      id: input.id ?? crypto.randomUUID(),
      name: input.name,
      prompt: input.prompt,
      schedule: input.schedule,
      enabled: input.enabled ?? false,
      runtimeType: 'mock',
      riskLevel: 'low',
      agentIds: input.agentIds ?? [],
      tokenBudget: input.tokenBudget,
      createdAt: now,
      updatedAt: now
    });
    this.autopilots.set(autopilot.id, autopilot);
    this.persistAutopilots();
    await this.syncScheduler(autopilot);
    return autopilot;
  }

  async update(autopilotId: string, patch: Partial<AutopilotInput>) {
    const current = this.get(autopilotId);
    const updated = this.normalize({
      ...current,
      ...patch,
      id: current.id,
      runtimeType: 'mock',
      riskLevel: 'low',
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString()
    });
    this.autopilots.set(updated.id, updated);
    this.persistAutopilots();
    await this.syncScheduler(updated);
    return updated;
  }

  async remove(autopilotId: string) {
    const autopilot = this.get(autopilotId);
    await this.removeScheduler(autopilot.id);
    this.autopilots.delete(autopilot.id);
    this.persistAutopilots();
    return { autopilot, removed: true };
  }

  async trigger(autopilotId: string, options: { force?: boolean } = {}) {
    const autopilot = this.get(autopilotId);
    if (!autopilot.enabled && !options.force) {
      throw new BadRequestException('Autopilot is disabled. Enable it or use force for a manual trigger.');
    }
    const existing = this.activeRun(autopilot.id);
    if (existing) return { run: existing, duplicate: true };
    const run = this.createRun(autopilot.id, 'manual');
    if (this.queue) {
      await this.queue.add('run', { autopilotId: autopilot.id, runId: run.id, trigger: 'manual' }, {
        jobId: run.issueguardKey,
        removeOnComplete: true,
        removeOnFail: 100,
        attempts: 1
      });
    } else {
      void this.processRun(run.id);
    }
    return { run, duplicate: false };
  }

  async processRun(runId: string) {
    const run = this.runs.get(runId);
    if (!run) throw new NotFoundException(`Autopilot run not found: ${runId}`);
    const autopilot = this.get(run.autopilotId);
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'skipped') return run;
    run.status = 'running';
    run.startedAt ??= new Date().toISOString();
    this.persistRuns();
    try {
      if (!run.sessionId) {
        const created = await this.sessions.create({
          input: autopilot.prompt,
          agentIds: autopilot.agentIds,
          tokenBudget: autopilot.tokenBudget,
          engineeringRuntimeType: 'mock',
          origin: 'autopilot',
          autopilotRunId: run.id
        });
        run.sessionId = created.session.id;
        this.persistRuns();
      }
      const terminal = await this.waitForTerminalSession(run.sessionId);
      run.status = terminal === 'COMPLETED' ? 'completed' : 'failed';
      run.error = terminal === 'COMPLETED' ? undefined : `Session ended with ${terminal}`;
      run.completedAt = new Date().toISOString();
      this.persistRuns();
      return run;
    } catch (error) {
      run.status = 'failed';
      run.error = error instanceof Error ? error.message : String(error);
      run.completedAt = new Date().toISOString();
      this.persistRuns();
      return run;
    }
  }

  private async processJob(job: Job<AutopilotJobData>) {
    if (job.name === 'schedule') {
      const autopilot = this.get(job.data.autopilotId);
      if (!autopilot.enabled || this.activeRun(autopilot.id)) return;
      return this.processRun(this.createRun(autopilot.id, 'scheduled').id);
    }
    if (!job.data.runId) throw new Error('Autopilot run job is missing runId.');
    return this.processRun(job.data.runId);
  }

  private createRun(autopilotId: string, trigger: AutopilotRun['trigger']) {
    const now = new Date().toISOString();
    const run: AutopilotRun = {
      id: crypto.randomUUID(),
      autopilotId,
      trigger,
      status: 'queued',
      issueguardKey: `autopilot:${autopilotId}:active`,
      createdAt: now
    };
    this.runs.set(run.id, run);
    this.persistRuns();
    return run;
  }

  private activeRun(autopilotId: string) {
    return this.listRuns(autopilotId).find((run) => activeStatuses.has(run.status));
  }

  private async waitForTerminalSession(sessionId: string) {
    const timeoutMs = Number(process.env.AUTOPILOT_RUN_TIMEOUT_MS ?? 60 * 60 * 1000);
    const pollMs = Number(process.env.AUTOPILOT_POLL_MS ?? 1_000);
    const deadline = Date.now() + (Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 60 * 60 * 1000);
    while (Date.now() < deadline) {
      const status = this.sessions.get(sessionId).status;
      if (status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED') return status;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.max(10, pollMs)));
    }
    throw new Error(`Autopilot session timed out: ${sessionId}`);
  }

  private async syncScheduler(autopilot: Autopilot) {
    if (!this.queue) return;
    if (!autopilot.enabled || !autopilot.schedule) {
      await this.removeScheduler(autopilot.id);
      return;
    }
    await this.queue.upsertJobScheduler(
      this.schedulerId(autopilot.id),
      { pattern: autopilot.schedule },
      {
        name: 'schedule',
        data: { autopilotId: autopilot.id, trigger: 'scheduled' },
        opts: { removeOnComplete: true, removeOnFail: 100 }
      }
    );
  }

  private async removeScheduler(autopilotId: string) {
    await this.queue?.removeJobScheduler(this.schedulerId(autopilotId)).catch(() => false);
  }

  private schedulerId(autopilotId: string) {
    return `autopilot-schedule:${autopilotId}`;
  }

  private normalize(input: Autopilot): Autopilot {
    const name = input.name?.trim();
    const prompt = input.prompt?.trim();
    const schedule = input.schedule?.trim() || undefined;
    if (!name || name.length > 100) throw new BadRequestException('Autopilot name must be 1-100 characters.');
    if (!prompt || prompt.length > 20_000) throw new BadRequestException('Autopilot prompt must be 1-20000 characters.');
    if (schedule && schedule.length > 200) throw new BadRequestException('Autopilot schedule is too long.');
    return {
      ...input,
      name,
      prompt,
      schedule,
      enabled: input.enabled === true,
      runtimeType: 'mock',
      riskLevel: 'low',
      agentIds: Array.from(new Set((input.agentIds ?? []).filter(Boolean)))
    };
  }

  private schedulerEnabled() {
    return process.env.AUTOPILOT_ENABLED === 'true' && bullMqEnabled();
  }

  private persistAutopilots() {
    this.persistence.setCollection('autopilots', this.list());
  }

  private persistRuns() {
    this.persistence.setCollection('autopilotRuns', this.listRuns());
  }
}
