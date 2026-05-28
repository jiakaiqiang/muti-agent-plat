import { Injectable } from '@nestjs/common';
import type { AgentRunInput } from '@agent-cluster/shared';
import { GenericLlmRuntimeService } from './generic-llm-runtime.service.js';
import { MockRuntimeService } from './mock-runtime.service.js';

@Injectable()
export class RuntimeService {
  constructor(
    private readonly mockRuntime: MockRuntimeService,
    private readonly genericLlmRuntime: GenericLlmRuntimeService
  ) {}

  run(input: AgentRunInput) {
    if (input.agent.runtimeType === 'generic_llm') {
      return this.genericLlmRuntime.run(input);
    }
    return this.mockRuntime.run(input);
  }
}
