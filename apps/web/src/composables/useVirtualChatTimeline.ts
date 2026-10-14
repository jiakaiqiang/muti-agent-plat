import { computed, shallowRef, type Ref } from 'vue'

export function heightIndex(ids: readonly string[], heights: ReadonlyMap<string, number>, estimate = 180, gap = 18) {
  const offsets = [0]
  for (const id of ids) offsets.push(offsets[offsets.length - 1] + (heights.get(id) ?? estimate) + gap)
  return offsets
}

export function indexAtOffset(offsets: readonly number[], top: number) {
  let low = 0
  let high = Math.max(0, offsets.length - 2)
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (offsets[middle] <= top) low = middle
    else high = middle - 1
  }
  return low
}

/** Geometry is keyed by stable message identity, never by its current array index. */
export function useVirtualChatTimeline<T extends { id: string }>(items: Ref<T[]>) {
  const heights = shallowRef(new Map<string, number>())
  const viewport = shallowRef({ top: Number.MAX_SAFE_INTEGER, height: 800 })
  const focusedId = shallowRef('')
  const offsets = computed(() => heightIndex(items.value.map(item => item.id), heights.value))
  const range = computed(() => {
    const length = items.value.length
    if (length < 80) return { start: 0, end: length }
    const total = offsets.value[length]
    const height = Math.max(400, viewport.value.height)
    const top = Math.min(viewport.value.top, Math.max(0, total - height))
    const start = indexAtOffset(offsets.value, Math.max(0, top - height))
    const end = Math.min(length, indexAtOffset(offsets.value, top + height * 2) + 1)
    return { start, end }
  })
  const pinnedIndex = computed(() => {
    const index = focusedId.value ? items.value.findIndex(item => item.id === focusedId.value) : -1
    return index >= 0 && (index < range.value.start || index >= range.value.end) ? index : -1
  })
  const visible = computed(() => {
    const rows = items.value.slice(range.value.start, range.value.end)
    if (pinnedIndex.value >= 0) {
      const item = items.value[pinnedIndex.value]
      if (pinnedIndex.value < range.value.start) rows.unshift(item)
      else rows.push(item)
    }
    return rows
  })
  const padding = computed(() => ({
    paddingTop: `${offsets.value[range.value.start]}px`,
    paddingBottom: `${Math.max(0, offsets.value[items.value.length] - offsets.value[range.value.end])}px`
  }))
  function measure(entries: readonly [string, number][]) {
    let changed = false
    const next = new Map(heights.value)
    for (const [id, height] of entries) {
      if (height > 0 && Math.abs((next.get(id) ?? 180) - height) > 1) { next.set(id, height); changed = true }
    }
    if (changed) heights.value = next
    return changed
  }
  function reset() {
    heights.value = new Map()
    focusedId.value = ''
    viewport.value = { top: Number.MAX_SAFE_INTEGER, height: 800 }
  }
  function offsetFor(id: string) {
    const index = items.value.findIndex(item => item.id === id)
    return index < 0 ? undefined : offsets.value[index]
  }
  return { visible, padding, offsets, viewport, focusedId, pinnedIndex, range, measure, reset, offsetFor }
}
