import type { RuntimeRoutingInput, RuntimeType, WorkspaceCapabilityKey } from '@agent-cluster/shared';

const ARCHITECTURE_ELIGIBLE_RUNTIMES: RuntimeType[] = [
  'generic_llm',
  'code_reader',
  'codex',
  'claude_code'
];

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

export function resolveArchitectureRuntimes(input: RuntimeRoutingInput): RuntimeType[] {
  const workspaceCaps = input.workspace.capabilities;
  return ARCHITECTURE_ELIGIBLE_RUNTIMES.filter((runtime) => {
    const runtimeCaps = RUNTIME_CAPABILITIES[runtime];
    for (const cap of input.requiredCapabilities) {
      if (!runtimeCaps.includes(cap)) return false;
      if (!workspaceCaps[cap]) return false;
    }
    return true;
  });
}
