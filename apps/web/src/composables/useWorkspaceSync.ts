import { onMounted, onBeforeUnmount, watch } from 'vue'
import { useSessionStore } from '@/stores/session'
import { useEventStore } from '@/stores/event'
import type { SessionStatus } from '@/types/contracts'

// Both clients own their layout, but share the same foreground reconciliation.
export function useWorkspaceSync(options: {
  syncEvents: (id: string, status?: SessionStatus) => Promise<void>
  refreshDetails?: (id: string) => Promise<unknown>
}) {
  const sessions = useSessionStore()
  const events = useEventStore()
  let disposed = false
  let refreshing = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let interval: ReturnType<typeof setInterval> | undefined

  async function refresh() {
    if (disposed || refreshing || document.visibilityState === 'hidden' ||
        !sessions.backendCompatible || !sessions.runtimeHealthChecked || sessions.loading) return
    refreshing = true
    const id = sessions.currentSession?.id
    try {
      const results: PromiseSettledResult<unknown>[] = await Promise.allSettled([
        sessions.loadSessions(),
        ...(id ? [sessions.refreshCurrentSession(id)] : [])
      ])
      if (disposed || sessions.currentSession?.id !== id) return
      if (id) {
        results.push(...await Promise.allSettled([
          options.syncEvents(id, sessions.currentSession?.status),
          sessions.loadWorkItems(id),
          sessions.loadFileRevisions(id),
          ...(options.refreshDetails ? [options.refreshDetails(id)] : [])
        ]))
      }
      for (const result of results) {
        if (result.status === 'rejected') console.warn('Workspace synchronization failed; will retry.', result.reason)
      }
    } finally { refreshing = false }
  }

  function schedule() {
    if (disposed || document.visibilityState === 'hidden') return
    clearTimeout(timer)
    timer = setTimeout(() => { void refresh() }, 250)
  }
  watch(() => {
    const id = sessions.currentSession?.id
    return id ? [...events.eventsForSession(id)].reverse().find(event =>
      /^(session_status_changed|workflow_|task_|artifact_|brief_|user_confirmation_|final_delivery_created)/.test(event.type)
    )?.id : undefined
  }, schedule)
  onMounted(() => {
    window.addEventListener('focus', schedule)
    window.addEventListener('online', schedule)
    document.addEventListener('visibilitychange', schedule)
    interval = setInterval(() => { void refresh() }, 15_000)
  })
  onBeforeUnmount(() => {
    disposed = true
    clearTimeout(timer)
    clearInterval(interval)
    window.removeEventListener('focus', schedule)
    window.removeEventListener('online', schedule)
    document.removeEventListener('visibilitychange', schedule)
  })
}
