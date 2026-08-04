import { describe, expect, it } from 'vitest'
import {
  buildLinearWorkflowEdges,
  createHumanApprovalNode,
  createRobotApprovalNode,
  createWorkflowNodeId,
  insertAgentNode,
  moveWorkflowNode,
  removeWorkflowNode
} from './workflowBuilderModel'

const nodes = [
  { id: 'requirements-node', type: 'agent' as const, agentId: 'requirements', order: 0 },
  { id: 'frontend-node', type: 'agent' as const, agentId: 'frontend', order: 1 },
  { id: 'test-node', type: 'agent' as const, agentId: 'test', order: 2 }
]

describe('workflowBuilderModel', () => {
  it('inserts and reorders Agent nodes while preserving canonical order', () => {
    const inserted = insertAgentNode(nodes, 'product', 1, 'product-node')
    expect(inserted.map((node) => node.agentId)).toEqual(['requirements', 'product', 'frontend', 'test'])
    const moved = moveWorkflowNode(inserted, 'test-node', 1)
    expect(moved.map((node) => node.agentId)).toEqual(['requirements', 'test', 'product', 'frontend'])
    expect(moved.map((node) => node.order)).toEqual([0, 1, 2, 3])
  })

  it('removes nodes and rebuilds linear edges', () => {
    const remaining = removeWorkflowNode(nodes, 'frontend-node')
    expect(buildLinearWorkflowEdges(remaining)).toEqual([
      {
        id: 'edge:requirements-node:test-node',
        sourceNodeId: 'requirements-node',
        targetNodeId: 'test-node'
      }
    ])
  })

  it('creates explicit human and robot confirmation nodes with safe defaults', () => {
    expect(createHumanApprovalNode(1, 'human-node')).toMatchObject({
      id: 'human-node', type: 'human_approval', assignee: 'session_owner', allowedDecisions: ['approve', 'revise', 'cancel']
    })
    expect(createRobotApprovalNode('reviewer', 2, 'robot-node')).toMatchObject({
      id: 'robot-node', type: 'robot_approval', reviewerAgentId: 'reviewer', maxRevisionAttempts: 2, fallback: 'human_approval'
    })
  })

  it('creates a UUID v4 when crypto.randomUUID is unavailable', () => {
    const cryptoWithoutRandomUuid = {
      getRandomValues: <T extends ArrayBufferView | null>(array: T) => {
        if (array) new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(0)
        return array
      }
    }

    expect(createWorkflowNodeId(cryptoWithoutRandomUuid)).toBe('00000000-0000-4000-8000-000000000000')
    expect(createWorkflowNodeId(null)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})
