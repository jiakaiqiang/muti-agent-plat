import { Injectable } from '@nestjs/common';
import type { AgentRunInput, AgentRunResult } from '@agent-cluster/shared';
import { nowIso } from '../../common/time.js';
import { PersistenceService } from '../persistence/persistence.service.js';
import { GenericLlmRuntimeService } from './generic-llm-runtime.service.js';
import { MockRuntimeService } from './mock-runtime.service.js';

export type RuntimeInvocationLog = {
  id: string;
  runId: string;
  sessionId: string;
  taskId?: string;
  agentId: string;
  agentKey: string;
  runtimeType: string;
  phase: string;
  status: string;
  contextPack: AgentRunInput['contextPack'];
  expectedOutput: AgentRunInput['expectedOutput'];
  usage?: AgentRunResult['usage'];
  error?: AgentRunResult['error'];
  startedAt: string;
  completedAt: string;
};

@Injectable()
export class RuntimeService {
  private readonly invocationsBySession = new Map<string, RuntimeInvocationLog[]>();

  constructor(
    private readonly persistence: PersistenceService,
    private readonly mockRuntime: MockRuntimeService,
    private readonly genericLlmRuntime: GenericLlmRuntimeService
  ) {
    const persisted = this.persistence.getCollection<Record<string, RuntimeInvocationLog[]>>('runtimeInvocationsBySession', {});
    for (const [sessionId, invocations] of Object.entries(persisted)) {
      this.invocationsBySession.set(sessionId, invocations);
    }
  }

  async run(input: AgentRunInput) {
    const startedAt = nowIso();
    const result =
      input.agent.runtimeType === 'generic_llm' ? await this.genericLlmRuntime.run(input) : await this.mockRuntime.run(input);
    this.recordInvocation(input, result, startedAt);
    return result;
  }

  listInvocations(sessionId: string) {
    return this.invocationsBySession.get(sessionId) ?? [];
  }

  private recordInvocation(input: AgentRunInput, result: AgentRunResult, startedAt: string) {
    const log: RuntimeInvocationLog = {
      id: crypto.randomUUID(),
      runId: input.runId,
      sessionId: input.sessionId,
      taskId: input.taskId,
      agentId: input.agent.id,
      agentKey: input.agent.key,
      runtimeType: result.runtimeType,
      phase: input.phase,
      status: result.status,
      contextPack: input.contextPack,
      expectedOutput: input.expectedOutput,
      usage: result.usage,
      error: result.error,
      startedAt,
      completedAt: nowIso()
    };
    this.invocationsBySession.set(input.sessionId, [...this.listInvocations(input.sessionId), log]);
    this.persistence.setCollection('runtimeInvocationsBySession', Object.fromEntries(this.invocationsBySession));
  }
}
