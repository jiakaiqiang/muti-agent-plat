import { Injectable } from '@nestjs/common';
import type { AgentRunInput } from '@agent-cluster/shared';
import { MockRuntimeService } from './mock-runtime.service.js';

@Injectable()
export class RuntimeService {
  constructor(private readonly mockRuntime: MockRuntimeService) {}

  run(input: AgentRunInput) {
    return this.mockRuntime.run(input);
  }
}
