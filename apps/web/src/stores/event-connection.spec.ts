import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { CollaborationEvent } from '@/types/contracts'
import { useEventStore } from './event'

class FakeEventSource {
  static instances: FakeEventSource[] = []
  onopen: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  closed = false
  private readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>()

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    const callback = typeof listener === 'function'
      ? listener as (event: MessageEvent) => void
      : (event: MessageEvent) => listener.handleEvent(event)
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), callback])
  }

  emit(type: string, data: unknown) {
    const message = new MessageEvent(type, { data: JSON.stringify(data) })
    for (const listener of this.listeners.get(type) ?? []) listener(message)
  }

  close() {
    this.closed = true
  }
}

function event(id: string, type: CollaborationEvent['type'] = 'agent_message'): CollaborationEvent {
  return {
    id,
    sessionId: 'session-1',
    type,
    toAgentIds: [],
    content: id,
    metadata: { schemaVersion: '0.1', payload: {} },
    createdAt: new Date().toISOString()
  }
}

function response(items: CollaborationEvent[]) {
  return new Response(JSON.stringify({ data: { items, hasMore: false }, requestId: 'request-1' }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('event stream recovery coordinator', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    FakeEventSource.instances = []
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    vi.stubGlobal('EventSource', FakeEventSource)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response([])))
  })

  afterEach(() => {
    useEventStore().disconnectSse()
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('retries quickly, then enters degraded mode after 30 seconds', async () => {
    const store = useEventStore()
    store.ensureConnected('session-1')

    const first = FakeEventSource.instances[0]!
    first.onerror?.(new Event('error'))
    expect(store.sseConnectionState).toBe('reconnecting')
    expect(first.closed).toBe(true)

    await vi.advanceTimersByTimeAsync(1_000)
    expect(FakeEventSource.instances).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(29_000)
    expect(store.sseConnectionState).toBe('degraded')
    expect(store.sseConnected).toBe(false)
  })

  it('uses the complete fast backoff sequence and keeps retrying every 30 seconds when degraded', async () => {
    const store = useEventStore()
    store.ensureConnected('session-1')
    FakeEventSource.instances[0]!.onerror?.(new Event('error'))

    for (const delay of [1_000, 2_000, 4_000, 8_000, 15_000]) {
      await vi.advanceTimersByTimeAsync(delay)
      FakeEventSource.instances.at(-1)!.onerror?.(new Event('error'))
    }

    expect(store.sseConnectionState).toBe('degraded')
    const attemptsBeforeDegradedRetry = FakeEventSource.instances.length
    await vi.advanceTimersByTimeAsync(30_000)
    expect(FakeEventSource.instances).toHaveLength(attemptsBeforeDegradedRetry + 1)
  })

  it('retries immediately when the browser reports that the network is online again', async () => {
    const store = useEventStore()
    store.ensureConnected('session-1')
    FakeEventSource.instances[0]!.onerror?.(new Event('error'))

    window.dispatchEvent(new Event('online'))

    expect(FakeEventSource.instances).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(FakeEventSource.instances).toHaveLength(2)
  })

  it('keeps reconnecting when atomic backfill fails', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('backfill unavailable'))
    const store = useEventStore()
    store.ensureConnected('session-1')
    const stream = FakeEventSource.instances[0]!

    stream.onopen?.(new Event('open'))
    await vi.waitFor(() => expect(store.sseConnectionState).toBe('reconnecting'))

    expect(store.sseConnected).toBe(false)
    expect(stream.closed).toBe(true)
  })

  it('ignores stale callbacks and retry timers after switching Sessions', async () => {
    const store = useEventStore()
    store.ensureConnected('session-1')
    const stale = FakeEventSource.instances[0]!
    stale.onerror?.(new Event('error'))

    store.ensureConnected('session-2')
    const current = FakeEventSource.instances[1]!
    stale.onopen?.(new Event('open'))
    stale.emit('collaboration-event', event('stale-event'))
    await vi.advanceTimersByTimeAsync(2_000)

    expect(FakeEventSource.instances).toHaveLength(2)
    expect(store.connectedSessionId).toBe('session-2')
    expect(store.eventsForSession('session-1')).toEqual([])
    expect(current.closed).toBe(false)
  })

  it('atomically merges backfill before buffered live events and deduplicates by server id', async () => {
    const backfill = deferred<Response>()
    vi.mocked(fetch).mockReturnValue(backfill.promise)
    const store = useEventStore()
    store.ensureConnected('session-1')
    const stream = FakeEventSource.instances[0]!

    stream.onopen?.(new Event('open'))
    stream.emit('collaboration-event', event('live-event'))
    expect(store.eventsForSession('session-1')).toEqual([])

    backfill.resolve(response([event('history-event'), event('live-event')]))
    await vi.waitFor(() => expect(store.sseConnectionState).toBe('connected'))

    expect(store.eventsForSession('session-1').map((item) => item.id)).toEqual([
      'history-event',
      'live-event'
    ])
    expect(store.lastCommittedServerEventIdBySessionId['session-1']).toBe('live-event')
  })

  it('keeps optimistic events outside the server cursor and reconciles confirmations', async () => {
    const store = useEventStore()
    store.appendEvent(event('server-event'))
    store.appendEvent({
      ...event('evt-local-confirmation-1', 'user_confirmation_resolved'),
      metadata: { schemaVersion: '0.1', payload: { confirmationId: 'confirmation-1' } }
    })

    expect(store.lastCommittedServerEventIdBySessionId['session-1']).toBe('server-event')
    await store.loadEvents('session-1', { append: true })
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toContain('afterEventId=server-event')

    store.appendEvent({
      ...event('confirmed-event', 'user_confirmation_resolved'),
      metadata: { schemaVersion: '0.1', payload: { confirmationId: 'confirmation-1' } }
    })
    expect(store.eventsForSession('session-1').map((item) => item.id)).toEqual([
      'server-event',
      'confirmed-event'
    ])
  })

  it('disconnect aborts in-flight backfill and clears scheduled retries', async () => {
    let backfillSignal: AbortSignal | undefined
    vi.mocked(fetch).mockImplementation((_input, init) => {
      backfillSignal = init?.signal ?? undefined
      return new Promise<Response>(() => undefined)
    })
    const store = useEventStore()
    store.ensureConnected('session-1')
    const stream = FakeEventSource.instances[0]!
    stream.onopen?.(new Event('open'))
    await Promise.resolve()

    store.disconnectSse()
    expect(backfillSignal?.aborted).toBe(true)
    expect(stream.closed).toBe(true)
    expect(store.sseConnectionState).toBe('idle')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(FakeEventSource.instances).toHaveLength(1)
  })

  it('atomically captures live tail events before a terminal Session disconnects', async () => {
    const store = useEventStore()
    store.ensureConnected('session-1')
    const stream = FakeEventSource.instances[0]!
    stream.onopen?.(new Event('open'))
    await vi.waitFor(() => expect(store.sseConnectionState).toBe('connected'))

    const finalBackfill = deferred<Response>()
    vi.mocked(fetch).mockReturnValueOnce(finalBackfill.promise)
    const finalizing = store.finalizeSessionEvents('session-1')
    stream.emit('collaboration-event', event('terminal-tail-event'))
    finalBackfill.resolve(response([event('terminal-status', 'session_status_changed')]))
    await finalizing

    expect(store.eventsForSession('session-1').map((item) => item.id)).toEqual([
      'terminal-status',
      'terminal-tail-event'
    ])
    expect(store.sseConnectionState).toBe('idle')
    expect(stream.closed).toBe(true)
  })

  it('uses heartbeat frames only for liveness and reconnects a silent half-open stream', async () => {
    const store = useEventStore()
    store.ensureConnected('session-1')
    const stream = FakeEventSource.instances[0]!
    stream.onopen?.(new Event('open'))
    await vi.waitFor(() => expect(store.sseConnectionState).toBe('connected'))

    stream.emit('heartbeat', { time: new Date().toISOString() })
    expect(store.eventsForSession('session-1')).toEqual([])
    await vi.advanceTimersByTimeAsync(44_999)
    expect(stream.closed).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(stream.closed).toBe(true)
    expect(store.sseConnectionState).toBe('reconnecting')
  })
})
