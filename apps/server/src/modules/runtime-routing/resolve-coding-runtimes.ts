import type { RuntimeRoutingInput, RuntimeType, WorkspaceCapabilityKey } from '@agent-cluster/shared';

const CODING_ELIGIBLE_RUNTIMES: RuntimeType[] = ['codex', 'claude_code'];

const RUNTIME_CAPABILITIES: Record<RuntimeType, readonly WorkspaceCapabilityKey[]> = {
  mock: ['read'],
  generic_llm: ['read'],
  code_reader: ['read'],
  test_runner: ['read', 'test'],
  codex: ['read', 'write', 'command'],
  claude_code: ['read', 'write', 'command'],
  mcp_tool: ['read'],
  human: ['read', 'write', 'command']
};

const DEFAULT_CODING_CAPABILITIES: readonly WorkspaceCapabilityKey[] = ['read', 'write', 'command'];

export function resolveCodingRuntimes(input: RuntimeRoutingInput): RuntimeType[] {
  const workspaceCaps = input.workspace.capabilities;
  const required = input.requiredCapabilities.length > 0
    ? input.requiredCapabilities
    : DEFAULT_CODING_CAPABILITIES;

  return CODING_ELIGIBLE_RUNTIMES.filter((runtime) => {
    const runtimeCaps = RUNTIME_CAPABILITIES[runtime];
    for (const cap of required) {
      if (!runtimeCaps.includes(cap)) return false;
      if (!workspaceCaps[cap]) return false;
    }
    return true;
  });
}
