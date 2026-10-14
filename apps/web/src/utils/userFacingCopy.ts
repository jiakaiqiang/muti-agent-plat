import { localizeBuiltInNotice } from '@agent-cluster/shared'
import type { ChatMessage, CollaborationEvent } from '@/types/contracts'

/** Display-only compatibility: persisted user/model messages are never rewritten. */
export function chatMessageText(message: ChatMessage) {
  const builtIn = message.senderType === 'system' || message.messageType !== 'text' || message.payload?.phase === 'context_supplement'
  return builtIn && message.senderType !== 'user' ? localizeBuiltInNotice(message.content) : message.content
}

export function eventNoticeText(event: CollaborationEvent) {
  const builtIn = event.type !== 'user_message' && (event.type !== 'agent_message' || event.metadata.payload?.phase === 'context_supplement')
  return builtIn ? localizeBuiltInNotice(event.content) : event.content
}
