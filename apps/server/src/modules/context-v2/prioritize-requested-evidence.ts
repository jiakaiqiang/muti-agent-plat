import type { ScoredEvidenceCandidate } from './score-evidence-candidates.js';

const REQUESTED_PRIORITY_BOOST = 10_000;

export function prioritizeRequestedEvidence(
  candidates: ScoredEvidenceCandidate[],
  requestedPaths: string[]
): ScoredEvidenceCandidate[] {
  const requestedSet = new Set(requestedPaths);
  const result = new Map<string, ScoredEvidenceCandidate>();

  for (const candidate of candidates) {
    if (requestedSet.has(candidate.path)) {
      result.set(candidate.path, {
        path: candidate.path,
        score: candidate.score + REQUESTED_PRIORITY_BOOST,
        reasons: appendReason(candidate.reasons, 'user-requested')
      });
    } else {
      result.set(candidate.path, candidate);
    }
  }

  for (const path of requestedSet) {
    if (result.has(path)) continue;
    result.set(path, {
      path,
      score: REQUESTED_PRIORITY_BOOST,
      reasons: ['user-requested']
    });
  }

  return Array.from(result.values()).sort(
    (a, b) => (b.score - a.score) || a.path.localeCompare(b.path)
  );
}

function appendReason(reasons: string[], reason: string): string[] {
  return reasons.includes(reason) ? reasons : [reason, ...reasons];
}
