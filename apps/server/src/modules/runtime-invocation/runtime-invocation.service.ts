import { BadRequestException, Injectable } from '@nestjs/common';
import type { AgentRunResult } from '@agent-cluster/shared';
import type { ResolveInvocationInput } from '../runtime-routing/invocation-resolver.service.js';
import { InvocationResolverService } from '../runtime-routing/invocation-resolver.service.js';
import { RuntimeService } from '../runtimes/runtime.service.js';

@Injectable()
export class RuntimeInvocationService {
  constructor(
    private readonly resolver: InvocationResolverService,
    private readonly runtime: RuntimeService
  ) {}

  async invoke(input: ResolveInvocationInput, signal?: AbortSignal): Promise<AgentRunResult> {
    let operation = await this.runtime.operations.begin({ id: input.operationId ?? input.invocationId,
      sessionId: input.sessionId, taskId: input.taskId, phase: input.phase });
    if (operation.status === 'paused') operation = await this.runtime.operations.resume(input.sessionId, operation.id);
    const plan = this.resolver.resolve(input);
    plan.operation = operation;
    if (plan.pendingApprovals?.length) {
      throw new BadRequestException('System Runtime invocation cannot wait for Tool approval.');
    }
    const execution = this.runtime.start(plan, signal);
    const drainEvents = (async () => {
      for await (const _event of execution.events) {
        // RuntimeService owns durable invocation logs; callers own user-facing events.
      }
    })();
    const [result] = await Promise.all([execution.result, drainEvents]);
    return result;
  }
}
