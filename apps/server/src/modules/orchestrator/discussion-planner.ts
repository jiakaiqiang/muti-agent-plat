import type { DelegationOrigin, DiscussionPlanOutput } from '@agent-cluster/shared';

export type PlannerAgentRef = { id: string; key: string };

export type ResolveDiscussionPlanContext = {
  coordinatorAgentId: string;
  /** Agents already in the session — the only ones a delegation may target. */
  participants: readonly PlannerAgentRef[];
  /** Every agent the platform knows; a proposal outside this is not a member to add. */
  catalog: readonly PlannerAgentRef[];
  budgetPerConsultationTokens: number;
};

export type PlannedDelegation = {
  targetAgentId: string;
  targetAgentKey: string;
  origin: DelegationOrigin;
  objective: string;
  expectedResult: string;
  budgetTokens: number;
};

export type PlannedMemberAddition = {
  targetAgentKey: string;
  targetAgentId: string;
  objective: string;
  expectedResult: string;
};

export type DroppedConsultation = {
  targetAgentKey: string;
  reason: 'self_consultation' | 'duplicate_target';
};

export type ResolvedDiscussionPlan =
  | {
      status: 'resolved';
      objective: string;
      gaps: string[];
      exitCondition: string;
      delegations: PlannedDelegation[];
      /** Known agents outside the session: the user decides, the model does not (AC3). */
      memberAdditions: PlannedMemberAddition[];
      /** Names the model produced that match nothing; surfaced, never invented. */
      unknownTargets: string[];
      dropped: DroppedConsultation[];
      questionsForUser: string[];
      readyToSummarize: boolean;
    }
  | { status: 'invalid'; code: 'DISCUSSION_PLAN_EMPTY' };

/**
 * Turns the coordinator's proposal into what the domain will actually do.
 *
 * The model proposes; this decides. Membership is the one boundary the plan
 * makes sharpest: a participant can be delegated to, a catalogued non-member
 * becomes a confirmation for the user, and an unknown name is reported as
 * such. Nothing here creates a member, spends budget or writes state.
 */
export function resolveDiscussionPlan(
  plan: DiscussionPlanOutput,
  context: ResolveDiscussionPlanContext
): ResolvedDiscussionPlan {
  const participantsByKey = new Map(context.participants.map((agent) => [agent.key, agent]));
  const catalogByKey = new Map(context.catalog.map((agent) => [agent.key, agent]));
  const budget = Math.max(0, Math.floor(context.budgetPerConsultationTokens));

  const delegations: PlannedDelegation[] = [];
  const memberAdditions: PlannedMemberAddition[] = [];
  const unknownTargets: string[] = [];
  const dropped: DroppedConsultation[] = [];
  const seen = new Set<string>();

  for (const consultation of plan.consultations) {
    const key = consultation.targetAgentKey;
    if (seen.has(key)) {
      dropped.push({ targetAgentKey: key, reason: 'duplicate_target' });
      continue;
    }
    seen.add(key);

    const participant = participantsByKey.get(key);
    if (participant) {
      if (participant.id === context.coordinatorAgentId) {
        dropped.push({ targetAgentKey: key, reason: 'self_consultation' });
        continue;
      }
      delegations.push({
        targetAgentId: participant.id,
        targetAgentKey: key,
        origin: 'coordinator',
        objective: consultation.objective,
        expectedResult: consultation.expectedResult,
        budgetTokens: budget
      });
      continue;
    }

    const known = catalogByKey.get(key);
    if (known) {
      memberAdditions.push({
        targetAgentKey: key,
        targetAgentId: known.id,
        objective: consultation.objective,
        expectedResult: consultation.expectedResult
      });
      continue;
    }

    unknownTargets.push(key);
  }

  // A round must propose something: ask an expert, ask the user, or close. This
  // is judged on the proposal itself — a plan whose every target was rejected
  // above is still a plan, and the diagnostics are what the coordinator needs
  // to replan. Only a proposal with nothing in it has no exit.
  if (plan.consultations.length === 0 && plan.questionsForUser.length === 0 && !plan.readyToSummarize) {
    return { status: 'invalid', code: 'DISCUSSION_PLAN_EMPTY' };
  }

  return {
    status: 'resolved',
    objective: plan.objective,
    gaps: [...plan.gaps],
    exitCondition: plan.exitCondition,
    delegations,
    memberAdditions,
    unknownTargets,
    dropped,
    questionsForUser: [...plan.questionsForUser],
    readyToSummarize: plan.readyToSummarize
  };
}
