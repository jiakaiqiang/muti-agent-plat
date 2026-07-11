import type { ResolvedExecutionTarget, RuntimeRoutingInput, RuntimeType } from '@agent-cluster/shared';
import { resolveExecutionTarget } from './resolve-execution-target.js';

const COMMAND_HEAVY_RUNTIMES: RuntimeType[] = ['codex', 'claude_code'];

export interface ResolveWithBrowserFallbackArgs {
  input: RuntimeRoutingInput;
  eligibleRuntimes: RuntimeType[];
  projectPolicyRuntime?: RuntimeType;
  smartRouterPick?: RuntimeType;
}

export interface FallbackTarget extends ResolvedExecutionTarget {
  fallbackFrom?: RuntimeType;
  fallbackReason?: string;
}

export function resolveWithBrowserFallback(args: ResolveWithBrowserFallbackArgs): FallbackTarget {
  const target = resolveExecutionTarget(args);
  const workspaceKind = args.input.workspace.providerKind;
  const workspaceCanCommand = args.input.workspace.capabilities.command === true;

  if (
    workspaceKind === 'browser_broker' &&
    !workspaceCanCommand &&
    COMMAND_HEAVY_RUNTIMES.includes(target.runtimeType)
  ) {
    return {
      runtimeType: 'generic_llm',
      source: 'smart_router',
      requiredCapabilities: target.requiredCapabilities,
      writeMode: target.writeMode,
      fallbackFrom: target.runtimeType,
      fallbackReason: 'browser-broker-lacks-command-capability'
    };
  }

  return target;
}
