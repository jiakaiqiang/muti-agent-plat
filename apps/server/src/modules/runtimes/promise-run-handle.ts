import type { AgentRunResult, AgentRuntimeRunHandle } from '@agent-cluster/shared';

export function promiseHandle(result: Promise<AgentRunResult>): AgentRuntimeRunHandle {
  return {
    events: (async function* () {})(),
    result,
    async cancel() {}
  };
}
