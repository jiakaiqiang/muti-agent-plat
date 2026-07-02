import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import type { AgentRunInput, RuntimeModelCreateInput, RuntimeModelUpdateInput } from '@agent-cluster/shared';
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
    return ok(await this.runtime.run(this.createSmokeInput('mock', scenario)));
  }

  @Get('generic-llm/smoke')
  async genericLlmSmoke(@Query('scenario') scenario?: 'happy_path' | 'task_failed') {
    return ok(await this.runtime.run(this.createSmokeInput('generic_llm', scenario)));
  }

  private createSmokeInput(runtimeType: 'mock' | 'generic_llm', scenario?: 'happy_path' | 'task_failed'): AgentRunInput {
    const agent = {
      id: 'runtime-smoke-agent',
      key: 'backend',
      name: 'Backend Agent',
      role: 'Runtime smoke test agent',
      systemPrompt: 'Return deterministic mock output.',
      runtimeType,
      capabilityIds: []
    };
    return {
      runId: crypto.randomUUID(),
      sessionId: 'runtime-smoke-session',
      phase: 'task_execution',
      agent,
      contextPack: {
        systemRules: ['v0.1 runtime smoke test'],
        sessionGoal: 'Verify runtime result contract.',
        taskContext: {
          domain: 'coding',
          intent: 'validation',
          currentStage: 'task_execution',
          taskMap: {
            kind: 'project_map',
            summary: 'Runtime smoke uses a synthetic project map.',
            items: [
              { type: 'boundary', label: 'runtime-smoke-session' },
              { type: 'validation_path', label: 'Runtime contract smoke', reason: 'Expected output kind must match.' }
            ]
          },
          stagePlan: {
            phase: 'task_execution',
            read: [
              {
                action: 'read',
                label: 'Runtime smoke input',
                refs: ['runtime smoke input'],
                reason: 'Synthetic evidence for the runtime contract smoke.'
              }
            ],
            do: [
              {
                action: 'do',
                label: 'Return deterministic runtime output',
                refs: ['runtime-smoke-session'],
                reason: 'Exercise the adapter output normalization path.'
              }
            ],
            validate: [
              {
                action: 'validate',
                label: 'Runtime output contract',
                refs: ['runtime smoke input'],
                reason: 'AgentRunResult output kind matches expectedOutput.'
              }
            ]
          },
          executionMode: 'single_agent',
          validationMode: 'runtime_checks',
          requiresCodeChanges: false,
          requiresExternalEvidence: false,
          validationRules: [{ label: 'Runtime output contract', evidenceRequired: 'AgentRunResult output kind matches expectedOutput.' }],
          agentResponsibilities: [
            { role: 'execution', agentKey: agent.key },
            { role: 'validation', agentKey: agent.key, independentFrom: [agent.key] },
            { role: 'review', agentKey: agent.key, independentFrom: [agent.key] }
          ],
          evidenceSelection: {
            phase: 'task_execution',
            strategy: 'coding_minimal',
            query: 'Verify runtime result contract.',
            maxEvidenceRefs: 8,
            selectedCount: 1,
            omittedCount: 0,
            selectedTypes: ['user_input'],
            omittedTypes: [],
            selectedRefs: [{ type: 'user_input', label: 'runtime smoke input' }],
            omittedRefs: [],
            rules: ['Select only refs needed for task_execution.']
          },
          evidenceRefs: [{ type: 'user_input', label: 'runtime smoke input' }]
        },
        summaryMemory: {
          goal: 'Verify runtime result contract.',
          currentState: 'runtime smoke',
          confirmedFacts: ['Synthetic runtime smoke invocation.'],
          completed: [],
          decisions: [],
          openQuestions: [],
          risks: [],
          nextSteps: ['Return a deterministic smoke-test output.']
        },
        continuationState: {
          phase: 'task_execution',
          sessionStatus: 'EXECUTING',
          activeTaskId: 'runtime-smoke-task',
          activeAgentKey: agent.key,
          pendingTaskIds: [],
          runningTaskIds: ['runtime-smoke-task'],
          completedTaskIds: [],
          blockedTaskIds: [],
          nextAgentKeys: [agent.key],
          handoffRefs: [],
          sourceEventIds: [],
          sourceArtifactIds: [],
          resumeHints: ['Synthetic runtime smoke can resume from the task_execution phase.']
        },
        agentProfile: agent,
        relevantEvents: [],
        relevantMemories: [],
        ragSnippets: [],
        artifacts: [],
        capabilities: [],
        constraints: ['dry-run only'],
        budget: {}
      },
      expectedOutput: { kind: 'task_execution_result', schemaVersion: '0.1' },
      budget: {},
      options: { scenario: scenario ?? 'happy_path' }
    };
  }
}
