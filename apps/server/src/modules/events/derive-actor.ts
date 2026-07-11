import type { ActorRef, CollaborationEventType, UUID } from '@agent-cluster/shared';

export type DeriveActorInput = {
  type: CollaborationEventType;
  fromAgentId?: UUID;
  sessionUserId?: UUID;
};

const systemEventTypes = new Set<CollaborationEventType>([
  'session_status_changed',
  'error_reported'
]);

export function deriveActor(input: DeriveActorInput): ActorRef {
  if (input.type === 'user_message') {
    return { type: 'user', id: input.sessionUserId ?? 'system' };
  }
  if (input.fromAgentId) {
    return { type: 'agent', id: input.fromAgentId };
  }
  if (systemEventTypes.has(input.type)) {
    return { type: 'system', id: 'system' };
  }
  return { type: 'system', id: 'system' };
}
