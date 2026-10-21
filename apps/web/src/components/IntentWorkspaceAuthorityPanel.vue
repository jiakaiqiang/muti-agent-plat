<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { SessionDetail } from '@agent-cluster/shared'
import { ApiRequestError } from '@/api/client'
import { authorityKey, useIntentWorkspaceAuthorityStore } from '@/stores/intentWorkspaceAuthority'
import { useEventStore } from '@/stores/event'

const props = defineProps<{ session: SessionDetail; disabled?: boolean }>()
const store = useIntentWorkspaceAuthorityStore(), events = useEventStore()
const key = computed(() => authorityKey(props.session.id, props.session.dataEpoch))
const view = computed(() => store.views[key.value])
const pending = computed(() => store.pending[key.value])
const busy = computed(() => Boolean(store.busy[key.value]))
const loading = ref(false), error = ref(''), notice = ref('')
let reader: AbortController | undefined
const lastAuthorityEvent = computed(() => events.eventsForSession(props.session.id)
  .filter(event => event.type === 'intent_workspace_authority_changed').at(-1)?.id)
const status = computed(() => !view.value || store.stale[key.value] ? '状态待确认' : view.value.enabled ? '已允许读取' :
  view.value.authority?.grant.revokedAt ? '已撤销读取' : view.value.bindingHash ? '尚未授权读取' : '工作区尚不可读取')
const locked = computed(() => Boolean(props.disabled || loading.value || busy.value || pending.value || store.stale[key.value]))

async function refresh() {
  reader?.abort(); const controller = new AbortController(); reader = controller
  const sessionId = props.session.id, epoch = props.session.dataEpoch
  loading.value = true; error.value = ''
  try { await store.refresh(sessionId, epoch, controller.signal) }
  catch { if (!controller.signal.aborted) error.value = '无法确认读取授权状态，请刷新后重试。' }
  finally { if (!controller.signal.aborted) loading.value = false }
}
async function change(action?: 'grant' | 'revoke') {
  if (props.disabled || busy.value) return
  const sessionId = props.session.id, epoch = props.session.dataEpoch, origin = key.value
  error.value = ''; notice.value = ''
  try {
    if (action) store.prepare(sessionId, epoch, action)
    await store.submit(sessionId, epoch)
    if (key.value === origin) notice.value = '读取授权已更新。重新授权后，请重新发送需要读取文件的消息。'
  } catch (cause) {
    if (key.value !== origin) return
    error.value = cause instanceof ApiRequestError && [409, 410].includes(cause.status)
      ? '授权状态已发生变化，请核对刷新后的状态再操作。'
      : store.pending[origin] ? '提交结果尚未确认，请重试原请求。' : '操作未完成，请刷新授权状态后重试。'
  }
}
watch(() => [props.session.id, props.session.dataEpoch, props.session.revision, props.session.sourceBinding?.version, lastAuthorityEvent.value],
  () => { notice.value = ''; void refresh() }, { immediate: true })
onBeforeUnmount(() => reader?.abort())
</script>

<template>
  <section class="intent-workspace-authority" aria-label="工作区读取授权" :aria-busy="loading || busy">
    <div class="intent-workspace-authority__row">
      <strong>工作区读取</strong>
      <span role="status">{{ status }}</span>
      <span class="intent-workspace-authority__name">{{ session.workingDirectory?.name ?? '等待工作区准备完成' }}</span>
      <div class="intent-workspace-authority__actions">
        <button type="button" :disabled="disabled || loading || busy" @click="refresh">刷新状态</button>
        <button v-if="pending" type="button" :disabled="disabled || busy" @click="change()">重试原请求</button>
        <template v-else>
          <button v-if="view?.enabled || (view?.authority && !view.authority.grant.revokedAt)" type="button" :disabled="locked" @click="change('revoke')">撤销读取授权</button>
          <button v-else-if="view?.bindingHash" type="button" :disabled="locked" @click="change('grant')">允许读取工作区</button>
        </template>
      </div>
    </div>
    <p>读取授权用于查看和搜索工作区文件。撤销后将阻止后续读取及尚未发布的回答。</p>
    <p v-if="pending" role="status">有一项{{ pending.payload.action === 'grant' ? '授权' : '撤销' }}请求尚未确认。重试会核对原操作结果。</p>
    <p v-if="error" role="alert" class="intent-workspace-authority__error">{{ error }}</p>
    <p v-else-if="notice" role="status">{{ notice }}</p>
  </section>
</template>

<style scoped>
.intent-workspace-authority { flex: none; border-bottom: 1px solid var(--border-color, #dcdfe6); background: #f8fbff; color: #303133; padding: 10px 16px; font-size: 13px; }
.intent-workspace-authority__row, .intent-workspace-authority__actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.intent-workspace-authority__name { overflow-wrap: anywhere; color: #606266; }
.intent-workspace-authority__actions { margin-left: auto; }
.intent-workspace-authority button { min-height: 32px; padding: 4px 10px; border: 1px solid #b7c6dd; border-radius: 4px; background: #fff; color: #155eef; cursor: pointer; font: inherit; }
.intent-workspace-authority button:focus-visible { outline: 2px solid #155eef; outline-offset: 2px; }
.intent-workspace-authority button:disabled { cursor: not-allowed; color: #606266; background: #f4f4f5; }
.intent-workspace-authority p { margin: 6px 0 0; color: #606266; }
.intent-workspace-authority .intent-workspace-authority__error { color: #b42318; }
</style>
