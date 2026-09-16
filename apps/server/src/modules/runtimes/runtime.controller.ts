import { BadGatewayException, BadRequestException, Body, Controller, Delete, Get, Logger, Optional, Param, Patch, Post, Query } from '@nestjs/common';
import type {
  InvocationPlan,
  RuntimeModelCreateInput,
  RuntimeModelUpdateInput,
  RuntimeType
} from '@agent-cluster/shared';
import { ok } from '../../common/api-response.js';
import { RuntimeModelConfigService } from './runtime-model-config.service.js';
import { RuntimeService } from './runtime.service.js';
import { LocalRuntimeConnectionService } from '../local-runtime/local-runtime-connection.service.js';

@Controller('runtimes')
export class RuntimeController {
  private readonly logger = new Logger(RuntimeController.name);

  constructor(
    private readonly runtime: RuntimeService,
    private readonly modelConfig: RuntimeModelConfigService,
    @Optional() private readonly localRuntime?: LocalRuntimeConnectionService
  ) {}

  @Get('model-config')
  async modelConfiguration() {
    return ok(await this.modelConfig.getConfig());
  }

  @Get('availability')
  async availability() {
    return ok({ items: await this.runtime.listRuntimeAvailability() });
  }

  @Get('operations')
  operations(@Query('sessionId') sessionId?: string) {
    if (!sessionId?.trim()) throw new BadRequestException('sessionId is required.');
    return ok({ items: this.runtime.operations.list(sessionId) });
  }

  @Post('model-config/switch')
  async switchModel(@Body() body?: { model?: string }) {
    return ok(await this.modelConfig.switchModel(body?.model ?? ''));
  }

  @Post('model-config/models')
  async addModel(@Body() body: RuntimeModelCreateInput) {
    const storesCredentialLocally = body.kind === 'remote' && (body.credentialLocation ?? 'server') === 'local';
    const config = await this.modelConfig.addModel(
      body,
      storesCredentialLocally
        ? async (_nextConfig, affectedModelId) => this.storeLocalCredential(affectedModelId, body)
        : undefined
    );
    return ok(config);
  }

  @Patch('model-config/models/:modelId')
  async updateModel(@Param('modelId') modelId: string, @Body() body?: RuntimeModelUpdateInput) {
    const input = body ?? {};
    const config = await this.modelConfig.updateModel(modelId, input, async (nextConfig, affectedModelId) => {
      const selected = nextConfig.availableModels.find((model) => model.id === affectedModelId);
      if (selected?.credentialLocation !== 'local' || !input.apiKey?.trim()) return;
      await this.storeLocalCredential(selected.id, {
        kind: 'remote',
        provider: selected.provider === 'anthropic-compatible' ? selected.provider : 'openai-compatible',
        credentialLocation: 'local',
        deviceId: selected.deviceId,
        model: selected.model,
        baseUrl: selected.baseUrl ?? '',
        apiKey: input.apiKey
      });
    });
    return ok(config);
  }

  @Delete('model-config/models/:modelId')
  async deleteModel(@Param('modelId') modelId: string) {
    const existing = this.modelConfig.getConfigSnapshot().availableModels.find((model) => model.id === modelId);
    if (existing?.credentialLocation === 'local' && existing.deviceId && this.localRuntime) {
      await this.localRuntime.deleteProviderConnection(existing.deviceId, existing.id).catch(() => undefined);
    }
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
        workspaceProviderKind: 'server_local',
        executionLocation: 'server'
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

  private async storeLocalCredential(modelId: string, input: Extract<RuntimeModelCreateInput, { kind: 'remote' }>) {
    if (!this.localRuntime) {
      throw new BadGatewayException('Local Runtime 凭据桥接不可用。请确认 Local Runtime 正在运行后重试。');
    }
    const deviceId = input.deviceId?.trim();
    if (!deviceId) throw new BadRequestException('必须选择一个已连接的 Local Runtime 设备。');
    const provider = input.provider ?? 'openai-compatible';
    try {
      await this.localRuntime.upsertProviderConnection(deviceId, {
        connectionId: modelId,
        provider,
        model: input.model,
        baseUrl: input.baseUrl,
        apiKey: input.apiKey
      });
    } catch (error) {
      this.logger.error(
        `Local Runtime credential storage failed for model ${modelId}.`,
        error instanceof Error ? error.stack : undefined
      );
      throw new BadGatewayException('无法在本机安全保存 API Key。请确认 Local Runtime 正在运行后重试。');
    }
  }
}
