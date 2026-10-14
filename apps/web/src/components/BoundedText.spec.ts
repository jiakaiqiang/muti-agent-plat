import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import BoundedText from './BoundedText.vue'
describe('large text rendering', () => {
  it('bounds initial rendering while copying the complete source', async () => {
    const content = '中'.repeat(100000)
    const copy = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText: copy } })
    const wrapper = mount(BoundedText, { props: { content } })
    expect(wrapper.get('pre').text()).toHaveLength(32000)
    await wrapper.findAll('button')[1].trigger('click')
    expect(copy).toHaveBeenCalledWith(content)
    await wrapper.findAll('button')[0].trigger('click')
    expect(wrapper.get('pre').text()).toHaveLength(64000)
    wrapper.unmount(); vi.unstubAllGlobals()
  })
})
