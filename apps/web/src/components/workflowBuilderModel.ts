import type {
  AgentWorkflowNode,
  HumanApprovalWorkflowNode,
  RobotApprovalWorkflowNode,
  WorkflowEdge,
  WorkflowNode
} from '@/types/contracts'

export type WorkflowResource = { type: WorkflowNode['type']; agentId?: string }

type WorkflowIdCrypto = Partial<Pick<Crypto, 'randomUUID' | 'getRandomValues'>>

export function createWorkflowNodeId(cryptoApi: WorkflowIdCrypto | null = globalThis.crypto) {
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID()

  const bytes = new Uint8Array(16)
  if (typeof cryptoApi?.getRandomValues === 'function') {
    cryptoApi.getRandomValues(bytes)
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256)
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0'))
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`
}

export function normalizeWorkflowNodes(nodes: WorkflowNode[]) {
  return nodes.map((node, order) => ({ ...node, order }))
}

export function buildLinearWorkflowEdges(nodes: WorkflowNode[]): WorkflowEdge[] {
  return nodes.slice(0, -1).map((node, index) => ({
    id: `edge:${node.id}:${nodes[index + 1].id}`,
    sourceNodeId: node.id,
    targetNodeId: nodes[index + 1].id
  }))
}

export function insertWorkflowNode(nodes: WorkflowNode[], node: WorkflowNode, targetIndex: number) {
  const next = [...nodes]
  next.splice(Math.max(0, Math.min(targetIndex, next.length)), 0, node)
  return normalizeWorkflowNodes(next)
}

export function createAgentNode(agentId: string, order: number, nodeId = createWorkflowNodeId()): AgentWorkflowNode {
  return { id: nodeId, type: 'agent', agentId, order, inputContract: [], outputContract: [] }
}

export function createHumanApprovalNode(order: number, nodeId = createWorkflowNodeId()): HumanApprovalWorkflowNode {
  return {
    id: nodeId,
    type: 'human_approval',
    name: '人工确认',
    title: '确认上一环节输出',
    instruction: '请检查上一环节的结果，确认通过、退回修改或终止工作流。',
    assignee: 'session_owner',
    allowedDecisions: ['approve', 'revise', 'cancel'],
    order
  }
}

export function createRobotApprovalNode(
  reviewerAgentId: string,
  order: number,
  nodeId = createWorkflowNodeId()
): RobotApprovalWorkflowNode {
  return {
    id: nodeId,
    type: 'robot_approval',
    name: '机器人确认',
    reviewerAgentId,
    reviewPrompt: '根据评审标准检查上一环节结果，并严格返回约定的 JSON 决策。',
    criteria: ['结果完整且满足当前任务目标'],
    maxRevisionAttempts: 2,
    fallback: 'human_approval',
    order
  }
}

export function createWorkflowNode(resource: WorkflowResource, order: number, nodeId = createWorkflowNodeId()) {
  if (resource.type === 'agent') return createAgentNode(resource.agentId ?? '', order, nodeId)
  if (resource.type === 'human_approval') return createHumanApprovalNode(order, nodeId)
  return createRobotApprovalNode(resource.agentId ?? '', order, nodeId)
}

export function insertAgentNode(nodes: WorkflowNode[], agentId: string, targetIndex: number, nodeId = createWorkflowNodeId()) {
  return insertWorkflowNode(nodes, createAgentNode(agentId, targetIndex, nodeId), targetIndex)
}

export function moveWorkflowNode(nodes: WorkflowNode[], nodeId: string, targetIndex: number) {
  const sourceIndex = nodes.findIndex((node) => node.id === nodeId)
  if (sourceIndex < 0) return normalizeWorkflowNodes(nodes)
  const next = [...nodes]
  const [node] = next.splice(sourceIndex, 1)
  const adjustedTarget = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex
  next.splice(Math.max(0, Math.min(adjustedTarget, next.length)), 0, node)
  return normalizeWorkflowNodes(next)
}

export function reorderWorkflowNodes(nodes: WorkflowNode[], orderedNodeIds: string[]) {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const ordered = orderedNodeIds.map((id) => byId.get(id)).filter((node): node is WorkflowNode => Boolean(node))
  const missing = nodes.filter((node) => !orderedNodeIds.includes(node.id))
  return normalizeWorkflowNodes([...ordered, ...missing])
}

export function removeWorkflowNode(nodes: WorkflowNode[], nodeId: string) {
  return normalizeWorkflowNodes(nodes.filter((node) => node.id !== nodeId))
}

export function replaceWorkflowNode(nodes: WorkflowNode[], updated: WorkflowNode) {
  return normalizeWorkflowNodes(nodes.map((node) => node.id === updated.id ? updated : node))
}
