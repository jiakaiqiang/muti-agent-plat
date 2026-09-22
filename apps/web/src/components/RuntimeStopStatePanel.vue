<script setup lang="ts">
import { computed } from 'vue'
import type { RuntimeStopSummary } from '@/types/contracts'
import UiIcon from './UiIcon.vue'

const props = withDefaults(defineProps<{
  summary?: RuntimeStopSummary
  queryError?: string
  retrying?: boolean
}>(), {
  retrying: false
})
const emit = defineEmits<{ retry: [] }>()

const visible = computed(() => Boolean(props.queryError) || Boolean(props.summary && props.summary.status !== 'idle'))
const title = computed(() => {
  if (props.queryError) return '停止状态查询失败'
  if (props.summary?.status === 'unknown') return '停止状态未知'
  if (props.summary?.status === 'confirmed') return '执行已停止'
  return '正在停止执行'
})
const progress = computed(() => `${props.summary?.confirmedCount ?? 0}/${props.summary?.requestedCount ?? 0}`)
const stateClass = computed(() => props.queryError ? 'query-error' : props.summary?.status ?? 'unknown')
</script>

<template>
  <section v-if="visible" class="runtime-stop-state" :class="stateClass" aria-live="polite">
    <div class="runtime-stop-state__summary">
      <span class="runtime-stop-state__indicator" aria-hidden="true"></span>
      <strong>{{ title }}</strong>
      <span v-if="summary?.requestedCount">{{ progress }}</span>
      <button v-if="queryError" type="button" :disabled="retrying" @click="emit('retry')">
        <UiIcon name="refresh-cw" :size="14" />
        {{ retrying ? '检测中' : '重新检测' }}
      </button>
    </div>
    <p v-if="queryError">暂时无法确认停止状态，系统将自动重试。当前任务是否正在执行请以上方阶段状态为准。</p>
    <p v-else-if="summary?.blockers[0]">{{ summary.blockers[0].message }}</p>
    <details v-if="summary && summary.targets.length > 1">
      <summary>查看停止目标</summary>
      <ul>
        <li v-for="target in summary.targets" :key="target.invocationId">
          <code>{{ target.invocationId }}</code>
          <span>{{ target.state === 'confirmed' ? '已确认' : target.state === 'pending_sync' ? '待同步' : target.state === 'unknown' ? '状态未知' : '等待结束' }}</span>
        </li>
      </ul>
    </details>
  </section>
</template>

<style scoped>
.runtime-stop-state {
  flex: none;
  padding: 10px 16px;
  border-top: 1px solid var(--border-color, #dcdfe6);
  border-bottom: 1px solid var(--border-color, #dcdfe6);
  background: #f4f4f5;
  color: #303133;
}
.runtime-stop-state.waiting,
.runtime-stop-state.requested { background: #fdf6ec; }
.runtime-stop-state.confirmed { background: #f0f9eb; }
.runtime-stop-state.unknown,
.runtime-stop-state.query-error { background: #fef0f0; }
.runtime-stop-state__summary { display: flex; align-items: center; gap: 8px; }
.runtime-stop-state__summary strong { min-width: 0; }
.runtime-stop-state__summary button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 28px;
  margin-left: auto;
  padding: 3px 8px;
  border: 1px solid #f56c6c;
  border-radius: 4px;
  background: #fff;
  color: #c45656;
  cursor: pointer;
  font: inherit;
  font-size: 12px;
}
.runtime-stop-state__summary button:disabled { cursor: wait; opacity: 0.65; }
.runtime-stop-state__summary button:focus-visible { outline: 2px solid #409eff; outline-offset: 2px; }
.runtime-stop-state__indicator { width: 8px; height: 8px; border-radius: 50%; background: #e6a23c; }
.runtime-stop-state.confirmed .runtime-stop-state__indicator { background: #67c23a; }
.runtime-stop-state.unknown .runtime-stop-state__indicator,
.runtime-stop-state.query-error .runtime-stop-state__indicator { background: #f56c6c; }
.runtime-stop-state p { margin: 4px 0 0 16px; color: #606266; font-size: 13px; }
.runtime-stop-state details { margin: 6px 0 0 16px; font-size: 13px; }
.runtime-stop-state ul { margin: 6px 0 0; padding-left: 18px; }
.runtime-stop-state li { display: flex; justify-content: space-between; gap: 12px; }
.runtime-stop-state code { overflow-wrap: anywhere; }
</style>
