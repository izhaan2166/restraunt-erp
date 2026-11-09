'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Users } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { Empty, ErrorNote, PageHeader, Spinner } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { cn } from '@/lib/cn';
import { time } from '@/lib/format';
import { useRealtime } from '@/lib/realtime';
import { useBranch } from '@/lib/session';
import type { TableRow } from '@/lib/types';

const STATUS: Record<TableRow['status'], { label: string; cls: string }> = {
  AVAILABLE: { label: 'Free', cls: 'border-emerald-300 bg-emerald-50 text-emerald-900' },
  OCCUPIED: { label: 'Occupied', cls: 'border-amber-400 bg-amber-50 text-amber-900' },
  BILL_PENDING: { label: 'Bill pending', cls: 'border-violet-400 bg-violet-50 text-violet-900' },
  RESERVED: { label: 'Reserved', cls: 'border-sky-400 bg-sky-50 text-sky-900' },
  OUT_OF_SERVICE: { label: 'Out of service', cls: 'border-stone-300 bg-stone-100 text-stone-500' },
};

/** The floor: every table where it stands in the room, coloured by state. Tap a table to seat guests or open its order. */
export default function TablesPage() {
  const branch = useBranch();
  const qc = useQueryClient();
  const [area, setArea] = useState<string>('');

  const tables = useQuery({
    queryKey: ['tables', branch.id],
    queryFn: () => api.get<TableRow[]>(`/branches/${branch.id}/tables`),
    refetchInterval: 30_000,
  });
  const live = useRealtime(
    branch.id,
    ['tables'],
    () => qc.invalidateQueries({ queryKey: ['tables', branch.id] }),
    () => qc.invalidateQueries({ queryKey: ['tables', branch.id] }),
  );

  const areas = useMemo(() => [...new Set((tables.data ?? []).map((t) => t.area ?? 'Other'))], [tables.data]);
  const shown = (tables.data ?? []).filter((t) => !area || (t.area ?? 'Other') === area);
  const counts = (tables.data ?? []).reduce<Record<string, number>>((m, t) => ({ ...m, [t.status]: (m[t.status] ?? 0) + 1 }), {});

  return (
    <div className="p-3 sm:p-4">
      <PageHeader
        title="Tables"
        subtitle={
          <span>
            {counts.AVAILABLE ?? 0} free · {(counts.OCCUPIED ?? 0) + (counts.BILL_PENDING ?? 0)} in use · {counts.RESERVED ?? 0} reserved
            {live === 'offline' && ' · offline, refreshing every 30 s'}
          </span>
        }
        actions={
          <Link href="/pos" className="inline-flex h-10 items-center rounded-lg border border-stone-300 bg-white px-4 text-sm font-medium hover:bg-stone-50">
            Takeaway or delivery
          </Link>
        }
      />
      {areas.length > 1 && (
        <div role="tablist" aria-label="Area" className="mb-3 flex gap-2 overflow-x-auto">
          {['', ...areas].map((a) => (
            <button
              key={a || 'all'}
              role="tab"
              aria-selected={area === a}
              onClick={() => setArea(a)}
              className={cn('h-9 shrink-0 rounded-full px-4 text-sm font-medium', area === a ? 'bg-brand-600 text-white' : 'bg-stone-100 text-stone-700')}
            >
              {a || 'All areas'}
            </button>
          ))}
        </div>
      )}
      {tables.isPending ? (
        <Spinner label="Loading tables" />
      ) : tables.isError ? (
        <ErrorNote message={errorMessage(tables.error)} onRetry={() => tables.refetch()} />
      ) : shown.length === 0 ? (
        <Empty title="No tables yet">An owner or manager can add tables in settings.</Empty>
      ) : (
        <Floor tables={shown} />
      )}
      <Legend />
    </div>
  );
}

/** Draws tables at their saved positions; if no layout was saved (all at 0,0) it falls back to a grid. */
function Floor({ tables }: { tables: TableRow[] }) {
  const laidOut = tables.some((t) => t.posX > 0 || t.posY > 0);
  if (!laidOut)
    return (
      <div className="grid grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-3">
        {tables.map((t) => (
          <TableTile key={t.id} table={t} className="aspect-square" />
        ))}
      </div>
    );
  const minX = Math.min(...tables.map((t) => t.posX));
  const minY = Math.min(...tables.map((t) => t.posY));
  const w = Math.max(...tables.map((t) => t.posX - minX + t.width)) + 16;
  const h = Math.max(...tables.map((t) => t.posY - minY + t.height)) + 16;
  return (
    <div className="overflow-auto rounded-xl border border-stone-200 bg-[radial-gradient(circle,#e7e5e4_1px,transparent_1px)] [background-size:20px_20px]">
      <div className="relative" style={{ width: w + 16, height: h + 16 }}>
        {tables.map((t) => (
          <TableTile
            key={t.id}
            table={t}
            className="absolute"
            style={{ left: t.posX - minX + 16, top: t.posY - minY + 16, width: Math.max(t.width, 72), height: Math.max(t.height, 72) }}
          />
        ))}
      </div>
    </div>
  );
}

function TableTile({ table: t, className, style }: { table: TableRow; className?: string; style?: React.CSSProperties }) {
  const s = STATUS[t.status];
  const body = (
    <>
      <span className="text-lg font-bold">{t.label}</span>
      <span className="flex items-center gap-1 text-xs">
        <Users className="size-3" aria-hidden />
        {t.session?.guestCount ?? 0}/{t.capacity}
      </span>
      <span className="text-[11px] font-medium">
        {t.status === 'OCCUPIED' && t.session ? `since ${time(t.session.openedAt)}` : t.status === 'RESERVED' && t.reservationName ? t.reservationName : s.label}
      </span>
    </>
  );
  const cls = cn('flex flex-col items-center justify-center gap-0.5 border-2 text-center shadow-sm', t.shape === 'ROUND' ? 'rounded-full' : 'rounded-xl', s.cls, className);
  if (t.status === 'OUT_OF_SERVICE')
    return (
      <div className={cn(cls, 'cursor-not-allowed')} style={style} aria-label={`${t.label}, out of service`}>
        {body}
      </div>
    );
  return (
    <Link href={`/pos?table=${t.id}`} className={cn(cls, 'hover:brightness-95')} style={style} aria-label={`${t.label}, ${s.label}, seats ${t.capacity}`} data-testid={`table-${t.label}`}>
      {body}
    </Link>
  );
}

function Legend() {
  return (
    <ul className="mt-4 flex flex-wrap gap-3 text-xs text-stone-600" aria-label="Colours">
      {Object.entries(STATUS).map(([k, v]) => (
        <li key={k} className="flex items-center gap-1.5">
          <span className={cn('size-3 rounded border-2', v.cls)} aria-hidden />
          {v.label}
        </li>
      ))}
    </ul>
  );
}
