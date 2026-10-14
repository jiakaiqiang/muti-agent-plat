import { isUsableWorkspaceEvidencePath, isWorkspaceTextContent } from '@agent-cluster/shared';
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
  const fileRevisions = (input.envelope.L3.fileRevisions ?? []).filter(
    (revision) => revision.complete === true && revision.truncated === false
  );
  const evidencePaths = [
    ...files.map((file) => file.path),
    ...fileRevisions.map((revision) => revision.filePath)
  ];

  const manifestByPath = new Map(input.envelope.L1.navigation.entries.map((entry) => [entry.path, entry]));
  const hasAnyNavigableEntry = manifestByPath.size > 0;

  if (evidencePaths.length === 0) {
    if (!hasAnyNavigableEntry) {
      return { ok: false, reason: 'evidence-empty' };
    }
    return { ok: false, reason: 'evidence-empty' };
  }

  const usablePaths = evidencePaths.filter((path) => {
    const manifestEntry = manifestByPath.get(path);
    if (!manifestEntry) return false;
    const file = files.find(item => item.path === path);
    return !manifestEntry.generated && !manifestEntry.sensitive && isUsableWorkspaceEvidencePath(path) &&
      (!file || isWorkspaceTextContent(file.content));
  });

  if (usablePaths.length === 0) {
    const anyGenerated = evidencePaths.some((path) => manifestByPath.get(path)?.generated === true);
    const anyNavigable = evidencePaths.some((path) => manifestByPath.has(path));
    return {
      ok: false,
      reason: !anyNavigable
        ? 'evidence-not-navigable'
        : anyGenerated
          ? 'evidence-only-generated'
          : evidencePaths.some(path => manifestByPath.get(path)?.sensitive)
            ? 'evidence-only-sensitive' : 'evidence-empty'
    };
  }
  return { ok: true };
}
