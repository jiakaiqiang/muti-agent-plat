import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ok } from '../../common/api-response.js';
import { ConnectionInput, ConnectionsService } from './connections.service.js';

@Controller('connections')
export class ConnectionsController {
  constructor(private readonly connections: ConnectionsService) {}

  @Get()
  list() {
    return ok(this.connections.list());
  }

  @Get(':connectionId')
  detail(@Param('connectionId') connectionId: string) {
    return ok(this.connections.get(connectionId));
  }

  @Post()
  create(@Body() body: ConnectionInput) {
    return ok(this.connections.create(body ?? {}));
  }

  @Patch(':connectionId')
  update(@Param('connectionId') connectionId: string, @Body() body: ConnectionInput) {
    return ok(this.connections.update(connectionId, body ?? {}));
  }

  @Delete(':connectionId')
  remove(@Param('connectionId') connectionId: string) {
    return ok(this.connections.remove(connectionId));
  }

  @Post(':connectionId/discover')
  async discover(@Param('connectionId') connectionId: string) {
    return ok({ models: await this.connections.discover(connectionId) });
  }
}
