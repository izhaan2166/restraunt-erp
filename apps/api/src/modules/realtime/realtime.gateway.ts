import { Logger, OnModuleDestroy } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import { isUUID } from 'class-validator';
import type { Server, Socket } from 'socket.io';
import { AppError } from '../../common/errors/app-error';
import { loadEnv } from '../../config/env';
import type { AuthPrincipal } from '../auth/principal';
import { PrincipalService } from '../auth/principal.service';
import { RealtimeService } from './realtime.service';
import { TOPICS, Topic, permittedTopics, roomFor } from './topics';

interface ClientState {
  principal: AuthPrincipal;
  expiresAt: Date;
  timers: NodeJS.Timeout[];
}

const SESSION_CHECK_MS = 60_000;
const MAX_REPLAY = 500;

type Ack = Record<string, unknown>;
const fail = (code: string, message: string): Ack => ({ ok: false, error: { code, message } });

/**
 * WebSocket endpoint (socket.io, path /realtime).
 *
 * Connect with `auth: { token: <access token> }`. The token and its session are checked like any
 * REST call; the connection ends when the token expires (`session_expired`) or the session is
 * revoked, and the client reconnects with a fresh token.
 *
 * `subscribe { branchId, topics?, since? }` joins the branch's topics the caller may read. With
 * `since` (the last event id processed) the ack also carries the missed events, or
 * `resyncRequired: true` when they are no longer available. Every event has a unique increasing
 * `id`; clients ignore ids they have already processed, so a replay that overlaps live delivery is safe.
 */
@WebSocketGateway({
  path: '/realtime',
  cors: { origin: loadEnv().CORS_ORIGINS, credentials: true },
  serveClient: false,
})
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy {
  private readonly logger = new Logger(RealtimeGateway.name);
  private readonly clients = new Map<string, ClientState>();
  private unsubscribe?: () => void;

  constructor(
    private readonly principals: PrincipalService,
    private readonly realtime: RealtimeService,
  ) {}

  afterInit(server: Server) {
    // Authenticate during the handshake, so unauthenticated sockets never connect.
    server.use((socket, next) => {
      const token = extractToken(socket);
      if (!token) return next(wsError('UNAUTHENTICATED', 'Send the access token as auth.token'));
      this.principals
        .fromAccessToken(token)
        .then(({ principal, expiresAt }) => {
          socket.data.principal = principal;
          socket.data.expiresAt = expiresAt;
          next();
        })
        .catch((err: unknown) => next(err instanceof AppError ? wsError(err.code, err.message) : wsError('UNAUTHENTICATED', 'Authentication failed')));
    });
    this.unsubscribe?.();
    this.unsubscribe = this.realtime.onEvents((events) => {
      for (const e of events) server.to(roomFor(e.branchId, e.topic)).emit('event', e);
    });
  }

  onModuleDestroy() {
    this.unsubscribe?.();
    for (const s of this.clients.values()) s.timers.forEach((t) => clearTimeout(t));
    this.clients.clear();
  }

  handleConnection(socket: Socket) {
    const principal = socket.data.principal as AuthPrincipal | undefined;
    const expiresAt = socket.data.expiresAt as Date | undefined;
    if (!principal || !expiresAt) return void socket.disconnect(true);
    const end = (reason: string) => {
      socket.emit('session_expired', { reason });
      socket.disconnect(true);
    };
    const timers = [
      setTimeout(() => end('TOKEN_EXPIRED'), Math.min(Math.max(expiresAt.getTime() - Date.now(), 0), 2_147_483_647)),
      setInterval(() => {
        this.principals
          .isSessionLive(principal.sessionId)
          .then((live) => !live && end('SESSION_REVOKED'))
          .catch(() => undefined);
      }, SESSION_CHECK_MS),
    ];
    for (const t of timers) t.unref?.();
    this.clients.set(socket.id, { principal, expiresAt, timers });
    socket.emit('ready', { userId: principal.userId, expiresAt: expiresAt.toISOString() });
  }

  handleDisconnect(socket: Socket) {
    const state = this.clients.get(socket.id);
    state?.timers.forEach((t) => clearTimeout(t));
    this.clients.delete(socket.id);
  }

  @SubscribeMessage('subscribe')
  async subscribe(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown): Promise<Ack> {
    const state = this.clients.get(socket.id);
    if (!state) return fail('UNAUTHENTICATED', 'Not connected');
    const { branchId, topics, since } = (body ?? {}) as { branchId?: unknown; topics?: unknown; since?: unknown };
    if (typeof branchId !== 'string' || !isUUID(branchId)) return fail('VALIDATION_FAILED', 'branchId must be a UUID');
    if (topics !== undefined && (!Array.isArray(topics) || topics.some((t) => !TOPICS.includes(t as Topic)))) {
      return fail('VALIDATION_FAILED', `topics must be a list of: ${TOPICS.join(', ')}`);
    }
    if (since !== undefined && (typeof since !== 'number' || !Number.isSafeInteger(since) || since < 0)) {
      return fail('VALIDATION_FAILED', 'since must be the last event id you processed');
    }
    try {
      await this.realtime.assertBranch(state.principal, branchId);
    } catch (err) {
      return err instanceof AppError ? fail(err.code, err.message) : fail('INTERNAL', 'Subscription failed');
    }
    const allowed = permittedTopics(state.principal, branchId, topics as string[] | undefined);
    if (!allowed.length) return fail('MISSING_PERMISSION', 'You cannot see any of these topics in this branch');

    // Join first, then read the backlog: nothing can fall between the two (overlaps are de-duplicated by id).
    await socket.join(allowed.map((t) => roomFor(branchId, t)));
    if (since === undefined) return { ok: true, branchId, topics: allowed };
    try {
      const r = await this.realtime.eventsAfter(state.principal, branchId, since, allowed, MAX_REPLAY);
      if (r.hasMore) return { ok: true, branchId, topics: allowed, resyncRequired: true, lastSeq: r.lastSeq };
      return { ok: true, branchId, topics: allowed, events: r.events, lastSeq: r.lastSeq };
    } catch (err) {
      if (err instanceof AppError && err.code === 'RESYNC_REQUIRED') {
        return { ok: true, branchId, topics: allowed, resyncRequired: true, lastSeq: (err.details as { lastSeq?: number })?.lastSeq };
      }
      this.logger.error({ err }, 'Realtime replay failed');
      return fail('INTERNAL', 'Could not load missed events');
    }
  }

  @SubscribeMessage('unsubscribe')
  async leave(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown): Promise<Ack> {
    const { branchId } = (body ?? {}) as { branchId?: unknown };
    if (typeof branchId !== 'string' || !isUUID(branchId)) return fail('VALIDATION_FAILED', 'branchId must be a UUID');
    await Promise.all(TOPICS.map((t) => socket.leave(roomFor(branchId, t))));
    return { ok: true, branchId };
  }
}

function extractToken(socket: Socket): string | undefined {
  const auth = socket.handshake.auth as { token?: unknown } | undefined;
  if (typeof auth?.token === 'string' && auth.token) return auth.token.replace(/^Bearer\s+/i, '');
  const header = socket.handshake.headers.authorization;
  return header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
}

function wsError(code: string, message: string) {
  return Object.assign(new Error(message), { data: { code, message } });
}
