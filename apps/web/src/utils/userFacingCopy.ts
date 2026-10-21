import { contextSupplementNotice, localizeBuiltInNotice } from '@agent-cluster/shared'
import type { SupplementalContextResolution } from '@agent-cluster/shared'
import type { ChatMessage, CollaborationEvent } from '@/types/contracts'

/** Display-only compatibility: persisted user/model messages are never rewritten. */
export function chatMessageText(message: ChatMessage) {
  if (message.senderType !== 'user' && message.payload?.phase === 'context_supplement' && message.payload?.resolution) {
    const resolution = message.payload.resolution as SupplementalContextResolution
    return contextSupplementNotice(resolution, (message.payload.requestedContext as { reason?: string } | undefined)?.reason ?? message.content)
  }
  const builtIn = message.senderType === 'system' || message.messageType !== 'text' || message.payload?.phase === 'context_supplement'
  return builtIn && message.senderType !== 'user' ? localizeBuiltInNotice(message.content) : message.content
}

export function eventNoticeText(event: CollaborationEvent) {
  const payload = event.metadata.payload
  if (event.type !== 'user_message' && payload?.phase === 'context_supplement' && payload.resolution) {
    return contextSupplementNotice(payload.resolution as SupplementalContextResolution,
      (payload.requestedContext as { reason?: string } | undefined)?.reason ?? event.content)
  }
  const builtIn = event.type !== 'user_message' && (event.type !== 'agent_message' || event.metadata.payload?.phase === 'context_supplement')
  return builtIn ? localizeBuiltInNotice(event.content) : event.content
}
