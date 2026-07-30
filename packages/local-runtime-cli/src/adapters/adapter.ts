import type {
  AgentRunResult,
  InvocationPlan,
  LocalRuntimePermissionPolicy,
  RuntimeOutput,
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
};

export type LocalRuntimeAdapterResult = {
  output: RuntimeOutput;
  usage: RuntimeUsage;
  runtimeSession?: AgentRunResult['runtimeSession'];
};

export interface LocalRuntimeAdapter {
  readonly runtimeType: SupportedLocalRuntimeType;
  detectVersion(): Promise<string | undefined>;
  execute(context: LocalRuntimeAdapterContext): Promise<LocalRuntimeAdapterResult>;
}
