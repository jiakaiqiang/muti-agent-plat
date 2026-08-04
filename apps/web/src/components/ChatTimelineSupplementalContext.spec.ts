import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { ChatMessage } from '@/types/contracts'
import ChatTimeline from './ChatTimeline.vue'

function message(resolution: Record<string, unknown>, requestedContext?: Record<string, unknown>): ChatMessage {
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
        requestedPaths: ['src/main.ts'],
        ...requestedContext
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
          contentBytes: 0,
          outcome: 'exhausted'
        })]
      },
      global: { stubs: { AgentPortrait: true } }
    })
    expect(wrapper.text()).toContain('读取失败')
    expect(wrapper.text()).toContain('src/main.ts / BROKER_OFFLINE')
    expect(wrapper.text()).not.toContain('等待中')
  })

  it('uses semantic resolution outcomes and renders canonical file/ref details', () => {
    const wrapper = mount(ChatTimeline, {
      props: {
        messages: [message({
          requestedFiles: [{ path: 'docs/architecture.md' }],
          hydratedPaths: [],
          resolvedRefs: [{ type: 'artifact', label: 'Architecture', ref: 'artifact-1' }],
          failedRefs: [],
          failedPaths: [],
          deferredPaths: [],
          contentBytes: 128,
          outcome: 'resolved'
        }, {
          requestedPaths: undefined,
          requestedFiles: [{ path: 'docs/architecture.md' }],
          requestedRefs: [{ type: 'artifact', label: 'Architecture' }]
        })]
      },
      global: { stubs: { AgentPortrait: true } }
    })
    expect(wrapper.text()).toContain('已补充')
    expect(wrapper.text()).toContain('docs/architecture.md')
    expect(wrapper.text()).toContain('artifact / Architecture / artifact-1')
  })

  it('shows invalid semantic references as terminal failures', () => {
    const wrapper = mount(ChatTimeline, {
      props: {
        messages: [message({
          requestedFiles: [], hydratedPaths: [], resolvedRefs: [],
          failedRefs: [{ type: 'historical_decision', label: 'Missing decision', code: 'INVALID_REFERENCE', retryable: true }],
          failedPaths: [], deferredPaths: [], contentBytes: 0, outcome: 'exhausted'
        }, { requestedPaths: undefined, requestedRefs: [{ type: 'historical_decision', label: 'Missing decision' }] })]
      },
      global: { stubs: { AgentPortrait: true } }
    })
    expect(wrapper.text()).toContain('引用无效')
    expect(wrapper.text()).toContain('historical_decision / Missing decision / INVALID_REFERENCE')
  })
})
