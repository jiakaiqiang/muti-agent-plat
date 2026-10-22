<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElButton } from 'element-plus'
import type { SessionDetail } from '@agent-cluster/shared'
import { useSessionStore } from '@/stores/session'

const props = defineProps<{ session?: SessionDetail }>()
const store = useSessionStore()
const busy = ref<string>()
const error = ref('')
const notice = ref('')
const localStatuses = ref<Record<string, string>>({})
const rows = computed(() => props.session?.intentFollowUps ?? [])
const labels: Record<string, string> = {
  queued: '排队中', blocked: '已阻止', brief: '等待 Brief 确认', ready: '待派发', running: '执行中',
  waiting_budget: '等待预算决定', completed: '已完成', cancelled: '已取消'
}
const canCancel = (status: string) => status === 'queued' || status === 'brief'
const statusFor = (follow: (typeof rows.value)[number]) => localStatuses.value[follow.id] ?? follow.status

async function cancel(follow: (typeof rows.value)[number]) {
  if (!canCancel(follow.status) || busy.value) return
  busy.value = follow.id; error.value = ''; notice.value = ''
  try {
    const result = await store.cancelIntentFollowUp(props.session!.id, follow.id, { expectedRevision: follow.revision, idempotencyKey: `cancel:${follow.id}:${follow.revision}` })
    localStatuses.value = { ...localStatuses.value, [follow.id]: result?.status ?? 'cancelled' }
    notice.value = '追加需求已取消。'
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '取消追加需求失败'
  } finally { busy.value = undefined }
}
</script>

<template>
  <section v-if="rows.length" class="intent-follow-up-status" aria-label="追加需求状态">
    <header><h3>追加需求状态</h3><p>状态来自服务端 FollowUp 记录；取消只对排队中或等待 Brief 确认的条目开放。</p></header>
    <p v-if="error" role="alert">{{ error }}</p><p v-if="notice" role="status">{{ notice }}</p>
    <ul><li v-for="follow in rows" :key="follow.id"><div><strong>{{ labels[statusFor(follow)] ?? statusFor(follow) }}</strong><span>追加需求 {{ follow.id }} · 原消息 {{ follow.sourceEventId }}</span><small v-if="follow.failureCode">原因：{{ follow.failureCode }}</small></div><ElButton v-if="canCancel(statusFor(follow))" size="small" type="danger" :disabled="busy === follow.id || Boolean(busy)" @click="cancel(follow)">取消这条追加需求</ElButton></li></ul>
  </section>
</template>

<style scoped>
.intent-follow-up-status { display: grid; gap: 10px; margin: 0 0 12px; padding: 12px; border: 1px solid var(--el-border-color); border-radius: 8px; }
.intent-follow-up-status h3, .intent-follow-up-status p { margin: 0; }
.intent-follow-up-status header { display: grid; gap: 4px; }
.intent-follow-up-status header p, .intent-follow-up-status small { color: var(--el-text-color-secondary); font-size: 12px; }
.intent-follow-up-status ul { display: grid; gap: 8px; list-style: none; padding: 0; margin: 0; }
.intent-follow-up-status li { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 8px; border-bottom: 1px solid var(--el-border-color-lighter); }
.intent-follow-up-status li > div { display: grid; gap: 3px; min-width: 0; }
.intent-follow-up-status span { overflow-wrap: anywhere; }
</style>
