import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { ChatMessage } from '@/types/contracts'
import ChatTimeline from './ChatTimeline.vue'

const reportContent = [
  '# 完整系统架构说明',
  '',
  '## 系统边界',
  '浏览器 -> Session API -> Orchestrator -> Codex Runtime',
  '',
  '## 数据流转',
  'RuntimeOutput -> Artifact -> final_delivery_created -> 群聊',
  '',
  '## 问题定位',
  '最终交付过去只展示摘要，完整正文仅存在于旧产物载荷。'
].join('\n')

function deliveryMessage(): ChatMessage {
  return {
    id: 'message-delivery-report',
    sessionId: 'session-1',
    senderType: 'agent',
    senderAgentId: 'architect',
    toAgentIds: [],
    messageType: 'delivery',
    content: '最终交付已创建。',
    createdAt: '2026-07-13T00:00:00.000Z',
    rawEventId: 'event-delivery-report',
    payload: {
      summary: '已完成系统架构分析。',
      completedItems: ['已梳理系统边界和数据流转。'],
      incompleteItems: ['外部系统未做联调。'],
      risks: ['本地环境配置可能不同。'],
      report: {
        artifactId: 'artifact-report',
        title: '完整系统架构说明',
        format: 'markdown',
        content: reportContent,
        suggestedPath: 'agent-output/project-architecture-analysis.md',
        requiresUserConfirmation: true
      }
    }
  }
}

describe('ChatTimeline complete delivery report', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    HTMLElement.prototype.scrollTo = vi.fn()
  })

  it('shows the full report body, target path, incomplete items and risks in group chat', () => {
    const wrapper = mount(ChatTimeline, {
      props: { messages: [deliveryMessage()] },
      global: { stubs: { AgentPortrait: true } }
    })

    expect(wrapper.get('[aria-label="完整系统架构说明正文"]').text()).toContain('## 数据流转')
    expect(wrapper.get('[aria-label="完整系统架构说明正文"]').text()).toContain('## 问题定位')
    expect(wrapper.text()).toContain('agent-output/project-architecture-analysis.md')
    expect(wrapper.text()).toContain('外部系统未做联调。')
    expect(wrapper.text()).toContain('本地环境配置可能不同。')
  })

  it('recovers the full report from a historical runtime artifact for old delivery events', () => {
    const artifactMessage: ChatMessage = {
      id: 'message-runtime-artifact',
      sessionId: 'session-1',
      senderType: 'agent',
      senderAgentId: 'architect',
      toAgentIds: [],
      messageType: 'artifact',
      content: '已创建产物：架构分析执行结果',
      createdAt: '2026-07-13T00:00:00.000Z',
      rawEventId: 'event-runtime-artifact',
      payload: {
        artifactId: 'artifact-runtime-report',
        type: 'json',
        title: '架构分析执行结果',
        report: {
            kind: 'project_architecture_analysis',
            title: '系统架构说明',
            content: reportContent,
        }
      }
    }
    const historicalDelivery = deliveryMessage()
    delete historicalDelivery.payload?.report

    const wrapper = mount(ChatTimeline, {
      props: { messages: [artifactMessage, historicalDelivery] },
      global: { stubs: { AgentPortrait: true } }
    })

    expect(wrapper.get('[aria-label="完整系统架构说明正文"]').text()).toContain('## 数据流转')
    expect(wrapper.text()).toContain('agent-output/project-architecture-analysis.md')
  })

  it('renders structured RuntimeError status and requested context without internal contract details', () => {
    const errorMessage: ChatMessage = {
      id: 'message-runtime-error',
      sessionId: 'session-1',
      senderType: 'system',
      toAgentIds: [],
      messageType: 'error',
      content: 'Runtime output rejected',
      createdAt: '2026-07-15T00:00:00.000Z',
      rawEventId: 'event-runtime-error',
      payload: {
        phase: 'task_brief',
        runtimeError: {
          code: 'RUNTIME_OUTPUT_CONTRACT_VIOLATION',
          message: 'schema mismatch',
          retryable: false,
          details: {
            diagnosticRef: 'contract-safe',
            contractId: 'runtime.output.task_brief',
            schemaHash: 'fnv1a32:deadbeef'
          },
          requestedContext: {
            reason: 'Need the current contract source',
            requestedRefs: [],
            requestedPaths: ['packages/shared/src/runtime-contracts/registry.ts']
          }
        }
      }
    }

    const wrapper = mount(ChatTimeline, {
      props: { messages: [errorMessage] },
      global: { stubs: { AgentPortrait: true } }
    })

    expect(wrapper.text()).toContain('RUNTIME_OUTPUT_CONTRACT_VIOLATION')
    expect(wrapper.text()).toContain('不可重试')
    expect(wrapper.text()).toContain('contract-safe')
    expect(wrapper.text()).not.toContain('runtime.output.task_brief')
    expect(wrapper.text()).not.toContain('fnv1a32:deadbeef')
    expect(wrapper.text()).toContain('Need the current contract source')
    expect(wrapper.text()).toContain('packages/shared/src/runtime-contracts/registry.ts')
  })

  it('does not render a backend stack or raw Claude command in a user error card', () => {
    const wrapper = mount(ChatTimeline, {
      props: {
        messages: [{
          id: 'message-safe-runtime-error',
          sessionId: 'session-1',
          senderType: 'system',
          toAgentIds: [],
          messageType: 'error',
          content: 'Claude Code 启动失败。',
          createdAt: '2026-07-16T00:00:00.000Z',
          rawEventId: 'event-safe-runtime-error',
          payload: {
            phase: 'brief_generation',
            fullMessage: 'Claude Code 启动失败，请检查 Runtime 配置。',
            stack: 'Command failed: claude --json-schema {"type":"object"} C:\\private\\workspace',
            runtimeError: {
              code: 'RUNTIME_INVOCATION_ERROR',
              message: 'Claude Code 启动失败，请检查 Runtime 配置。',
              retryable: false,
              details: {
                provider: 'claude_code',
                stage: 'argument_validation',
                diagnosticRef: 'invocation-safe',
                command: 'claude --json-schema {"type":"object"}',
                schema: '{"type":"object"}',
                path: 'C:\\private\\workspace'
              }
            }
          }
        }]
      },
      global: { stubs: { AgentPortrait: true } }
    })

    expect(wrapper.text()).toContain('RUNTIME_INVOCATION_ERROR')
    expect(wrapper.text()).toContain('invocation-safe')
    expect(wrapper.text()).toContain('argument_validation')
    expect(wrapper.text()).not.toContain('--json-schema')
    expect(wrapper.text()).not.toContain('C:\\private\\workspace')
  })

  it('deduplicates structured Runtime errors without a diagnosticRef by stable message and phase', () => {
    const messages = ['first', 'second'].map((suffix, index): ChatMessage => ({
      id: `message-runtime-error-${suffix}`,
      sessionId: 'session-1',
      senderType: 'system',
      toAgentIds: [],
      messageType: 'error',
      content: 'Claude Code could not be started.',
      createdAt: `2026-07-16T00:00:0${index}.000Z`,
      rawEventId: `event-runtime-error-${suffix}`,
      payload: {
        phase: 'brief_generation',
        runtimeError: {
          code: 'RUNTIME_INVOCATION_ERROR',
          message: 'Claude Code could not be started.',
          retryable: false
        }
      }
    }))

    const wrapper = mount(ChatTimeline, {
      props: { messages },
      global: { stubs: { AgentPortrait: true } }
    })

    expect(wrapper.findAll('.timeline-item')).toHaveLength(1)
  })
})
