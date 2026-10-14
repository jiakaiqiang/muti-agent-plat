import { describe, expect, it, vi } from 'vitest'
import { createSessionSwitch, type SessionSwitchContext } from './useSessionSwitch'

describe('display navigation ownership', () => {
  it('ignores late success/error/finally, including A → B → A', async () => {
    const reads: { owner: SessionSwitchContext; finish: () => void; fail: (error: Error) => void }[] = []
    const release = vi.fn()
    let displayed = ''
    const navigation = createSessionSwitch({ release, load: async owner => {
      await new Promise<void>((finish, fail) => reads.push({ owner, finish, fail }))
      if (owner.isCurrent()) displayed = owner.sessionId
    } })
    const first = navigation.select('A')
    const middle = navigation.select('B')
    const latest = navigation.select('A')
    expect(reads[0].owner.signal.aborted).toBe(true)
    reads[0].finish()
    reads[1].fail(new Error('old failure'))
    await Promise.all([first, middle])
    expect(displayed).toBe('')
    expect(navigation.state.phase).toBe('loading')
    expect(navigation.state.error).toBe('')
    reads[2].finish()
    await latest
    expect(displayed).toBe('A')
    expect(navigation.state.phase).toBe('ready')
    await navigation.select('A')
    expect(reads).toHaveLength(3)
    navigation.dispose()
    expect(release).toHaveBeenCalledTimes(4)
  })

  it('allows explicit retry after failure and ignores completion after disposal', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('会话不存在')).mockResolvedValue(undefined)
    const navigation = createSessionSwitch({ release: vi.fn(), load })
    await navigation.select('missing')
    expect(navigation.state.phase).toBe('error')
    await navigation.select('missing')
    expect(navigation.state.phase).toBe('ready')
    navigation.dispose()
    await navigation.select('B')
    expect(load).toHaveBeenCalledTimes(2)
  })
})
