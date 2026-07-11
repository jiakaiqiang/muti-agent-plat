import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ok } from '../../common/api-response.js';
import { CapabilityAuditService } from './capability-audit.service.js';
import { CapabilitiesService, type CapabilityUpsertInput } from './capabilities.service.js';

@Controller('capabilities')
export class CapabilitiesController {
  constructor(
    private readonly capabilities: CapabilitiesService,
    private readonly audit: CapabilityAuditService
  ) {}

  @Get()
  list() {
    return ok(this.capabilities.listDefinitions());
  }

  @Post()
  create(@Body() body: CapabilityUpsertInput) {
    return ok(this.capabilities.createDefinition(body));
  }

  @Get(':capabilityId')
  detail(@Param('capabilityId') capabilityId: string) {
    return ok(this.capabilities.getDefinition(capabilityId));
  }

  @Get(':capabilityId/references')
  references(@Param('capabilityId') capabilityId: string) {
    return ok({ agents: this.capabilities.referencingAgents(capabilityId) });
  }

  @Patch(':capabilityId')
  update(@Param('capabilityId') capabilityId: string, @Body() body: Partial<CapabilityUpsertInput>) {
    return ok(this.capabilities.updateDefinition(capabilityId, body ?? {}));
  }

  @Delete(':capabilityId')
  remove(@Param('capabilityId') capabilityId: string) {
    return ok(this.capabilities.removeDefinition(capabilityId));
  }

  @Post(':capabilityId/check')
  check(
    @Param('capabilityId') capabilityId: string,
    @Body() body: { sessionId?: string; agentId?: string; reason?: string }
  ) {
    const input = body ?? {};
    const result = this.capabilities.checkInvocation(capabilityId, input);
    this.audit.recordCheck(input, result);
    return ok(result);
  }

  @Post(':capabilityId/approve')
  approve(
    @Param('capabilityId') capabilityId: string,
    @Body() body: { sessionId?: string; agentId?: string; reason?: string }
  ) {
    const input = body ?? {};
    const result = this.capabilities.approve(capabilityId, input);
    this.audit.recordApproval(input, result);
    return ok(result);
  }
}
