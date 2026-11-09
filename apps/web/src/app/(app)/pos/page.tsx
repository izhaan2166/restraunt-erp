'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCheck, ChefHat, Minus, Plus, Receipt, Search, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useMemo, useState } from 'react';
import { BillDialog } from '@/components/bill-dialog';
import { ProductDialog } from '@/components/product-dialog';
import { useToast } from '@/components/toast';
import { Badge, Button, Dialog, Empty, ErrorNote, Input, Spinner, Tone } from '@/components/ui';
import { ApiError, api, errorMessage } from '@/lib/api';
import { cn } from '@/lib/cn';
import { qty, rupees, titleCase } from '@/lib/format';
import { useRealtime } from '@/lib/realtime';
import { useBranch, useSession } from '@/lib/session';
import type { KitchenStatus, MenuProduct, Order, OrderItem, OrderType, PosMenu, TableRow } from '@/lib/types';
import { isUnsent, ItemInput, NewOrderContext, useOrder } from '@/lib/use-order';

const OPEN_STATUSES = 'NEW,CONFIRMED,PREPARING,READY,SERVED,OUT_FOR_DELIVERY,DELIVERED';

export default function PosPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <Pos />
    </Suspense>
  );
}

/** Works out what is being rung up (a table, an existing order, or a new takeaway/delivery) and loads it. */
function Pos() {
  const branch = useBranch();
  const params = useSearchParams();
  const tableId = params.get('table');
  const orderId = params.get('order');
  const [type, setType] = useState<Exclude<OrderType, 'DINE_IN'>>('TAKEAWAY');

  const ctx = useQuery({
    queryKey: ['pos-context', branch.id, tableId, orderId],
    queryFn: async (): Promise<{ table: TableRow | null; order: Order | null }> => {
      if (orderId) {
        const order = await api.get<Order>(`/orders/${orderId}`);
        return { table: null, order };
      }
      if (tableId) {
        const table = await api.get<TableRow>(`/branches/${branch.id}/tables/${tableId}`);
        if (!table.session) return { table, order: null };
        const sessionId = table.session.mergedIntoTableId ? undefined : table.session.id;
        if (!sessionId) return { table, order: null };
        const { items } = await api.page<{ id: string }>('/orders', { branchId: branch.id, tableSessionId: sessionId, status: OPEN_STATUSES, pageSize: 1 });
        const order = items[0] ? await api.get<Order>(`/orders/${items[0].id}`) : null;
        return { table, order };
      }
      return { table: null, order: null };
    },
    staleTime: 0,
    gcTime: 0,
  });

  if (ctx.isPending) return <Spinner label="Loading order" />;
  if (ctx.isError) return <div className="p-4"><ErrorNote message={errorMessage(ctx.error)} onRetry={() => ctx.refetch()} /></div>;

  const { table, order } = ctx.data;
  if (table && !table.session) return <OpenTable table={table} onOpened={() => ctx.refetch()} />;
  if (table?.session?.mergedIntoTableId)
    return (
      <Empty title={`${table.label} is joined to another table`}>
        <Link className="text-brand-700 underline" href={`/pos?table=${table.session.mergedIntoTableId}`}>
          Open the main table
        </Link>
      </Empty>
    );

  const orderType: OrderType = order?.orderType ?? (table ? 'DINE_IN' : type);
  return (
    <Register
      key={`${tableId ?? ''}|${orderId ?? ''}|${order?.id ?? ''}|${orderType}`}
      branchId={branch.id}
      table={table}
      initial={order}
      orderType={orderType}
      onTypeChange={order || table ? undefined : setType}
    />
  );
}

function OpenTable({ table, onOpened }: { table: TableRow; onOpened: () => void }) {
  const branch = useBranch();
  const [guests, setGuests] = useState(String(Math.min(2, table.capacity)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function open() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/branches/${branch.id}/tables/${table.id}/open`, { guestCount: Number(guests) });
      onOpened();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }
  return (
    <div className="mx-auto mt-10 flex max-w-sm flex-col gap-4 rounded-2xl border border-stone-200 bg-white p-6">
      <h1 className="text-xl font-semibold">Seat guests at {table.label}</h1>
      <p className="text-sm text-stone-600">
        {table.status === 'RESERVED' && table.reservationName ? `Reserved for ${table.reservationName}. ` : ''}Seats {table.capacity}.
      </p>
      <Input label="Guests" type="number" min={1} max={50} inputMode="numeric" value={guests} onChange={(e) => setGuests(e.target.value)} autoFocus />
      {error && <ErrorNote message={error} />}
      <Button size="lg" onClick={open} loading={busy} disabled={!(Number(guests) >= 1)}>
        Open table
      </Button>
      <Link href="/tables" className="text-center text-sm text-stone-600 hover:underline">
        Back to tables
      </Link>
    </div>
  );
}

/** Hand-over steps staff confirm from the order screen; kitchen progress moves the rest by itself. */
const STEP_LABEL = { SERVED: 'Mark served', PICKED_UP: 'Handed to customer', OUT_FOR_DELIVERY: 'Out for delivery', DELIVERED: 'Delivered' } as const;

const KITCHEN_TONE: Record<KitchenStatus, Tone> = { PENDING: 'amber', PREPARING: 'blue', READY: 'green', SERVED: 'neutral', CANCELLED: 'red' };
const KITCHEN_LABEL: Record<KitchenStatus, string> = { PENDING: 'Sent', PREPARING: 'Cooking', READY: 'Ready', SERVED: 'Served', CANCELLED: 'Cancelled' };

function Register({
  branchId,
  table,
  initial,
  orderType,
  onTypeChange,
}: {
  branchId: string;
  table: TableRow | null;
  initial: Order | null;
  orderType: OrderType;
  onTypeChange?: (t: Exclude<OrderType, 'DINE_IN'>) => void;
}) {
  const toast = useToast();
  const router = useRouter();
  const qc = useQueryClient();
  const { can } = useSession();
  const o = useOrder(initial);
  const order = o.order;

  const [customer, setCustomer] = useState({ customerName: initial?.customerName ?? '', customerPhone: initial?.customerPhone ?? '', deliveryAddress: '' });
  const [product, setProduct] = useState<MenuProduct | null>(null);
  const [voiding, setVoiding] = useState<OrderItem | null>(null);
  const [billing, setBilling] = useState(false);

  const menu = useQuery({ queryKey: ['menu', branchId], queryFn: () => api.get<PosMenu>('/menu', { branchId }), staleTime: 60_000 });

  // Keep the order fresh when the kitchen or another till changes it.
  const live = useRealtime(
    branchId,
    ['orders', 'kitchen'],
    (e) => {
      const cur = order;
      if (!cur || o.busy) return;
      const mine = e.entityId === cur.id || (e.data as { orderId?: string }).orderId === cur.id;
      if (!mine) return;
      if (e.entityType === 'order' && e.entityVersion !== null && e.entityVersion <= cur.version) return;
      o.reload().catch(() => undefined);
    },
    () => o.reload().catch(() => undefined),
  );

  const fail = useCallback((err: unknown) => toast(errorMessage(err), 'error'), [toast]);

  const ctx: NewOrderContext = {
    branchId,
    orderType,
    tableId: table?.id,
    customerName: customer.customerName.trim() || undefined,
    customerPhone: customer.customerPhone.trim() || undefined,
    deliveryAddress: orderType === 'DELIVERY' ? customer.deliveryAddress.trim() || undefined : undefined,
  };
  const needsAddress = orderType === 'DELIVERY' && !order && !customer.deliveryAddress.trim();
  const billed = !!order?.invoices.some((i) => i.status === 'FINALIZED');
  const closed = order ? ['COMPLETED', 'CANCELLED'].includes(order.status) : false;
  const locked = billed || closed;

  const add = (item: ItemInput) => {
    setProduct(null);
    o.addItem(ctx, item).catch(fail);
  };

  const pick = (p: MenuProduct) => {
    if (locked) return;
    if (needsAddress) return toast('Enter the delivery address first', 'error');
    const simple = p.modifierGroups.length === 0 && p.variants.filter((v) => v.isAvailable).length <= 1;
    if (simple) add({ productId: p.id, variantId: p.variants.find((v) => v.isAvailable)?.id, quantity: '1' });
    else setProduct(p);
  };

  const active = order?.items.filter((i) => i.status === 'ACTIVE') ?? [];
  const nextStep = order?.allowedTransitions.find((t): t is keyof typeof STEP_LABEL => t in STEP_LABEL);
  const unsent = active.filter(isUnsent);

  async function send() {
    try {
      await o.sendToKitchen();
      toast(`Sent ${unsent.length} item${unsent.length === 1 ? '' : 's'} to the kitchen`, 'success');
    } catch (err) {
      fail(err);
    }
  }

  /** Frees the table once nothing on it is left to pay; the server refuses while any order is still open. */
  async function freeTable(quiet = false) {
    if (!table) return;
    try {
      await api.post(`/branches/${branchId}/tables/${table.id}/close`, {});
      if (!quiet) toast(`${table.label} is free`, 'success');
      qc.invalidateQueries({ queryKey: ['tables'] });
      router.push('/tables');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'TABLE_HAS_OPEN_ORDERS') {
        toast(`${table.label} stays open until its order is served and paid`, 'info');
        o.reload().catch(() => undefined);
      } else fail(err);
    }
  }

  async function finished() {
    setBilling(false);
    toast('Payment complete', 'success');
    qc.invalidateQueries({ queryKey: ['orders'] });
    if (table) await freeTable(true);
    else {
      o.reset();
      setCustomer({ customerName: '', customerPhone: '', deliveryAddress: '' });
    }
  }

  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)_auto] lg:grid-cols-[minmax(0,1fr)_400px] lg:grid-rows-[minmax(0,1fr)]">
      <MenuPanel menu={menu.data} loading={menu.isPending} error={menu.isError ? errorMessage(menu.error) : null} onRetry={() => menu.refetch()} onPick={pick} disabled={locked} />

      <aside aria-label="Current order" className="flex max-h-[60vh] min-h-0 min-w-0 flex-col border-t border-stone-200 bg-white lg:max-h-none lg:border-l lg:border-t-0">
        <div className="flex flex-col gap-3 border-b border-stone-200 p-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h2 className="font-semibold">{table ? `Table ${table.label}` : order ? `Order ${order.orderNumber}` : 'New order'}</h2>
              <p className="text-xs text-stone-500">
                {order ? `${titleCase(order.orderType)} · ${titleCase(order.status)}` : titleCase(orderType)}
                {live === 'offline' && ' · offline, changes may be delayed'}
              </p>
            </div>
            {billed && <Badge tone="violet">Billed</Badge>}
          </div>
          {onTypeChange && !order && (
            <div role="tablist" aria-label="Order type" className="grid grid-cols-3 gap-1 rounded-lg bg-stone-100 p-1 text-sm">
              {(['TAKEAWAY', 'DELIVERY'] as const).map((t) => (
                <button key={t} role="tab" aria-selected={orderType === t} onClick={() => onTypeChange(t)} className={cn('h-9 rounded-md font-medium', orderType === t ? 'bg-white shadow-sm' : 'text-stone-600')}>
                  {titleCase(t)}
                </button>
              ))}
              <Link href="/tables" role="tab" aria-selected={false} className="flex h-9 items-center justify-center rounded-md font-medium text-stone-600">
                Dine in
              </Link>
            </div>
          )}
          {orderType !== 'DINE_IN' && !order && (
            <div className="grid grid-cols-2 gap-2">
              <Input label="Customer name" value={customer.customerName} onChange={(e) => setCustomer({ ...customer, customerName: e.target.value })} />
              <Input label="Phone" inputMode="tel" value={customer.customerPhone} onChange={(e) => setCustomer({ ...customer, customerPhone: e.target.value })} />
              {orderType === 'DELIVERY' && (
                <div className="col-span-2">
                  <Input label="Delivery address" value={customer.deliveryAddress} onChange={(e) => setCustomer({ ...customer, deliveryAddress: e.target.value })} />
                </div>
              )}
            </div>
          )}
          {order && (order.customerName || order.customerPhone) && <p className="text-sm text-stone-600">{[order.customerName, order.customerPhone].filter(Boolean).join(' · ')}</p>}
        </div>

        <ul className="min-h-28 flex-1 divide-y divide-stone-100 overflow-y-auto" aria-label="Items" data-testid="order-items">
          {active.length === 0 && (
            <li>
              <Empty title="No items yet">Tap a dish to add it.</Empty>
            </li>
          )}
          {active.map((i) => (
            <ItemRow key={i.id} item={i} locked={locked} busy={o.busy} onQty={(q) => o.setQuantity(i.id, q).catch(fail)} onVoid={() => setVoiding(i)} canVoid={can('orders.update', branchId)} />
          ))}
        </ul>

        {order && active.length > 0 && <Totals order={order} />}

        {order && nextStep && can('orders.update', branchId) && (
          <div className="border-t border-stone-200 px-3 pt-3">
            <Button variant="secondary" className="w-full" loading={o.busy} onClick={() => o.setStatus(nextStep).catch(fail)}>
              <CheckCheck className="size-5" aria-hidden /> {STEP_LABEL[nextStep]}
            </Button>
          </div>
        )}
        {table && order?.status === 'COMPLETED' && can('tables.operate', branchId) && (
          <div className="border-t border-stone-200 px-3 pt-3">
            <Button variant="success" className="w-full" onClick={() => freeTable()}>
              Paid and served: free {table.label}
            </Button>
          </div>
        )}
        {table && !order && can('tables.operate', branchId) && (
          <div className="border-t border-stone-200 px-3 pt-3">
            <Button variant="ghost" className="w-full" onClick={() => freeTable()}>
              Guests left without ordering: free {table.label}
            </Button>
          </div>
        )}
        <div className="grid grid-cols-2 gap-2 border-t border-stone-200 p-3 [&>button]:whitespace-nowrap [&>button]:px-3">
          <Button size="lg" variant="secondary" onClick={send} disabled={!unsent.length || locked} loading={o.busy && unsent.length > 0}>
            <ChefHat className="size-5" aria-hidden /> Send to kitchen
          </Button>
          <Button
            size="lg"
            onClick={() => setBilling(true)}
            disabled={!order || !active.length || unsent.length > 0 || closed || o.busy || !can('invoices.create', branchId)}
            title={unsent.length ? 'Send all items to the kitchen first' : undefined}
          >
            <Receipt className="size-5" aria-hidden /> {billed ? 'Payment' : 'Bill'}
          </Button>
        </div>
      </aside>

      {product && <ProductDialog product={product} onClose={() => setProduct(null)} onAdd={add} />}
      {voiding && (
        <VoidDialog
          item={voiding}
          onClose={() => setVoiding(null)}
          onVoid={(reason) => {
            setVoiding(null);
            o.removeItem(voiding.id, reason).then(() => toast('Item removed', 'success'), fail);
          }}
        />
      )}
      {order && billing && (
        <BillDialog
          order={order}
          open
          onClose={() => {
            setBilling(false);
            o.reload().catch(() => undefined);
          }}
          onPaid={finished}
        />
      )}
    </div>
  );
}

function MenuPanel({ menu, loading, error, onRetry, onPick, disabled }: { menu?: PosMenu; loading: boolean; error: string | null; onRetry: () => void; onPick: (p: MenuProduct) => void; disabled: boolean }) {
  const [category, setCategory] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const products = useMemo(() => {
    if (!menu) return [];
    const q = search.trim().toLowerCase();
    return menu.products.filter((p) => (q ? p.name.toLowerCase().includes(q) || p.sku?.toLowerCase() === q : !category || p.categoryId === category));
  }, [menu, category, search]);

  if (loading) return <Spinner label="Loading menu" />;
  if (error) return <div className="p-4"><ErrorNote message={error} onRetry={onRetry} /></div>;
  if (!menu) return null;
  const used = new Set(menu.products.map((p) => p.categoryId));
  const categories = menu.categories.filter((c) => used.has(c.id));

  return (
    <section aria-label="Menu" className="flex min-h-0 min-w-0 flex-col">
      <div className="flex flex-col gap-2 border-b border-stone-200 bg-white p-3">
        <label className="relative">
          <span className="sr-only">Search the menu</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-stone-400" aria-hidden />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search dishes"
            className="h-11 w-full rounded-lg border border-stone-300 pl-9 pr-3 outline-none focus:border-brand-600"
          />
        </label>
        <div className="flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label="Categories">
          {[{ id: null as string | null, name: 'All' }, ...categories].map((c) => (
            <button
              key={c.id ?? 'all'}
              role="tab"
              aria-selected={!search && category === c.id}
              onClick={() => {
                setSearch('');
                setCategory(c.id);
              }}
              className={cn('h-9 shrink-0 rounded-full px-4 text-sm font-medium', !search && category === c.id ? 'bg-brand-600 text-white' : 'bg-stone-100 text-stone-700 hover:bg-stone-200')}
            >
              {c.name}
            </button>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {products.length === 0 ? (
          <Empty title="No dishes match">Try another name or category.</Empty>
        ) : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
            {products.map((p) => (
              <button
                key={p.id}
                onClick={() => onPick(p)}
                disabled={!p.isAvailable || disabled}
                className="flex min-h-24 flex-col justify-between gap-2 rounded-xl border border-stone-200 bg-white p-3 text-left shadow-sm hover:border-brand-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span className="flex items-start gap-2">
                  <span className={cn('mt-1 size-3 shrink-0 rounded-sm border-2', p.isVeg ? 'border-emerald-600' : 'border-red-600')} aria-label={p.isVeg ? 'Veg' : 'Non-veg'} role="img" />
                  <span className="font-medium leading-snug">{p.name}</span>
                </span>
                <span className="flex items-center justify-between text-sm text-stone-600">
                  <span className="tabular-nums">{p.variants.length > 1 ? `from ${rupees(minPrice(p))}` : rupees(p.variants[0]?.price ?? p.price)}</span>
                  {!p.isAvailable && <Badge tone="red">Sold out</Badge>}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

/** Cheapest size, for the "from ₹…" label: compares menu prices only, no arithmetic. */
function minPrice(p: MenuProduct): string {
  return p.variants.reduce((m, v) => (Number(v.price) < Number(m) ? v.price : m), p.variants[0].price);
}

function ItemRow({ item: i, locked, busy, onQty, onVoid, canVoid }: { item: OrderItem; locked: boolean; busy: boolean; onQty: (q: string) => void; onVoid: () => void; canVoid: boolean }) {
  const unsent = isUnsent(i);
  const n = Number(i.quantity);
  return (
    <li className="flex gap-3 px-3 py-2.5" data-testid="order-item">
      <div className="min-w-0 flex-1">
        <p className="font-medium leading-snug">
          {i.productName}
          {i.variantName && <span className="text-stone-500"> ({i.variantName})</span>}
        </p>
        {i.modifiers.length > 0 && <p className="text-xs text-stone-500">{i.modifiers.map((m) => m.name).join(', ')}</p>}
        {i.specialInstructions && <p className="text-xs italic text-stone-500">“{i.specialInstructions}”</p>}
        <div className="mt-1 flex items-center gap-2">
          {unsent ? <Badge tone="brand">Not sent</Badge> : <Badge tone={KITCHEN_TONE[i.kitchenStatus]}>{KITCHEN_LABEL[i.kitchenStatus]}</Badge>}
        </div>
      </div>
      <div className="flex flex-col items-end gap-1">
        <span className="font-medium tabular-nums">{rupees(i.lineTotal)}</span>
        {unsent && !locked ? (
          <div className="flex items-center gap-1">
            <button aria-label={`One less ${i.productName}`} disabled={busy} onClick={() => onQty(String(n - 1))} className="rounded-md border border-stone-300 p-1.5 hover:bg-stone-50">
              {n <= 1 ? <Trash2 className="size-4" /> : <Minus className="size-4" />}
            </button>
            <span className="w-7 text-center tabular-nums">{qty(i.quantity)}</span>
            <button aria-label={`One more ${i.productName}`} disabled={busy} onClick={() => onQty(String(n + 1))} className="rounded-md border border-stone-300 p-1.5 hover:bg-stone-50">
              <Plus className="size-4" />
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-sm text-stone-600">
            <span>× {qty(i.quantity)}</span>
            {!locked && canVoid && (
              <button onClick={onVoid} className="rounded-md p-1 text-stone-400 hover:bg-red-50 hover:text-red-600" aria-label={`Remove ${i.productName}`}>
                <Trash2 className="size-4" />
              </button>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

function Totals({ order: o }: { order: Order }) {
  const line = (label: string, v: string, show = true) =>
    show ? (
      <div className="flex justify-between">
        <span>{label}</span>
        <span className="tabular-nums">{v}</span>
      </div>
    ) : null;
  return (
    <div className="flex flex-col gap-0.5 border-t border-stone-200 px-3 py-2 text-sm text-stone-600" data-testid="order-totals">
      {line('Subtotal', rupees(o.subtotal))}
      {line('Discount', `− ${rupees(o.discountTotal)}`, Number(o.discountTotal) > 0)}
      {line('Tax', rupees(o.taxTotal), Number(o.taxTotal) > 0)}
      {line('Service charge', rupees(o.serviceCharge), Number(o.serviceCharge) > 0)}
      {line('Round off', rupees(o.roundOff), Number(o.roundOff) !== 0)}
      <div className="mt-1 flex justify-between text-lg font-semibold text-stone-900">
        <span>Total</span>
        <span className="tabular-nums" data-testid="grand-total">
          {rupees(o.grandTotal)}
        </span>
      </div>
    </div>
  );
}

function VoidDialog({ item, onClose, onVoid }: { item: OrderItem; onClose: () => void; onVoid: (reason: string) => void }) {
  const [reason, setReason] = useState('');
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Remove ${item.productName}?`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Keep it
          </Button>
          <Button variant="danger" disabled={reason.trim().length < 3} onClick={() => onVoid(reason.trim())}>
            Remove item
          </Button>
        </>
      }
    >
      <p className="mb-3 text-sm text-stone-600">The kitchen has already seen this item. Removing it is recorded with your name and the reason.</p>
      <Input label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Customer changed their mind" autoFocus />
    </Dialog>
  );
}
