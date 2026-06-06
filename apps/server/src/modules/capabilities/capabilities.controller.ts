import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ok } from '../../common/api-response.js';
import { CapabilityAuditService } from './capability-audit.service.js';
import { CapabilitiesService } from './capabilities.service.js';

@Controller('capabilities')
export class CapabilitiesController {
  constructor(
    private readonly capabilities: CapabilitiesService,
    private readonly audit: CapabilityAuditService
  ) {}

  @Get()
  list() {
    return ok(this.capabilities.list());
  }

  @Get(':capabilityId')
  detail(@Param('capabilityId') capabilityId: string) {
    return ok(this.capabilities.get(capabilityId));
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
