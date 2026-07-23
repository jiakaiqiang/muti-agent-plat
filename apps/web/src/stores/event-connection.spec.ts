import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useEventStore } from './event'

class FakeEventSource {
  static instances: FakeEventSource[] = []
  onopen: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  closed = false

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this)
  }

  addEventListener() {}

  close() {
    this.closed = true
  }
}

describe('event stream connection state', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    FakeEventSource.instances = []
    vi.stubGlobal('EventSource', FakeEventSource)
  })

  afterEach(() => vi.unstubAllGlobals())

  it('distinguishes connecting, disconnected, and manually idle states', () => {
    const store = useEventStore()
    store.connectSse('session-1')

    expect(store.sseConnectionState).toBe('connecting')
    const stream = FakeEventSource.instances[0]!
    stream.onerror?.(new Event('error'))
    expect(store.sseConnected).toBe(false)
    expect(store.sseConnectionState).toBe('disconnected')
    expect(store.lastSseErrorAt).toBeTruthy()

    store.disconnectSse()
    expect(stream.closed).toBe(true)
    expect(store.sseConnectionState).toBe('idle')
  })
})
