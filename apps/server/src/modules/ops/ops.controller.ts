import { Controller, Get } from '@nestjs/common';
import { DEFAULT_CONTEXT_PIPELINE_VERSION, SUPPORTED_CONTEXT_PIPELINE_VERSIONS } from '@agent-cluster/shared';
import type { OpsHealth } from '@agent-cluster/shared';
import { Queue, type ConnectionOptions } from 'bullmq';
import { ok } from '../../common/api-response.js';
import { bullMqEnabled, bullMqPrefix, redisConnectionOptions } from '../../common/redis.js';
import { contextPipelineV2Enabled, contextPipelineVersionForNewSession } from '../../common/runtime-config.js';

const queueNames = [
  'agent-discussion-queue',
  'agent-task-queue',
  'runtime-invocation-queue',
  'rag-indexing-queue',
  'notification-queue',
  'post-review-queue'
];

@Controller()
export class OpsController {
  @Get('health')
  health() {
    const pipelineVersion = contextPipelineVersionForNewSession();
    const health: OpsHealth = {
      status: 'ok',
      service: 'agent-cluster-server',
      version: '0.1.0',
      buildTime: this.buildTime(),
      commit: this.commit(),
      pipelineVersion,
      defaultContextPipelineVersion: DEFAULT_CONTEXT_PIPELINE_VERSION,
      contextPipelineVersion: pipelineVersion,
      contextPipelineV2Enabled: contextPipelineV2Enabled(),
      supportedContextPipelineVersions: SUPPORTED_CONTEXT_PIPELINE_VERSIONS,
      timestamp: new Date().toISOString()
    };
    return ok(health);
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
    return (
      process.env.AGENT_CLUSTER_COMMIT?.trim() ||
      process.env.GIT_COMMIT?.trim() ||
      process.env.COMMIT_SHA?.trim() ||
      'unknown'
    );
  }

}
