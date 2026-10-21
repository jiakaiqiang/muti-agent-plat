<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { IntentTestScript, SessionDetail } from '@agent-cluster/shared'
import { ApiRequestError } from '@/api/client'
import { testAuthorityKey, useIntentTestAuthorityStore } from '@/stores/intentTestAuthority'
import { useEventStore } from '@/stores/event'

const props = defineProps<{ session: SessionDetail; disabled?: boolean }>()
const store = useIntentTestAuthorityStore(), events = useEventStore()
const key = computed(() => testAuthorityKey(props.session.id, props.session.dataEpoch))
const view = computed(() => store.views[key.value]), pending = computed(() => store.pending[key.value])
const busy = computed(() => Boolean(store.busy[key.value]))
const selected = ref<IntentTestScript>('test'), loading = ref(false), error = ref(''), notice = ref('')
const writeReport = ref(false)
let reader: AbortController | undefined
const lastEvent = computed(() => events.eventsForSession(props.session.id).filter(event => event.type === 'intent_test_authority_changed').at(-1)?.id)
const status = computed(() => !view.value || store.stale[key.value] ? '状态待确认' : view.value.enabled ? `已允许 ${view.value.authority!.binding.script}` :
  view.value.authority?.grant.revokedAt ? '已撤销测试授权' : view.value.authority ? '原测试授权已失效' :
    view.value.availableBindings.length ? '尚未授权测试' : '隔离测试环境尚未配置')
const locked = computed(() => Boolean(props.disabled || loading.value || busy.value || pending.value || store.stale[key.value]))
const canGrant = computed(() => view.value?.availableBindings.some(binding => binding.script === selected.value) &&
  (!view.value.enabled || view.value.authority?.binding.script !== selected.value ||
    Boolean(view.value.authority?.reportGrant && !view.value.authority.reportGrant.revokedAt) !== writeReport.value))

async function refresh() {
  reader?.abort(); const controller = new AbortController(); reader = controller
  const sessionId = props.session.id, epoch = props.session.dataEpoch
  loading.value = true; error.value = ''
  try { await store.refresh(sessionId, epoch, controller.signal) }
  catch { if (!controller.signal.aborted) error.value = '无法确认测试授权状态，请刷新后重试。' }
  finally { if (!controller.signal.aborted) loading.value = false }
}
async function change(action?: 'grant' | 'revoke') {
  if (props.disabled || busy.value) return
  const sessionId = props.session.id, epoch = props.session.dataEpoch, origin = key.value
  error.value = ''; notice.value = ''
  try {
    if (action) store.prepare(sessionId, epoch, action, selected.value, writeReport.value)
    await store.submit(sessionId, epoch)
    if (key.value === origin) notice.value = '测试授权已更新，旧测试请求不会自动重新执行。'
  } catch (cause) {
    if (key.value !== origin) return
    error.value = cause instanceof ApiRequestError && [409, 410].includes(cause.status)
      ? '授权状态已发生变化，请核对刷新后的状态再操作。'
      : store.pending[origin] ? '提交结果尚未确认，请重试原请求。' : '操作未完成，请刷新测试授权状态后重试。'
  }
}
watch(key, () => { selected.value = 'test'; writeReport.value = false; notice.value = '' })
watch(view, current => {
  writeReport.value = pending.value ? pending.value.payload.writeReport === true : Boolean(current?.enabled && current.authority?.reportGrant && !current.authority.reportGrant.revokedAt)
  if (pending.value) selected.value = pending.value.payload.script
  else if (current?.enabled) selected.value = current.authority!.binding.script
  else if (current?.availableBindings.length && !current.availableBindings.some(binding => binding.script === selected.value)) selected.value = current.availableBindings[0].script
})
watch(() => [props.session.id, props.session.dataEpoch, props.session.revision, props.session.sourceBinding?.version, lastEvent.value],
  () => { notice.value = ''; void refresh() }, { immediate: true })
onBeforeUnmount(() => reader?.abort())
</script>

<template>
  <section class="intent-test-authority" aria-label="隔离测试授权" :aria-busy="loading || busy">
    <div class="intent-test-authority__row">
      <strong>隔离测试</strong>
      <span role="status">{{ status }}</span>
      <span class="intent-test-authority__name">{{ session.workingDirectory?.name ?? '等待工作区准备完成' }}</span>
      <div class="intent-test-authority__actions">
        <label v-if="view?.availableBindings.length"><input v-model="writeReport" type="checkbox" :disabled="locked">允许保存会话测试报告</label>
        <label v-if="view?.availableBindings.length">测试脚本
          <select v-model="selected" :disabled="locked">
            <option v-for="binding in view.availableBindings" :key="binding.resourceId" :value="binding.script">{{ binding.script }}</option>
          </select>
        </label>
        <button type="button" :disabled="disabled || loading || busy" @click="refresh">刷新测试状态</button>
        <button v-if="pending" type="button" :disabled="disabled || busy" @click="change()">重试原测试授权请求</button>
        <template v-else>
          <button v-if="view?.authority && !view.authority.grant.revokedAt" type="button" :disabled="locked" @click="change('revoke')">撤销测试授权</button>
          <button v-if="canGrant" type="button" :disabled="locked" @click="change('grant')">允许所选测试</button>
        </template>
      </div>
    </div>
    <p>仅授权所选脚本的隔离测试，不开放源码修改、任意命令或外部网络访问。</p>
    <p>授权后，新提交的测试请求会按当前计划执行；旧请求不会自动重跑。缺少授权的原请求可在消息中点击“授权后重新校验原请求”。</p>
    <p v-if="view?.enabled && view.authority?.reportGrant && !view.authority.reportGrant.revokedAt">已允许保存会话测试报告；报告不会写入源码目录。</p>
    <p v-if="pending" role="status">{{ pending.payload.script }} 的{{ pending.payload.action === 'grant' ? '授权' : '撤销' }}结果尚未确认。重试会核对原操作结果。</p>
    <p v-if="error" role="alert" class="intent-test-authority__error">{{ error }}</p>
    <p v-else-if="notice" role="status">{{ notice }}</p>
  </section>
</template>

<style scoped>
.intent-test-authority { flex: none; border-bottom: 1px solid var(--border-color, #dcdfe6); background: #f8fbff; color: #303133; padding: 10px 16px; font-size: 13px; }
.intent-test-authority__row, .intent-test-authority__actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.intent-test-authority__name { overflow-wrap: anywhere; color: #606266; }
.intent-test-authority__actions { margin-left: auto; }
.intent-test-authority label { display: flex; align-items: center; gap: 6px; }
.intent-test-authority button, .intent-test-authority select { min-height: 32px; max-width: 100%; padding: 4px 10px; border: 1px solid #b7c6dd; border-radius: 4px; background: #fff; color: #155eef; font: inherit; }
.intent-test-authority button { cursor: pointer; }
.intent-test-authority :is(button, select, input):focus-visible { outline: 2px solid #155eef; outline-offset: 2px; }
.intent-test-authority :is(button, select):disabled { cursor: not-allowed; color: #606266; background: #f4f4f5; }
.intent-test-authority p { margin: 6px 0 0; color: #606266; }
.intent-test-authority .intent-test-authority__error { color: #b42318; }
</style>
