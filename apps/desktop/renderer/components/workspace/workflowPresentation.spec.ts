import { describe, expect, it } from 'vitest'
import type { AgentTask, WorkflowNodeRun } from '@agent-cluster/shared'
import { tasksForNode } from './workflowPresentation'

describe('workflow node task boundaries', () => {
  it('keeps attempts and participating agents while excluding other nodes, runs and unlinked tasks', () => {
    const task = (id: string, run = 'run', node = 'develop', agent = 'agent-a') => ({ id, workflowRunId: run, workflowNodeId: node, assignee: { type: 'agent', id: agent } }) as AgentTask
    const tasks = [task('first'), task('rework'), task('second-agent', 'run', 'develop', 'agent-b'), task('same-agent-other-node', 'run', 'verify'), task('other-run', 'old'), task('unlinked')]
    const attempts = tasks.slice(0, 5).map((task, index) => ({ id: `attempt-${index}`, workflowRunId: task.workflowRunId, nodeId: task.workflowNodeId, relatedTaskId: task.id, attempt: index + 1 })) as WorkflowNodeRun[]
    expect(tasksForNode(tasks, 'run', 'develop', attempts).map(task => task.id)).toEqual(['first', 'rework', 'second-agent'])
    expect(tasksForNode(tasks, 'run', 'human', attempts)).toEqual([])
  })
})
