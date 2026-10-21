import { Check } from '@sinclair/typebox/value';
import { IntentUnderstandingOutputSchema, intentUnderstandingStructureErrors, type IntentUnderstandingOutput } from './runtime-contracts/intent-understanding.js';

/** An immutable diagnostic display; never a confirmation or an execution grant. */
export type IntentMultiSegmentReview = {
  contractVersion: 'intent-multi-segment-review-v1';
  mode: 'clarify_only';
  sessionId: string;
  dataEpoch: string;
  routingId: string;
  sourceEventId: string;
  routingRevision: number;
  referenceLabels?: Array<{ id: string; label: string }>;
  understanding: IntentUnderstandingOutput;
};

export function parseIntentMultiSegmentReview(value: unknown): IntentMultiSegmentReview | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const row = value as IntentMultiSegmentReview;
  if (Object.keys(row).some(key => !['contractVersion', 'mode', 'sessionId', 'dataEpoch', 'routingId', 'sourceEventId', 'routingRevision', 'understanding', 'referenceLabels'].includes(key)) ||
    row.contractVersion !== 'intent-multi-segment-review-v1' || row.mode !== 'clarify_only' ||
    ![row.sessionId, row.dataEpoch, row.routingId, row.sourceEventId].every(id => typeof id === 'string' && id.length > 0 && id.length <= 256) ||
    !Number.isSafeInteger(row.routingRevision) || row.routingRevision < 1) return;
  if (row.referenceLabels !== undefined && (!Array.isArray(row.referenceLabels) || row.referenceLabels.length > 512 ||
    row.referenceLabels.some(item => !item || typeof item.id !== 'string' || !item.id || item.id.length > 256 ||
      typeof item.label !== 'string' || !item.label || item.label.length > 16000))) return;
  // Interpret the same schema; desktop CSP forbids runtime code generation (Ajv compile).
  if (!Check(IntentUnderstandingOutputSchema, row.understanding) || row.understanding.segments.length < 2 ||
    intentUnderstandingStructureErrors(row.understanding).length) return;
  return row;
}
