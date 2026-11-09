'use client';

import { CheckCircle2, Printer } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ApiError, api, errorMessage, newKey, openFile } from '@/lib/api';
import { rupees } from '@/lib/format';
import { useSession } from '@/lib/session';
import type { Invoice, Order, PaymentMethod } from '@/lib/types';
import { cn } from '@/lib/cn';
import { Button, Dialog, ErrorNote, Input, Spinner } from './ui';

const METHODS: { value: PaymentMethod; label: string }[] = [
  { value: 'CASH', label: 'Cash' },
  { value: 'UPI', label: 'UPI' },
  { value: 'CARD', label: 'Card' },
  { value: 'WALLET', label: 'Wallet' },
];

const MONEY = /^\d+(\.\d{1,2})?$/;

/**
 * Issues the bill for an order (once: a retry reuses the same key, and an order that already has a
 * bill shows that bill), then takes one or more payments. The server computes every amount; the
 * screen only shows what it returns.
 */
export function BillDialog({ order, open, onClose, onPaid }: { order: Order; open: boolean; onClose: () => void; onPaid: (inv: Invoice) => void }) {
  const { can } = useSession();
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const issueKey = useRef(newKey());

  // Depend on the finalized bill's id, not the invoices array: the order reloads live (new array each
  // time), and re-running would send the same issue request again while the first is still in flight.
  const existingId = order.invoices.find((i) => i.status === 'FINALIZED')?.id;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);
    setLoading(true);
    (async () => {
      try {
        let inv: Invoice;
        if (existingId) inv = await api.get<Invoice>(`/invoices/${existingId}`);
        else {
          try {
            inv = await issue(order.id, issueKey.current);
          } catch (err) {
            // Another till billed it first: show that bill.
            const id = err instanceof ApiError && err.code === 'ALREADY_INVOICED' ? (err.details as { invoiceId?: string } | undefined)?.invoiceId : undefined;
            if (!id) throw err;
            inv = await api.get<Invoice>(`/invoices/${id}`);
          }
        }
        if (!cancelled) setInvoice(inv);
      } catch (err) {
        if (!cancelled) setError(errorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, order.id, existingId]);

  const paid = invoice?.paymentStatus === 'PAID';

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={invoice ? `Bill ${invoice.invoiceNumber}` : 'Bill'}
      footer={
        invoice ? (
          <>
            <Button variant="secondary" onClick={() => openFile(`/invoices/${invoice.id}/pdf`).catch((e) => setError(errorMessage(e)))}>
              <Printer className="size-4" aria-hidden /> Print bill
            </Button>
            {paid ? (
              <Button variant="success" onClick={() => onPaid(invoice)}>
                Done
              </Button>
            ) : (
              <Button variant="ghost" onClick={onClose}>
                Close
              </Button>
            )}
          </>
        ) : undefined
      }
    >
      {loading && <Spinner label="Preparing bill" />}
      {error && <ErrorNote message={error} />}
      {invoice && (
        <div className="flex flex-col gap-4">
          <BillSummary invoice={invoice} />
          {paid ? (
            <p role="status" className="flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2 font-medium text-emerald-800">
              <CheckCircle2 className="size-5" aria-hidden /> Paid in full
            </p>
          ) : can('payments.create', order.branchId) ? (
            <PaymentForm invoice={invoice} onPaid={setInvoice} />
          ) : (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">The bill is ready. A cashier needs to take the payment.</p>
          )}
        </div>
      )}
    </Dialog>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={cn('flex justify-between', strong && 'text-base font-semibold text-stone-900')}>
      <span>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}

function BillSummary({ invoice: i }: { invoice: Invoice }) {
  return (
    <div className="flex flex-col gap-1 text-sm text-stone-700">
      {i.items.map((l) => (
        <div key={l.id} className="flex justify-between gap-3">
          <span>
            {l.description} × {l.quantity.replace(/\.0+$/, '')}
          </span>
          <span className="tabular-nums">{rupees(l.lineTotal)}</span>
        </div>
      ))}
      <hr className="my-2 border-stone-200" />
      <Row label="Subtotal" value={rupees(i.subtotal)} />
      {Number(i.discountTotal) > 0 && <Row label="Discount" value={`− ${rupees(i.discountTotal)}`} />}
      {Number(i.cgstAmount) > 0 && <Row label="CGST" value={rupees(i.cgstAmount)} />}
      {Number(i.sgstAmount) > 0 && <Row label="SGST" value={rupees(i.sgstAmount)} />}
      {Number(i.igstAmount) > 0 && <Row label="IGST" value={rupees(i.igstAmount)} />}
      {Number(i.serviceCharge) > 0 && <Row label="Service charge" value={rupees(i.serviceCharge)} />}
      {Number(i.roundOff) !== 0 && <Row label="Round off" value={rupees(i.roundOff)} />}
      <Row label="Total" value={rupees(i.grandTotal)} strong />
      {i.payments.length > 0 && (
        <>
          <hr className="my-2 border-stone-200" />
          {i.payments.map((p) => (
            <Row key={p.id} label={`Paid by ${p.method.toLowerCase()}${p.reference ? ` (${p.reference})` : ''}`} value={rupees(p.allocated ?? p.amount)} />
          ))}
          <Row label="Still to pay" value={rupees(i.outstanding)} strong />
        </>
      )}
    </div>
  );
}

function PaymentForm({ invoice, onPaid }: { invoice: Invoice; onPaid: (i: Invoice) => void }) {
  const [method, setMethod] = useState<PaymentMethod>('CASH');
  const [amount, setAmount] = useState(invoice.outstanding);
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsShift, setNeedsShift] = useState(false);
  // One key per payment attempt: retrying the same tap never charges twice; a new payment gets a new key.
  const key = useRef(newKey());
  const { branch } = useSession();

  useEffect(() => setAmount(invoice.outstanding), [invoice.outstanding]);

  const valid = MONEY.test(amount) && Number(amount) > 0;

  async function pay() {
    setBusy(true);
    setError(null);
    try {
      const inv = await api.post<Invoice>(`/invoices/${invoice.id}/payments`, { method, amount, reference: reference.trim() || undefined }, key.current);
      key.current = newKey();
      setReference('');
      onPaid(inv);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'NO_OPEN_SHIFT') setNeedsShift(true);
      else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const change = (fn: () => void) => {
    fn();
    key.current = newKey();
  };

  if (needsShift && branch) return <OpenDrawer branchId={branch.id} onOpened={() => setNeedsShift(false)} />;

  return (
    <div className="flex flex-col gap-3 rounded-xl bg-stone-50 p-3">
      <div role="radiogroup" aria-label="Payment method" className="grid grid-cols-4 gap-2">
        {METHODS.map((m) => (
          <button
            key={m.value}
            role="radio"
            aria-checked={method === m.value}
            onClick={() => change(() => setMethod(m.value))}
            className={cn('h-11 rounded-lg border text-sm font-medium', method === m.value ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-stone-300 bg-white')}
          >
            {m.label}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Input label="Amount (₹)" inputMode="decimal" value={amount} onChange={(e) => change(() => setAmount(e.target.value.trim()))} error={amount && !valid ? 'Enter an amount like 250 or 250.50' : null} />
        {method !== 'CASH' && <Input label={method === 'UPI' ? 'UPI reference' : 'Reference'} value={reference} onChange={(e) => change(() => setReference(e.target.value))} placeholder="Optional" />}
      </div>
      {error && <ErrorNote message={error} />}
      <Button size="lg" variant="success" onClick={pay} loading={busy} disabled={!valid}>
        Take {rupees(MONEY.test(amount) ? amount : '0')}
      </Button>
    </div>
  );
}

function OpenDrawer({ branchId, onOpened }: { branchId: string; onOpened: () => void }) {
  const [opening, setOpening] = useState('0');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef(newKey());
  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.post('/cash-sessions/open', { branchId, openingBalance: opening }, key.current);
      onOpened();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-col gap-3 rounded-xl bg-amber-50 p-3">
      <p className="text-sm text-amber-900">Open your cash drawer before taking cash. Count the cash in the drawer now.</p>
      <Input label="Cash in drawer (₹)" inputMode="decimal" value={opening} onChange={(e) => setOpening(e.target.value.trim())} />
      {error && <ErrorNote message={error} />}
      <Button onClick={submit} loading={busy} disabled={!MONEY.test(opening)}>
        Open drawer
      </Button>
    </div>
  );
}

/** Issues the bill; if the same request is still being processed (a quick re-open), waits for its answer. */
async function issue(orderId: string, key: string): Promise<Invoice> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await api.post<Invoice>('/invoices', { orderId }, key);
    } catch (err) {
      if (!(err instanceof ApiError && err.code === 'IDEMPOTENCY_IN_PROGRESS') || attempt >= 5) throw err;
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    }
  }
}
