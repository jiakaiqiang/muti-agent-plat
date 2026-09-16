import type { AgentRuntimeEvent, RuntimeError } from '@agent-cluster/shared';

/** Supervises the CLI's own correction loop; it never starts a new model invocation. */
export function structuredOutputGuard(input: {
  maxCorrections: number;
  timeoutMs: number;
  fail: (error: RuntimeError) => void;
}) {
  const seen = new Set<string>();
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const stop = (error: RuntimeError) => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    input.fail(error);
  };
  return {
    observe(frame: AgentRuntimeEvent) {
      const md = frame.metadata ?? {};
      if (stopped || frame.type !== 'tool_completed' || md.name !== 'StructuredOutput') return;
      if (typeof md.toolCallId !== 'string' || seen.has(md.toolCallId)) return;
      seen.add(md.toolCallId);
      if (md.isError !== true) {
        clearTimeout(timer);
        timer = undefined;
        return;
      }
      failures += 1;
      if (failures > input.maxCorrections) {
        stop({ code: 'RUNTIME_OUTPUT_CONTRACT_VIOLATION', message: '输出格式仍未通过校验，已停止本次调用，可从检查点重新尝试。', retryable: false,
          details: { structuredOutputGuard: true, failureCount: failures, maxCorrections: input.maxCorrections } });
      } else if (!timer) {
        timer = setTimeout(() => stop({ code: 'RUNTIME_TIMEOUT', message: '输出格式纠正超时，已请求停止本次调用。', retryable: false,
          details: { structuredOutputGuard: true, failureCount: failures, timeoutMs: input.timeoutMs } }), input.timeoutMs);
      }
    },
    dispose() { stopped = true; clearTimeout(timer); }
  };
}
