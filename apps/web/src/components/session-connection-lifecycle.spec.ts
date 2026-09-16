import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(resolve('src/components/SessionWorkspace.vue'), 'utf8')

describe('Session event connection lifecycle', () => {
  it('performs final reconciliation and stops reconnecting for terminal Sessions', () => {
    const connectionBlock = source.slice(
      source.indexOf('const terminalSessionStatuses'),
      source.indexOf('function requestDeleteSession')
    )

    expect(connectionBlock).toContain("['COMPLETED', 'FAILED', 'CANCELLED']")
    expect(connectionBlock).toContain('eventStore.finalizeSessionEvents(sessionId)')
    expect(connectionBlock).toContain('eventStore.ensureConnectedAndReconcile(sessionId)')
  })

  it('separates SSE degradation from backend health and keeps message input enabled', () => {
    expect(source).toContain("state === 'reconnecting' || state === 'degraded'")
    expect(source).toContain('await eventStore.probeBackendReachability()')
    expect(source).toContain("title: '实时连接正在恢复'")
    expect(source).toContain("title: '实时更新暂不可用'")
    expect(source).toContain("backendReachability.value === 'unreachable'")
    expect(source).not.toContain("eventStore.sseConnectionState === 'disconnected'")
  })

  it('treats an interrupted Session as writable while a truly unreachable backend stays disabled', () => {
    expect(source).toContain('const backendUnreachable = computed')
    expect(source).toContain('const sessionInterrupted = computed')
    expect(source).not.toContain('const backendDisconnected')
    expect(source).toContain(':disabled="backendUnreachable"')
    expect(source).toContain("backendUnreachable ? '后端离线，恢复连接后可继续发送'")
    expect(source).toContain('可以直接输入新需求或补充说明')
    expect(source).not.toContain('系统不会自动重新连接或续跑')
  })
})
