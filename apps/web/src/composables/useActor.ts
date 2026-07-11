import type { ActorRef, CollaborationEvent } from '@/types/contracts'
import { useAgentStore } from '@/stores/agent'

/**
 * `useActor` 提供事件层统一的 actor 读取:优先 `event.actor`,不存在则回退到旧的 `fromAgentId`(视作 agent)
 * 或按事件类型推 system。返回值包含 type/id/displayName/avatarKey,便于 ChatTimeline 侧渲染。
 *
 * v0.2 双写期契约见 docs/contracts/event-contract-v0.1.md §10。
 */
export interface ResolvedActor {
  type: 'user' | 'agent' | 'system'
  id: string
  displayName: string
  avatarKey?: string
}

export function actorAgentId(actor: ActorRef | undefined, legacyAgentId?: string): string | undefined {
  return actor?.type === 'agent' ? actor.id : legacyAgentId
}

export function eventAgentId(event: CollaborationEvent): string | undefined {
  return actorAgentId(event.actor, event.fromAgentId)
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
  if (event.fromAgentId) return { type: 'agent', id: event.fromAgentId }
  return { type: 'system', id: 'system' }
}

export function useActor() {
  return { resolveActor }
}
