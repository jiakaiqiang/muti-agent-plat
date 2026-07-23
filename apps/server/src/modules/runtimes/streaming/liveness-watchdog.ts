/**
 * 活性看门狗:替代 wall-clock 硬超时。
 *
 * 三种超时(可组合):
 * - `first_frame`:start() 后 firstFrameTimeoutMs 内没有 notifyFrame() → 触发
 * - `idle`:首帧到达后,连续 idleTimeoutMs 无新帧 → 触发
 * - `absolute`:start() 起绝对上限(可选),到点必然触发
 *
 * 语义:
 * - `onTimeout` 每个 watchdog 生命周期内最多触发 1 次(触发即 stop)
 * - `stop()` 幂等,清理所有 timer
 * - `notifyFrame()` 在 stop 后是 no-op
 *
 * 详见 docs/design/multica-refactor-development-design-v1.md §4。
 */

export type WatchdogReason = 'first_frame' | 'idle' | 'absolute';

export type WatchdogTimeoutObservation = {
  reason: WatchdogReason;
  thresholdMs: number;
  startedAtMs: number;
  lastActivityAtMs: number;
  timedOutAtMs: number;
  elapsedMs: number;
  idleForMs: number;
  firstFrameSeen: boolean;
};

export interface LivenessWatchdogOptions {
  firstFrameTimeoutMs: number;
  idleTimeoutMs?: number;
  absoluteTimeoutMs?: number;
  onTimeout: (reason: WatchdogReason, observation: WatchdogTimeoutObservation) => void;
  now?: () => number;
}

export class LivenessWatchdog {
  private readonly opts: LivenessWatchdogOptions;
  private firstFrameTimer: NodeJS.Timeout | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private absoluteTimer: NodeJS.Timeout | undefined;
  private started = false;
  private stopped = false;
  private fired = false;
  private firstFrameSeen = false;
  private startedAtMs = 0;
  private lastActivityAtMs = 0;

  constructor(opts: LivenessWatchdogOptions) {
    this.opts = opts;
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.startedAtMs = this.now();
    this.lastActivityAtMs = this.startedAtMs;
    this.firstFrameTimer = setTimeout(() => this.fire('first_frame'), this.opts.firstFrameTimeoutMs);
    if (this.opts.absoluteTimeoutMs && this.opts.absoluteTimeoutMs > 0) {
      this.absoluteTimer = setTimeout(() => this.fire('absolute'), this.opts.absoluteTimeoutMs);
    }
  }

  notifyFrame(activity = true): void {
    if (!this.started || this.stopped || this.fired) return;
    const observedAtMs = this.now();
    if (!this.firstFrameSeen) {
      this.firstFrameSeen = true;
      if (this.firstFrameTimer) {
        clearTimeout(this.firstFrameTimer);
        this.firstFrameTimer = undefined;
      }
      this.startIdleTimer();
    }
    if (!activity) return;
    this.lastActivityAtMs = observedAtMs;
    this.startIdleTimer();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.clearAll();
  }

  private fire(reason: WatchdogReason): void {
    if (this.fired || this.stopped) return;
    this.fired = true;
    const timedOutAtMs = this.now();
    const thresholdMs =
      reason === 'first_frame'
        ? this.opts.firstFrameTimeoutMs
        : reason === 'idle'
          ? (this.opts.idleTimeoutMs ?? 0)
          : (this.opts.absoluteTimeoutMs ?? 0);
    const observation: WatchdogTimeoutObservation = {
      reason,
      thresholdMs,
      startedAtMs: this.startedAtMs,
      lastActivityAtMs: this.lastActivityAtMs,
      timedOutAtMs,
      elapsedMs: Math.max(0, timedOutAtMs - this.startedAtMs),
      idleForMs: Math.max(0, timedOutAtMs - this.lastActivityAtMs),
      firstFrameSeen: this.firstFrameSeen
    };
    this.clearAll();
    this.opts.onTimeout(reason, observation);
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private startIdleTimer(): void {
    if (!this.opts.idleTimeoutMs || this.opts.idleTimeoutMs <= 0) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.fire('idle'), this.opts.idleTimeoutMs);
  }

  private clearAll(): void {
    if (this.firstFrameTimer) {
      clearTimeout(this.firstFrameTimer);
      this.firstFrameTimer = undefined;
    }
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    if (this.absoluteTimer) {
      clearTimeout(this.absoluteTimer);
      this.absoluteTimer = undefined;
    }
  }
}
