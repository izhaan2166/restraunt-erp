'use client';

import { useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { getAccessToken, onTokenChange, refreshAccessToken } from './api';

export interface RealtimeEvent {
  id: number;
  type: string;
  topic: string;
  branchId: string;
  entityType: string;
  entityId: string;
  entityVersion: number | null;
  data: Record<string, unknown>;
  occurredAt: string;
}

export type Topic = 'orders' | 'kitchen' | 'tables' | 'payments' | 'inventory' | 'shifts';
export type LiveState = 'connecting' | 'live' | 'offline';

/**
 * Live updates for one branch. Events only say *what* changed; screens re-read details through
 * REST (the database stays the source of truth). After a reconnect the server replays what was
 * missed from `since`; if the gap is too old it asks for a full reload (`onResync`).
 *
 * The socket goes through this app's own origin (`/realtime`, proxied to the API).
 */
export function useRealtime(branchId: string | undefined, topics: Topic[], onEvent: (e: RealtimeEvent) => void, onResync: () => void): LiveState {
  const [state, setState] = useState<LiveState>('connecting');
  const handlers = useRef({ onEvent, onResync });
  handlers.current = { onEvent, onResync };
  const topicKey = topics.join(',');

  useEffect(() => {
    if (!branchId) return;
    let lastSeq: number | undefined;
    const seen = new Set<number>();
    const socket: Socket = io({
      path: '/realtime',
      transports: ['websocket', 'polling'],
      auth: (cb) => cb({ token: getAccessToken() }),
      reconnectionDelay: 500,
      reconnectionDelayMax: 5000,
    });

    const deliver = (e: RealtimeEvent) => {
      if (seen.has(e.id)) return;
      seen.add(e.id);
      if (seen.size > 2000) seen.delete(seen.values().next().value as number);
      lastSeq = Math.max(lastSeq ?? 0, e.id);
      handlers.current.onEvent(e);
    };

    const subscribe = () => {
      socket.emit(
        'subscribe',
        { branchId, topics: topicKey.split(','), since: lastSeq },
        (ack: { ok: boolean; events?: RealtimeEvent[]; lastSeq?: number; resyncRequired?: boolean }) => {
          if (!ack?.ok) return setState('offline');
          setState('live');
          if (ack.resyncRequired) handlers.current.onResync();
          for (const e of ack.events ?? []) deliver(e);
          if (ack.lastSeq !== undefined && lastSeq === undefined) lastSeq = ack.lastSeq;
        },
      );
    };

    socket.on('ready', subscribe);
    socket.on('event', deliver);
    socket.on('disconnect', () => setState('offline'));
    socket.on('connect_error', async (err: Error & { data?: { code?: string } }) => {
      setState('offline');
      if (err.data?.code === 'INVALID_ACCESS_TOKEN' || err.data?.code === 'UNAUTHENTICATED') await refreshAccessToken();
    });
    socket.on('session_expired', async () => {
      await refreshAccessToken();
      socket.connect();
    });
    // A refreshed token takes effect on the next (re)connect through the auth callback.
    const off = onTokenChange((t) => {
      if (!t) socket.disconnect();
    });
    return () => {
      off();
      socket.removeAllListeners();
      socket.disconnect();
    };
  }, [branchId, topicKey]);

  return state;
}
