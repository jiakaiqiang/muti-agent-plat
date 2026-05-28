import { Controller, Get, Param } from '@nestjs/common';
import { ok } from '../../common/api-response.js';
import { TasksService } from './tasks.service.js';

@Controller('sessions/:sessionId/tasks')
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Get()
  list(@Param('sessionId') sessionId: string) {
    return ok(this.tasks.list(sessionId));
  }
}
