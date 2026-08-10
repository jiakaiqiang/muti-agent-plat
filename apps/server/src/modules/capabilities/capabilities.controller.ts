import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ok } from '../../common/api-response.js';
import { CapabilityAuditService } from './capability-audit.service.js';
import {
  CapabilitiesService,
  type CapabilityApprovalResult,
  type CapabilityUpsertInput
} from './capabilities.service.js';
import { EventsService } from '../events/events.service.js';

@Controller('capabilities')
export class CapabilitiesController {
  constructor(
    private readonly capabilities: CapabilitiesService,
    private readonly audit: CapabilityAuditService,
    private readonly events: EventsService
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
  async approve(
    @Param('capabilityId') capabilityId: string,
    @Body() body: { sessionId?: string; agentId?: string; reason?: string }
  ) {
    const input = body ?? {};
    const result = await this.capabilities.approve(capabilityId, input);
    this.publishApproval(input, result);

    return ok(result);
  }

  @Post('approvals')
  async approveMany(
    @Body() body: { capabilityIds?: string[]; sessionId?: string; agentId?: string; reason?: string }
  ) {
    const { capabilityIds = [], ...input } = body ?? {};
    const results = await this.capabilities.approveMany(capabilityIds, input);
    for (const result of results) this.publishApproval(input, result);
    return ok(results);
  }

  private publishApproval(
    input: { sessionId?: string; agentId?: string; reason?: string },
    result: CapabilityApprovalResult
  ) {
    if (!result.newlyApproved) return;
    this.audit.recordApproval(input, result);
    if (!input.sessionId) return;
    this.events.create({
      sessionId: input.sessionId,
      type: 'capability_approved',
      ...(input.agentId ? { fromAgentId: input.agentId } : {}),
      toAgentIds: [],
      content: `能力 ${result.capability.name} 已授权`,
      metadata: {
        schemaVersion: '0.1',
        renderAs: 'system_notice',
        payload: {
          capabilityId: result.capability.id,
          capabilityKey: result.capability.key,
          approvalKey: result.approvalKey
        }
      }
    });
  }
}
