import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

const port = Number(process.env.SERVER_PORT ?? process.env.PORT ?? 3000);

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { cors: true });
  app.setGlobalPrefix('api');
  await app.listen(port);
  console.log(`Agent Cluster server listening on http://localhost:${port}/api`);
}

void bootstrap();
