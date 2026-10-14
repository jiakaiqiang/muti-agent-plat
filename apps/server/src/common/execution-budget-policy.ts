import type { RuntimeHealthSnapshot } from '@agent-cluster/shared';

export type BudgetFallbackReason = 'runtime_disconnected' | 'provider_or_tool_error';

/** Reads the same live supervision state as the UI; never maintains a second error flag. */
export class ExecutionBudgetHealth {
  constructor(private readonly deadlineAt: number) {}

  check(now: number, connected: boolean, health?: RuntimeHealthSnapshot): { waitMs: number; reason?: never } | { reason: BudgetFallbackReason; waitMs?: never } {
    if (now < this.deadlineAt) return { waitMs: this.deadlineAt - now };
    if (health && ['terminal', 'stopping'].includes(health.stage)) return { waitMs: 5_000 };
    if (!connected) return { reason: 'runtime_disconnected' };
    if (!health?.historical && health?.health === 'abnormal' &&
      ['provider_retry', 'provider_error', 'tool_error', 'control_disconnected'].includes(health.reasonCode)) {
      return { reason: health.reasonCode === 'control_disconnected' ? 'runtime_disconnected' : 'provider_or_tool_error' };
    }
    // Silence/probe failure remains unknown. Output corrections have their own existing hard allowance.
    return { waitMs: 5_000 };
  }
}
