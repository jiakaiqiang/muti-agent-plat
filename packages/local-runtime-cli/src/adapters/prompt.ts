import {
  buildStructuredOutputInstructions,
  CHINESE_RUNTIME_OUTPUT_INSTRUCTION,
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
    CHINESE_RUNTIME_OUTPUT_INSTRUCTION,
    'Operate only inside the current authorized working directory.',
    'Do not access credentials or paths outside this directory.',
    'Do not perform an operation whose effective permission is not allow.',
    ...(plan.recoveryCandidate ? [
      'The platform has restored the previous execution candidate into this working directory. Read and verify those files before editing. Continue the unfinished step; do not reimplement completed changes or treat prior test claims as verified.',
      `Restored candidate: ${JSON.stringify({ id: plan.recoveryCandidate.id, stage: plan.recoveryCandidate.stage,
        manifestHash: plan.recoveryCandidate.manifestHash, paths: plan.recoveryCandidate.changeSet.changes.map(change => change.operation === 'move' ? change.toPath : change.path) })}`
    ] : []),
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
