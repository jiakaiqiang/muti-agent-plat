import type {
  ExecutionTargetSource,
  ResolvedExecutionTarget,
  RuntimeRoutingInput,
  RuntimeType
} from '@agent-cluster/shared';

const GLOBAL_DEFAULT_RUNTIME: RuntimeType = 'generic_llm';

export interface ResolveExecutionTargetArgs {
  input: RuntimeRoutingInput;
  eligibleRuntimes: RuntimeType[];
  projectPolicyRuntime?: RuntimeType;
  smartRouterPick?: RuntimeType;
}

export function resolveExecutionTarget(args: ResolveExecutionTargetArgs): ResolvedExecutionTarget {
  const { input, eligibleRuntimes } = args;
  const eligible = new Set(eligibleRuntimes);

  const picked = pickRuntime(args, eligible);

  return {
    runtimeType: picked.runtimeType,
    ...(picked.modelId ? { modelId: picked.modelId } : {}),
    source: picked.source,
    requiredCapabilities: input.requiredCapabilities,
    writeMode: input.writeMode
  };
}

interface PickResult {
  runtimeType: RuntimeType;
  modelId?: string;
  source: ExecutionTargetSource;
}

function pickRuntime(args: ResolveExecutionTargetArgs, eligible: Set<RuntimeType>): PickResult {
  const { input } = args;
  if (input.userOverride && eligible.has(input.userOverride.runtimeType)) {
    return {
      runtimeType: input.userOverride.runtimeType,
      modelId: input.userOverride.modelId,
      source: input.userOverride.source === 'user' ? 'task_override' : input.userOverride.source
    };
  }
  if (input.agentPreferredRuntime && eligible.has(input.agentPreferredRuntime)) {
    return { runtimeType: input.agentPreferredRuntime, source: 'session_preference' };
  }
  if (args.projectPolicyRuntime && eligible.has(args.projectPolicyRuntime)) {
    return { runtimeType: args.projectPolicyRuntime, source: 'project_policy' };
  }
  if (args.smartRouterPick && eligible.has(args.smartRouterPick)) {
    return { runtimeType: args.smartRouterPick, source: 'smart_router' };
  }
  const firstEligible = args.eligibleRuntimes[0];
  if (firstEligible) {
    return { runtimeType: firstEligible, source: 'smart_router' };
  }
  return { runtimeType: GLOBAL_DEFAULT_RUNTIME, source: 'global_default' };
}
