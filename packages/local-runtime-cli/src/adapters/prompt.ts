import type { InvocationPlan, LocalRuntimePermissionPolicy } from '@agent-cluster/shared';

export function buildLocalRuntimePrompt(
  providerName: string,
  plan: InvocationPlan,
  permissions: LocalRuntimePermissionPolicy
) {
  return [
    `You are running as an Agent Cluster local ${providerName} Runtime.`,
    'Operate only inside the current authorized working directory.',
    'Do not access credentials or paths outside this directory.',
    'Do not perform an operation whose effective permission is not allow.',
    `Effective local permissions: ${JSON.stringify(permissions)}.`,
    'Return exactly one JSON object matching the required output contract, with no markdown fences.',
    `Required output kind: ${plan.expectedOutput.kind}.`,
    '',
    'Runtime input JSON:',
    JSON.stringify({
      phase: plan.phase,
      agent: plan.agent,
      contextEnvelope: plan.contextEnvelope,
      executionTarget: plan.executionTarget,
      toolCatalog: plan.toolCatalog,
      expectedOutput: plan.expectedOutput
    }, null, 2)
  ].join('\n');
}
