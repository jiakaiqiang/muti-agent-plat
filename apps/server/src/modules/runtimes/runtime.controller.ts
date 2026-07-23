import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import type {
  InvocationPlan,
  RuntimeModelCreateInput,
  RuntimeModelUpdateInput,
  RuntimeType
} from '@agent-cluster/shared';
import { ok } from '../../common/api-response.js';
import { RuntimeModelConfigService } from './runtime-model-config.service.js';
import { RuntimeService } from './runtime.service.js';

@Controller('runtimes')
export class RuntimeController {
  constructor(
    private readonly runtime: RuntimeService,
    private readonly modelConfig: RuntimeModelConfigService
  ) {}

  @Get('model-config')
  async modelConfiguration() {
    return ok(await this.modelConfig.getConfig());
  }

  @Get('availability')
  async availability() {
    return ok({ items: await this.runtime.listRuntimeAvailability() });
  }

  @Post('model-config/switch')
  async switchModel(@Body() body?: { model?: string }) {
    return ok(await this.modelConfig.switchModel(body?.model ?? ''));
  }

  @Post('model-config/models')
  async addModel(@Body() body: RuntimeModelCreateInput) {
    return ok(await this.modelConfig.addModel(body));
  }

  @Patch('model-config/models/:modelId')
  async updateModel(@Param('modelId') modelId: string, @Body() body?: RuntimeModelUpdateInput) {
    return ok(await this.modelConfig.updateModel(modelId, body ?? {}));
  }

  @Delete('model-config/models/:modelId')
  async deleteModel(@Param('modelId') modelId: string) {
    return ok(await this.modelConfig.deleteModel(modelId));
  }

  @Get('mock/smoke')
  async mockSmoke(@Query('scenario') scenario?: 'happy_path' | 'task_failed') {
    return ok(await this.runtime.run(this.createSmokePlan('mock', scenario)));
  }

  @Get('generic-llm/smoke')
  async genericLlmSmoke(@Query('scenario') scenario?: 'happy_path' | 'task_failed') {
    return ok(await this.runtime.run(this.createSmokePlan('generic_llm', scenario)));
  }

  private createSmokePlan(
    runtimeType: Extract<RuntimeType, 'mock' | 'generic_llm'>,
    scenario: 'happy_path' | 'task_failed' = 'happy_path'
  ): InvocationPlan {
    const invocationId = crypto.randomUUID();
    const sessionId = 'runtime-smoke-session';
    const agentId = 'runtime-smoke-agent';
    const profileHash = 'runtime-smoke-profile-v2';
    const toolCatalogHash = 'runtime-smoke-tools-v2';
    const createdAt = new Date().toISOString();
    return {
      invocationId,
      sessionId,
      phase: 'task_execution',
      agent: {
        agentId,
        key: 'backend',
        name: 'Backend Agent',
        role: 'Runtime smoke test agent',
        systemPrompt: 'Return deterministic structured output for the smoke invocation.',
        profileHash,
        profileRevision: 1,
        skillBindings: [],
        requestedToolIds: [],
        requestedToolKeys: [],
        capabilityIds: [],
        knowledgeBaseIds: []
      },
      executionTarget: {
        runtimeType,
        source: 'task_override',
        reason: 'Operator requested a Runtime smoke invocation.',
        requiredCapabilities: [],
        requiredToolIds: [],
        writeMode: 'none',
        workspaceProviderKind: 'server_local'
      },
      toolCatalog: {
        tools: [],
        decisions: [],
        catalogHash: toolCatalogHash
      },
      contextEnvelope: {
        version: 'v2',
        createdAt,
        workspaceId: 'runtime-smoke-workspace',
        sessionId,
        L0: {
          systemRules: ['Return the requested structured output without external side effects.'],
          agentId,
          profileHash,
          profileRevision: 1,
          toolCatalogHash,
          workspace: {
            workspaceId: 'runtime-smoke-workspace',
            rootName: 'runtime-smoke',
            providerKind: 'server_local',
            revision: { id: 'runtime-smoke-revision', observedAt: createdAt }
          }
        },
        L1: {
          sessionGoal: `Verify the Runtime result contract (${scenario}).`,
          phase: 'task_execution',
          navigation: { entries: [], truncated: false }
        },
        L2: { source: 'generated', modules: [] },
        L3: { files: [], totalByteLength: 0, truncated: false },
        L4: { calls: [] },
        L5: { bullets: [`Smoke scenario: ${scenario}`], turnCount: 0 },
        L6: { changeSetIds: [], reportIds: [] },
        budget: {
          inputTokens: 2_000,
          navigationTokens: 200,
          projectMapTokens: 100,
          evidenceTokens: 600
        }
      },
      expectedOutput: { kind: 'task_execution_result', schemaVersion: '1.0' },
      budget: { maxInputTokens: 2_000, maxOutputTokens: 1_000, maxTotalTokens: 3_000 }
    };
  }
}
