import { Type, type Static } from '@sinclair/typebox';
import Ajv, { type ValidateFunction } from 'ajv';
import type { TaskExecutionResultOutput } from './output-contracts.js';
import { NonEmptyString, StringArray, literalUnion, strictObject } from './schema-primitives.js';
import { assertStrictJsonSchema, stableSchemaHash } from './preflight.js';

export const MinimalTaskSubmissionSchema = strictObject({
  kind: Type.Literal('task_execution_result'), schemaVersion: Type.Literal('2.0'),
  status: literalUnion(['completed', 'failed', 'blocked', 'needs_review'] as const),
  summary: NonEmptyString, artifactRefs: StringArray, blockers: StringArray, nextActions: StringArray
});
export type MinimalTaskSubmission = Static<typeof MinimalTaskSubmissionSchema>;
assertStrictJsonSchema(MinimalTaskSubmissionSchema);
// Shared contracts are also imported by the sandboxed desktop renderer.
// Compile only when validation is requested; Ajv code generation is forbidden
// by the renderer CSP and must not run as an import side effect.
let validator: ValidateFunction | undefined;

export const minimalTaskSubmissionContract = {
  contractId: 'runtime.output.task_execution_result' as const, version: '2.0' as const,
  kind: 'task_execution_result' as const, schema: MinimalTaskSubmissionSchema,
  // This identity changes only with the immutable v2 schema, independently of v1.
  schemaHash: stableSchemaHash(MinimalTaskSubmissionSchema),
  example: { kind: 'task_execution_result', schemaVersion: '2.0', status: 'completed',
    summary: 'Implemented the requested change.', artifactRefs: [], blockers: [], nextActions: [] } satisfies MinimalTaskSubmission,
  validate(value: unknown) {
    validator ??= new Ajv({ allErrors: true, strict: true }).compile(MinimalTaskSubmissionSchema);
    return validator(value)
      ? { valid: true as const, value: structuredClone(value) as MinimalTaskSubmission, errors: [] }
      : { valid: false as const, errors: (validator.errors ?? []).map(error => `${error.instancePath || '/'} ${error.message}`) };
  }
};

/** File identities and test verdicts must come from the captured system evidence. */
export function materializeTaskSubmission(submission: MinimalTaskSubmission, capturedPaths: readonly string[]): TaskExecutionResultOutput {
  if (submission.artifactRefs.some(ref => !capturedPaths.includes(ref))) throw new Error('SUBMISSION_REFERENCE_OUTSIDE_CANDIDATE');
  if (submission.status === 'completed' && submission.blockers.length) throw new Error('SUBMISSION_COMPLETED_WITH_BLOCKERS');
  return { kind: 'task_execution_result', schemaVersion: '1.0', status: submission.status,
    summary: submission.summary, completedItems: [], changedArtifacts: [], requestedContext: null,
    agentMessages: [], nextSuggestedActions: submission.nextActions, risks: submission.blockers };
}
