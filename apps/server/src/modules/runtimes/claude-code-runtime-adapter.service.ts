import { Injectable } from '@nestjs/common';
import type { AgentRunInput, AgentRunResult, AgentRuntimeAdapter } from '@agent-cluster/shared';

@Injectable()
export class ClaudeCodeRuntimeAdapterService implements AgentRuntimeAdapter {
  readonly type = 'claude_code' as const;

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    throw new Error(`ClaudeCodeRuntimeAdapter is reserved for v2 controlled execution: ${input.runId}`);
  }
}
