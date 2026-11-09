'use client';

import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { useState } from 'react';
import { Button, Card, ErrorNote, Input, PageHeader, Select, Spinner } from '@/components/ui';
import { api, errorMessage, saveFile } from '@/lib/api';
import { cn } from '@/lib/cn';
import { DatePreset, indiaDate, presetRange, qty, rupees, shortDate } from '@/lib/format';
import { useBranch, useSession } from '@/lib/session';

type CellType = 'text' | 'money' | 'qty' | 'number' | 'percent';
type Cell = string | number | null;
interface Report {
  key: string;
  title: string;
  from: string;
  to: string;
  branches: { id: string; name: string }[];
  summary: { key: string; label: string; value: Cell; type?: CellType }[];
  tables: { key: string; title: string; columns: { key: string; label: string; type?: CellType }[]; rows: Record<string, Cell>[]; truncated?: boolean }[];
  notes?: string[];
}

interface ReportDef {
  path: string;
  label: string;
  /** Any of these lets you open it; the server decides which branches each person may see. */
  anyOf: string[];
  group: string;
}

const REPORTS: ReportDef[] = [
  { path: 'sales', label: 'Sales', anyOf: ['reports.sales'], group: 'Sales' },
  { path: 'products', label: 'Dishes sold', anyOf: ['reports.sales'], group: 'Sales' },
  { path: 'categories', label: 'Categories', anyOf: ['reports.sales'], group: 'Sales' },
  { path: 'discounts', label: 'Discounts', anyOf: ['reports.sales'], group: 'Sales' },
  { path: 'cancellations', label: 'Cancellations', anyOf: ['reports.sales'], group: 'Sales' },
  { path: 'branches', label: 'Branches compared', anyOf: ['reports.sales'], group: 'Sales' },
  { path: 'gst', label: 'GST', anyOf: ['reports.gst'], group: 'Tax and money' },
  { path: 'payments', label: 'Payments', anyOf: ['reports.financial'], group: 'Tax and money' },
  { path: 'refunds', label: 'Refunds', anyOf: ['reports.financial'], group: 'Tax and money' },
  { path: 'expenses', label: 'Expenses', anyOf: ['reports.financial'], group: 'Tax and money' },
  { path: 'profit-loss', label: 'Profit and loss', anyOf: ['reports.financial'], group: 'Tax and money' },
  { path: 'inventory', label: 'Stock and food cost', anyOf: ['reports.inventory'], group: 'Stock' },
  { path: 'wastage', label: 'Wastage', anyOf: ['reports.inventory'], group: 'Stock' },
  { path: 'purchases', label: 'Purchases', anyOf: ['reports.inventory', 'reports.financial'], group: 'Stock' },
  { path: 'employees', label: 'Staff performance', anyOf: ['reports.employee'], group: 'Staff' },
];

type Preset = DatePreset | 'custom';
const PRESETS: { key: Preset; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'this_week', label: 'This week' },
  { key: 'this_month', label: 'This month' },
  { key: 'last_month', label: 'Last month' },
  { key: 'custom', label: 'Choose dates' },
];

function show(v: Cell, type: CellType = 'text'): string {
  if (v === null || v === '') return '—';
  if (type === 'money') return rupees(String(v));
  if (type === 'qty') return qty(String(v));
  if (type === 'percent') return `${Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 })}%`;
  if (type === 'number') return Number(v).toLocaleString('en-IN');
  return String(v);
}

const right = (t?: CellType) => t && t !== 'text';

/** Every report the person may open, for any dates, one branch or all, on screen or as Excel (CSV) and PDF. */
export default function ReportsPage() {
  const { can, me } = useSession();
  const branch = useBranch();
  const mine = REPORTS.filter((r) => r.anyOf.some((p) => can(p)));
  const [path, setPath] = useState(mine[0]?.path ?? 'sales');
  const [preset, setPreset] = useState<Preset>('today');
  const [custom, setCustom] = useState(() => presetRange('this_month'));
  const [allBranches, setAllBranches] = useState(false);
  const [groupBy, setGroupBy] = useState('day');
  const [downloading, setDownloading] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const many = (me?.branches.length ?? 0) > 1;
  const range = preset === 'custom' ? custom : presetRange(preset);
  const query = { ...range, branchId: allBranches && many ? undefined : branch.id, groupBy: path === 'sales' ? groupBy : undefined };
  const def = mine.find((r) => r.path === path) ?? mine[0];
  const report = useQuery({ queryKey: ['report', path, query], queryFn: () => api.get<Report>(`/reports/${path}`, { ...query, format: 'table' }), enabled: !!def && range.from <= range.to });

  async function download(format: 'csv' | 'pdf') {
    setDownloading(format);
    setDownloadError(null);
    try {
      await saveFile(`/reports/${path}`, { ...query, format }, `${path}_${range.from}_${range.to}.${format}`);
    } catch (err) {
      setDownloadError(errorMessage(err));
    } finally {
      setDownloading(null);
    }
  }

  if (!def) return <p className="p-4 text-stone-600">You have no reports to see.</p>;
  const groups = [...new Set(mine.map((r) => r.group))];

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 p-3 sm:p-4">
      <PageHeader
        title="Reports"
        subtitle="Figures come straight from the bills, payments and stock records."
        actions={
          <div className="flex gap-2">
            <Button variant="secondary" loading={downloading === 'csv'} onClick={() => download('csv')}>
              <Download className="size-4" aria-hidden /> Excel (CSV)
            </Button>
            <Button variant="secondary" loading={downloading === 'pdf'} onClick={() => download('pdf')}>
              <Download className="size-4" aria-hidden /> PDF
            </Button>
          </div>
        }
      />
      <div className="grid gap-4 md:grid-cols-[14rem_minmax(0,1fr)]">
        <nav aria-label="Reports" className="flex flex-col gap-3">
          {groups.map((g) => (
            <div key={g}>
              <p className="mb-1 text-xs font-medium uppercase tracking-wide text-stone-500">{g}</p>
              <ul className="flex flex-wrap gap-1 md:flex-col">
                {mine
                  .filter((r) => r.group === g)
                  .map((r) => (
                    <li key={r.path}>
                      <button
                        onClick={() => setPath(r.path)}
                        aria-current={r.path === def.path || undefined}
                        className={cn('w-full rounded-lg px-3 py-1.5 text-left text-sm', r.path === def.path ? 'bg-brand-50 font-medium text-brand-800' : 'text-stone-700 hover:bg-stone-100')}
                      >
                        {r.label}
                      </button>
                    </li>
                  ))}
              </ul>
            </div>
          ))}
        </nav>
        <div className="flex min-w-0 flex-col gap-4">
          <div className="flex flex-wrap items-end gap-3">
            <Select label="Dates" value={preset} onChange={(e) => setPreset(e.target.value as Preset)} className="w-40">
              {PRESETS.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label}
                </option>
              ))}
            </Select>
            {preset === 'custom' && (
              <>
                <Input label="From" type="date" value={custom.from} max={indiaDate()} onChange={(e) => e.target.value && setCustom((c) => ({ ...c, from: e.target.value }))} className="w-40" />
                <Input label="To" type="date" value={custom.to} max={indiaDate()} onChange={(e) => e.target.value && setCustom((c) => ({ ...c, to: e.target.value }))} className="w-40" />
              </>
            )}
            {def.path === 'sales' && (
              <Select label="One row per" value={groupBy} onChange={(e) => setGroupBy(e.target.value)} className="w-32">
                <option value="day">Day</option>
                <option value="week">Week</option>
                <option value="month">Month</option>
                <option value="year">Year</option>
              </Select>
            )}
            {many && (
              <label className="flex h-11 items-center gap-2 text-sm">
                <input type="checkbox" checked={allBranches} onChange={(e) => setAllBranches(e.target.checked)} /> All my branches
              </label>
            )}
          </div>
          {downloadError && <ErrorNote message={downloadError} />}
          {range.from > range.to ? (
            <p className="text-sm text-amber-800">The start date is after the end date.</p>
          ) : report.isError ? (
            <ErrorNote message={errorMessage(report.error)} onRetry={() => report.refetch()} />
          ) : !report.data ? (
            <Spinner label="Working out the report" />
          ) : (
            <ReportView r={report.data} />
          )}
        </div>
      </div>
    </div>
  );
}

function ReportView({ r }: { r: Report }) {
  return (
    <section aria-label={r.title} className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold">{r.title}</h2>
        <p className="text-sm text-stone-600">
          {r.from === r.to ? shortDate(r.from) : `${shortDate(r.from)} to ${shortDate(r.to)}`} · {r.branches.map((b) => b.name).join(', ') || 'No branches'}
        </p>
      </div>
      {r.summary.length > 0 && (
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4" aria-label="Totals">
          {r.summary.map((s) => (
            <Card key={s.key} className="p-3">
              <dt className="text-xs text-stone-600">{s.label}</dt>
              <dd className="text-lg font-semibold tabular-nums" data-testid={`total-${s.key}`}>
                {show(s.value, s.type)}
              </dd>
            </Card>
          ))}
        </dl>
      )}
      {r.tables.map((t) => (
        <Card key={t.key} className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="px-4 pt-3 text-left font-semibold">{t.title}</caption>
            <thead className="text-xs text-stone-500">
              <tr>
                {t.columns.map((c) => (
                  <th key={c.key} className={cn('whitespace-nowrap px-3 py-2 font-medium', right(c.type) ? 'text-right' : 'text-left')}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {t.rows.length === 0 ? (
                <tr>
                  <td colSpan={t.columns.length} className="px-3 py-3 text-stone-500">
                    Nothing in these dates.
                  </td>
                </tr>
              ) : (
                t.rows.map((row, i) => (
                  <tr key={i}>
                    {t.columns.map((c) => (
                      <td key={c.key} className={cn('whitespace-nowrap px-3 py-1.5', right(c.type) && 'text-right tabular-nums')}>
                        {show(row[c.key] ?? null, c.type)}
                      </td>
                    ))}
                  </tr>
                ))
              )}
            </tbody>
          </table>
          {t.truncated && <p className="px-3 pb-3 text-xs text-amber-800">Only the first rows are shown. Download the file for all of them.</p>}
        </Card>
      ))}
      {r.notes?.map((n) => (
        <p key={n} className="text-xs text-stone-500">
          {n}
        </p>
      ))}
    </section>
  );
}
