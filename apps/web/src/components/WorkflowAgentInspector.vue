<script setup lang="ts">
import type { WorkflowChainNode, WorkflowChainState } from './workflowChainModel'
import AgentPortrait from './AgentPortrait.vue'

/**
 * Shows one Agent's capabilities and its output in the current task.
 *
 * Display only: every value comes from the chain model, so no execution state is
 * derived here. The canvas node carries identity alone, and this panel is where
 * the detail that used to overflow the node now lives.
 */
const props = defineProps<{
  node: WorkflowChainNode
  tone: number
}>()

const stateLabels: Record<WorkflowChainState, string> = {
  done: '已执行',
  active: '执行中',
  pending: '未执行'
}

function stateLabel(state: WorkflowChainState) {
  return stateLabels[state]
}

const hasOutput = () =>
  Boolean(props.node.output.currentTaskTitle) ||
  Boolean(props.node.output.actionSummary) ||
  Boolean(props.node.output.thoughtSummary) ||
  props.node.output.recentLogs.length > 0
</script>

<template>
  <section class="workflow-agent-inspector" :class="`is-${node.state}`" aria-label="Agent 详情">
    <header class="workflow-agent-inspector__head">
      <AgentPortrait :tone="node.kind === 'system' ? 'system' : tone" :label="node.name" size="md" />
      <div>
        <h3>{{ node.name }}</h3>
        <p v-if="node.role">{{ node.role }}</p>
      </div>
      <span class="workflow-agent-inspector__state">{{ stateLabel(node.state) }}</span>
    </header>

    <section class="workflow-agent-inspector__block">
      <h4>Agent 能力</h4>
      <div v-if="node.output.capabilityNames.length" class="tag-row">
        <span v-for="capability in node.output.capabilityNames" :key="capability" class="tag">{{ capability }}</span>
      </div>
      <p v-else class="workflow-agent-inspector__empty">该 Agent 没有已启用的能力。</p>
    </section>

    <section class="workflow-agent-inspector__block">
      <h4>本次任务输出</h4>
      <dl v-if="hasOutput()">
        <template v-if="node.output.currentTaskTitle">
          <dt>当前任务</dt>
          <dd>{{ node.output.currentTaskTitle }}</dd>
        </template>
        <template v-if="node.output.actionSummary">
          <dt>执行输出</dt>
          <dd>{{ node.output.actionSummary }}</dd>
        </template>
        <template v-if="node.output.thoughtSummary">
          <dt>思考摘要</dt>
          <dd>{{ node.output.thoughtSummary }}</dd>
        </template>
        <template v-if="node.output.recentLogs.length">
          <dt>最近日志</dt>
          <dd>
            <ul>
              <li v-for="log in node.output.recentLogs" :key="log">{{ log }}</li>
            </ul>
          </dd>
        </template>
      </dl>
      <p v-else class="workflow-agent-inspector__empty">该 Agent 在当前任务中还没有输出。</p>
    </section>

    <section v-if="node.output.artifactIds.length" class="workflow-agent-inspector__block">
      <h4>产出物</h4>
      <p>{{ node.output.artifactIds.length }} 个产物</p>
    </section>
  </section>
</template>
