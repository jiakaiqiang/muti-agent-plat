import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { ChatMessage } from '@/types/contracts'
import ChatTimeline from './ChatTimeline.vue'

const { apiGetText } = vi.hoisted(() => ({ apiGetText: vi.fn() }))
vi.mock('@/api/client', () => ({ apiGetText }))

const markdown = '# 修改后的方案\n\n- 由主 Agent 汇总\n'
const contentHash = createHash('sha256').update(markdown).digest('hex')

function message(sessionId = 'session-1', hash = contentHash): ChatMessage {
  return {
    id: `message-${sessionId}`,
    sessionId,
    senderType: 'system',
    toAgentIds: [],
    messageType: 'discussion_document',
    content: '方案文档已发布。',
    createdAt: '2026-09-20T00:00:00.000Z',
    rawEventId: `event-${sessionId}`,
    payload: {
      documentId: `document-${sessionId}`,
      title: '修改后的方案',
      revision: 2,
      relativePath: `.agent-cluster/discussion-documents/${sessionId}/plan-revision-002.md`,
      contentUrl: `/api/sessions/${sessionId}/discussion-documents/document-${sessionId}/content`,
      contentHash: hash,
      readStatus: 'completed'
    }
  }
}

describe('ChatTimeline discussion document', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    apiGetText.mockReset()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    HTMLElement.prototype.scrollTo = vi.fn()
  })

  it('loads and displays the full Markdown with version, path, URL, hash and read status', async () => {
    apiGetText.mockResolvedValue(markdown)
    const wrapper = mount(ChatTimeline, {
      props: { messages: [message()], sessionId: 'session-1' },
      global: { stubs: { AgentPortrait: true } }
    })
    await flushPromises()
    await vi.waitFor(() => expect(wrapper.find('.discussion-document-content').exists()).toBe(true))

    expect(wrapper.get('.discussion-document-content').text()).toContain('由主 Agent 汇总')
    expect(wrapper.text()).toContain('v2')
    expect(wrapper.text()).toContain('plan-revision-002.md')
    expect(wrapper.text()).toContain('/api/sessions/session-1/discussion-documents/document-session-1/content')
    expect(wrapper.text()).toContain(contentHash)
    expect(wrapper.text()).toContain('已读取')
    expect(wrapper.html()).not.toContain('<script>')
  })

  it('fails closed when the fetched body does not match the published hash', async () => {
    apiGetText.mockResolvedValue('# tampered\n')
    const wrapper = mount(ChatTimeline, {
      props: { messages: [message()], sessionId: 'session-1' },
      global: { stubs: { AgentPortrait: true } }
    })
    await flushPromises()
    await vi.waitFor(() => expect(wrapper.text()).toContain('内容校验失败'))

    expect(wrapper.find('.discussion-document-content').exists()).toBe(false)
    expect(wrapper.text()).toContain('内容校验失败')
  })

  it('renders Markdown HTML as inert text instead of executable DOM', async () => {
    const untrustedMarkdown = '# Plan\n\n<script>globalThis.compromised = true</script>\n'
    const untrustedHash = createHash('sha256').update(untrustedMarkdown).digest('hex')
    apiGetText.mockResolvedValue(untrustedMarkdown)
    const wrapper = mount(ChatTimeline, {
      props: { messages: [message('session-1', untrustedHash)], sessionId: 'session-1' },
      global: { stubs: { AgentPortrait: true } }
    })
    await flushPromises()
    await vi.waitFor(() => expect(wrapper.find('.discussion-document-content').exists()).toBe(true))

    expect(wrapper.find('script').exists()).toBe(false)
    expect(wrapper.get('.discussion-document-content').text()).toContain('<script>')
    expect(wrapper.html()).toContain('&lt;script&gt;')
  })

  it('ignores a late document response after switching sessions', async () => {
    let resolveFirst: ((value: string) => void) | undefined
    apiGetText
      .mockImplementationOnce(() => new Promise<string>((resolve) => { resolveFirst = resolve }))
      .mockResolvedValueOnce(markdown)
    const wrapper = mount(ChatTimeline, {
      props: { messages: [message()], sessionId: 'session-1' },
      global: { stubs: { AgentPortrait: true } }
    })

    await wrapper.setProps({ messages: [message('session-2')], sessionId: 'session-2' })
    await flushPromises()
    resolveFirst?.(markdown)
    await flushPromises()

    expect(wrapper.findAll('.discussion-document-content')).toHaveLength(1)
    expect(wrapper.text()).toContain('session-2')
    expect(wrapper.text()).not.toContain('session-1/plan-revision')
  })
})
