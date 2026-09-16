import {
  buildStructuredOutputInstructions,
  getVersionedRuntimeOutputContract,
  type InvocationPlan,
  type LocalRuntimePermissionPolicy
} from '@agent-cluster/shared';

export type LocalRuntimePromptOptions = {
  /** Provider tool that receives the root object. Omit when the Runtime prints the JSON directly. */
  submissionToolName?: string;
};

export function buildLocalRuntimePrompt(
  providerName: string,
  plan: InvocationPlan,
  permissions: LocalRuntimePermissionPolicy,
  options: LocalRuntimePromptOptions = {}
) {
  const outputContract = getVersionedRuntimeOutputContract(plan.expectedOutput.kind, plan.expectedOutput.schemaVersion);
  return [
    `You are running as an Agent Cluster local ${providerName} Runtime.`,
    'Operate only inside the current authorized working directory.',
    'Do not access credentials or paths outside this directory.',
    'Do not perform an operation whose effective permission is not allow.',
    `Effective local permissions: ${JSON.stringify(permissions)}.`,
    'Return exactly one JSON object matching the required output contract, with no markdown fences.',
    `Required output kind: ${plan.expectedOutput.kind}.`,
    plan.expectedOutput.schemaVersion === '2.0'
      ? 'Submit status, summary, artifactRefs (changed relative paths), blockers and nextActions only. File identities and test verdicts are supplied by the system. Do not invent test evidence.'
      : buildStructuredOutputInstructions(plan.expectedOutput.kind, {
      submissionToolName: options.submissionToolName
    }),
    'Output JSON Schema:',
    JSON.stringify(outputContract.schema),
    'Output JSON example:',
    JSON.stringify(outputContract.example),
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
