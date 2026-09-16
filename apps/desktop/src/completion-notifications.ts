export type NotificationSession = { id: string; title: string; updatedAt: string };
export type NotificationEvent = { id: string; type: string; createdAt: string; metadata?: { payload?: { status?: string } } };
export type CompletionNotice = { sessionId: string; eventId: string; title: string };

/** Main-process polling stays active when the renderer is hidden or on another route. */
export class CompletionNotifications {
  private checkpoints = new Map<string, { updatedAt: string; afterEventId?: string }>();
  private initialized = false;
  private stopped = false;
  private pending = false;
  private timer?: ReturnType<typeof setInterval>;
  constructor(private dependencies: {
    sessions(): Promise<NotificationSession[]>;
    events(sessionId: string, afterEventId?: string): Promise<NotificationEvent[]>;
    notify(notice: CompletionNotice): void;
    enabled(): boolean;
    onError(error: unknown): void;
  }) {}

  start() {
    void this.poll();
    this.timer = setInterval(() => { void this.poll(); }, 5000);
    this.timer.unref?.();
  }
  stop() { this.stopped = true; if (this.timer) clearInterval(this.timer); }

  async poll() {
    if (this.stopped || this.pending) return;
    this.pending = true;
    try {
      const sessions = await this.dependencies.sessions();
      if (this.stopped) return;
      if (!this.initialized) {
        for (const item of sessions) this.checkpoints.set(item.id, { updatedAt: item.updatedAt });
        this.initialized = true;
        return; // History is a baseline, never a burst of completion notifications.
      }
      for (const item of sessions) {
        if (this.stopped) return;
        const previous = this.checkpoints.get(item.id);
        if (previous?.updatedAt === item.updatedAt) continue;
        try {
          const events = await this.dependencies.events(item.id, previous?.afterEventId);
          if (this.stopped) return;
          const seen = new Set<string>();
          for (const event of events) {
            if (!event.id || seen.has(event.id)) continue;
            seen.add(event.id);
            if (previous && Date.parse(event.createdAt) <= Date.parse(previous.updatedAt)) continue;
            if (event.type !== 'session_status_changed' || event.metadata?.payload?.status !== 'COMPLETED') continue;
            if (this.dependencies.enabled()) this.dependencies.notify({ sessionId: item.id, eventId: event.id, title: item.title });
          }
          this.checkpoints.set(item.id, { updatedAt: item.updatedAt, afterEventId: events.at(-1)?.id ?? previous?.afterEventId });
        } catch (error) { this.dependencies.onError(error); } // Retry this session next poll, without blocking others.
      }
      const ids = new Set(sessions.map(item => item.id));
      for (const id of this.checkpoints.keys()) if (!ids.has(id)) this.checkpoints.delete(id);
    } catch (error) { if (!this.stopped) this.dependencies.onError(error); }
    finally { this.pending = false; }
  }
}

export function notificationText(title: string) {
  return { title: '任务已完成', body: `${title.replace(/[\r\n\t]/g, ' ').trim().slice(0, 100) || '会话任务'}\n点击查看执行结果` };
}
