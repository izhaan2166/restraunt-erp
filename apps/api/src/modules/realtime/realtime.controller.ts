import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { WithMeta } from '../../common/dto/pagination';
import { AuthenticatedOnly, CurrentUser } from '../../common/decorators/auth.decorators';
import type { AuthPrincipal } from '../auth/principal';
import { EventsQuery } from './dto/realtime.dto';
import { RealtimeService } from './realtime.service';

@ApiTags('realtime')
@ApiBearerAuth()
@Controller('realtime')
export class RealtimeController {
  constructor(private readonly realtime: RealtimeService) {}

  /**
   * Events after a cursor, for clients catching up after a reconnect. 410 RESYNC_REQUIRED means
   * the gap is too old (or the cursor is unknown): reload the screen from the REST API instead.
   * Topic rights are checked per branch in the service.
   */
  @Get('events')
  @AuthenticatedOnly()
  async events(@CurrentUser() u: AuthPrincipal, @Query() q: EventsQuery) {
    const r = await this.realtime.eventsAfter(u, q.branchId, q.after, q.topics, q.limit);
    return new WithMeta(r.events, { lastSeq: r.lastSeq, hasMore: r.hasMore, topics: r.topics });
  }
}
