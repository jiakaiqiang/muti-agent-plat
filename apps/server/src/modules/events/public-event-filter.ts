import { shouldPublishRuntimeEventToCollaboration, type CollaborationEvent } from '@agent-cluster/shared';

export function shouldExposeCollaborationEvent(event: CollaborationEvent): boolean {
  const payload = event.metadata?.payload as { code?: unknown; visibility?: unknown } | undefined;
  const visibility = (event as unknown as { visibility?: unknown }).visibility ?? payload?.visibility;
  return shouldPublishRuntimeEventToCollaboration({
    type: event.type,
    visibility,
    code: payload?.code
  });
}
