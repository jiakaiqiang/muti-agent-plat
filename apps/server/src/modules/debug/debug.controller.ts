import { Controller, Get, Param } from '@nestjs/common';
import { ok } from '../../common/api-response.js';
import { EventsService } from '../events/events.service.js';
import { RuntimeService } from '../runtimes/runtime.service.js';

@Controller('sessions/:sessionId/debug')
export class DebugController {
  constructor(
    private readonly events: EventsService,
    private readonly runtime: RuntimeService
  ) {}

  @Get('context-packs')
  contextPacks(@Param('sessionId') sessionId: string) {
    return ok({
      items: this.runtime.listInvocations(sessionId).map((invocation) => ({
        invocationId: invocation.id,
        runId: invocation.runId,
        taskId: invocation.taskId,
        agentId: invocation.agentId,
        agentKey: invocation.agentKey,
        phase: invocation.phase,
        status: invocation.status,
        contextPack: invocation.contextPack,
        createdAt: invocation.startedAt
      })),
      hasMore: false
    });
  }

  @Get('runtime-invocations')
  runtimeInvocations(@Param('sessionId') sessionId: string) {
    return ok({
      items: this.runtime.listInvocations(sessionId).map(({ contextPack, ...invocation }) => ({
        ...invocation,
        contextPackSummary: {
          sessionGoal: contextPack.sessionGoal,
          agentKey: contextPack.agentProfile.key,
          eventCount: contextPack.relevantEvents.length,
          memoryCount: contextPack.relevantMemories.length,
          ragSnippetCount: contextPack.ragSnippets.length,
          artifactCount: contextPack.artifacts.length,
          capabilityCount: contextPack.capabilities.length,
          constraintCount: contextPack.constraints.length
        }
      })),
      hasMore: false
    });
  }

  @Get('rag-retrievals')
  ragRetrievals(@Param('sessionId') sessionId: string) {
    return ok({
      items: this.events
        .list(sessionId)
        .filter((event) => event.type === 'rag_retrieved')
        .map((event) => ({
          eventId: event.id,
          taskId: event.taskId,
          agentId: event.fromAgentId,
          content: event.content,
          payload: event.metadata.payload,
          createdAt: event.createdAt
        })),
      hasMore: false
    });
  }

  @Get('token-usage')
  tokenUsage(@Param('sessionId') sessionId: string) {
    const invocations = this.runtime.listInvocations(sessionId);
    const total = invocations.reduce(
      (acc, invocation) => ({
        inputTokens: acc.inputTokens + (invocation.usage?.inputTokens ?? 0),
        outputTokens: acc.outputTokens + (invocation.usage?.outputTokens ?? 0),
        totalTokens: acc.totalTokens + (invocation.usage?.totalTokens ?? 0)
      }),
      { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
    );

    return ok({
      ...total,
      invocationCount: invocations.length,
      byInvocation: invocations.map((invocation) => ({
        invocationId: invocation.id,
        runId: invocation.runId,
        agentKey: invocation.agentKey,
        phase: invocation.phase,
        usage: invocation.usage
      }))
    });
  }
}
