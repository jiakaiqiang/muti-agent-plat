import type { InvocationPlan } from '@agent-cluster/shared';

export function resolveCliToolAuthority(input: InvocationPlan) {
  const tools = new Set(input.toolCatalog.tools.map((tool) => tool.name));
  const canWrite = input.executionTarget.writeMode !== 'none' && tools.has('write_file');
  // CLI test tools execute shell commands. A read-only analysis invocation must
  // remain command-free even if an overly broad catalog contains run_test.
  const canRunTests = input.executionTarget.writeMode !== 'none' && tools.has('run_test');
  return {
    canWrite,
    canRunTests,
    codexSandbox: canWrite ? ('workspace-write' as const) : ('read-only' as const),
    claudePermissionMode: canWrite ? 'acceptEdits' : 'plan',
    claudeAllowedTools: [
      'Read',
      'Grep',
      'Glob',
      ...(canWrite ? ['Edit', 'MultiEdit', 'Write'] : []),
      ...(canRunTests ? ['Bash(npm test*)', 'Bash(npm run test*)', 'Bash(pnpm test*)', 'Bash(pnpm run test*)'] : [])
    ].join(',')
  };
}
