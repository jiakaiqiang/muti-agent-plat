import { Controller, Get } from '@nestjs/common';
import { Queue, type ConnectionOptions } from 'bullmq';
import { ok } from '../../common/api-response.js';

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
    return ok({
      status: 'ok',
      service: 'agent-cluster-server',
      version: '0.1.0',
      timestamp: new Date().toISOString()
    });
  }

  @Get('ops/queues')
  async queues() {
    const bullmqEnabled = process.env.ENABLE_BULLMQ === 'true';
    const prefix = process.env.BULLMQ_PREFIX ?? 'agent-cluster';

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
      connection = this.redisConnectionOptions();
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

  private redisConnectionOptions(): ConnectionOptions {
    const redisUrl = process.env.REDIS_URL;
    const connectTimeout = Number(process.env.REDIS_CONNECT_TIMEOUT_MS ?? 5_000);

    if (!redisUrl) {
      return {
        host: process.env.REDIS_HOST ?? 'localhost',
        port: Number(process.env.REDIS_PORT ?? 6379),
        db: Number(process.env.REDIS_DB ?? 0),
        password: process.env.REDIS_PASSWORD || undefined,
        maxRetriesPerRequest: null,
        connectTimeout
      };
    }

    const parsed = new URL(redisUrl);
    const protocol = parsed.protocol.replace(':', '');
    return {
      host: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : 6379,
      db: Number(parsed.pathname.replace('/', '') || 0),
      username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
      password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
      tls: protocol === 'rediss' ? {} : undefined,
      maxRetriesPerRequest: null,
      connectTimeout
    };
  }
}
