import type { ActorRef, CollaborationEvent } from '@/types/contracts'
import { useAgentStore } from '@/stores/agent'

/** Resolve the authoritative ActorRef used by event views. */
export interface ResolvedActor {
  type: 'user' | 'agent' | 'system'
  id: string
  displayName: string
  avatarKey?: string
}

export function actorAgentId(actor: ActorRef | undefined): string | undefined {
  return actor?.type === 'agent' ? actor.id : undefined
}

export function eventAgentId(event: CollaborationEvent): string | undefined {
  return actorAgentId(event.actor)
}

export function resolveActor(event: CollaborationEvent): ResolvedActor {
  const actor = eventActor(event)
  const agentStore = useAgentStore()
  if (actor.type === 'agent') {
    return {
      type: 'agent',
      id: actor.id,
      displayName: agentStore.agentName(actor.id) || actor.id,
      avatarKey: actor.id
    }
  }
  if (actor.type === 'user') {
    return { type: 'user', id: actor.id, displayName: '你' }
  }
  return { type: 'system', id: actor.id, displayName: '系统' }
}

export function eventActor(event: CollaborationEvent): ActorRef {
  if (event.actor) return event.actor
  if (event.type === 'user_message') return { type: 'user', id: 'system' }
  return { type: 'system', id: 'system' }
}

export function useActor() {
  return { resolveActor }
}
