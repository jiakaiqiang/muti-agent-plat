import { Controller, Get, Query } from '@nestjs/common';
import type { AgentRunInput, RuntimeType } from '@agent-cluster/shared';
import { ok } from '../../common/api-response.js';
import { RuntimeService } from './runtime.service.js';

type SmokeRuntimeType = Extract<RuntimeType, 'mock' | 'generic_llm' | 'codex' | 'claude_code'>;

@Controller('runtimes')
export class RuntimeController {
  constructor(private readonly runtime: RuntimeService) {}

  @Get('mock/smoke')
  async mockSmoke(@Query('scenario') scenario?: 'happy_path' | 'task_failed') {
    return ok(await this.runtime.run(this.createSmokeInput('mock', scenario)));
  }

  @Get('generic-llm/smoke')
  async genericLlmSmoke(@Query('scenario') scenario?: 'happy_path' | 'task_failed') {
    return ok(await this.runtime.run(this.createSmokeInput('generic_llm', scenario)));
  }

  @Get('codex/smoke')
  async codexSmoke() {
    return ok(await this.runtime.run(this.createSmokeInput('codex')));
  }

  @Get('claude-code/smoke')
  async claudeCodeSmoke() {
    return ok(await this.runtime.run(this.createSmokeInput('claude_code')));
  }

  private createSmokeInput(runtimeType: SmokeRuntimeType, scenario?: 'happy_path' | 'task_failed'): AgentRunInput {
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
