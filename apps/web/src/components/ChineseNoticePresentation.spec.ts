import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { ChatMessage } from '@/types/contracts'
import WebChatTimeline from './ChatTimeline.vue'
import DesktopChatTimeline from '../../../desktop/renderer/components/ChatTimeline.vue'
import { chatMessageText, eventNoticeText } from '@/utils/userFacingCopy'

const content = 'Supplemental context hydrated for retry: Context v2 blocked an ungrounded runtime call: evidence-empty.'
const reason = 'Context v2 blocked an ungrounded runtime call: evidence-empty.'
const instruction = 'Read at least one non-sensitive source file and retry the same phase.'
const wrappers: VueWrapper[] = []
const base: ChatMessage = { id: 'notice', sessionId: 's', senderType: 'agent', messageType: 'text',
  content, toAgentIds: [], rawEventId: 'e', createdAt: '2026-09-29T00:00:00.000Z' }

beforeEach(() => { setActivePinia(createPinia()); sessionStorage.clear() })
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()) })

describe('built-in Chinese notice presentation', () => {
  it.each([['Web', WebChatTimeline], ['Desktop', DesktopChatTimeline]] as const)('%s displays saved test evidence as escaped text', (_name, component) => {
    const report = '# 测试报告\n<script>alert(1)</script>\n退出码：0'
    const message = { ...base, senderType: 'system' as const, messageType: 'artifact' as const,
      payload: { artifactId: 'report', type: 'test_report', title: '隔离测试报告', contentSummary: '测试完成',
        intentTestReport: { format: 'markdown', content: report, stepId: 'step', invocationId: 'run', bindingHash: 'a'.repeat(64),
          snapshotHash: 'b'.repeat(64), script: 'test:unit', exitCode: 0, supersedesArtifactIds: ['old-report'] }, runtimeProposals: [], platformProjections: [], systemEvidence: null } }
    const wrapper = mount(component, { props: { messages: [message as ChatMessage] }, global: { stubs: {
      ChatScrollArea: { props: ['messages'], template: '<div><slot :visible-messages="messages" /></div>' }, AgentPortrait: true
    } } }); wrappers.push(wrapper)
    expect(wrapper.text()).toContain('查看隔离测试报告'); expect(wrapper.get('pre').text()).toBe(report)
    expect(wrapper.text()).toContain('关联的 1 份旧报告仍保留在会话记录中')
    expect(wrapper.find('script').exists()).toBe(false); expect(wrapper.get('details').attributes('open')).toBeUndefined()
  })
  it.each([['Web', WebChatTimeline], ['Desktop', DesktopChatTimeline]] as const)('%s localizes historical context notices without changing stored content', (_name, component) => {
    const message = { ...base, payload: { phase: 'context_supplement',
      requestedContext: { reason, requestedRefs: [], requestedPaths: ['game.js'], followUpInstruction: instruction },
      resolution: { outcome: 'resolved', hydratedPaths: ['game.js'], failedPaths: [], deferredPaths: [] } } }
    const wrapper = mount(component, { props: { messages: [message] }, global: { stubs: {
      ChatScrollArea: { props: ['messages'], template: '<div><slot :visible-messages="messages" /></div>' }, AgentPortrait: true
    } } })
    wrappers.push(wrapper)
    expect(chatMessageText(message)).toBe('所需上下文已补充，正在重新组装并检查证据。')
    expect(wrapper.text()).toContain('历史补读原因（已处理）')
    expect(wrapper.find('details.context-request-history').attributes('open')).toBeUndefined()
    expect(wrapper.text()).not.toContain('下一步指令')
    expect(wrapper.text()).not.toContain('请至少读取一个非敏感源码文件')
    expect(wrapper.text()).not.toContain('Supplemental context hydrated')
    expect(wrapper.text()).not.toContain('Read at least one')
    expect(wrapper.text()).toContain('game.js')
    expect(message.content).toBe(content)
    expect(message.payload.requestedContext.reason).toBe(reason)
  })

  it.each([['Web', WebChatTimeline], ['Desktop', DesktopChatTimeline]] as const)('%s keeps unresolved errors actionable and model failures separate', (_name, component) => {
    const message = { ...base, payload: { phase: 'context_supplement',
      requestedContext: { reason, requestedRefs: [], followUpInstruction: instruction },
      resolution: { outcome: 'exhausted', hydratedPaths: [], failedPaths: [{ path: 'game.js', code: 'READ_ERROR' }], deferredPaths: [] } } }
    const provider = { ...base, id: 'provider', senderType: 'system' as const,
      content: '模型服务异常／等待恢复', payload: { code: 'RUNTIME_REQUEST_HEALTH_CHANGED' } }
    const wrapper = mount(component, { props: { messages: [message, provider] }, global: { stubs: {
      ChatScrollArea: { props: ['messages'], template: '<div><slot :visible-messages="messages" /></div>' }, AgentPortrait: true
    } } })
    wrappers.push(wrapper)
    expect(wrapper.find('details.context-request-history').exists()).toBe(false)
    expect(wrapper.text()).toContain('上下文准备未完成')
    expect(wrapper.text()).toContain('读取失败')
    expect(wrapper.text()).toContain('下一步指令')
    expect(chatMessageText(provider)).toBe('模型服务异常／等待恢复')
  })

  it('also presents historical collaboration log notices from their resolution without rewriting events', () => {
    const event = { type: 'agent_message', content, metadata: { payload: { phase: 'context_supplement',
      requestedContext: { reason }, resolution: { outcome: 'resolved' } } } } as Parameters<typeof eventNoticeText>[0]
    expect(eventNoticeText(event)).toBe('所需上下文已补充，正在重新组装并检查证据。')
    expect(event.content).toBe(content)
  })

  it('does not translate ordinary model replies, user text or code', () => {
    expect(chatMessageText(base)).toBe(content)
    expect(chatMessageText({ ...base, senderType: 'user', payload: { phase: 'context_supplement' } })).toBe(content)
    expect(chatMessageText({ ...base, content: 'const text = "hello";', senderType: 'system' })).toBe('const text = "hello";')
  })
})
