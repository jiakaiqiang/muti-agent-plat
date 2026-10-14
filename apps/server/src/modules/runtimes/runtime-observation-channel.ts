import type { AgentRuntimeEvent } from '@agent-cluster/shared';

/** Bounded metadata channel; final business output never travels here. */
export class RuntimeObservationChannel implements AsyncIterable<AgentRuntimeEvent> {
  private readonly values: AgentRuntimeEvent[] = [];
  private readonly waiters: Array<(value: IteratorResult<AgentRuntimeEvent>) => void> = [];
  private closed = false;
  push(event: AgentRuntimeEvent) {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value: event });
    else { if (this.values.length >= 512) this.values.shift(); this.values.push(event); }
  }
  close() {
    this.closed = true;
    while (this.waiters.length) this.waiters.shift()!({ done: true, value: undefined });
  }
  [Symbol.asyncIterator](): AsyncIterator<AgentRuntimeEvent> {
    return { next: () => {
      const value = this.values.shift();
      if (value) return Promise.resolve({ done: false, value });
      if (this.closed) return Promise.resolve({ done: true, value: undefined });
      return new Promise(resolve => this.waiters.push(resolve));
    } };
  }
}
