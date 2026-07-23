import { Controller, Get, Param, Query, Res, Sse } from '@nestjs/common';
import { filter, map } from 'rxjs';
import { ok } from '../../common/api-response.js';
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
  stream(@Param('sessionId') sessionId: string, @Res({ passthrough: true }) response: { setHeader: (key: string, value: string) => void }) {
    response.setHeader('Cache-Control', 'no-cache');
    return this.events.stream(sessionId).pipe(
      filter(shouldExposeCollaborationEvent),
      map((event) => ({
        id: event.id,
        type: 'collaboration-event',
        data: event
      }))
    );
  }
}
