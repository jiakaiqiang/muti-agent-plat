import type { PostReviewAction } from '@agent-cluster/shared';

export const POST_REVIEW_CONTEXT_ACTION_INSTRUCTION =
  'For post_review_report, when workspace evidence is insufficient, return recommendation "ask_user" and an action "request_workspace_context" with a reason and non-empty missingPaths containing the exact workspace-relative files needed. Do not claim review completion.';

function nonEmptyString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function nonEmptyStringArray(value: unknown) {
  if (!Array.isArray(value) || !value.length) {
    return undefined;
  }
  const normalized = value.map(nonEmptyString);
  return normalized.every((item): item is string => Boolean(item))
    ? Array.from(new Set(normalized))
    : undefined;
}

function optionalStringArray(value: unknown) {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value.map(nonEmptyString);
  return normalized.every((item): item is string => Boolean(item))
    ? Array.from(new Set(normalized))
    : undefined;
}

function normalizePostReviewAction(value: unknown): PostReviewAction | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.action === 'request_workspace_context') {
    const reason = nonEmptyString(record.reason);
    const missingPaths = nonEmptyStringArray(record.missingPaths);
    return reason && missingPaths
      ? { action: 'request_workspace_context', reason, missingPaths }
      : undefined;
  }
  if (record.action === 'deliver_with_limitations') {
    const limitations = nonEmptyStringArray(record.limitations);
    return limitations ? { action: 'deliver_with_limitations', limitations } : undefined;
  }
  if (record.action === 'save_progress') {
    const artifactIds = optionalStringArray(record.artifactIds);
    if (record.artifactIds !== undefined && !artifactIds) {
      return undefined;
    }
    return artifactIds ? { action: 'save_progress', artifactIds } : { action: 'save_progress' };
  }
  if (record.action === 'cancel') {
    const reason = nonEmptyString(record.reason);
    if (record.reason !== undefined && !reason) {
      return undefined;
    }
    return reason ? { action: 'cancel', reason } : { action: 'cancel' };
  }
  return undefined;
}

export function normalizePostReviewActions(value: unknown): PostReviewAction[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const actions = value.map(normalizePostReviewAction);
  return actions.every((action): action is PostReviewAction => Boolean(action)) ? actions : undefined;
}
