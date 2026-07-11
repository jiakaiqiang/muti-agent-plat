import type { ContextEnvelopeV2 } from '@agent-cluster/shared';

export interface GroundedEvidenceGateInput {
  envelope: ContextEnvelopeV2;
  requiresEvidence: boolean;
}

export type GroundedEvidenceGateDecision =
  | { ok: true }
  | { ok: false; reason: 'evidence-empty' | 'evidence-only-generated' | 'evidence-only-sensitive' };

export function evaluateGroundedEvidenceGate(
  input: GroundedEvidenceGateInput
): GroundedEvidenceGateDecision {
  if (!input.requiresEvidence) return { ok: true };
  const files = input.envelope.L3.files;
  if (files.length === 0) return { ok: false, reason: 'evidence-empty' };

  const manifestByPath = new Map(input.envelope.L1.entries.map((entry) => [entry.path, entry]));
  const usableFiles = files.filter((file) => {
    const manifestEntry = manifestByPath.get(file.path);
    if (!manifestEntry) return true;
    return !manifestEntry.generated && !manifestEntry.sensitive;
  });

  if (usableFiles.length === 0) {
    const anyGenerated = files.some((file) => manifestByPath.get(file.path)?.generated === true);
    return {
      ok: false,
      reason: anyGenerated ? 'evidence-only-generated' : 'evidence-only-sensitive'
    };
  }
  return { ok: true };
}
