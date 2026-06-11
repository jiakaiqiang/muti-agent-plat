import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Subject } from 'rxjs';
import type { CollaborationEvent, CollaborationEventType, EventMetadata, UUID } from '@agent-cluster/shared';
import { nowIso } from '../../common/time.js';
import { PersistenceService } from '../persistence/persistence.service.js';

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
};

@Injectable()
export class EventsService implements OnModuleDestroy {
  private readonly eventsBySession = new Map<string, CollaborationEvent[]>();
  private readonly subjectsBySession = new Map<string, Subject<CollaborationEvent>>();
  private persistTimer?: NodeJS.Timeout;
  private persistDirty = false;
  private readonly flushOnProcessExit = () => this.flushPersist();

  constructor(private readonly persistence: PersistenceService) {
    const persisted = this.persistence.getCollection<Record<string, CollaborationEvent[]>>('eventsBySession', {});
    for (const [sessionId, events] of Object.entries(persisted)) {
      this.eventsBySession.set(sessionId, events);
    }
    // OnModuleDestroy only runs on graceful shutdown; 'exit' also covers process.exit and post-crash termination.
    process.on('exit', this.flushOnProcessExit);
  }

  create<TPayload extends Record<string, unknown> = Record<string, unknown>>(
    input: CreateEventInput<TPayload>
  ): CollaborationEvent<TPayload> {
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
      createdAt: nowIso()
    };

    const current = this.eventsBySession.get(input.sessionId) ?? [];
    current.push(event as CollaborationEvent);
    this.eventsBySession.set(input.sessionId, current);
    this.subjectFor(input.sessionId).next(event as CollaborationEvent);
    this.schedulePersist();
    return event;
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
    this.schedulePersist();
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
    process.removeListener('exit', this.flushOnProcessExit);
    this.flushPersist();
  }

  private schedulePersist() {
    this.persistDirty = true;
    if (this.persistTimer) {
      return;
    }
    this.persistTimer = setTimeout(() => this.flushPersist(), 200);
  }

  private flushPersist() {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    if (!this.persistDirty) {
      return;
    }
    this.persistDirty = false;
    this.persistence.setCollection('eventsBySession', Object.fromEntries(this.eventsBySession));
  }
}
