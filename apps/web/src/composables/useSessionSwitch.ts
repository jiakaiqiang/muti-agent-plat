import { onBeforeUnmount, reactive } from 'vue'

export interface SessionSwitchContext {
  sessionId: string
  epoch: number
  signal: AbortSignal
  isCurrent: () => boolean
}

/** Owns display reads only. Never pass this signal to a business command. */
export function createSessionSwitch(options: {
  release: () => void
  load: (context: SessionSwitchContext) => Promise<void>
}) {
  const state = reactive({ targetSessionId: '', epoch: 0, phase: 'idle' as 'idle' | 'loading' | 'ready' | 'error', error: '' })
  let controller: AbortController | undefined
  let disposed = false
  async function select(sessionId: string) {
    if (disposed || (state.targetSessionId === sessionId && ['loading', 'ready'].includes(state.phase))) return
    controller?.abort()
    const owner = new AbortController()
    controller = owner
    const epoch = ++state.epoch
    state.targetSessionId = sessionId
    state.phase = 'loading'
    state.error = ''
    options.release()
    const isCurrent = () => !disposed && !owner.signal.aborted && state.epoch === epoch
    try {
      await options.load({ sessionId, epoch, signal: owner.signal, isCurrent })
      if (isCurrent()) state.phase = 'ready'
    } catch (error) {
      if (!isCurrent()) return
      state.error = error instanceof Error ? error.message : '加载会话失败，请重试。'
      state.phase = 'error'
    }
  }
  function dispose() {
    disposed = true
    controller?.abort()
    options.release()
  }
  return { state, select, dispose }
}

export function useSessionSwitch(options: Parameters<typeof createSessionSwitch>[0]) {
  const navigation = createSessionSwitch(options)
  onBeforeUnmount(navigation.dispose)
  return navigation
}
