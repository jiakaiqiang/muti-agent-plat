import { PROCEED_WITH_OPEN_QUESTIONS_OPTION, type CollaborationEvent, type TaskBrief } from '@agent-cluster/shared';

export { PROCEED_WITH_OPEN_QUESTIONS_OPTION };

/**
 * Count durable revision requests for the current work item.
 *
 * A brief version is not sufficient here because a follow-up can create a new
 * brief without being a revision. The rejection event is the durable fact that
 * a user actually submitted a revision, and the work-item boundary prevents a
 * completed task from consuming the budget of an unrelated task in the same
 * session.
 */
export function countBriefRevisionAttempts(
  events: CollaborationEvent[],
  briefs: TaskBrief[],
  currentBrief: TaskBrief
) {
  const relatedBriefIds = new Set(
    briefs
      .filter((brief) => currentBrief.workItemId
        ? brief.workItemId === currentBrief.workItemId
        : !brief.workItemId)
      .map((brief) => brief.id)
  );
  relatedBriefIds.add(currentBrief.id);
  return events.filter((event) => {
    if (event.type !== 'brief_rejected') return false;
    const payload = event.metadata?.payload as { briefId?: unknown; workItemId?: unknown } | undefined;
    if (currentBrief.workItemId && payload?.workItemId === currentBrief.workItemId) return true;
    const briefId = payload?.briefId;
    return typeof briefId === 'string' && relatedBriefIds.has(briefId);
  }).length;
}
