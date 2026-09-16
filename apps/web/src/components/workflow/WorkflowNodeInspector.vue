<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { AgentDefinition, WorkflowNode } from '@/types/contracts'
import UiIcon from '../UiIcon.vue'

const props = defineProps<{
  node?: WorkflowNode
  agents: AgentDefinition[]
}>()

const emit = defineEmits<{
  update: [node: WorkflowNode]
  remove: [nodeId: string]
}>()
const activeTab = ref<'detail' | 'config' | 'io'>('detail')
watch(() => props.node?.id, () => { activeTab.value = 'detail' })

const selectedAgent = computed(() => {
  if (!props.node) return undefined
  const agentId = props.node.type === 'agent' ? props.node.agentId : props.node.type === 'robot_approval' ? props.node.reviewerAgentId : undefined
  return props.agents.find((agent) => agent.id === agentId)
})

function updateNode(patch: Partial<WorkflowNode>) {
  if (!props.node) return
  emit('update', { ...props.node, ...patch } as WorkflowNode)
}

function lines(value: string) {
  return value.split('\n').map((item) => item.trim()).filter(Boolean)
}

function toggleDecision(decision: 'approve' | 'revise' | 'cancel', checked: boolean) {
  if (props.node?.type !== 'human_approval') return
  const current = props.node.allowedDecisions
  const next = checked ? [...new Set([...current, decision])] : current.filter((item) => item !== decision)
  updateNode({ allowedDecisions: next })
}
</script>

<template>
  <aside class="node-inspector" aria-label="节点详情">
    <template v-if="node">
      <header class="inspector-heading">
        <span :class="['node-kind-icon', node.type]">
          <UiIcon :name="node.type === 'agent' ? 'bot' : node.type === 'human_approval' ? 'users' : 'sparkles'" :size="18" />
        </span>
        <div>
          <h2>{{ node.type === 'agent' ? selectedAgent?.name || 'Agent 节点' : node.type === 'human_approval' ? '人工确认' : '机器人确认' }}</h2>
          <p>{{ node.type === 'agent' ? selectedAgent?.role || '执行节点' : node.type === 'human_approval' ? '由会话发起人决策' : '由评审 Agent 自动判断' }}</p>
        </div>
      </header>

      <div class="inspector-tabs" role="tablist" aria-label="节点配置视图">
        <button type="button" :class="{ active: activeTab === 'detail' }" role="tab" :aria-selected="activeTab === 'detail'" @click="activeTab = 'detail'">详情</button>
        <button type="button" :class="{ active: activeTab === 'config' }" role="tab" :aria-selected="activeTab === 'config'" @click="activeTab = 'config'">配置</button>
        <button type="button" :class="{ active: activeTab === 'io' }" role="tab" :aria-selected="activeTab === 'io'" @click="activeTab = 'io'">输入输出</button>
      </div>

      <div v-if="activeTab === 'detail'" class="inspector-detail">
        <template v-if="node.type === 'agent'">
          <section><h3>Agent 描述</h3><p>{{ selectedAgent?.description || selectedAgent?.role || '暂无描述' }}</p></section>
          <section><h3>标签</h3><div class="detail-tags"><span v-for="tag in selectedAgent?.tags || []" :key="tag">{{ tag }}</span><small v-if="!selectedAgent?.tags.length">暂无标签</small></div></section>
          <section><h3>阶段职责</h3><p>{{ node.stageDescription || '尚未配置阶段说明。' }}</p></section>
          <section><h3>质量验收</h3><p>普通 Agent 节点只执行任务，不会自动把质量问题退回上游。需要自动验收与返工时，请在其后配置机器人确认节点。</p></section>
        </template>
        <template v-else-if="node.type === 'human_approval'">
          <section><h3>确认方式</h3><p>工作流在此节点暂停，由当前会话发起人完成决策。</p></section>
          <section><h3>可用决策</h3><div class="detail-tags"><span v-for="decision in node.allowedDecisions" :key="decision">{{ decision }}</span></div></section>
          <section><h3>确认说明</h3><p>{{ node.instruction || '暂无说明' }}</p></section>
        </template>
        <template v-else>
          <section><h3>自动评审</h3><p>{{ selectedAgent?.name || '未选择评审 Agent' }} 根据配置标准输出结构化决策。</p></section>
          <section><h3>失败策略</h3><p>格式错误、执行异常或超过 {{ node.maxRevisionAttempts }} 次返工后转人工确认。</p></section>
          <section><h3>评审标准</h3><ul><li v-for="criterion in node.criteria" :key="criterion">{{ criterion }}</li><li v-if="!node.criteria.length">尚未配置评审标准。</li></ul></section>
        </template>
      </div>

      <div v-else-if="activeTab === 'config'" class="inspector-form">
        <label>
          <span>节点名称</span>
          <input :value="node.name || ''" maxlength="50" placeholder="请输入节点名称" @input="updateNode({ name: ($event.target as HTMLInputElement).value })" />
        </label>

        <template v-if="node.type === 'agent'">
          <label>
            <span>执行 Agent <em>*</em></span>
            <select :value="node.agentId" @change="updateNode({ agentId: ($event.target as HTMLSelectElement).value })">
              <option v-for="agent in agents" :key="agent.id" :value="agent.id">{{ agent.name }} · {{ agent.role }}</option>
            </select>
          </label>
          <label>
            <span>阶段说明</span>
            <textarea :value="node.stageDescription || ''" rows="4" maxlength="300" placeholder="说明该 Agent 在本阶段需要完成的工作" @input="updateNode({ stageDescription: ($event.target as HTMLTextAreaElement).value })"></textarea>
          </label>
        </template>

        <template v-else-if="node.type === 'human_approval'">
          <label>
            <span>确认标题 <em>*</em></span>
            <input :value="node.title" maxlength="80" placeholder="例如：确认需求分析结果" @input="updateNode({ title: ($event.target as HTMLInputElement).value })" />
          </label>
          <label>
            <span>确认说明</span>
            <textarea :value="node.instruction || ''" rows="5" maxlength="500" placeholder="告诉确认人需要检查什么" @input="updateNode({ instruction: ($event.target as HTMLTextAreaElement).value })"></textarea>
          </label>
          <fieldset>
            <legend>允许操作</legend>
            <label class="check-row"><input type="checkbox" :checked="node.allowedDecisions.includes('approve')" @change="toggleDecision('approve', ($event.target as HTMLInputElement).checked)" />通过并继续</label>
            <label class="check-row"><input type="checkbox" :checked="node.allowedDecisions.includes('revise')" @change="toggleDecision('revise', ($event.target as HTMLInputElement).checked)" />退回上一 Agent 修改</label>
            <label class="check-row"><input type="checkbox" :checked="node.allowedDecisions.includes('cancel')" @change="toggleDecision('cancel', ($event.target as HTMLInputElement).checked)" />终止工作流</label>
          </fieldset>
          <p class="form-note"><UiIcon name="users" :size="14" />确认人固定为当前会话发起人。</p>
        </template>

        <template v-else>
          <label>
            <span>评审 Agent <em>*</em></span>
            <select :value="node.reviewerAgentId" @change="updateNode({ reviewerAgentId: ($event.target as HTMLSelectElement).value })">
              <option value="" disabled>请选择评审 Agent</option>
              <option v-for="agent in agents" :key="agent.id" :value="agent.id">{{ agent.name }} · {{ agent.role }}</option>
            </select>
          </label>
          <label>
            <span>评审提示词 <em>*</em></span>
            <textarea :value="node.reviewPrompt" rows="5" maxlength="1000" placeholder="要求评审 Agent 严格返回 approve、revise 或 reject" @input="updateNode({ reviewPrompt: ($event.target as HTMLTextAreaElement).value })"></textarea>
          </label>
          <label>
            <span>评审标准 <em>*</em></span>
            <textarea :value="node.criteria.join('\n')" rows="4" placeholder="每行一条可验证标准" @input="updateNode({ criteria: lines(($event.target as HTMLTextAreaElement).value) })"></textarea>
          </label>
          <label>
            <span>最大返工次数</span>
            <input type="number" min="0" max="10" :value="node.maxRevisionAttempts" @input="updateNode({ maxRevisionAttempts: Number(($event.target as HTMLInputElement).value) })" />
          </label>
          <p class="form-note warning"><UiIcon name="sparkles" :size="14" />输出格式无效、执行异常或超过返工上限时自动转人工确认。</p>
          <p class="form-note warning"><UiIcon name="sparkles" :size="14" />可修复缺陷使用 revise 并填写修改说明；reject 会立即终止整个工作流，仅用于不可恢复问题。</p>
        </template>
      </div>

      <div v-else class="inspector-form io-form">
        <template v-if="node.type === 'agent'">
          <label><span>输入约定</span><textarea :value="(node.inputContract || []).join('\n')" rows="7" placeholder="每行一项，例如：已确认的任务契约" @input="updateNode({ inputContract: lines(($event.target as HTMLTextAreaElement).value) })"></textarea></label>
          <label><span>输出约定</span><textarea :value="(node.outputContract || []).join('\n')" rows="7" placeholder="每行一项，例如：可验收的需求文档" @input="updateNode({ outputContract: lines(($event.target as HTMLTextAreaElement).value) })"></textarea></label>
        </template>
        <template v-else-if="node.type === 'human_approval'">
          <section class="contract-block"><h3>输入</h3><p>最近一个有效上游 Agent 节点的输出摘要与产物引用。</p></section>
          <section class="contract-block"><h3>输出</h3><code>approve | revise | cancel</code><p>退回时必须提供修改说明；决策记录包含操作者、原因和时间。</p></section>
        </template>
        <template v-else>
          <section class="contract-block"><h3>输入</h3><p>上游 Agent 输出、评审提示词和逐条评审标准。</p></section>
          <section class="contract-block"><h3>严格 JSON 输出</h3><code>{ "decision": "approve|revise|reject", "reason": "...", "revisionInstruction": "...或null", "evidenceRefs": [] }</code><p>revise 必须提供非空修改说明；approve/reject 使用 null。</p></section>
        </template>
      </div>

      <footer>
        <button type="button" class="danger-button" @click="emit('remove', node.id)"><UiIcon name="trash" :size="15" />删除节点</button>
      </footer>
    </template>

    <div v-else class="inspector-empty">
      <span><UiIcon name="settings" :size="24" /></span>
      <h2>选择一个节点</h2>
      <p>在画布中选择节点后，可在这里查看和修改具体配置。</p>
    </div>
  </aside>
</template>

<style scoped>
.node-inspector{display:flex;flex-direction:column;min-width:0;min-height:0;background:#fff;overflow:auto}.inspector-heading{display:grid;grid-template-columns:40px minmax(0,1fr);align-items:center;gap:10px;padding:16px;border-bottom:1px solid #ebeef5}.node-kind-icon{display:grid;place-items:center;width:38px;height:38px;border-radius:6px;background:#ecf5ff;color:#409eff}.node-kind-icon.human_approval{background:#f0f9eb;color:#67c23a}.node-kind-icon.robot_approval{background:#fdf6ec;color:#e6a23c}.inspector-heading h2{margin:0;color:#303133;font-size:14px}.inspector-heading p{margin:4px 0 0;color:#909399;font-size:11px}.inspector-tabs{display:flex;height:39px;padding:0 16px;border-bottom:1px solid #e4e7ed}.inspector-tabs button{margin-right:20px;padding:0 2px;border:0;border-bottom:2px solid transparent;background:#fff;color:#606266;font-size:12px;cursor:pointer}.inspector-tabs button.active{border-bottom-color:#409eff;color:#409eff;font-weight:600}.inspector-detail{display:grid;gap:16px;padding:16px}.inspector-detail section{padding-bottom:14px;border-bottom:1px solid #ebeef5}.inspector-detail h3,.contract-block h3{margin:0 0 7px;color:#303133;font-size:12px}.inspector-detail p,.inspector-detail li,.contract-block p{margin:0;color:#606266;font-size:11px;line-height:1.7}.inspector-detail ul{margin:0;padding-left:17px}.detail-tags{display:flex;flex-wrap:wrap;gap:6px}.detail-tags span{padding:3px 7px;border-radius:4px;background:#ecf5ff;color:#409eff;font-size:10px}.detail-tags small{color:#909399}.inspector-form{display:grid;gap:16px;padding:16px}.inspector-form>label{display:grid;gap:7px}.inspector-form label>span,.inspector-form legend{color:#606266;font-size:12px;font-weight:600}.inspector-form em{color:#f56c6c;font-style:normal}.inspector-form input:not([type=checkbox]),.inspector-form select,.inspector-form textarea{box-sizing:border-box;width:100%;border:1px solid #dcdfe6;border-radius:4px;background:#fff;color:#303133;font:inherit;font-size:12px;outline:0}.inspector-form input:not([type=checkbox]),.inspector-form select{height:34px;padding:0 9px}.inspector-form textarea{padding:8px 9px;line-height:1.55;resize:vertical}.inspector-form input:focus,.inspector-form select:focus,.inspector-form textarea:focus{border-color:#409eff;box-shadow:0 0 0 2px rgb(64 158 255 / 12%)}.inspector-form fieldset{display:grid;gap:9px;margin:0;padding:12px;border:1px solid #e4e7ed;border-radius:4px}.check-row{display:flex;align-items:center;gap:8px;color:#606266;font-size:12px}.check-row input{accent-color:#409eff}.form-note{display:flex;align-items:flex-start;gap:7px;margin:0;padding:9px;border-radius:4px;background:#f0f9eb;color:#529b2e;font-size:11px;line-height:1.5}.form-note.warning{background:#fdf6ec;color:#b88230}.io-form{align-content:start}.contract-block{padding:12px;border:1px solid #e4e7ed;border-radius:4px}.contract-block code{display:block;padding:9px;border-radius:4px;background:#f5f7fa;color:#606266;font-size:10px;line-height:1.6;white-space:normal;word-break:break-word}.node-inspector footer{margin-top:auto;padding:12px 16px;border-top:1px solid #ebeef5}.danger-button{display:flex;align-items:center;justify-content:center;gap:6px;width:100%;height:34px;border:1px solid #fab6b6;border-radius:4px;background:#fff;color:#f56c6c;cursor:pointer}.danger-button:hover,.danger-button:focus-visible{background:#fef0f0;outline:0}.inspector-empty{display:grid;place-items:center;align-content:center;min-height:320px;padding:32px;text-align:center}.inspector-empty>span{display:grid;place-items:center;width:52px;height:52px;border-radius:50%;background:#f4f4f5;color:#a8abb2}.inspector-empty h2{margin:14px 0 6px;color:#606266;font-size:14px}.inspector-empty p{max-width:210px;margin:0;color:#909399;font-size:12px;line-height:1.6}
</style>
