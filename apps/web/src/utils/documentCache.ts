/** Rebuildable text only; File objects, user drafts and pending commands never enter this cache. */
export class DocumentCache {
  private entries = new Map<string, { sessionId: string; body: string; bytes: number }>()
  private sessions: string[] = []
  bytes = 0
  constructor(private budget = 16 * 1024 * 1024, private sessionLimit = 3) {}
  get(key: string) {
    const item = this.entries.get(key)
    if (!item) return undefined
    this.entries.delete(key); this.entries.set(key, item)
    this.sessions = [...this.sessions.filter(id => id !== item.sessionId), item.sessionId]
    return item.body
  }
  set(key: string, sessionId: string, body: string) {
    this.remove(key)
    const bytes = new TextEncoder().encode(body).byteLength
    if (bytes > this.budget) return
    this.entries.set(key, { sessionId, body, bytes }); this.bytes += bytes
    this.sessions = [...this.sessions.filter(id => id !== sessionId), sessionId]
    while (this.sessions.length > this.sessionLimit) {
      const expired = this.sessions.shift()
      for (const [id, entry] of this.entries) if (entry.sessionId === expired) this.remove(id)
    }
    while (this.bytes > this.budget) this.remove(this.entries.keys().next().value!)
  }
  private remove(key: string) {
    this.bytes -= this.entries.get(key)?.bytes ?? 0
    this.entries.delete(key)
  }
}
