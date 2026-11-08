import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { RealtimeEvent } from '@prisma/client';
import { Errors } from '../../common/errors/app-error';
import { ENV, type Env } from '../../config/env';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthPrincipal } from '../auth/principal';
import { Topic, canSeeBranch, permittedTopics } from './topics';

export interface EventView {
  /** Gap-free, increasing across the whole system: the cursor for catching up after a reconnect. */
  id: number;
  type: string;
  topic: Topic;
  branchId: string;
  entityType: string;
  entityId: string;
  entityVersion: number | null;
  data: unknown;
  occurredAt: Date;
}

/** Only one relay (of any API instance) numbers events at a time. */
const RELAY_LOCK = 4_042_004;
const BATCH = 1000;
const PRUNE_EVERY_MS = 10 * 60_000;

export const toView = (e: RealtimeEvent): EventView => ({
  id: Number(e.seq),
  type: e.type,
  topic: e.topic as Topic,
  branchId: e.branchId,
  entityType: e.entityType,
  entityId: e.entityId,
  entityVersion: e.entityVersion,
  data: e.payload,
  occurredAt: e.createdAt,
});

/**
 * Transactional outbox relay. Database triggers write an event row in the same transaction as each
 * change, so an event exists exactly when its change committed. The relay then:
 *  1. numbers committed rows with a gap-free `seq` (under an advisory lock, so numbers are handed out
 *     in commit order even with several API instances), and
 *  2. on every instance, reads rows past the last `seq` it pushed and hands them to the WebSocket
 *     gateway for that instance's clients.
 * Clients that missed events catch up with GET /realtime/events?after=<seq>. PostgreSQL stays the
 * source of truth: events say what changed; details are read through the REST API.
 */
@Injectable()
export class RealtimeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RealtimeService.name);
  private readonly listeners = new Set<(events: EventView[]) => void>();
  private lastSeq = 0n;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;
  private lastPrune = 0;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async onModuleInit() {
    this.lastSeq = await this.maxSeq();
    if (this.env.REALTIME_ENABLED) this.schedule();
  }

  async onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.running;
  }

  onEvents(fn: (events: EventView[]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Runs one relay cycle now (also used by tests instead of waiting for the timer). */
  async flush(): Promise<void> {
    while (this.running) await this.running.catch(() => undefined);
    this.running = this.cycle().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** Missed events for one branch, for clients catching up after a reconnect. */
  async eventsAfter(actor: AuthPrincipal, branchId: string, after: number, requested: string[] | undefined, limit: number) {
    await this.assertBranch(actor, branchId);
    const topics = permittedTopics(actor, branchId, requested);
    if (!topics.length) throw Errors.forbidden('MISSING_PERMISSION', 'You cannot see any of these event topics in this branch', { branchId });
    const head = await this.maxSeq();
    const cursor = BigInt(after);
    if (cursor > head) throw Errors.gone('RESYNC_REQUIRED', 'Unknown event cursor; reload the screen from the API', { lastSeq: Number(head) });
    if (cursor < head) {
      const oldest = await this.prisma.realtimeEvent.findFirst({ where: { seq: { not: null } }, orderBy: { seq: 'asc' }, select: { seq: true } });
      if (oldest?.seq && cursor < oldest.seq - 1n) {
        throw Errors.gone('RESYNC_REQUIRED', 'Events since then are no longer kept; reload the screen from the API', { lastSeq: Number(head) });
      }
    }
    const rows = await this.prisma.realtimeEvent.findMany({
      where: { organizationId: actor.organizationId, branchId, topic: { in: topics }, seq: { gt: cursor, lte: head } },
      orderBy: { seq: 'asc' },
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    return {
      topics,
      events: page.map(toView),
      hasMore,
      // Without more pages the client is caught up to the head, even if the last events were for other branches.
      lastSeq: hasMore ? Number(page[page.length - 1].seq) : Number(head),
    };
  }

  /** 404 unless the branch is in the caller's organization and they hold a role there. */
  async assertBranch(actor: AuthPrincipal, branchId: string) {
    const branch = await this.prisma.branch.findFirst({ where: { id: branchId, organizationId: actor.organizationId, deletedAt: null }, select: { id: true } });
    if (!branch || !canSeeBranch(actor, branchId)) throw Errors.notFound('Branch');
  }

  // ───────────── Internals ─────────────

  private schedule() {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.flush()
        .catch((err: unknown) => this.logger.error({ err }, 'Realtime relay cycle failed'))
        .finally(() => this.schedule());
    }, this.env.REALTIME_POLL_MS);
    this.timer.unref?.();
  }

  private async cycle() {
    await this.publishPending();
    await this.fanOut();
    if (Date.now() - this.lastPrune > PRUNE_EVERY_MS) {
      this.lastPrune = Date.now();
      await this.prune();
    }
  }

  /** Gives committed, unnumbered events the next sequence numbers, oldest first. */
  private async publishPending() {
    for (;;) {
      const n = await this.prisma.$transaction(async (tx) => {
        const [{ locked }] = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(${RELAY_LOCK}) AS locked`;
        if (!locked) return 0;
        return tx.$executeRaw`
          WITH pending AS (
            SELECT id, row_number() OVER (ORDER BY pending_id) AS rn
            FROM realtime_events WHERE seq IS NULL ORDER BY pending_id LIMIT ${BATCH}
          ), head AS (SELECT COALESCE(MAX(seq), 0) AS m FROM realtime_events)
          UPDATE realtime_events e SET seq = head.m + pending.rn, published_at = now()
          FROM pending, head WHERE e.id = pending.id`;
      });
      if (n < BATCH) return;
    }
  }

  private async fanOut() {
    for (;;) {
      const rows = await this.prisma.realtimeEvent.findMany({ where: { seq: { gt: this.lastSeq } }, orderBy: { seq: 'asc' }, take: BATCH });
      if (!rows.length) return;
      this.lastSeq = rows[rows.length - 1].seq!;
      const events = rows.map(toView);
      for (const fn of this.listeners) {
        try {
          fn(events);
        } catch (err) {
          this.logger.error({ err }, 'Realtime listener failed');
        }
      }
      if (rows.length < BATCH) return;
    }
  }

  /** Drops old published events, always keeping the newest so numbering continues. */
  private async prune() {
    const cutoff = new Date(Date.now() - this.env.REALTIME_RETENTION_HOURS * 3600_000);
    await this.prisma.$executeRaw`
      DELETE FROM realtime_events
      WHERE published_at < ${cutoff} AND seq < (SELECT MAX(seq) FROM realtime_events)`;
  }

  private async maxSeq(): Promise<bigint> {
    const r = await this.prisma.realtimeEvent.aggregate({ _max: { seq: true } });
    return r._max.seq ?? 0n;
  }
}
