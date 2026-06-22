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
          configuredRuntimeType: contextPack.agentProfile.configuredRuntimeType,
          effectiveRuntimeType: contextPack.agentProfile.runtimeType,
          runtimeSelectionSource: contextPack.runtimeSelection?.source,
          runtimeSelectionReason: contextPack.runtimeSelection?.reason,
          taskDomain: contextPack.taskContext.domain,
          taskIntent: contextPack.taskContext.intent,
          currentStage: contextPack.taskContext.currentStage,
          taskMapKind: contextPack.taskContext.taskMap.kind,
          taskMapItemCount: contextPack.taskContext.taskMap.items.length,
          projectMapSource: contextPack.projectMap?.source,
          projectMapModuleCount: contextPack.projectMap?.modules.length ?? 0,
          projectMapSourceRefCount: contextPack.projectMap?.sourceRefs.length ?? 0,
          projectMapValidationCommandCount: contextPack.projectMap?.validationCommands.length ?? 0,
          stagePlanReadCount: contextPack.taskContext.stagePlan.read.length,
          stagePlanDoCount: contextPack.taskContext.stagePlan.do.length,
          stagePlanValidateCount: contextPack.taskContext.stagePlan.validate.length,
          executionMode: contextPack.taskContext.executionMode,
          validationMode: contextPack.taskContext.validationMode,
          validationRuleCount: contextPack.taskContext.validationRules.length,
          agentResponsibilityCount: contextPack.taskContext.agentResponsibilities.length,
          evidenceSelectionStrategy: contextPack.taskContext.evidenceSelection.strategy,
          evidenceSelectionMaxRefs: contextPack.taskContext.evidenceSelection.maxEvidenceRefs,
          evidenceSelectionSelectedCount: contextPack.taskContext.evidenceSelection.selectedCount,
          evidenceSelectionOmittedCount: contextPack.taskContext.evidenceSelection.omittedCount,
          evidenceSelectionSelectedTokenEstimate: contextPack.taskContext.evidenceSelection.selectedRefs.reduce(
            (total, ref) => total + (ref.estimatedTokens ?? 0),
            0
          ),
          evidenceSelectionOmittedTokenEstimate: contextPack.taskContext.evidenceSelection.omittedRefs.reduce(
            (total, ref) => total + (ref.estimatedTokens ?? 0),
            0
          ),
          evidenceCount: contextPack.taskContext.evidenceRefs.length,
          summaryConfirmedFactCount: contextPack.summaryMemory.confirmedFacts.length,
          summaryCompletedCount: contextPack.summaryMemory.completed.length,
          summaryRiskCount: contextPack.summaryMemory.risks.length,
          continuationPhase: contextPack.continuationState.phase,
          continuationActiveTaskId: contextPack.continuationState.activeTaskId,
          continuationPendingTaskCount: contextPack.continuationState.pendingTaskIds.length,
          continuationRunningTaskCount: contextPack.continuationState.runningTaskIds.length,
          continuationCompletedTaskCount: contextPack.continuationState.completedTaskIds.length,
          continuationBlockedTaskCount: contextPack.continuationState.blockedTaskIds.length,
          continuationResumeHintCount: contextPack.continuationState.resumeHints.length,
          eventCount: contextPack.relevantEvents.length,
          memoryCount: contextPack.relevantMemories.length,
          ragSnippetCount: contextPack.ragSnippets.length,
          artifactCount: contextPack.artifacts.length,
          capabilityCount: contextPack.capabilities.length,
          constraintCount: contextPack.constraints.length,
          errorCode: invocation.error?.code,
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
        invocationId: invocation.id,
        runId: invocation.runId,
        agentKey: invocation.agentKey,
        phase: invocation.phase,
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
    return ok({
      latest: checkpoints.at(-1) ?? null,
      items: checkpoints,
      hasMore: false
    });
  }
}
