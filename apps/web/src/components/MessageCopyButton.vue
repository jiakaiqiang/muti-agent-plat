<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import { ElButton } from 'element-plus'
import { Check, CopyDocument, Warning } from '@element-plus/icons-vue'

const props = defineProps<{ content: string }>()
const feedback = ref('')
const copying = ref(false)
let resetTimer: ReturnType<typeof setTimeout> | undefined
let disposed = false

onBeforeUnmount(() => {
  disposed = true
  clearTimeout(resetTimer)
})

async function copy() {
  if (copying.value) return
  copying.value = true
  feedback.value = ''
  clearTimeout(resetTimer)
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(props.content)
    } else {
      // Clipboard API is unavailable on some HTTP LAN installations.
      const focused = document.activeElement as HTMLElement | null
      const selection = window.getSelection()
      const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : []
      const textarea = document.createElement('textarea')
      textarea.value = props.content
      textarea.readOnly = true
      textarea.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0'
      document.body.appendChild(textarea)
      try {
        textarea.select()
        if (!document.execCommand('copy')) throw new Error('Copy failed')
      } finally {
        textarea.remove()
        focused?.focus({ preventScroll: true })
        selection?.removeAllRanges()
        ranges.forEach(range => selection?.addRange(range))
      }
    }
    if (!disposed) {
      feedback.value = '已复制'
      resetTimer = setTimeout(() => { feedback.value = '' }, 2000)
    }
  } catch {
    if (!disposed) feedback.value = '复制失败，请手动选择正文复制'
  } finally {
    copying.value = false
  }
}
</script>

<template>
  <span class="message-copy">
    <ElButton
      class="message-copy__button"
      text
      size="small"
      :icon="feedback === '已复制' ? Check : feedback ? Warning : CopyDocument"
      :loading="copying"
      :disabled="!content"
      aria-label="复制消息"
      :title="feedback || '复制消息正文'"
      @click.stop="copy"
    />
    <span class="message-copy__feedback" role="status" aria-live="polite">{{ feedback }}</span>
  </span>
</template>

<style scoped>
.message-copy { display: flex; align-items: center; margin-top: 8px; }
.message-copy__button { width: 28px; height: 28px; padding: 0; }
.message-copy__button:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 2px; }
.message-copy__feedback { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
</style>
