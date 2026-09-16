import { RUNTIME_OUTPUT_SCHEMA_VERSION, type RuntimeOutputKind } from './contract-types.js';

export type StructuredOutputInstructionOptions = {
  /**
   * Name of the provider tool that receives the root object, when the Runtime submits the
   * result through a tool call. Omit for Runtimes that print the JSON object directly.
   */
  submissionToolName?: string;
};

function rootTarget(submissionToolName?: string) {
  return submissionToolName ? `the root arguments to ${submissionToolName}` : 'the root object you return';
}

/**
 * Root-object discipline shared by every Runtime prompt path.
 *
 * Both the server-side adapters and the local Runtime CLI must inject this text, otherwise a
 * provider is free to invent a wrapper object or JSON-encode a structured field, which fails
 * strict contract validation after the model has already spent the phase budget.
 */
export function buildStructuredOutputInstructions(
  outputKind: RuntimeOutputKind,
  options: StructuredOutputInstructionOptions = {}
) {
  const target = rootTarget(options.submissionToolName);
  const instructions = [
    'STRUCTURED OUTPUT CONTRACT:',
    `Pass every schema property directly as ${target}.`,
    'Never wrap the result in content, output, result, payload, artifact, or metadata.',
    'Include every required schema property and do not add undeclared root properties.',
    'Every array property must be a JSON array, never a string or a JSON-encoded string.',
    `The root object must include schemaVersion: "${RUNTIME_OUTPUT_SCHEMA_VERSION}" and kind: "${outputKind}".`
  ];

  if (outputKind === 'task_execution_result') {
    instructions.push(
      'For task_execution_result:',
      '  - requestedContext is required; use null when no additional context is needed.',
      '  - agentMessages is required; use [] when there are no Agent messages.',
      '  - nextSuggestedActions is required; use [] when there are no next actions.',
      '  - changedArtifacts must be an array of artifact objects.',
      '  - Do not JSON-encode changedArtifacts or an artifact as a string.',
      '  - Put an architecture or design document in changedArtifacts[].content; it does not replace the task_execution_result root object.'
    );
  }

  if (outputKind === 'task_acceptance_decision') {
    instructions.push(
      'For task_acceptance_decision, judge only whether the assigned Agent can start and execute the currentTask with its role, capabilities, and available minimum context.',
      'This is an intake decision, not a quality review. Do not reject an assignment because an upstream artifact may be incomplete or low quality.',
      'A QA, test, review, or validation Agent that can perform the assigned acceptance work must return status "accepted" and then report quality findings during the execution or approval phase.',
      'Use status "blocked" only when required context is missing before work can begin and supplemental context may recover the task.',
      'Use status "rejected" only when the assigned Agent clearly cannot perform the responsibility because of a capability, role, or policy mismatch.',
      'For ordinary fixable quality defects, a quality gate must return decision "revise" with a non-empty revisionInstruction. Use decision "reject" only when the workflow must terminate because the result is not recoverable or violates a non-negotiable boundary.',
      'Do not reassign the task yourself; return the acceptance decision and any handoff suggestion for the Coordinator to resolve explicitly.'
    );
  }

  if (outputKind === 'task_brief') {
    instructions.push(
      'For task_brief:',
      '  - scope, outOfScope, constraints, acceptanceCriteria, risks, and openQuestions must each be an array of strings.',
      '  - Use [] for an empty list; never submit these fields as a single string.',
      '  - suggestedTasks must be an array of task objects, not a string.'
    );
  }

  return instructions.join('\n');
}
