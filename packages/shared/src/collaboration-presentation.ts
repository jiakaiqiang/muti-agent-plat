import type { DelegationStatus, DiscussionRunStatus } from './discussion-contracts.js';
import type { RequirementDocumentSections, RequirementDocumentStatus } from './requirement-document-contracts.js';

/**
 * Business-state projections both clients derive the same way.
 *
 * Web and desktop keep their own layout and styling, but they must not disagree
 * about *what* is true: which document version is current, whether a card the
 * user is looking at is already stale, and whether a discussion round actually
 * produced a complete answer. Computing that twice in two component trees is how
 * one end ends up offering a button the server already refuses, so the verdicts
 * live here and each end only renders them.
 *
 * Deliberately free of document bodies and model reasoning: these projections
 * carry versions, hashes and conclusions, never prose a client has no business
 * holding.
 */

export type DocumentVersionSummary = {
  documentId: string;
  documentRevision: number;
  workItemRevision: number;
  contentHash: string;
  status: RequirementDocumentStatus;
  createdAt: string;
  /** Set once a user confirmation approved this exact version. */
  confirmationId?: string;
};

export type DocumentStalenessVerdict =
  | { stale: false; currentRevision: number }
  | { stale: true; currentRevision: number; reason: 'revision_superseded' | 'content_changed' | 'unknown_document' };

export type DocumentVersionTimeline = {
  /** Newest first: both ends list history in the same order. */
  versions: DocumentVersionSummary[];
  current?: DocumentVersionSummary;
  /** A formal current version still needs the user; a confirmed one does not. */
  awaitingConfirmation: boolean;
  staleness(binding: { documentId: string; documentRevision: number; contentHash: string }): DocumentStalenessVerdict;
};

export function documentVersionTimeline(versions: readonly DocumentVersionSummary[]): DocumentVersionTimeline {
  const ordered = [...versions].sort((left, right) => right.documentRevision - left.documentRevision);
  const current = ordered[0];

  return {
    versions: ordered,
    ...(current ? { current } : {}),
    awaitingConfirmation: current?.status === 'formal',
    staleness(binding) {
      if (!current) return { stale: true, currentRevision: 0, reason: 'unknown_document' };
      if (binding.documentId !== current.documentId || binding.documentRevision < current.documentRevision) {
        return { stale: true, currentRevision: current.documentRevision, reason: 'revision_superseded' };
      }
      // Same revision with different content is a different document: the hash
      // is the binding, not the number.
      if (binding.contentHash !== current.contentHash) {
        return { stale: true, currentRevision: current.documentRevision, reason: 'content_changed' };
      }
      return { stale: false, currentRevision: current.documentRevision };
    }
  };
}

export type DocumentSectionKey = keyof RequirementDocumentSections;

export type DocumentSectionChanges = {
  changed: DocumentSectionKey[];
  unchanged: DocumentSectionKey[];
  hasChanges: boolean;
};

const SECTION_KEYS: readonly DocumentSectionKey[] = [
  'goal',
  'scope',
  'outOfScope',
  'acceptanceCriteria',
  'risks',
  'pendingItems'
];

/**
 * Names which sections moved between two versions. Each end renders the actual
 * text change with its own diff component; the set of changed sections is
 * business state and has to agree.
 */
export function documentSectionChanges(
  previous: RequirementDocumentSections,
  next: RequirementDocumentSections
): DocumentSectionChanges {
  const changed: DocumentSectionKey[] = [];
  const unchanged: DocumentSectionKey[] = [];

  for (const key of SECTION_KEYS) {
    const before = previous[key];
    const after = next[key];
    const same = Array.isArray(before) && Array.isArray(after)
      ? before.length === after.length && before.every((item, index) => item === after[index])
      : before === after;
    (same ? unchanged : changed).push(key);
  }

  return { changed, unchanged, hasChanges: changed.length > 0 };
}

export type DiscussionDelegationView = {
  targetAgentId: string;
  objective: string;
  status: DelegationStatus;
  conclusion?: string;
  failureReason?: string;
};

export type DiscussionProgressInput = {
  status: DiscussionRunStatus;
  objective: string;
  exitCondition: string;
  round: number;
  roundLimit: number;
  delegations: DiscussionDelegationView[];
};

export type DiscussionProgressView = {
  headline: string;
  objective: string;
  exitCondition: string;
  roundLabel: string;
  pending: DiscussionDelegationView[];
  answered: DiscussionDelegationView[];
  failed: DiscussionDelegationView[];
  awaitingUser: boolean;
  /** False whenever an asked expert failed or has not answered yet. */
  completeAnswer: boolean;
};

const HEADLINES: Readonly<Record<DiscussionRunStatus, string>> = {
  planning: '正在规划讨论',
  consulting: '正在咨询专家',
  synthesizing: '正在汇总专家结论',
  waiting_user: '等待用户决定',
  ready_for_confirmation: '已形成综合结论',
  paused: '讨论已暂停，可恢复',
  failed: '讨论失败，等待处理'
};

const PENDING_STATUSES: readonly DelegationStatus[] = ['pending', 'running'];
/** blocked counts as unfinished: the expert could not answer, it did not answer. */
const UNFINISHED_STATUSES: readonly DelegationStatus[] = ['pending', 'running', 'blocked', 'failed'];

/**
 * Projects one discussion run for display. Fields are copied by name so a
 * delegation record carrying private model reasoning cannot leak it into a
 * client payload just by existing on the source object.
 */
export function discussionProgressView(input: DiscussionProgressInput): DiscussionProgressView {
  const project = (item: DiscussionDelegationView): DiscussionDelegationView => ({
    targetAgentId: item.targetAgentId,
    objective: item.objective,
    status: item.status,
    ...(item.conclusion === undefined ? {} : { conclusion: item.conclusion }),
    ...(item.failureReason === undefined ? {} : { failureReason: item.failureReason })
  });

  const pending = input.delegations.filter((item) => PENDING_STATUSES.includes(item.status)).map(project);
  const answered = input.delegations.filter((item) => item.status === 'completed').map(project);
  const failed = input.delegations
    .filter((item) => item.status === 'failed' || item.status === 'blocked')
    .map(project);
  const unfinished = input.delegations.some((item) => UNFINISHED_STATUSES.includes(item.status));

  return {
    headline: HEADLINES[input.status],
    objective: input.objective,
    exitCondition: input.exitCondition,
    roundLabel: `第 ${input.round}/${input.roundLimit} 轮`,
    pending,
    answered,
    failed,
    awaitingUser: input.status === 'waiting_user',
    // A synthesis is only a complete answer when the run closed and every expert
    // it asked actually answered. Anything else must keep showing why.
    completeAnswer: input.status === 'ready_for_confirmation' && !unfinished
  };
}
