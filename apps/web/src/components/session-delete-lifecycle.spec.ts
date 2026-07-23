import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(resolve('src/components/SessionWorkspace.vue'), 'utf8')

describe('Session deletion lifecycle', () => {
  it('keeps SSE connected until the backend confirms deletion', () => {
    const deleteBlock = source.slice(
      source.indexOf('async function deleteSession'),
      source.indexOf('async function reconnectBackend')
    )
    expect(deleteBlock.indexOf('await sessionStore.deleteSession(sessionId)')).toBeGreaterThanOrEqual(0)
    expect(deleteBlock.indexOf('eventStore.disconnectSse()')).toBeGreaterThan(
      deleteBlock.indexOf('await sessionStore.deleteSession(sessionId)')
    )
  })
})
