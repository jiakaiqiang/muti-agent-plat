<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { isIntentWorkflowEffects, type IntentWorkflowEffects, type IntentEffectKind, type IntentResource } from '@agent-cluster/shared'
const props = defineProps<{ value?: IntentWorkflowEffects; nodeId: string; human?: boolean }>()
const emit = defineEmits<{ update: [value: IntentWorkflowEffects | undefined] }>()
const kind = ref<IntentEffectKind>('read_workspace'), resourceId = ref(''), error = ref('')
const choices: Array<{ kind: IntentEffectKind; label: string; resource: IntentResource['kind'] }> = [
  { kind: 'answer', label: '生成回复', resource: 'unresolved' },
  { kind: 'read_workspace', label: '读取工作区', resource: 'workspace' },
  { kind: 'write_artifact', label: '保存产物', resource: 'artifact' },
  { kind: 'modify_source', label: '修改源码', resource: 'source' },
  { kind: 'run_tests', label: '运行测试', resource: 'test_runner' },
  { kind: 'run_command', label: '执行命令', resource: 'command' },
  { kind: 'external_write', label: '写入外部系统', resource: 'external' }
]
const selected = computed(() => choices.find(row => row.kind === kind.value)!)
watch(() => props.nodeId, () => { resourceId.value = ''; kind.value = 'read_workspace'; error.value = '' })
function add() {
  const value: IntentWorkflowEffects = { contractVersion: 'intent-workflow-effects-v1', effects: [...(props.value?.effects ?? []),
    { kind: kind.value, target: { kind: selected.value.resource, refId: kind.value === 'answer' ? null : resourceId.value.trim() } }] }
  if (!isIntentWorkflowEffects(value)) { error.value = '请填写资源标识；操作不可重复，最多 16 项。'; return }
  emit('update', value); error.value = ''; resourceId.value = ''
}
function remove(index: number) {
  emit('update', { contractVersion: 'intent-workflow-effects-v1', effects: props.value!.effects.filter((_, position) => position !== index) })
}
</script>
<template>
  <fieldset class="workflow-effects">
    <legend>节点所需操作</legend>
    <p>声明本节点需要的操作；实际运行仍须符合任务授权，保存声明不会授予权限。</p>
    <p v-if="!value" role="status">尚未声明。使用新版意图执行时，须先明确所需操作。</p>
    <p v-else-if="!value.effects.length" role="status">已明确声明：无需操作资源。</p>
    <ul v-else>
      <li v-for="(effect, index) in value.effects" :key="JSON.stringify(effect)">
        <span>{{ choices.find(row => row.kind === effect.kind)?.label }}{{ effect.target.refId ? `：${effect.target.refId}` : '' }}</span>
        <button type="button" :aria-label="`移除第 ${index + 1} 项操作`" @click="remove(index)">移除</button>
      </li>
    </ul>
    <template v-if="!human">
      <label>操作类型<select v-model="kind"><option v-for="choice in choices" :key="choice.kind" :value="choice.kind">{{ choice.label }}</option></select></label>
      <label v-if="kind !== 'answer'">目标资源标识<input v-model="resourceId" maxlength="200" placeholder="填写对应工作区、产物或执行资源的标识" /></label>
      <small v-if="kind !== 'answer'">使用系统中实际存在的资源标识，不能填写路径或通配符来扩大范围。</small>
      <button type="button" :disabled="(value?.effects.length ?? 0) >= 16" @click="add">添加所需操作</button>
    </template>
    <p v-else>人工确认节点只记录决定，不直接执行资源操作。</p>
    <button type="button" @click="emit('update', { contractVersion: 'intent-workflow-effects-v1', effects: [] }); error = ''">声明无需操作资源</button>
    <button v-if="value" type="button" @click="emit('update', undefined); error = ''">清除声明</button>
    <p v-if="error" role="alert">{{ error }}</p>
  </fieldset>
</template>
<style scoped>
.workflow-effects { min-width: 0; display: grid; gap: 10px; margin: 0; padding: 12px; border: 1px solid var(--el-border-color, #dcdfe6); border-radius: 4px; }
.workflow-effects legend { font-weight: 600; }
.workflow-effects p, .workflow-effects small { margin: 0; line-height: 1.6; color: var(--el-text-color-regular, #606266); }
.workflow-effects label { display: grid; gap: 6px; }
.workflow-effects input, .workflow-effects select, .workflow-effects button { min-width: 0; padding: 7px; font: inherit; border: 1px solid var(--el-border-color, #dcdfe6); border-radius: 4px; background: var(--el-bg-color, #fff); color: var(--el-text-color-primary, #303133); }
.workflow-effects ul { margin: 0; padding-left: 18px; }
.workflow-effects li { overflow-wrap: anywhere; margin-bottom: 6px; }
.workflow-effects button { cursor: pointer; }
.workflow-effects button:disabled { opacity: .5; cursor: default; }
.workflow-effects :focus-visible { outline: 2px solid var(--el-color-primary, #409eff); outline-offset: 2px; }
.workflow-effects [role=alert] { color: var(--el-color-danger, #f56c6c); }
</style>
