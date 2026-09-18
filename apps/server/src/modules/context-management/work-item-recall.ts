import type { SummaryCheckpointRecord, WorkItem } from '@agent-cluster/shared';

/**
 * Archive index entry: title, status, time, keywords and checkpoint references
 * only. Bodies stay in events/artifacts/checkpoints and are read on demand
 * after a candidate has been chosen, within the request budget.
 */
export type WorkItemArchiveEntry = {
  workItemId: string;
  title: string;
  status: WorkItem['status'];
  createdAt: string;
  updatedAt: string;
  revision: number;
  keywords: string[];
  latestCheckpointId?: string;
  coveredEventSeq?: number;
  decisionLedgerRevision?: number;
};

export type WorkItemArchiveIndex = {
  entries: WorkItemArchiveEntry[];
  availability: 'ok' | 'limited';
  reason?: string;
};

export type WorkItemRecallCandidate = {
  workItemId: string;
  title: string;
  status: WorkItem['status'];
  matchedBy: 'explicit' | 'lexical';
  matchedTerms: string[];
  score: number;
  latestCheckpointId?: string;
};

export type WorkItemRecallResult = {
  availability: 'ok' | 'limited';
  candidates: WorkItemRecallCandidate[];
  needsClarification: boolean;
  clarificationReason?: 'no_match' | 'multiple_similar_candidates' | 'low_confidence' | 'index_unavailable';
};

const DEFAULT_RECALL_LIMIT = 5;
/** Second-best within this ratio of the best is "similar enough" to require a choice. */
const SIMILARITY_RATIO = 0.8;
const MIN_CONFIDENT_SCORE = 2;

export function buildWorkItemArchiveIndex(
  workItems: WorkItem[],
  checkpoints: SummaryCheckpointRecord[]
): WorkItemArchiveIndex {
  const latestByWorkItem = new Map<string, SummaryCheckpointRecord>();
  for (const checkpoint of checkpoints) {
    const current = latestByWorkItem.get(checkpoint.workItemId);
    if (!current || checkpoint.coveredEventSeq > current.coveredEventSeq) latestByWorkItem.set(checkpoint.workItemId, checkpoint);
  }
  return {
    availability: 'ok',
    entries: workItems.map((item) => {
      const checkpoint = latestByWorkItem.get(item.id);
      return {
        workItemId: item.id,
        title: item.title,
        status: item.status,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        revision: item.revision,
        keywords: terms(`${item.title} ${item.goal}`),
        ...(checkpoint
          ? {
              latestCheckpointId: checkpoint.checkpointId,
              coveredEventSeq: checkpoint.coveredEventSeq,
              decisionLedgerRevision: checkpoint.decisionLedgerRevision
            }
          : {})
      };
    })
  };
}

/**
 * Bounded recall: explicit references first, then lexical overlap over the
 * archive index. Ambiguity (several similar candidates, or a weak best match)
 * is surfaced for clarification rather than resolved by guessing, and an
 * unavailable index is reported as "limited", never as "no such history".
 */
export function recallWorkItems(input: {
  index: WorkItemArchiveIndex;
  message: string;
  explicitWorkItemIds?: string[];
  limit?: number;
}): WorkItemRecallResult {
  const limit = input.limit ?? DEFAULT_RECALL_LIMIT;
  if (input.index.availability !== 'ok') {
    return { availability: 'limited', candidates: [], needsClarification: true, clarificationReason: 'index_unavailable' };
  }
  const byId = new Map(input.index.entries.map((entry) => [entry.workItemId, entry]));
  const explicit: WorkItemRecallCandidate[] = (input.explicitWorkItemIds ?? [])
    .map((id) => byId.get(id))
    .filter((entry): entry is WorkItemArchiveEntry => Boolean(entry))
    .map((entry) => ({
      workItemId: entry.workItemId, title: entry.title, status: entry.status,
      matchedBy: 'explicit', matchedTerms: [], score: Number.POSITIVE_INFINITY, latestCheckpointId: entry.latestCheckpointId
    }));
  if (explicit.length) {
    return { availability: 'ok', candidates: explicit.slice(0, limit), needsClarification: false };
  }

  const queryTerms = terms(input.message);
  const lexical = input.index.entries
    .map((entry) => {
      const matchedTerms = queryTerms.filter((term) => entry.keywords.includes(term));
      return {
        workItemId: entry.workItemId, title: entry.title, status: entry.status,
        matchedBy: 'lexical' as const, matchedTerms, score: matchedTerms.length, latestCheckpointId: entry.latestCheckpointId
      };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || right.workItemId.localeCompare(left.workItemId))
    .slice(0, limit);

  if (!lexical.length) {
    return { availability: 'ok', candidates: [], needsClarification: true, clarificationReason: 'no_match' };
  }
  const [best, second] = lexical;
  if (best.score < MIN_CONFIDENT_SCORE) {
    return { availability: 'ok', candidates: lexical, needsClarification: true, clarificationReason: 'low_confidence' };
  }
  if (second && second.score >= best.score * SIMILARITY_RATIO) {
    return { availability: 'ok', candidates: lexical, needsClarification: true, clarificationReason: 'multiple_similar_candidates' };
  }
  return { availability: 'ok', candidates: lexical, needsClarification: false };
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
