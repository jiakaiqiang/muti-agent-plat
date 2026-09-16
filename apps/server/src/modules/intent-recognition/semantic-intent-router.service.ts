import { Injectable, Optional } from '@nestjs/common';
import {
  validateRuntimeOutput,
  type ContextEnvelopeV2,
  type IntentContextSnapshot,
  type IntentRoutingDecisionOutput,
  type IntentRoutingDecisionV2,
  type IntentRoutingRecord,
  type IntentRoutingValidation,
  type SessionDetail
} from '@agent-cluster/shared';
import { globalDefaultRuntimeType, projectPolicyRuntimeType } from '../../common/runtime-config.js';
import { workspaceMetrics } from '../../common/workspace-metrics.js';
import { AgentsService } from '../agents/agents.service.js';
import { SystemAgentRuntimePolicyService } from '../agents/system-agent-runtime-policy.service.js';
import { ContextManagementService } from '../context-management/context-management.service.js';
import { EventsService } from '../events/events.service.js';
import { RuntimeInvocationService } from '../runtime-invocation/runtime-invocation.service.js';
import { workspaceProviderKindForDirectory } from '../workspaces/workspace-provider.js';
import { matchExactUserCommand } from './deterministic-command-guard.service.js';

export type SemanticIntentRoutingOutcome = {
  routing: IntentRoutingRecord;
  decision: IntentRoutingDecisionV2;
  validation: IntentRoutingValidation;
  autoApplicable: boolean;
};

@Injectable()
export class SemanticIntentRouterService {
  constructor(
    private readonly runtimeInvocation: RuntimeInvocationService,
    private readonly agents: AgentsService,
    private readonly policies: SystemAgentRuntimePolicyService,
    private readonly context: ContextManagementService,
    @Optional() private readonly events?: EventsService
  ) {}

  async classify(
    session: SessionDetail,
    routing: IntentRoutingRecord,
    snapshot: IntentContextSnapshot,
    signal?: AbortSignal
  ): Promise<SemanticIntentRoutingOutcome> {
    signal?.throwIfAborted();
    if (routing.status !== 'CLASSIFYING') {
      await this.context.updateRoutingRecord(session.id, routing.id, {
        status: 'SNAPSHOT_READY',
        snapshotId: snapshot.id
      }, routing.leaseOwner);
    }
    const deterministic = this.deterministicDecision(session, snapshot);
    if (deterministic) {
      await this.context.updateRoutingRecord(session.id, routing.id, { status: 'CLASSIFYING' }, routing.leaseOwner);
      await this.context.updateRoutingRecord(session.id, routing.id, { status: 'VALIDATING' }, routing.leaseOwner);
      return this.finish(session, routing.id, routing.rolloutMode, snapshot, deterministic, true, routing.leaseOwner);
    }

    let lastError = 'INTENT_RUNTIME_UNAVAILABLE';
    for (let attempt = 0; attempt < 2; attempt += 1) {
      signal?.throwIfAborted();
      await this.context.updateRoutingRecord(session.id, routing.id, {
        status: 'CLASSIFYING',
        retryCount: attempt
      }, routing.leaseOwner);
      const invocationId = crypto.randomUUID();
      try {
        const result = await this.runtimeInvocation.invoke(
          { ...this.runtimeInput(session, snapshot, invocationId), operationId: routing.id },
          signal
        );
        signal?.throwIfAborted();
        if (result.status !== 'completed') {
          lastError = result.error?.code ?? 'INTENT_RUNTIME_FAILED';
          if (result.error?.details?.operationFailure || result.error?.details?.stopUnconfirmed) break;
          if (result.error?.retryable === false) break;
          const retryAfterMs = Number(result.error?.details?.retryAfterMs ?? 0);
          if (retryAfterMs > 0) {
            if (retryAfterMs >= (result.operationTelemetry?.remainingMs ?? 0)) break;
            await new Promise<void>((resolve, reject) => {
              const onAbort = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); reject(signal?.reason); };
              const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, retryAfterMs);
              if (signal?.aborted) onAbort();
              else signal?.addEventListener('abort', onAbort, { once: true });
            });
          }
          throw new Error(lastError);
        }
        const parsed = validateRuntimeOutput('intent_routing_decision', result.output);
        if (!parsed.valid) {
          lastError = 'INTENT_OUTPUT_INVALID';
          throw new Error(`${lastError}: ${parsed.errors.join('; ')}`);
        }
        await this.context.updateRoutingRecord(session.id, routing.id, {
          status: 'VALIDATING',
          invocationId,
          retryCount: attempt
        }, routing.leaseOwner);
        return this.finish(session, routing.id, routing.rolloutMode, snapshot, this.toDecision(parsed.value), false, routing.leaseOwner);
      } catch (error) {
        signal?.throwIfAborted();
        if (String(error).includes('ROUTING_LEASE_LOST')) throw error;
        lastError = stableErrorCode(error, lastError);
        workspaceMetrics.increment('intent_route_runtime_failure_total', 1, {
          code: intentFailureMetricCode(lastError)
        });
        if (lastError === 'INTENT_OUTPUT_INVALID' && attempt === 0) {
          workspaceMetrics.increment('intent_route_schema_repair_total');
        }
        await this.context.updateRoutingRecord(session.id, routing.id, {
          status: 'PENDING_RETRY',
          invocationId,
          retryCount: attempt + 1,
          reasonCodes: [lastError]
        }, routing.leaseOwner);
      }
    }

    const decision: IntentRoutingDecisionV2 = {
      dialogueAct: 'clarification',
      scopeRelation: 'ambiguous',
      contextPolicy: 'ask_user',
      requestedAction: 'clarify',
      selectedDecisionIds: [],
      selectedArtifactIds: [],
      goalSegments: [],
      missingFields: ['intent_runtime_decision'],
      ambiguityReasons: [lastError],
      reasonCodes: [lastError, 'USER_CHOICE_REQUIRED'],
      riskLevel: 'low'
    };
    return this.finish(session, routing.id, routing.rolloutMode, snapshot, decision, false, routing.leaseOwner);
  }

  private async finish(
    session: SessionDetail,
    routingId: string,
    rolloutMode: IntentRoutingRecord['rolloutMode'],
    snapshot: IntentContextSnapshot,
    decision: IntentRoutingDecisionV2,
    deterministic: boolean,
    expectedLeaseOwner?: string
  ): Promise<SemanticIntentRoutingOutcome> {
    const validation = this.validate(session, snapshot, decision, deterministic);
    const autoApplicable = validation.safeToApply && decision.requestedAction !== 'clarify';
    const status = autoApplicable
      ? rolloutMode === 'shadow'
        ? 'ROUTED'
        : 'VALIDATING'
      : 'CLARIFICATION_REQUIRED';
    const routing = await this.context.updateRoutingRecord(session.id, routingId, {
      status,
      decision,
      validation,
      finalAction: status === 'ROUTED' ? decision.requestedAction : status === 'CLARIFICATION_REQUIRED' ? 'clarify' : undefined,
      reasonCodes: [...new Set([...decision.reasonCodes, ...validation.errors])]
    }, expectedLeaseOwner);
    return { routing, decision, validation, autoApplicable };
  }

  private validate(
    session: SessionDetail,
    snapshot: IntentContextSnapshot,
    decision: IntentRoutingDecisionV2,
    deterministic: boolean
  ): IntentRoutingValidation {
    const errors: string[] = [];
    const candidateIds = new Set(snapshot.candidateWorkItemIds);
    const decisionIds = new Set(snapshot.validDecisionIds);
    const artifactIds = new Set(snapshot.activeWorkItem?.id
      ? this.context.getWorkItem(session.id, snapshot.activeWorkItem.id).inheritedArtifactIds
      : []);
    const referencesValid =
      (!decision.selectedWorkItemId || candidateIds.has(decision.selectedWorkItemId)) &&
      decision.selectedDecisionIds.every((id) => decisionIds.has(id)) &&
      decision.selectedArtifactIds.every((id) => artifactIds.has(id));
    if (!referencesValid) errors.push('REFERENCE_OUTSIDE_SNAPSHOT');
    const snapshotCurrent = this.context.isSnapshotCurrent(
      session,
      snapshot,
      this.events?.list(session.id).length
    );
    if (!snapshotCurrent) errors.push('SNAPSHOT_STALE');
    const transitionValid = this.transitionValid(session, snapshot, decision);
    if (!transitionValid) errors.push('STATE_TRANSITION_INVALID');
    if (decision.missingFields.length) errors.push('REQUIRED_FIELDS_MISSING');
    if (decision.scopeRelation === 'ambiguous' || decision.ambiguityReasons.length) errors.push('INTENT_AMBIGUOUS');
    if (decision.riskLevel === 'high' && !deterministic) errors.push('HIGH_RISK_REQUIRES_CONFIRMATION');
    if (decision.requestedAction === 'confirm' || decision.requestedAction === 'reject') {
      errors.push('CONFIRMATION_TARGET_REQUIRED');
    }

    const serverConfidence = Math.max(0, Math.min(1,
      1 -
      (referencesValid ? 0 : 0.35) -
      (snapshotCurrent ? 0 : 0.35) -
      (transitionValid ? 0 : 0.25) -
      (decision.missingFields.length ? 0.25 : 0) -
      (decision.ambiguityReasons.length ? 0.25 : 0) -
      (decision.riskLevel === 'high' && !deterministic ? 0.3 : 0) -
      (decision.requestedAction === 'confirm' || decision.requestedAction === 'reject' ? 0.4 : 0)
    ));
    return {
      schemaValid: true,
      referencesValid,
      transitionValid,
      snapshotCurrent,
      safeToApply: errors.length === 0 && serverConfidence >= 0.75,
      serverConfidence,
      errors
    };
  }

  private transitionValid(
    session: SessionDetail,
    snapshot: IntentContextSnapshot,
    decision: IntentRoutingDecisionV2
  ) {
    if (['continue_active_work_item', 'resume', 'replan', 'pause', 'cancel'].includes(decision.requestedAction)) {
      if (!snapshot.activeWorkItemId) return false;
    }
    if (decision.requestedAction === 'resume') {
      return snapshot.activeWorkItem?.status === 'FAILED' || ['FAILED', 'INTERRUPTED', 'PAUSED'].includes(session.status);
    }
    if (decision.requestedAction === 'confirm' || decision.requestedAction === 'reject') {
      return Boolean(snapshot.pendingConfirmationContext ?? snapshot.pendingConfirmation);
    }
    if (decision.requestedAction === 'create_independent_work_item') {
      return decision.contextPolicy === 'clean_task_context';
    }
    return true;
  }

  private deterministicDecision(session: SessionDetail, snapshot: IntentContextSnapshot): IntentRoutingDecisionV2 | undefined {
    const exactCommand = matchExactUserCommand(snapshot.currentMessage);
    if (!exactCommand) return undefined;
    const activeId = snapshot.activeWorkItemId;
    const base = {
      dialogueAct: 'command' as const,
      selectedWorkItemId: activeId,
      selectedDecisionIds: snapshot.validDecisionIds,
      selectedArtifactIds: [] as string[],
      goalSegments: [] as string[],
      missingFields: [] as string[],
      ambiguityReasons: [] as string[],
      riskLevel: 'low' as const,
      modelConfidence: 1
    };
    if (exactCommand.command === 'resume' || exactCommand.command === 'retry') {
      return {
        ...base,
        scopeRelation: activeId ? 'same_requirement' : 'ambiguous',
        contextPolicy: activeId ? 'inherit_confirmed' : 'ask_user',
        requestedAction: activeId && ['FAILED', 'INTERRUPTED', 'PAUSED'].includes(session.status)
          ? 'resume'
          : activeId ? 'continue_active_work_item' : 'clarify',
        ambiguityReasons: activeId ? [] : ['NO_ACTIVE_WORK_ITEM'],
        reasonCodes: [exactCommand.reasonCode]
      };
    }
    if (exactCommand.command === 'pause') {
      return { ...base, scopeRelation: 'same_requirement', contextPolicy: 'inherit_confirmed', requestedAction: 'pause', reasonCodes: [exactCommand.reasonCode] };
    }
    if (exactCommand.command === 'cancel') {
      return { ...base, scopeRelation: 'same_requirement', contextPolicy: 'inherit_confirmed', requestedAction: 'cancel', reasonCodes: [exactCommand.reasonCode], riskLevel: 'high' };
    }
    if (exactCommand.command === 'confirm') {
      return { ...base, scopeRelation: 'same_requirement', contextPolicy: 'inherit_confirmed', requestedAction: 'confirm', reasonCodes: [exactCommand.reasonCode] };
    }
    if (exactCommand.command === 'reject') {
      return { ...base, scopeRelation: 'same_requirement', contextPolicy: 'inherit_confirmed', requestedAction: 'reject', reasonCodes: [exactCommand.reasonCode], riskLevel: 'high' };
    }
    return undefined;
  }

  private runtimeInput(session: SessionDetail, snapshot: IntentContextSnapshot, invocationId: string) {
    const agent = this.agents.resolveSystemRole('intent_router');
    const policy = this.policies.get('intent_router');
    const providerKind = workspaceProviderKindForDirectory(session.workingDirectory?.kind);
    return {
      invocationId,
      sessionId: session.id,
      taskKind: 'intent_routing',
      phase: 'user_message_routing' as const,
      taskRequiresCodeChanges: false,
      agent,
      workspace: {
        workspaceId: session.workspaceId,
        providerKind,
        capabilities: { read: false, write: false, command: false, test: false }
      },
      sessionPreference: {
        ...session.runtimePreference,
        ...policy,
        allowedRuntimeTypes: policy.allowedRuntimeTypes ?? session.runtimePreference?.allowedRuntimeTypes
      },
      ...(policy.preferredRuntimeType ? {
        taskOverride: {
          runtimeType: policy.preferredRuntimeType,
          ...(policy.preferredModelId ? { modelId: policy.preferredModelId } : {})
        }
      } : {}),
      projectPolicyRuntime: projectPolicyRuntimeType(),
      smartRouterPick: policy.preferredRuntimeType ?? 'generic_llm' as const,
      globalDefaultRuntime: globalDefaultRuntimeType(),
      contextEnvelopeFactory: ({ identity, toolCatalog }: {
        identity: { agentId: string; profileHash: string; profileRevision: number };
        toolCatalog: { catalogHash: string };
      }): ContextEnvelopeV2 => ({
        version: 'v2',
        createdAt: new Date().toISOString(),
        workspaceId: session.workspaceId,
        sessionId: session.id,
        L0: {
          systemRules: [
            'Return only IntentRoutingDecisionV2 structured output.',
            'Select WorkItem, Decision and Artifact identifiers only from the supplied snapshot.',
            'Ask for clarification when the relation or state transition is ambiguous.',
            'Do not decompose tasks, invoke tools, or mutate Session state.'
          ],
          agentId: identity.agentId,
          profileHash: identity.profileHash,
          profileRevision: identity.profileRevision,
          toolCatalogHash: toolCatalog.catalogHash,
          workspace: {
            workspaceId: session.workspaceId,
            rootName: session.workingDirectory?.name ?? session.workspaceId,
            providerKind,
            revision: { id: `intent:${session.revision ?? 1}`, observedAt: new Date().toISOString() }
          }
        },
        L1: {
          sessionGoal: session.originalInput,
          currentContractGoal: snapshot.activeWorkItem?.goal,
          currentUserMessage: snapshot.currentMessage,
          phase: 'user_message_routing',
          navigation: { entries: [], truncated: false }
        },
        L2: { source: 'generated', modules: [] },
        L3: { files: [], fileRevisions: [], totalByteLength: 0, truncated: false },
        L4: { calls: [] },
        L5: {
          bullets: [
            `Current message: ${snapshot.currentMessage}`,
            `Active WorkItem: ${JSON.stringify(snapshot.activeWorkItem ?? null)}`,
            `Candidate WorkItems: ${JSON.stringify(snapshot.candidateWorkItems)}`,
            `Valid Decisions: ${JSON.stringify(snapshot.validDecisions)}`,
            `Pending confirmation: ${JSON.stringify(snapshot.pendingConfirmationContext ?? snapshot.pendingConfirmation ?? null)}`,
            `Failure checkpoint: ${snapshot.failureCheckpoint ?? '(none)'}`
          ],
          turnCount: 1
        },
        L6: { changeSetIds: [], reportIds: [] },
        budget: { inputTokens: 4_000, navigationTokens: 0, projectMapTokens: 0, evidenceTokens: 0 }
      }),
      expectedOutput: { kind: 'intent_routing_decision' as const, schemaVersion: '1.0' as const },
      budget: { maxInputTokens: 4_000, maxOutputTokens: 1_200, maxTotalTokens: 5_200 },
      writeModeOverride: 'none' as const
    };
  }

  private toDecision(output: IntentRoutingDecisionOutput): IntentRoutingDecisionV2 {
    return {
      dialogueAct: output.dialogueAct,
      scopeRelation: output.scopeRelation,
      contextPolicy: output.contextPolicy,
      requestedAction: output.requestedAction,
      selectedWorkItemId: output.selectedWorkItemId ?? undefined,
      selectedDecisionIds: output.selectedDecisionIds,
      selectedArtifactIds: output.selectedArtifactIds,
      goalSegments: output.goalSegments,
      missingFields: output.missingFields,
      ambiguityReasons: output.ambiguityReasons,
      reasonCodes: output.reasonCodes,
      riskLevel: output.riskLevel,
      modelConfidence: output.modelConfidence ?? undefined
    };
  }
}

function stableErrorCode(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : String(error);
  return message.match(/\b[A-Z][A-Z0-9_]{3,}\b/)?.[0] ?? fallback;
}

function intentFailureMetricCode(code: string) {
  if (code === 'INTENT_OUTPUT_INVALID') return 'output_invalid';
  if (code === 'INTENT_RUNTIME_UNAVAILABLE') return 'runtime_unavailable';
  if (code === 'INTENT_RUNTIME_FAILED') return 'runtime_failed';
  if (code === 'RUNTIME_TIMEOUT') return 'runtime_timeout';
  if (code === 'RUNTIME_CANCELLED') return 'runtime_cancelled';
  return 'other';
}
