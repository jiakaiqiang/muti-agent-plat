import { Controller, Get, NotFoundException, Param, Query, Sse } from '@nestjs/common';
import { filter, map, merge, timer } from 'rxjs';
import { ok } from '../../common/api-response.js';
import { SkipPersistenceCommit } from '../persistence/skip-persistence-commit.js';
import { EventsService } from './events.service.js';
import { shouldExposeCollaborationEvent } from './public-event-filter.js';

@Controller('sessions/:sessionId/events')
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Get()
  list(@Param('sessionId') sessionId: string, @Query('afterEventId') afterEventId?: string) {
    return ok({
      items: this.events.list(sessionId, afterEventId).filter(shouldExposeCollaborationEvent),
      hasMore: false
    });
  }

  @Sse('stream')
  @SkipPersistenceCommit()
  stream(@Param('sessionId') sessionId: string) {
    if (!this.events.hasSession(sessionId)) {
      throw new NotFoundException(`Session not found: ${sessionId}`);
    }
    const heartbeatMs = sseHeartbeatIntervalMs();
    return merge(
      this.events.stream(sessionId).pipe(
        filter(shouldExposeCollaborationEvent),
        map((event) => ({
          id: event.id,
          type: 'collaboration-event',
          data: event
        }))
      ),
      timer(heartbeatMs, heartbeatMs).pipe(
        map(() => ({
          type: 'heartbeat',
          data: { time: new Date().toISOString() }
        }))
      )
    );
  }
}

export function sseHeartbeatIntervalMs() {
  const configured = Number(process.env.AGENT_CLUSTER_SSE_HEARTBEAT_INTERVAL_MS ?? 15_000);
  return Number.isFinite(configured) && configured >= 1_000 ? Math.floor(configured) : 15_000;
}
