import type { AgentRunInput } from '@agent-cluster/shared';

/**
 * M4-03 · 根据 phase 和 M4-02 prior invocation 结果构造 AgentRunInput.options。
 * 仅在 task_execution 阶段透传 resume;其余阶段一律不塞。
 */
export type PriorInvocationRef = {
  cliSessionId?: string;
  workDir?: string;
};

export function buildResumeOptions(
  phase: AgentRunInput['phase'],
  prior: PriorInvocationRef | undefined
): Record<string, unknown> | undefined {
  if (phase !== 'task_execution') return undefined;
  if (!prior || (!prior.cliSessionId && !prior.workDir)) return undefined;
  return {
    resume: {
      cliSessionId: prior.cliSessionId,
      workDir: prior.workDir
    }
  };
}
