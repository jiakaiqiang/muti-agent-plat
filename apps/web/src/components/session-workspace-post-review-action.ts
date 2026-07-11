import type { PostReviewAction } from '@/types/contracts'

type PostReviewActionHandlers = {
  requestWorkspaceContext(action: Extract<PostReviewAction, { action: 'request_workspace_context' }>): Promise<void>
  deliverWithLimitations(action: Extract<PostReviewAction, { action: 'deliver_with_limitations' }>): Promise<void>
  saveProgress(action: Extract<PostReviewAction, { action: 'save_progress' }>): Promise<void>
  cancel(action: Extract<PostReviewAction, { action: 'cancel' }>): Promise<void>
}

export async function resolveSessionWorkspacePostReviewAction(
  actionKey: string,
  actions: PostReviewAction[],
  handlers: PostReviewActionHandlers
) {
  const action = actions.find((candidate) => candidate.action === actionKey)
  if (!action) return false

  switch (action.action) {
    case 'request_workspace_context':
      await handlers.requestWorkspaceContext(action)
      return true
    case 'deliver_with_limitations':
      await handlers.deliverWithLimitations(action)
      return true
    case 'save_progress':
      await handlers.saveProgress(action)
      return true
    case 'cancel':
      await handlers.cancel(action)
      return true
  }
}
