import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { ChatMessage } from '@/types/contracts'
import ChatTimeline from './ChatTimeline.vue'

function message(resolution: Record<string, unknown>): ChatMessage {
  return {
    id: 'message-1',
    sessionId: 'session-1',
    senderType: 'agent',
    senderAgentId: 'architect',
    toAgentIds: [],
    messageType: 'text',
    content: 'Supplemental context request recorded.',
    createdAt: '2026-07-13T00:00:00.000Z',
    rawEventId: 'event-1',
    payload: {
      phase: 'context_supplement',
      requestedContext: {
        reason: 'Need source',
        requestedRefs: [],
        requestedPaths: ['src/main.ts']
      },
      resolution
    }
  }
}

describe('ChatTimeline supplemental context status', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    HTMLElement.prototype.scrollTo = vi.fn()
  })

  it('renders a terminal read failure instead of permanent waiting', () => {
    const wrapper = mount(ChatTimeline, {
      props: {
        messages: [message({
          requestedPaths: ['src/main.ts'],
          hydratedPaths: [],
          failedPaths: [{ path: 'src/main.ts', code: 'BROKER_OFFLINE', retryable: true }],
          deferredPaths: [],
          contentBytes: 0
        })]
      },
      global: { stubs: { AgentPortrait: true } }
    })
    expect(wrapper.text()).toContain('读取失败')
    expect(wrapper.text()).toContain('src/main.ts / BROKER_OFFLINE')
    expect(wrapper.text()).not.toContain('等待中')
  })
})
