import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(resolve('src/components/SessionWorkspace.vue'), 'utf8')

describe('Session deletion lifecycle', () => {
  it('opens a visible confirmation before invoking the delete request', () => {
    expect(source).toContain('@delete="requestDeleteSession"')
    expect(source).toContain('aria-label="确认删除会话"')
    expect(source).toContain('data-testid="session-confirm-delete"')

    const requestBlock = source.slice(
      source.indexOf('function requestDeleteSession'),
      source.indexOf('async function confirmDeleteSession')
    )
    expect(requestBlock).not.toContain('sessionStore.deleteSession')
  })

  it('keeps SSE connected until the backend confirms deletion', () => {
    const deleteBlock = source.slice(
      source.indexOf('async function confirmDeleteSession'),
      source.indexOf('async function createSession')
    )
    expect(deleteBlock.indexOf('await sessionStore.deleteSession(sessionId)')).toBeGreaterThanOrEqual(0)
    expect(deleteBlock.indexOf('eventStore.disconnectSse()')).toBeGreaterThan(
      deleteBlock.indexOf('await sessionStore.deleteSession(sessionId)')
    )
  })

  it('keeps the confirmation visible with an explicit deleting state and inline error', () => {
    expect(source).toContain("isPendingSessionDeleting ? '删除中…' : '确认删除'")
    expect(source).toContain('v-if="deleteSessionError"')
    expect(source).toContain("deleteSessionError.value = error instanceof Error ? error.message : '删除会话失败'")
  })
})
