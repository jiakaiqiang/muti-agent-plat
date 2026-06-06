import type { ConnectionOptions } from 'bullmq';

export const executionQueueName = 'agent-task-queue';

export function bullMqEnabled() {
  return process.env.ENABLE_BULLMQ === 'true';
}

export function bullMqPrefix() {
  return process.env.BULLMQ_PREFIX ?? 'agent-cluster';
}

export function queueAttempts() {
  const parsed = Number(process.env.QUEUE_ATTEMPTS ?? 3);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 3;
}

export function queueConcurrency() {
  const parsed = Number(process.env.QUEUE_CONCURRENCY ?? 4);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 4;
}

export function redisConnectionOptions(): ConnectionOptions {
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
