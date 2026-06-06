import { Injectable } from '@nestjs/common';
import type { AgentRunInput, AgentRunResult, AgentRuntimeAdapter } from '@agent-cluster/shared';

@Injectable()
export class CodexRuntimeAdapterService implements AgentRuntimeAdapter {
  readonly type = 'codex' as const;

  async run(input: AgentRunInput, _signal?: AbortSignal): Promise<AgentRunResult> {
    throw new Error(`CodexRuntimeAdapter is reserved for v2 controlled execution: ${input.runId}`);
  }
}
