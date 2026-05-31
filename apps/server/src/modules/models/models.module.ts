import { Module } from '@nestjs/common';
import { ConnectionsController } from './connections.controller.js';
import { ConnectionsService } from './connections.service.js';
import { ModelsController } from './models.controller.js';
import { ModelsService } from './models.service.js';
import { SecretsService } from './secrets.service.js';

@Module({
  controllers: [ConnectionsController, ModelsController],
  providers: [SecretsService, ConnectionsService, ModelsService],
  exports: [ModelsService, ConnectionsService]
})
export class ModelsModule {}
