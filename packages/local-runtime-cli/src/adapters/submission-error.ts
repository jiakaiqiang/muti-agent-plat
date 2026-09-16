export class SubmissionError extends Error {
  constructor(readonly originalSubmission: unknown, readonly schemaErrors: string[]) {
    super(`RUNTIME_OUTPUT_CONTRACT_VIOLATION: ${schemaErrors.join('; ')}`);
  }
}
