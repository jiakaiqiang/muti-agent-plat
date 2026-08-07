import { Body, Controller, Get, Param, Patch } from '@nestjs/common';
import type { SystemAgentRole } from '@agent-cluster/shared';
import { ok } from '../../common/api-response.js';
import {
  SystemAgentRuntimePolicyService,
  type SystemAgentRuntimePolicyPatch
} from './system-agent-runtime-policy.service.js';

@Controller('system-agent-runtime-policies')
export class SystemAgentRuntimePolicyController {
  constructor(private readonly policies: SystemAgentRuntimePolicyService) {}

  @Get()
  list() {
    return ok(this.policies.list());
  }

  @Get(':role')
  detail(@Param('role') role: SystemAgentRole) {
    return ok(this.policies.get(role));
  }

  @Patch(':role')
  async update(
    @Param('role') role: SystemAgentRole,
    @Body() body: SystemAgentRuntimePolicyPatch
  ) {
    return ok(await this.policies.update(role, body));
  }
}
