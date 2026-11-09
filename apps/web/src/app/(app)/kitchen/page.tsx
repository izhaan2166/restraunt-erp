'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock, Wifi, WifiOff } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useToast } from '@/components/toast';
import { Badge, Button, Empty, ErrorNote, Spinner } from '@/components/ui';
import { api, errorMessage, request } from '@/lib/api';
import { cn } from '@/lib/cn';
import { elapsed, qty, titleCase } from '@/lib/format';
import { useRealtime } from '@/lib/realtime';
import { useBranch } from '@/lib/session';
import type { KitchenStatus, Ticket } from '@/lib/types';

const NEXT: Partial<Record<KitchenStatus, KitchenStatus>> = { PENDING: 'PREPARING', PREPARING: 'READY', READY: 'SERVED' };
const ACTION: Partial<Record<KitchenStatus, string>> = { PENDING: 'Start cooking', PREPARING: 'Mark ready', READY: 'Served' };
const COLUMNS: { status: KitchenStatus; title: string; tone: string }[] = [
  { status: 'PENDING', title: 'New', tone: 'border-t-amber-500' },
  { status: 'PREPARING', title: 'Cooking', tone: 'border-t-sky-500' },
  { status: 'READY', title: 'Ready to serve', tone: 'border-t-emerald-500' },
];
/** A ticket waiting longer than this is flagged so it does not get forgotten. */
const LATE_SECONDS = 15 * 60;

/**
 * Kitchen display. Tickets come from the server with how long they have been waiting; the board
 * updates live, and still refreshes every few seconds if the live connection drops.
 */
export default function KitchenPage() {
  const branch = useBranch();
  const qc = useQueryClient();
  const toast = useToast();
  const [station, setStation] = useState<string>('');
  const [fetchedAt, setFetchedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());

  const stations = useQuery({
    queryKey: ['stations', branch.id],
    queryFn: () => api.get<{ id: string; code: string; name: string; isActive?: boolean }[]>(`/branches/${branch.id}/kitchen-stations`),
    staleTime: 300_000,
  });

  const refresh = useRef<ReturnType<typeof setTimeout> | null>(null);
  const live = useRealtime(
    branch.id,
    ['kitchen'],
    () => {
      // Several events arrive together when a ticket is sent; reload once.
      if (refresh.current) clearTimeout(refresh.current);
      refresh.current = setTimeout(() => qc.invalidateQueries({ queryKey: ['kot', branch.id] }), 150);
    },
    () => qc.invalidateQueries({ queryKey: ['kot', branch.id] }),
  );

  const tickets = useQuery({
    queryKey: ['kot', branch.id, station],
    queryFn: async () => {
      const r = await request<Ticket[]>('/kot', { query: { branchId: branch.id, stationId: station || undefined } });
      setFetchedAt(Date.now());
      return r.data;
    },
    refetchInterval: live === 'live' ? 60_000 : 10_000,
  });

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  async function advance(kind: 'ticket' | 'item', id: string, status: KitchenStatus) {
    try {
      if (kind === 'ticket') await api.post(`/kot/${id}/status`, { status });
      else await api.patch(`/kot/items/${id}/status`, { status });
      await qc.invalidateQueries({ queryKey: ['kot', branch.id] });
    } catch (err) {
      toast(errorMessage(err), 'error');
      qc.invalidateQueries({ queryKey: ['kot', branch.id] });
    }
  }

  const drift = Math.max(0, Math.floor((now - fetchedAt) / 1000));

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-stone-200 bg-white px-3 py-2">
        <h1 className="text-lg font-semibold">Kitchen</h1>
        <div role="tablist" aria-label="Station" className="flex gap-1 overflow-x-auto">
          {[{ id: '', name: 'All stations' }, ...(stations.data ?? [])].map((s) => (
            <button
              key={s.id || 'all'}
              role="tab"
              aria-selected={station === s.id}
              onClick={() => setStation(s.id)}
              className={cn('h-9 shrink-0 rounded-full px-4 text-sm font-medium', station === s.id ? 'bg-stone-900 text-white' : 'bg-stone-100 text-stone-700')}
            >
              {s.name}
            </button>
          ))}
        </div>
        <span className={cn('ml-auto flex items-center gap-1 text-xs', live === 'live' ? 'text-emerald-700' : 'text-amber-700')} role="status">
          {live === 'live' ? <Wifi className="size-4" aria-hidden /> : <WifiOff className="size-4" aria-hidden />}
          {live === 'live' ? 'Live' : live === 'connecting' ? 'Connecting…' : 'Offline, refreshing every 10 s'}
        </span>
      </div>

      {tickets.isPending ? (
        <Spinner label="Loading tickets" />
      ) : tickets.isError ? (
        <div className="p-4">
          <ErrorNote message={errorMessage(tickets.error)} onRetry={() => tickets.refetch()} />
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 content-start gap-3 overflow-auto p-3 md:grid-cols-3 md:content-stretch">
          {COLUMNS.map((col) => {
            const list = tickets.data.filter((t) => t.status === col.status);
            return (
              <section key={col.status} aria-label={col.title} className={cn('flex flex-col rounded-xl border-t-4 bg-stone-100/70 md:min-h-0', col.tone)} data-testid={`column-${col.status}`}>
                <h2 className="flex items-center justify-between px-3 py-2 text-sm font-semibold text-stone-700">
                  {col.title}
                  <Badge>{list.length}</Badge>
                </h2>
                <div className="flex flex-col gap-3 px-2 pb-3 md:overflow-y-auto">
                  {list.length === 0 && <Empty title="Nothing here" />}
                  {list.map((t) => (
                    <TicketCard key={t.id} ticket={t} waited={t.elapsedSeconds + drift} onAdvance={advance} />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

function TicketCard({ ticket: t, waited, onAdvance }: { ticket: Ticket; waited: number; onAdvance: (kind: 'ticket' | 'item', id: string, s: KitchenStatus) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const next = NEXT[t.status];
  const late = waited >= LATE_SECONDS && t.status !== 'READY';
  const where = t.order.table ? `Table ${t.order.table.label}` : titleCase(t.order.orderType);

  const run = async (kind: 'ticket' | 'item', id: string, s: KitchenStatus) => {
    setBusy(true);
    await onAdvance(kind, id, s);
    setBusy(false);
  };

  return (
    <article className={cn('rounded-xl border bg-white shadow-sm', late ? 'border-red-400 ring-2 ring-red-200' : 'border-stone-200')} data-testid="ticket" aria-label={`Ticket ${t.ticketNumber}, ${where}`}>
      <header className="flex items-start justify-between gap-2 border-b border-stone-100 px-3 py-2">
        <div>
          <p className="text-lg font-bold leading-tight">{where}</p>
          <p className="text-xs text-stone-500">
            {t.ticketNumber}
            {t.station ? ` · ${t.station.name}` : ''}
            {t.order.customerName ? ` · ${t.order.customerName}` : ''}
          </p>
        </div>
        <span className={cn('flex items-center gap-1 rounded-md px-2 py-1 text-sm font-semibold tabular-nums', late ? 'bg-red-100 text-red-700' : 'bg-stone-100 text-stone-700')}>
          <Clock className="size-4" aria-hidden />
          {elapsed(waited)}
        </span>
      </header>
      <ul className="divide-y divide-stone-100">
        {t.items.map((i) => {
          const itemNext = NEXT[i.status];
          const cancelled = i.status === 'CANCELLED';
          return (
            <li key={i.id}>
              <button
                disabled={busy || cancelled || !itemNext || itemNext === 'SERVED'}
                onClick={() => itemNext && run('item', i.id, itemNext)}
                className="flex w-full items-start gap-3 px-3 py-2 text-left enabled:hover:bg-stone-50"
                aria-label={`${i.productName}, ${titleCase(i.status)}${itemNext && itemNext !== 'SERVED' ? `. Tap to mark ${titleCase(itemNext)}` : ''}`}
              >
                <span className="min-w-8 text-lg font-bold tabular-nums">{qty(i.quantity)}×</span>
                <span className={cn('flex-1', cancelled && 'text-stone-400 line-through')}>
                  <span className="font-medium">
                    {i.productName}
                    {i.variantName ? ` (${i.variantName})` : ''}
                  </span>
                  {i.modifiers.length > 0 && <span className="block text-sm text-stone-600">+ {i.modifiers.join(', ')}</span>}
                  {i.instructions && <span className="block text-sm font-medium text-red-700">{i.instructions}</span>}
                </span>
                <Badge tone={i.status === 'READY' ? 'green' : i.status === 'PREPARING' ? 'blue' : cancelled ? 'red' : 'amber'}>{titleCase(i.status)}</Badge>
              </button>
            </li>
          );
        })}
      </ul>
      {t.order.notes && <p className="border-t border-stone-100 px-3 py-2 text-sm text-stone-700">Note: {t.order.notes}</p>}
      {next && (
        <div className="border-t border-stone-100 p-2">
          <Button className="w-full" size="lg" variant={next === 'READY' ? 'success' : next === 'SERVED' ? 'secondary' : 'primary'} loading={busy} onClick={() => run('ticket', t.id, next)}>
            {ACTION[t.status]}
          </Button>
        </div>
      )}
    </article>
  );
}
