import type { InvocationPlan } from './contracts.js';

/** Bounded handoff metadata; bytes stay in the verified isolated workspace. */
export function runtimeRecoveryContext(plan: InvocationPlan) {
  const candidate = plan.recoveryCandidate;
  if (!candidate) return undefined;
  return { instruction: 'The platform restored the prior candidate. Read its changed files, reconcile them with the current goal and evidence, and continue only unfinished work. Prior edits are not proof that tests passed. Do not replay external actions with unknown outcomes.',
    candidateId: candidate.id, manifestHash: candidate.manifestHash, stage: candidate.stage,
    changedFileCount: candidate.changeSet.changes.length,
    paths: candidate.changeSet.changes.slice(0, 64).map(change => change.operation === 'move' ? change.toPath : change.path) };
}
