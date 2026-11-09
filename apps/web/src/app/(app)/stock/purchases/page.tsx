'use client';

import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { PackageCheck, Plus, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { useToast } from '@/components/toast';
import { Badge, Button, Card, Dialog, Empty, ErrorNote, Input, PageHeader, Select, Spinner, Tone } from '@/components/ui';
import { api, errorMessage, newKey } from '@/lib/api';
import { cn } from '@/lib/cn';
import { dateTime, qty, rupees, stockQty } from '@/lib/format';
import { useBranch, useSession } from '@/lib/session';
import type { GoodsReceipt, Ingredient, PurchaseOrder, PurchaseOrderStatus, StockRow, Supplier, Unit } from '@/lib/types';

const QTY = /^(0|[1-9][0-9]{0,10})(\.[0-9]{1,3})?$/;
const PRICE = /^(0|[1-9][0-9]{0,9})(\.[0-9]{1,4})?$/;
const PCT = /^(100(\.0{1,3})?|[0-9]{1,2}(\.[0-9]{1,3})?)$/;

const FILTERS = [
  { key: 'open', label: 'Open', status: 'DRAFT,ORDERED,PARTIALLY_RECEIVED' },
  { key: 'received', label: 'Received', status: 'RECEIVED' },
  { key: 'cancelled', label: 'Cancelled', status: 'CANCELLED' },
  { key: 'all', label: 'All', status: undefined },
];
const STATUS: Record<PurchaseOrderStatus, { label: string; tone: Tone }> = {
  DRAFT: { label: 'Needs approval', tone: 'amber' },
  ORDERED: { label: 'Ordered', tone: 'blue' },
  PARTIALLY_RECEIVED: { label: 'Part received', tone: 'violet' },
  RECEIVED: { label: 'Received', tone: 'green' },
  CANCELLED: { label: 'Cancelled', tone: 'red' },
};

/** Purchase orders for the selected branch: raise, approve, receive. Deliveries add stock at the price paid. */
export default function PurchasesPage() {
  const branch = useBranch();
  const { can } = useSession();
  const [filter, setFilter] = useState('open');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | 'new' | 'direct' | null>(null);
  const f = FILTERS.find((x) => x.key === filter)!;

  const orders = useQuery({
    queryKey: ['purchase-orders', branch.id, filter, page],
    queryFn: () => api.page<PurchaseOrder>('/purchase-orders', { branchId: branch.id, status: f.status, page, pageSize: 25 }),
    placeholderData: keepPreviousData,
  });

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Purchase orders"
        subtitle={`${branch.name}: order from suppliers, then receive what arrives.`}
        actions={
          <>
            {can('purchases.receive') && (
              <Button variant="secondary" onClick={() => setOpen('direct')}>
                <PackageCheck className="size-4" aria-hidden /> Delivery without order
              </Button>
            )}
            {can('purchases.create') && (
              <Button onClick={() => setOpen('new')}>
                <Plus className="size-4" aria-hidden /> New purchase order
              </Button>
            )}
          </>
        }
      />
      <div role="tablist" aria-label="Show" className="flex w-fit gap-1 rounded-lg bg-stone-100 p-1">
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
      {orders.isPending ? (
        <Spinner />
      ) : orders.isError ? (
        <ErrorNote message={errorMessage(orders.error)} onRetry={() => orders.refetch()} />
      ) : orders.data.items.length === 0 ? (
        <Empty title="No purchase orders here" />
      ) : (
        <Card>
          <ul className="divide-y divide-stone-100">
            {orders.data.items.map((po) => (
              <li key={po.id}>
                <button className="flex w-full flex-wrap items-center gap-3 px-4 py-3 text-left hover:bg-stone-50" onClick={() => setOpen(po.id)} data-testid="po-row">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{po.supplier.name}</p>
                    <p className="truncate text-xs text-stone-500">
                      {po.poNumber} · {dateTime(po.orderDate)} · {po.items.map((i) => i.ingredient.name).join(', ')}
                    </p>
                  </div>
                  <Badge tone={STATUS[po.status].tone}>{STATUS[po.status].label}</Badge>
                  <span className="w-24 text-right font-medium tabular-nums">{rupees(po.total)}</span>
                </button>
              </li>
            ))}
          </ul>
          {orders.data.meta.totalPages > 1 && (
            <div className="flex items-center justify-between border-t border-stone-100 px-4 py-2 text-sm">
              <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                Previous
              </Button>
              <span>
                Page {page} of {orders.data.meta.totalPages}
              </span>
              <Button size="sm" variant="secondary" disabled={page >= orders.data.meta.totalPages} onClick={() => setPage((p) => p + 1)}>
                Next
              </Button>
            </div>
          )}
        </Card>
      )}
      {(open === 'new' || open === 'direct') && <OrderForm kind={open} onClose={() => setOpen(null)} onCreated={(id) => setOpen(id)} />}
      {open && open !== 'new' && open !== 'direct' && <OrderDialog id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

interface LineForm {
  ingredientId: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  taxRate: string;
}

function usePurchaseData() {
  const branch = useBranch();
  const suppliers = useQuery({ queryKey: ['suppliers'], queryFn: () => api.all<Supplier>('/suppliers', { includeInactive: true }) });
  const ingredients = useQuery({ queryKey: ['ingredients'], queryFn: () => api.all<Ingredient>('/ingredients', { includeInactive: true }) });
  const units = useQuery({ queryKey: ['units'], queryFn: () => api.get<Unit[]>('/units'), staleTime: Infinity });
  const stock = useQuery({ queryKey: ['stock', branch.id], queryFn: () => api.get<StockRow[]>('/inventory', { branchId: branch.id }) });
  return { suppliers, ingredients, units, stock };
}

/** A new purchase order, or goods that arrived without one. The totals are worked out by the server. */
function OrderForm({ kind, onClose, onCreated }: { kind: 'new' | 'direct'; onClose: () => void; onCreated: (id: string) => void }) {
  const branch = useBranch();
  const qc = useQueryClient();
  const toast = useToast();
  const { suppliers, ingredients, units, stock } = usePurchaseData();
  const [supplierId, setSupplierId] = useState('');
  const [expectedDate, setExpectedDate] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<LineForm[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef(newKey());
  const direct = kind === 'direct';

  if (suppliers.error || ingredients.error || units.error) return null;
  const ready = suppliers.data && ingredients.data && units.data;
  const active = (ingredients.data ?? []).filter((i) => i.isActive);
  const byId = new Map(active.map((i) => [i.id, i]));
  // Prefer the unit it is bought in (kg, l) over the counting unit (g, ml).
  const buyUnit = (i?: Ingredient) => (i ? ((units.data ?? []).find((u) => u.dimension === i.baseUnit.dimension && u.factorToBase === '1000')?.code ?? i.baseUnit.code) : '');
  const low = (stock.data ?? []).filter((s) => (s.isLow || s.isNegative) && byId.has(s.ingredientId) && !lines.some((l) => l.ingredientId === s.ingredientId));
  const update = (i: number, p: Partial<LineForm>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));
  const blank = (ingredientId = ''): LineForm => ({ ingredientId, quantity: '', unit: buyUnit(byId.get(ingredientId)), unitPrice: '', taxRate: '' });

  const problem = !supplierId
    ? 'Choose the supplier'
    : lines.length === 0
      ? 'Add at least one item'
      : lines.some((l) => !l.ingredientId)
        ? 'Choose an ingredient on every line'
        : lines.some((l) => !QTY.test(l.quantity) || Number(l.quantity) <= 0)
          ? 'Enter a quantity on every line'
          : lines.some((l) => !PRICE.test(l.unitPrice))
            ? 'Enter the price on every line, like 320 or 32.50'
            : lines.some((l) => l.taxRate !== '' && !PCT.test(l.taxRate))
              ? 'GST is a percent between 0 and 100'
              : null;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      if (direct) {
        const grn = await api.post<GoodsReceipt>(
          '/goods-receipts',
          { branchId: branch.id, supplierId, notes: notes.trim() || undefined, items: lines.map(({ ingredientId, quantity, unit, unitPrice }) => ({ ingredientId, quantity, unit, unitPrice })) },
          key.current,
        );
        await Promise.all([qc.invalidateQueries({ queryKey: ['stock'] }), qc.invalidateQueries({ queryKey: ['purchase-orders'] })]);
        toast(`Delivery ${grn.grnNumber} added to stock (${rupees(grn.totalValue)})`, 'success');
        onClose();
      } else {
        const po = await api.post<PurchaseOrder>(
          '/purchase-orders',
          {
            branchId: branch.id,
            supplierId,
            expectedDate: expectedDate ? new Date(`${expectedDate}T00:00:00`).toISOString() : undefined,
            notes: notes.trim() || undefined,
            items: lines.map((l) => ({ ...l, taxRate: l.taxRate || undefined })),
          },
          key.current,
        );
        await qc.invalidateQueries({ queryKey: ['purchase-orders'] });
        toast(`${po.poNumber} saved`, 'success');
        onCreated(po.id);
      }
    } catch (err) {
      setError(errorMessage(err));
      key.current = newKey();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={direct ? 'Delivery without an order' : 'New purchase order'}
      footer={
        <>
          {problem && lines.length > 0 && <span className="mr-auto text-sm text-amber-800">{problem}</span>}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={busy} disabled={!!problem}>
            {direct ? 'Add to stock' : 'Save purchase order'}
          </Button>
        </>
      }
    >
      {!ready ? (
        <Spinner />
      ) : (
        <div className="flex flex-col gap-3">
          {error && <ErrorNote message={error} />}
          {direct && <p className="text-sm text-stone-600">For goods bought without a purchase order, such as from the market. They are added to stock straight away at the price you enter.</p>}
          <div className="grid gap-3 sm:grid-cols-2">
            <Select label="Supplier" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
              <option value="">Choose…</option>
              {suppliers.data!.filter((s) => s.isActive).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
            {!direct && <Input label="Expected on (optional)" type="date" value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)} />}
          </div>
          {suppliers.data!.every((s) => !s.isActive) && <p className="text-sm text-amber-800">Add a supplier on the Suppliers tab first.</p>}
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-semibold">Items</legend>
            {lines.map((l, i) => {
              const ing = byId.get(l.ingredientId);
              return (
                <div key={i} className="grid grid-cols-2 items-end gap-2 rounded-lg border border-stone-200 p-2 sm:grid-cols-[minmax(0,1fr)_6rem_5rem_7rem_5rem_auto] sm:border-0 sm:p-0" data-testid="po-line">
                  <div className="col-span-2 sm:col-span-1">
                    <Select label="Ingredient" value={l.ingredientId} onChange={(e) => update(i, { ingredientId: e.target.value, unit: buyUnit(byId.get(e.target.value)) })}>
                      <option value="">Choose…</option>
                      {active.map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.name}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <Input label="Quantity" inputMode="decimal" value={l.quantity} onChange={(e) => update(i, { quantity: e.target.value.trim() })} />
                  <Select label="Unit" value={l.unit} disabled={!ing} onChange={(e) => update(i, { unit: e.target.value })}>
                    {(units.data ?? [])
                      .filter((u) => ing && u.dimension === ing.baseUnit.dimension)
                      .map((u) => (
                        <option key={u.id} value={u.code}>
                          {u.code}
                        </option>
                      ))}
                  </Select>
                  <Input label={`₹ per ${l.unit || 'unit'}`} inputMode="decimal" value={l.unitPrice} onChange={(e) => update(i, { unitPrice: e.target.value.trim() })} />
                  {!direct ? <Input label="GST %" inputMode="decimal" placeholder="0" value={l.taxRate} onChange={(e) => update(i, { taxRate: e.target.value.trim() })} /> : <span className="hidden sm:block" />}
                  <Button variant="ghost" className="h-11" aria-label={`Remove ${ing?.name ?? 'line'}`} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
                    <X className="size-4" aria-hidden />
                  </Button>
                </div>
              );
            })}
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" disabled={active.length === 0} onClick={() => setLines((ls) => [...ls, blank()])}>
                <Plus className="size-4" aria-hidden /> Add item
              </Button>
              {!direct && low.length > 0 && (
                <Button variant="secondary" size="sm" onClick={() => setLines((ls) => [...ls.filter((l) => l.ingredientId), ...low.map((s) => blank(s.ingredientId))])}>
                  Add {low.length} item{low.length === 1 ? '' : 's'} running low
                </Button>
              )}
            </div>
            {active.length === 0 && <p className="text-sm text-amber-800">Add ingredients on the Stock tab first.</p>}
          </fieldset>
          <Input label="Notes (optional)" value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} />
          {!direct && <p className="text-xs text-stone-500">Totals and GST are worked out when you save.</p>}
        </div>
      )}
    </Dialog>
  );
}

/** One purchase order: approve it, cancel it, or receive what arrived. */
function OrderDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const branch = useBranch();
  const { can } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const [mode, setMode] = useState<'view' | 'receive' | 'cancel'>('view');
  const [received, setReceived] = useState<Record<string, { quantity: string; unitPrice: string }>>({});
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef(newKey());

  const po = useQuery({ queryKey: ['purchase-order', id], queryFn: () => api.get<PurchaseOrder>(`/purchase-orders/${id}`) });
  const receipts = useQuery({ queryKey: ['goods-receipts', id], queryFn: () => api.get<GoodsReceipt[]>('/goods-receipts', { branchId: branch.id, purchaseOrderId: id }) });

  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['purchase-order', id] }),
      qc.invalidateQueries({ queryKey: ['goods-receipts', id] }),
      qc.invalidateQueries({ queryKey: ['purchase-orders'] }),
      qc.invalidateQueries({ queryKey: ['stock'] }),
    ]);
  const run = async (fn: () => Promise<unknown>, done: string, close = false) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refresh();
      toast(done, 'success');
      setMode('view');
      key.current = newKey();
      if (close) onClose();
    } catch (err) {
      setError(errorMessage(err));
      key.current = newKey();
    } finally {
      setBusy(false);
    }
  };

  const o = po.data;
  const receivable = o && (o.status === 'ORDERED' || o.status === 'PARTIALLY_RECEIVED');
  const lines = o?.items.map((i) => ({ item: i, form: received[i.id] ?? { quantity: i.remainingQuantity, unitPrice: i.unitPrice } })) ?? [];
  const toReceive = lines.filter((l) => l.form.quantity !== '' && Number(l.form.quantity) > 0);
  const receiveProblem = toReceive.length === 0 ? 'Enter what arrived' : lines.some((l) => (l.form.quantity !== '' && !QTY.test(l.form.quantity)) || !PRICE.test(l.form.unitPrice)) ? 'Check the quantities and prices' : null;

  const receive = () =>
    run(
      () =>
        api.post(
          `/purchase-orders/${id}/receipts`,
          { items: toReceive.map((l) => ({ purchaseOrderItemId: l.item.id, quantity: l.form.quantity, unitPrice: l.form.unitPrice !== l.item.unitPrice ? l.form.unitPrice : undefined })) },
          key.current,
        ),
      'Delivery received and added to stock',
    );

  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={o ? `${o.poNumber} · ${o.supplier.name}` : 'Purchase order'}
      footer={
        o && (
          <>
            {mode === 'view' && (
              <>
                {(o.status === 'DRAFT' || o.status === 'ORDERED') && can('purchases.create') && (
                  <Button variant="ghost" className="mr-auto text-red-700" onClick={() => setMode('cancel')}>
                    Cancel order
                  </Button>
                )}
                <Button variant="ghost" onClick={onClose}>
                  Close
                </Button>
                {o.status === 'DRAFT' && can('purchases.approve') && (
                  <Button loading={busy} onClick={() => run(() => api.post(`/purchase-orders/${id}/approve`), `${o.poNumber} approved`)}>
                    Approve order
                  </Button>
                )}
                {receivable && can('purchases.receive') && <Button onClick={() => setMode('receive')}>Receive delivery</Button>}
              </>
            )}
            {mode === 'receive' && (
              <>
                {receiveProblem && <span className="mr-auto text-sm text-amber-800">{receiveProblem}</span>}
                <Button variant="ghost" onClick={() => setMode('view')}>
                  Back
                </Button>
                <Button loading={busy} disabled={!!receiveProblem} onClick={receive}>
                  Add to stock
                </Button>
              </>
            )}
            {mode === 'cancel' && (
              <>
                <Button variant="ghost" onClick={() => setMode('view')}>
                  Back
                </Button>
                <Button variant="danger" loading={busy} disabled={reason.trim().length < 3} onClick={() => run(() => api.post(`/purchase-orders/${id}/cancel`, { reason: reason.trim() }), `${o.poNumber} cancelled`, true)}>
                  Cancel this order
                </Button>
              </>
            )}
          </>
        )
      }
    >
      {po.isError ? (
        <ErrorNote message={errorMessage(po.error)} onRetry={() => po.refetch()} />
      ) : !o ? (
        <Spinner />
      ) : (
        <div className="flex flex-col gap-4">
          {error && <ErrorNote message={error} />}
          <div className="flex flex-wrap items-center gap-2 text-sm text-stone-600">
            <Badge tone={STATUS[o.status].tone}>{STATUS[o.status].label}</Badge>
            <span>Ordered {dateTime(o.orderDate)}</span>
            {o.expectedDate && <span>· expected {new Date(o.expectedDate).toLocaleDateString('en-IN')}</span>}
            {o.status === 'DRAFT' && !can('purchases.approve') && <span className="font-medium text-amber-800">· waiting for the owner to approve</span>}
            {o.cancelReason && <span>· {o.cancelReason}</span>}
          </div>
          {mode === 'cancel' ? (
            <Input label="Why is it cancelled?" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} autoFocus />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[34rem] text-sm">
                <thead className="text-left text-xs text-stone-500">
                  <tr>
                    <th className="py-1 font-medium">Item</th>
                    <th className="py-1 text-right font-medium">Ordered</th>
                    <th className="py-1 text-right font-medium">{mode === 'receive' ? 'Arrived now' : 'Received'}</th>
                    <th className="py-1 text-right font-medium">Price</th>
                    <th className="py-1 text-right font-medium">GST</th>
                    <th className="py-1 text-right font-medium">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-100">
                  {lines.map(({ item: i, form }) => (
                    <tr key={i.id} data-testid="po-item">
                      <td className="py-2 font-medium">{i.ingredient.name}</td>
                      <td className="py-2 text-right tabular-nums">
                        {qty(i.quantity)} {i.unit.code}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {mode === 'receive' ? (
                          Number(i.remainingQuantity) > 0 ? (
                            <input
                              aria-label={`${i.ingredient.name} arrived`}
                              inputMode="decimal"
                              value={form.quantity}
                              onChange={(e) => setReceived((m) => ({ ...m, [i.id]: { ...form, quantity: e.target.value.trim() } }))}
                              className="h-9 w-20 rounded-lg border border-stone-300 px-2 text-right"
                            />
                          ) : (
                            'all in'
                          )
                        ) : (
                          `${qty(i.receivedQuantity)} ${i.unit.code}`
                        )}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {mode === 'receive' && Number(i.remainingQuantity) > 0 ? (
                          <input
                            aria-label={`${i.ingredient.name} price`}
                            inputMode="decimal"
                            value={form.unitPrice}
                            onChange={(e) => setReceived((m) => ({ ...m, [i.id]: { ...form, unitPrice: e.target.value.trim() } }))}
                            className="h-9 w-24 rounded-lg border border-stone-300 px-2 text-right"
                          />
                        ) : (
                          `${rupees(i.unitPrice)}/${i.unit.code}`
                        )}
                      </td>
                      <td className="py-2 text-right tabular-nums">{Number(i.taxRate)}%</td>
                      <td className="py-2 text-right tabular-nums">{rupees(i.lineTotal)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="text-sm">
                  <tr>
                    <td colSpan={5} className="pt-2 text-right text-stone-500">
                      Before GST
                    </td>
                    <td className="pt-2 text-right tabular-nums">{rupees(o.subtotal)}</td>
                  </tr>
                  <tr>
                    <td colSpan={5} className="text-right text-stone-500">
                      GST
                    </td>
                    <td className="text-right tabular-nums">{rupees(o.taxTotal)}</td>
                  </tr>
                  <tr className="font-semibold">
                    <td colSpan={5} className="text-right">
                      Total
                    </td>
                    <td className="text-right tabular-nums">{rupees(o.total)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
          {mode === 'receive' && <p className="text-xs text-stone-500">Change the price only if the bill differs from the order. Stock is valued at the price you receive at.</p>}
          {o.notes && <p className="text-sm text-stone-600">Note: {o.notes}</p>}
          {receipts.data && receipts.data.length > 0 && mode === 'view' && (
            <section>
              <h3 className="mb-1 text-sm font-semibold">Deliveries</h3>
              <ul className="divide-y divide-stone-100 rounded-lg border border-stone-200 text-sm">
                {receipts.data.map((g) => (
                  <li key={g.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                    <span className="font-medium">{g.grnNumber}</span>
                    <span className="text-stone-500">{dateTime(g.receivedAt)}</span>
                    <span className="min-w-0 flex-1 truncate text-stone-600">{g.items.map((x) => `${x.ingredient.name} ${stockQty(x.quantity, x.unit.code)}`).join(', ')}</span>
                    <span className="tabular-nums">{rupees(g.totalValue)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {o.status === 'DRAFT' && <p className="text-xs text-stone-500">Not sent yet. Approve it to order, then receive the delivery when it arrives.</p>}
        </div>
      )}
    </Dialog>
  );
}
