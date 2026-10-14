import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { ChatMessage } from '@/types/contracts'
import WebChatTimeline from './ChatTimeline.vue'
import DesktopChatTimeline from '../../../desktop/renderer/components/ChatTimeline.vue'
import { chatMessageText } from '@/utils/userFacingCopy'

const content = 'Supplemental context hydrated for retry: Context v2 blocked an ungrounded runtime call: evidence-empty.'
const reason = 'Context v2 blocked an ungrounded runtime call: evidence-empty.'
const instruction = 'Read at least one non-sensitive source file and retry the same phase.'
const wrappers: VueWrapper[] = []
const base: ChatMessage = { id: 'notice', sessionId: 's', senderType: 'agent', messageType: 'text',
  content, toAgentIds: [], rawEventId: 'e', createdAt: '2026-09-29T00:00:00.000Z' }

beforeEach(() => { setActivePinia(createPinia()); sessionStorage.clear() })
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()) })

describe('built-in Chinese notice presentation', () => {
  it.each([['Web', WebChatTimeline], ['Desktop', DesktopChatTimeline]] as const)('%s localizes historical context notices without changing stored content', (_name, component) => {
    const message = { ...base, payload: { phase: 'context_supplement',
      requestedContext: { reason, requestedRefs: [], requestedPaths: ['game.js'], followUpInstruction: instruction },
      resolution: { outcome: 'resolved', hydratedPaths: ['game.js'], failedPaths: [], deferredPaths: [] } } }
    const wrapper = mount(component, { props: { messages: [message] }, global: { stubs: {
      ChatScrollArea: { props: ['messages'], template: '<div><slot :visible-messages="messages" /></div>' }, AgentPortrait: true
    } } })
    wrappers.push(wrapper)
    expect(wrapper.text()).toContain('已补充上下文，准备重试')
    expect(wrapper.text()).toContain('请至少读取一个非敏感源码文件')
    expect(wrapper.text()).not.toContain('Supplemental context hydrated')
    expect(wrapper.text()).not.toContain('Read at least one')
    expect(wrapper.text()).toContain('game.js')
    expect(message.content).toBe(content)
    expect(message.payload.requestedContext.reason).toBe(reason)
  })

  it('does not translate ordinary model replies, user text or code', () => {
    expect(chatMessageText(base)).toBe(content)
    expect(chatMessageText({ ...base, senderType: 'user', payload: { phase: 'context_supplement' } })).toBe(content)
    expect(chatMessageText({ ...base, content: 'const text = "hello";', senderType: 'system' })).toBe('const text = "hello";')
  })
})
