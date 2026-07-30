import { shouldPublishRuntimeEventToCollaboration, type CollaborationEvent } from '@agent-cluster/shared';

export function shouldExposeCollaborationEvent(event: CollaborationEvent): boolean {
  const payload = event.metadata?.payload as { code?: unknown; visibility?: unknown; phase?: unknown } | undefined;
  const visibility = (event as unknown as { visibility?: unknown }).visibility ?? payload?.visibility;
  if (payload?.phase === 'user_message_routing' && event.type.startsWith('runtime_')) return false;
  return shouldPublishRuntimeEventToCollaboration({
    type: event.type,
    visibility,
    code: payload?.code
  });
}
