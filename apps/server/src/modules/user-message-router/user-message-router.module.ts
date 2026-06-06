import { Module } from '@nestjs/common';
import { UserMessageRouterService } from './user-message-router.service.js';

@Module({
  providers: [UserMessageRouterService],
  exports: [UserMessageRouterService]
})
export class UserMessageRouterModule {}
