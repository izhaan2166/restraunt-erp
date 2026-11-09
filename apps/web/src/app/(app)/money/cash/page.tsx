'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDownToLine, ArrowUpFromLine } from 'lucide-react';
import { useRef, useState } from 'react';
import { useToast } from '@/components/toast';
import { Badge, Button, Card, Dialog, Empty, ErrorNote, Input, PageHeader, Select, Spinner } from '@/components/ui';
import { api, errorMessage, newKey } from '@/lib/api';
import { MONEY_INPUT, METHOD_LABEL, dateTime, indiaDate, rupees, titleCase } from '@/lib/format';
import { useBranch, useSession } from '@/lib/session';
import type { CashShift, ShiftReport } from '@/lib/types';

/** The cash drawer: your own shift (open, add or take out cash, count and close) and, for managers, every shift. */
export default function CashPage() {
  const { can } = useSession();
  const branch = useBranch();
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Cash drawer" subtitle={`Cash in the drawer at ${branch.name}. Every rupee in or out is recorded.`} />
      {can('shifts.open', branch.id) && <MyShift />}
      {can('shifts.read', branch.id) && <AllShifts />}
    </div>
  );
}

function MyShift() {
  const branch = useBranch();
  const current = useQuery({ queryKey: ['shift-current', branch.id], queryFn: () => api.get<CashShift | null>('/cash-sessions/current', { branchId: branch.id }) });
  if (current.isError) return <ErrorNote message={errorMessage(current.error)} onRetry={() => current.refetch()} />;
  if (current.data === undefined) return <Spinner label="Loading your shift" />;
  return (
    <section aria-labelledby="my-shift" className="flex flex-col gap-3">
      <h2 id="my-shift" className="text-lg font-semibold">
        Your shift
      </h2>
      {current.data ? <OpenShift shift={current.data} /> : <OpenForm />}
    </section>
  );
}

function OpenForm() {
  const branch = useBranch();
  const qc = useQueryClient();
  const toast = useToast();
  const [opening, setOpening] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef(newKey());
  const valid = MONEY_INPUT.test(opening);
  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.post('/cash-sessions/open', { branchId: branch.id, openingBalance: opening }, key.current);
      key.current = newKey();
      await qc.invalidateQueries({ queryKey: ['shift-current', branch.id] });
      await qc.invalidateQueries({ queryKey: ['shifts', branch.id] });
      toast('Drawer opened', 'success');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card className="flex flex-col gap-3 p-4">
      <p className="text-sm text-stone-600">Your drawer is closed. Count the cash in it now and open your shift before you take any cash.</p>
      {error && <ErrorNote message={error} />}
      <div className="flex flex-wrap items-end gap-3">
        <Input label="Cash in drawer now (₹)" inputMode="decimal" value={opening} onChange={(e) => setOpening(e.target.value.trim())} className="w-48" error={opening && !valid ? 'Enter an amount like 1000 or 1000.50' : null} />
        <Button onClick={submit} loading={busy} disabled={!valid}>
          Open drawer
        </Button>
      </div>
    </Card>
  );
}

function OpenShift({ shift }: { shift: CashShift }) {
  const { can } = useSession();
  const [moving, setMoving] = useState<'CASH_IN' | 'CASH_OUT' | null>(null);
  const [closing, setClosing] = useState(false);
  return (
    <div className="flex flex-col gap-3">
      <ShiftFigures id={shift.id} />
      <div className="flex flex-wrap gap-2">
        {can('cash.movement') && (
          <>
            <Button variant="secondary" onClick={() => setMoving('CASH_IN')}>
              <ArrowDownToLine className="size-4" aria-hidden /> Add cash
            </Button>
            <Button variant="secondary" onClick={() => setMoving('CASH_OUT')}>
              <ArrowUpFromLine className="size-4" aria-hidden /> Take cash out
            </Button>
          </>
        )}
        {can('shifts.close') && <Button onClick={() => setClosing(true)}>Count and close</Button>}
      </div>
      {moving && <MovementDialog shift={shift} type={moving} onClose={() => setMoving(null)} />}
      {closing && <CloseDialog shift={shift} onClose={() => setClosing(false)} />}
    </div>
  );
}

const ROW_LABEL: Record<string, string> = {
  OPENING_FLOAT: 'Opening cash',
  CASH_SALE: 'Cash sale',
  CASH_REFUND: 'Cash refund',
  CASH_IN: 'Cash added',
  CASH_OUT: 'Cash taken out',
  EXPENSE: 'Expense paid',
};

/** The server's report for a shift: what should be in the drawer and why. */
function ShiftFigures({ id, full }: { id: string; full?: boolean }) {
  const report = useQuery({ queryKey: ['shift-report', id], queryFn: () => api.get<ShiftReport>(`/cash-sessions/${id}/report`), refetchInterval: 30_000 });
  if (report.isError) return <ErrorNote message={errorMessage(report.error)} onRetry={() => report.refetch()} />;
  if (!report.data) return <Spinner />;
  const r = report.data;
  const c = r.cash;
  const lines: [string, string][] = [
    ['Opening cash', c.openingFloat],
    ['Cash sales', c.cashSales],
    ['Cash refunds', c.cashRefunds],
    ['Cash added', c.cashIn],
    ['Cash taken out', c.cashOut],
    ['Expenses paid from drawer', c.expenses],
  ];
  return (
    <Card className="flex flex-col gap-3 p-4" >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm text-stone-600">
          {r.cashier.fullName} · opened {dateTime(r.openedAt)}
          {r.closedAt && ` · closed ${dateTime(r.closedAt)}${r.closedBy && r.closedBy.id !== r.cashier.id ? ` by ${r.closedBy.fullName}` : ''}`}
        </p>
        <Badge tone={r.status === 'OPEN' ? 'green' : 'neutral'}>{r.status === 'OPEN' ? 'Open' : 'Closed'}</Badge>
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
        {lines.map(([label, v]) => (
          <div key={label} className="flex justify-between gap-2 border-b border-stone-100 py-1">
            <dt className="text-stone-600">{label}</dt>
            <dd className="tabular-nums">{rupees(v)}</dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-wrap gap-x-8 gap-y-2">
        <p>
          <span className="text-sm text-stone-600">Should be in drawer </span>
          <span className="text-xl font-semibold tabular-nums" data-testid="expected-cash">
            {rupees(c.expected)}
          </span>
        </p>
        {c.actual !== null && (
          <p>
            <span className="text-sm text-stone-600">Counted </span>
            <span className="text-xl font-semibold tabular-nums">{rupees(c.actual)}</span>{' '}
            <Difference value={c.discrepancy} />
          </p>
        )}
      </div>
      {c.notes && <p className="text-sm text-stone-600">Note: {c.notes}</p>}
      {full && (
        <>
          {r.paymentsByMethod.length > 0 && (
            <p className="text-sm text-stone-600">
              Took {rupees(r.totalCollected)} in all:{' '}
              {r.paymentsByMethod.map((p) => `${METHOD_LABEL[p.method] ?? titleCase(p.method)} ${rupees(p.amount)} (${p.count})`).join(', ')}
            </p>
          )}
          <h3 className="font-medium">Drawer entries</h3>
          <ul className="divide-y divide-stone-100 text-sm" aria-label="Drawer entries">
            {r.movements.map((m) => (
              <li key={m.id} className="flex flex-wrap justify-between gap-2 py-1.5">
                <span>
                  {ROW_LABEL[m.type] ?? titleCase(m.type)}
                  {m.note && <span className="text-stone-500"> · {m.note}</span>}
                  <span className="block text-xs text-stone-500">{dateTime(m.createdAt)}</span>
                </span>
                <span className="tabular-nums">{rupees(m.amount)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

function Difference({ value }: { value: string | null }) {
  if (value === null) return null;
  const n = Number(value);
  if (n === 0) return <Badge tone="green">Matches</Badge>;
  return <Badge tone={n < 0 ? 'red' : 'amber'}>{n < 0 ? `${rupees(value.replace('-', ''))} short` : `${rupees(value)} over`}</Badge>;
}

function MovementDialog({ shift, type, onClose }: { shift: CashShift; type: 'CASH_IN' | 'CASH_OUT'; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef(newKey());
  const valid = MONEY_INPUT.test(amount) && Number(amount) > 0 && reason.trim().length >= 3;
  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/cash-sessions/${shift.id}/movements`, { type, amount, reason: reason.trim() }, key.current);
      await qc.invalidateQueries({ queryKey: ['shift-report', shift.id] });
      toast(type === 'CASH_IN' ? `${rupees(amount)} added to the drawer` : `${rupees(amount)} taken out of the drawer`, 'success');
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onClose={onClose}
      title={type === 'CASH_IN' ? 'Add cash to the drawer' : 'Take cash out of the drawer'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} loading={busy} disabled={!valid}>
            {type === 'CASH_IN' ? 'Add cash' : 'Take out'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error && <ErrorNote message={error} />}
        <Input label="Amount (₹)" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.trim())} error={amount && !MONEY_INPUT.test(amount) ? 'Enter an amount like 500 or 500.50' : null} />
        <Input label="Why" value={reason} maxLength={200} placeholder={type === 'CASH_IN' ? 'Change from the bank' : 'Bank deposit'} onChange={(e) => setReason(e.target.value)} />
        <p className="text-xs text-stone-500">To pay a bill from the drawer, add it under Expenses and tick “Paid from the cash drawer”.</p>
      </div>
    </Dialog>
  );
}

function CloseDialog({ shift, onClose }: { shift: CashShift; onClose: () => void }) {
  const branch = useBranch();
  const qc = useQueryClient();
  const toast = useToast();
  const [actual, setActual] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = MONEY_INPUT.test(actual);
  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<ShiftReport>(`/cash-sessions/${shift.id}/close`, { actualCash: actual, notes: notes.trim() || undefined });
      qc.setQueryData(['shift-report', shift.id], r);
      await qc.invalidateQueries({ queryKey: ['shift-current', branch.id] });
      await qc.invalidateQueries({ queryKey: ['shifts', branch.id] });
      const d = Number(r.cash.discrepancy ?? 0);
      toast(d === 0 ? 'Shift closed. The drawer matches.' : `Shift closed. The drawer is ${rupees(String(Math.abs(d)))} ${d < 0 ? 'short' : 'over'}.`, d === 0 ? 'success' : 'info');
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Close shift: ${shift.user.fullName}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} loading={busy} disabled={!valid}>
            Close shift
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-sm text-stone-600">Count every note and coin in the drawer and type the total. If it does not match what should be there, say why.</p>
        {error && <ErrorNote message={error} />}
        <Input label="Cash counted (₹)" inputMode="decimal" value={actual} onChange={(e) => setActual(e.target.value.trim())} error={actual && !valid ? 'Enter an amount like 8450 or 8450.50' : null} />
        <Input label="Note (needed if it does not match)" value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} />
      </div>
    </Dialog>
  );
}

function AllShifts() {
  const branch = useBranch();
  const { can, me } = useSession();
  const [status, setStatus] = useState<'' | 'OPEN' | 'CLOSED'>('');
  const [from, setFrom] = useState(() => indiaDate(new Date(Date.now() - 6 * 86_400_000)));
  const [to, setTo] = useState(() => indiaDate());
  const [viewing, setViewing] = useState<CashShift | null>(null);
  const [closing, setClosing] = useState<CashShift | null>(null);
  const query = { branchId: branch.id, status: status || undefined, from, to, pageSize: 100 };
  const shifts = useQuery({ queryKey: ['shifts', branch.id, query], queryFn: () => api.page<CashShift>('/cash-sessions', query) });
  const summary = useQuery({
    queryKey: ['shifts', branch.id, 'summary', from, to],
    queryFn: () =>
      api.get<{ cashier: { id: string; fullName: string }; shifts: number; openShifts: number; cashSales: string; shortages: string; overages: string; netDiscrepancy: string }[]>('/cash-sessions/summary', { branchId: branch.id, from, to }),
  });

  return (
    <section aria-labelledby="all-shifts" className="flex flex-col gap-3">
      <h2 id="all-shifts" className="text-lg font-semibold">
        All shifts
      </h2>
      <div className="flex flex-wrap items-end gap-3">
        <Input label="From" type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} className="w-40" />
        <Input label="To" type="date" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} className="w-40" />
        <Select label="Status" value={status} onChange={(e) => setStatus(e.target.value as typeof status)} className="w-36">
          <option value="">All</option>
          <option value="OPEN">Open</option>
          <option value="CLOSED">Closed</option>
        </Select>
      </div>
      {summary.data && summary.data.length > 0 && (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">Cash by cashier</caption>
            <thead className="text-left text-xs text-stone-500">
              <tr>
                <th className="px-4 py-2 font-medium">Cashier</th>
                <th className="px-4 py-2 font-medium">Shifts</th>
                <th className="px-4 py-2 text-right font-medium">Cash sales</th>
                <th className="px-4 py-2 text-right font-medium">Short</th>
                <th className="px-4 py-2 text-right font-medium">Over</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {summary.data.map((s) => (
                <tr key={s.cashier.id}>
                  <td className="px-4 py-2">{s.cashier.fullName}</td>
                  <td className="px-4 py-2">
                    {s.shifts}
                    {s.openShifts > 0 && ` (${s.openShifts} open)`}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">{rupees(s.cashSales)}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-red-700">{Number(s.shortages) ? rupees(s.shortages) : '—'}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-amber-800">{Number(s.overages) ? rupees(s.overages) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {shifts.isError ? (
        <ErrorNote message={errorMessage(shifts.error)} onRetry={() => shifts.refetch()} />
      ) : !shifts.data ? (
        <Spinner label="Loading shifts" />
      ) : shifts.data.items.length === 0 ? (
        <Empty title="No shifts in these dates" />
      ) : (
        <Card>
          <ul className="divide-y divide-stone-100">
            {shifts.data.items.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-3 px-4 py-3" data-testid="shift-row">
                <button className="min-w-0 flex-1 text-left" onClick={() => setViewing(s)}>
                  <p className="font-medium">
                    {s.user.fullName} {s.status === 'OPEN' ? <Badge tone="green">Open</Badge> : <Difference value={s.discrepancy} />}
                  </p>
                  <p className="text-xs text-stone-500">
                    {dateTime(s.openedAt)}
                    {s.closedAt && ` to ${dateTime(s.closedAt)}`} · opened with {rupees(s.openingBalance)}
                    {s.actualCash !== null && ` · counted ${rupees(s.actualCash)}`}
                  </p>
                </button>
                {s.status === 'OPEN' && s.userId !== me?.user.id && can('shifts.close', branch.id) && (
                  <Button size="sm" variant="secondary" onClick={() => setClosing(s)}>
                    Close
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
      {viewing && (
        <Dialog open wide onClose={() => setViewing(null)} title={`Shift: ${viewing.user.fullName}`}>
          <ShiftFigures id={viewing.id} full />
        </Dialog>
      )}
      {closing && <CloseDialog shift={closing} onClose={() => setClosing(null)} />}
    </section>
  );
}
