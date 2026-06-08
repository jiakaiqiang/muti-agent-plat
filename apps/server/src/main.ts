import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { loadLocalEnv } from './common/env.js';
import { ApiExceptionFilter } from './common/api-exception.filter.js';
import { JsonLogger } from './common/json-logger.js';
import { bullMqEnabled, bullMqPrefix } from './common/redis.js';

loadLocalEnv();

const port = Number(process.env.SERVER_PORT ?? process.env.PORT ?? 3000);
const defaultCorsOrigin =
  'http://localhost:5173,http://127.0.0.1:5173,http://localhost:5174,http://127.0.0.1:5174,http://localhost:8099,http://127.0.0.1:8099';

function parseCorsOrigins(value: string | undefined) {
  return (value ?? defaultCorsOrigin)
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function applySecurityHeaders(
  _: unknown,
  response: { setHeader(name: string, value: string): void },
  next: () => void
) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  next();
}

function runtimeMode() {
  const runtimeType = process.env.DEFAULT_AGENT_RUNTIME_TYPE ?? process.env.AGENT_RUNTIME_TYPE ?? 'generic_llm';
  const mockFallback = process.env.LLM_MOCK_FALLBACK ?? process.env.LLM_DRY_RUN ?? 'false';
  return `${runtimeType}${['1', 'true', 'yes', 'on', 'mock'].includes(mockFallback.toLowerCase()) ? ' (mock fallback enabled)' : ''}`;
}

async function bootstrap() {
  const logger = process.env.LOG_FORMAT === 'json' ? new JsonLogger() : new Logger('Bootstrap');
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false, logger });
  app.enableShutdownHooks();
  const requestBodyLimit = process.env.HTTP_JSON_BODY_LIMIT ?? '2mb';
  const allowedOrigins = new Set(parseCorsOrigins(process.env.CORS_ORIGIN));

  app.useBodyParser('json', { limit: requestBodyLimit });
  app.useBodyParser('urlencoded', { extended: true, limit: requestBodyLimit });

  app.enableCors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.has(origin)) {
        callback(null, true);
        return;
      }

      callback(null, false);
    },
    credentials: true
  });
  app.use(applySecurityHeaders);
  app.setGlobalPrefix('api');
  app.useGlobalFilters(new ApiExceptionFilter());
  await app.listen(port);
  logger.log(`Agent Cluster server listening on http://localhost:${port}/api`);
  logger.log(
    [
      `Runtime mode: ${runtimeMode()}`,
      `Persistence: ${process.env.AGENT_CLUSTER_PERSISTENCE_BACKEND ?? 'file'}`,
      `Data: ${
        process.env.AGENT_CLUSTER_PERSISTENCE_BACKEND === 'postgres'
          ? process.env.DATABASE_URL ?? 'DATABASE_URL not set'
          : process.env.AGENT_CLUSTER_DATA_FILE ?? process.env.AGENT_CLUSTER_DATA_DIR ?? '.cache/agent-cluster/state.v0.1.json'
      }`,
      `BullMQ: ${bullMqEnabled() ? `enabled (${bullMqPrefix()})` : 'disabled'}`,
      `Recovery on boot: ${(process.env.AGENT_CLUSTER_RECOVER_ON_BOOT ?? 'true').toLowerCase()}`
    ].join(' | ')
  );
}

void bootstrap();
