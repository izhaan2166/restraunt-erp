'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { Badge, Card, ErrorNote, PageHeader, Spinner } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { cn } from '@/lib/cn';
import { METHOD_LABEL, dateTime, qty, rupees, shortDate, stockQty, titleCase } from '@/lib/format';
import { useBranch, useSession } from '@/lib/session';

type Range = 'today' | 'yesterday' | 'this_week' | 'this_month';
const RANGES: { key: Range; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'this_week', label: 'This week' },
  { key: 'this_month', label: 'This month' },
];

interface Dashboard {
  range: string;
  from: string;
  to: string;
  generatedAt: string;
  branches: { id: string; name: string }[];
  sales: { totalSales: string; grossRevenue: string; discounts: string; netRevenue: string; tax: string; averageOrderValue: string; bills: number; collected: string; refunded: string; netCollected: string };
  orders: { total: number; completed: number; cancelled: number; pending: number };
  expenses?: string;
  estimatedProfit?: string;
  paymentMethods: { method: string; payments: number; amount: string; refunded: string; net: string }[];
  bestSellers: { productId: string; name: string; category: string; quantity: string; netSales: string }[];
  lowStock?: { ingredientId: string; name: string; unit: string; branchId: string; branch: string; quantity: string; minimumLevel: string }[];
  recentTransactions: { type: string; id: string; at: string; method: string; amount: string; status: string; invoiceNumber: string | null; by: string | null; branch: string }[];
  branchPerformance: { branchId: string; branch: string; orders: number; bills: number; netRevenue: string; totalSales: string; averageOrderValue: string }[];
  hidden: string[];
}

/** The day at a glance for owners and managers. Every figure is worked out by the server. */
export default function DashboardPage() {
  const branch = useBranch();
  const { me } = useSession();
  const [range, setRange] = useState<Range>('today');
  const [allBranches, setAllBranches] = useState(false);
  const many = (me?.branches.length ?? 0) > 1;
  const query = { range, branchId: allBranches && many ? undefined : branch.id };
  const d = useQuery({ queryKey: ['dashboard', query], queryFn: () => api.get<Dashboard>('/dashboard', query), refetchInterval: 60_000 });

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 p-3 sm:p-4">
      <PageHeader
        title="Dashboard"
        subtitle={d.data ? `${d.data.from === d.data.to ? shortDate(d.data.from) : `${shortDate(d.data.from)} to ${shortDate(d.data.to)}`} · ${allBranches && many ? 'all branches' : branch.name}` : branch.name}
      />
      <div className="flex flex-wrap items-center gap-3">
        <div role="tablist" aria-label="Period" className="flex rounded-lg border border-stone-300 bg-white p-0.5">
          {RANGES.map((r) => (
            <button key={r.key} role="tab" aria-selected={range === r.key} onClick={() => setRange(r.key)} className={cn('h-9 rounded-md px-3 text-sm', range === r.key ? 'bg-brand-600 text-white' : 'text-stone-700 hover:bg-stone-100')}>
              {r.label}
            </button>
          ))}
        </div>
        {many && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={allBranches} onChange={(e) => setAllBranches(e.target.checked)} /> All my branches
          </label>
        )}
      </div>
      {d.isError ? <ErrorNote message={errorMessage(d.error)} onRetry={() => d.refetch()} /> : !d.data ? <Spinner label="Loading dashboard" /> : <Body d={d.data} />}
    </div>
  );
}

function Tile({ label, value, hint, testId }: { label: string; value: string; hint?: string; testId?: string }) {
  return (
    <Card className="flex flex-col gap-1 p-4">
      <span className="text-sm text-stone-600">{label}</span>
      <span className="text-2xl font-semibold tabular-nums" data-testid={testId}>
        {value}
      </span>
      {hint && <span className="text-xs text-stone-500">{hint}</span>}
    </Card>
  );
}

function Body({ d }: { d: Dashboard }) {
  const hidden = new Set(d.hidden);
  const s = d.sales;
  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Headline figures">
        <Tile label="Sales (with GST)" value={rupees(s.totalSales)} hint={`${s.bills} ${s.bills === 1 ? 'bill' : 'bills'} · GST ${rupees(s.tax)}`} testId="dash-sales" />
        <Tile label="Net sales (before GST)" value={rupees(s.netRevenue)} hint={Number(s.discounts) ? `after ${rupees(s.discounts)} discounts` : undefined} />
        <Tile label="Orders" value={String(d.orders.total)} hint={`${d.orders.pending} open · ${d.orders.cancelled} cancelled · average bill ${rupees(s.averageOrderValue)}`} testId="dash-orders" />
        <Tile label="Money received" value={rupees(s.netCollected)} hint={Number(s.refunded) ? `after ${rupees(s.refunded)} refunds` : undefined} />
        {!hidden.has('expenses') && d.expenses !== undefined && <Tile label="Expenses" value={rupees(d.expenses)} />}
        {!hidden.has('estimatedProfit') && d.estimatedProfit !== undefined && <Tile label="Estimated profit" value={rupees(d.estimatedProfit)} hint="Sales less recipe cost, wastage and expenses" />}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-4">
          <h2 className="mb-2 font-semibold">How customers paid</h2>
          {d.paymentMethods.length === 0 ? (
            <p className="text-sm text-stone-500">No payments yet.</p>
          ) : (
            <ul className="flex flex-col gap-2" aria-label="Payment methods">
              {d.paymentMethods.map((m) => {
                const share = Number(s.netCollected) > 0 ? Math.max(0, Math.min(100, (Number(m.net) / Number(s.netCollected)) * 100)) : 0;
                return (
                  <li key={m.method} className="text-sm">
                    <div className="flex justify-between gap-2">
                      <span>
                        {METHOD_LABEL[m.method] ?? titleCase(m.method)} <span className="text-stone-500">({m.payments})</span>
                      </span>
                      <span className="tabular-nums">{rupees(m.net)}</span>
                    </div>
                    {/* Bar width is only a picture of the server's figures; no money is calculated here. */}
                    <div className="mt-1 h-2 rounded bg-stone-100" aria-hidden>
                      <div className="h-2 rounded bg-brand-600" style={{ width: `${share}%` }} />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card className="p-4">
          <h2 className="mb-2 font-semibold">Best sellers</h2>
          {d.bestSellers.length === 0 ? (
            <p className="text-sm text-stone-500">Nothing sold yet.</p>
          ) : (
            <ol className="divide-y divide-stone-100 text-sm" aria-label="Best sellers">
              {d.bestSellers.map((b, i) => (
                <li key={b.productId} className="flex justify-between gap-2 py-1.5">
                  <span>
                    {i + 1}. {b.name} <span className="text-stone-500">· {qty(b.quantity)} sold</span>
                  </span>
                  <span className="tabular-nums">{rupees(b.netSales)}</span>
                </li>
              ))}
            </ol>
          )}
        </Card>

        {!hidden.has('lowStock') && d.lowStock && (
          <Card className="p-4">
            <div className="mb-2 flex items-baseline justify-between">
              <h2 className="font-semibold">Running low</h2>
              <Link href="/stock/levels" className="text-sm text-brand-700 underline">
                Stock
              </Link>
            </div>
            {d.lowStock.length === 0 ? (
              <p className="text-sm text-stone-500">Nothing is below its minimum.</p>
            ) : (
              <ul className="divide-y divide-stone-100 text-sm" aria-label="Running low">
                {d.lowStock.map((l) => {
                  const unit = l.unit;
                  const min = l.minimumLevel;
                  return (
                    <li key={`${l.branchId}-${l.ingredientId}`} className="flex justify-between gap-2 py-1.5">
                      <span>
                        {l.name}
                        {l.branch && d.branches.length > 1 && <span className="text-stone-500"> · {l.branch}</span>}
                      </span>
                      <span className="tabular-nums">
                        <Badge tone={Number(l.quantity) < 0 ? 'red' : 'amber'}>{stockQty(l.quantity, unit)}</Badge>
                        {min && <span className="text-xs text-stone-500"> of {stockQty(min, unit)}</span>}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        )}

        <Card className="p-4">
          <h2 className="mb-2 font-semibold">Latest payments</h2>
          {d.recentTransactions.length === 0 ? (
            <p className="text-sm text-stone-500">No payments yet.</p>
          ) : (
            <ul className="divide-y divide-stone-100 text-sm" aria-label="Latest payments">
              {d.recentTransactions.map((t) => (
                <li key={`${t.type}-${t.id}`} className="flex justify-between gap-2 py-1.5">
                  <span>
                    {t.type === 'REFUND' ? 'Refund' : METHOD_LABEL[t.method] ?? titleCase(t.method)} {t.invoiceNumber && <span className="text-stone-500">· {t.invoiceNumber}</span>}
                    <span className="block text-xs text-stone-500">
                      {dateTime(t.at)}
                      {t.by && ` · ${t.by}`}
                    </span>
                  </span>
                  <span className={cn('tabular-nums', t.type === 'REFUND' && 'text-red-700')}>{rupees(t.amount)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {d.branchPerformance.length > 1 && (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="px-4 pt-3 text-left font-semibold">Branches</caption>
            <thead className="text-left text-xs text-stone-500">
              <tr>
                <th className="px-4 py-2 font-medium">Branch</th>
                <th className="px-4 py-2 text-right font-medium">Orders</th>
                <th className="px-4 py-2 text-right font-medium">Net sales</th>
                <th className="px-4 py-2 text-right font-medium">Sales with GST</th>
                <th className="px-4 py-2 text-right font-medium">Average bill</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {d.branchPerformance.map((b) => (
                <tr key={b.branchId}>
                  <td className="px-4 py-2">{b.branch}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{b.orders}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{rupees(b.netRevenue)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{rupees(b.totalSales)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{rupees(b.averageOrderValue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      <p className="text-xs text-stone-500">Updated {dateTime(d.generatedAt)}. Refreshes every minute.</p>
    </>
  );
}
