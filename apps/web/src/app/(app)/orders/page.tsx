'use client';

import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { Badge, Button, Card, Empty, ErrorNote, PageHeader, Spinner, Tone } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { cn } from '@/lib/cn';
import { dateTime, rupees, titleCase } from '@/lib/format';
import { useRealtime } from '@/lib/realtime';
import { useBranch } from '@/lib/session';
import type { OrderStatus, OrderType } from '@/lib/types';

interface OrderRow {
  id: string;
  orderNumber: string;
  orderType: OrderType;
  status: OrderStatus;
  customerName: string | null;
  grandTotal: string;
  paymentStatus: string;
  createdAt: string;
  tableSession: { table: { label: string } } | null;
  _count: { items: number };
}

const FILTERS: { key: string; label: string; status?: string }[] = [
  { key: 'open', label: 'Open', status: 'NEW,CONFIRMED,PREPARING,READY,SERVED,OUT_FOR_DELIVERY,DELIVERED' },
  { key: 'done', label: 'Completed', status: 'COMPLETED' },
  { key: 'cancelled', label: 'Cancelled', status: 'CANCELLED' },
  { key: 'all', label: 'All' },
];

const TONE: Partial<Record<OrderStatus, Tone>> = { NEW: 'brand', CONFIRMED: 'amber', PREPARING: 'blue', READY: 'green', SERVED: 'violet', COMPLETED: 'neutral', CANCELLED: 'red' };

export default function OrdersPage() {
  const branch = useBranch();
  const qc = useQueryClient();
  const [filter, setFilter] = useState('open');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const f = FILTERS.find((x) => x.key === filter)!;

  const q = useQuery({
    queryKey: ['orders', branch.id, filter, search, page],
    queryFn: () => api.page<OrderRow>('/orders', { branchId: branch.id, status: f.status, search: search.trim() || undefined, page, pageSize: 25 }),
    placeholderData: keepPreviousData,
  });
  useRealtime(
    branch.id,
    ['orders'],
    () => qc.invalidateQueries({ queryKey: ['orders', branch.id] }),
    () => qc.invalidateQueries({ queryKey: ['orders', branch.id] }),
  );

  return (
    <div className="mx-auto max-w-5xl p-3 sm:p-4">
      <PageHeader title="Orders" subtitle="Tap an order to open it." />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div role="tablist" aria-label="Show" className="flex gap-1 rounded-lg bg-stone-100 p-1">
          {FILTERS.map((x) => (
            <button
              key={x.key}
              role="tab"
              aria-selected={filter === x.key}
              onClick={() => {
                setFilter(x.key);
                setPage(1);
              }}
              className={cn('h-8 rounded-md px-3 text-sm font-medium', filter === x.key ? 'bg-white shadow-sm' : 'text-stone-600')}
            >
              {x.label}
            </button>
          ))}
        </div>
        <input
          type="search"
          aria-label="Search orders"
          placeholder="Order number, name or phone"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
          className="h-10 min-w-0 flex-1 rounded-lg border border-stone-300 px-3"
        />
      </div>
      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <ErrorNote message={errorMessage(q.error)} onRetry={() => q.refetch()} />
      ) : q.data.items.length === 0 ? (
        <Empty title="No orders here" />
      ) : (
        <Card>
          <ul className="divide-y divide-stone-100">
            {q.data.items.map((o) => (
              <li key={o.id}>
                <Link href={`/pos?order=${o.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-stone-50">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">
                      {o.tableSession ? `Table ${o.tableSession.table.label}` : titleCase(o.orderType)}
                      {o.customerName && <span className="font-normal text-stone-500"> · {o.customerName}</span>}
                    </p>
                    <p className="text-xs text-stone-500">
                      {o.orderNumber} · {dateTime(o.createdAt)} · {o._count.items} item{o._count.items === 1 ? '' : 's'}
                    </p>
                  </div>
                  <Badge tone={TONE[o.status] ?? 'neutral'}>{titleCase(o.status)}</Badge>
                  <span className="w-24 text-right font-medium tabular-nums">{rupees(o.grandTotal)}</span>
                </Link>
              </li>
            ))}
          </ul>
          {q.data.meta.totalPages > 1 && (
            <div className="flex items-center justify-between border-t border-stone-100 px-4 py-2 text-sm">
              <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                Previous
              </Button>
              <span>
                Page {page} of {q.data.meta.totalPages}
              </span>
              <Button size="sm" variant="secondary" disabled={page >= q.data.meta.totalPages} onClick={() => setPage((p) => p + 1)}>
                Next
              </Button>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
