'use client';

import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { ClipboardCheck, History, Plus } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { useToast } from '@/components/toast';
import { Badge, Button, Card, Dialog, Empty, ErrorNote, Input, PageHeader, Select, Spinner } from '@/components/ui';
import { api, errorMessage, newKey } from '@/lib/api';
import { cn } from '@/lib/cn';
import { dateTime, rupees, stockQty, titleCase } from '@/lib/format';
import { useBranch, useSession } from '@/lib/session';
import type { Ingredient, StockMovement, StockRow, Unit } from '@/lib/types';

const QTY = /^(0|[1-9][0-9]{0,10})(\.[0-9]{1,3})?$/;
const PRICE = /^(0|[1-9][0-9]{0,9})(\.[0-9]{1,4})?$/;

interface Line {
  ingredient: Ingredient;
  stock?: StockRow;
}

/** Stock of every ingredient in the selected branch: what is low, and recording deliveries, wastage and counts. */
export default function StockLevelsPage() {
  const branch = useBranch();
  const { can } = useSession();
  const [search, setSearch] = useState('');
  const [lowOnly, setLowOnly] = useState(false);
  const [view, setView] = useState<'stock' | 'history'>('stock');
  const [open, setOpen] = useState<Line | 'new' | 'count' | null>(null);

  const ingredients = useQuery({ queryKey: ['ingredients'], queryFn: () => api.all<Ingredient>('/ingredients', { includeInactive: true }) });
  const stock = useQuery({ queryKey: ['stock', branch.id], queryFn: () => api.get<StockRow[]>('/inventory', { branchId: branch.id }) });
  const units = useQuery({ queryKey: ['units'], queryFn: () => api.get<Unit[]>('/units'), staleTime: Infinity });

  const lines = useMemo<Line[]>(() => {
    const byId = new Map((stock.data ?? []).map((s) => [s.ingredientId, s]));
    return (ingredients.data ?? []).filter((i) => i.isActive).map((i) => ({ ingredient: i, stock: byId.get(i.id) }));
  }, [ingredients.data, stock.data]);

  const error = ingredients.error ?? stock.error ?? units.error;
  if (error) return <ErrorNote message={errorMessage(error)} onRetry={() => (ingredients.refetch(), stock.refetch(), units.refetch())} />;
  if (!ingredients.data || !stock.data || !units.data) return <Spinner label="Loading stock" />;

  const q = search.trim().toLowerCase();
  const shown = lines.filter((l) => (!lowOnly || l.stock?.isLow || l.stock?.isNegative) && (!q || l.ingredient.name.toLowerCase().includes(q) || (l.ingredient.category ?? '').toLowerCase().includes(q)));
  const lowCount = lines.filter((l) => l.stock?.isLow || l.stock?.isNegative).length;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Stock"
        subtitle={
          <span>
            {branch.name} · {lines.length} ingredient{lines.length === 1 ? '' : 's'}
            {lowCount > 0 && <span className="font-medium text-red-700"> · {lowCount} running low</span>}
          </span>
        }
        actions={
          <>
            <Button variant="secondary" onClick={() => setView(view === 'stock' ? 'history' : 'stock')}>
              <History className="size-4" aria-hidden /> {view === 'stock' ? 'History' : 'Back to stock'}
            </Button>
            {can('inventory.adjust') && lines.length > 0 && (
              <Button variant="secondary" onClick={() => setOpen('count')}>
                <ClipboardCheck className="size-4" aria-hidden /> Stock count
              </Button>
            )}
            {can('inventory.manage') && (
              <Button onClick={() => setOpen('new')}>
                <Plus className="size-4" aria-hidden /> New ingredient
              </Button>
            )}
          </>
        }
      />

      {view === 'history' ? (
        <Movements ingredients={ingredients.data} />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <input type="search" aria-label="Search ingredients" placeholder="Ingredient or category" value={search} onChange={(e) => setSearch(e.target.value)} className="h-10 min-w-0 flex-1 rounded-lg border border-stone-300 px-3" />
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={lowOnly} onChange={(e) => setLowOnly(e.target.checked)} /> Running low only
            </label>
          </div>
          {shown.length === 0 ? (
            <Empty title={lines.length === 0 ? 'No ingredients yet' : 'Nothing matches'}>{lines.length === 0 && 'Add ingredients, then record a stock count to set the opening stock.'}</Empty>
          ) : (
            <Card>
              <ul className="divide-y divide-stone-100">
                {shown.map((l) => {
                  const unit = l.stock?.unit ?? l.ingredient.baseUnit.code;
                  return (
                    <li key={l.ingredient.id}>
                      <button className="flex w-full flex-wrap items-center gap-3 px-4 py-3 text-left hover:bg-stone-50" onClick={() => setOpen(l)} data-testid="stock-row">
                        <div className="min-w-0 flex-1">
                          <p className="font-medium">{l.ingredient.name}</p>
                          <p className="text-xs text-stone-500">
                            {l.ingredient.category ?? 'No category'}
                            {l.stock && Number(l.stock.minimumLevel) > 0 ? ` · keep at least ${stockQty(l.stock.minimumLevel, unit)}` : ''}
                          </p>
                        </div>
                        {l.stock?.isNegative ? <Badge tone="red">Below zero</Badge> : l.stock?.isLow ? <Badge tone="red">Low</Badge> : !l.stock && <Badge>Not counted</Badge>}
                        <span className={cn('w-28 text-right font-semibold tabular-nums', (l.stock?.isLow || l.stock?.isNegative) && 'text-red-700')}>{stockQty(l.stock?.quantity ?? 0, unit)}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}
        </>
      )}

      {open === 'new' && <IngredientDialog units={units.data} onClose={() => setOpen(null)} />}
      {open === 'count' && <CountDialog lines={lines} units={units.data} onClose={() => setOpen(null)} />}
      {open && typeof open === 'object' && <StockDialog line={open} units={units.data} onClose={() => setOpen(null)} />}
    </div>
  );
}

const compatible = (units: Unit[], i: Ingredient) => units.filter((u) => u.dimension === i.baseUnit.dimension);

function useRefresh() {
  const qc = useQueryClient();
  return () => Promise.all([qc.invalidateQueries({ queryKey: ['stock'] }), qc.invalidateQueries({ queryKey: ['ingredients'] }), qc.invalidateQueries({ queryKey: ['movements'] })]);
}

function IngredientDialog({ units, onClose }: { units: Unit[]; onClose: () => void }) {
  const toast = useToast();
  const refresh = useRefresh();
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [baseUnit, setBaseUnit] = useState('g');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bases = units.filter((u) => u.factorToBase === '1');

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post('/ingredients', { name: name.trim(), baseUnit, category: category.trim() || undefined });
      await refresh();
      toast(`${name.trim()} added`, 'success');
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="New ingredient"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={busy} disabled={!name.trim()}>
            Add ingredient
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error && <ErrorNote message={error} />}
        <Input label="Name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} autoFocus />
        <Input label="Category (optional)" placeholder="Dairy, Vegetables, Spices…" value={category} maxLength={60} onChange={(e) => setCategory(e.target.value)} />
        <Select label="Counted in" value={baseUnit} onChange={(e) => setBaseUnit(e.target.value)}>
          {bases.map((u) => (
            <option key={u.id} value={u.code}>
              {u.name} ({u.code}){u.dimension === 'MASS' ? ', also buy in kg' : u.dimension === 'VOLUME' ? ', also buy in litres' : ''}
            </option>
          ))}
        </Select>
      </div>
    </Dialog>
  );
}

type Action = 'in' | 'out' | 'wastage' | 'minimum' | 'details';

/** One ingredient: record a delivery or correction, wastage, its minimum level, or edit it. */
function StockDialog({ line, units, onClose }: { line: Line; units: Unit[]; onClose: () => void }) {
  const branch = useBranch();
  const { can } = useSession();
  const toast = useToast();
  const refresh = useRefresh();
  const ing = line.ingredient;
  const actions: { key: Action; label: string; allowed: boolean }[] = [
    { key: 'in', label: 'Add stock', allowed: can('inventory.adjust') },
    { key: 'out', label: 'Remove stock', allowed: can('inventory.adjust') },
    { key: 'wastage', label: 'Wastage', allowed: can('inventory.wastage') },
    { key: 'minimum', label: 'Minimum level', allowed: can('inventory.manage') },
    { key: 'details', label: 'Details', allowed: can('inventory.manage') },
  ];
  const allowed = actions.filter((a) => a.allowed);
  const [action, setAction] = useState<Action | undefined>(allowed[0]?.key);
  const [quantity, setQuantity] = useState('');
  const [unit, setUnit] = useState(ing.baseUnit.code);
  const [reason, setReason] = useState('');
  const [minimum, setMinimum] = useState(line.stock?.minimumLevel ?? '0');
  const [name, setName] = useState(ing.name);
  const [category, setCategory] = useState(ing.category ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One key per form fill, so a double tap or a retry never records the movement twice.
  const key = useRef(newKey());
  const baseUnit = line.stock?.unit ?? ing.baseUnit.code;

  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refresh();
      toast(done, 'success');
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      key.current = newKey();
    } finally {
      setBusy(false);
    }
  };

  const moving = action === 'in' || action === 'out' || action === 'wastage';
  const valid = moving ? QTY.test(quantity) && Number(quantity) > 0 && reason.trim().length >= 3 : action === 'minimum' ? QTY.test(minimum) : name.trim().length > 0;

  const submit = () => {
    if (action === 'in' || action === 'out')
      return run(
        () => api.post('/inventory/adjustments', { branchId: branch.id, ingredientId: ing.id, quantity, unit, reason: reason.trim(), direction: action === 'in' ? 'IN' : 'OUT' }, key.current),
        `${ing.name}: ${action === 'in' ? 'added' : 'removed'} ${quantity} ${unit}`,
      );
    if (action === 'wastage') return run(() => api.post('/inventory/wastage', { branchId: branch.id, ingredientId: ing.id, quantity, unit, reason: reason.trim() }, key.current), `Wastage of ${ing.name} recorded`);
    if (action === 'minimum') return run(() => api.put('/inventory/levels', { branchId: branch.id, levels: [{ ingredientId: ing.id, minimumLevel: minimum }] }), `Minimum level for ${ing.name} saved`);
    return run(() => api.patch(`/ingredients/${ing.id}`, { name: name.trim(), category: category.trim() || undefined }), `${name.trim()} saved`);
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={ing.name}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          {action && (
            <Button onClick={submit} loading={busy} disabled={!valid}>
              {action === 'in' ? 'Add to stock' : action === 'out' ? 'Remove from stock' : action === 'wastage' ? 'Record wastage' : 'Save'}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-3 gap-2 text-sm">
          <Fact label="In stock" value={stockQty(line.stock?.quantity ?? 0, baseUnit)} />
          <Fact label="Minimum" value={stockQty(line.stock?.minimumLevel ?? 0, baseUnit)} />
          <Fact label="Average cost" value={line.stock ? `${rupees(String(Number(line.stock.averageCost) * (BIG[baseUnit] ?? 1)))} / ${BIG_UNIT[baseUnit] ?? baseUnit}` : '—'} />
        </div>
        {allowed.length === 0 ? (
          <p className="text-sm text-stone-600">You can see stock but not change it.</p>
        ) : (
          <div role="tablist" aria-label="What to do" className="flex flex-wrap gap-1 rounded-lg bg-stone-100 p-1">
            {allowed.map((a) => (
              <button
                key={a.key}
                role="tab"
                aria-selected={action === a.key}
                onClick={() => {
                  setAction(a.key);
                  setError(null);
                }}
                className={cn('h-8 rounded-md px-3 text-sm font-medium', action === a.key ? 'bg-white shadow-sm' : 'text-stone-600')}
              >
                {a.label}
              </button>
            ))}
          </div>
        )}
        {error && <ErrorNote message={error} />}
        {moving && (
          <>
            <div className="grid grid-cols-[minmax(0,1fr)_8rem] gap-3">
              <Input label="Quantity" inputMode="decimal" value={quantity} onChange={(e) => setQuantity(e.target.value.trim())} autoFocus error={quantity && !QTY.test(quantity) ? 'A number, up to 3 decimals' : null} />
              <Select label="Unit" value={unit} onChange={(e) => setUnit(e.target.value)}>
                {compatible(units, ing).map((u) => (
                  <option key={u.id} value={u.code}>
                    {u.code}
                  </option>
                ))}
              </Select>
            </div>
            <Input
              label={action === 'wastage' ? 'What happened' : 'Reason'}
              placeholder={action === 'in' ? 'Bought at the market' : action === 'out' ? 'Sent to the other branch' : 'Spoiled, dropped, burnt…'}
              value={reason}
              maxLength={300}
              onChange={(e) => setReason(e.target.value)}
            />
            {action === 'in' && <p className="text-xs text-stone-500">For deliveries from a supplier, receive them against the purchase order instead, so the cost is recorded.</p>}
          </>
        )}
        {action === 'minimum' && <Input label={`Warn when stock falls below (${baseUnit})`} inputMode="decimal" value={minimum} onChange={(e) => setMinimum(e.target.value.trim())} hint={QTY.test(minimum) ? stockQty(minimum, baseUnit) : 'A number, up to 3 decimals'} />}
        {action === 'details' && (
          <>
            <Input label="Name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
            <Input label="Category (optional)" value={category} maxLength={60} onChange={(e) => setCategory(e.target.value)} />
            <div>
              <Button variant="ghost" className="text-red-700" loading={busy} onClick={() => run(() => api.patch(`/ingredients/${ing.id}`, { isActive: false }), `${ing.name} removed from the list`)}>
                Stop using this ingredient
              </Button>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}

/** Average cost is kept per gram or millilitre; shown per kg or litre, which is how it is bought. Display only. */
const BIG: Record<string, number> = { g: 1000, ml: 1000 };
const BIG_UNIT: Record<string, string> = { g: 'kg', ml: 'l' };

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-stone-50 px-3 py-2">
      <p className="text-xs text-stone-500">{label}</p>
      <p className="font-semibold tabular-nums">{value}</p>
    </div>
  );
}

/** A full or partial count: only the ingredients with a number entered are changed. */
function CountDialog({ lines, units, onClose }: { lines: Line[]; units: Unit[]; onClose: () => void }) {
  const branch = useBranch();
  const toast = useToast();
  const refresh = useRefresh();
  const [rows, setRows] = useState<Record<string, { quantity: string; unit: string; unitCost: string }>>({});
  const [reason, setReason] = useState('Stock count');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef(newKey());

  const entered = Object.entries(rows).filter(([, r]) => r.quantity !== '');
  const bad = entered.some(([, r]) => !QTY.test(r.quantity) || (r.unitCost !== '' && !PRICE.test(r.unitCost)));
  const set = (id: string, base: string, p: Partial<{ quantity: string; unit: string; unitCost: string }>) => setRows((m) => ({ ...m, [id]: { ...(m[id] ?? { quantity: '', unit: base, unitCost: '' }), ...p } }));

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const counts = entered.map(([ingredientId, r]) => ({ ingredientId, quantity: r.quantity, unit: r.unit, unitCost: r.unitCost || undefined }));
      const result = await api.post<{ name: string; difference: string }[]>('/inventory/stock-counts', { branchId: branch.id, reason: reason.trim(), counts }, key.current);
      await refresh();
      const changed = result.filter((r) => Number(r.difference) !== 0).length;
      toast(`Count saved: ${changed} of ${result.length} changed`, 'success');
      onClose();
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
      title="Stock count"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={busy} disabled={entered.length === 0 || bad || reason.trim().length < 3}>
            Save count ({entered.length})
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-sm text-stone-600">Enter what is actually on the shelf. Leave a line empty to skip it. For a first count, add the cost per unit so stock has a value.</p>
        {error && <ErrorNote message={error} />}
        <Input label="Reason" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
        <ul className="divide-y divide-stone-100 rounded-lg border border-stone-200">
          {lines.map((l) => {
            const base = l.ingredient.baseUnit.code;
            const r = rows[l.ingredient.id] ?? { quantity: '', unit: base, unitCost: '' };
            return (
              <li key={l.ingredient.id} className="grid grid-cols-[minmax(0,1fr)_6rem_5rem] items-center gap-2 px-3 py-2 sm:grid-cols-[minmax(0,1fr)_7rem_5rem_8rem]" data-testid="count-row">
                <span className="min-w-0">
                  <span className="block truncate font-medium">{l.ingredient.name}</span>
                  <span className="text-xs text-stone-500">now {stockQty(l.stock?.quantity ?? 0, base)}</span>
                </span>
                <input
                  aria-label={`${l.ingredient.name} counted`}
                  inputMode="decimal"
                  placeholder="Counted"
                  value={r.quantity}
                  onChange={(e) => set(l.ingredient.id, base, { quantity: e.target.value.trim() })}
                  className={cn('h-10 min-w-0 rounded-lg border border-stone-300 px-2', r.quantity && !QTY.test(r.quantity) && 'border-red-500')}
                />
                <select aria-label={`${l.ingredient.name} unit`} value={r.unit} onChange={(e) => set(l.ingredient.id, base, { unit: e.target.value })} className="h-10 rounded-lg border border-stone-300 bg-white px-1">
                  {compatible(units, l.ingredient).map((u) => (
                    <option key={u.id} value={u.code}>
                      {u.code}
                    </option>
                  ))}
                </select>
                <input
                  aria-label={`${l.ingredient.name} cost per ${r.unit}`}
                  inputMode="decimal"
                  placeholder={`₹ per ${r.unit}`}
                  value={r.unitCost}
                  onChange={(e) => set(l.ingredient.id, base, { unitCost: e.target.value.trim() })}
                  className={cn('col-span-3 h-10 min-w-0 rounded-lg border border-stone-300 px-2 sm:col-span-1', r.unitCost && !PRICE.test(r.unitCost) && 'border-red-500')}
                />
              </li>
            );
          })}
        </ul>
      </div>
    </Dialog>
  );
}

const MOVEMENT_LABEL: Record<string, string> = {
  OPENING: 'Opening stock',
  PURCHASE_RECEIPT: 'Delivery',
  SALE_CONSUMPTION: 'Sold',
  SALE_REVERSAL: 'Sale cancelled',
  WASTAGE: 'Wastage',
  ADJUSTMENT_IN: 'Added',
  ADJUSTMENT_OUT: 'Removed',
  TRANSFER_IN: 'Transfer in',
  TRANSFER_OUT: 'Transfer out',
};

/** Every change to stock, newest first: sales, deliveries, wastage, counts and corrections. */
function Movements({ ingredients }: { ingredients: Ingredient[] }) {
  const branch = useBranch();
  const [ingredientId, setIngredientId] = useState('');
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: ['movements', branch.id, ingredientId, page],
    queryFn: () => api.page<StockMovement>('/inventory/movements', { branchId: branch.id, ingredientId: ingredientId || undefined, page, pageSize: 50 }),
    placeholderData: keepPreviousData,
  });

  return (
    <div className="flex flex-col gap-3">
      <Select
        label="Ingredient"
        value={ingredientId}
        onChange={(e) => {
          setIngredientId(e.target.value);
          setPage(1);
        }}
        className="max-w-sm"
      >
        <option value="">All ingredients</option>
        {ingredients.map((i) => (
          <option key={i.id} value={i.id}>
            {i.name}
          </option>
        ))}
      </Select>
      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <ErrorNote message={errorMessage(q.error)} onRetry={() => q.refetch()} />
      ) : q.data.items.length === 0 ? (
        <Empty title="No stock changes yet" />
      ) : (
        <Card>
          <ul className="divide-y divide-stone-100">
            {q.data.items.map((m) => {
              const qn = Number(m.quantity);
              return (
                <li key={m.id} className="flex flex-wrap items-center gap-3 px-4 py-2" data-testid="movement">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">
                      {m.ingredientName} <Badge tone={qn < 0 ? 'amber' : 'green'}>{MOVEMENT_LABEL[m.type] ?? titleCase(m.type)}</Badge>
                    </p>
                    <p className="truncate text-xs text-stone-500">
                      {dateTime(m.createdAt)}
                      {m.note ? ` · ${m.note}` : ''}
                    </p>
                  </div>
                  <span className={cn('w-24 text-right font-medium tabular-nums', qn < 0 ? 'text-amber-800' : 'text-emerald-800')}>
                    {qn > 0 ? '+' : ''}
                    {stockQty(m.quantity, m.unit)}
                  </span>
                  <span className="w-24 text-right text-sm text-stone-500 tabular-nums">left {stockQty(m.balanceAfter, m.unit)}</span>
                </li>
              );
            })}
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
