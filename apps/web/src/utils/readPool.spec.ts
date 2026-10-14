import { describe, expect, it, vi } from 'vitest'
import { createReadPool } from './readPool'
describe('shared read cancellation', () => {
  it('keeps another subscriber alive and starts a fresh transport after all subscribers cancel', async () => {
    const read = createReadPool()
    let signal!: AbortSignal
    let done!: (value: number) => void
    const fetcher = vi.fn((value: AbortSignal) => { signal = value; return new Promise<number>(resolve => { done = resolve }) })
    const a = new AbortController()
    const first = read('A', fetcher, a.signal).catch(error => error.name)
    const second = read('A', fetcher)
    await Promise.resolve()
    a.abort()
    expect(await first).toBe('AbortError')
    expect(signal.aborted).toBe(false)
    done(1)
    expect(await second).toBe(1)
    expect(fetcher).toHaveBeenCalledTimes(1)
    const b = new AbortController()
    const third = read('B', fetcher, b.signal).catch(error => error.name)
    await Promise.resolve()
    b.abort()
    expect(await third).toBe('AbortError')
    expect(signal.aborted).toBe(true)
    const fourth = read('B', fetcher)
    await Promise.resolve()
    done(4)
    expect(await fourth).toBe(4)
    expect(fetcher).toHaveBeenCalledTimes(3)
  })
})
