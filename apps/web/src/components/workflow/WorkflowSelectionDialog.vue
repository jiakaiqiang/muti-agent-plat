<script setup lang="ts">
import { computed, ref } from 'vue'
import UiIcon from '../UiIcon.vue'

export type WorkflowSelectionOption = {
  id: string
  name: string
  description?: string
  version: number
  nodeCount: number
  agentCount: number
  humanApprovalCount: number
  robotApprovalCount: number
}

const props = defineProps<{ workflows: WorkflowSelectionOption[] }>()
const emit = defineEmits<{ select: [workflowId: string, version: number]; manage: []; close: [] }>()
const search = ref('')
const selectedId = ref('')
const filtered = computed(() => {
  const query = search.value.trim().toLowerCase()
  return props.workflows.filter((workflow) => !query || `${workflow.name} ${workflow.description ?? ''}`.toLowerCase().includes(query))
})
const selected = computed(() => props.workflows.find((workflow) => workflow.id === selectedId.value))
</script>

<template>
  <Teleport to="body">
    <div class="workflow-dialog-backdrop" role="presentation" @click.self="emit('close')">
      <section class="workflow-dialog" role="dialog" aria-modal="true" aria-labelledby="workflow-dialog-title">
        <header><div><h2 id="workflow-dialog-title">选择执行工作流</h2><p>需求将严格按照所选发布版本流转。</p></div><button type="button" title="关闭" aria-label="关闭工作流选择弹窗" @click="emit('close')"><UiIcon name="x" :size="17" /></button></header>
        <label class="workflow-search"><UiIcon name="search" :size="16" /><input v-model="search" type="search" placeholder="搜索工作流名称或描述" aria-label="搜索可用工作流" /></label>
        <div class="workflow-options" role="radiogroup" aria-label="已发布工作流">
          <button v-for="workflow in filtered" :key="workflow.id" type="button" class="workflow-option" :class="{ selected: selectedId === workflow.id }" role="radio" :aria-checked="selectedId === workflow.id" @click="selectedId = workflow.id">
            <span class="option-radio"><i></i></span>
            <span class="option-copy"><span><strong>{{ workflow.name }}</strong><em>v{{ workflow.version }}</em></span><small>{{ workflow.description || '暂无描述' }}</small><span class="option-counts"><span><UiIcon name="bot" :size="13" />Agent {{ workflow.agentCount }}</span><span><UiIcon name="users" :size="13" />人工 {{ workflow.humanApprovalCount }}</span><span><UiIcon name="sparkles" :size="13" />机器人 {{ workflow.robotApprovalCount }}</span><span>共 {{ workflow.nodeCount }} 节点</span></span></span>
          </button>
          <div v-if="!filtered.length" class="workflow-empty"><UiIcon name="workflow" :size="25" /><strong>没有可用的已发布工作流</strong><p>请先创建并发布工作流，或调整搜索条件。</p></div>
        </div>
        <footer><button type="button" @click="emit('manage')">管理工作流</button><button type="button" class="primary" :disabled="!selected" @click="selected && emit('select', selected.id, selected.version)">确认并开始执行</button></footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.workflow-dialog-backdrop{position:fixed;inset:0;z-index:1000;display:grid;place-items:center;padding:20px;background:rgb(0 0 0 / 38%)}.workflow-dialog{display:grid;grid-template-rows:auto auto minmax(180px,1fr) auto;width:min(720px,calc(100vw - 40px));max-height:min(720px,calc(100vh - 40px));border-radius:6px;background:#fff;box-shadow:0 18px 48px rgb(0 0 0 / 22%);overflow:hidden}.workflow-dialog>header{display:flex;align-items:flex-start;justify-content:space-between;padding:18px 20px;border-bottom:1px solid #e4e7ed}.workflow-dialog h2{margin:0;color:#303133;font-size:17px}.workflow-dialog header p{margin:6px 0 0;color:#909399;font-size:12px}.workflow-dialog header button{display:grid;place-items:center;width:30px;height:30px;padding:0;border:0;border-radius:4px;background:#fff;color:#909399;cursor:pointer}.workflow-dialog header button:hover,.workflow-dialog header button:focus-visible{background:#f4f4f5;color:#303133;outline:0}.workflow-search{display:flex;align-items:center;gap:8px;height:36px;margin:14px 20px 8px;padding:0 10px;border:1px solid #dcdfe6;border-radius:4px;color:#909399}.workflow-search:focus-within{border-color:#409eff;box-shadow:0 0 0 2px rgb(64 158 255 / 12%)}.workflow-search input{width:100%;border:0;outline:0;color:#303133}.workflow-options{display:grid;align-content:start;gap:8px;padding:8px 20px 18px;overflow:auto}.workflow-option{display:grid;grid-template-columns:20px minmax(0,1fr);gap:12px;width:100%;padding:13px;border:1px solid #dcdfe6;border-radius:6px;background:#fff;color:#303133;text-align:left;cursor:pointer}.workflow-option:hover,.workflow-option:focus-visible{border-color:#79bbff;background:#f5faff;outline:0}.workflow-option.selected{border-color:#409eff;background:#ecf5ff;box-shadow:0 0 0 1px #409eff}.option-radio{display:grid;place-items:center;width:18px;height:18px;margin-top:1px;border:1px solid #c0c4cc;border-radius:50%;background:#fff}.selected .option-radio{border-color:#409eff}.selected .option-radio i{width:9px;height:9px;border-radius:50%;background:#409eff}.option-copy{display:grid;gap:7px;min-width:0}.option-copy>span:first-child{display:flex;align-items:center;gap:8px}.option-copy strong{font-size:13px}.option-copy em{padding:2px 6px;border-radius:4px;background:#f4f4f5;color:#606266;font-size:10px;font-style:normal}.option-copy>small{color:#909399;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.option-counts{display:flex;flex-wrap:wrap;gap:12px;color:#606266;font-size:10px}.option-counts>span{display:flex;align-items:center;gap:4px}.workflow-empty{display:grid;place-items:center;align-content:center;min-height:210px;color:#a8abb2;text-align:center}.workflow-empty strong{margin-top:12px;color:#606266;font-size:13px}.workflow-empty p{margin:6px 0 0;font-size:11px}.workflow-dialog>footer{display:flex;justify-content:flex-end;gap:8px;padding:12px 20px;border-top:1px solid #e4e7ed;background:#fafafa}.workflow-dialog footer button{height:34px;padding:0 14px;border:1px solid #dcdfe6;border-radius:4px;background:#fff;color:#606266;cursor:pointer}.workflow-dialog footer .primary{border-color:#409eff;background:#409eff;color:#fff}.workflow-dialog footer button:disabled{cursor:not-allowed;opacity:.5}@media(max-width:600px){.workflow-dialog-backdrop{padding:10px}.workflow-dialog{width:calc(100vw - 20px);max-height:calc(100vh - 20px)}.option-counts{gap:7px}}
</style>
