import type { ResolvedExecutionTarget, RuntimeAgentProfile } from '@agent-cluster/shared';

export function pairAgentWithExecutionTarget(
  agent: RuntimeAgentProfile,
  target: ResolvedExecutionTarget
): RuntimeAgentProfile {
  return {
    ...agent,
    runtimeType: target.runtimeType,
    ...(target.modelId ? { modelId: target.modelId } : { modelId: agent.modelId })
  };
}
