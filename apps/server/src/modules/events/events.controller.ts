import { Controller, Get, Param, Query, Res, Sse } from '@nestjs/common';
import { map } from 'rxjs';
import { ok } from '../../common/api-response.js';
import { EventsService } from './events.service.js';

@Controller('sessions/:sessionId/events')
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Get()
  list(@Param('sessionId') sessionId: string, @Query('afterEventId') afterEventId?: string) {
    return ok({
      items: this.events.list(sessionId, afterEventId),
      hasMore: false
    });
  }

  @Sse('stream')
  stream(@Param('sessionId') sessionId: string, @Res({ passthrough: true }) response: { setHeader: (key: string, value: string) => void }) {
    response.setHeader('Cache-Control', 'no-cache');
    return this.events.stream(sessionId).pipe(
      map((event) => ({
        id: event.id,
        type: 'collaboration-event',
        data: event
      }))
    );
  }
}
