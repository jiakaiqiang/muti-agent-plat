import { Module, forwardRef } from '@nestjs/common';
import { AgentProfileModule } from '../agent-profile/agent-profile.module.js';
import { AgentsService } from './agents.service.js';
import { AgentsController } from './agents.controller.js';
import { AgentCatalogService } from './agent-catalog.service.js';
import { SystemAgentRegistryService } from './system-agent-registry.service.js';
import { SystemAgentRuntimePolicyService } from './system-agent-runtime-policy.service.js';
import { SystemAgentRuntimePolicyController } from './system-agent-runtime-policy.controller.js';

@Module({
  imports: [forwardRef(() => AgentProfileModule)],
  controllers: [AgentsController, SystemAgentRuntimePolicyController],
  providers: [SystemAgentRegistryService, SystemAgentRuntimePolicyService, AgentsService, AgentCatalogService],
  exports: [SystemAgentRegistryService, SystemAgentRuntimePolicyService, AgentsService, AgentCatalogService]
})
export class AgentsModule {}
