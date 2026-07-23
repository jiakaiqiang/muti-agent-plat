import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Subject } from 'rxjs';
import type { ActorRef, CollaborationEvent, CollaborationEventType, EventMetadata, UUID } from '@agent-cluster/shared';
import { nowIso } from '../../common/time.js';
import { PersistenceService } from '../persistence/persistence.service.js';
import { deriveActor } from './derive-actor.js';

type CreateEventInput<TPayload extends Record<string, unknown> = Record<string, unknown>> = {
  sessionId: UUID;
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
  private readonly subjectsBySession = new Map<string, Subject<CollaborationEvent>>();

  constructor(private readonly persistence: PersistenceService) {
    const persisted = this.persistence.getCollection<Record<string, CollaborationEvent[]>>('eventsBySession', {});
    for (const [sessionId, events] of Object.entries(persisted)) {
      this.eventsBySession.set(sessionId, events);
    }
  }

  create<TPayload extends Record<string, unknown> = Record<string, unknown>>(
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

    const current = this.eventsBySession.get(input.sessionId) ?? [];
    current.push(event as CollaborationEvent);
    this.eventsBySession.set(input.sessionId, current);
    const committed = this.persist();
    void committed.then((success) => {
      if (success) {
        this.subjectFor(input.sessionId).next(event as CollaborationEvent);
        void this.persistence.markEventPublished(event.id);
      }
    });
    return event;
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

  stream(sessionId: string) {
    return this.subjectFor(sessionId).asObservable();
  }

  deleteSession(sessionId: string) {
    this.eventsBySession.delete(sessionId);
    const subject = this.subjectsBySession.get(sessionId);
    subject?.complete();
    this.subjectsBySession.delete(sessionId);
    void this.persist();
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
    return this.persistence.flush();
  }

  private persist() {
    return this.persistence.setCollection('eventsBySession', Object.fromEntries(this.eventsBySession));
  }
}
