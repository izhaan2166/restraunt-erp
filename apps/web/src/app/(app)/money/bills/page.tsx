'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useRef, useState } from 'react';
import { useToast } from '@/components/toast';
import { Badge, Button, Card, Dialog, Empty, ErrorNote, Input, PageHeader, Select, Spinner } from '@/components/ui';
import { api, errorMessage, newKey } from '@/lib/api';
import { cn } from '@/lib/cn';
import { METHOD_LABEL, MONEY_INPUT, dateTime, indiaDate, rupees, shortDate } from '@/lib/format';
import { useBranch, useSession } from '@/lib/session';
import type { GoodsReceipt, PaymentMethod, Supplier, SupplierBill } from '@/lib/types';

type View = 'open' | 'overdue' | 'paid' | 'all';
const VIEWS: { key: View; label: string }[] = [
  { key: 'open', label: 'To pay' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'paid', label: 'Paid' },
  { key: 'all', label: 'All' },
];
const PAY_METHODS: PaymentMethod[] = ['BANK_TRANSFER', 'UPI', 'CASH', 'CARD', 'OTHER'];
const STATUS: Record<SupplierBill['status'], { label: string; tone: 'neutral' | 'amber' | 'green' | 'red' }> = {
  UNPAID: { label: 'Unpaid', tone: 'neutral' },
  PARTIALLY_PAID: { label: 'Part paid', tone: 'amber' },
  PAID: { label: 'Paid', tone: 'green' },
  CANCELLED: { label: 'Cancelled', tone: 'red' },
};

/** Bills from suppliers and what has been paid on them. The server works out what is still owed. */
export default function BillsPage() {
  const branch = useBranch();
  const { can } = useSession();
  const [view, setView] = useState<View>('open');
  const [supplierId, setSupplierId] = useState('');
  const [open, setOpen] = useState<string | 'new' | null>(null);
  const [statementFor, setStatementFor] = useState<Supplier | null>(null);
  const suppliers = useQuery({ queryKey: ['suppliers'], queryFn: () => api.all<Supplier>('/suppliers', { includeInactive: true }) });
  const query = {
    branchId: branch.id,
    supplierId: supplierId || undefined,
    status: view === 'open' ? 'UNPAID,PARTIALLY_PAID' : view === 'paid' ? 'PAID' : undefined,
    overdue: view === 'overdue' || undefined,
  };
  const bills = useQuery({ queryKey: ['supplier-bills', branch.id, query], queryFn: () => api.all<SupplierBill>('/supplier-invoices', query) });

  const error = suppliers.error ?? bills.error;
  if (error) return <ErrorNote message={errorMessage(error)} onRetry={() => (suppliers.refetch(), bills.refetch())} />;
  if (!suppliers.data || !bills.data) return <Spinner label="Loading supplier bills" />;
  const supplier = suppliers.data.find((s) => s.id === supplierId);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Supplier bills"
        subtitle={`What ${branch.name} owes suppliers, and what has been paid.`}
        actions={
          can('supplier_payments.create', branch.id) && (
            <Button onClick={() => setOpen('new')}>
              <Plus className="size-4" aria-hidden /> Add bill
            </Button>
          )
        }
      />
      <div className="flex flex-wrap items-end gap-3">
        <div role="tablist" aria-label="Which bills" className="flex rounded-lg border border-stone-300 bg-white p-0.5">
          {VIEWS.map((v) => (
            <button key={v.key} role="tab" aria-selected={view === v.key} onClick={() => setView(v.key)} className={cn('h-9 rounded-md px-3 text-sm', view === v.key ? 'bg-brand-600 text-white' : 'text-stone-700 hover:bg-stone-100')}>
              {v.label}
            </button>
          ))}
        </div>
        <Select label="Supplier" value={supplierId} onChange={(e) => setSupplierId(e.target.value)} className="w-56">
          <option value="">All suppliers</option>
          {suppliers.data.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
        {supplier && (
          <Button variant="secondary" onClick={() => setStatementFor(supplier)}>
            Statement
          </Button>
        )}
      </div>
      {bills.data.length === 0 ? (
        <Empty title={view === 'open' ? 'Nothing to pay' : view === 'overdue' ? 'No overdue bills' : 'No bills'} />
      ) : (
        <Card>
          <ul className="divide-y divide-stone-100">
            {bills.data.map((b) => (
              <li key={b.id}>
                <button className="flex w-full flex-wrap items-center gap-3 px-4 py-3 text-left hover:bg-stone-50" onClick={() => setOpen(b.id)} data-testid="bill-row">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">
                      {b.supplier.name} · {b.invoiceNumber} <Badge tone={STATUS[b.status].tone}>{STATUS[b.status].label}</Badge> {b.isOverdue && <Badge tone="red">Overdue</Badge>}
                    </p>
                    <p className="text-xs text-stone-500">
                      Billed {shortDate(b.invoiceDate)}
                      {b.dueDate && b.status !== 'PAID' && b.status !== 'CANCELLED' && ` · due ${shortDate(b.dueDate)}`} · total {rupees(b.total)}
                    </p>
                  </div>
                  {b.status !== 'CANCELLED' && Number(b.outstanding) > 0 && (
                    <span className="text-right">
                      <span className="block text-xs text-stone-500">Still owed</span>
                      <span className="font-semibold tabular-nums">{rupees(b.outstanding)}</span>
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {open === 'new' && <NewBillDialog suppliers={suppliers.data.filter((s) => s.isActive)} onClose={() => setOpen(null)} onCreated={(id) => setOpen(id)} />}
      {open && open !== 'new' && <BillDialog id={open} onClose={() => setOpen(null)} />}
      {statementFor && <StatementDialog supplier={statementFor} onClose={() => setStatementFor(null)} />}
    </div>
  );
}

function NewBillDialog({ suppliers, onClose, onCreated }: { suppliers: Supplier[]; onClose: () => void; onCreated: (id: string) => void }) {
  const branch = useBranch();
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState({ supplierId: '', invoiceNumber: '', invoiceDate: indiaDate(), dueDate: '', subtotal: '', taxTotal: '' });
  const [grns, setGrns] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef(newKey());
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  const receipts = useQuery({
    queryKey: ['goods-receipts', branch.id, f.supplierId],
    queryFn: () => api.all<GoodsReceipt & { supplierInvoiceId: string | null }>('/goods-receipts', { branchId: branch.id, supplierId: f.supplierId }),
    enabled: !!f.supplierId,
  });
  const unbilled = (receipts.data ?? []).filter((r) => !r.supplierInvoiceId);

  const problem = !f.supplierId
    ? 'Choose the supplier'
    : !f.invoiceNumber.trim()
      ? 'Enter the bill number printed on it'
      : !MONEY_INPUT.test(f.subtotal)
        ? 'Enter the amount before GST'
        : f.taxTotal && !MONEY_INPUT.test(f.taxTotal)
          ? 'GST should be an amount like 60 or 60.50'
          : f.dueDate && f.dueDate < f.invoiceDate
            ? 'The due date cannot be before the bill date'
            : null;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const bill = await api.post<SupplierBill>(
        '/supplier-invoices',
        {
          branchId: branch.id,
          supplierId: f.supplierId,
          invoiceNumber: f.invoiceNumber.trim(),
          invoiceDate: f.invoiceDate,
          dueDate: f.dueDate || undefined,
          subtotal: f.subtotal,
          taxTotal: f.taxTotal || '0',
          goodsReceiptIds: grns.length ? grns : undefined,
        },
        key.current,
      );
      await qc.invalidateQueries({ queryKey: ['supplier-bills', branch.id] });
      await qc.invalidateQueries({ queryKey: ['goods-receipts', branch.id] });
      toast(`Bill ${bill.invoiceNumber} added: ${rupees(bill.total)}`, 'success');
      onCreated(bill.id);
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
      title="Add supplier bill"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={busy} disabled={!!problem} onClick={submit}>
            Add bill
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error && <ErrorNote message={error} />}
        <Select
          label="Supplier"
          value={f.supplierId}
          onChange={(e) => {
            set({ supplierId: e.target.value });
            setGrns([]);
          }}
        >
          <option value="">Choose…</option>
          {suppliers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label="Bill number" value={f.invoiceNumber} maxLength={40} onChange={(e) => set({ invoiceNumber: e.target.value })} />
          <Input label="Bill date" type="date" value={f.invoiceDate} max={indiaDate()} onChange={(e) => set({ invoiceDate: e.target.value })} />
          <Input label="Amount before GST (₹)" inputMode="decimal" value={f.subtotal} onChange={(e) => set({ subtotal: e.target.value.trim() })} />
          <Input label="GST (₹)" inputMode="decimal" placeholder="0" value={f.taxTotal} onChange={(e) => set({ taxTotal: e.target.value.trim() })} />
          <Input label="Pay by (optional)" type="date" value={f.dueDate} min={f.invoiceDate} hint="Left empty, the supplier's payment terms decide" onChange={(e) => set({ dueDate: e.target.value })} />
        </div>
        {unbilled.length > 0 && (
          <fieldset className="flex flex-col gap-1 text-sm">
            <legend className="mb-1 font-medium">Deliveries this bill covers</legend>
            {unbilled.map((r) => (
              <label key={r.id} className="flex items-center gap-2">
                <input type="checkbox" checked={grns.includes(r.id)} onChange={(e) => setGrns((g) => (e.target.checked ? [...g, r.id] : g.filter((x) => x !== r.id)))} />
                {r.grnNumber} · received {dateTime(r.receivedAt)} · worth {rupees(r.totalValue)}
              </label>
            ))}
          </fieldset>
        )}
        {problem && f.supplierId && <p className="text-sm text-amber-800">{problem}</p>}
      </div>
    </Dialog>
  );
}

function BillDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const branch = useBranch();
  const { can } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const bill = useQuery({ queryKey: ['supplier-bill', id], queryFn: () => api.get<SupplierBill>(`/supplier-invoices/${id}`) });
  const [amount, setAmount] = useState<string | null>(null);
  const [method, setMethod] = useState<PaymentMethod>('BANK_TRANSFER');
  const [reference, setReference] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef(newKey());

  if (bill.isError) return <Dialog open onClose={onClose} title="Supplier bill"><ErrorNote message={errorMessage(bill.error)} onRetry={() => bill.refetch()} /></Dialog>;
  if (!bill.data) return <Dialog open onClose={onClose} title="Supplier bill"><Spinner /></Dialog>;
  const b = bill.data;
  const payable = can('supplier_payments.create') && (b.status === 'UNPAID' || b.status === 'PARTIALLY_PAID');
  const pay = amount ?? b.outstanding;
  const valid = MONEY_INPUT.test(pay) && Number(pay) > 0;

  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ['supplier-bill', id] });
      await qc.invalidateQueries({ queryKey: ['supplier-bills', branch.id] });
      toast(done, 'success');
      setAmount(null);
      setReference('');
      setCancelling(false);
      key.current = newKey();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={`${b.supplier.name} · ${b.invoiceNumber}`}
      footer={
        cancelling ? (
          <>
            <Button variant="ghost" onClick={() => setCancelling(false)}>
              Keep it
            </Button>
            <Button variant="danger" loading={busy} disabled={reason.trim().length < 3} onClick={() => run(() => api.post(`/supplier-invoices/${id}/cancel`, { reason: reason.trim() }), 'Bill cancelled')}>
              Cancel bill
            </Button>
          </>
        ) : (
          <>
            {b.status === 'UNPAID' && can('supplier_payments.create') && (
              <Button variant="ghost" className="mr-auto text-red-700" onClick={() => setCancelling(true)}>
                Cancel bill
              </Button>
            )}
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-4">
        {error && <ErrorNote message={error} />}
        <div className="flex flex-wrap gap-2">
          <Badge tone={STATUS[b.status].tone}>{STATUS[b.status].label}</Badge>
          {b.isOverdue && <Badge tone="red">Overdue</Badge>}
        </div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
          {(
            [
              ['Bill date', shortDate(b.invoiceDate)],
              ['Pay by', b.dueDate ? shortDate(b.dueDate) : '—'],
              ['Before GST', rupees(b.subtotal)],
              ['GST', rupees(b.taxTotal)],
              ['Total', rupees(b.total)],
              ['Paid', rupees(b.paidAmount)],
            ] as const
          ).map(([k, v]) => (
            <div key={k} className="flex justify-between gap-2 border-b border-stone-100 py-1">
              <dt className="text-stone-600">{k}</dt>
              <dd className="tabular-nums">{v}</dd>
            </div>
          ))}
        </dl>
        {b.status !== 'CANCELLED' && (
          <p>
            <span className="text-sm text-stone-600">Still owed </span>
            <span className="text-xl font-semibold tabular-nums" data-testid="bill-outstanding">
              {rupees(b.outstanding)}
            </span>
          </p>
        )}
        {b.goodsReceipts && b.goodsReceipts.length > 0 && <p className="text-sm text-stone-600">Covers deliveries {b.goodsReceipts.map((g) => g.grnNumber).join(', ')}</p>}
        {b.payments && b.payments.length > 0 && (
          <div>
            <h3 className="mb-1 font-medium">Payments</h3>
            <ul className="divide-y divide-stone-100 text-sm" aria-label="Payments">
              {b.payments.map((p) => (
                <li key={p.id} className="flex justify-between gap-2 py-1.5">
                  <span>
                    {dateTime(p.paidAt ?? p.createdAt)} · {METHOD_LABEL[p.method]}
                    {p.reference && <span className="text-stone-500"> · {p.reference}</span>}
                  </span>
                  <span className="tabular-nums">{rupees(p.amount)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {cancelling && <Input label="Why cancel it" value={reason} maxLength={300} placeholder="Entered for the wrong supplier" onChange={(e) => setReason(e.target.value)} />}
        {payable && !cancelling && (
          <div className="flex flex-col gap-3 rounded-xl bg-stone-50 p-3">
            <h3 className="font-medium">Record a payment</h3>
            <div className="grid gap-3 sm:grid-cols-3">
              <Input label="Amount (₹)" inputMode="decimal" value={pay} onChange={(e) => setAmount(e.target.value.trim())} />
              <Select label="Paid by" value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>
                {PAY_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {METHOD_LABEL[m]}
                  </option>
                ))}
              </Select>
              <Input label="Reference (optional)" value={reference} maxLength={100} placeholder="UTR or cheque number" onChange={(e) => setReference(e.target.value)} />
            </div>
            <Button
              className="self-start"
              loading={busy}
              disabled={!valid}
              onClick={() => run(() => api.post('/supplier-payments', { supplierInvoiceId: id, amount: pay, method, reference: reference.trim() || undefined }, key.current), `Payment of ${rupees(pay)} recorded`)}
            >
              Record payment
            </Button>
          </div>
        )}
      </div>
    </Dialog>
  );
}

interface Statement {
  entries: { id: string; date: string; type: string; reference: string; debit: string; credit: string; balance: string }[];
  balance: string;
}

function StatementDialog({ supplier, onClose }: { supplier: Supplier; onClose: () => void }) {
  const branch = useBranch();
  const s = useQuery({ queryKey: ['supplier-statement', supplier.id, branch.id], queryFn: () => api.get<Statement>(`/suppliers/${supplier.id}/transactions`, { branchId: branch.id }) });
  return (
    <Dialog open wide onClose={onClose} title={`Statement: ${supplier.name}`} footer={<Button variant="ghost" onClick={onClose}>Close</Button>}>
      {s.isError ? (
        <ErrorNote message={errorMessage(s.error)} onRetry={() => s.refetch()} />
      ) : !s.data ? (
        <Spinner />
      ) : s.data.entries.length === 0 ? (
        <p className="text-sm text-stone-500">No bills or payments yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-stone-500">
              <tr>
                <th className="py-2 pr-3 font-medium">Date</th>
                <th className="py-2 pr-3 font-medium">What</th>
                <th className="py-2 pr-3 text-right font-medium">Billed</th>
                <th className="py-2 pr-3 text-right font-medium">Paid</th>
                <th className="py-2 text-right font-medium">Owed</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {s.data.entries.map((e, i) => (
                <tr key={`${e.id}-${i}`}>
                  <td className="py-1.5 pr-3">{shortDate(e.date)}</td>
                  <td className="py-1.5 pr-3">
                    {e.type === 'INVOICE' ? 'Bill' : e.type === 'PAYMENT' ? 'Payment' : e.type.toLowerCase()} {e.reference}
                  </td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{Number(e.debit) ? rupees(e.debit) : ''}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{Number(e.credit) ? rupees(e.credit) : ''}</td>
                  <td className="py-1.5 text-right tabular-nums">{rupees(e.balance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-right">
            Owed now <span className="font-semibold">{rupees(s.data.balance)}</span>
          </p>
        </div>
      )}
    </Dialog>
  );
}
