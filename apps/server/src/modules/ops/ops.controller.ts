import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Post,
  ServiceUnavailableException,
  UnauthorizedException
} from '@nestjs/common';
import { DEFAULT_CONTEXT_PIPELINE_VERSION } from '@agent-cluster/shared';
import type { OpsHealth } from '@agent-cluster/shared';
import { timingSafeEqual } from 'node:crypto';
import { Queue, type ConnectionOptions } from 'bullmq';
import { ok } from '../../common/api-response.js';
import { resolveBuildCommit } from '../../common/build-metadata.js';
import { bullMqEnabled, bullMqPrefix, redisConnectionOptions } from '../../common/redis.js';
import { MaintenanceCoordinatorService } from '../persistence/maintenance-coordinator.service.js';
import { PersistenceService } from '../persistence/persistence.service.js';

const queueNames = [
  'agent-discussion-queue',
  'agent-task-queue',
  'runtime-invocation-queue',
  'rag-indexing-queue',
  'notification-queue',
  'post-review-queue'
];
const processStartedAt = new Date(Date.now() - process.uptime() * 1_000).toISOString();

@Controller()
export class OpsController {
  private readonly buildCommit = resolveBuildCommit();

  constructor(
    private readonly persistence: PersistenceService,
    private readonly maintenance: MaintenanceCoordinatorService
  ) {}

  @Get('health')
  health() {
    const health: OpsHealth = {
      status: 'ok',
      service: 'agent-cluster-server',
      version: '0.1.0',
      buildTime: this.buildTime(),
      commit: this.commit(),
      processId: process.pid,
      startedAt: processStartedAt,
      pipelineVersion: DEFAULT_CONTEXT_PIPELINE_VERSION,
      dataSchemaVersion: 3,
      dataEpoch: this.persistence.currentDataEpoch(),
      persistenceBackend: this.persistence.backendName(),
      persistenceLocation: this.persistence.locationSummary(),
      maintenanceMode: this.persistence.isInMaintenanceMode(),
      timestamp: new Date().toISOString()
    };
    return ok(health);
  }

  @Get('ops/maintenance')
  maintenanceStatus() {
    const state = this.maintenance.current() ?? null;
    return ok({ active: this.persistence.isInMaintenanceMode(), state });
  }

  @Post('ops/maintenance/enter')
  async enterMaintenance(
    @Headers('x-maintenance-token') callerToken: string | undefined,
    @Body() body: { reason?: string; requestedBy?: string }
  ) {
    this.assertMaintenanceAuthorized(callerToken);
    const reason = body.reason?.trim();
    const requestedBy = body.requestedBy?.trim();
    if (!reason || !requestedBy) {
      throw new BadRequestException('MAINTENANCE_REQUEST_INVALID: reason and requestedBy are required.');
    }
    return ok(await this.maintenance.enter({ reason, requestedBy }));
  }

  @Get('ops/queues')
  async queues() {
    const bullmqEnabled = bullMqEnabled();
    const prefix = bullMqPrefix();

    if (!bullmqEnabled) {
      return ok({
        backend: 'bullmq',
        enabled: false,
        prefix,
        queues: queueNames.map((name) => ({
          name,
          status: 'disabled',
          waiting: null,
          active: null,
          completed: null,
          failed: null
        }))
      });
    }

    return ok({
      backend: 'bullmq',
      enabled: true,
      prefix,
      queues: await this.readBullMqQueues(prefix)
    });
  }

  private async readBullMqQueues(prefix: string) {
    let connection: ConnectionOptions;
    let queues: Queue[] = [];

    try {
      connection = redisConnectionOptions();
      queues = queueNames.map((name) => new Queue(name, { connection, prefix }));
      return await Promise.all(
        queues.map(async (queue) => {
          const counts = await queue.getJobCounts('waiting', 'active', 'completed', 'failed');
          return {
            name: queue.name,
            status: 'connected',
            waiting: counts.waiting ?? 0,
            active: counts.active ?? 0,
            completed: counts.completed ?? 0,
            failed: counts.failed ?? 0
          };
        })
      );
    } catch (error) {
      return queueNames.map((name) => ({
        name,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
        waiting: null,
        active: null,
        completed: null,
        failed: null
      }));
    } finally {
      await Promise.all(queues.map((queue) => queue.close().catch(() => undefined)));
    }
  }

  private buildTime() {
    return process.env.AGENT_CLUSTER_BUILD_TIME?.trim() || process.env.BUILD_TIME?.trim() || 'unknown';
  }

  private commit() {
    return this.buildCommit;
  }

  private assertMaintenanceAuthorized(callerToken: string | undefined) {
    const configuredToken = process.env.AGENT_CLUSTER_MAINTENANCE_TOKEN;
    if (!configuredToken) {
      throw new ServiceUnavailableException(
        'MAINTENANCE_TOKEN_NOT_CONFIGURED: maintenance entry is disabled.'
      );
    }
    if (!callerToken) {
      throw new UnauthorizedException('MAINTENANCE_UNAUTHORIZED: invalid maintenance token.');
    }
    const expected = Buffer.from(configuredToken, 'utf8');
    const supplied = Buffer.from(callerToken, 'utf8');
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
      throw new UnauthorizedException('MAINTENANCE_UNAUTHORIZED: invalid maintenance token.');
    }
  }

}
