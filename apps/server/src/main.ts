import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { loadLocalEnv } from './common/env.js';
import { ApiExceptionFilter } from './common/api-exception.filter.js';
import { JsonLogger } from './common/json-logger.js';

loadLocalEnv();

const port = Number(process.env.SERVER_PORT ?? process.env.PORT ?? 3000);
const defaultCorsOrigin = 'http://localhost:5173,http://127.0.0.1:5173';

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

async function bootstrap() {
  const logger = process.env.LOG_FORMAT === 'json' ? new JsonLogger() : new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule, { logger });
  const allowedOrigins = new Set(parseCorsOrigins(process.env.CORS_ORIGIN));

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
}

void bootstrap();
