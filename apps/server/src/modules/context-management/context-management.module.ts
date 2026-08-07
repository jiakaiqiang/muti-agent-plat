import { Module } from '@nestjs/common';
import { ContextManagementService } from './context-management.service.js';

@Module({
  providers: [ContextManagementService],
  exports: [ContextManagementService]
})
export class ContextManagementModule {}
