import { describe, expect, it } from 'vitest'
import { ref } from 'vue'
import { heightIndex, indexAtOffset, useVirtualChatTimeline } from './useVirtualChatTimeline'

describe('dynamic timeline window', () => {
  it('pins an offscreen focused row without mounting all intervening history', () => {
    const items = ref(Array.from({ length: 10000 }, (_, index) => ({ id: String(index) })))
    const model = useVirtualChatTimeline(items)
    model.focusedId.value = '1'
    expect(model.visible.value.some(item => item.id === '1')).toBe(true)
    expect(model.visible.value.length).toBeLessThan(30)
    expect(model.pinnedIndex.value).toBe(1)
  })
  it('locates mixed measured and estimated heights at boundaries', () => {
    const offsets = heightIndex(['a', 'b', 'c'], new Map([['b', 400]]))
    expect(offsets).toEqual([0, 198, 616, 814])
    expect(indexAtOffset(offsets, 197)).toBe(0)
    expect(indexAtOffset(offsets, 198)).toBe(1)
    expect(indexAtOffset(offsets, 999)).toBe(2)
  })
  it.each([174, 332, 1571, 5000, 10000])('bounds mounted rows for %i messages without discarding data', count => {
    const items = ref(Array.from({ length: count }, (_, index) => ({ id: String(index) })))
    const model = useVirtualChatTimeline(items)
    expect(model.visible.value.length).toBeLessThan(30)
    expect(model.visible.value.at(-1)?.id).toBe(String(count - 1))
    model.viewport.value = { top: 198 * 50, height: 600 }
    expect(model.visible.value.length).toBeLessThan(30)
    expect(model.visible.value.some(item => item.id === '50')).toBe(true)
    expect(items.value).toHaveLength(count)
    model.measure([['0', 400]])
    expect(model.offsetFor('50')).toBe(198 * 50 + 220)
    items.value.unshift({ id: 'new' })
    expect(model.offsetFor('50')).toBe(198 * 51 + 220)
  })
})
