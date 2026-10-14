<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { ElButton, ElConfigProvider, ElDialog, ElPagination } from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import { defaultAgents, runtimeHealthLabel } from '@agent-cluster/shared'
import { useRuntimeRequestHealthStore } from '@/stores/runtimeRequestHealth'
import { useEventStore } from '@/stores/event'
import { useAgentStore } from '@/stores/agent'
import { runtimeTypeLabel } from '@/utils/runtimeLabels'
import { runtimeHealthDetails, runtimeHealthExplanation, runtimeMessages, runtimePhaseLabel, runtimeTimeLabel } from '@/utils/runtimeHealthPresentation'

const props = defineProps<{ sessionId: string; stopBusy?: boolean; canStop?: boolean }>()
const emit = defineEmits<{ stop: [] }>()
const health = useRuntimeRequestHealthStore()
const events = useEventStore()
const agents = useAgentStore()
const allItems = computed(() => health.items(props.sessionId))
const items = computed(() => allItems.value.filter(item => !item.historical && item.stage !== 'terminal'))
const messagesOpen = ref(false)
const page = ref(1)
const pageSize = 20
const messages = computed(() => runtimeMessages(props.sessionId, events.eventsForSession(props.sessionId), allItems.value))
const visibleMessages = computed(() => messages.value.slice((page.value - 1) * pageSize, page.value * pageSize))
const agentName = (id?: string, name?: string) => agents.agents.find(agent => agent.id === id)?.name
  ?? defaultAgents.find(agent => agent.id === id)?.name ?? name ?? '智能体'
const observedNow = ref(Date.now())
const queryReady = ref(false)
const elapsed = (startedAt: string) => {
  const minutes = Math.max(0, Math.floor((observedNow.value - Date.parse(startedAt)) / 60000))
  return Number.isFinite(minutes) ? minutes < 1 ? '不到 1 分钟' : `${minutes} 分钟` : '时长未知'
}
let timer: ReturnType<typeof setTimeout> | undefined
let controller: AbortController | undefined
watch(() => props.sessionId, sessionId => {
  messagesOpen.value = false
  page.value = 1
  queryReady.value = false
  clearTimeout(timer)
  controller?.abort()
  controller = new AbortController()
  const signal = controller.signal
  if (!sessionId) return
  const poll = async () => {
    await health.load(sessionId, signal)
    if (signal.aborted) return
    queryReady.value = true
    observedNow.value = Date.now()
    if (!signal.aborted) timer = setTimeout(poll, 5000)
  }
  void poll()
}, { immediate: true })
watch(() => events.eventsForSession(props.sessionId), list => {
  for (const event of list) {
    const payload = event.metadata?.payload
    if (payload?.code === 'RUNTIME_REQUEST_HEALTH_CHANGED') health.merge(props.sessionId, payload.healthSnapshot)
  }
}, { immediate: true })
onBeforeUnmount(() => { clearTimeout(timer); controller?.abort() })
const actionKey = (id: string) => `${props.sessionId}:${id}`
watch(() => messages.value.length, count => { page.value = Math.min(page.value, Math.max(1, Math.ceil(count / pageSize))) })
</script>

<template>
  <ElConfigProvider :locale="zhCn">
  <section v-if="sessionId" class="runtime-request-health" aria-label="模型调用状态">
    <div class="runtime-request-health-toolbar">
      <span>{{ health.queryErrors[sessionId] ? '模型调用状态暂不可用' : items.length ? `当前 ${items.length} 个调用` : queryReady ? '暂无进行中的模型调用' : '正在读取模型调用状态…' }}</span>
      <ElButton size="small" aria-haspopup="dialog" @click="messagesOpen = true; page = 1">Runtime 消息</ElButton>
    </div>
    <p v-if="health.queryErrors[sessionId]" role="status">{{ health.queryErrors[sessionId] }}</p>
    <article v-for="item in items" :key="item.invocationId" class="runtime-request-health-item">
      <div>
        <strong role="status">{{ runtimeHealthLabel(item) }}</strong>
        <small>{{ agentName(item.agentId) }} · {{ runtimePhaseLabel(item.phase) }} · {{ runtimeTypeLabel(item.runtimeType) }} · 已等待 {{ elapsed(item.startedAt) }}</small>
        <p v-if="item.stage === 'unknown_wait'">暂未收到新的执行进展，无法确认模型状态。原调用保留；继续等待不会重发请求或重置预算。</p>
        <p v-if="item.health === 'abnormal' || item.budgetFallbackReason">{{ runtimeHealthExplanation(item) }}</p>
        <p v-if="item.pendingSync" role="status">观测记录待同步，不代表模型失败。</p>
        <p v-if="item.lastWaitAcknowledgedAt && item.stage === 'unknown_wait'">已确认继续等待。</p>
        <p v-if="health.actionErrors[actionKey(item.invocationId)]" role="alert">{{ health.actionErrors[actionKey(item.invocationId)] }}</p>
      </div>
      <div v-if="!item.historical" class="runtime-request-health-actions">
        <ElButton v-if="item.canWait" size="small" :disabled="health.waiting[actionKey(item.invocationId)] || stopBusy" @click="health.wait(sessionId, item)">
          {{ health.waiting[actionKey(item.invocationId)] ? '确认中…' : '继续等待' }}
        </ElButton>
        <ElButton v-if="item.canStop" size="small" :disabled="!canStop || stopBusy" @click="emit('stop')">停止会话全部调用</ElButton>
      </div>
    </article>
  </section>
  <ElDialog v-model="messagesOpen" title="Runtime 消息" width="min(780px, 94vw)" append-to-body destroy-on-close>
    <div class="runtime-messages-body">
      <p class="runtime-messages-intro">Runtime 是负责请求模型、执行工具并回传结果的运行环境。这里展示本群聊已收到的消息，不包含模型隐藏思考、凭据或原始调试数据。</p>
      <p v-if="health.queryErrors[sessionId]" role="status">{{ health.queryErrors[sessionId] }}</p>
      <section v-if="items.length" aria-label="当前调用状态">
        <h3>当前调用状态</h3>
        <article v-for="item in items" :key="item.invocationId" class="runtime-call-detail">
          <h4>{{ agentName(item.agentId) }} · {{ runtimePhaseLabel(item.phase) }} · {{ runtimeTypeLabel(item.runtimeType) }}</h4>
          <p><strong>{{ runtimeHealthLabel(item) }}</strong> · 已等待 {{ elapsed(item.startedAt) }}</p>
          <p>{{ runtimeHealthExplanation(item) }}</p>
          <details>
            <summary>查看运行程序和模型请求状态</summary>
            <dl class="runtime-health-fields">
              <div v-for="field in runtimeHealthDetails(item)" :key="field.label">
                <dt>{{ field.label }}</dt>
                <dd><strong>{{ field.value }}</strong><span>{{ field.help }}</span></dd>
              </div>
            </dl>
          </details>
          <details class="runtime-message-diagnostics">
            <summary>排查信息（内部编号）</summary>
            <p>调用编号：{{ item.invocationId }}。用于定位本次请求，不是错误码。</p>
            <p>观测规则版本：{{ item.policyVersion }}。用于识别状态判断规则，不是预算或超时限制。</p>
          </details>
        </article>
      </section>
      <section aria-label="Runtime 消息记录">
        <h3>消息记录 <small>共 {{ messages.length }} 条，最新在前</small></h3>
        <p v-if="!messages.length" role="status">暂无 Runtime 消息。发起模型调用后，已收到的记录会显示在这里。</p>
        <ol v-else class="runtime-message-list">
          <li v-for="message in visibleMessages" :key="message.id">
            <div class="runtime-message-heading"><strong>{{ message.title }}</strong><time>{{ runtimeTimeLabel(message.createdAt) }}</time></div>
            <small>{{ agentName(message.agentId, message.agentName) }}<template v-if="message.phase"> · {{ runtimePhaseLabel(message.phase) }}</template></small>
            <p class="runtime-message-content">{{ message.content }}</p>
            <details v-if="message.snapshot">
              <summary>查看这条消息的状态说明</summary>
              <dl class="runtime-health-fields">
                <div v-for="field in runtimeHealthDetails(message.snapshot)" :key="field.label">
                  <dt>{{ field.label }}</dt><dd><strong>{{ field.value }}</strong><span>{{ field.help }}</span></dd>
                </div>
              </dl>
            </details>
          </li>
        </ol>
      </section>
    </div>
    <template #footer>
      <div class="runtime-messages-footer">
        <ElPagination v-if="messages.length > pageSize" v-model:current-page="page" :page-size="pageSize" :total="messages.length" :pager-count="5" layout="prev, pager, next" size="small" />
        <ElButton @click="messagesOpen = false">关闭</ElButton>
      </div>
    </template>
  </ElDialog>
  </ElConfigProvider>
</template>

<style scoped>
.runtime-request-health { padding: 8px 16px; border-bottom: 1px solid var(--el-border-color, #dcdfe6); background: var(--el-bg-color-page, #f5f7fa); max-height: 30vh; overflow: auto; color: var(--el-text-color-primary, #303133); }
.runtime-request-health-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: 13px; color: var(--el-text-color-regular, #606266); }
.runtime-request-health-item { display: flex; justify-content: space-between; gap: 12px; padding: 6px 0; }
small { display: block; color: var(--el-text-color-regular, #606266); overflow-wrap: anywhere; margin-top: 4px; }
p { margin: 4px 0; font-size: 13px; }
.runtime-request-health-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; flex-shrink: 0; }
.runtime-messages-body { max-height: 62vh; overflow-y: auto; overflow-wrap: anywhere; color: var(--el-text-color-primary, #303133); }
.runtime-messages-intro { margin-top: 0; color: var(--el-text-color-regular, #606266); line-height: 1.6; }
h3 { margin: 20px 0 12px; font-size: 16px; }
h3 small { display: inline; font-size: 12px; font-weight: 400; }
h4 { margin: 0 0 8px; font-size: 14px; }
.runtime-call-detail { padding: 12px 0; border-bottom: 1px solid var(--el-border-color-lighter, #ebeef5); }
.runtime-health-fields { margin: 12px 0; font-size: 13px; }
.runtime-health-fields > div { display: grid; grid-template-columns: 126px minmax(0, 1fr); gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--el-border-color-lighter, #ebeef5); }
dt { color: var(--el-text-color-regular, #606266); }
dd { margin: 0; }
dd span { display: block; margin-top: 4px; color: var(--el-text-color-regular, #606266); line-height: 1.5; }
summary { cursor: pointer; font-size: 13px; }
summary:focus-visible { outline: 2px solid var(--el-color-primary, #409eff); outline-offset: 3px; }
.runtime-message-diagnostics { margin-top: 12px; }
.runtime-message-list { list-style: none; padding: 0; margin: 0; }
.runtime-message-list > li { padding: 12px 0; border-bottom: 1px solid var(--el-border-color-lighter, #ebeef5); }
.runtime-message-heading { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 6px 12px; }
time { font-size: 12px; color: var(--el-text-color-regular, #606266); }
.runtime-message-content { white-space: pre-wrap; line-height: 1.6; }
.runtime-messages-footer { display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: 12px; }
@media (max-width: 600px) {
  .runtime-request-health-item { flex-direction: column; }
  .runtime-health-fields > div { grid-template-columns: 1fr; gap: 4px; }
}
</style>
