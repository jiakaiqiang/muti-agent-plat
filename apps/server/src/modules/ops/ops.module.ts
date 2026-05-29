import { Module } from '@nestjs/common';
import { OpsController } from './ops.controller.js';

@Module({
  controllers: [OpsController]
})
export class OpsModule {}
