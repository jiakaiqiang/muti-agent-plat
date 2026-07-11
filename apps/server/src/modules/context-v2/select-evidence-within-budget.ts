import type { ContextL3EvidenceFile, ContextL3SelectedEvidence } from '@agent-cluster/shared';
import type { ScoredEvidenceCandidate } from './score-evidence-candidates.js';

export interface SelectEvidenceWithinBudgetArgs {
  candidates: ScoredEvidenceCandidate[];
  contents: Map<string, ContextL3EvidenceFile>;
  budgetBytes: number;
}

export function selectEvidenceWithinBudget(
  args: SelectEvidenceWithinBudgetArgs
): ContextL3SelectedEvidence {
  const { candidates, contents, budgetBytes } = args;
  const orderedCandidates = [...candidates].sort(
    (a, b) => (b.score - a.score) || a.path.localeCompare(b.path)
  );

  const selected: ContextL3EvidenceFile[] = [];
  let usedBytes = 0;
  let dropped = false;

  for (const candidate of orderedCandidates) {
    const file = contents.get(candidate.path);
    if (!file) continue;
    if (usedBytes + file.byteLength > budgetBytes) {
      dropped = true;
      continue;
    }
    selected.push(file);
    usedBytes += file.byteLength;
  }

  return {
    files: selected,
    totalByteLength: usedBytes,
    truncated: dropped || candidates.length > selected.length
  };
}
