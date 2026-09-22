import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Subject } from 'rxjs';
import type { ActorRef, CollaborationEvent, CollaborationEventType, EventMetadata, UUID } from '@agent-cluster/shared';
import { nowIso } from '../../common/time.js';
import { workspaceMetrics } from '../../common/workspace-metrics.js';
import { PersistenceService } from '../persistence/persistence.service.js';
import { deriveActor } from './derive-actor.js';

export const EVENT_PAGE_DEFAULT = 200;
export const EVENT_PAGE_MAX = 500;
export const EVENT_PAGE_CACHE_MAX = 32;

type EventPage = { items: CollaborationEvent[]; hasMore: boolean; nextCursor?: string };

export type CreateEventInput<TPayload extends Record<string, unknown> = Record<string, unknown>> = {
  sessionId: UUID;
  workItemId?: UUID;
  type: CollaborationEventType;
  content: string;
  metadata?: EventMetadata<TPayload>;
  fromAgentId?: UUID;
  toAgentIds?: UUID[];
  taskId?: UUID;
  userMessageIntent?: CollaborationEvent['userMessageIntent'];
  priority?: CollaborationEvent['priority'];
  actor?: ActorRef;
  sessionUserId?: UUID;
};

@Injectable()
export class EventsService implements OnModuleDestroy {
  private readonly eventsBySession = new Map<string, CollaborationEvent[]>();
  private readonly pageCache = new Map<string, EventPage>();
  private readonly subjectsBySession = new Map<string, Subject<CollaborationEvent>>();
  private readonly outboxWorkerId = `events:${process.pid}:${crypto.randomUUID()}`;

  constructor(private readonly persistence: PersistenceService) {
    const persisted = this.persistence.getCollection<Record<string, CollaborationEvent[]>>('eventsBySession', {});
    for (const [sessionId, events] of Object.entries(persisted)) {
      this.eventsBySession.set(sessionId, events);
    }
    queueMicrotask(() => void this.recoverPendingOutbox().catch(() => undefined));
  }

  create<TPayload extends Record<string, unknown> = Record<string, unknown>>(
    input: CreateEventInput<TPayload>
  ): CollaborationEvent<TPayload> {
    const event = this.createDraft(input);
    this.appendToMemory(event as CollaborationEvent);
    const committed = this.persistence.appendEvent(event as CollaborationEvent);
    void committed.then((success) => {
      if (success) this.publishCommitted(event as CollaborationEvent);
    });
    return event;
  }

  createDraft<TPayload extends Record<string, unknown> = Record<string, unknown>>(
    input: CreateEventInput<TPayload>
  ): CollaborationEvent<TPayload> {
    const actor: ActorRef =
      input.actor ??
      deriveActor({
        type: input.type,
        fromAgentId: input.fromAgentId,
        sessionUserId: input.sessionUserId
      });
    const event: CollaborationEvent<TPayload> = {
      id: crypto.randomUUID(),
      sessionId: input.sessionId,
      workItemId: input.workItemId,
      type: input.type,
      userMessageIntent: input.userMessageIntent,
      priority: input.priority,
      fromAgentId: input.fromAgentId,
      toAgentIds: input.toAgentIds ?? [],
      taskId: input.taskId,
      content: input.content,
      metadata: input.metadata ?? { schemaVersion: '0.1', payload: {} as TPayload },
      actor,
      createdAt: nowIso()
    };
    return event;
  }

  acceptCommitted(event: CollaborationEvent): boolean {
    if ((this.eventsBySession.get(event.sessionId) ?? []).some((item) => item.id === event.id)) return false;
    this.appendToMemory(event);
    this.publishCommitted(event);
    return true;
  }

  createOnce<TPayload extends Record<string, unknown> = Record<string, unknown>>(
    idempotencyKey: string,
    input: CreateEventInput<TPayload>
  ): CollaborationEvent<TPayload> {
    const existing = (this.eventsBySession.get(input.sessionId) ?? []).find(
      (event) => event.metadata.idempotencyKey === idempotencyKey
    );
    if (existing) return existing as CollaborationEvent<TPayload>;
    return this.create({
      ...input,
      metadata: {
        ...(input.metadata ?? { schemaVersion: '0.1', payload: {} as TPayload }),
        idempotencyKey
      }
    });
  }

  list(sessionId: string, afterEventId?: string) {
    const events = this.eventsBySession.get(sessionId) ?? [];
    if (!afterEventId) {
      return events;
    }
    const index = events.findIndex((event) => event.id === afterEventId);
    return index >= 0 ? events.slice(index + 1) : events;
  }

  /**
   * Redacts a user message in place while keeping an auditable tombstone.
   *
   * A message id is referenced by follow-ups, routing snapshots and attachment
   * records, so physically removing the event would leave dangling references
   * (and cannot be represented by the relational collection writer).  The
   * tombstone keeps the stable id, removes user content and executable refs,
   * and is safe to apply repeatedly.
   */
  async redactUserMessage(sessionId: string, eventId: string, attachmentIds: readonly string[] = []) {
    const events = this.eventsBySession.get(sessionId) ?? [];
    const index = events.findIndex((event) => event.id === eventId);
    if (index < 0) return undefined;
    const current = events[index];
    if (current.type !== 'user_message') return undefined;
    const currentPayload = (current.metadata?.payload ?? {}) as Record<string, unknown>;
    const existingDeletedAt = typeof currentPayload.deletedAt === 'string' ? currentPayload.deletedAt : undefined;
    if (existingDeletedAt) {
      return { event: current, deleted: true as const, alreadyDeleted: true as const };
    }

    const updated = {
      ...current,
      content: '消息已删除',
      metadata: {
        ...current.metadata,
        summary: '消息已删除',
        payload: {
          deleted: true,
          deletedAt: new Date().toISOString(),
          ...(attachmentIds.length ? { deletedAttachmentIds: [...new Set(attachmentIds)] } : {})
        }
      }
    } satisfies typeof current;
    events[index] = updated;
    this.invalidatePages(sessionId);
    try {
      await this.persistAll();
    } catch (error) {
      events[index] = current;
      this.invalidatePages(sessionId);
      throw error;
    }
    return { event: updated, deleted: true as const, alreadyDeleted: false as const };
  }

  /**
   * Cursor page over the durable event log so a long Session can be read in
   * bounded slices instead of one full-history load. `limit` is clamped to
   * [1, EVENT_PAGE_MAX] so a client cannot request the whole log through it.
   */
  async listPage(sessionId: string, options: { afterEventId?: string; limit?: number } = {}) {
    const requested = options.limit ?? EVENT_PAGE_DEFAULT;
    const limit = Number.isFinite(requested)
      ? Math.max(1, Math.min(EVENT_PAGE_MAX, Math.floor(requested)))
      : EVENT_PAGE_DEFAULT;
    const durable = await this.persistence.readEventPage?.(sessionId, { afterEventId: options.afterEventId, limit });
    if (durable) return durable;
    const cacheKey = `${JSON.stringify(sessionId)}:${JSON.stringify(options.afterEventId ?? null)}:${limit}`;
    const cached = this.pageCache.get(cacheKey);
    if (cached) {
      this.pageCache.delete(cacheKey);
      this.pageCache.set(cacheKey, cached);
      return structuredClone(cached);
    }
    const events = this.eventsBySession.get(sessionId) ?? [];
    const cursor = options.afterEventId ? events.findIndex((event) => event.id === options.afterEventId) : -1;
    const start = cursor < 0 ? 0 : cursor + 1;
    const items = events.slice(start, start + limit);
    const hasMore = start + items.length < events.length;
    const page = {
      items,
      hasMore,
      ...(hasMore && items.length ? { nextCursor: items[items.length - 1].id } : {})
    };
    this.pageCache.set(cacheKey, structuredClone(page));
    if (this.pageCache.size > EVENT_PAGE_CACHE_MAX) {
      this.pageCache.delete(this.pageCache.keys().next().value!);
    }
    return page;
  }

  stream(sessionId: string) {
    return this.subjectFor(sessionId).asObservable();
  }

  hasSession(sessionId: string) {
    return this.eventsBySession.has(sessionId);
  }

  deleteSession(sessionId: string) {
    this.invalidatePages(sessionId);
    this.eventsBySession.delete(sessionId);
    const subject = this.subjectsBySession.get(sessionId);
    subject?.complete();
    this.subjectsBySession.delete(sessionId);
    void this.persistAll();
  }

  private subjectFor(sessionId: string) {
    const existing = this.subjectsBySession.get(sessionId);
    if (existing) {
      return existing;
    }
    const subject = new Subject<CollaborationEvent>();
    this.subjectsBySession.set(sessionId, subject);
    return subject;
  }

  onModuleDestroy() {
    for (const subject of this.subjectsBySession.values()) subject.complete();
    this.subjectsBySession.clear();
    this.pageCache.clear();
    return this.persistence.flush();
  }

  private appendToMemory(event: CollaborationEvent) {
    this.invalidatePages(event.sessionId);
    const current = this.eventsBySession.get(event.sessionId) ?? [];
    current.push(event);
    this.eventsBySession.set(event.sessionId, current);
  }

  private invalidatePages(sessionId: string) {
    const prefix = `${JSON.stringify(sessionId)}:`;
    for (const key of this.pageCache.keys()) {
      if (key.startsWith(prefix)) this.pageCache.delete(key);
    }
  }

  private publishCommitted(event: CollaborationEvent) {
    this.subjectFor(event.sessionId).next(event);
    workspaceMetrics.observe('event_outbox_lag_ms', Math.max(0, Date.now() - Date.parse(event.createdAt)), {
      eventType: event.type
    });
    void this.persistence.markEventPublished(event.id);
  }

  private async recoverPendingOutbox() {
    const claimed = await this.persistence.claimPendingEventOutbox(this.outboxWorkerId);
    for (const record of claimed) {
      const payload = record.payload as { event?: CollaborationEvent } | undefined;
      const event = payload?.event;
      const eventId = event?.id ?? String(record.id ?? '').replace(/^outbox:/, '');
      if (!event || !(this.eventsBySession.get(event.sessionId) ?? []).some((item) => item.id === event.id)) {
        if (eventId) await this.persistence.discardEventOutbox(eventId, 'event is not visible in an active session');
        continue;
      }
      workspaceMetrics.observe('event_outbox_lag_ms', Math.max(0, Date.now() - Date.parse(event.createdAt)), {
        eventType: event.type,
        recovery: 'true'
      });
      this.publishCommitted(event);
    }
  }

  private persistAll() {
    return this.persistence.setCollection('eventsBySession', Object.fromEntries(this.eventsBySession));
  }
}
