<script setup lang="ts">
import { computed } from 'vue'
import type { RuntimeStopSummary } from '@/types/contracts'

const props = defineProps<{ summary?: RuntimeStopSummary; queryError?: string }>()

const visible = computed(() => Boolean(props.queryError) || Boolean(props.summary && props.summary.status !== 'idle'))
const title = computed(() => {
  if (props.queryError || props.summary?.status === 'unknown') return '停止状态未知'
  if (props.summary?.status === 'confirmed') return '执行已停止'
  return '正在停止执行'
})
const progress = computed(() => `${props.summary?.confirmedCount ?? 0}/${props.summary?.requestedCount ?? 0}`)
</script>

<template>
  <section v-if="visible" class="runtime-stop-state" :class="summary?.status ?? 'unknown'" aria-live="polite">
    <div class="runtime-stop-state__summary">
      <span class="runtime-stop-state__indicator" aria-hidden="true"></span>
      <strong>{{ title }}</strong>
      <span v-if="summary?.requestedCount">{{ progress }}</span>
    </div>
    <p v-if="queryError">无法读取权威停止状态，继续执行已被暂时禁用。</p>
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
.runtime-stop-state.unknown { background: #fef0f0; }
.runtime-stop-state__summary { display: flex; align-items: center; gap: 8px; }
.runtime-stop-state__indicator { width: 8px; height: 8px; border-radius: 50%; background: #e6a23c; }
.runtime-stop-state.confirmed .runtime-stop-state__indicator { background: #67c23a; }
.runtime-stop-state.unknown .runtime-stop-state__indicator { background: #f56c6c; }
.runtime-stop-state p { margin: 4px 0 0 16px; color: #606266; font-size: 13px; }
.runtime-stop-state details { margin: 6px 0 0 16px; font-size: 13px; }
.runtime-stop-state ul { margin: 6px 0 0; padding-left: 18px; }
.runtime-stop-state li { display: flex; justify-content: space-between; gap: 12px; }
.runtime-stop-state code { overflow-wrap: anywhere; }
</style>
