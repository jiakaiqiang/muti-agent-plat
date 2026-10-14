<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { SessionStatus } from '@/types/contracts'
import type { ChatMessage } from '@/types/contracts'
import { useVirtualChatTimeline } from '@/composables/useVirtualChatTimeline'
import type { CSSProperties } from 'vue'

const props = defineProps<{
  readingKey: string
  messageCount: number
  status?: SessionStatus
  disconnected?: boolean
  messages?: ChatMessage[]
}>()
const windowModel = useVirtualChatTimeline(computed(() => props.messages ?? []))
const visibleMessages = windowModel.visible
const virtualPadding = windowModel.padding
function messageStyle(id: string): CSSProperties | undefined {
  return windowModel.pinnedIndex.value >= 0 && id === windowModel.focusedId.value
    ? { position: 'absolute', top: `${windowModel.offsetFor(id)}px`, left: 0, right: 0 } : undefined
}
const emit = defineEmits<{ visible: [messages: ChatMessage[]] }>()
watch(visibleMessages, messages => emit('visible', messages), { immediate: true })
const element = ref<HTMLElement | null>(null)
const content = ref<HTMLElement | null>(null)
const following = ref(true)
const away = ref(false)
const running = computed(() => !props.disconnected && Boolean(props.status && [
  'AGENT_DISCUSSING', 'REVISING_BRIEF', 'EXECUTING', 'POST_REVIEW', 'REWORKING', 'APPLYING_CHANGES'
].includes(props.status)))
const label = computed(() => running.value ? '会话正在进行，点击回到最新消息' : '回到最新消息')
let observer: ResizeObserver | undefined
let restoredKey: string | undefined
let lastTop = 0
let disposed = false
let frame: number | undefined
let saveTimer: ReturnType<typeof setTimeout> | undefined
let pendingAnchor: { id: string; offset: number } | undefined
let rowObserver: ResizeObserver | undefined
const observedRows = new Set<Element>()

function observeRows() {
  const rows = new Set(content.value?.querySelectorAll<HTMLElement>('[data-message-id]') ?? [])
  for (const row of observedRows) if (!rows.has(row as HTMLElement)) { rowObserver?.unobserve(row); observedRows.delete(row) }
  for (const row of rows) if (!observedRows.has(row)) { rowObserver?.observe(row); observedRows.add(row) }
}
watch(visibleMessages, () => { void nextTick(observeRows) }, { flush: 'post' })

function updateViewport() {
  if (element.value) windowModel.viewport.value = { top: element.value.scrollTop, height: element.value.clientHeight }
}

function onFocus(event: FocusEvent) {
  windowModel.focusedId.value = (event.target as HTMLElement).closest<HTMLElement>('[data-message-id]')?.dataset.messageId ?? ''
}
function onBlur() {
  void nextTick(() => {
    if (!content.value?.contains(document.activeElement)) windowModel.focusedId.value = ''
  })
}
function beginReadingInteraction() { pendingAnchor = undefined }

function anchorTop(item: HTMLElement, el: HTMLElement) {
  return item.getBoundingClientRect().top - el.getBoundingClientRect().top - el.clientTop + el.scrollTop
}

function measure() {
  const el = element.value
  if (el?.clientHeight) away.value = el.scrollHeight - el.scrollTop - el.clientHeight > 16
}

function savePosition(key = props.readingKey) {
  const el = element.value
  if (!el?.clientHeight || !key || restoredKey !== key) return
  // Following the tail requires no message geometry reads.
  let anchor: HTMLElement | undefined
  if (!following.value) {
    const items = el.querySelectorAll<HTMLElement>('[data-message-id]')
    let low = 0
    let high = items.length - 1
    while (low <= high) {
      const middle = (low + high) >>> 1
      const item = items[middle]
      if (anchorTop(item, el) + item.offsetHeight >= el.scrollTop) { anchor = item; high = middle - 1 }
      else low = middle + 1
    }
  }
  try {
    sessionStorage.setItem(key, JSON.stringify({ top: el.scrollTop, following: following.value,
      messageId: anchor?.dataset.messageId, offset: anchor ? el.scrollTop - anchorTop(anchor, el) : 0 }))
  } catch { /* Reading remains available when storage is disabled. */ }
}

function scheduleSave() {
  if (saveTimer) return
  const key = props.readingKey
  saveTimer = setTimeout(() => {
    saveTimer = undefined
    if (!disposed && props.readingKey === key) savePosition(key)
  }, 200)
}

function scheduleSync() {
  if (disposed || frame !== undefined) return
  const key = props.readingKey
  frame = requestAnimationFrame(() => {
    frame = undefined
    if (!disposed && key === props.readingKey) sync()
  })
}

function onScroll() {
  const el = element.value
  if (!el?.clientHeight) return
  // Growing content can also produce scroll events. Only upward movement opts out of following.
  if (el.scrollTop < lastTop - 1) following.value = false
  measure()
  if (!away.value) following.value = true
  lastTop = el.scrollTop
  updateViewport()
  scheduleSave()
}

function restoreReadingPosition() {
  const el = element.value
  if (!el?.clientHeight || !props.messageCount || restoredKey === props.readingKey) return false
  restoredKey = props.readingKey
  try {
    const saved = JSON.parse(sessionStorage.getItem(props.readingKey) ?? 'null')
    if (saved && Number.isFinite(saved.top) && typeof saved.following === 'boolean') {
      following.value = saved.following
      if (!saved.following && saved.messageId && Number.isFinite(saved.offset)) pendingAnchor = { id: saved.messageId, offset: saved.offset }
      const anchor = Array.from(el.querySelectorAll<HTMLElement>('[data-message-id]'))
        .find(item => item.dataset.messageId === saved.messageId)
      const virtualTop = saved.messageId ? windowModel.offsetFor(saved.messageId) : undefined
      el.scrollTo({ top: saved.following ? el.scrollHeight : anchor && Number.isFinite(saved.offset)
        ? anchorTop(anchor, el) + saved.offset : virtualTop !== undefined && Number.isFinite(saved.offset)
          ? virtualTop + saved.offset : saved.top, behavior: 'instant' })
      lastTop = el.scrollTop
      measure()
      return true
    }
  } catch { /* Ignore obsolete reading positions. */ }
  return false
}

function sync() {
  const el = element.value
  if (disposed || !el?.clientHeight) return
  restoreReadingPosition()
  if (!following.value && pendingAnchor) {
    const anchor = Array.from(el.querySelectorAll<HTMLElement>('[data-message-id]')).find(item => item.dataset.messageId === pendingAnchor?.id)
    if (anchor) {
      el.scrollTop = anchorTop(anchor, el) + pendingAnchor.offset
    }
  }
  if (following.value && el.scrollHeight - el.scrollTop - el.clientHeight > 1) el.scrollTo({ top: el.scrollHeight, behavior: 'instant' })
  lastTop = el.scrollTop
  updateViewport()
  measure()
  scheduleSave()
}

function jumpToLatest() {
  pendingAnchor = undefined
  following.value = true
  sync()
}

watch(() => props.readingKey, (_, previous) => {
  savePosition(previous)
  clearTimeout(saveTimer)
  saveTimer = undefined
  if (frame !== undefined) cancelAnimationFrame(frame)
  frame = undefined
  windowModel.reset()
  pendingAnchor = undefined
  restoredKey = undefined
  following.value = true
  away.value = false
  lastTop = 0
  void nextTick(scheduleSync)
}, { flush: 'pre' })
watch(() => props.messageCount, scheduleSync, { flush: 'post' })
onMounted(() => {
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(scheduleSync)
    if (element.value) observer.observe(element.value)
    if (content.value) observer.observe(content.value)
    if (props.messages) rowObserver = new ResizeObserver(entries => {
      const el = element.value
      if (!el) return
      const key = props.readingKey
      const anchor = !following.value ? Array.from(content.value?.querySelectorAll<HTMLElement>('[data-message-id]') ?? [])
        .find(row => row.getBoundingClientRect().bottom >= el.getBoundingClientRect().top) : undefined
      const offset = anchor ? el.scrollTop - anchorTop(anchor, el) : 0
      const changed = windowModel.measure(entries.filter(entry => content.value?.contains(entry.target)).map(entry => [(entry.target as HTMLElement).dataset.messageId ?? '', entry.target.getBoundingClientRect().height]))
      if (changed) {
        void nextTick(() => {
          if (disposed || props.readingKey !== key) return
          if (!following.value && !pendingAnchor && anchor?.isConnected) el.scrollTop = anchorTop(anchor, el) + offset
          scheduleSync()
        })
      }
    })
    observeRows()
  }
  sync()
})
onBeforeUnmount(() => {
  savePosition()
  disposed = true
  clearTimeout(saveTimer)
  if (frame !== undefined) cancelAnimationFrame(frame)
  observer?.disconnect()
  rowObserver?.disconnect()
  observedRows.clear()
})
async function scrollToMessage(id: string) {
  const top = windowModel.offsetFor(id)
  if (top === undefined || !element.value) return
  following.value = false
  element.value.scrollTo({ top, behavior: 'instant' })
  updateViewport()
  await nextTick()
}
defineExpose({ element, restoreReadingPosition, scrollToMessage })
</script>

<template>
  <div class="chat-timeline-shell">
    <main ref="element" class="chat-timeline" @scroll.passive="onScroll" @wheel.passive="beginReadingInteraction" @touchstart.passive="beginReadingInteraction" @pointerdown="beginReadingInteraction" @keydown="beginReadingInteraction">
      <div ref="content" class="chat-timeline-content" :style="messages ? virtualPadding : undefined" @focusin="onFocus" @focusout="onBlur"><slot :visible-messages="visibleMessages" :message-style="messageStyle" /></div>
    </main>
    <button v-if="away" type="button" class="chat-scroll-latest" :aria-label="label" :title="label" @click="jumpToLatest">
      <span v-if="running" class="chat-scroll-dots" aria-hidden="true"><i /><i /><i /></span>
      <svg v-else class="chat-scroll-arrow" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v16m-6-6 6 6 6-6" /></svg>
    </button>
  </div>
</template>

<style scoped>
.chat-timeline-shell { position: relative; display: grid; grid-template-rows: minmax(0, 1fr); min-width: 0; min-height: 0; overflow: hidden; flex: 1; }
.chat-timeline-content { position: relative; display: flex; flex-direction: column; gap: 18px; min-width: 0; flex-shrink: 0; overflow-anchor: none; }
.chat-scroll-latest { position: absolute; bottom: 12px; left: 50%; transform: translateX(-50%); display: grid; place-items: center; width: 44px; height: 44px; border: 1px solid #d6dbe2; border-radius: 50%; background: #fff; color: #414b59; box-shadow: 0 2px 8px #17212e1a; cursor: pointer; z-index: 2; }
.chat-scroll-latest:hover { background: #f2f4f7; }
.chat-scroll-latest:focus-visible { outline: 2px solid #409eff; outline-offset: 3px; }
.chat-scroll-dots { display: flex; gap: 4px; }
.chat-scroll-dots i { width: 4px; height: 4px; border-radius: 50%; background: currentColor; animation: chat-scroll-pulse 1.4s ease-in-out infinite; }
.chat-scroll-dots i:nth-child(2) { animation-delay: .18s; }
.chat-scroll-dots i:nth-child(3) { animation-delay: .36s; }
@keyframes chat-scroll-pulse { 0%, 80%, 100% { opacity: .3; } 40% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .chat-scroll-dots i { animation: none; } }
</style>
