import type {
  AgentRunResult,
  AgentRuntimeEvent,
  InvocationPlan,
  LocalRuntimePermissionPolicy,
  RuntimeOutput,
  MinimalTaskSubmission,
  RuntimeType,
  RuntimeUsage
} from '@agent-cluster/shared';
import type { LocalRuntimeProviderConnectionInput } from '@agent-cluster/shared';

export type SupportedLocalRuntimeType = Extract<RuntimeType, 'codex' | 'claude_code'>;

export type LocalRuntimeAdapterContext = {
  plan: InvocationPlan;
  cwd: string;
  signal: AbortSignal;
  permissions: LocalRuntimePermissionPolicy;
  providerConnection?: LocalRuntimeProviderConnectionInput;
  /**
   * 把运行中的中间事件回传给服务端时间线。可选:不传时适配器只在
   * 结束时返回结果,行为与回传能力引入前一致。
   */
  emit?: (event: AgentRuntimeEvent) => void;
};

export type LocalRuntimeAdapterResult = {
  output: RuntimeOutput | MinimalTaskSubmission;
  usage: RuntimeUsage;
  runtimeSession?: AgentRunResult['runtimeSession'];
};

export interface LocalRuntimeAdapter {
  readonly runtimeType: SupportedLocalRuntimeType;
  detectVersion(): Promise<string | undefined>;
  execute(context: LocalRuntimeAdapterContext): Promise<LocalRuntimeAdapterResult>;
}
