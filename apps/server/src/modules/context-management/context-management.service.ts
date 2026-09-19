import { createHash } from 'node:crypto';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  AgentTask,
  Artifact,
  DecisionRecord,
  DecisionRecordKind,
  CollaborationEvent,
  IntentContextSnapshot,
  IntentSnapshotMessageExcerpt,
  PendingConfirmationContext,
  IntentRoutingDecisionV2,
  IntentRoutingRecord,
  IntentRoutingRolloutMode,
  IntentRoutingValidation,
  SessionDetail,
  SessionFollowUpMessage,
  SummaryCheckpointRecord,
  WorkItem
} from '@agent-cluster/shared';
import type { MemoryItem } from '@agent-cluster/shared';
import { PersistenceService, type PersistedState } from '../persistence/persistence.service.js';
import { SUMMARY_CHECKPOINTS_COLLECTION } from '../memory/summary-checkpoint-store.js';
import { buildWorkItemArchiveIndex, recallWorkItems } from './work-item-recall.js';

type BySession<T> = Record<string, T[]>;

/**
 * Routing snapshot caps. The classifier never reads Session history directly, so these
 * bounds are what keeps a routing request from growing with the number of past
 * requirements or messages. Every snapshot reports them back in `bounds`.
 */
const SNAPSHOT_CANDIDATE_WORK_ITEM_LIMIT = 5;
const SNAPSHOT_RECENT_MESSAGE_LIMIT = 8;
const SNAPSHOT_MESSAGE_CHAR_LIMIT = 400;
const SNAPSHOT_DIALOGUE_EVENT_TYPES = new Set<CollaborationEvent['type']>([
  'user_message',
  'agent_message',
  'intent_clarification_required'
]);

export type CreateWorkItemInput = {
  session: SessionDetail;
  sourceEventId: string;
  title: string;
  goal: string;
  parentWorkItemId?: string;
  inheritedDecisionIds?: string[];
  inheritedArtifactIds?: string[];
  status?: WorkItem['status'];
  activate?: boolean;
};

export type AppliedIntentRoute = {
  routing: IntentRoutingRecord;
  workItem: WorkItem;
  followUp: SessionFollowUpMessage;
  createdWorkItem: boolean;
  previousWorkItemId?: string;
  deferredActivation?: boolean;
  committedEvent?: CollaborationEvent;
  committedEvents?: CollaborationEvent[];
};

export type MessageIngressCommitResult = {
  event: CollaborationEvent;
  followUp: SessionFollowUpMessage;
  routing: IntentRoutingRecord;
  workItem: WorkItem;
  additionalEvents?: CollaborationEvent[];
  idempotentReplay: boolean;
};

export type IntentRoutingClaimResult = {
  state: 'claimed' | 'blocked' | 'terminal';
  routing: IntentRoutingRecord;
  blockingRouting?: IntentRoutingRecord;
};

export type WorkItemContextSlice = {
  workItem?: WorkItem;
  decisions: DecisionRecord[];
  tasks: AgentTask[];
  events: CollaborationEvent[];
  memories: MemoryItem[];
  artifacts: Artifact[];
  inheritedDecisionIds: string[];
  inheritedArtifactIds: string[];
};

@Injectable()
export class ContextManagementService {
  private readonly sessionLocks = new Map<string, Promise<unknown>>();

  constructor(private readonly persistence: PersistenceService) {}

  listWorkItems(sessionId: string) {
    return this.collection<WorkItem>('workItemsBySession')[sessionId] ?? [];
  }

  getWorkItem(sessionId: string, workItemId: string) {
    const item = this.listWorkItems(sessionId).find((candidate) => candidate.id === workItemId);
    if (!item) throw new NotFoundException(`WorkItem not found in Session: ${workItemId}`);
    return item;
  }

  activeWorkItem(session: SessionDetail) {
    return session.activeWorkItemId
      ? this.listWorkItems(session.id).find((item) => item.id === session.activeWorkItemId)
      : undefined;
  }

  listDecisions(sessionId: string) {
    return this.collection<DecisionRecord>('decisionRecordsBySession')[sessionId] ?? [];
  }

  validDecisions(sessionId: string, workItemId: string) {
    const workItem = this.getWorkItem(sessionId, workItemId);
    const validIds = new Set([...workItem.inheritedDecisionIds]);
    return this.listDecisions(sessionId).filter(
      (decision) => decision.status === 'confirmed' &&
        (decision.workItemId === workItemId || validIds.has(decision.id))
    );
  }

  listSnapshots(sessionId: string) {
    return this.collection<IntentContextSnapshot>('contextSnapshotsBySession')[sessionId] ?? [];
  }

  listRoutingRecords(sessionId: string) {
    return this.collection<IntentRoutingRecord>('intentRoutingRecordsBySession')[sessionId] ?? [];
  }

  listFollowUps(sessionId: string) {
    return this.collection<SessionFollowUpMessage>('followUpMessagesBySession')[sessionId] ?? [];
  }

  /** Reply targets are verified against durable Session events so a restart cannot reject a valid one. */
  hasSessionEvent(sessionId: string, eventId: string) {
    return (this.collection<CollaborationEvent>('eventsBySession')[sessionId] ?? [])
      .some((event) => event.id === eventId);
  }

  buildWorkItemContextSlice(input: {
    session: SessionDetail;
    workItemId?: string;
    tasks: AgentTask[];
    events: CollaborationEvent[];
    memories: MemoryItem[];
    artifacts: Artifact[];
  }): WorkItemContextSlice {
    const workItem = input.workItemId
      ? this.listWorkItems(input.session.id).find((item) => item.id === input.workItemId)
      : undefined;
    const initialWorkItemId = this.listWorkItems(input.session.id)[0]?.id;
    const allowLegacyUnscoped = !input.workItemId || input.workItemId === initialWorkItemId;
    const inheritedDecisionIds = workItem?.inheritedDecisionIds ?? [];
    const inheritedArtifactIds = workItem?.inheritedArtifactIds ?? [];
    const decisions = workItem
      ? this.validDecisions(input.session.id, workItem.id)
      : [];
    const tasks = input.tasks.filter((task) =>
      task.workItemId === input.workItemId || (allowLegacyUnscoped && !task.workItemId)
    );
    const events = input.events.filter((event) =>
      event.workItemId === input.workItemId ||
      (event.taskId && tasks.some((task) => task.id === event.taskId)) ||
      (allowLegacyUnscoped && !event.workItemId && !event.taskId)
    );
    const memories = input.memories.filter((memory) =>
      memory.workItemId === input.workItemId || (allowLegacyUnscoped && !memory.workItemId)
    );
    const artifacts = input.artifacts.filter((artifact) =>
      artifact.workItemId === input.workItemId ||
      inheritedArtifactIds.includes(artifact.id) ||
      (allowLegacyUnscoped && !artifact.workItemId)
    );
    return {
      workItem,
      decisions,
      tasks,
      events,
      memories,
      artifacts,
      inheritedDecisionIds: [...inheritedDecisionIds],
      inheritedArtifactIds: [...inheritedArtifactIds]
    };
  }

  isSnapshotCurrent(session: SessionDetail, snapshot: IntentContextSnapshot, latestEventSeq?: number) {
    return snapshotMatchesProjection(session, this.listWorkItems(session.id), snapshot,
      this.collection<CollaborationEvent>('eventsBySession')[session.id] ?? [],
      this.collection<AgentTask>('tasksBySession')[session.id] ?? []);
  }

  async reserveRoutingRebuild(sessionId: string, routingId: string): Promise<boolean> {
    return this.serialized(sessionId, () => this.mutate((draft) => {
      const route = collectionFromDraft<IntentRoutingRecord>(draft, 'intentRoutingRecordsBySession')[sessionId]
        ?.find(item => item.id === routingId);
      if (!route || ['ROUTED', 'REJECTED'].includes(route.status) || (route.snapshotRebuildCount ?? 0) >= 1) return false;
      route.snapshotRebuildCount = 1;
      return true;
    }, sessionId));
  }

  async ensureInitialWorkItem(
    session: SessionDetail,
    sourceEventId: string,
    goal = session.originalInput,
    status?: WorkItem['status']
  ) {
    const current = this.activeWorkItem(session);
    if (current) return current;
    return this.createWorkItem({
      session,
      sourceEventId,
      title: session.title,
      goal,
      status,
      activate: true
    });
  }

  async createWorkItem(input: CreateWorkItemInput) {
    return this.serialized(input.session.id, async () => {
      const decisionIds = [...new Set(input.inheritedDecisionIds ?? [])];
      const artifactIds = [...new Set(input.inheritedArtifactIds ?? [])];
      this.assertInheritedDecisions(input.session.id, decisionIds);
      this.assertInheritedArtifacts(input.session.id, artifactIds);
      if (input.parentWorkItemId) this.getWorkItem(input.session.id, input.parentWorkItemId);
      const now = new Date().toISOString();
      const item: WorkItem = {
        id: crypto.randomUUID(),
        sessionId: input.session.id,
        parentWorkItemId: input.parentWorkItemId,
        title: input.title.trim().slice(0, 120) || '新需求',
        goal: input.goal.trim(),
        status: input.status ?? 'OPEN',
        revision: 1,
        createdFromEventId: input.sourceEventId,
        inheritedDecisionIds: decisionIds,
        inheritedArtifactIds: artifactIds,
        createdAt: now,
        updatedAt: now
      };
      if (!item.goal) throw new BadRequestException('WorkItem goal is required.');

      await this.mutate((draft) => {
        const workItems = collectionFromDraft<WorkItem>(draft, 'workItemsBySession');
        (workItems[input.session.id] ??= []).push(item);
        draft.workItemsBySession = workItems;
        if (input.activate !== false) updateSessionProjection(draft, input.session.id, item.id);
      });
      if (input.activate !== false) {
        input.session.activeWorkItemId = item.id;
        input.session.revision = (input.session.revision ?? 1) + 1;
      }
      return item;
    });
  }

  async activateWorkItem(session: SessionDetail, workItemId: string) {
    return this.serialized(session.id, async () => {
      const item = this.getWorkItem(session.id, workItemId);
      await this.mutate((draft) => updateSessionProjection(draft, session.id, item.id));
      session.activeWorkItemId = item.id;
      session.revision = (session.revision ?? 1) + 1;
      return item;
    });
  }

  async updateActiveWorkItemStatus(session: SessionDetail, status: WorkItem['status']) {
    return this.serialized(session.id, async () => {
      const active = this.activeWorkItem(session);
      if (!active || active.status === status) return active;
      const now = new Date().toISOString();
      await this.mutate((draft) => {
        const workItems = collectionFromDraft<WorkItem>(draft, 'workItemsBySession');
        const item = (workItems[session.id] ?? []).find((candidate) => candidate.id === active.id);
        if (!item) throw new NotFoundException(`Active WorkItem not found during status update: ${active.id}`);
        item.status = status;
        item.revision += 1;
        item.updatedAt = now;
        draft.workItemsBySession = workItems;
        const sessions = Array.isArray(draft.sessions) ? draft.sessions as SessionDetail[] : [];
        const projected = sessions.find((candidate) => candidate.id === session.id);
        if (projected) {
          projected.revision = (projected.revision ?? 1) + 1;
          projected.updatedAt = now;
          draft.sessions = sessions;
        }
      });
      active.status = status;
      active.revision += 1;
      active.updatedAt = now;
      session.revision = (session.revision ?? 1) + 1;
      session.updatedAt = now;
      return active;
    });
  }

  async recordDecision(input: {
    session: SessionDetail;
    workItemId: string;
    sourceEventId: string;
    kind: DecisionRecordKind;
    content: string;
    confirmed?: boolean;
    supersedesDecisionId?: string;
  }) {
    return this.serialized(input.session.id, async () => {
      this.getWorkItem(input.session.id, input.workItemId);
      if (input.supersedesDecisionId) {
        const superseded = this.listDecisions(input.session.id).find((item) => item.id === input.supersedesDecisionId);
        if (!superseded) throw new BadRequestException(`Decision does not belong to Session: ${input.supersedesDecisionId}`);
      }
      const now = new Date().toISOString();
      const decision: DecisionRecord = {
        id: crypto.randomUUID(),
        sessionId: input.session.id,
        workItemId: input.workItemId,
        kind: input.kind,
        status: input.confirmed === false ? 'proposed' : 'confirmed',
        content: input.content.trim(),
        sourceEventId: input.sourceEventId,
        supersedesDecisionId: input.supersedesDecisionId,
        revision: 1,
        confirmedBy: input.confirmed === false ? undefined : { type: 'user', id: input.session.ownerId },
        createdAt: now,
        updatedAt: now
      };
      if (!decision.content) throw new BadRequestException('Decision content is required.');

      await this.mutate((draft) => {
        const decisions = collectionFromDraft<DecisionRecord>(draft, 'decisionRecordsBySession');
        const sessionDecisions = (decisions[input.session.id] ??= []);
        if (input.supersedesDecisionId) {
          const superseded = sessionDecisions.find((item) => item.id === input.supersedesDecisionId);
          if (superseded) {
            superseded.status = 'superseded';
            superseded.revision += 1;
            superseded.updatedAt = now;
          }
        }
        sessionDecisions.push(decision);
        draft.decisionRecordsBySession = decisions;
        updateDecisionLedgerProjection(draft, input.session.id);
      });
      input.session.decisionLedgerRevision = (input.session.decisionLedgerRevision ?? 0) + 1;
      input.session.revision = (input.session.revision ?? 1) + 1;
      return decision;
    });
  }

  async recordConfirmedDecisions(input: {
    session: SessionDetail;
    workItemId: string;
    sourceEvent: CollaborationEvent;
    decisions: Array<{ kind: DecisionRecordKind; content: string }>;
  }) {
    return this.serialized(input.session.id, async () => {
      const now = new Date().toISOString();
      const normalized = input.decisions
        .map((item) => ({ kind: item.kind, content: item.content.trim() }))
        .filter((item) => item.content);
      if (!normalized.length) return [];
      const committed = await this.mutate((draft) => {
        const workItems = collectionFromDraft<WorkItem>(draft, 'workItemsBySession');
        if (!(workItems[input.session.id] ?? []).some((item) => item.id === input.workItemId)) {
          throw new NotFoundException(`WorkItem not found during confirmed decision checkpoint: ${input.workItemId}`);
        }
        const decisions = collectionFromDraft<DecisionRecord>(draft, 'decisionRecordsBySession');
        const sessionDecisions = (decisions[input.session.id] ??= []);
        const existing = sessionDecisions.filter((item) => item.sourceEventId === input.sourceEvent.id);
        if (existing.length) return { records: existing, created: false };
        const records = normalized.map<DecisionRecord>((item) => ({
          id: crypto.randomUUID(),
          sessionId: input.session.id,
          workItemId: input.workItemId,
          kind: item.kind,
          status: 'confirmed',
          content: item.content,
          sourceEventId: input.sourceEvent.id,
          revision: 1,
          confirmedBy: { type: 'user', id: input.session.ownerId },
          createdAt: now,
          updatedAt: now
        }));
        sessionDecisions.push(...records);
        const events = collectionFromDraft<CollaborationEvent>(draft, 'eventsBySession');
        const sessionEvents = (events[input.session.id] ??= []);
        if (!sessionEvents.some((event) => event.id === input.sourceEvent.id)) {
          sessionEvents.push(input.sourceEvent);
          appendEventOutbox(draft, input.sourceEvent);
        }
        draft.decisionRecordsBySession = decisions;
        draft.eventsBySession = events;
        updateDecisionLedgerProjection(draft, input.session.id);
        return { records, created: true };
      }, input.session.id);
      if (committed.created) {
        input.session.decisionLedgerRevision = (input.session.decisionLedgerRevision ?? 0) + 1;
        input.session.revision = (input.session.revision ?? 1) + 1;
        input.session.updatedAt = now;
      }
      return committed.records;
    });
  }

  async buildIntentSnapshot(input: {
    session: SessionDetail;
    sourceEventId: string;
    currentMessage: string;
    latestEventSeq: number;
    explicitWorkItemIds?: string[];
    mentionedAgentIds?: string[];
    replyToEventId?: string;
    pendingConfirmation?: string;
    pendingConfirmationContext?: PendingConfirmationContext;
    failureCheckpoint?: string;
  }) {
    return this.serialized(input.session.id, async () => {
      const workItems = this.listWorkItems(input.session.id);
      const active = this.activeWorkItem(input.session);
      const explicit = (input.explicitWorkItemIds ?? []).map((id) => this.getWorkItem(input.session.id, id));
      // 2B: bounded historical recall runs on the server over the archive index
      // (titles/keywords/checkpoint refs), so an early requirement among hundreds
      // can become a candidate without the classifier reading all of history.
      const recall = recallWorkItems({
        index: buildWorkItemArchiveIndex(
          workItems,
          this.collection<SummaryCheckpointRecord>(SUMMARY_CHECKPOINTS_COLLECTION)[input.session.id] ?? []
        ),
        message: input.currentMessage,
        explicitWorkItemIds: input.explicitWorkItemIds,
        limit: SNAPSHOT_CANDIDATE_WORK_ITEM_LIMIT
      });
      const byId = new Map(workItems.map((item) => [item.id, item]));
      const recalled = recall.candidates
        .map((candidate) => byId.get(candidate.workItemId))
        .filter((item): item is WorkItem => Boolean(item));
      const ranked = uniqueById([
        ...explicit,
        ...recalled,
        ...(active ? [active] : []),
        ...workItems.filter((item) => ['WAITING_USER', 'FAILED'].includes(item.status)).reverse(),
        ...[...workItems].reverse()
      ]);
      const candidates = ranked.slice(0, SNAPSHOT_CANDIDATE_WORK_ITEM_LIMIT);
      const sessionEvents = this.collection<CollaborationEvent>('eventsBySession')[input.session.id] ?? [];
      const replyTarget = input.replyToEventId
        ? sessionEvents.find((event) => event.id === input.replyToEventId)
        : undefined;
      if (input.replyToEventId && !replyTarget) {
        throw new BadRequestException(
          `REPLY_TARGET_OUTSIDE_SESSION: ${input.replyToEventId} does not belong to Session ${input.session.id}.`
        );
      }
      const initialWorkItemId = workItems[0]?.id;
      const allowLegacyUnscoped = !active || active.id === initialWorkItemId;
      const relevantEvents = sessionEvents.filter((event) =>
        SNAPSHOT_DIALOGUE_EVENT_TYPES.has(event.type) &&
        (event.workItemId === active?.id || (allowLegacyUnscoped && !event.workItemId))
      );
      const recentRelevantMessages = relevantEvents
        .slice(-SNAPSHOT_RECENT_MESSAGE_LIMIT)
        .map(messageExcerpt);
      const mentionedAgentIds = input.mentionedAgentIds?.length
        ? [...new Set(input.mentionedAgentIds)]
        : undefined;
      const bounds = {
        recentMessageLimit: SNAPSHOT_RECENT_MESSAGE_LIMIT,
        messageCharLimit: SNAPSHOT_MESSAGE_CHAR_LIMIT,
        candidateWorkItemLimit: SNAPSHOT_CANDIDATE_WORK_ITEM_LIMIT,
        totalCandidateWorkItems: ranked.length,
        omittedCandidateWorkItems: Math.max(0, ranked.length - candidates.length),
        omittedRecentMessages: Math.max(0, relevantEvents.length - recentRelevantMessages.length)
      };
      const activeDecisions = active ? this.validDecisions(input.session.id, active.id) : [];
      const revision = {
        sessionRevision: input.session.revision ?? 1,
        activeWorkItemId: active?.id,
        activeWorkItemRevision: active?.revision,
        decisionLedgerRevision: input.session.decisionLedgerRevision ?? 0,
        workflowRunId: input.session.workflowRunId,
        workflowRevision: input.session.workflowRun?.currentStepIndex,
        latestEventSeq: input.latestEventSeq
      };
      const payload = {
        sessionId: input.session.id,
        sourceEventId: input.sourceEventId,
        activeWorkItemId: active?.id,
        activeWorkItem: active ? workItemSummary(active) : undefined,
        currentMessage: input.currentMessage,
        mentionedAgentIds,
        replyToEventId: replyTarget?.id,
        replyToMessage: replyTarget ? messageExcerpt(replyTarget) : undefined,
        recentRelevantMessages: recentRelevantMessages.length ? recentRelevantMessages : undefined,
        bounds,
        recall: {
          availability: recall.availability,
          needsClarification: recall.needsClarification,
          ...(recall.clarificationReason ? { clarificationReason: recall.clarificationReason } : {}),
          candidates: recall.candidates.map((candidate) => ({
            workItemId: candidate.workItemId,
            matchedBy: candidate.matchedBy,
            matchedTerms: candidate.matchedTerms,
            ...(candidate.latestCheckpointId ? { latestCheckpointId: candidate.latestCheckpointId } : {})
          }))
        },
        pendingConfirmation: input.pendingConfirmation,
        pendingConfirmationContext: input.pendingConfirmationContext,
        validDecisionIds: activeDecisions.map((item) => item.id),
        validDecisions: activeDecisions.map((item) => ({
          id: item.id,
          kind: item.kind,
          status: item.status,
          content: item.content,
          revision: item.revision
        })),
        candidateWorkItemIds: candidates.map((item) => item.id),
        candidateWorkItems: candidates.map(workItemSummary),
        failureCheckpoint: input.failureCheckpoint,
        revision
      };
      const snapshot: IntentContextSnapshot = {
        id: crypto.randomUUID(),
        ...payload,
        businessFingerprint: routingBusinessFingerprint(input.session, workItems,
          this.collection<CollaborationEvent>('eventsBySession')[input.session.id] ?? [],
          this.collection<AgentTask>('tasksBySession')[input.session.id] ?? []),
        snapshotHash: createHash('sha256').update(stableJson(payload)).digest('hex'),
        createdAt: new Date().toISOString()
      };
      await this.mutate((draft) => {
        const snapshots = collectionFromDraft<IntentContextSnapshot>(draft, 'contextSnapshotsBySession');
        (snapshots[input.session.id] ??= []).push(snapshot);
        draft.contextSnapshotsBySession = snapshots;
      });
      return snapshot;
    });
  }

  async createRoutingRecord(input: {
    session: SessionDetail;
    sourceEventId: string;
    idempotencyKey: string;
    rolloutMode: IntentRoutingRolloutMode;
    policyVersion?: string;
  }) {
    return this.serialized(input.session.id, async () => {
      const existing = this.listRoutingRecords(input.session.id).find(
        (record) => record.idempotencyKey === input.idempotencyKey
      );
      if (existing) return existing;
      const now = new Date().toISOString();
      const records = this.listRoutingRecords(input.session.id);
      const record: IntentRoutingRecord = {
        id: crypto.randomUUID(),
        sessionId: input.session.id,
        sourceEventId: input.sourceEventId,
        sessionSeq: Math.max(0, ...records.map((item) => item.sessionSeq)) + 1,
        status: 'RECEIVED',
        policyVersion: input.policyVersion ?? 'intent-v2.1',
        rolloutMode: input.rolloutMode,
        reasonCodes: [],
        retryCount: 0,
        idempotencyKey: input.idempotencyKey,
        createdAt: now,
        updatedAt: now
      };
      await this.mutate((draft) => {
        const routings = collectionFromDraft<IntentRoutingRecord>(draft, 'intentRoutingRecordsBySession');
        (routings[input.session.id] ??= []).push(record);
        draft.intentRoutingRecordsBySession = routings;
      });
      return record;
    });
  }

  async commitMessageIngress(input: {
    session: SessionDetail;
    event: CollaborationEvent;
    followUp: SessionFollowUpMessage;
    rolloutMode: IntentRoutingRolloutMode;
    routingIdempotencyKey: string;
    initialGoal?: string;
    /**
     * A budget-exhausted requirement can only recover through a fresh related
     * WorkItem. This is a server-enforced routing invariant, not a model hint.
     */
    forceNewRelatedWorkItem?: boolean;
    additionalEvents?: CollaborationEvent[];
  }): Promise<MessageIngressCommitResult> {
    return this.serialized(input.session.id, async () => {
      const committed = await this.mutate((draft) => {
        const sessions = Array.isArray(draft.sessions) ? draft.sessions as SessionDetail[] : [];
        const projectedSession = sessions.find((item) => item.id === input.session.id);
        if (!projectedSession) throw new NotFoundException(`Session projection not found during message ingress: ${input.session.id}`);

        const events = collectionFromDraft<CollaborationEvent>(draft, 'eventsBySession');
        const sessionEvents = (events[input.session.id] ??= []);
        const messageIdempotencyKey = input.event.metadata.idempotencyKey;
        const existingEvent = messageIdempotencyKey
          ? sessionEvents.find((item) => item.metadata.idempotencyKey === messageIdempotencyKey)
          : sessionEvents.find((item) => item.id === input.event.id);
        const followUps = collectionFromDraft<SessionFollowUpMessage>(draft, 'followUpMessagesBySession');
        const sessionFollowUps = (followUps[input.session.id] ??= []);
        const routings = collectionFromDraft<IntentRoutingRecord>(draft, 'intentRoutingRecordsBySession');
        const sessionRoutings = (routings[input.session.id] ??= []);
        const workItems = collectionFromDraft<WorkItem>(draft, 'workItemsBySession');
        const sessionWorkItems = (workItems[input.session.id] ??= []);

        if (existingEvent) {
          const existingFollowUp = sessionFollowUps.find((item) => item.sourceEventId === existingEvent.id);
          const existingRouting = existingFollowUp?.routingId
            ? sessionRoutings.find((item) => item.id === existingFollowUp.routingId)
            : sessionRoutings.find((item) => item.sourceEventId === existingEvent.id);
          const existingWorkItem = sessionWorkItems.find((item) => item.id === existingFollowUp?.workItemId) ??
            sessionWorkItems.find((item) => item.id === projectedSession.activeWorkItemId);
          if (!existingFollowUp || !existingRouting || !existingWorkItem) {
            throw new BadRequestException('IDEMPOTENCY_STATE_INCOMPLETE: message ingress replay has incomplete projections.');
          }
          return {
            event: existingEvent,
            followUp: existingFollowUp,
            routing: existingRouting,
            workItem: existingWorkItem,
            idempotentReplay: true
          };
        }

        const now = new Date().toISOString();
        let workItem = sessionWorkItems.find((item) => item.id === projectedSession.activeWorkItemId);
        if (!workItem) {
          workItem = {
            id: crypto.randomUUID(),
            sessionId: input.session.id,
            title: projectedSession.title.trim().slice(0, 120) || 'New requirement',
            goal: (input.initialGoal ?? projectedSession.originalInput).trim(),
            status: 'OPEN',
            revision: 1,
            createdFromEventId: input.event.id,
            inheritedDecisionIds: [],
            inheritedArtifactIds: [],
            createdAt: now,
            updatedAt: now
          };
          sessionWorkItems.push(workItem);
          projectedSession.activeWorkItemId = workItem.id;
        }
        const previousWorkItem = workItem;
        if (input.forceNewRelatedWorkItem && previousWorkItem) {
          // Do not inherit decisions or artifacts implicitly. The new user
          // message is a narrowed/split requirement, so it receives a clean
          // budget ledger and only a parent link for auditability.
          workItem = {
            id: crypto.randomUUID(),
            sessionId: input.session.id,
            parentWorkItemId: previousWorkItem.id,
            title: input.followUp.content.trim().slice(0, 120) || '拆分后的需求',
            goal: input.followUp.content.trim(),
            status: 'OPEN',
            revision: 1,
            createdFromEventId: input.event.id,
            inheritedDecisionIds: [],
            inheritedArtifactIds: [],
            createdAt: now,
            updatedAt: now
          };
          if (!workItem.goal) throw new BadRequestException('A replacement WorkItem requires user input.');
          previousWorkItem.status = 'WAITING_USER';
          previousWorkItem.revision += 1;
          previousWorkItem.updatedAt = now;
          sessionWorkItems.push(workItem);
          projectedSession.activeWorkItemId = workItem.id;
        }
        const routing: IntentRoutingRecord = {
          id: crypto.randomUUID(),
          sessionId: input.session.id,
          sourceEventId: input.event.id,
          sessionSeq: Math.max(0, ...sessionRoutings.map((item) => item.sessionSeq)) + 1,
          status: 'RECEIVED',
          policyVersion: 'intent-v2.1',
          rolloutMode: input.rolloutMode,
          reasonCodes: [],
          retryCount: 0,
          idempotencyKey: input.routingIdempotencyKey,
          createdAt: now,
          updatedAt: now
        };
        if (input.forceNewRelatedWorkItem) {
          routing.forcedWorkItemId = workItem.id;
          routing.reasonCodes.push('WORK_ITEM_BUDGET_EXHAUSTION_REPLACEMENT');
        }
        const followUp: SessionFollowUpMessage = {
          ...structuredClone(input.followUp),
          workItemId: workItem.id,
          routingId: routing.id
        };
        const additionalEvents = input.additionalEvents ?? [];
        sessionEvents.push(structuredClone(input.event), ...additionalEvents.map((item) => structuredClone(item)));
        sessionFollowUps.push(followUp);
        sessionRoutings.push(routing);
        projectedSession.pendingFollowUpMessages = [
          ...(projectedSession.pendingFollowUpMessages ?? []),
          structuredClone(followUp)
        ];
        projectedSession.revision = (projectedSession.revision ?? 1) + 1;
        projectedSession.updatedAt = now;
        appendEventOutbox(draft, input.event);
        for (const additionalEvent of additionalEvents) appendEventOutbox(draft, additionalEvent);
        draft.sessions = sessions;
        draft.eventsBySession = events;
        draft.followUpMessagesBySession = followUps;
        draft.intentRoutingRecordsBySession = routings;
        draft.workItemsBySession = workItems;
        return {
          event: input.event,
          followUp,
          routing,
          workItem,
          ...(additionalEvents.length ? { additionalEvents } : {}),
          idempotentReplay: false
        };
      }, input.session.id);

      input.session.activeWorkItemId = committed.workItem.id;
      input.session.pendingFollowUpMessages = [
        ...(input.session.pendingFollowUpMessages ?? []),
        ...(!committed.idempotentReplay ? [structuredClone(committed.followUp)] : [])
      ];
      if (!committed.idempotentReplay) {
        input.session.revision = (input.session.revision ?? 1) + 1;
        input.session.updatedAt = committed.routing.updatedAt;
      }
      return committed;
    });
  }

  async saveFollowUp(sessionId: string, followUp: SessionFollowUpMessage) {
    return this.serialized(sessionId, async () => {
      await this.mutate((draft) => {
        const followUps = collectionFromDraft<SessionFollowUpMessage>(draft, 'followUpMessagesBySession');
        const sessionFollowUps = (followUps[sessionId] ??= []);
        const index = sessionFollowUps.findIndex((item) => item.id === followUp.id);
        const copy = structuredClone(followUp);
        if (index >= 0) sessionFollowUps[index] = copy;
        else sessionFollowUps.push(copy);
        draft.followUpMessagesBySession = followUps;
      });
      return followUp;
    });
  }

  async applyIntentRoute(input: {
    session: SessionDetail;
    routingId: string;
    snapshotId: string;
    followUpId: string;
    decision: IntentRoutingDecisionV2;
    validation: IntentRoutingValidation;
    expectedLeaseOwner?: string;
    handlingPlan?: SessionFollowUpMessage['handlingPlan'];
    routeEventFactory?: (route: Omit<AppliedIntentRoute, 'committedEvent' | 'committedEvents' | 'followUp'>) => CollaborationEvent;
    additionalEvents?: CollaborationEvent[];
  }): Promise<AppliedIntentRoute> {
    return this.serialized(input.session.id, async () => {
      let applied: AppliedIntentRoute | undefined;
      let stale = false;
      let projectedDecisionLedgerRevision: number | undefined;
      await this.mutate((draft) => {
        const sessions = Array.isArray(draft.sessions) ? draft.sessions as SessionDetail[] : [];
        const projectedSession = sessions.find((item) => item.id === input.session.id);
        if (!projectedSession) {
          throw new NotFoundException(`Session projection not found during route apply: ${input.session.id}`);
        }
        const workItems = collectionFromDraft<WorkItem>(draft, 'workItemsBySession');
        const sessionWorkItems = (workItems[input.session.id] ??= []);
        const snapshots = collectionFromDraft<IntentContextSnapshot>(draft, 'contextSnapshotsBySession');
        const snapshot = (snapshots[input.session.id] ?? []).find((item) => item.id === input.snapshotId);
        if (!snapshot) throw new NotFoundException(`IntentContextSnapshot not found: ${input.snapshotId}`);
        const routings = collectionFromDraft<IntentRoutingRecord>(draft, 'intentRoutingRecordsBySession');
        const routing = (routings[input.session.id] ?? []).find((item) => item.id === input.routingId);
        if (!routing) throw new NotFoundException(`IntentRoutingRecord not found: ${input.routingId}`);
        const followUps = collectionFromDraft<SessionFollowUpMessage>(draft, 'followUpMessagesBySession');
        const followUp = (followUps[input.session.id] ?? []).find((item) => item.id === input.followUpId);
        if (!followUp) throw new NotFoundException(`SessionFollowUpMessage not found: ${input.followUpId}`);

        if (routing.status === 'ROUTED') {
          const existing = sessionWorkItems.find((item) => item.id === followUp.workItemId);
          if (!existing) throw new BadRequestException('Applied routing has no valid WorkItem projection.');
          const current = sessionWorkItems.find((item) => item.id === projectedSession.activeWorkItemId);
          const deferredActivation = routing.deferredActivation ??
            (existing.id !== current?.id && isExecutionActive(projectedSession));
          applied = { routing, workItem: existing, followUp, createdWorkItem: false, deferredActivation };
          return;
        }
        if (routing.status !== 'VALIDATING' || !input.validation.safeToApply) {
          throw new BadRequestException(`Intent route is not safe to apply from state ${routing.status}.`);
        }
        assertRoutingLease(routing, input.expectedLeaseOwner);
        if (!snapshotMatchesProjection(projectedSession, sessionWorkItems, snapshot,
          collectionFromDraft<CollaborationEvent>(draft, 'eventsBySession')[input.session.id] ?? [],
          collectionFromDraft<AgentTask>(draft, 'tasksBySession')[input.session.id] ?? [])) {
          routing.status = 'PENDING_RETRY';
          routing.reasonCodes = [...new Set([...routing.reasonCodes, 'SNAPSHOT_STALE'])];
          routing.updatedAt = new Date().toISOString();
          draft.intentRoutingRecordsBySession = routings;
          stale = true;
          return;
        }

        const current = sessionWorkItems.find((item) => item.id === projectedSession.activeWorkItemId);
        const previousWorkItemId = current?.id;
        const forcedTarget = routing.forcedWorkItemId
          ? sessionWorkItems.find((item) => item.id === routing.forcedWorkItemId)
          : undefined;
        if (routing.forcedWorkItemId && !forcedTarget) {
          throw new BadRequestException('Forced replacement WorkItem is no longer available.');
        }
        let target = forcedTarget ?? (input.decision.selectedWorkItemId
          ? sessionWorkItems.find((item) => item.id === input.decision.selectedWorkItemId)
          : current);
        let createdWorkItem = false;
        if (
          input.decision.requestedAction === 'create_related_work_item' ||
          input.decision.requestedAction === 'create_independent_work_item'
        ) {
          const related = input.decision.requestedAction === 'create_related_work_item';
          const selectedDecisionIds = related ? [...new Set(input.decision.selectedDecisionIds)] : [];
          const decisions = collectionFromDraft<DecisionRecord>(draft, 'decisionRecordsBySession')[input.session.id] ?? [];
          const invalidDecisionIds = selectedDecisionIds.filter((id) =>
            !decisions.some((item) => item.id === id && item.status === 'confirmed')
          );
          if (invalidDecisionIds.length) {
            throw new BadRequestException(`Cannot inherit invalid decisions: ${invalidDecisionIds.join(', ')}`);
          }
          const now = new Date().toISOString();
          const goal = input.decision.goalSegments.join('\n').trim() || followUp.content.trim();
          target = {
            id: crypto.randomUUID(),
            sessionId: input.session.id,
            parentWorkItemId: related ? current?.id : undefined,
            title: goal.slice(0, 120) || '新需求',
            goal,
            status: 'OPEN',
            revision: 1,
            createdFromEventId: routing.sourceEventId,
            inheritedDecisionIds: selectedDecisionIds,
            inheritedArtifactIds: related ? [...new Set(input.decision.selectedArtifactIds)] : [],
            createdAt: now,
            updatedAt: now
          };
          sessionWorkItems.push(target);
          createdWorkItem = true;
        }
        if (!target) throw new BadRequestException('Intent route did not resolve a target WorkItem.');

        const deferredActivation = target.id !== current?.id && isExecutionActive(projectedSession);
        if (!deferredActivation) projectedSession.activeWorkItemId = target.id;
        projectedSession.revision = (projectedSession.revision ?? 1) + 1;
        projectedSession.updatedAt = new Date().toISOString();
        followUp.workItemId = target.id;
        if (input.handlingPlan) {
          followUp.handlingPlan = routing.forcedWorkItemId
            ? {
                ...input.handlingPlan,
                requirementRelation: 'new_requirement',
                failedExecutionAction: 'replan'
              }
            : input.handlingPlan;
        }
        routing.status = 'ROUTED';
        routing.decision = input.decision;
        routing.validation = input.validation;
        routing.finalAction = input.decision.requestedAction;
        routing.deferredActivation = deferredActivation;
        routing.actionStatus = ['pause', 'cancel', 'resume', 'replan'].includes(input.decision.requestedAction)
          ? 'pending'
          : 'applied';
        delete routing.leaseOwner;
        delete routing.leaseExpiresAt;
        routing.updatedAt = projectedSession.updatedAt;
        draft.sessions = sessions;
        draft.workItemsBySession = workItems;
        draft.followUpMessagesBySession = followUps;
        draft.intentRoutingRecordsBySession = routings;
        const route = { routing, workItem: target, createdWorkItem, previousWorkItemId, deferredActivation };
        const routeDecisionKind = decisionKindForIntent(input.decision.dialogueAct);
        if (routeDecisionKind) {
          const decisions = collectionFromDraft<DecisionRecord>(draft, 'decisionRecordsBySession');
          const sessionDecisions = (decisions[input.session.id] ??= []);
          const content = input.decision.goalSegments.join('\n').trim() || followUp.content.trim();
          const existingDecision = sessionDecisions.find((item) =>
            item.sourceEventId === followUp.sourceEventId &&
            item.workItemId === target.id &&
            item.kind === routeDecisionKind &&
            item.content === content
          );
          if (!existingDecision) {
            const now = new Date().toISOString();
            sessionDecisions.push({
              id: crypto.randomUUID(),
              sessionId: input.session.id,
              workItemId: target.id,
              kind: routeDecisionKind,
              status: 'confirmed',
              content,
              sourceEventId: followUp.sourceEventId,
              revision: 1,
              confirmedBy: { type: 'user', id: projectedSession.ownerId },
              createdAt: now,
              updatedAt: now
            });
            draft.decisionRecordsBySession = decisions;
            projectedSession.decisionLedgerRevision = (projectedSession.decisionLedgerRevision ?? 0) + 1;
            projectedDecisionLedgerRevision = projectedSession.decisionLedgerRevision;
          }
        }
        const committedEvent = input.routeEventFactory?.(route);
        const committedEvents = [...(committedEvent ? [committedEvent] : []), ...(input.additionalEvents ?? [])];
        if (committedEvents.length) {
          const events = collectionFromDraft<CollaborationEvent>(draft, 'eventsBySession');
          (events[input.session.id] ??= []).push(...committedEvents);
          for (const event of committedEvents) appendEventOutbox(draft, event);
          draft.eventsBySession = events;
        }
        applied = { ...route, followUp, committedEvent, committedEvents };
      });
      if (stale) throw new BadRequestException('SNAPSHOT_STALE: intent route must be rebuilt before apply.');
      if (!applied) throw new BadRequestException('Intent route apply produced no result.');
      if (!applied.deferredActivation) input.session.activeWorkItemId = applied.workItem.id;
      if (projectedDecisionLedgerRevision !== undefined) {
        input.session.decisionLedgerRevision = projectedDecisionLedgerRevision;
      }
      input.session.revision = (input.session.revision ?? 1) + 1;
      input.session.updatedAt = applied.routing.updatedAt;
      return applied;
    });
  }

  async deleteSession(sessionId: string) {
    return this.serialized(sessionId, () => this.mutate((draft) => {
      for (const key of [
        'workItemsBySession',
        'decisionRecordsBySession',
        'contextSnapshotsBySession',
        'intentRoutingRecordsBySession',
        'followUpMessagesBySession'
      ]) {
        const collection = collectionFromDraft<unknown>(draft, key);
        delete collection[sessionId];
        draft[key] = collection;
      }
    }));
  }

  async updateRoutingRecord(
    sessionId: string,
    routingId: string,
    patch: Partial<Pick<IntentRoutingRecord,
      'status' | 'snapshotId' | 'invocationId' | 'decision' | 'validation' | 'finalAction' | 'actionStatus' |
      'leaseOwner' | 'leaseExpiresAt' | 'reasonCodes' | 'retryCount'>>,
    expectedLeaseOwner?: string
  ) {
    return this.serialized(sessionId, async () => {
      const current = this.listRoutingRecords(sessionId).find((record) => record.id === routingId);
      if (!current) throw new NotFoundException(`IntentRoutingRecord not found: ${routingId}`);
      if (patch.status && patch.status !== current.status && !allowedRoutingTransitions(current.status).includes(patch.status)) {
        throw new BadRequestException(`Invalid intent routing transition: ${current.status} -> ${patch.status}`);
      }
      const updated: IntentRoutingRecord = {
        ...current,
        ...patch,
        id: current.id,
        sessionId: current.sessionId,
        sourceEventId: current.sourceEventId,
        sessionSeq: current.sessionSeq,
        policyVersion: current.policyVersion,
        rolloutMode: current.rolloutMode,
        idempotencyKey: current.idempotencyKey,
        createdAt: current.createdAt,
        updatedAt: new Date().toISOString()
      };
      if (['ROUTED', 'CLARIFICATION_REQUIRED', 'REJECTED'].includes(updated.status)) {
        delete updated.leaseOwner;
        delete updated.leaseExpiresAt;
      }
      await this.mutate((draft) => {
        const routings = collectionFromDraft<IntentRoutingRecord>(draft, 'intentRoutingRecordsBySession');
        const index = (routings[sessionId] ?? []).findIndex((record) => record.id === routingId);
        if (index < 0) throw new NotFoundException(`IntentRoutingRecord not found during mutation: ${routingId}`);
        const fresh = routings[sessionId][index];
        if (expectedLeaseOwner) assertRoutingLease(fresh, expectedLeaseOwner);
        if (fresh.updatedAt !== current.updatedAt || fresh.status !== current.status || fresh.leaseOwner !== current.leaseOwner) {
          throw new BadRequestException('ROUTING_LEASE_LOST: routing changed during update.');
        }
        routings[sessionId][index] = { ...updated, snapshotRebuildCount: fresh.snapshotRebuildCount };
        draft.intentRoutingRecordsBySession = routings;
      }, sessionId);
      return updated;
    });
  }

  async updateFollowUpStatus(
    sessionId: string,
    followUpId: string,
    status: SessionFollowUpMessage['status']
  ) {
    return this.serialized(sessionId, async () => {
      const followUps = this.listFollowUps(sessionId);
      const current = followUps.find((item) => item.id === followUpId);
      if (!current) throw new NotFoundException(`SessionFollowUpMessage not found: ${followUpId}`);
      const updated = { ...current, status };
      await this.mutate((draft) => {
        const collection = collectionFromDraft<SessionFollowUpMessage>(draft, 'followUpMessagesBySession');
        const index = (collection[sessionId] ?? []).findIndex((item) => item.id === followUpId);
        if (index < 0) throw new NotFoundException(`SessionFollowUpMessage not found during status mutation: ${followUpId}`);
        collection[sessionId][index] = updated;
        draft.followUpMessagesBySession = collection;
      }, sessionId);
      return updated;
    });
  }

  async updateRoutingActionStatus(
    sessionId: string,
    routingId: string,
    actionStatus: NonNullable<IntentRoutingRecord['actionStatus']>
  ) {
    return this.updateRoutingRecord(sessionId, routingId, { actionStatus });
  }

  async claimIntentRouting(
    sessionId: string,
    routingId: string,
    snapshotId: string,
    workerId: string,
    leaseMs = 120_000
  ): Promise<IntentRoutingClaimResult> {
    return this.serialized(sessionId, async () => {
      let result: IntentRoutingClaimResult | undefined;
      await this.mutate((draft) => {
        const routings = collectionFromDraft<IntentRoutingRecord>(draft, 'intentRoutingRecordsBySession');
        const records = routings[sessionId] ?? [];
        const current = records.find((item) => item.id === routingId);
        if (!current) throw new NotFoundException(`IntentRoutingRecord not found: ${routingId}`);
        if (['ROUTED', 'CLARIFICATION_REQUIRED', 'REJECTED'].includes(current.status)) {
          result = { state: 'terminal', routing: structuredClone(current) };
          return;
        }
        const earlier = records
          .filter((item) => item.sessionSeq < current.sessionSeq &&
            !['ROUTED', 'CLARIFICATION_REQUIRED', 'REJECTED'].includes(item.status))
          .sort((left, right) => left.sessionSeq - right.sessionSeq)[0];
        if (earlier) {
          result = {
            state: 'blocked',
            routing: structuredClone(current),
            blockingRouting: structuredClone(earlier)
          };
          return;
        }
        const now = Date.now();
        const active = ['CLASSIFYING', 'VALIDATING', 'APPLYING'].includes(current.status);
        const leaseExpiresAt = Date.parse(current.leaseExpiresAt ?? '');
        if (active && (!Number.isFinite(leaseExpiresAt) || leaseExpiresAt > now)) {
          result = { state: 'blocked', routing: structuredClone(current) };
          return;
        }
        const reclaimed = active;
        current.status = 'CLASSIFYING';
        current.snapshotId = snapshotId;
        current.leaseOwner = workerId;
        current.leaseExpiresAt = new Date(now + Math.max(1, leaseMs)).toISOString();
        if (reclaimed) current.retryCount += 1;
        current.reasonCodes = [...new Set([
          ...current.reasonCodes,
          reclaimed ? 'ROUTING_LEASE_RECLAIMED' : 'ROUTING_CLAIMED'
        ])];
        current.updatedAt = new Date(now).toISOString();
        routings[sessionId] = records;
        draft.intentRoutingRecordsBySession = routings;
        result = { state: 'claimed', routing: structuredClone(current) };
      }, sessionId);
      if (!result) throw new Error('Intent routing claim produced no result.');
      return result;
    });
  }

  private assertInheritedDecisions(sessionId: string, decisionIds: string[]) {
    if (!decisionIds.length) return;
    const decisions = new Map(this.listDecisions(sessionId).map((item) => [item.id, item]));
    const invalid = decisionIds.filter((id) => decisions.get(id)?.status !== 'confirmed');
    if (invalid.length) throw new BadRequestException(`Only confirmed Session decisions can be inherited: ${invalid.join(', ')}`);
  }

  /**
   * Inherited artifacts are evidence the new requirement claims to build on, so
   * they must be real artifacts of this Session. Decisions were already guarded;
   * artifact ids used to be copied verbatim, which let an id from another
   * Session — or a typo — be recorded as inherited evidence (phase 5 AC5).
   */
  private assertInheritedArtifacts(sessionId: string, artifactIds: string[]) {
    if (!artifactIds.length) return;
    const artifacts = this.persistence.getCollection<{
      artifactIdsBySession?: Record<string, string[]>;
    }>('artifacts', {});
    const owned = new Set(artifacts.artifactIdsBySession?.[sessionId] ?? []);
    const invalid = artifactIds.filter((id) => !owned.has(id));
    if (invalid.length) {
      throw new BadRequestException(`Only this Session's artifacts can be inherited: ${invalid.join(', ')}`);
    }
  }

  private collection<T>(key: string): BySession<T> {
    return this.persistence.getCollection<BySession<T>>(key, {});
  }

  private async mutate<T>(mutator: (draft: PersistedState) => T, sessionId?: string): Promise<T> {
    return this.persistence.mutateCollections([
      'workItemsBySession', 'decisionRecordsBySession', 'contextSnapshotsBySession',
      'intentRoutingRecordsBySession', 'followUpMessagesBySession', 'sessions',
      'tasksBySession', 'eventsBySession', 'eventOutbox'
    ], mutator);
  }

  private serialized<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.sessionLocks.get(sessionId) ?? Promise.resolve();
    const current = previous.then(operation, operation);
    this.sessionLocks.set(sessionId, current.then(() => undefined, () => undefined));
    return current;
  }
}

function collectionFromDraft<T>(draft: PersistedState, key: string): BySession<T> {
  const value = draft[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as BySession<T>
    : {};
}

function appendEventOutbox(draft: PersistedState, event: CollaborationEvent) {
  const outbox = Array.isArray(draft.eventOutbox)
    ? draft.eventOutbox as Array<Record<string, unknown>>
    : [];
  const id = `outbox:${event.id}`;
  if (outbox.some((item) => item.id === id)) return;
  outbox.push({
    id,
    idempotencyKey: `session:${event.sessionId}:event:${event.id}`,
    aggregateType: 'session',
    aggregateId: event.sessionId,
    eventType: event.type,
    payload: { event },
    status: 'pending',
    attempts: 0,
    createdAt: event.createdAt
  });
  draft.eventOutbox = outbox;
}

function updateSessionProjection(draft: PersistedState, sessionId: string, activeWorkItemId: string) {
  const sessions = Array.isArray(draft.sessions) ? draft.sessions as SessionDetail[] : [];
  const session = sessions.find((item) => item.id === sessionId);
  if (!session) throw new NotFoundException(`Session projection not found during context mutation: ${sessionId}`);
  session.activeWorkItemId = activeWorkItemId;
  session.revision = (session.revision ?? 1) + 1;
  session.updatedAt = new Date().toISOString();
  draft.sessions = sessions;
}

function updateDecisionLedgerProjection(draft: PersistedState, sessionId: string) {
  const sessions = Array.isArray(draft.sessions) ? draft.sessions as SessionDetail[] : [];
  const session = sessions.find((item) => item.id === sessionId);
  if (!session) throw new NotFoundException(`Session projection not found during decision mutation: ${sessionId}`);
  session.decisionLedgerRevision = (session.decisionLedgerRevision ?? 0) + 1;
  session.revision = (session.revision ?? 1) + 1;
  session.updatedAt = new Date().toISOString();
  draft.sessions = sessions;
}

function isExecutionActive(session: SessionDetail) {
  return [
    'AGENT_DISCUSSING',
    'REVISING_BRIEF',
    'EXECUTING',
    'POST_REVIEW',
    'REWORKING',
    'APPLYING_CHANGES',
    'WAIT_USER_DECISION'
  ].includes(session.status);
}

function uniqueById<T extends { id: string }>(items: T[]) {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

/** Truncates one durable event into a bounded excerpt; the full payload never reaches the classifier. */
function messageExcerpt(event: CollaborationEvent): IntentSnapshotMessageExcerpt {
  const content = event.content ?? '';
  const truncated = content.length > SNAPSHOT_MESSAGE_CHAR_LIMIT;
  return {
    eventId: event.id,
    role: event.actor?.type === 'user' ? 'user' : event.fromAgentId ? 'agent' : 'system',
    content: truncated ? content.slice(0, SNAPSHOT_MESSAGE_CHAR_LIMIT) : content,
    ...(truncated ? { truncated: true } : {}),
    createdAt: event.createdAt
  };
}

function workItemSummary(item: WorkItem): Pick<WorkItem, 'id' | 'title' | 'goal' | 'status' | 'revision'> {
  return {
    id: item.id,
    title: item.title,
    goal: item.goal,
    status: item.status,
    revision: item.revision
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function snapshotMatchesProjection(
  session: SessionDetail,
  workItems: WorkItem[],
  snapshot: IntentContextSnapshot,
  events: CollaborationEvent[] = [],
  tasks: AgentTask[] = []
) {
  if (snapshot.businessFingerprint) return snapshot.businessFingerprint === routingBusinessFingerprint(session, workItems, events, tasks);
  const active = workItems.find((item) => item.id === session.activeWorkItemId);
  return snapshot.revision.sessionRevision === (session.revision ?? 1) &&
    snapshot.revision.activeWorkItemId === active?.id &&
    snapshot.revision.activeWorkItemRevision === active?.revision &&
    snapshot.revision.decisionLedgerRevision === (session.decisionLedgerRevision ?? 0) &&
    snapshot.revision.workflowRunId === session.workflowRunId &&
    snapshot.revision.workflowRevision === session.workflowRun?.currentStepIndex;
}

function routingBusinessFingerprint(session: SessionDetail, workItems: WorkItem[], events: CollaborationEvent[], tasks: AgentTask[]) {
  const businessEvents = new Set(['user_message', 'user_confirmation_requested', 'user_confirmation_resolved',
    'intent_clarification_required', 'brief_confirmed', 'brief_revised']);
  return createHash('sha256').update(stableJson({
    sessionRevision: session.revision ?? 1, status: session.status, goal: session.originalInput,
    contractGoal: session.latestContractGoal, activeWorkItemId: session.activeWorkItemId,
    decisionLedgerRevision: session.decisionLedgerRevision ?? 0,
    workflowRunId: session.workflowRunId, workflowStep: session.workflowRun?.currentStepIndex,
    tasks: tasks.map(task => ({ id: task.id, workItemId: task.workItemId, status: task.status,
      assignee: task.assignee, description: task.description, acceptanceCriteria: task.acceptanceCriteria,
      dependsOnTaskIds: task.dependsOnTaskIds, requiresUserConfirmation: task.requiresUserConfirmation })),
    workItems: workItems.map(workItemSummary),
    businessEvents: events.filter(event => businessEvents.has(event.type)).map(event => event.id)
  })).digest('hex');
}

function assertRoutingLease(routing: IntentRoutingRecord, expectedLeaseOwner?: string) {
  if ((routing.leaseOwner || expectedLeaseOwner) &&
    (!expectedLeaseOwner || routing.leaseOwner !== expectedLeaseOwner ||
      !(Date.parse(routing.leaseExpiresAt ?? '') > Date.now()))) {
    throw new BadRequestException('ROUTING_LEASE_LOST: stale classifier cannot update or apply this route.');
  }
}

function allowedRoutingTransitions(status: IntentRoutingRecord['status']): IntentRoutingRecord['status'][] {
  const transitions: Record<IntentRoutingRecord['status'], IntentRoutingRecord['status'][]> = {
    RECEIVED: ['SNAPSHOT_READY', 'REJECTED'],
    SNAPSHOT_READY: ['CLASSIFYING', 'REJECTED'],
    CLASSIFYING: ['VALIDATING', 'PENDING_RETRY', 'CLARIFICATION_REQUIRED', 'REJECTED'],
    VALIDATING: ['APPLYING', 'ROUTED', 'CLARIFICATION_REQUIRED', 'PENDING_RETRY', 'REJECTED'],
    APPLYING: ['ROUTED', 'PENDING_RETRY', 'REJECTED'],
    ROUTED: [],
    CLARIFICATION_REQUIRED: ['SNAPSHOT_READY', 'REJECTED'],
    PENDING_RETRY: ['SNAPSHOT_READY', 'CLASSIFYING', 'CLARIFICATION_REQUIRED', 'REJECTED'],
    REJECTED: []
  };
  return transitions[status];
}

function decisionKindForIntent(intent: IntentRoutingDecisionV2['dialogueAct']): DecisionRecordKind | undefined {
  if (intent === 'constraint') return 'constraint';
  if (intent === 'correction') return 'correction';
  if (intent === 'preference_input') return 'preference';
  return undefined;
}
