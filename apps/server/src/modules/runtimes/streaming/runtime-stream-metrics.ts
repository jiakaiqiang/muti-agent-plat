import type { RuntimeStreamMetrics } from '@agent-cluster/shared';

export class RuntimeStreamMetricsCollector {
  private readonly startedAtMs: number;
  private firstFrameAtMs: number | undefined;
  private lastActivityAtMs: number;
  private maxInterFrameGapMs = 0;
  private frameCount = 0;

  constructor(private readonly now: () => number = Date.now) {
    this.startedAtMs = this.now();
    this.lastActivityAtMs = this.startedAtMs;
  }

  notifyFrame(): void {
    const current = this.now();
    if (this.firstFrameAtMs === undefined) {
      this.firstFrameAtMs = current;
    } else {
      this.maxInterFrameGapMs = Math.max(this.maxInterFrameGapMs, current - this.lastActivityAtMs);
    }
    this.lastActivityAtMs = current;
    this.frameCount += 1;
  }

  complete(): RuntimeStreamMetrics {
    const completedAtMs = this.now();
    return {
      startedAt: new Date(this.startedAtMs).toISOString(),
      completedAt: new Date(completedAtMs).toISOString(),
      durationMs: Math.max(0, completedAtMs - this.startedAtMs),
      frameCount: this.frameCount,
      firstFrameAt: this.firstFrameAtMs === undefined ? undefined : new Date(this.firstFrameAtMs).toISOString(),
      firstFrameLatencyMs:
        this.firstFrameAtMs === undefined ? undefined : Math.max(0, this.firstFrameAtMs - this.startedAtMs),
      lastActivityAt: new Date(this.lastActivityAtMs).toISOString(),
      maxInterFrameGapMs: this.maxInterFrameGapMs
    };
  }
}
