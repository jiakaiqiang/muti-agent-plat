import type { DecisionRecord, SummaryMemory } from '@agent-cluster/shared';

export type SummaryMemoryDerivationInput = {
  goal: string;
  currentState: string;
  confirmedFacts: string[];
  completed: string[];
  nextSteps: string[];
  risks: string[];
  /** Authoritative decision ledger for the WorkItem; only `confirmed` rows count. */
  decisions: DecisionRecord[];
  requirementChanged?: boolean;
  constraints?: string[];
  acceptanceCriteria?: string[];
  openQuestions?: string[];
  previous?: SummaryMemory;
};

export type DerivedSummaryMemory = SummaryMemory & { sourceDecisionIds: string[] };

const FACT_LIMIT = 12;
const COMPLETED_LIMIT = 12;
const DECISION_LIMIT = 8;
const QUESTION_LIMIT = 8;
const RISK_LIMIT = 8;

/**
 * Pure summary derivation (phase 2B).
 *
 * Decisions are read from the DecisionRecord ledger rather than merged forward
 * from the previous checkpoint, so a superseded decision disappears the moment
 * the ledger says so — the prior summary cannot resurrect it. Everything else
 * that the previous checkpoint contributed is carried forward as before.
 */
export function deriveSummaryMemory(input: SummaryMemoryDerivationInput): DerivedSummaryMemory {
  const previous = input.previous;
  const effective = input.decisions.filter((decision) => decision.status === 'confirmed');
  const decisions = effective.map(renderDecision).slice(-DECISION_LIMIT);
  const questions = reconcileOpenQuestions({
    previous: previous?.openQuestions ?? [],
    current: input.openQuestions ?? [],
    resolvedBy: effective
  });
  return {
    goal: input.goal,
    currentState: input.currentState,
    confirmedFacts: unique([
      ...(input.requirementChanged ? [] : previous?.confirmedFacts ?? []),
      ...input.confirmedFacts,
      ...(input.constraints ?? []).map((value) => `Constraint: ${value}`),
      ...(input.acceptanceCriteria ?? []).map((value) => `Acceptance: ${value}`)
    ], FACT_LIMIT),
    completed: unique([...(previous?.completed ?? []), ...input.completed], COMPLETED_LIMIT),
    decisions,
    openQuestions: questions.open.slice(-QUESTION_LIMIT),
    risks: unique([...(previous?.risks ?? []), ...input.risks], RISK_LIMIT),
    nextSteps: input.nextSteps,
    checkpointRefs: previous?.checkpointRefs ?? [],
    sourceEventIds: previous?.sourceEventIds ?? [],
    sourceArtifactIds: previous?.sourceArtifactIds ?? [],
    sourceMemoryIds: previous?.sourceMemoryIds ?? [],
    sourceDecisionIds: effective.map((decision) => decision.id)
  };
}

/**
 * Open questions are a set with explicit transitions: a question that a newer
 * confirmed decision answers is resolved and dropped, one that stops being
 * reported by the current brief is kept only if nothing answered it, and new
 * ones are added. This is what keeps "openQuestions" from growing forever.
 */
export function reconcileOpenQuestions(input: {
  previous: string[];
  current: string[];
  resolvedBy: DecisionRecord[];
}): { open: string[]; added: string[]; resolved: string[] } {
  const previous = unique(input.previous, Number.POSITIVE_INFINITY);
  const current = unique(input.current, Number.POSITIVE_INFINITY);
  const resolved = previous.filter((question) =>
    !current.includes(question) && input.resolvedBy.some((decision) => answers(decision.content, question))
  );
  const open = unique([...previous.filter((question) => !resolved.includes(question)), ...current], Number.POSITIVE_INFINITY);
  const added = current.filter((question) => !previous.includes(question));
  return { open, added, resolved };
}

function renderDecision(decision: DecisionRecord) {
  return `[${decision.id}] ${decision.content}`;
}

/** Keyword overlap between a decision and a question; conservative on purpose. */
function answers(decisionContent: string, question: string) {
  const decisionTerms = new Set(terms(decisionContent));
  const questionTerms = terms(question);
  if (!questionTerms.length) return false;
  const hits = questionTerms.filter((term) => decisionTerms.has(term)).length;
  return hits >= Math.max(1, Math.ceil(questionTerms.length / 2));
}

/** Latin words as-is; CJK runs as character bigrams, since they carry no whitespace. */
function terms(text: string): string[] {
  const normalized = text.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const result = new Set<string>();
  for (const token of normalized.split(/\s+/).filter((item) => item.length > 1)) {
    if (/[㐀-鿿]/u.test(token)) {
      for (let index = 0; index + 2 <= token.length; index += 1) result.add(token.slice(index, index + 2));
    } else {
      result.add(token);
    }
  }
  return [...result];
}

function unique(values: string[], limit: number) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return Number.isFinite(limit) ? result.slice(-limit) : result;
}
