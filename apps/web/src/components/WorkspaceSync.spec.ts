import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useWorkspaceSync } from '@/composables/useWorkspaceSync'
import { useSessionStore } from '@/stores/session'
import { useEventStore } from '@/stores/event'
import type { SessionDetail } from '@/types/contracts'

function session(id = 'current', status = 'EXECUTING', updatedAt = '2026-09-11T10:00:00Z') {
  return { id, status, updatedAt } as SessionDetail
}
const wrappers: ReturnType<typeof mount>[] = []
function setup() {
  const sessions = useSessionStore()
  sessions.runtimeHealthChecked = true
  sessions.runtimeHealth = { pipelineVersion: 'v2', dataSchemaVersion: 3, runtimeBuildStale: false, buildId: 'test' } as never
  sessions.currentSession = session()
  const events = useEventStore()
  events.connectedSessionId = 'current'
  events.sseConnectionState = 'connected'
  const list = vi.spyOn(sessions, 'loadSessions').mockResolvedValue()
  const detail = vi.spyOn(sessions, 'refreshCurrentSession').mockResolvedValue(sessions.currentSession)
  const workItems = vi.spyOn(sessions, 'loadWorkItems').mockResolvedValue([])
  const files = vi.spyOn(sessions, 'loadFileRevisions').mockResolvedValue({} as never)
  const syncEvents = vi.fn().mockResolvedValue(undefined)
  const history = vi.fn().mockResolvedValue(undefined)
  const wrapper = mount(defineComponent({ setup() { useWorkspaceSync({ syncEvents, refreshDetails: history }); return () => null } }))
  wrappers.push(wrapper)
  return { sessions, events, list, detail, workItems, files, syncEvents, history, wrapper }
}

describe('shared foreground workspace synchronization', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.useFakeTimers()
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  })
  afterEach(() => {
    wrappers.splice(0).forEach(wrapper => wrapper.unmount())
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })
  it('refreshes list, snapshot, messages, files and workflow even when SSE still says connected', async () => {
    const f = setup()
    window.dispatchEvent(new Event('focus'))
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(300)
    expect(f.list).toHaveBeenCalledTimes(1)
    expect(f.detail).toHaveBeenCalledWith('current')
    expect(f.syncEvents).toHaveBeenCalledWith('current', 'EXECUTING')
    expect(f.workItems).toHaveBeenCalledWith('current')
    expect(f.files).toHaveBeenCalledWith('current')
    expect(f.history).toHaveBeenCalledWith('current')
  })
  it('discovers execution resumed by another client after local terminal subscription was closed', async () => {
    const f = setup()
    f.sessions.currentSession = session('current', 'COMPLETED')
    f.events.connectedSessionId = undefined
    f.events.sseConnectionState = 'idle'
    f.detail.mockImplementation(async () => { f.sessions.currentSession = session(); return f.sessions.currentSession })
    await vi.advanceTimersByTimeAsync(15_000)
    expect(f.syncEvents).toHaveBeenCalledWith('current', 'EXECUTING')
  })
  it('coalesces in-flight refreshes and never reconnects the old session after selection changes', async () => {
    const f = setup()
    let finish!: () => void
    f.list.mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(300)
    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(300)
    expect(f.list).toHaveBeenCalledTimes(1)
    f.sessions.currentSession = session('other')
    finish()
    await flushPromises()
    expect(f.syncEvents).not.toHaveBeenCalled()
    expect(f.sessions.currentSession.id).toBe('other')
  })
  it('does not poll hidden pages and removes listeners and timers on unmount', async () => {
    const f = setup()
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(f.list).not.toHaveBeenCalled()
    f.wrapper.unmount()
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(30_000)
    expect(f.list).not.toHaveBeenCalled()
  })
  it('does not let a slow snapshot overwrite a newer status event', async () => {
    const sessions = useSessionStore()
    sessions.currentSession = session()
    vi.spyOn(sessions, 'assertBackendCompatible').mockResolvedValue()
    let respond!: (value: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { respond = resolve })))
    const refresh = sessions.refreshCurrentSession('current')
    await flushPromises()
    sessions.setCurrentStatus('current', 'COMPLETED', '2026-09-11T10:02:00Z')
    respond(new Response(JSON.stringify({ data: session('current', 'EXECUTING', '2026-09-11T10:01:00Z') })))
    await refresh
    expect(sessions.currentSession.status).toBe('COMPLETED')
  })
  it('keeps a newer sidebar status when an older list request arrives late', async () => {
    const sessions = useSessionStore()
    sessions.sessions = [session() as never]
    vi.spyOn(sessions, 'assertBackendCompatible').mockResolvedValue()
    let respond!: (value: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { respond = resolve })))
    const refresh = sessions.loadSessions()
    await flushPromises()
    sessions.setCurrentStatus('current', 'COMPLETED', '2026-09-11T10:02:00Z')
    respond(new Response(JSON.stringify({ data: { items: [session('current', 'EXECUTING', '2026-09-11T10:01:00Z')], hasMore: false } })))
    await refresh
    expect(sessions.sessions[0].status).toBe('COMPLETED')
  })
})
