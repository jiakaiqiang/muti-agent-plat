import type { AgentRunPhase, ContextEnvelopeV2, EvidenceSelectionStrategy } from '@agent-cluster/shared';

export function requiresGroundedRuntimeEvidence(
  phase: AgentRunPhase,
  requiresCodeChanges: boolean,
  strategy: EvidenceSelectionStrategy
) {
  return strategy === 'architecture_analysis' || (phase === 'task_execution' && requiresCodeChanges);
}

export interface GroundedEvidenceGateInput {
  envelope: ContextEnvelopeV2;
  requiresEvidence: boolean;
}

export type GroundedEvidenceGateDecision =
  | { ok: true }
  | { ok: false; reason: 'evidence-empty' | 'evidence-only-generated' | 'evidence-only-sensitive' | 'evidence-not-navigable' };

export function evaluateGroundedEvidenceGate(
  input: GroundedEvidenceGateInput
): GroundedEvidenceGateDecision {
  if (!input.requiresEvidence) return { ok: true };
  const files = input.envelope.L3.files;
  if (files.length === 0) return { ok: false, reason: 'evidence-empty' };

  const manifestByPath = new Map(input.envelope.L1.navigation.entries.map((entry) => [entry.path, entry]));
  const usableFiles = files.filter((file) => {
    const manifestEntry = manifestByPath.get(file.path);
    if (!manifestEntry) return false;
    return !manifestEntry.generated && !manifestEntry.sensitive;
  });

  if (usableFiles.length === 0) {
    const anyGenerated = files.some((file) => manifestByPath.get(file.path)?.generated === true);
    const anyNavigable = files.some((file) => manifestByPath.has(file.path));
    return {
      ok: false,
      reason: !anyNavigable
        ? 'evidence-not-navigable'
        : anyGenerated
          ? 'evidence-only-generated'
          : 'evidence-only-sensitive'
    };
  }
  return { ok: true };
}
