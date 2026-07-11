import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ok } from '../../common/api-response.js';
import { AutopilotService, type AutopilotInput } from './autopilot.service.js';

@Controller('autopilots')
export class AutopilotController {
  constructor(private readonly autopilots: AutopilotService) {}

  @Get()
  list() {
    return ok(this.autopilots.list());
  }

  @Get('runs')
  runs() {
    return ok(this.autopilots.listRuns());
  }

  @Get(':autopilotId')
  detail(@Param('autopilotId') autopilotId: string) {
    return ok(this.autopilots.get(autopilotId));
  }

  @Get(':autopilotId/runs')
  autopilotRuns(@Param('autopilotId') autopilotId: string) {
    return ok(this.autopilots.listRuns(autopilotId));
  }

  @Post()
  create(@Body() body: AutopilotInput) {
    return this.autopilots.create(body).then(ok);
  }

  @Patch(':autopilotId')
  update(@Param('autopilotId') autopilotId: string, @Body() body: Partial<AutopilotInput>) {
    return this.autopilots.update(autopilotId, body).then(ok);
  }

  @Delete(':autopilotId')
  remove(@Param('autopilotId') autopilotId: string) {
    return this.autopilots.remove(autopilotId).then(ok);
  }

  @Post(':autopilotId/trigger')
  trigger(@Param('autopilotId') autopilotId: string, @Body() body: { force?: boolean } = {}) {
    return this.autopilots.trigger(autopilotId, body).then(ok);
  }
}
