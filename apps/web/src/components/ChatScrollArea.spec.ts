import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import ChatScrollArea from './ChatScrollArea.vue'

describe('shared chat reading behavior', () => {
  let resize: () => void
  let height: number
  let viewport: number
  const disconnect = vi.fn()
  const wrappers: ReturnType<typeof mount>[] = []
  beforeEach(() => {
    sessionStorage.clear()
    height = 1200
    viewport = 400
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resize = callback }
      observe() {}
      disconnect = disconnect
    })
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => viewport)
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => height)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const top = this.dataset.messageId ? 300 - (this.closest('main')?.scrollTop ?? 0) : 0
      return { top, bottom: top + 100, left: 0, right: 100, width: 100, height: 100, x: 0, y: top, toJSON() {} }
    })
    vi.stubGlobal('scrollTo', vi.fn())
    HTMLElement.prototype.scrollTo = function (options: ScrollToOptions | number) {
      if (typeof options === 'object') this.scrollTop = Math.max(0, Math.min(options.top ?? 0, height - viewport))
    }
  })
  afterEach(() => {
    wrappers.splice(0).forEach(wrapper => wrapper.unmount())
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })
  function setup(key = 'session-a') {
    const wrapper = mount(ChatScrollArea, { props: { readingKey: key, messageCount: 3, status: 'EXECUTING' },
      slots: { default: '<article data-message-id="anchor">message</article>' } })
    wrappers.push(wrapper)
    return wrapper
  }
  async function scrollUp(wrapper: ReturnType<typeof setup>, top = 240) {
    wrapper.get('main').element.scrollTop = top
    await wrapper.get('main').trigger('scroll')
  }
  it('follows appended and same-message streamed content, but preserves upward reading', async () => {
    const wrapper = setup()
    expect(wrapper.get('main').element.scrollTop).toBe(800)
    height = 1500
    resize()
    expect(wrapper.get('main').element.scrollTop).toBe(1100)
    await scrollUp(wrapper)
    height = 1900
    resize()
    await wrapper.setProps({ messageCount: 4 })
    expect(wrapper.get('main').element.scrollTop).toBe(240)
    expect(wrapper.find('.chat-scroll-dots').exists()).toBe(true)
    expect(wrapper.get('button').attributes('aria-label')).toContain('会话正在进行')
    await wrapper.setProps({ status: 'COMPLETED' })
    expect(wrapper.find('.chat-scroll-arrow').exists()).toBe(true)
    await wrapper.get('button').trigger('click')
    expect(wrapper.get('main').element.scrollTop).toBe(1500)
    expect(wrapper.find('button').exists()).toBe(false)
    height = 2100
    resize()
    expect(wrapper.get('main').element.scrollTop).toBe(1700)
  })
  it.each(['PAUSED', 'FAILED', 'CANCELLED', 'WAIT_WORKFLOW_SELECT'] as const)('shows the arrow while %s', async status => {
    const wrapper = setup()
    await scrollUp(wrapper)
    await wrapper.setProps({ status })
    expect(wrapper.find('.chat-scroll-arrow').exists()).toBe(true)
    expect(wrapper.find('.chat-scroll-dots').exists()).toBe(false)
  })
  it('does not claim ongoing execution when disconnected', async () => {
    const wrapper = setup()
    await scrollUp(wrapper)
    await wrapper.setProps({ disconnected: true })
    expect(wrapper.find('.chat-scroll-arrow').exists()).toBe(true)
  })
  it('isolates session positions and restores the saved message anchor', async () => {
    const wrapper = setup()
    await scrollUp(wrapper)
    await wrapper.setProps({ readingKey: 'session-b' })
    await nextTick()
    expect(wrapper.get('main').element.scrollTop).toBe(800)
    await wrapper.setProps({ readingKey: 'session-a' })
    await nextTick()
    expect(wrapper.get('main').element.scrollTop).toBe(240)
  })
  it('waits for visibility and messages before restoring, and releases the observer', async () => {
    viewport = 0
    const wrapper = setup()
    expect(wrapper.get('main').element.scrollTop).toBe(0)
    viewport = 400
    resize()
    expect(wrapper.get('main').element.scrollTop).toBe(800)
    await wrapper.setProps({ readingKey: 'saved', messageCount: 0 })
    sessionStorage.setItem('saved', JSON.stringify({ top: 100, following: false }))
    await wrapper.setProps({ messageCount: 10 })
    expect(wrapper.get('main').element.scrollTop).toBe(100)
    wrapper.unmount()
    expect(disconnect).toHaveBeenCalled()
  })
})
