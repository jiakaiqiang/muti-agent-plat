import { Controller, Get, Param } from '@nestjs/common';
import { ok } from '../../common/api-response.js';
import { ArtifactsService } from '../artifacts/artifacts.service.js';
import { EventsService } from '../events/events.service.js';
import { RuntimeService } from '../runtimes/runtime.service.js';
import { SessionsService } from '../sessions/sessions.service.js';

@Controller('sessions/:sessionId/debug')
export class DebugController {
  constructor(
    private readonly artifacts: ArtifactsService,
    private readonly events: EventsService,
    private readonly runtime: RuntimeService,
    private readonly sessions: SessionsService
  ) {}

  @Get('context-envelopes')
  contextEnvelopes(@Param('sessionId') sessionId: string) {
    return ok({
      items: this.runtime.listInvocations(sessionId).map((invocation) => ({
        invocationId: invocation.invocationId,
        taskId: invocation.taskId,
        agentId: invocation.agentId,
        agentKey: invocation.agentKey,
        phase: invocation.phase,
        status: invocation.status,
        contextEnvelope: invocation.contextEnvelope,
        createdAt: invocation.startedAt
      })),
      hasMore: false
    });
  }

  @Get('runtime-invocations')
  runtimeInvocations(@Param('sessionId') sessionId: string) {
    return ok({
      items: this.runtime.listInvocations(sessionId).map((invocation) => ({
        id: invocation.id,
        dataEpoch: invocation.dataEpoch,
        invocationId: invocation.invocationId,
        sessionId: invocation.sessionId,
        taskId: invocation.taskId,
        agentId: invocation.agentId,
        agentKey: invocation.agentKey,
        phase: invocation.phase,
        status: invocation.status,
        identity: invocation.profileSnapshot,
        executionTarget: invocation.executionTarget,
        toolCatalog: invocation.toolCatalog,
        contextEnvelope: invocation.contextEnvelope,
        expectedOutput: invocation.expectedOutput,
        outputContract: invocation.outputContract,
        budget: invocation.budget,
        attempt: invocation.attempt,
        usage: invocation.usage,
        error: invocation.error,
        termination: invocation.termination,
        streamMetrics: invocation.streamMetrics,
        runtimeDiagnostics: invocation.runtimeDiagnostics,
        systemEvidence: invocation.systemEvidence,
        cliSessionId: invocation.cliSessionId,
        startedAt: invocation.startedAt,
        completedAt: invocation.completedAt,
        summary: {
          sessionGoal: invocation.contextEnvelope.L1.sessionGoal,
          workspaceId: invocation.contextEnvelope.workspaceId,
          navigationCount: invocation.contextEnvelope.L1.navigation.entries.length,
          evidenceCount: invocation.contextEnvelope.L3.files.length,
          evidenceBytes: invocation.contextEnvelope.L3.totalByteLength,
          projectModuleCount: invocation.contextEnvelope.L2.modules.length,
          toolCount: invocation.toolCatalog.tools.length,
          blockedToolCount: invocation.toolCatalog.decisions.filter((decision) => decision.status === 'blocked').length,
          memoryBulletCount: invocation.contextEnvelope.L5.bullets.length,
          artifactRefCount:
            invocation.contextEnvelope.L6.changeSetIds.length + invocation.contextEnvelope.L6.reportIds.length,
          requestedContextRefCount: invocation.error?.requestedContext?.requestedRefs.length ?? 0,
          requestedContextPathCount: invocation.error?.requestedContext?.requestedPaths?.length ?? 0,
          requestedContextCommandCount: invocation.error?.requestedContext?.requestedCommands?.length ?? 0
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
    const session = this.sessions.get(sessionId);
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
      tokenBudget: session.tokenBudget,
      tokenUsed: session.tokenUsed,
      ...total,
      invocationCount: invocations.length,
      byInvocation: invocations.map((invocation) => ({
        invocationId: invocation.invocationId,
        agentKey: invocation.agentKey,
        phase: invocation.phase,
        runtimeType: invocation.runtimeType,
        usage: invocation.usage
      }))
    });
  }

  @Get('summary-memory')
  summaryMemory(@Param('sessionId') sessionId: string) {
    const checkpoints = this.artifacts
      .listBySession(sessionId)
      .map((artifact) => ({
        artifactId: artifact.id,
        title: artifact.title,
        createdAt: artifact.createdAt,
        checkpoint: artifact.metadata.summaryMemoryCheckpoint
      }))
      .filter((item) => {
        const checkpoint = item.checkpoint as { kind?: string } | undefined;
        return checkpoint?.kind === 'summary_memory_checkpoint';
      });
    return ok({ latest: checkpoints.at(-1) ?? null, items: checkpoints, hasMore: false });
  }
}
