import type { RuntimeStreamFrame } from './runtime-stream-frame.js';

/**
 * per-runId 帧通道:adapter 生产 → orchestrator 消费。
 * - **有界**:达到 capacity 时优先丢弃 `assistant_text`(增量文本),保留
 *   `tool_use`/`tool_result`/`result`/`system`/`stderr_tail`。
 * - **单消费者**:第二次 `[Symbol.asyncIterator]()` 抛错。
 * - **close 后**已入队帧可被消费完;之后 iterator 终止。
 *
 * 详见 docs/design/multica-refactor-development-design-v1.md §3.2、§3.6。
 */

const isPriorityFrame = (f: RuntimeStreamFrame): boolean => f.kind !== 'assistant_text';

export interface RunChannelOptions {
  capacity: number;
}

type Resolver = (step: IteratorResult<RuntimeStreamFrame>) => void;

export class RunChannel implements AsyncIterable<RuntimeStreamFrame> {
  private readonly capacity: number;
  private readonly queue: RuntimeStreamFrame[] = [];
  private readonly pendingResolvers: Resolver[] = [];
  private closed = false;
  private consumed = false;

  constructor(opts: RunChannelOptions) {
    if (opts.capacity < 1) {
      throw new Error('RunChannel capacity must be >= 1');
    }
    this.capacity = opts.capacity;
  }

  push(frame: RuntimeStreamFrame): void {
    if (this.closed) return; // 关闭后拒收
    if (this.pendingResolvers.length > 0) {
      // 有等待中的消费者,直接投递
      const resolve = this.pendingResolvers.shift()!;
      resolve({ value: frame, done: false });
      return;
    }
    this.queue.push(frame);
    while (this.queue.length > this.capacity) {
      // 找一个 assistant_text 丢弃,保护优先帧
      const dropIdx = this.queue.findIndex((f) => !isPriorityFrame(f));
      if (dropIdx === -1) {
        // 全是优先帧,只能丢队头(极端情况)
        this.queue.shift();
      } else {
        this.queue.splice(dropIdx, 1);
      }
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    // 唤醒所有等待者:队列中还有数据的话消费者会先拿到那些
    while (this.pendingResolvers.length > 0 && this.queue.length > 0) {
      const resolve = this.pendingResolvers.shift()!;
      const frame = this.queue.shift()!;
      resolve({ value: frame, done: false });
    }
    while (this.pendingResolvers.length > 0) {
      const resolve = this.pendingResolvers.shift()!;
      resolve({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<RuntimeStreamFrame> {
    if (this.consumed) {
      throw new Error('RunChannel already streaming (single-consumer only)');
    }
    this.consumed = true;
    return {
      next: (): Promise<IteratorResult<RuntimeStreamFrame>> => {
        if (this.queue.length > 0) {
          const frame = this.queue.shift()!;
          return Promise.resolve({ value: frame, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as never, done: true });
        }
        return new Promise<IteratorResult<RuntimeStreamFrame>>((resolve) => {
          this.pendingResolvers.push(resolve);
        });
      },
      return: (): Promise<IteratorResult<RuntimeStreamFrame>> => {
        this.close();
        return Promise.resolve({ value: undefined as never, done: true });
      }
    };
  }
}
