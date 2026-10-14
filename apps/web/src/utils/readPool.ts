/** Subscriber cancellation never cancels another view's read, and never handles writes. */
export function createReadPool() {
  const entries = new Map<string, { controller: AbortController; promise: Promise<unknown>; subscribers: number }>()
  return function read<T>(key: string, fetcher: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(new DOMException('读取已取消', 'AbortError'))
    let entry = entries.get(key)
    if (!entry || entry.controller.signal.aborted) {
      const controller = new AbortController()
      let promise: Promise<T>
      try { promise = fetcher(controller.signal) } catch (error) { promise = Promise.reject(error) }
      const created = { controller, promise, subscribers: 0 }
      entry = created
      entries.set(key, created)
      void created.promise.finally(() => { if (entries.get(key) === created) entries.delete(key) }).catch(() => undefined)
    }
    const owner = entry
    owner.subscribers++
    return new Promise<T>((resolve, reject) => {
      let settled = false
      const finish = (callback: () => void) => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', abort)
        owner.subscribers--
        if (owner.subscribers === 0 && entries.get(key) === owner) {
          entries.delete(key)
          owner.controller.abort()
        }
        callback()
      }
      const abort = () => finish(() => reject(new DOMException('读取已取消', 'AbortError')))
      signal?.addEventListener('abort', abort, { once: true })
      owner.promise.then(value => finish(() => resolve(value as T)), error => finish(() => reject(error)))
    })
  }
}

const pools = new WeakMap<object, ReturnType<typeof createReadPool>>()
export function readPoolFor(owner: object) {
  let pool = pools.get(owner)
  if (!pool) { pool = createReadPool(); pools.set(owner, pool) }
  return pool
}
