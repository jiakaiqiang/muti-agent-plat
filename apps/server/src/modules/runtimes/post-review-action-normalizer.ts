export const POST_REVIEW_CONTEXT_ACTION_INSTRUCTION =
  'For post_review_report, when workspace evidence is insufficient, return recommendation "ask_user" and an action "request_workspace_context" with a reason and non-empty missingPaths containing the exact workspace-relative files needed. Do not claim review completion.';
