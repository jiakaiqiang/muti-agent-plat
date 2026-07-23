import { Module } from '@nestjs/common';
import { OpsController } from './ops.controller.js';
import { MaintenanceModule } from '../persistence/maintenance.module.js';

@Module({
  imports: [MaintenanceModule],
  controllers: [OpsController]
})
export class OpsModule {}
