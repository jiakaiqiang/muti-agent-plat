<script setup lang="ts">
import { computed, ref, watch } from 'vue'
const props = defineProps<{ content: string }>()
const limit = ref(32_000)
const feedback = ref('')
const shown = computed(() => props.content.slice(0, limit.value))
watch(() => props.content, () => { limit.value = 32_000; feedback.value = '' })
async function copy() {
  try { await navigator.clipboard.writeText(props.content); feedback.value = '已复制完整内容' }
  catch { feedback.value = '复制失败，请展开内容后手动复制。' }
}
</script>
<template>
  <div class="bounded-text">
    <pre>{{ shown }}</pre>
    <button v-if="limit < content.length" type="button" @click="limit += 32_000">继续显示（尚有 {{ content.length - limit }} 个字符）</button>
    <button type="button" @click="copy">复制完整内容</button>
    <span role="status" aria-live="polite">{{ feedback }}</span>
  </div>
</template>
<style scoped>
pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 480px; overflow: auto; }
button { margin: 4px 8px 4px 0; }
button:focus-visible { outline: 2px solid #409eff; outline-offset: 2px; }
</style>
