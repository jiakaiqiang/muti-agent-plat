import type {
  AgentRuntimeRunHandle,
  ExecutionTermination,
  InvocationPlan
} from '@agent-cluster/shared';
import {
  createExecutionTermination,
  ensureStructuredTermination
} from '../../common/execution-termination.js';

export function withStructuredTermination(
  handle: AgentRuntimeRunHandle,
  input: InvocationPlan,
  signal?: AbortSignal
): AgentRuntimeRunHandle {
  let explicitTermination: ExecutionTermination | undefined;
  return {
    events: handle.events,
    result: handle.result.then((result) =>
      ensureStructuredTermination(result, {
        phase: input.phase,
        signal,
        termination: explicitTermination
      })
    ),
    cancel: async (termination) => {
      explicitTermination ??=
        termination ??
        createExecutionTermination({
          kind: 'user_cancelled',
          source: 'user',
          scope: 'invocation',
          phase: input.phase
        });
      await handle.cancel(explicitTermination);
    }
  };
}
