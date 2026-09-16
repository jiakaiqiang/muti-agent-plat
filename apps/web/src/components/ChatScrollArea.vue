<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, onUpdated, ref, watch } from 'vue'
import type { SessionStatus } from '@/types/contracts'

const props = defineProps<{
  readingKey: string
  messageCount: number
  status?: SessionStatus
  disconnected?: boolean
}>()
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

function anchorTop(item: HTMLElement, el: HTMLElement) {
  return item.getBoundingClientRect().top - el.getBoundingClientRect().top - el.clientTop + el.scrollTop
}

function measure() {
  const el = element.value
  if (el?.clientHeight) away.value = el.scrollHeight - el.scrollTop - el.clientHeight > 16
}

function savePosition() {
  const el = element.value
  if (!el?.clientHeight || !props.readingKey || !props.messageCount || restoredKey !== props.readingKey) return
  const anchor = Array.from(el.querySelectorAll<HTMLElement>('[data-message-id]'))
    .find(item => anchorTop(item, el) + item.offsetHeight >= el.scrollTop)
  try {
    sessionStorage.setItem(props.readingKey, JSON.stringify({ top: el.scrollTop, following: following.value,
      messageId: anchor?.dataset.messageId, offset: anchor ? el.scrollTop - anchorTop(anchor, el) : 0 }))
  } catch { /* Reading remains available when storage is disabled. */ }
}

function onScroll() {
  const el = element.value
  if (!el?.clientHeight) return
  // Growing content can also produce scroll events. Only upward movement opts out of following.
  if (el.scrollTop < lastTop - 1) following.value = false
  measure()
  if (!away.value) following.value = true
  lastTop = el.scrollTop
  savePosition()
}

function restoreReadingPosition() {
  const el = element.value
  if (!el?.clientHeight || !props.messageCount || restoredKey === props.readingKey) return false
  restoredKey = props.readingKey
  try {
    const saved = JSON.parse(sessionStorage.getItem(props.readingKey) ?? 'null')
    if (saved && Number.isFinite(saved.top) && typeof saved.following === 'boolean') {
      following.value = saved.following
      const anchor = Array.from(el.querySelectorAll<HTMLElement>('[data-message-id]'))
        .find(item => item.dataset.messageId === saved.messageId)
      el.scrollTo({ top: saved.following ? el.scrollHeight : anchor && Number.isFinite(saved.offset)
        ? anchorTop(anchor, el) + saved.offset : saved.top, behavior: 'instant' })
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
  if (following.value) el.scrollTo({ top: el.scrollHeight, behavior: 'instant' })
  lastTop = el.scrollTop
  measure()
  savePosition()
}

function jumpToLatest() {
  following.value = true
  sync()
}

watch(() => props.readingKey, () => {
  restoredKey = undefined
  following.value = true
  away.value = false
  lastTop = 0
  void nextTick(sync)
})
onMounted(() => {
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(sync)
    if (element.value) observer.observe(element.value)
    if (content.value) observer.observe(content.value)
  }
  sync()
})
onUpdated(sync)
onBeforeUnmount(() => {
  savePosition()
  disposed = true
  observer?.disconnect()
})
defineExpose({ element, restoreReadingPosition })
</script>

<template>
  <div class="chat-timeline-shell">
    <main ref="element" class="chat-timeline" @scroll.passive="onScroll">
      <div ref="content" class="chat-timeline-content"><slot /></div>
    </main>
    <button v-if="away" type="button" class="chat-scroll-latest" :aria-label="label" :title="label" @click="jumpToLatest">
      <span v-if="running" class="chat-scroll-dots" aria-hidden="true"><i /><i /><i /></span>
      <svg v-else class="chat-scroll-arrow" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v16m-6-6 6 6 6-6" /></svg>
    </button>
  </div>
</template>

<style scoped>
.chat-timeline-shell { position: relative; display: grid; grid-template-rows: minmax(0, 1fr); min-width: 0; min-height: 0; overflow: hidden; flex: 1; }
.chat-timeline-content { display: flex; flex-direction: column; gap: 18px; min-width: 0; flex-shrink: 0; }
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
