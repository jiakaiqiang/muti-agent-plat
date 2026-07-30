import type { AgentRunResult, AgentRuntimeEvent, ExecutionTermination, InvocationPlan, RuntimeModelProvider } from '@agent-cluster/shared';

export type ServerRuntimeCredential = {
  provider: Extract<RuntimeModelProvider, 'openai-compatible' | 'anthropic-compatible'>;
  baseUrl: string;
  model: string;
  apiKey: string;
};

export type ServerRuntimeWorkerRequest =
  | { kind: 'worker.start'; payload: { plan: InvocationPlan; workDir: string; credential?: ServerRuntimeCredential } }
  | { kind: 'worker.cancel'; payload: { invocationId: string; termination?: ExecutionTermination } };

export type ServerRuntimeWorkerResponse =
  | { kind: 'worker.ready'; payload: { pid: number } }
  | { kind: 'worker.event'; payload: AgentRuntimeEvent }
  | { kind: 'worker.result'; payload: AgentRunResult }
  | { kind: 'worker.error'; payload: { invocationId: string; message: string } };
